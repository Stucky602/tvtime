#!/usr/bin/env node
// Architecture ref: ARCHITECTURE_v1.0.md §4.1, §4.2, §4.3, §4.4, §5.1
//
// Component 7. Runs in GitHub Actions (nightly cron + workflow_dispatch,
// see .github/workflows/pool-refresh.yml). Zero npm dependencies on
// purpose -- Node 20's built-in fetch is enough, and this job doesn't
// need to share a dependency tree with the frontend.
//
// Two responsibilities, run in sequence:
//   Phase A -- discover NEW titles for the platforms in active use and
//              upsert them into the global `titles` cache (§5.1).
//   Phase B -- re-verify provider data on titles that are already stale,
//              prioritizing anything sitting in someone's Together/Solo
//              tab (§4.3's provider-drift note).
//
// Talks to Supabase over plain REST (PostgREST) with the service role
// key, which bypasses RLS entirely -- appropriate here, since this job
// is the only thing on earth allowed to write to `titles`.
//
// Required env vars: TMDB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// TMDB_BASE_URL and the Supabase REST path are overridable for local
// testing against a mock server -- see supabase/tests/pool-refresh.test.mjs.

const TMDB_API_KEY = requireEnv('TMDB_API_KEY');
const SUPABASE_URL = requireEnv('SUPABASE_URL').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const TMDB_BASE_URL = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/$/, '');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------
// Config constants (§12, plus the pagination scheme this job needed
// that §12 didn't specify -- see the "stateless paging" note below)
// ---------------------------------------------------------------------

// Eight supported services. TMDB provider IDs are resolved AT RUNTIME
// by matching these names against TMDB's own /watch/providers/movie
// list, rather than hardcoded.
//
// Hardcoding was the obvious approach and it is a trap. TMDB provider
// IDs are not stable -- the HBO Max -> Max rebrand changed one out from
// under everyone -- and a stale ID fails silently: discover simply
// returns nothing for that service and the deck quietly loses a whole
// platform with no error anywhere. Matching on name means a rename
// shows up as a loud warning in the job log instead.
//
// Multiple names per service because TMDB splits tiers (ads vs no-ads,
// and "X Amazon Channel" resellers) into separate providers.
const PLATFORM_NAMES = {
  netflix: ['Netflix', 'Netflix Standard with Ads'],
  prime: ['Amazon Prime Video', 'Amazon Prime Video with Ads'],
  disney: ['Disney Plus', 'Disney+'],
  hulu: ['Hulu'],
  max: ['Max', 'HBO Max', 'Max Amazon Channel'],
  appletv: ['Apple TV+', 'Apple TV Plus', 'Apple TV+ Amazon Channel'],
  peacock: ['Peacock Premium', 'Peacock Premium Plus', 'Peacock'],
  paramount: ['Paramount Plus', 'Paramount+', 'Paramount+ Amazon Channel'],
};

// Last-known-good IDs, used ONLY if the live lookup fails entirely
// (TMDB unreachable). Verified for the original four; the rest are
// best-effort and exist so a network blip degrades to a partial refresh
// rather than no refresh. The live lookup is the real source of truth.
const FALLBACK_IDS = { netflix: 8, prime: 9, disney: 337, hulu: 15 };

const ALL_PLATFORMS = Object.keys(PLATFORM_NAMES);

// Filled in by resolveProviderIds() at startup.
let PROVIDER_IDS = {};          // slug -> [id, ...]
let PROVIDER_ID_TO_SLUG = {};   // id -> slug

/**
 * Ask TMDB for its current US provider list and map our slugs onto it
 * by name. Any service we cannot find is logged loudly -- a silently
 * missing platform is exactly the failure mode this exists to prevent.
 */
async function resolveProviderIds() {
  let results = [];
  try {
    const data = await tmdbGet('/watch/providers/movie', { watch_region: 'US' });
    results = data.results || [];
  } catch (err) {
    console.error(
      `Could not fetch TMDB provider list (${err.message}). ` +
      `Falling back to last-known-good IDs -- newer services will be skipped this run.`
    );
    PROVIDER_IDS = Object.fromEntries(Object.entries(FALLBACK_IDS).map(([s, id]) => [s, [id]]));
    PROVIDER_ID_TO_SLUG = Object.fromEntries(Object.entries(FALLBACK_IDS).map(([s, id]) => [id, s]));
    return;
  }

  const byName = new Map(results.map((r) => [r.provider_name.trim().toLowerCase(), r.provider_id]));

  for (const [slug, names] of Object.entries(PLATFORM_NAMES)) {
    const ids = names
      .map((n) => byName.get(n.trim().toLowerCase()))
      .filter((id) => id !== undefined);

    if (ids.length === 0) {
      console.warn(
        `No TMDB provider matched "${slug}" (tried: ${names.join(', ')}). ` +
        `This service will contribute no titles until the name is corrected ` +
        `in PLATFORM_NAMES -- check TMDB's current provider list.`
      );
      continue;
    }
    PROVIDER_IDS[slug] = ids;
    for (const id of ids) PROVIDER_ID_TO_SLUG[id] = slug;
  }

  console.log(
    'Resolved providers: ' +
    Object.entries(PROVIDER_IDS).map(([s, ids]) => `${s}=${ids.join('/')}`).join(', ')
  );
}

// §4.4: hard exclusions (universal, no room ever wants these) vs. the
// one genre that's a per-room choice.
const HARD_EXCLUDE_TV_GENRES = [10763, 10767, 10766]; // News, Talk, Soap
const REALITY_TV_GENRE = 10764;
const TV_MAX_EPISODES = 300;

// TMDB keyword id for "anime". This is the authoritative signal --
// TMDB has no anime genre, and the trait cuts across genres, so it
// can't be derived from `genres` at all.
const ANIME_KEYWORD_ID = 210024;
const TMDB_ANIMATION_GENRE = 16;

// §4.4 / §5.1 slice rules.
const BACKCATALOG_VOTE_FLOOR = 500;
const TV_POPULAR_VOTE_FLOOR = 200; // movies get no floor here -- §4.4: "Movies need none of this."
const RECENCY_YEARS = 3;

// How many discover pages to pull per (media_type, slice) each run.
// 20 results/page, so at these settings a single run touches roughly
// (2+1)*20*2 = 120 raw candidates before exclusion/dedup -- a few dozen
// TMDB detail calls after filtering, comfortably inside a nightly
// Action's time budget. Raise these once real usage shows the pool
// needs to grow faster; there's nothing structural stopping it.
const PAGES_PER_RUN_POPULAR = 2;
const PAGES_PER_RUN_BACKCATALOG = 1;

// Stateless paging: rather than track a "last page fetched" cursor in
// its own table (one more thing that could drift from reality), the
// page number is derived from the day of year. This cycles through
// results over time and self-heals -- a corrupted or reset cursor isn't
// possible because there is no cursor. Capped well below TMDB's own
// 500-page ceiling and comfortably below the actual result count for
// "movies on 4 major US platforms," so every value in range returns
// real results.
const PAGE_CYCLE_CAP = 100;

// §4.3: refresh cadence for EXISTING titles' provider data.
const GENERAL_PROVIDER_REFRESH_DAYS = 30;
const TOGETHER_SOLO_PROVIDER_REFRESH_DAYS = 7;
// Bounds Phase B's TMDB call volume per run regardless of how large the
// stale set has grown -- important once the cache reaches a few
// thousand titles and most of it is simultaneously "30 days stale."
const REFRESH_BATCH_CAP = 100;

// §4.3: "throttle to something polite (5-10 rps)". ~5.5 rps.
const THROTTLE_MS = 180;

// §10 / §5.1: rooms with no activity in this window don't drive
// discovery. Relies on rooms.last_active_at, which component 7 found
// was never being written -- see the migration in this same batch
// (20260722220700_room_activity_and_reality_toggle.sql) for the fix
// this job depends on.
const ACTIVE_ROOM_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastTmdbCallAt = 0;
async function throttledFetch(url) {
  const now = Date.now();
  const wait = lastTmdbCallAt + THROTTLE_MS - now;
  if (wait > 0) await sleep(wait);
  lastTmdbCallAt = Date.now();
  return fetch(url);
}

async function tmdbGet(path, params = {}) {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await throttledFetch(url.toString());
  if (!res.ok) {
    throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function supabaseUpsert(table, rows, onConflict) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert ${table} -> HTTP ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------
// Genre mapping (component 4's table is the single source of truth --
// this job reads it fresh each run rather than keeping its own copy, so
// the two can never drift apart)
// ---------------------------------------------------------------------

async function loadGenreMap() {
  const rows = await supabaseGet('/tmdb_genre_map?select=tmdb_genre_id,media_type,canonical_genre_id');
  const map = { movie: new Map(), tv: new Map() };
  for (const row of rows) {
    map[row.media_type].set(row.tmdb_genre_id, row.canonical_genre_id);
  }
  return map;
}

function mapGenres(mediaType, tmdbGenreIds, genreMap) {
  const seen = new Set();
  for (const id of tmdbGenreIds) {
    const canonical = genreMap[mediaType].get(id);
    if (canonical !== undefined) seen.add(canonical);
    // A TMDB genre id with no mapping entry would mean component 4's
    // table has fallen out of date with TMDB's own genre list. Rather
    // than fail the whole title over one unmapped id, drop it silently
    // here but log once per run so the gap gets noticed.
    else unmappedGenreIds.add(`${mediaType}:${id}`);
  }
  return Array.from(seen);
}
const unmappedGenreIds = new Set();

// ---------------------------------------------------------------------
// Active platform detection (§5.1, §10)
// ---------------------------------------------------------------------

async function getActivePlatforms() {
  const cutoff = new Date(Date.now() - ACTIVE_ROOM_WINDOW_DAYS * 86400_000).toISOString();
  const rows = await supabaseGet(
    `/rooms?select=platforms&last_active_at=gte.${encodeURIComponent(cutoff)}`
  );
  const union = new Set();
  for (const row of rows) {
    for (const p of row.platforms || []) union.add(p);
  }
  if (union.size === 0) {
    // No active rooms yet (fresh deploy, or everyone's been away 30+
    // days) -- still seed the cache with all four platforms rather than
    // doing nothing, or a brand new install has an empty deck forever.
    console.log('No active rooms found; falling back to all platforms for pool seeding.');
    return ALL_PLATFORMS;
  }
  return Array.from(union);
}

// ---------------------------------------------------------------------
// Discover queries (§4.1, §4.4, §5.1)
// ---------------------------------------------------------------------

function dateYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function computePageForToday() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 0));
  const dayOfYear = Math.floor((Date.now() - start.getTime()) / 86400_000);
  return 1 + (dayOfYear % PAGE_CYCLE_CAP);
}

async function discoverPage(mediaType, slice, providerIdsCsv, page) {
  const path = mediaType === 'movie' ? '/discover/movie' : '/discover/tv';

  const params = {
    page,
    watch_region: 'US',
    with_watch_providers: providerIdsCsv,
    with_watch_monetization_types: 'flatrate',
    include_adult: 'false',
  };

  if (slice === 'popular') {
    params.sort_by = 'popularity.desc';
    params[mediaType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'] =
      dateYearsAgo(RECENCY_YEARS);
    // §4.4: telenovelas and imported soaps dominate raw TV popularity;
    // restricting to English for the popular slice removes them
    // wholesale. Backcatalog deliberately skips this -- that's where
    // prestige international titles live, and it's quality-gated by the
    // vote floor below instead.
    params.with_original_language = 'en';
    if (mediaType === 'tv') {
      params['vote_count.gte'] = TV_POPULAR_VOTE_FLOOR;
      // Belt and braces alongside the post-detail-fetch genre check
      // below: filtering these out at discover time means we never
      // waste a detail call on a title we already know we'll exclude.
      params.without_genres = HARD_EXCLUDE_TV_GENRES.join(',');
    }
  } else {
    params.sort_by = 'vote_average.desc';
    params['vote_count.gte'] = BACKCATALOG_VOTE_FLOOR;
    if (mediaType === 'tv') {
      params.without_genres = HARD_EXCLUDE_TV_GENRES.join(',');
    }
  }

  const data = await tmdbGet(path, params);
  return data.results || [];
}

// ---------------------------------------------------------------------
// Detail fetch and row shaping (§4.1, §4.3, §4.4)
// ---------------------------------------------------------------------

async function fetchDetail(mediaType, tmdbId) {
  const path = mediaType === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  // keywords rides along on the same request -- no extra API call.
  return tmdbGet(path, { append_to_response: 'watch/providers,keywords' });
}

function extractProviders(detail) {
  // §4.1: "Discover filtering is a prefilter, not truth." The detail
  // response's watch/providers block is what actually goes into
  // titles.providers -- and a title that turns out to be on none of our
  // four platforms still gets upserted (with an empty array) rather
  // than dropped, so the discover+detail work isn't repeated on it every
  // single night. See titleRowFromDetail below.
  const usFlatrate = detail?.['watch/providers']?.results?.US?.flatrate || [];
  const slugs = new Set();
  for (const p of usFlatrate) {
    const slug = PROVIDER_ID_TO_SLUG[p.provider_id];
    if (slug) slugs.add(slug);
  }
  return Array.from(slugs);
}

/**
 * Anime detection. Keyword first (authoritative), then a language +
 * Animation heuristic for older titles that predate consistent keyword
 * tagging.
 *
 * TMDB returns keywords under different shapes per media type: movies
 * use `keywords.keywords`, TV uses `keywords.results`. Getting this
 * wrong fails silently -- every title reads as non-anime -- so both are
 * handled explicitly rather than assumed.
 */
function detectAnime(mediaType, detail, rawGenreIds) {
  const kw = detail.keywords || {};
  const list = kw.keywords || kw.results || [];
  if (list.some((k) => k.id === ANIME_KEYWORD_ID)) return true;

  return (
    detail.original_language === 'ja' &&
    rawGenreIds.includes(TMDB_ANIMATION_GENRE)
  );
}

function extractYear(dateStr) {
  // §4.3: release_date / first_air_date can be an empty string, not
  // just absent -- naive parsing throws on ''.
  if (!dateStr) return null;
  const year = parseInt(dateStr.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function extractRuntime(mediaType, detail) {
  // §4.3: movies have `runtime` (int, sometimes null). TV has
  // `episode_run_time` (array, often empty, sometimes implausible) --
  // take the first element if present, else null.
  if (mediaType === 'movie') return detail.runtime ?? null;
  const arr = detail.episode_run_time;
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

function titleRowFromDetail(mediaType, detail, genreMap) {
  const genreIds = (detail.genres || []).map((g) => g.id);
  const canonicalGenres = mapGenres(mediaType, genreIds, genreMap);

  const isReality = mediaType === 'tv' && genreIds.includes(REALITY_TV_GENRE);
  const hasHardExcludedGenre =
    mediaType === 'tv' && genreIds.some((id) => HARD_EXCLUDE_TV_GENRES.includes(id));
  const tooManyEpisodes =
    mediaType === 'tv' &&
    typeof detail.number_of_episodes === 'number' &&
    detail.number_of_episodes > TV_MAX_EPISODES;

  const now = new Date().toISOString();

  return {
    tmdb_id: detail.id,
    media_type: mediaType,
    title: detail.title || detail.name || `Untitled ${detail.id}`,
    year: extractYear(detail.release_date || detail.first_air_date),
    runtime: extractRuntime(mediaType, detail),
    synopsis: detail.overview || null,
    poster_path: detail.poster_path || null,
    backdrop_path: detail.backdrop_path || null,
    rating: detail.vote_average ?? null,
    vote_count: detail.vote_count ?? null,
    popularity: detail.popularity ?? null,
    original_language: detail.original_language || null,
    genres: canonicalGenres,
    providers: extractProviders(detail),
    providers_updated_at: now,
    detail_updated_at: now,
    excluded: hasHardExcludedGenre || tooManyEpisodes,
    is_reality: isReality,
    is_anime: detectAnime(mediaType, detail, genreIds),
  };
}

// ---------------------------------------------------------------------
// Phase A: discover new titles
// ---------------------------------------------------------------------

async function runDiscoveryPhase(providerIdsCsv, genreMap) {
  const rows = [];
  const seen = new Set(); // dedupe within this run across slices

  for (const mediaType of ['movie', 'tv']) {
    for (const [slice, pageCount] of [
      ['popular', PAGES_PER_RUN_POPULAR],
      ['backcatalog', PAGES_PER_RUN_BACKCATALOG],
    ]) {
      let candidates = [];
      const basePage = computePageForToday();
      for (let offset = 0; offset < pageCount; offset++) {
        try {
          const results = await discoverPage(mediaType, slice, providerIdsCsv, basePage + offset);
          candidates.push(...results);
          if (results.length === 0) break; // ran past TMDB's total_pages for this query
        } catch (err) {
          console.warn(`Discover failed for ${mediaType}/${slice} page ${basePage + offset}: ${err.message}`);
        }
      }

      for (const candidate of candidates) {
        const key = `${mediaType}:${candidate.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const detail = await fetchDetail(mediaType, candidate.id);
          rows.push(titleRowFromDetail(mediaType, detail, genreMap));
        } catch (err) {
          console.warn(`Detail fetch failed for ${key}: ${err.message}`);
        }
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------
// Phase B: refresh stale provider data on existing titles (§4.3)
// ---------------------------------------------------------------------

async function getStaleTitles() {
  const generalCutoff = new Date(
    Date.now() - GENERAL_PROVIDER_REFRESH_DAYS * 86400_000
  ).toISOString();
  const tightCutoff = new Date(
    Date.now() - TOGETHER_SOLO_PROVIDER_REFRESH_DAYS * 86400_000
  ).toISOString();

  // Anything stale by the general 30-day cadence.
  const generallyStale = await supabaseGet(
    `/titles?select=tmdb_id,media_type&providers_updated_at=lt.${encodeURIComponent(generalCutoff)}&limit=${REFRESH_BATCH_CAP}`
  );

  // Anything currently sitting in ANY room's Together or Solo bucket
  // gets the tighter 7-day cadence -- these are the titles a couple
  // might actually be about to sit down and watch, so stale provider
  // data here is the expensive kind of wrong (§4.3: "the deck can
  // tolerate staleness; the 'let's watch this tonight' list cannot").
  const inPlay = await supabaseGet(
    `/user_title_buckets?select=tmdb_id,media_type&bucket=in.(together,solo)&limit=1000`
  );
  const inPlayKeys = new Set(inPlay.map((r) => `${r.tmdb_id}:${r.media_type}`));

  let tightlyStale = [];
  if (inPlayKeys.size > 0) {
    const inPlayTitles = await supabaseGet(
      `/titles?select=tmdb_id,media_type,providers_updated_at&providers_updated_at=lt.${encodeURIComponent(tightCutoff)}&limit=${REFRESH_BATCH_CAP}`
    );
    tightlyStale = inPlayTitles.filter((t) => inPlayKeys.has(`${t.tmdb_id}:${t.media_type}`));
  }

  const merged = new Map();
  for (const t of [...tightlyStale, ...generallyStale]) {
    merged.set(`${t.tmdb_id}:${t.media_type}`, t);
  }
  return Array.from(merged.values()).slice(0, REFRESH_BATCH_CAP);
}

async function runRefreshPhase(genreMap) {
  let stale;
  try {
    stale = await getStaleTitles();
  } catch (err) {
    console.warn(`Could not fetch stale-title list, skipping refresh phase: ${err.message}`);
    return [];
  }

  const rows = [];
  for (const { tmdb_id, media_type } of stale) {
    try {
      const detail = await fetchDetail(media_type, tmdb_id);
      rows.push(titleRowFromDetail(media_type, detail, genreMap));
    } catch (err) {
      console.warn(`Refresh detail fetch failed for ${media_type}:${tmdb_id}: ${err.message}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();

  await resolveProviderIds();

  const activePlatforms = await getActivePlatforms();
  const providerIdsCsv = activePlatforms.flatMap((p) => PROVIDER_IDS[p] || []).join('|');
  console.log(`Active platforms: ${activePlatforms.join(', ')}`);

  const genreMap = await loadGenreMap();

  const discovered = await runDiscoveryPhase(providerIdsCsv, genreMap);
  console.log(`Phase A (discovery): ${discovered.length} titles fetched.`);

  const refreshed = await runRefreshPhase(genreMap);
  console.log(`Phase B (refresh): ${refreshed.length} stale titles re-verified.`);

  const allRows = [...discovered, ...refreshed];

  if (allRows.length === 0) {
    console.warn('Nothing to upsert this run (both phases came back empty).');
  } else {
    // Chunked to keep individual request payloads reasonable regardless
    // of how large a single run's batch gets.
    const CHUNK = 200;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      await supabaseUpsert('titles', allRows.slice(i, i + CHUNK), 'tmdb_id,media_type');
    }
  }

  if (unmappedGenreIds.size > 0) {
    console.warn(
      `Encountered TMDB genre ids with no canonical mapping (component 4's tmdb_genre_map ` +
      `may be out of date with TMDB's genre list): ${Array.from(unmappedGenreIds).join(', ')}`
    );
  }

  let totalCount = 'unknown';
  try {
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/titles?select=tmdb_id`, {
      method: 'HEAD',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    totalCount = countRes.headers.get('content-range')?.split('/')?.[1] ?? 'unknown';
  } catch {
    // Purely informational -- never fail the run over a count check.
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s. Upserted ${allRows.length} rows. Cache now holds ~${totalCount} titles ` +
    `(target §12 POOL_TARGET_SIZE is 3000, informational only -- nothing here stops at it).`
  );

  // Fail the Actions run loudly only when literally nothing worked --
  // a run that fetched zero rows across both phases while active rooms
  // exist is a real outage worth surfacing, not a quiet retry-tomorrow.
  if (allRows.length === 0 && activePlatforms.length > 0) {
    console.error('No titles were fetched or refreshed this run.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Pool refresh failed:', err);
  process.exit(1);
});
