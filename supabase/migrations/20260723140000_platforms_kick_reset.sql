-- FlixPix polish round.
--
-- Three things:
--   1. The platform whitelist grows from 4 services to 8.
--   2. remove_member() -- kick someone out of your room.
--   3. reset_my_data() -- wipe your own swipes/preferences without
--      touching your partner's.

-- =====================================================================
-- 1. Platform whitelist
-- =====================================================================
-- create_room hardcoded the four original services and rejected
-- anything else with BAD_PLATFORM. Now eight. Kept as an explicit list
-- rather than dropping validation entirely: an unrecognised slug would
-- silently never match any title's provider array, producing an empty
-- deck with no visible cause, which is a miserable thing to debug.

create or replace function app_valid_platforms() returns text[]
  language sql immutable as $$
    select array['netflix','prime','disney','hulu','max','appletv','peacock','paramount']
  $$;

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
    where p <> all (app_valid_platforms())
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
      'id', v_room_id, 'code', v_code, 'platforms', to_jsonb(p_platforms)
    )
  );
end;
$$;

-- =====================================================================
-- 2. remove_member -- kick your partner out of the room
-- =====================================================================
-- Deliberately simple, because the room has exactly two people and they
-- are a couple: any member may remove the other, no PIN required (you
-- are already inside the room, which is the hard part). The one rule is
-- that you cannot remove yourself through this path -- that's
-- leave_room(), which exists and has different semantics.
--
-- What it does NOT do: delete the removed person's swipes. Those stay
-- attached to their user row. If they rejoin later the joined_at
-- scoping means their old votes don't retroactively count toward the
-- room, which is the same rule as any other join.

create or replace function remove_member(p_member_user_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select room_id into v_room_id from room_members where user_id = v_uid;
  if v_room_id is null then
    return jsonb_build_object('status', 'NOT_IN_ROOM');
  end if;

  if p_member_user_id = v_uid then
    -- Removing yourself is leave_room()'s job. Routing it here would
    -- make "kick" and "leave" the same button with different copy.
    return jsonb_build_object('status', 'CANNOT_REMOVE_SELF');
  end if;

  if not exists (
    select 1 from room_members
    where room_id = v_room_id and user_id = p_member_user_id
  ) then
    return jsonb_build_object('status', 'NOT_A_MEMBER');
  end if;

  delete from room_members
  where room_id = v_room_id and user_id = p_member_user_id;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- 3. reset_my_data -- wipe your own deck and preferences
-- =====================================================================
-- "Start over" without leaving the room or affecting your partner.
--
-- Scopes, chosen carefully:
--   swipes      -- yours only. Deleting these resets the deck AND
--                  every bucket that depended on them, which is the
--                  point.
--   genre_prefs -- optionally cleared, so onboarding picks can be redone.
--   watched     -- room-scoped and shared, so it is NOT touched. One
--                  person resetting must not erase the couple's record
--                  of what they have actually watched together.
--
-- The partner's swipes are untouched, so titles they voted on stay in
-- their Pending until you vote again -- which is correct, not a bug.

create or replace function reset_my_data(p_clear_genres boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted int;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  delete from swipes where user_id = v_uid;
  get diagnostics v_deleted = row_count;

  if p_clear_genres then
    update users set genre_prefs = '{}' where id = v_uid;
  end if;

  -- Badges are derived from "since you last looked", and that reference
  -- point is meaningless once the underlying votes are gone.
  update users set tab_seen_at = '{}'::jsonb where id = v_uid;

  return jsonb_build_object('status', 'OK', 'swipes_deleted', v_deleted);
end;
$$;

-- =====================================================================
-- Grants (same posture as component 6: revoke from public/anon first,
-- then grant only to authenticated).
-- =====================================================================
revoke all on function app_valid_platforms() from public, anon;
revoke all on function remove_member(uuid) from public, anon;
revoke all on function reset_my_data(boolean) from public, anon;

grant execute on function app_valid_platforms() to authenticated;
grant execute on function remove_member(uuid) to authenticated;
grant execute on function reset_my_data(boolean) to authenticated;
