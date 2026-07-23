-- FlixPix: recognise someone who leaves and comes back.
--
-- THE PROBLEM, which is bigger than it first looks.
--
-- `leave_room()` deletes the room_members row outright, and the bucket
-- views scope a member's votes to `voted_at >= rm.joined_at` (the
-- re-rooming guard). So rejoining stamps a fresh joined_at, every swipe
-- you ever made now predates your membership, and Together / Solo /
-- Pending all go empty. Your history is still in the database; the room
-- just can't see any of it.
--
-- On a NEW device it's worse again: anonymous sign-in mints a new
-- auth identity, so the old swipes belong to a user_id nobody is using
-- any more and there's nothing to scope in the first place.
--
-- THE FIX. Remember memberships after they end, and on rejoin match
-- either by identity (same device) or by display name (any device),
-- then restore the original joined_at and pull the old identity's
-- swipes across.
--
-- On matching by name: it is a weak identifier in general, but the
-- threat model here is already bounded -- you cannot reach this code
-- path without the room code AND the PIN, and a room holds two people
-- who know each other. Within those constraints, "same name means same
-- person" is a safe and useful assumption. It is also only ever used to
-- REUNITE someone with data they created; it never grants access to
-- anything a plain join wouldn't already give.

create table if not exists room_past_members (
  room_id           uuid not null references rooms(id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  -- Normalised at write time so the lookup is a plain equality test
  -- rather than a function call that can't use the index.
  display_name_norm text not null,
  first_joined_at   timestamptz not null,
  left_at           timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_past_members_lookup_idx
  on room_past_members (room_id, display_name_norm);

alter table room_past_members enable row level security;
-- No policies, and grants revoked: written and read only by the
-- SECURITY DEFINER functions below. Same posture as room_secrets.
revoke all on room_past_members from authenticated, anon;

-- =====================================================================
-- leave_room: record the membership before dropping it
-- =====================================================================

create or replace function leave_room()
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_joined_at timestamptz;
  v_name text;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select rm.room_id, rm.joined_at into v_room_id, v_joined_at
  from room_members rm where rm.user_id = v_uid;

  if v_room_id is null then
    return jsonb_build_object('status', 'OK'); -- already out; idempotent
  end if;

  select display_name into v_name from users where id = v_uid;

  -- Preserve the ORIGINAL first_joined_at across repeated leave/rejoin
  -- cycles. Someone who joins, leaves, rejoins and leaves again should
  -- still get their earliest history back, not just the last stint's.
  insert into room_past_members (room_id, user_id, display_name_norm, first_joined_at, left_at)
  values (v_room_id, v_uid, lower(trim(coalesce(v_name, ''))), v_joined_at, now())
  on conflict (room_id, user_id) do update
    set display_name_norm = excluded.display_name_norm,
        first_joined_at = least(room_past_members.first_joined_at, excluded.first_joined_at),
        left_at = excluded.left_at;

  delete from room_members where user_id = v_uid;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- remove_member: same bookkeeping when someone is kicked
-- =====================================================================
-- Someone who was removed and later rejoins with the code and PIN is
-- just as much "the same person" as someone who left voluntarily, so
-- their history is preserved on the same terms.

create or replace function remove_member(p_member_user_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_joined_at timestamptz;
  v_name text;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select room_id into v_room_id from room_members where user_id = v_uid;
  if v_room_id is null then
    return jsonb_build_object('status', 'NOT_IN_ROOM');
  end if;

  if p_member_user_id = v_uid then
    return jsonb_build_object('status', 'CANNOT_REMOVE_SELF');
  end if;

  select rm.joined_at into v_joined_at
  from room_members rm
  where rm.room_id = v_room_id and rm.user_id = p_member_user_id;

  if v_joined_at is null then
    return jsonb_build_object('status', 'NOT_A_MEMBER');
  end if;

  select display_name into v_name from users where id = p_member_user_id;

  insert into room_past_members (room_id, user_id, display_name_norm, first_joined_at, left_at)
  values (v_room_id, p_member_user_id, lower(trim(coalesce(v_name, ''))), v_joined_at, now())
  on conflict (room_id, user_id) do update
    set display_name_norm = excluded.display_name_norm,
        first_joined_at = least(room_past_members.first_joined_at, excluded.first_joined_at),
        left_at = excluded.left_at;

  delete from room_members
  where room_id = v_room_id and user_id = p_member_user_id;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- join_room: recognise a returning member
-- =====================================================================

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
  v_past room_past_members%rowtype;
  v_joined_at timestamptz := now();
  v_restored boolean := false;
  v_restored_swipes int := 0;
  v_name_norm text := lower(trim(coalesce(p_display_name, '')));
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

  -- Already seated: idempotent success (covers a double-tapped button).
  if exists (select 1 from room_members where user_id = v_uid and room_id = v_room.id) then
    return jsonb_build_object(
      'status', 'OK',
      'restored', false,
      'room', jsonb_build_object('id', v_room.id, 'code', v_room.code,
                                 'platforms', to_jsonb(v_room.platforms))
    );
  end if;

  if exists (select 1 from room_members where user_id = v_uid) then
    return jsonb_build_object('status', 'ALREADY_IN_ROOM');
  end if;

  -- ---- Recognise a returning member ----
  -- Prefer an exact identity match (same device) over a name match
  -- (new device), and among name matches take the most recent.
  -- Deliberately excludes anyone currently seated, so a second person
  -- picking the same display name can never hijack a live member.
  select * into v_past
  from room_past_members pm
  where pm.room_id = v_room.id
    and (pm.user_id = v_uid or pm.display_name_norm = v_name_norm)
    and not exists (
      select 1 from room_members rm
      where rm.room_id = pm.room_id and rm.user_id = pm.user_id
    )
  order by (pm.user_id = v_uid) desc, pm.left_at desc
  limit 1;

  if found then
    -- Restoring the original joined_at is the whole point: the bucket
    -- views scope votes to voted_at >= joined_at, so a fresh timestamp
    -- would leave every past swipe invisible to the room.
    v_joined_at := v_past.first_joined_at;
    v_restored := true;

    if v_past.user_id <> v_uid then
      -- Same person, different device. Move the old identity's history
      -- onto the current one.
      --
      -- swipes is keyed (user_id, tmdb_id, media_type), so a blind
      -- UPDATE would collide on any title both identities voted on.
      -- Drop the NEW identity's colliding rows first: the restored
      -- history wins, since that's the data being recovered and it's
      -- what the partner's buckets already reflect.
      delete from swipes s
      where s.user_id = v_uid
        and exists (
          select 1 from swipes o
          where o.user_id = v_past.user_id
            and o.tmdb_id = s.tmdb_id
            and o.media_type = s.media_type
        );

      update swipes set user_id = v_uid where user_id = v_past.user_id;
      get diagnostics v_restored_swipes = row_count;

      update watched set marked_by = v_uid where marked_by = v_past.user_id;
    else
      select count(*) into v_restored_swipes from swipes where user_id = v_uid;
    end if;

    delete from room_past_members
    where room_id = v_room.id and user_id = v_past.user_id;
  end if;

  begin
    insert into room_members (room_id, user_id, joined_at)
    values (v_room.id, v_uid, v_joined_at);
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
    'restored', v_restored,
    'restored_swipes', v_restored_swipes,
    'room', jsonb_build_object('id', v_room.id, 'code', v_room.code,
                               'platforms', to_jsonb(v_room.platforms))
  );
end;
$$;
