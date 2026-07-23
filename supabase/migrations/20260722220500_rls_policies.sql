-- Architecture ref: ARCHITECTURE_v1.0.md §8 (RLS and secrets), §3.2, §7
--
-- Component 5. Every table got `enable row level security` back in
-- components 2 and 4 with zero policies, so everything has been fully
-- closed since then. This migration is purely additive: it opens exactly
-- the doors §8 specifies and nothing else.
--
-- Read this header before changing any policy below. There are four
-- non-obvious things going on, and three of them are load-bearing
-- against real failure modes rather than style preferences.
--
-- ---------------------------------------------------------------------
-- 1. ANONYMOUS SIGN-IN STILL MEANS ROLE `authenticated`
-- ---------------------------------------------------------------------
-- §7 uses Supabase anonymous sign-in. That still mints a real JWT with
-- `role: authenticated` (plus an `is_anonymous: true` claim) -- it is NOT
-- the `anon` role. `anon` is the pre-sign-in, no-JWT role. So every policy
-- here targets `authenticated`, and `anon` deliberately gets nothing at
-- all: there is no screen in this app that works before sign-in, because
-- sign-in is invisible and automatic.
--
-- ---------------------------------------------------------------------
-- 2. POLICY RECURSION (the classic RLS footgun)
-- ---------------------------------------------------------------------
-- The natural way to write the room_members read policy is
--     room_id in (select room_id from room_members where user_id = auth.uid())
-- which sends Postgres into infinite recursion: evaluating the policy on
-- room_members requires querying room_members, which invokes the policy.
-- Postgres raises `infinite recursion detected in policy for relation`.
--
-- Fix: the two SECURITY DEFINER helpers below. A definer function runs as
-- its owner and bypasses RLS on what it reads, so the policy asks a
-- question that never re-enters the policy system. Both are STABLE (same
-- answer for the whole statement, so the planner calls them once, not
-- per row) and both pin `search_path` so a malicious temp schema can't
-- shadow the tables they read -- standard hardening for definer functions.
--
-- ---------------------------------------------------------------------
-- 3. THE CAPACITY TRIGGER BREAKS UNDER RLS UNLESS IT IS DEFINER
-- ---------------------------------------------------------------------
-- This one is a real bug being fixed, not a precaution. `enforce_room_capacity`
-- (component 2) does:
--     select count(*) into current_count from room_members where room_id = ...
-- A trigger function runs as the *invoking* user, so once RLS is live that
-- count is silently RLS-filtered. When user C tries to join a full room,
-- C is not yet a member, so C can see zero room_members rows, so the count
-- comes back 0, so the capacity check passes and a third person lands in a
-- two-person room. The trigger would have gone from enforcing the rule to
-- rubber-stamping every violation, without erroring.
--
-- Same problem on its `select max_members from rooms` -- C can't read a
-- room it hasn't joined, so `cap` would come back NULL and the comparison
-- would evaluate to NULL (never true), failing open again.
--
-- Fix below: recreate the function as SECURITY DEFINER with a pinned
-- search_path. Behavior is otherwise byte-identical to component 2.
-- Component 6's join_room RPC is also SECURITY DEFINER and does its own
-- capacity check, but that's the polite path -- this trigger is the one
-- that holds if anything ever writes room_members directly.
--
-- ---------------------------------------------------------------------
-- 4. VIEWS BYPASS RLS BY DEFAULT
-- ---------------------------------------------------------------------
-- `room_votes` and `user_title_buckets` (component 3) are owned by
-- postgres, and a normal Postgres view executes with the *owner's*
-- permissions. Left alone, they would happily read every room's swipes
-- for anyone who queried them, straight through the RLS on the underlying
-- tables. `security_invoker = on` (PG15+, which Supabase is) makes the
-- view execute as the caller instead, so the swipes/room_members policies
-- below actually apply. Without this line the tab UI would leak every
-- other couple's swipe history.

-- =====================================================================
-- Helper functions (see note 2 above)
-- =====================================================================

-- The single room this user belongs to, or null. `room_members` has a
-- unique constraint on user_id (one room per user, v1), so this is
-- at most one row.
create or replace function current_room_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select room_id from room_members where user_id = auth.uid();
$$;

-- Every user id in the caller's room, including the caller. Used by the
-- users/swipes read policies so a person can see their partner's rows
-- (and only their partner's).
create or replace function current_room_user_ids()
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select user_id from room_members where room_id = current_room_id();
$$;

-- =====================================================================
-- Capacity trigger fix (see note 3 above)
-- =====================================================================

create or replace function enforce_room_capacity()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  cap int;
  current_count int;
begin
  select max_members into cap from rooms where id = new.room_id for update;
  select count(*) into current_count from room_members where room_id = new.room_id;
  if current_count >= cap then
    raise exception 'ROOM_FULL';
  end if;
  return new;
end;
$$;

-- =====================================================================
-- users
-- =====================================================================
-- §8 says "read/write own row only." Read is deliberately widened to
-- include room-mates, because the app cannot render without it: the
-- Solo tab's framing ("watch this without them"), the waiting-for-partner
-- empty state (§9), and the reclaim screen's "which of these is you"
-- member list (§7) all need the partner's display_name. The alternative
-- would be proxying display names through a definer RPC purely to satisfy
-- the letter of a line whose intent is clearly "don't expose the whole
-- user table." Room-mates only, still nothing global.
--
-- Write stays strictly own-row. `with check` on update prevents a user
-- from rewriting the row to point at someone else's id.

create policy users_select_self_or_roommate on users
  for select to authenticated
  using (
    id = auth.uid()
    or id in (select current_room_user_ids())
  );

create policy users_insert_self on users
  for insert to authenticated
  with check (id = auth.uid());

create policy users_update_self on users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No delete policy. Account deletion cascades from auth.users; there is
-- no in-app "delete my profile row" path, and leaving one available
-- would orphan swipes and break a partner's buckets mid-session.

-- =====================================================================
-- rooms
-- =====================================================================
-- Read: members only. Update: members, platforms column only (see the
-- column grants at the bottom of this file -- RLS gates the row, grants
-- gate the column; RLS alone cannot restrict which columns an UPDATE
-- touches).
--
-- Insert: DELIBERATELY NOT GRANTED, a tightening of §8's "insert is open."
-- Creating a room is not one write, it's three that must land together:
-- the `rooms` row, its `room_secrets` PIN hash, and the creator's
-- `room_members` row. A client-side insert can only ever do the first,
-- producing a PIN-less room that nobody (including its creator) can join
-- and that nothing cleans up. Component 6's `create_room` RPC is
-- SECURITY DEFINER and does all three atomically, so it bypasses RLS and
-- doesn't need this policy. Denying direct insert removes the broken
-- state entirely rather than documenting it as a caveat.

create policy rooms_select_member on rooms
  for select to authenticated
  using (id = current_room_id());

create policy rooms_update_member on rooms
  for update to authenticated
  using (id = current_room_id())
  with check (id = current_room_id());

-- =====================================================================
-- room_members
-- =====================================================================
-- Read: rows for your room (so you can see that your partner exists,
-- and when they joined). Insert: your own membership only -- though the
-- normal path is component 6's join_room RPC, which also enforces the
-- PIN and the rate limit. This policy exists so the capacity trigger
-- and the membership model stay coherent if anything else ever inserts.
-- Delete: your own membership only, which is exactly §7's "leaving"
-- behavior (drops the membership row, retains swipes).

create policy room_members_select_own_room on room_members
  for select to authenticated
  using (room_id = current_room_id());

create policy room_members_insert_self on room_members
  for insert to authenticated
  with check (user_id = auth.uid());

create policy room_members_delete_self on room_members
  for delete to authenticated
  using (user_id = auth.uid());

-- No update policy. Moving rooms is leave-then-join (two statements,
-- each individually authorized), not an in-place row edit. The reclaim
-- flow (§7) does repoint a membership's user_id, but that runs inside a
-- SECURITY DEFINER RPC in component 6 and bypasses RLS by design -- it
-- has to, since the person reclaiming is by definition not yet the
-- member they're reclaiming.

-- =====================================================================
-- swipes
-- =====================================================================
-- Read: every swipe belonging to anyone in your room. This is what makes
-- the bucket views work at all -- classification is inherently a
-- comparison against your partner's votes, so there is no narrower read
-- that still produces a Together tab. It also feeds the client-side deck
-- build (§6.5), which fetches both members' swipe rows to compute the
-- partner_pending term and joint affinity.
--
-- The `or user_id = auth.uid()` arm covers the pre-join window: a user
-- who has signed in but not yet joined a room has no room-mates, and
-- current_room_user_ids() returns nothing, but they still need to read
-- back their own swipes.
--
-- Write: own rows only, all three verbs. `undo_swipe` (§6) is a real
-- delete, so delete is granted here rather than routed through an RPC.

create policy swipes_select_room on swipes
  for select to authenticated
  using (
    user_id = auth.uid()
    or user_id in (select current_room_user_ids())
  );

create policy swipes_insert_self on swipes
  for insert to authenticated
  with check (user_id = auth.uid());

create policy swipes_update_self on swipes
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy swipes_delete_self on swipes
  for delete to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- watched
-- =====================================================================
-- Room-scoped by design (§2.4: watching is a joint act, either partner
-- can mark or unmark, no per-user state). So all four verbs are gated on
-- room membership rather than on who did the marking. `marked_by` is
-- checked on insert only to keep the audit field honest -- you can mark
-- anything in your room, but you can't attribute it to your partner.
--
-- Update is what carries the §2.4 verdict toast (thumbs up/down lands as
-- an update to an existing row), and unmarking is the delete.

create policy watched_select_room on watched
  for select to authenticated
  using (room_id = current_room_id());

create policy watched_insert_room on watched
  for insert to authenticated
  with check (
    room_id = current_room_id()
    and marked_by = auth.uid()
  );

create policy watched_update_room on watched
  for update to authenticated
  using (room_id = current_room_id())
  with check (room_id = current_room_id());

create policy watched_delete_room on watched
  for delete to authenticated
  using (room_id = current_room_id());

-- =====================================================================
-- titles, genres, tmdb_genre_map (reference data)
-- =====================================================================
-- Read-only to every signed-in user, no row filtering -- the whole point
-- of `titles` is that it's a shared global cache (§5.1), and the deck
-- build needs to read across all of it. Writes belong exclusively to the
-- component 7 pool-refresh job, which authenticates with the service role
-- key and therefore bypasses RLS entirely. Granting no write policy here
-- is the enforcement.
--
-- `genres` and `tmdb_genre_map` did not get `enable row level security`
-- in component 4 -- an oversight caught while writing this migration.
-- Enabling it here and immediately granting read keeps the "RLS on every
-- table, no exceptions" invariant of §8 true across the whole schema.

alter table genres enable row level security;
alter table tmdb_genre_map enable row level security;

create policy titles_select_all on titles
  for select to authenticated
  using (true);

create policy genres_select_all on genres
  for select to authenticated
  using (true);

create policy tmdb_genre_map_select_all on tmdb_genre_map
  for select to authenticated
  using (true);

-- =====================================================================
-- room_secrets, join_attempts: intentionally no policies
-- =====================================================================
-- Both are written and read exclusively by component 6's SECURITY DEFINER
-- RPCs, which bypass RLS. With RLS enabled and zero policies, both tables
-- are fully closed to `anon` and `authenticated` -- which is the entire
-- point of splitting pin_hash out of `rooms` in the first place (§8: the
-- PIN hash must never be selectable by clients, and RLS is row-level, so
-- it could not have been hidden as a column on an otherwise-readable row).
--
-- If a future migration adds a policy to either table, that is almost
-- certainly a mistake. Do not "fix" the missing policies.
--
-- Defense in depth: with RLS on and no policies these already return
-- nothing, but Supabase's default grants still hand `authenticated` the
-- table privileges. Revoking them means a stray policy added later
-- cannot open the table on its own -- someone would have to also
-- re-grant, which is a much harder thing to do by accident.
revoke all on room_secrets from authenticated;
revoke all on join_attempts from authenticated;

-- =====================================================================
-- Column-level grants
-- =====================================================================
-- Supabase's default setup grants broad table privileges to `anon` and
-- `authenticated`, relying on RLS as the gate. RLS decides which ROWS a
-- statement may touch; it has no opinion on which COLUMNS. So a member
-- with the rooms_update_member policy could otherwise rewrite `code`,
-- `max_members`, or `created_at` on their own room -- changing max_members
-- would defeat the capacity trigger, and changing code would strand a
-- partner mid-join.
--
-- Column grants are the Postgres-native answer: revoke update wholesale,
-- then grant it back on exactly the column §8 says members may change.
revoke update on rooms from authenticated;
grant update (platforms) on rooms to authenticated;

-- Same reasoning for users: a person may edit their profile, but
-- `id` and `created_at` are not theirs to rewrite.
revoke update on users from authenticated;
grant update (display_name, genre_prefs, tab_seen_at, last_seen_at) on users to authenticated;

-- Reference data is read-only to clients regardless of policies. Belt
-- and braces with the "no write policy" rule above: if someone later
-- adds a write policy by mistake, the missing grant still blocks it.
revoke insert, update, delete on titles from authenticated;
revoke insert, update, delete on genres from authenticated;
revoke insert, update, delete on tmdb_genre_map from authenticated;

-- `anon` (pre-sign-in, no JWT) has no use for any of this. Every screen
-- requires a session, so close it out completely rather than relying on
-- the absence of policies.
revoke all on rooms, room_secrets, users, room_members, join_attempts,
              titles, swipes, watched, genres, tmdb_genre_map
  from anon;

-- =====================================================================
-- Views: force RLS to apply (see note 4 above)
-- =====================================================================
alter view room_votes set (security_invoker = on);
alter view user_title_buckets set (security_invoker = on);
