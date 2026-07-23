-- Architecture ref: ARCHITECTURE_v1.0.md §7, §8
--
-- Fixes a real bug found on the hosted project, reproduced locally
-- before this fix was written: `function gen_salt(unknown) does not
-- exist` when calling create_room (and the same failure would hit
-- join_room, room_members_for_reclaim, and reclaim_membership, since
-- all four call crypt()/gen_salt()).
--
-- Root cause: component 6's migration installed pgcrypto with
-- `create extension if not exists pgcrypto;`, no schema specified.
-- On a bare local Postgres that lands in `public`, which is why local
-- testing never caught this. On Supabase's hosted platform, pgcrypto is
-- pre-installed in a dedicated `extensions` schema as a matter of
-- convention -- so `if not exists` was a silent no-op there, and the
-- functions stayed in `extensions`, never `public`.
--
-- Every affected RPC deliberately pins `set search_path = public` as
-- SECURITY DEFINER hardening (component 5's note on this pattern) --
-- which is exactly why it can't see `extensions`. `select gen_salt('bf')`
-- run directly in the SQL Editor works fine, because that session's
-- default search_path already includes `extensions`; the same call
-- fails only inside these functions, which is the exact symptom that
-- led here.
--
-- Fix: widen search_path to `public, extensions` on ONLY the four
-- functions that actually call crypt()/gen_salt() -- not all of them,
-- since the rest have no pgcrypto dependency and narrowing what each
-- function can see is the whole point of pinning search_path at all.
-- Reproduced the failure locally first (a fresh database with pgcrypto
-- installed into its own `extensions` schema, matching Supabase's
-- setup) and confirmed this fix resolves it before shipping it.
--
-- Bodies below are byte-identical to component 6's originals except for
-- this one line -- migrations are append-only, so this replaces the
-- functions in place via `create or replace` rather than editing the
-- earlier file.

create or replace function create_room(
  p_display_name text,
  p_platforms text[],
  p_pin text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_code text;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    return jsonb_build_object('status', 'BAD_DISPLAY_NAME');
  end if;

  if p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('status', 'BAD_PIN_FORMAT');
  end if;

  if p_platforms is null or array_length(p_platforms, 1) is null then
    return jsonb_build_object('status', 'NO_PLATFORMS');
  end if;
  if exists (
    select 1 from unnest(p_platforms) p
    where p not in ('netflix', 'prime', 'disney', 'hulu')
  ) then
    return jsonb_build_object('status', 'BAD_PLATFORM');
  end if;

  insert into users (id, display_name)
  values (v_uid, trim(p_display_name))
  on conflict (id) do update set display_name = excluded.display_name;

  if exists (select 1 from room_members where user_id = v_uid) then
    return jsonb_build_object('status', 'ALREADY_IN_ROOM');
  end if;

  v_code := generate_room_code();

  insert into rooms (code, platforms)
  values (v_code, p_platforms)
  returning id into v_room_id;

  insert into room_secrets (room_id, pin_hash)
  values (v_room_id, crypt(p_pin, gen_salt('bf')));

  insert into room_members (room_id, user_id)
  values (v_room_id, v_uid);

  return jsonb_build_object(
    'status', 'OK',
    'room', jsonb_build_object(
      'id', v_room_id,
      'code', v_code,
      'platforms', to_jsonb(p_platforms)
    )
  );
end;
$$;

create or replace function join_room(
  p_code text,
  p_pin text,
  p_display_name text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room rooms%rowtype;
  v_pin_hash text;
  v_recent_failures int;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    return jsonb_build_object('status', 'BAD_DISPLAY_NAME');
  end if;

  insert into users (id, display_name)
  values (v_uid, trim(p_display_name))
  on conflict (id) do update set display_name = excluded.display_name;

  select * into v_room from rooms where code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('status', 'BAD_CODE');
  end if;

  select count(*) into v_recent_failures
  from join_attempts
  where room_id = v_room.id
    and not succeeded
    and attempted_at > now() - app_join_attempt_window();

  if v_recent_failures >= app_join_attempt_limit() then
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;

  select pin_hash into v_pin_hash from room_secrets where room_id = v_room.id;

  if v_pin_hash is null or v_pin_hash <> crypt(p_pin, v_pin_hash) then
    insert into join_attempts (room_id, attempted_by, succeeded)
    values (v_room.id, v_uid, false);
    return jsonb_build_object('status', 'BAD_PIN');
  end if;

  if exists (select 1 from room_members where user_id = v_uid and room_id = v_room.id) then
    return jsonb_build_object(
      'status', 'OK',
      'room', jsonb_build_object('id', v_room.id, 'code', v_room.code,
                                 'platforms', to_jsonb(v_room.platforms))
    );
  end if;

  if exists (select 1 from room_members where user_id = v_uid) then
    return jsonb_build_object('status', 'ALREADY_IN_ROOM');
  end if;

  begin
    insert into room_members (room_id, user_id) values (v_room.id, v_uid);
  exception when others then
    if sqlerrm = 'ROOM_FULL' then
      insert into join_attempts (room_id, attempted_by, succeeded)
      values (v_room.id, v_uid, true);
      return jsonb_build_object('status', 'ROOM_FULL');
    end if;
    raise;
  end;

  insert into join_attempts (room_id, attempted_by, succeeded)
  values (v_room.id, v_uid, true);

  return jsonb_build_object(
    'status', 'OK',
    'room', jsonb_build_object('id', v_room.id, 'code', v_room.code,
                               'platforms', to_jsonb(v_room.platforms))
  );
end;
$$;

create or replace function room_members_for_reclaim(
  p_code text,
  p_pin text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room rooms%rowtype;
  v_pin_hash text;
  v_recent_failures int;
  v_members jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select * into v_room from rooms where code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('status', 'BAD_CODE');
  end if;

  select count(*) into v_recent_failures
  from join_attempts
  where room_id = v_room.id
    and not succeeded
    and attempted_at > now() - app_join_attempt_window();

  if v_recent_failures >= app_join_attempt_limit() then
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;

  select pin_hash into v_pin_hash from room_secrets where room_id = v_room.id;
  if v_pin_hash is null or v_pin_hash <> crypt(p_pin, v_pin_hash) then
    insert into join_attempts (room_id, attempted_by, succeeded)
    values (v_room.id, v_uid, false);
    return jsonb_build_object('status', 'BAD_PIN');
  end if;

  select jsonb_agg(jsonb_build_object(
           'user_id', u.id,
           'display_name', u.display_name,
           'reclaimable', u.last_seen_at < now() - app_reclaim_idle_hours()
         ) order by rm.joined_at)
    into v_members
  from room_members rm
  join users u on u.id = rm.user_id
  where rm.room_id = v_room.id;

  return jsonb_build_object('status', 'OK', 'members', coalesce(v_members, '[]'::jsonb));
end;
$$;

create or replace function reclaim_membership(
  p_code text,
  p_pin text,
  p_member_user_id uuid
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room rooms%rowtype;
  v_pin_hash text;
  v_recent_failures int;
  v_target users%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select * into v_room from rooms where code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('status', 'BAD_CODE');
  end if;

  select count(*) into v_recent_failures
  from join_attempts
  where room_id = v_room.id
    and not succeeded
    and attempted_at > now() - app_join_attempt_window();

  if v_recent_failures >= app_join_attempt_limit() then
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;

  select pin_hash into v_pin_hash from room_secrets where room_id = v_room.id;
  if v_pin_hash is null or v_pin_hash <> crypt(p_pin, v_pin_hash) then
    insert into join_attempts (room_id, attempted_by, succeeded)
    values (v_room.id, v_uid, false);
    return jsonb_build_object('status', 'BAD_PIN');
  end if;

  if p_member_user_id = v_uid then
    return jsonb_build_object('status', 'OK', 'room',
      jsonb_build_object('id', v_room.id, 'code', v_room.code,
                         'platforms', to_jsonb(v_room.platforms)));
  end if;

  if not exists (
    select 1 from room_members
    where room_id = v_room.id and user_id = p_member_user_id
  ) then
    return jsonb_build_object('status', 'NOT_A_MEMBER');
  end if;

  select * into v_target from users where id = p_member_user_id;

  if v_target.last_seen_at >= now() - app_reclaim_idle_hours() then
    return jsonb_build_object('status', 'MEMBER_ACTIVE');
  end if;

  if exists (select 1 from room_members where user_id = v_uid) then
    return jsonb_build_object('status', 'ALREADY_IN_ROOM');
  end if;

  insert into users (id, display_name)
  values (v_uid, v_target.display_name)
  on conflict (id) do nothing;

  delete from swipes s
  where s.user_id = v_uid
    and exists (
      select 1 from swipes o
      where o.user_id = p_member_user_id
        and o.tmdb_id = s.tmdb_id
        and o.media_type = s.media_type
    );

  update swipes set user_id = v_uid where user_id = p_member_user_id;

  update watched set marked_by = v_uid where marked_by = p_member_user_id;

  update room_members
  set user_id = v_uid
  where room_id = v_room.id and user_id = p_member_user_id;

  update users
  set display_name = v_target.display_name,
      last_seen_at = now()
  where id = v_uid;

  insert into join_attempts (room_id, attempted_by, succeeded)
  values (v_room.id, v_uid, true);

  return jsonb_build_object(
    'status', 'OK',
    'room', jsonb_build_object('id', v_room.id, 'code', v_room.code,
                               'platforms', to_jsonb(v_room.platforms))
  );
end;
$$;
