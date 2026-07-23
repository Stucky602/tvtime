-- FlixPix: make trailers actually appear.
--
-- The trailer feature shipped with a gap: `trailer_key` was added as a
-- nullable column, and only NEWLY discovered titles ever got one. Every
-- title already in the pool kept a NULL key, because the refresh job's
-- only re-fetch trigger is provider staleness at 30 days. So trailers
-- would have trickled in over a month, for whichever slice happened to
-- go stale -- not "give it a night" as I claimed.
--
-- Backfilling needs a way to tell "we have never looked for a trailer"
-- apart from "we looked and there isn't one". Without that marker a
-- backfill query on `trailer_key is null` would re-fetch the same
-- trailerless titles every single night forever and never finish.
--
-- Hence this column: set whenever a title's detail is fetched, so the
-- backfill can target `trailer_checked_at is null` and each title is
-- checked exactly once.

alter table titles add column if not exists trailer_checked_at timestamptz;

-- Partial index: the backfill only ever scans for un-checked rows, and
-- that set shrinks to nothing as the backfill completes. Indexing only
-- those rows keeps it small and lets it disappear entirely once done.
create index if not exists titles_trailer_backfill_idx
  on titles (popularity desc)
  where trailer_checked_at is null;
