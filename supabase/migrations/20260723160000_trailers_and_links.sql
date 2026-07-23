-- FlixPix feature round: trailers + watch links.
--
-- Two new columns on `titles`, both populated by the pool-refresh job
-- (component 7) from data TMDB already returns -- no new API, no new
-- key, no new service.
--
--   trailer_key -- YouTube video key from TMDB's /videos. Enough to
--                  embed a trailer straight into the card. Nullable
--                  because plenty of titles, especially older TV, have
--                  no trailer on file.
--
--   watch_link  -- the URL from watch/providers.results.US.link. This is
--                  a JustWatch page, NOT a Netflix deep link, and the
--                  distinction matters: TMDB does not hand out
--                  per-service deep links, and hand-rolling them means
--                  per-service URL schemes that differ by OS and break
--                  without warning. This link always works, so it is the
--                  reliable fallback behind the per-service search URLs
--                  built client-side in src/lib/links.js.

alter table titles add column if not exists trailer_key text;
alter table titles add column if not exists watch_link text;

-- Refreshing everything at once would be a large TMDB burst, so instead
-- the pool-refresh job's existing staleness pass picks these up
-- naturally: any title whose detail data is re-fetched gets both
-- columns filled. Nulling detail_updated_at on a slice per night would
-- force it faster, but there is no hurry -- a missing trailer degrades
-- to "no trailer button", which is exactly how a title with no trailer
-- behaves anyway.
