-- Architecture ref: ARCHITECTURE_v1.0.md §3.1, §7, §8
--
-- Table shape follows the doc closely, with two decisions made here that
-- the doc left open for whoever hit them first:
--
-- 1. pin_hash lives in its OWN table (room_secrets), not on rooms itself.
--    §8 says a room's PIN hash "is never selectable by clients" and offers
--    two ways to get there: a separate table, or a view that omits the
--    column. RLS is row-level, not column-level, so if pin_hash sat on
--    `rooms` there would be no way to let members SELECT the row (for
--    platforms, code, etc. -- which they need) without also exposing
--    pin_hash to that same SELECT. Splitting the table sidesteps the
--    problem entirely instead of working around it with a view. Component
--    5 (RLS) should grant room_secrets no SELECT/INSERT/UPDATE policies to
--    `authenticated` or `anon` at all -- it's written and read only by the
--    SECURITY DEFINER RPCs in component 6, which (owned by `postgres` in
--    Supabase's default setup) bypass RLS entirely. Default-deny is exactly
--    what we want here.
--
-- 2. RLS is enabled on every table in this migration, with zero policies
--    yet. §8 is explicit that RLS is on for every table with no exceptions,
--    and turning it on here -- even before component 5 writes the actual
--    policies -- closes the gap where these tables would otherwise sit
--    wide open to the anon key between this migration landing and that one.
--    Enabling now costs nothing: with no policies, every table defaults to
--    fully closed, which is a safe resting state to sit in.

create table rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,          -- 6 chars, unambiguous alphabet (component 6 generates it)
  platforms      text[] not null default '{}',  -- subset of {netflix, prime, disney, hulu}
  max_members    int not null default 2,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
alter table rooms enable row level security;

-- Split off per the note above. One row per room. Never exposed to a
-- policy that grants `authenticated`/`anon` access -- only SECURITY
-- DEFINER functions touch this table.
create table room_secrets (
  room_id  uuid primary key references rooms(id) on delete cascade,
  pin_hash text not null
);
alter table room_secrets enable row level security;

create table users (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  genre_prefs   int[] not null default '{}',  -- canonical genre ids, component 4's mapping
  tab_seen_at   jsonb not null default '{}',  -- {together: ts, solo: ts, pending: ts}
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()  -- drives the reclaim-flow idle check, §7
);
alter table users enable row level security;

-- Membership as a join table rather than a room_id column on users.
-- Generic in shape (any room could in principle have any number of rows)
-- even though v1 semantics are strictly 2-user -- see §3.1's reasoning on
-- why the storage is generic while the bucket logic stays narrow.
create table room_members (
  room_id    uuid not null references rooms(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (user_id)  -- enforces "one room per user" for v1 at the DB level,
                     -- not just in application code
);
create index room_members_room_id_idx on room_members (room_id);
alter table room_members enable row level security;

-- Enforces max_members at insert time. The `for update` row lock matters:
-- without it, two people entering the same code within the same instant
-- could both pass the count check before either insert commits, landing
-- 3 people in a 2-person room. Unlikely at this app's scale, free to
-- close off. Copied verbatim from ARCHITECTURE_v1.0.md §3.1.
create or replace function enforce_room_capacity() returns trigger as $$
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
$$ language plpgsql;

create trigger room_capacity
  before insert on room_members
  for each row execute function enforce_room_capacity();

-- Rate-limiting log for join_room and reclaim_membership (§7: "5 failures
-- per room per 15 minutes"). Only ever touched by the SECURITY DEFINER
-- RPCs in component 6 -- same default-deny posture as room_secrets, so no
-- policies are granted here either.
create table join_attempts (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references rooms(id) on delete cascade,
  attempted_by uuid not null references users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded    boolean not null
);
create index join_attempts_room_window_idx on join_attempts (room_id, attempted_at);
alter table join_attempts enable row level security;
