-- FlixPix: richer similarity.
--
-- THE PROBLEM. The recommender is genre-only, and genre is a blunt
-- instrument: "Drama" contains both Paddington and Schindler's List.
-- Two titles sharing a genre tells you almost nothing about whether
-- someone who liked one will like the other.
--
-- TMDB already returns keywords and credits on the same detail call the
-- refresh job makes -- appending them costs nothing extra against the
-- rate limit. Keywords are the useful part: "time loop", "heist",
-- "found footage", "based on a true story". They describe what a film
-- IS in a way genre never can, and they are what makes mood-style
-- matching possible at all.
--
-- STORAGE SHAPE, and why not a join table. The obvious relational answer
-- is titles -> title_keywords -> keywords. That is correct and it is
-- also wrong for this app: every similarity computation happens
-- CLIENT-SIDE (§6.5), over a candidate set already in memory, so a join
-- table would mean either a second round trip per deck build or a much
-- heavier query. int[] columns with GIN indexes give array-overlap
-- operators server-side when we want them and cost one extra column in
-- the payload when we don't.

alter table titles add column if not exists keyword_ids int[] not null default '{}';
alter table titles add column if not exists cast_ids int[] not null default '{}';
alter table titles add column if not exists director_ids int[] not null default '{}';

-- Names, so the UI can say "More from Denis Villeneuve" without a
-- second lookup. Small enough to denormalise; a people table would be
-- three extra queries to render one button.
alter table titles add column if not exists cast_names text[] not null default '{}';
alter table titles add column if not exists director_names text[] not null default '{}';

-- Marks "we have looked for credits", exactly like trailer_checked_at.
-- Without it a backfill on `keyword_ids = '{}'` would re-fetch every
-- title that genuinely has no keywords, every night, forever.
alter table titles add column if not exists credits_checked_at timestamptz;

create index if not exists titles_keywords_gin_idx on titles using gin (keyword_ids);
create index if not exists titles_cast_gin_idx on titles using gin (cast_ids);
create index if not exists titles_director_gin_idx on titles using gin (director_ids);

-- Partial index for the backfill queue -- shrinks to nothing as the
-- backfill completes, then costs nothing.
create index if not exists titles_credits_backfill_idx
  on titles (popularity desc)
  where credits_checked_at is null;

-- =====================================================================
-- Watch history / recap (item 10)
-- =====================================================================
-- `watched` already records what and when, which is most of a recap.
-- The gap is that it has no room-scoped "when did we actually watch it"
-- separate from "when was it marked" -- people mark things days later.
-- Optional, defaults to the mark time, and the UI lets it be adjusted.

alter table watched add column if not exists watched_on date;

-- Backfill from marked_at so existing rows appear in a recap rather
-- than being invisible until re-marked.
update watched set watched_on = marked_at::date where watched_on is null;
