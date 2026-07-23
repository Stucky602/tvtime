-- Architecture ref: ARCHITECTURE_v1.0.md §4.4, §5.1, §10
--
-- Two gaps closed here, both discovered while building component 7,
-- which depends on both being correct.
--
-- ---------------------------------------------------------------------
-- 1. rooms.last_active_at was never written (same shape of bug as
--    users.last_seen_at, fixed in component 6)
-- ---------------------------------------------------------------------
-- §10 says the pool-refresh job should skip "rooms with no activity in
-- 30 days" when deciding which platforms to pull for. `last_active_at`
-- exists on `rooms` specifically for this, defaulting to now() at
-- creation -- but nothing after creation ever updated it. A room stays
-- "active" for exactly 30 days after it was CREATED regardless of
-- whether anyone ever opens the app again, then silently and
-- permanently reads as abandoned even if two people swipe every night.
--
-- Fixed the same way as last_seen_at: submit_swipe and mark_watched
-- (component 6) are the two actions that mean "this room is in use,"
-- so both now touch rooms.last_active_at. Since the fix touches
-- functions that already exist, this migration replaces them rather
-- than editing 20260722220600_rpcs.sql in place -- migrations are
-- append-only.
--
-- ---------------------------------------------------------------------
-- 2. No schema support for the room-level reality-show toggle
-- ---------------------------------------------------------------------
-- §4.4: "Reality is arguable and some couples want it. Make it a room
-- setting rather than a hard rule, defaulting to excluded." Components
-- 2-6 never added anywhere to store that setting, and `titles.excluded`
-- (component 2) is a single global boolean -- it can't mean "excluded
-- for this room, included for that one," which is what a per-room
-- setting requires.
--
-- Two columns fix this: `rooms.include_reality` (the room's choice,
-- default false, matching the spec's "defaulting to excluded") and
-- `titles.is_reality` (a flag distinct from `excluded`, set by component
-- 7 when a title carries TMDB's Reality genre). Reality titles are
-- NEVER globally excluded -- component 9's deck build (not yet written)
-- is what will filter `is_reality` titles out for rooms that haven't
-- opted in, the same way it already filters on `providers`.
--
-- Reality could not simply be added to the existing hard-exclusion set
-- in component 7, because "Other" (canonical genre 12, from component
-- 4) already absorbs Reality alongside News, Talk, Soap, History, Music,
-- and several others that have nothing to do with each other -- not
-- specific enough to filter on later. `is_reality` is the dedicated,
-- unambiguous signal that a per-room toggle can actually act on.

alter table rooms add column include_reality boolean not null default false;
alter table titles add column is_reality boolean not null default false;

-- Extends component 5's column-grant pattern: members may toggle this
-- setting the same way they can change `platforms`, and nothing else.
grant update (include_reality) on rooms to authenticated;

create or replace function submit_swipe(
  p_tmdb_id int,
  p_media_type text,
  p_direction text,
  p_score_debug jsonb default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_joined_at timestamptz;
  v_prior_direction text;
  v_rights int;
  v_lefts int;
  v_total int;
  v_members int;
  v_bucket text;
  v_is_new_match boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  if p_direction not in ('left', 'right') then
    return jsonb_build_object('status', 'BAD_DIRECTION');
  end if;
  if p_media_type not in ('movie', 'tv') then
    return jsonb_build_object('status', 'BAD_MEDIA_TYPE');
  end if;

  if not exists (
    select 1 from titles where tmdb_id = p_tmdb_id and media_type = p_media_type
  ) then
    return jsonb_build_object('status', 'UNKNOWN_TITLE');
  end if;

  select rm.room_id, rm.joined_at into v_room_id, v_joined_at
  from room_members rm where rm.user_id = v_uid;

  select direction into v_prior_direction
  from swipes
  where user_id = v_uid and tmdb_id = p_tmdb_id and media_type = p_media_type;

  insert into swipes (user_id, tmdb_id, media_type, direction, voted_at, score_debug)
  values (v_uid, p_tmdb_id, p_media_type, p_direction, now(), p_score_debug)
  on conflict (user_id, tmdb_id, media_type) do update
    set direction = excluded.direction,
        voted_at = excluded.voted_at,
        score_debug = coalesce(excluded.score_debug, swipes.score_debug);

  update users set last_seen_at = now() where id = v_uid;

  -- New in this migration: keeps rooms.last_active_at meaningful. See
  -- the header note above -- without this, component 7's "skip inactive
  -- rooms" check runs off a value that's frozen at room-creation time.
  if v_room_id is not null then
    update rooms set last_active_at = now() where id = v_room_id;
  end if;

  if v_room_id is null then
    return jsonb_build_object('status', 'OK', 'bucket', null, 'is_new_match', false);
  end if;

  select
    count(*) filter (where s.direction = 'right'),
    count(*) filter (where s.direction = 'left'),
    count(*)
  into v_rights, v_lefts, v_total
  from swipes s
  join room_members rm on rm.user_id = s.user_id
  where rm.room_id = v_room_id
    and s.tmdb_id = p_tmdb_id
    and s.media_type = p_media_type
    and s.voted_at >= rm.joined_at;

  select count(*) into v_members from room_members where room_id = v_room_id;

  if v_members < 2 then
    v_bucket := null;
  elsif v_total = v_members and v_lefts = 0 then
    v_bucket := 'together';
  elsif v_rights = 1 and v_lefts = 1 and p_direction = 'right' then
    v_bucket := 'solo';
  elsif v_total < v_members then
    v_bucket := 'pending';
  elsif v_rights = 0 and v_total = v_members then
    v_bucket := 'dead';
  end if;

  v_is_new_match := coalesce(
    (v_bucket = 'together') and (v_prior_direction is distinct from 'right'),
    false
  );

  return jsonb_build_object(
    'status', 'OK',
    'bucket', v_bucket,
    'is_new_match', v_is_new_match
  );
end;
$$;

create or replace function mark_watched(
  p_tmdb_id int,
  p_media_type text,
  p_verdict text default null
)
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

  if p_verdict is not null and p_verdict not in ('up', 'down') then
    return jsonb_build_object('status', 'BAD_VERDICT');
  end if;

  select room_id into v_room_id from room_members where user_id = v_uid;
  if v_room_id is null then
    return jsonb_build_object('status', 'NOT_IN_ROOM');
  end if;

  if not exists (
    select 1 from titles where tmdb_id = p_tmdb_id and media_type = p_media_type
  ) then
    return jsonb_build_object('status', 'UNKNOWN_TITLE');
  end if;

  insert into watched (room_id, tmdb_id, media_type, marked_by, verdict)
  values (v_room_id, p_tmdb_id, p_media_type, v_uid, p_verdict)
  on conflict (room_id, tmdb_id, media_type) do update
    set verdict = coalesce(excluded.verdict, watched.verdict),
        marked_by = excluded.marked_by,
        marked_at = now();

  update users set last_seen_at = now() where id = v_uid;
  update rooms set last_active_at = now() where id = v_room_id;

  return jsonb_build_object('status', 'OK');
end;
$$;
