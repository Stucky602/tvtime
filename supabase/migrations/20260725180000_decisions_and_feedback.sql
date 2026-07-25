-- FlixPix: the decision layer, and the app's first feedback loop.
--
-- Four tables and two columns, covering eight of the ten items from the
-- generator session. The through-line: the app could form opinions and
-- record agreements, but it had no way to record a DECISION and no way
-- to find out whether any of its opinions were any good.

-- =====================================================================
-- 1. PLANS -- the missing noun
-- =====================================================================
-- The app is architected as a recommendation engine and used as a
-- negotiation tool. The clearest symptom: you match, Tonight's Pick
-- names a winner, and nothing anywhere records that you decided
-- anything. There was no state between "we both said yes" and "we
-- watched it", which is where the entire actual decision lives.
--
-- Deliberately separate from `watched` rather than a status on it.
-- A plan is an intention and can be abandoned without ever becoming a
-- watch; folding it into the watch record would mean inventing a
-- "watched but not really" state, which is how a clean model rots.

create table if not exists plans (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms(id) on delete cascade,
  tmdb_id     int not null,
  media_type  text not null,
  created_by  uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- Null means "tonight, or whenever". A date turns it into an
  -- occasion, which is what the ceremony generator wanted: "let's save
  -- this for the anniversary".
  planned_for date,
  note        text,
  status      text not null default 'planned'
    check (status in ('planned', 'done', 'cancelled')),
  resolved_at timestamptz,
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);

-- One live plan per title per room. Planning the same film twice is a
-- mistake, not an intention.
create unique index if not exists plans_one_live_idx
  on plans (room_id, tmdb_id, media_type)
  where status = 'planned';

create index if not exists plans_room_idx on plans (room_id, status, planned_for);

alter table plans enable row level security;

drop policy if exists plans_select_room on plans;
create policy plans_select_room on plans
  for select to authenticated using (room_id = current_room_id());

drop policy if exists plans_insert_room on plans;
create policy plans_insert_room on plans
  for insert to authenticated
  with check (room_id = current_room_id() and created_by = auth.uid());

-- Either member may resolve or cancel a plan. It is a joint intention,
-- so restricting it to the author would mean one person could leave a
-- dead plan sitting there forever.
drop policy if exists plans_update_room on plans;
create policy plans_update_room on plans
  for update to authenticated
  using (room_id = current_room_id()) with check (room_id = current_room_id());

drop policy if exists plans_delete_room on plans;
create policy plans_delete_room on plans
  for delete to authenticated using (room_id = current_room_id());

-- =====================================================================
-- 2. PICK OUTCOMES -- stop throwing away the best signal in the app
-- =====================================================================
-- Tonight's Pick asks you to choose between two titles, seven times,
-- and then discards every answer. Pairwise comparison is the highest-
-- quality preference data that exists (it is what serious ranking
-- systems are built on) and it was being generated and binned.
--
-- Stored raw rather than folded straight into a score. A pile of
-- comparisons can be re-analysed later with a better model; a running
-- average cannot be un-averaged.

create table if not exists pick_outcomes (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms(id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  winner_tmdb_id    int not null,
  winner_media_type text not null,
  loser_tmdb_id     int not null,
  loser_media_type  text not null,
  decided_at        timestamptz not null default now()
);

create index if not exists pick_outcomes_user_idx on pick_outcomes (user_id, decided_at desc);

alter table pick_outcomes enable row level security;

drop policy if exists pick_outcomes_select_room on pick_outcomes;
create policy pick_outcomes_select_room on pick_outcomes
  for select to authenticated using (room_id = current_room_id());

drop policy if exists pick_outcomes_insert_own on pick_outcomes;
create policy pick_outcomes_insert_own on pick_outcomes
  for insert to authenticated
  with check (room_id = current_room_id() and user_id = auth.uid());

-- =====================================================================
-- 3. WATCH VERDICTS -- one person's opinion stopped being both people's
-- =====================================================================
-- `watched.verdict` is a single room-scoped column, so a thumbs-down
-- from one of you was stored as the couple's opinion and fed BOTH
-- decks. In a two-person app that is not a rounding error: it is the
-- recommender confidently learning the wrong thing about one of you.
--
-- The old column stays, populated with whatever the marker said, so
-- nothing that reads it breaks. New reads should prefer this table.

create table if not exists watch_verdicts (
  room_id    uuid not null references rooms(id) on delete cascade,
  tmdb_id    int not null,
  media_type text not null,
  user_id    uuid not null references users(id) on delete cascade,
  verdict    text not null check (verdict in ('up', 'down')),
  rated_at   timestamptz not null default now(),
  primary key (room_id, tmdb_id, media_type, user_id)
);

create index if not exists watch_verdicts_user_idx on watch_verdicts (user_id);

alter table watch_verdicts enable row level security;

drop policy if exists watch_verdicts_select_room on watch_verdicts;
create policy watch_verdicts_select_room on watch_verdicts
  for select to authenticated using (room_id = current_room_id());

drop policy if exists watch_verdicts_write_own on watch_verdicts;
create policy watch_verdicts_write_own on watch_verdicts
  for insert to authenticated
  with check (room_id = current_room_id() and user_id = auth.uid());

drop policy if exists watch_verdicts_update_own on watch_verdicts;
create policy watch_verdicts_update_own on watch_verdicts
  for update to authenticated
  using (room_id = current_room_id() and user_id = auth.uid())
  with check (room_id = current_room_id() and user_id = auth.uid());

-- Backfill: attribute every existing verdict to whoever marked it.
-- That is the honest reading of the old data -- it is the only person
-- we can actually say held that opinion.
insert into watch_verdicts (room_id, tmdb_id, media_type, user_id, verdict, rated_at)
select w.room_id, w.tmdb_id, w.media_type, w.marked_by, w.verdict, coalesce(w.marked_at, now())
from watched w
where w.verdict in ('up', 'down') and w.marked_by is not null
on conflict do nothing;

-- =====================================================================
-- 4. PREDICTIONS -- "do we actually know each other"
-- =====================================================================
-- Before your partner's vote is visible, guess it. No points, no
-- streaks, nothing shaped like a game: the interesting output is a
-- calibration number about the two of you, and it happens to be real
-- data about how well the app's model of each person matches the
-- other's model of them.

create table if not exists predictions (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references rooms(id) on delete cascade,
  tmdb_id      int not null,
  media_type   text not null,
  guesser_id   uuid not null references users(id) on delete cascade,
  -- What you think THEY will say.
  guess        text not null check (guess in ('right', 'left')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  was_correct  boolean
);

create unique index if not exists predictions_one_per_title_idx
  on predictions (room_id, tmdb_id, media_type, guesser_id);

alter table predictions enable row level security;

drop policy if exists predictions_select_own on predictions;
-- Only YOUR guesses, deliberately. Seeing your partner's prediction
-- about you before you vote would poison the vote.
create policy predictions_select_own on predictions
  for select to authenticated
  using (room_id = current_room_id() and guesser_id = auth.uid());

drop policy if exists predictions_insert_own on predictions;
create policy predictions_insert_own on predictions
  for insert to authenticated
  with check (room_id = current_room_id() and guesser_id = auth.uid());

drop policy if exists predictions_update_own on predictions;
create policy predictions_update_own on predictions
  for update to authenticated
  using (room_id = current_room_id() and guesser_id = auth.uid())
  with check (room_id = current_room_id() and guesser_id = auth.uid());

-- =====================================================================
-- 5. SOLO WATCHES -- they used to vanish
-- =====================================================================
-- `watched` is room-scoped, so a film watched alone had nowhere to go.
-- The Solo tab tells you what you are free to watch without them and
-- then has no memory of whether you did, which makes it the one tab
-- with no follow-through.

alter table watched add column if not exists company text not null default 'together';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'watched_company_check') then
    alter table watched add constraint watched_company_check
      check (company in ('together', 'alone'));
  end if;
end $$;

-- =====================================================================
-- 6. Resolve a prediction when the real vote lands
-- =====================================================================
-- A trigger rather than app code, because the app cannot be trusted to
-- be running when the other person votes. This is the one piece of
-- logic that MUST fire regardless of which client is awake.

create or replace function resolve_predictions_for_swipe()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_room_id uuid;
begin
  -- Only ordinary votes resolve a guess. seen, snooze, and the secret
  -- votes are not the answer to "will they say yes".
  if new.direction not in ('left', 'right') then
    return new;
  end if;

  select room_id into v_room_id from room_members where user_id = new.user_id;
  if v_room_id is null then
    return new;
  end if;

  update predictions p
  set resolved_at = now(),
      was_correct = (p.guess = new.direction)
  where p.room_id = v_room_id
    and p.tmdb_id = new.tmdb_id
    and p.media_type = new.media_type
    and p.guesser_id <> new.user_id   -- your guess is about THEM
    and p.resolved_at is null;

  return new;
end;
$$;

drop trigger if exists resolve_predictions on swipes;
create trigger resolve_predictions
  after insert or update of direction on swipes
  for each row execute function resolve_predictions_for_swipe();
