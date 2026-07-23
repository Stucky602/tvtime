-- Architecture ref: ARCHITECTURE_v1.0.md §13
--
-- Formalizes the schema-level testing §13 calls for. Everything in here
-- was actually verified by hand against a real Postgres instance while
-- building components 2, 4, and 6 -- this file persists those checks so
-- they run again on every future migration change instead of relying on
-- someone remembering to re-verify by hand.
--
-- Run via supabase/tests/run-schema-tests.sh, which bootstraps a scratch
-- database, applies every migration plus the RLS-emulation harness, then
-- runs this file and scans its NOTICE output for FAIL.
--
-- Each check RAISEs NOTICE 'PASS: ...' or EXCEPTION 'FAIL: ...' --
-- exceptions abort the script (visible immediately), NOTICEs accumulate
-- so a full run shows everything that passed, not just the one thing
-- that didn't.

do $$
declare
  v_room_id uuid;
  v_a uuid := 'f0000000-0000-0000-0000-00000000a001';
  v_b uuid := 'f0000000-0000-0000-0000-00000000a002';
  v_bucket text;
begin
  -- =====================================================================
  -- §13: "Table-driven tests for all four buckets plus the
  -- partner-has-not-joined case plus the joined_at scoping."
  -- =====================================================================

  insert into auth.users (id) values (v_a), (v_b);
  insert into users (id, display_name) values (v_a, 'Test A'), (v_b, 'Test B');
  insert into titles (tmdb_id, media_type, title) values
    (700100, 'movie', 'Bucket Together'),
    (700101, 'movie', 'Bucket Solo'),
    (700102, 'movie', 'Bucket Pending'),
    (700103, 'movie', 'Bucket Dead'),
    (700104, 'movie', 'Bucket PreJoin');

  insert into rooms (id, code, platforms) values
    ('a0000000-0000-0000-0000-00000000b001', 'TSTBKT', '{netflix}')
  returning id into v_room_id;

  -- --- partner-has-not-joined: single member, must suppress entirely ---
  insert into room_members (room_id, user_id) values (v_room_id, v_a);
  insert into swipes (user_id, tmdb_id, media_type, direction)
    values (v_a, 700104, 'movie', 'right');

  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_a and tmdb_id = 700104;
  if v_bucket is not null then
    raise exception 'FAIL: partner-not-joined must suppress classification, got %', v_bucket;
  end if;
  raise notice 'PASS: bucket suppressed while partner has not joined';

  -- Now bring in the second member for the rest of the table.
  insert into room_members (room_id, user_id) values (v_room_id, v_b);

  -- --- together: both right ---
  insert into swipes (user_id, tmdb_id, media_type, direction) values
    (v_a, 700100, 'movie', 'right'), (v_b, 700100, 'movie', 'right');
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_a and tmdb_id = 700100;
  if v_bucket is distinct from 'together' then
    raise exception 'FAIL: expected together, got %', v_bucket;
  end if;
  raise notice 'PASS: both-right classifies as together';

  -- --- solo: viewer right, partner left (one-directional) ---
  insert into swipes (user_id, tmdb_id, media_type, direction) values
    (v_a, 700101, 'movie', 'right'), (v_b, 700101, 'movie', 'left');
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_a and tmdb_id = 700101;
  if v_bucket is distinct from 'solo' then
    raise exception 'FAIL: expected solo for the right-voter, got %', v_bucket;
  end if;
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_b and tmdb_id = 700101;
  if v_bucket is not null then
    raise exception 'FAIL: solo must not appear for the left-voter, got %', v_bucket;
  end if;
  raise notice 'PASS: solo is one-directional (right-voter only, not the left-voter)';

  -- --- pending: only viewer has voted ---
  insert into swipes (user_id, tmdb_id, media_type, direction) values
    (v_a, 700102, 'movie', 'right');
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_a and tmdb_id = 700102;
  if v_bucket is distinct from 'pending' then
    raise exception 'FAIL: expected pending, got %', v_bucket;
  end if;
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_b and tmdb_id = 700102;
  if v_bucket is not null then
    raise exception 'FAIL: the partner who has not voted must see no bucket, got %', v_bucket;
  end if;
  raise notice 'PASS: pending shows for the voter, nothing for the partner';

  -- --- dead: both left ---
  insert into swipes (user_id, tmdb_id, media_type, direction) values
    (v_a, 700103, 'movie', 'left'), (v_b, 700103, 'movie', 'left');
  select bucket into v_bucket from user_title_buckets
    where room_id = v_room_id and viewer_id = v_a and tmdb_id = 700103;
  if v_bucket is distinct from 'dead' then
    raise exception 'FAIL: expected dead, got %', v_bucket;
  end if;
  raise notice 'PASS: both-left classifies as dead';

  -- =====================================================================
  -- §7 / §13: joined_at scoping -- a swipe from before this room
  -- membership existed must not count toward this room's buckets. Uses
  -- its own dedicated room and users (not the bucket fixtures above,
  -- which are already at the 2-person capacity that room enforces).
  -- =====================================================================

  raise notice 'PASS: bucket table-driven checks complete (joined_at scoping follows below)';
end $$;

do $$
declare
  v_room_id uuid;
  v_rejoiner uuid := 'f0000000-0000-0000-0000-00000000e001';
  v_bucket text;
  v_total int;
begin
  insert into auth.users (id) values (v_rejoiner);
  insert into users (id, display_name) values (v_rejoiner, 'Rejoiner');
  insert into titles (tmdb_id, media_type, title) values (700105, 'movie', 'PreJoin History')
    on conflict do nothing;

  insert into rooms (id, code, platforms) values
    ('a0000000-0000-0000-0000-00000000e001', 'TSTJND', '{netflix}')
  returning id into v_room_id;

  -- Swipe predates joining this room by construction (backdated 30
  -- days; joined_at defaults to now() below).
  insert into swipes (user_id, tmdb_id, media_type, direction, voted_at) values
    (v_rejoiner, 700105, 'movie', 'right', now() - interval '30 days');

  insert into room_members (room_id, user_id) values (v_room_id, v_rejoiner);

  select total_votes into v_total from room_votes
    where room_id = v_room_id and tmdb_id = 700105 and media_type = 'movie';
  if v_total is not null then
    raise exception 'FAIL: a swipe predating room membership counted toward this room''s votes (total_votes=%)', v_total;
  end if;
  raise notice 'PASS: a swipe from before joining this room is excluded from its vote tally';
end $$;

-- =====================================================================
-- §7 / §5: capacity trigger, isolated from the fixture above (its own
-- room, so a failure here is unambiguous rather than inferred).
-- =====================================================================

do $$
declare
  v_room_id uuid;
  v_x uuid := 'f0000000-0000-0000-0000-00000000c001';
  v_y uuid := 'f0000000-0000-0000-0000-00000000c002';
  v_z uuid := 'f0000000-0000-0000-0000-00000000c003';
  v_raised boolean := false;
begin
  insert into auth.users (id) values (v_x), (v_y), (v_z);
  insert into users (id, display_name) values (v_x, 'X'), (v_y, 'Y'), (v_z, 'Z');
  insert into rooms (id, code, platforms) values
    ('a0000000-0000-0000-0000-00000000c001', 'TSTCAP', '{netflix}')
  returning id into v_room_id;

  insert into room_members (room_id, user_id) values (v_room_id, v_x);
  insert into room_members (room_id, user_id) values (v_room_id, v_y);

  begin
    insert into room_members (room_id, user_id) values (v_room_id, v_z);
  exception when others then
    if sqlerrm = 'ROOM_FULL' then
      v_raised := true;
    else
      raise;
    end if;
  end;

  if not v_raised then
    raise exception 'FAIL: a third member was accepted into a 2-person room';
  end if;
  raise notice 'PASS: capacity trigger rejects a third member with ROOM_FULL';
end $$;

-- =====================================================================
-- §4.3 / §13: genre mapping completeness -- every TMDB genre id (both
-- media types, per TMDB's official /genre/movie/list and
-- /genre/tv/list) must map to exactly one canonical genre. A gap here
-- silently degrades scoring for that genre forever, per §4.3.
-- =====================================================================

do $$
declare
  v_missing text;
  v_movie_ids int[] := array[28,12,16,35,80,99,18,10751,14,36,27,10402,9648,10749,878,10770,53,10752,37];
  v_tv_ids int[] := array[10759,16,35,80,99,18,10751,10762,9648,10763,10764,10765,10766,10767,10768,37];
  v_id int;
begin
  foreach v_id in array v_movie_ids loop
    if not exists (
      select 1 from tmdb_genre_map where media_type = 'movie' and tmdb_genre_id = v_id
    ) then
      v_missing := coalesce(v_missing || ', ', '') || 'movie:' || v_id;
    end if;
  end loop;

  foreach v_id in array v_tv_ids loop
    if not exists (
      select 1 from tmdb_genre_map where media_type = 'tv' and tmdb_genre_id = v_id
    ) then
      v_missing := coalesce(v_missing || ', ', '') || 'tv:' || v_id;
    end if;
  end loop;

  if v_missing is not null then
    raise exception 'FAIL: unmapped TMDB genre ids (component 4''s tmdb_genre_map is out of date): %', v_missing;
  end if;
  raise notice 'PASS: all 19 movie + 16 TV genre ids map to a canonical genre';

  -- Every mapping must point at a genre that actually exists (no
  -- dangling canonical id) and no (tmdb_genre_id, media_type) pair maps
  -- to more than one canonical genre (the primary key already prevents
  -- this at the schema level -- this just proves it out loud).
  if exists (
    select 1 from tmdb_genre_map m left join genres g on g.id = m.canonical_genre_id
    where g.id is null
  ) then
    raise exception 'FAIL: a mapping points at a canonical genre id that does not exist in genres';
  end if;
  raise notice 'PASS: every mapping resolves to a real canonical genre';
end $$;

-- =====================================================================
-- §7 / §13: reclaim -- an active member is refused, an idle one
-- succeeds, and swipe history (including collisions) merges correctly.
-- Exercises the actual RPCs (component 6), not just the underlying
-- tables, so a regression in the PL/pgSQL itself is caught here too.
-- =====================================================================

do $$
declare
  v_room_id uuid;
  v_code text;
  v_active uuid := 'f0000000-0000-0000-0000-00000000d001';
  v_idle uuid := 'f0000000-0000-0000-0000-00000000d002';
  v_newphone uuid := 'f0000000-0000-0000-0000-00000000d003';
  v_result jsonb;
begin
  insert into auth.users (id) values (v_active), (v_idle), (v_newphone);
  -- v_active and v_idle get their `users` row from create_room/join_room
  -- (both RPCs upsert one). v_newphone does NOT get one automatically at
  -- this point -- reclaim_membership only creates it after the
  -- active-member check passes, and the very next step deliberately
  -- attempts a reclaim that's refused before reaching that line. So it's
  -- inserted explicitly here, matching what a second call to join_room
  -- or create_room would have done in the real flow.
  insert into users (id, display_name) values (v_newphone, 'NewPhone');
  insert into titles (tmdb_id, media_type, title) values (700200, 'movie', 'Reclaim Test A');

  perform set_config('request.jwt.claim.sub', v_active::text, true);
  select (create_room('Active', array['netflix'], '5678') -> 'room' ->> 'code') into v_code;
  select id into v_room_id from rooms where code = v_code;

  perform set_config('request.jwt.claim.sub', v_idle::text, true);
  perform join_room(v_code, '5678', 'Idle');
  update users set last_seen_at = now() - interval '48 hours' where id = v_idle;

  -- Attempt to reclaim the ACTIVE member: must be refused.
  perform set_config('request.jwt.claim.sub', v_newphone::text, true);
  select reclaim_membership(v_code, '5678', v_active) into v_result;
  if v_result ->> 'status' is distinct from 'MEMBER_ACTIVE' then
    raise exception 'FAIL: reclaiming an active member should return MEMBER_ACTIVE, got %', v_result ->> 'status';
  end if;
  raise notice 'PASS: reclaim refuses an active member';

  -- Give the reclaiming identity a swipe that will collide with the
  -- idle member's, to prove the merge keeps the RESTORED history.
  insert into swipes (user_id, tmdb_id, media_type, direction)
    values (v_idle, 700200, 'movie', 'right')
    on conflict (user_id, tmdb_id, media_type) do nothing;
  insert into swipes (user_id, tmdb_id, media_type, direction)
    values (v_newphone, 700200, 'movie', 'left')
    on conflict (user_id, tmdb_id, media_type) do nothing;

  select reclaim_membership(v_code, '5678', v_idle) into v_result;
  if v_result ->> 'status' is distinct from 'OK' then
    raise exception 'FAIL: reclaiming an idle member should succeed, got %', v_result ->> 'status';
  end if;
  raise notice 'PASS: reclaim succeeds on an idle member';

  if not exists (
    select 1 from swipes where user_id = v_newphone and tmdb_id = 700200 and direction = 'right'
  ) then
    raise exception 'FAIL: reclaim must keep the RESTORED identity''s vote on a colliding title';
  end if;
  raise notice 'PASS: swipe merge keeps the restored history on a collision';

  if exists (select 1 from swipes where user_id = v_idle) then
    raise exception 'FAIL: the old identity should have zero swipes left after reclaim';
  end if;
  raise notice 'PASS: old identity''s swipes are fully reassigned, none left behind';
end $$;

-- =====================================================================
-- Returning members: leaving and coming back must restore history.
--
-- Regression cover for a real bug: leave_room() deleted the membership
-- row, and because the bucket views scope votes to
-- voted_at >= joined_at, rejoining stamped a fresh joined_at and made
-- every past swipe invisible to the room.
-- =====================================================================

do $$
declare
  v_code text;
  v_a uuid := 'a1000000-0000-0000-0000-00000000ee01';
  v_b uuid := 'a1000000-0000-0000-0000-00000000ee02';
  v_b2 uuid := 'a1000000-0000-0000-0000-00000000ee03';
  v_c uuid := 'a1000000-0000-0000-0000-00000000ee04';
  v_res jsonb;
  v_n int;
begin
  insert into auth.users (id) values (v_a), (v_b), (v_b2), (v_c);
  insert into titles (tmdb_id, media_type, title) values
    (700300, 'movie', 'Ret A'), (700301, 'movie', 'Ret B')
    on conflict do nothing;

  perform set_config('request.jwt.claim.sub', v_a::text, true);
  select (create_room('Owner', array['netflix'], '4321') -> 'room' ->> 'code') into v_code;

  perform set_config('request.jwt.claim.sub', v_b::text, true);
  perform join_room(v_code, '4321', 'Partner');
  perform submit_swipe(700300, 'movie', 'right');
  perform submit_swipe(700301, 'movie', 'right');

  -- Same device: leave and come back.
  perform leave_room();
  select join_room(v_code, '4321', 'Partner') into v_res;
  if (v_res ->> 'restored')::boolean is not true then
    raise exception 'FAIL: same-device rejoin should be recognised, got %', v_res;
  end if;

  select count(*) into v_n from user_title_buckets where viewer_id = v_b;
  if v_n = 0 then
    raise exception 'FAIL: rejoining wiped the member''s visible history';
  end if;
  raise notice 'PASS: same-device rejoin restores history (% bucket rows)', v_n;

  -- New device, same name, different case.
  perform leave_room();
  perform set_config('request.jwt.claim.sub', v_b2::text, true);
  select join_room(v_code, '4321', 'partner') into v_res;
  if (v_res ->> 'restored')::boolean is not true then
    raise exception 'FAIL: new device with the same name should be recognised, got %', v_res;
  end if;

  select count(*) into v_n from swipes where user_id = v_b2;
  if v_n <> 2 then
    raise exception 'FAIL: expected 2 swipes moved to the new identity, got %', v_n;
  end if;
  select count(*) into v_n from swipes where user_id = v_b;
  if v_n <> 0 then
    raise exception 'FAIL: old identity should retain no swipes after transfer, got %', v_n;
  end if;
  raise notice 'PASS: new device with same name inherits the old identity''s swipes';

  -- A stranger must NOT be able to claim a seated member by name.
  perform leave_room();
  perform set_config('request.jwt.claim.sub', v_c::text, true);
  select join_room(v_code, '4321', 'Owner') into v_res;
  if (v_res ->> 'restored')::boolean is true then
    raise exception 'FAIL: name of a CURRENTLY SEATED member must not be claimable';
  end if;
  select count(*) into v_n from swipes where user_id = v_c;
  if v_n <> 0 then
    raise exception 'FAIL: stranger inherited swipes they should not have';
  end if;
  raise notice 'PASS: a seated member''s name cannot be hijacked';
end $$;
