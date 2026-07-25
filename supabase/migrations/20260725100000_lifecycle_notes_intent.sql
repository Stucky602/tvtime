-- FlixPix: the four portfolio-level builds.
--
-- These replace roughly eleven queue items. Each section says which,
-- because the whole point of the portfolio pass was that those items
-- were symptoms of four underlying gaps rather than eleven features.

-- =====================================================================
-- 1. WATCH LIFECYCLE
-- =====================================================================
-- Absorbs: currently-watching shelf, inferred watched, memory lane,
-- taste drift, and most of cost-per-match.
--
-- The app modelled deciding and barely modelled watching. `watched` was
-- a single boolean event with an optional thumb: you either had watched
-- a thing or you had not. That is a poor model of how anyone actually
-- consumes a 60-hour series, and it is why five separate features were
-- each trying to reconstruct a timeline that was never stored.
--
-- `watched` becomes a lifecycle row rather than a flag. Deliberately NOT
-- a new table: every existing row is already a valid "finished" record,
-- so extending in place backfills perfectly and nothing downstream
-- breaks. A parallel table would have meant migrating history and
-- maintaining two sources of truth for the same fact.
--
-- 'planned' is intentionally absent as a status. A title both of you
-- said yes to is already planned, and that lives in the Together bucket.
-- Adding a status for it would duplicate state that the vote views
-- already derive correctly.

alter table watched add column if not exists status text not null default 'finished';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'watched_status_check'
  ) then
    alter table watched add constraint watched_status_check
      check (status in ('watching', 'finished', 'abandoned'));
  end if;
end $$;

alter table watched add column if not exists started_on date;

-- Free-text, optional, for "we're 3 episodes in" or "stopped after S2".
-- Deliberately not structured episode tracking: TV is one card per
-- series by design, and a per-episode model would contradict that.
alter table watched add column if not exists progress_note text;

-- Existing rows predate the column and are all completed watches. The
-- default handles new inserts; this handles the ones already there.
update watched set status = 'finished' where status is null;

create index if not exists watched_status_idx on watched (room_id, status);

-- =====================================================================
-- 2. EPISODE / SEASON COUNT
-- =====================================================================
-- The commitment signal. A card gave no hint whether a series is eight
-- episodes or two hundred, which is the single largest missing decision
-- input for TV. TMDB returns both on the detail call the refresh job
-- already makes, so this costs nothing but a column.
--
-- Nullable because movies have neither, and because plenty of TV rows
-- predate this and will fill in on the next backfill pass.

alter table titles add column if not exists episode_count int;
alter table titles add column if not exists season_count int;

-- =====================================================================
-- 3. NOTE PRIMITIVE
-- =====================================================================
-- Absorbs: boost-with-a-note, and watch-alone blessing.
--
-- The app was a shared database between two people with no way for
-- either to say anything to the other. Every relationship-shaped idea in
-- the queue was inventing its own narrow one-off channel. One primitive
-- covers them, and covers the next three nobody has asked for yet.
--
-- `kind` rather than three tables, because the storage is identical and
-- only the presentation differs:
--   note     -- a plain comment on a title
--   boost    -- "please look at this one", surfaces it in their deck
--   blessing -- "go ahead and watch this without me"
--
-- Room-scoped, not user-scoped: a note is part of the couple's shared
-- record of a title, the same way `watched` is.

create table if not exists title_notes (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  tmdb_id    int not null,
  media_type text not null,
  author_id  uuid not null references users(id) on delete cascade,
  kind       text not null default 'note' check (kind in ('note', 'boost', 'blessing')),
  body       text,
  created_at timestamptz not null default now(),
  -- Set when the other person has seen it, so a boost can stop shouting
  -- once it has been read rather than nagging forever.
  seen_at    timestamptz,
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);

create index if not exists title_notes_room_idx on title_notes (room_id, created_at desc);
create index if not exists title_notes_title_idx on title_notes (room_id, tmdb_id, media_type);

alter table title_notes enable row level security;

-- Same shape as the `watched` policies: any member of the room may read
-- and write, because these are shared artefacts. Authorship is enforced
-- on insert so you cannot post a note as your partner.
drop policy if exists title_notes_select_room on title_notes;
create policy title_notes_select_room on title_notes
  for select to authenticated
  using (room_id = current_room_id());

drop policy if exists title_notes_insert_room on title_notes;
create policy title_notes_insert_room on title_notes
  for insert to authenticated
  with check (room_id = current_room_id() and author_id = auth.uid());

-- Update is for marking seen, which either member does to the OTHER
-- person's note, so it is not restricted to the author.
drop policy if exists title_notes_update_room on title_notes;
create policy title_notes_update_room on title_notes
  for update to authenticated
  using (room_id = current_room_id())
  with check (room_id = current_room_id());

-- Delete only your own, so nobody can quietly erase what the other said.
drop policy if exists title_notes_delete_own on title_notes;
create policy title_notes_delete_own on title_notes
  for delete to authenticated
  using (room_id = current_room_id() and author_id = auth.uid());

-- =====================================================================
-- 4. SESSION PRESETS
-- =====================================================================
-- Absorbs: saved filter presets, and part of the time-aware deck.
--
-- The recommender modelled a stable taste profile and had no concept of
-- tonight, so it served the same deck at 9am Saturday and 11:30pm
-- Tuesday. Three separate queue items were three different input
-- mechanisms pointed at that one gap.
--
-- Built-in intents live in the client (src/lib/intent.js) because they
-- are logic, not data. This column is only for presets a user saves
-- themselves, which genuinely are data.

alter table users add column if not exists session_presets jsonb not null default '[]'::jsonb;
