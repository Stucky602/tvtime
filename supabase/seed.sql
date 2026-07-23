-- Architecture ref: ARCHITECTURE_v1.0.md §13
--
-- LOCAL DEV / TESTING ONLY. Never run against the hosted Supabase project.
--
-- This is Supabase's standard seed entrypoint: `supabase db reset` applies
-- every migration in order and then runs this file once, automatically.
-- It inserts fake rows directly into `auth.users`, which only works
-- against the local Supabase stack (a real project's `auth.users` is
-- managed by the auth service, not writable like this).
--
-- Purpose, per §13: give every UI component built after this one (9
-- onward) a populated app to develop against instead of an empty one --
-- specifically two users with genre preferences that partly overlap and
-- partly diverge, so the §5.4 divergence guard and the ordinary match
-- path can both be exercised by just opening the app.

-- ---------------------------------------------------------------------
-- Two fake auth identities + profiles.
-- Genre prefs (canonical ids from the genres table, component 4):
--   1 Action, 2 Comedy, 3 Drama, 4 Horror, 5 Sci-Fi & Fantasy, 6 Thriller,
--   7 Documentary, 8 Animation, 9 Romance, 10 Crime & Mystery, 11 Family
--
-- Kevin-ish (user A): thriller/crime/scifi leaning.
-- Wife-ish (user B): comedy/romance/family leaning, with Drama as the
-- ONE deliberate overlap genre -- enough shared ground for the seeded
-- deck and shared spine (§5.4) to have real material to work with,
-- while the rest of each person's taste stays genuinely divergent.
-- ---------------------------------------------------------------------

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002')
on conflict (id) do nothing;

insert into users (id, display_name, genre_prefs) values
  ('a0000000-0000-0000-0000-000000000001', 'Dev User A', array[1, 5, 6, 3]),
  ('a0000000-0000-0000-0000-000000000002', 'Dev User B', array[2, 9, 11, 3])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- One room, both users joined. PIN is '4242', bcrypt-hashed the same
-- way component 6's join_room RPC will hash real ones -- this doubles
-- as a smoke test that pgcrypto is wired up correctly.
-- ---------------------------------------------------------------------

insert into rooms (id, code, platforms) values
  ('b0000000-0000-0000-0000-000000000001', 'DEV001', '{netflix,prime,disney,hulu}')
on conflict (id) do nothing;

insert into room_secrets (room_id, pin_hash) values
  ('b0000000-0000-0000-0000-000000000001', crypt('4242', gen_salt('bf')))
on conflict (room_id) do nothing;

insert into room_members (room_id, user_id, joined_at) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', now() - interval '30 days'),
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', now() - interval '30 days')
on conflict do nothing;
-- joined_at is backdated 30 days, deliberately earlier than any swipe
-- below (which are randomized within the last 14 days). Miss this and
-- the §7 joined_at scoping filter -- correctly -- treats every seeded
-- swipe as pre-join history and excludes it, leaving Together/Solo/
-- Pending all empty despite hundreds of swipe rows existing. Caught by
-- actually running this seed against a real database rather than just
-- eyeballing the SQL (see the migration testing notes for how).

-- ---------------------------------------------------------------------
-- ~300 synthetic titles. tmdb_id is offset into the 9,000,000 range so
-- these can never collide with a real TMDB id once component 7 starts
-- writing real ones into the same table.
--
-- This is NOT real TMDB data -- component 7 (pool refresh) is what
-- populates the table for real. This just needs to be plausible enough
-- to develop the deck, scoring, and tab UI against: a spread of genres,
-- providers, decades, and quality so every scoring term in §5.2 has
-- something to differentiate on.
-- ---------------------------------------------------------------------

insert into titles (
  tmdb_id, media_type, title, year, runtime, synopsis, poster_path,
  rating, vote_count, popularity, original_language, genres, providers,
  providers_updated_at, detail_updated_at, excluded
)
select
  9000000 + n,
  case when n % 4 = 0 then 'tv' else 'movie' end,
  'Dev Title ' || n,
  1985 + (n % 40),                                    -- spread across ~40 years
  case when n % 4 = 0 then 22 + (n % 3) * 15           -- tv episode runtime, 22-52 min
       else 85 + (n % 6) * 12 end,                    -- movie runtime, 85-145 min
  'Synthetic synopsis for development title ' || n || '.',
  case when n % 11 = 0 then null else '/dev-poster-' || (n % 20) || '.jpg' end,
  (3.0 + (n % 71) / 10.0)::numeric(3,1),               -- 3.0 - 10.0
  case when n % 13 = 0 then (n % 40) else 100 + n * 3 end,  -- occasional low-vote-count outlier
  (random() * 100)::numeric(6,2),
  'en',
  -- 1-3 genres per title, drawn from the canonical space, biased so
  -- SOME titles land in each user's preferred genres and some land in
  -- neither -- that spread is what makes the divergence guard testable.
  case (n % 6)
    when 0 then array[1, 6]          -- action/thriller (A's lane)
    when 1 then array[2, 9]          -- comedy/romance (B's lane)
    when 2 then array[3]             -- drama (the deliberate overlap)
    when 3 then array[5, 1]          -- scifi/action (A's lane)
    when 4 then array[11, 2]         -- family/comedy (B's lane)
    else array[10, 4]                -- crime/horror (neither's stated pref)
  end,
  -- Providers: most titles on 1-2 platforms, a few on all four, a
  -- handful on none (simulates a title that's about to roll off or
  -- was never available -- exercises the "not on your services" path).
  case
    when n % 17 = 0 then array[]::text[]
    when n % 5 = 0 then array['netflix','prime','disney','hulu']
    when n % 2 = 0 then array['netflix']
    else array['prime','hulu']
  end,
  now(),
  now(),
  -- A handful of TV titles flagged excluded, to exercise the §4.4 path
  -- without needing real soap/talk-show data.
  (n % 4 = 0 and n % 30 = 0)
from generate_series(1, 320) as n
on conflict (tmdb_id, media_type) do nothing;

-- ---------------------------------------------------------------------
-- Randomized swipe history for both users. Deliberately NOT identical
-- between them -- about 60 swipes each, seeded from different offsets so
-- there's a real mix of Together, Solo, and Pending rows to look at
-- rather than a suspiciously tidy 1:1 overlap.
-- ---------------------------------------------------------------------

insert into swipes (user_id, tmdb_id, media_type, direction, voted_at)
select
  'a0000000-0000-0000-0000-000000000001',
  t.tmdb_id, t.media_type,
  case when (t.tmdb_id + 1) % 3 = 0 then 'left' else 'right' end,
  now() - (random() * interval '14 days')
from titles t
where t.tmdb_id between 9000001 and 9000320
  and (t.tmdb_id % 5) < 3   -- covers 60% of the pool
on conflict (user_id, tmdb_id, media_type) do nothing;

insert into swipes (user_id, tmdb_id, media_type, direction, voted_at)
select
  'a0000000-0000-0000-0000-000000000002',
  t.tmdb_id, t.media_type,
  case when (t.tmdb_id + 2) % 3 = 0 then 'left' else 'right' end,
  now() - (random() * interval '14 days')
from titles t
where t.tmdb_id between 9000001 and 9000320
  and (t.tmdb_id % 5) between 1 and 3   -- overlaps A's range partially, not fully
on conflict (user_id, tmdb_id, media_type) do nothing;

-- ---------------------------------------------------------------------
-- A few watched rows, one with each verdict and one with none, to
-- exercise the §2.4 toast/verdict path in the UI.
-- ---------------------------------------------------------------------

insert into watched (room_id, tmdb_id, media_type, marked_by, verdict)
select
  'b0000000-0000-0000-0000-000000000001',
  rv.tmdb_id, rv.media_type,
  'a0000000-0000-0000-0000-000000000001',
  case (row_number() over (order by rv.tmdb_id)) % 3
    when 0 then 'up'
    when 1 then 'down'
    else null
  end
from room_votes rv
where rv.room_id = 'b0000000-0000-0000-0000-000000000001'
  and rv.total_votes = rv.member_count
  and rv.lefts = 0
limit 5
on conflict (room_id, tmdb_id, media_type) do nothing;
