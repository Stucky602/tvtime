-- Architecture ref: ARCHITECTURE_v1.0.md §6.5 (RPC table), §6, §7, §2.4, §5.2
--
-- Component 6. Every write that needs to see past RLS lives here.
--
-- All functions are SECURITY DEFINER with a pinned search_path. They are
-- owned by postgres and therefore bypass RLS entirely -- which is the
-- whole point, since each one legitimately needs to touch rows the caller
-- cannot see: room_secrets (PIN hashes, readable by nobody),
-- join_attempts (rate limiting), a partner's swipes (bucket
-- classification), or a room the caller has not joined yet.
--
-- Because they bypass RLS, every function starts by resolving auth.uid()
-- and re-derives authorization itself. Nothing here trusts a caller-
-- supplied user id.
--
-- ---------------------------------------------------------------------
-- RETURN CONVENTION
-- ---------------------------------------------------------------------
-- Every function returns jsonb with a `status` key. Expected outcomes
-- (BAD_PIN, ROOM_FULL, RATE_LIMITED, ...) come back as data, not as
-- raised exceptions, so the client handles them with a branch instead of
-- a try/catch. Exceptions are reserved for genuine faults.
--
-- The one deliberate exception is ROOM_FULL from the capacity trigger,
-- which raises inside the insert -- it's caught and converted to a status
-- below so the client sees one consistent shape.
--
-- ---------------------------------------------------------------------
-- last_seen_at IS LOAD-BEARING (a gap closed here)
-- ---------------------------------------------------------------------
-- §7's reclaim guard refuses to evict a member whose `last_seen_at` is
-- newer than RECLAIM_IDLE_HOURS. But nothing in components 2-5 ever
-- writes that column -- it defaults to now() at signup and then sits
-- there forever. Left that way, every user looks permanently idle 24
-- hours after creating their account, and the guard that's supposed to
-- stop someone with the code and PIN from evicting a live partner would
-- wave through every attempt.
--
-- Closed here: submit_swipe touches last_seen_at (it's by far the most
-- frequent action), and touch_session() exists for the client to call on
-- app focus -- which §6.5 already does for badge refresh, so it costs no
-- extra round trip. Without both, the reclaim idle check is decorative.

-- =====================================================================
-- Config constants (§12)
-- =====================================================================
-- Kept as functions rather than hardcoded literals so the values are
-- greppable and changeable in one place, matching §12's intent that
-- these are tuned rather than fixed.

create or replace function app_join_attempt_limit() returns int
  language sql immutable as $$ select 5 $$;

create or replace function app_join_attempt_window() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

create or replace function app_reclaim_idle_hours() returns interval
  language sql immutable as $$ select interval '24 hours' $$;

-- §12 sets UNDO_WINDOW_SECONDS = 5, which is the window the *client*
-- shows the undo button for. The server window is deliberately more
-- generous: a user tapping undo at 4.8s on a slow connection would
-- otherwise have a valid-looking undo rejected for no visible reason.
-- The grace covers round-trip latency and clock skew. It does not widen
-- what the user can do, since the button is already gone at 5s.
create or replace function app_undo_window() returns interval
  language sql immutable as $$ select interval '8 seconds' $$;

-- =====================================================================
-- Room code generation
-- =====================================================================
-- 6 characters from an alphabet with the confusable glyphs removed
-- (no 0/O, no 1/I/L). 31 symbols, so ~887 million codes -- collisions are
-- theoretical at friends-and-family scale, but the retry loop is three
-- lines so there's no reason to leave it to chance.

create or replace function generate_room_code()
  returns text
  language plpgsql
  volatile
  set search_path = public
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  candidate text;
  attempt int := 0;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from rooms where code = candidate);

    attempt := attempt + 1;
    if attempt > 20 then
      -- 20 consecutive collisions against a ~887M keyspace means
      -- something is badly wrong (an exhausted table, a broken RNG),
      -- not bad luck. Fail loudly rather than spin.
      raise exception 'CODE_GENERATION_FAILED';
    end if;
  end loop;

  return candidate;
end;
$$;

-- =====================================================================
-- create_room
-- =====================================================================
-- Three writes that must land together: the room, its PIN hash, and the
-- creator's membership. This atomicity is exactly why component 5
-- declined to grant clients a direct insert on `rooms` -- a client-side
-- insert could only ever do the first, leaving a PIN-less room nobody
-- could join.

create or replace function create_room(
  p_display_name text,
  p_platforms text[],
  p_pin text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
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

  -- 4 digits. Validated server-side because a client that skips the
  -- check would otherwise store an unguessable-but-also-unenterable PIN.
  if p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('status', 'BAD_PIN_FORMAT');
  end if;

  -- Platforms must be a subset of the four the app supports (§1). An
  -- unrecognized value here would silently never match any title's
  -- provider list, producing an empty deck with no visible cause.
  if p_platforms is null or array_length(p_platforms, 1) is null then
    return jsonb_build_object('status', 'NO_PLATFORMS');
  end if;
  if exists (
    select 1 from unnest(p_platforms) p
    where p not in ('netflix', 'prime', 'disney', 'hulu')
  ) then
    return jsonb_build_object('status', 'BAD_PLATFORM');
  end if;

  -- The caller may not have a users row yet (anonymous sign-in creates
  -- the auth.users row, not this one).
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

-- =====================================================================
-- join_room
-- =====================================================================
-- Order of checks matters here and is not arbitrary:
--   resolve code -> rate limit -> PIN -> membership -> capacity
--
-- Rate limiting sits after code resolution because join_attempts.room_id
-- is a foreign key -- there is no room to log an attempt against until
-- the code resolves. That does leave code enumeration unthrottled, which
-- is a deliberate accept: a wrong code reveals only that no room has it,
-- the keyspace is ~887M, and §7 is explicit that the threat model here is
-- "a bored friend," not an adversary. The PIN, which is the thing worth
-- guessing, is fully rate-limited.
--
-- `join_attempts.succeeded` means "the credential check passed", NOT
-- "the join completed". Only a wrong PIN is a failure. See the ROOM_FULL
-- branch below for why that distinction is load-bearing.

create or replace function join_room(
  p_code text,
  p_pin text,
  p_display_name text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
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

  -- Codes are generated uppercase; accept any casing the user types.
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

  -- Idempotent: re-joining the room you're already in is a success, not
  -- an error. Covers a double-tapped join button.
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

  -- The capacity trigger raises ROOM_FULL. Caught here and converted so
  -- the client gets the same jsonb shape as every other outcome.
  begin
    insert into room_members (room_id, user_id) values (v_room.id, v_uid);
  exception when others then
    if sqlerrm = 'ROOM_FULL' then
      -- Logged as SUCCEEDED, deliberately. `succeeded` tracks whether the
      -- credential check passed, not whether the join completed -- and
      -- reaching this line means the PIN was correct. Counting it as a
      -- failure would be actively harmful: a user who lost their session
      -- enters the right code and PIN, gets ROOM_FULL, and is offered the
      -- §7 reclaim flow. If those attempts fed the brute-force counter,
      -- a few taps would rate-limit them out of their own recovery path.
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

-- =====================================================================
-- room_members_for_reclaim
-- =====================================================================
-- Feeds §7's "this is my room, I lost my session" screen, which lists the
-- room's members by display name so the user can pick which one they are.
-- Requires the PIN, and is rate-limited on the same counter as join_room
-- -- otherwise it would be a way to read a room's member names with only
-- a code, which join_room itself does not permit.

create or replace function room_members_for_reclaim(
  p_code text,
  p_pin text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
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
           -- Drives the UI's "(active recently)" affordance so a user
           -- isn't offered a reclaim that's going to be refused.
           'reclaimable', u.last_seen_at < now() - app_reclaim_idle_hours()
         ) order by rm.joined_at)
    into v_members
  from room_members rm
  join users u on u.id = rm.user_id
  where rm.room_id = v_room.id;

  return jsonb_build_object('status', 'OK', 'members', coalesce(v_members, '[]'::jsonb));
end;
$$;

-- =====================================================================
-- reclaim_membership
-- =====================================================================
-- §7's recovery path for a lost anonymous identity (cleared browser data,
-- new phone). Repoints the membership at the caller and carries the old
-- identity's swipe history across.
--
-- The swipe reassignment needs care. The architecture's sign-off assumed
-- a reclaiming identity has no swipes of its own, which is true in the
-- common case but not guaranteed: a user can sign in fresh, swipe a few
-- cards, and only then realize they should reclaim. `swipes` is keyed on
-- (user_id, tmdb_id, media_type), so a blind UPDATE would hit a primary
-- key collision on any title both identities voted on.
--
-- Resolved by deleting only the caller's *colliding* rows before the
-- update. The old identity's vote wins on conflicts (it's the history
-- being restored, and it's the one the partner's buckets already
-- reflect), while any titles only the new identity swiped survive. No
-- history is discarded.

create or replace function reclaim_membership(
  p_code text,
  p_pin text,
  p_member_user_id uuid
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
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

  -- Reclaiming yourself is a no-op success (double-tapped button).
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

  -- The guard that makes this safe: someone holding the code and PIN
  -- must not be able to evict a partner who is actively using the app.
  if v_target.last_seen_at >= now() - app_reclaim_idle_hours() then
    return jsonb_build_object('status', 'MEMBER_ACTIVE');
  end if;

  if exists (select 1 from room_members where user_id = v_uid) then
    return jsonb_build_object('status', 'ALREADY_IN_ROOM');
  end if;

  insert into users (id, display_name)
  values (v_uid, v_target.display_name)
  on conflict (id) do nothing;

  -- Drop only the caller's rows that would collide, then carry the old
  -- identity's history over. See the note above this function.
  delete from swipes s
  where s.user_id = v_uid
    and exists (
      select 1 from swipes o
      where o.user_id = p_member_user_id
        and o.tmdb_id = s.tmdb_id
        and o.media_type = s.media_type
    );

  update swipes set user_id = v_uid where user_id = p_member_user_id;

  -- Same person, so the audit field should follow them rather than point
  -- at an identity that no longer has a membership.
  update watched set marked_by = v_uid where marked_by = p_member_user_id;

  -- Preserve joined_at: the §3.2 bucket views scope votes to
  -- voted_at >= joined_at, so resetting it here would orphan every swipe
  -- just restored and empty the Together tab.
  update room_members
  set user_id = v_uid
  where room_id = v_room.id and user_id = p_member_user_id;

  -- Carry the display name over and mark the new identity live, so the
  -- reclaim can't immediately be undone by someone else.
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

-- =====================================================================
-- submit_swipe
-- =====================================================================
-- §6: the write and the match check are ONE round trip, so the transient
-- match indicator can render before the next card animates in.
--
-- The classification is computed inline rather than by selecting from
-- user_title_buckets. That view is security_invoker, and "invoker" inside
-- a SECURITY DEFINER function is the function owner -- so it would work,
-- but only by way of a subtlety that a later reader would have to
-- re-derive. Explicit SQL here says what it means. The joined_at scoping
-- (§7) is reproduced deliberately; dropping it would let pre-join votes
-- fabricate matches.

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
    -- The deck is built from `titles`, so this means a stale client is
    -- swiping a card that has since been removed from the cache.
    return jsonb_build_object('status', 'UNKNOWN_TITLE');
  end if;

  select rm.room_id, rm.joined_at into v_room_id, v_joined_at
  from room_members rm where rm.user_id = v_uid;

  select direction into v_prior_direction
  from swipes
  where user_id = v_uid and tmdb_id = p_tmdb_id and media_type = p_media_type;

  -- Upsert, so a retried request or a double-tap is a no-op rather than
  -- a duplicate or a flipped vote (§6, idempotency).
  insert into swipes (user_id, tmdb_id, media_type, direction, voted_at, score_debug)
  values (v_uid, p_tmdb_id, p_media_type, p_direction, now(), p_score_debug)
  on conflict (user_id, tmdb_id, media_type) do update
    set direction = excluded.direction,
        voted_at = excluded.voted_at,
        score_debug = coalesce(excluded.score_debug, swipes.score_debug);

  -- Keeps the §7 reclaim idle check meaningful. See the header note.
  update users set last_seen_at = now() where id = v_uid;

  -- No room yet: the vote is recorded, but there is nothing to classify
  -- against. §3.2's guard, same reasoning as the view's member_count < 2.
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

  -- The match indicator should fire on the swipe that *creates* the
  -- match, not every time an already-matched title is re-submitted.
  --
  -- coalesce is doing real work here, not defensive padding: v_bucket is
  -- null whenever the title has no tab from this viewer's side (the
  -- left-voter in a split, or a room without a partner yet). `null =
  -- 'together'` is null, and `null and true` is null, so without this the
  -- function returns null for a field the client contract says is
  -- boolean.
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

-- =====================================================================
-- undo_swipe
-- =====================================================================
-- §6: last swipe only, within the undo window, own rows only. Deleting
-- the row is the entire undo -- because Together is a view over swipes,
-- a match that just fired retracts itself with no cleanup logic.

create or replace function undo_swipe(
  p_tmdb_id int,
  p_media_type text
)
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

  delete from swipes
  where user_id = v_uid
    and tmdb_id = p_tmdb_id
    and media_type = p_media_type
    and voted_at >= now() - app_undo_window();

  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    -- Either the swipe was never there, belongs to someone else, or the
    -- window closed. All three are the same thing from the client's
    -- side: the card is not coming back.
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  update users set last_seen_at = now() where id = v_uid;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- mark_watched
-- =====================================================================
-- §2.4. Room-scoped (watching is a joint act), verdict optional and
-- applied later by the toast.
--
-- The conflict clause coalesces rather than overwrites, because the two
-- calls arrive in sequence: mark (verdict null), then verdict up/down a
-- few seconds later. A plain overwrite would let the second call's null
-- erase a verdict on any path where they arrive out of order.
--
-- Unmarking is a plain DELETE from the client -- component 5 grants room
-- members delete on `watched`, so it needs no RPC.

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

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- leave_room
-- =====================================================================
-- §7: drops the membership row, retains swipes. The retained swipes stop
-- counting toward the old room immediately (no membership row means no
-- join in the bucket views), and if the user later joins a new room the
-- joined_at scoping keeps them out of that room's tallies too.

create or replace function leave_room()
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  delete from room_members where user_id = v_uid;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- touch_session
-- =====================================================================
-- Keeps last_seen_at current so the §7 reclaim guard means something.
-- The client already polls on focus for badge counts (§6.5), so this
-- rides along on an existing round trip rather than adding one.

create or replace function touch_session()
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  update users set last_seen_at = now() where id = v_uid;

  return jsonb_build_object('status', 'OK');
end;
$$;

-- =====================================================================
-- Grants
-- =====================================================================
-- SECURITY DEFINER functions are executable by PUBLIC unless revoked,
-- which would expose every one of these to the pre-sign-in `anon` role.
-- Each function checks auth.uid() and bails, so the exposure is bounded
-- either way, but relying on that would make the guard the only thing
-- standing between anon and a definer function. Revoke first, then grant
-- to `authenticated` only (which is the role anonymous sign-in produces).

revoke all on function create_room(text, text[], text) from public, anon;
revoke all on function join_room(text, text, text) from public, anon;
revoke all on function room_members_for_reclaim(text, text) from public, anon;
revoke all on function reclaim_membership(text, text, uuid) from public, anon;
revoke all on function submit_swipe(int, text, text, jsonb) from public, anon;
revoke all on function undo_swipe(int, text) from public, anon;
revoke all on function mark_watched(int, text, text) from public, anon;
revoke all on function leave_room() from public, anon;
revoke all on function touch_session() from public, anon;
revoke all on function generate_room_code() from public, anon, authenticated;

grant execute on function create_room(text, text[], text) to authenticated;
grant execute on function join_room(text, text, text) to authenticated;
grant execute on function room_members_for_reclaim(text, text) to authenticated;
grant execute on function reclaim_membership(text, text, uuid) to authenticated;
grant execute on function submit_swipe(int, text, text, jsonb) to authenticated;
grant execute on function undo_swipe(int, text) to authenticated;
grant execute on function mark_watched(int, text, text) to authenticated;
grant execute on function leave_room() to authenticated;
grant execute on function touch_session() to authenticated;
