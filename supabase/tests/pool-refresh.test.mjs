// Architecture ref: ARCHITECTURE_v1.0.md §4 (whole section), §5.1
//
// This sandbox has no network access to api.themoviedb.org or a real
// Supabase project, so this file stands up a local HTTP server that
// speaks just enough of both APIs' shapes to exercise scripts/refresh-
// pool.mjs's actual logic end to end: pagination, genre mapping,
// exclusion rules, provider extraction, and the upsert payload shape.
//
// This is NOT part of the deployed app and is not run by any GitHub
// Actions workflow -- it's a one-off verification harness, kept here so
// the next person touching refresh-pool.mjs has something to run it
// against without needing real credentials.
//
// Usage: node supabase/tests/pool-refresh.test.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upserts = []; // captures every POST body the script sends, for assertions

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  // ---- TMDB discover ----
  if (p === '/discover/movie' || p === '/discover/tv') {
    const page = Number(url.searchParams.get('page'));
    // Only page 1 (of whatever base page today resolves to, captured
    // dynamically below) returns results; every other page is empty, to
    // exercise the "stop paging on empty results" break condition
    // without needing to predict today's exact computed page number.
    if (firstSeenPage[p] === undefined) firstSeenPage[p] = page;
    if (page !== firstSeenPage[p]) return send(200, { results: [] });

    if (p === '/discover/movie') {
      return send(200, {
        results: [
          { id: 111, title: 'Mock Movie One' },
          { id: 112, title: 'Mock Movie Two' },
        ],
      });
    }
    return send(200, {
      results: [
        { id: 211, name: 'Mock Show Soap' },     // will hard-exclude on detail
        { id: 212, name: 'Mock Show Reality' },  // will flag is_reality, not excluded
        { id: 213, name: 'Mock Show Normal' },
        { id: 214, name: 'Mock Show LongRunner' }, // will exceed TV_MAX_EPISODES
      ],
    });
  }

  // ---- TMDB detail ----
  if (p === '/movie/111') {
    return send(200, {
      id: 111, title: 'Mock Movie One',
      release_date: '2021-06-15', runtime: 118,
      overview: 'A mock movie.', poster_path: '/mock1.jpg', backdrop_path: null,
      vote_average: 7.4, vote_count: 3000, popularity: 55.2, original_language: 'en',
      genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
      videos: { results: [
        { site: 'Vimeo', type: 'Trailer', key: 'WRONG_SITE', official: true },
        { site: 'YouTube', type: 'Teaser', key: 'TEASER_KEY', official: true },
      ]},
      'watch/providers': { results: { US: { link: 'https://justwatch.test/111',
        flatrate: [{ provider_id: 8 }, { provider_id: 99 }] } } },
    });
  }
  if (p === '/movie/112') {
    return send(200, {
      id: 112, title: 'Mock Movie Two',
      release_date: '', runtime: null, // exercises empty-string year + null runtime
      overview: null, poster_path: null, backdrop_path: null,
      vote_average: 6.1, vote_count: 40, popularity: 3.1, original_language: 'fr',
      genres: [{ id: 18, name: 'Drama' }],
      'watch/providers': { results: {} }, // no US providers at all -> empty array, not dropped
    });
  }
  if (p === '/tv/211') {
    return send(200, {
      id: 211, name: 'Mock Show Soap',
      first_air_date: '2018-01-01', episode_run_time: [22],
      overview: 'A soap.', poster_path: null, backdrop_path: null,
      vote_average: 5.0, vote_count: 200, popularity: 40.0, original_language: 'en',
      number_of_episodes: 850,
      genres: [{ id: 10766, name: 'Soap' }],
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 8 }] } } },
    });
  }
  if (p === '/tv/212') {
    return send(200, {
      id: 212, name: 'Mock Show Reality',
      first_air_date: '2022-03-01', episode_run_time: [],
      overview: 'A reality show.', poster_path: '/mock212.jpg', backdrop_path: null,
      vote_average: 6.8, vote_count: 900, popularity: 80.0, original_language: 'en',
      number_of_episodes: 40,
      genres: [{ id: 10764, name: 'Reality' }],
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 15 }] } } },
    });
  }
  if (p === '/tv/213') {
    return send(200, {
      id: 213, name: 'Mock Show Normal',
      first_air_date: '2023-05-05', episode_run_time: [45],
      overview: 'A normal drama.', poster_path: '/mock213.jpg', backdrop_path: '/back213.jpg',
      vote_average: 8.1, vote_count: 1500, popularity: 95.0, original_language: 'en',
      number_of_episodes: 20,
      genres: [{ id: 18, name: 'Drama' }, { id: 9999, name: 'MadeUpGenre' }], // 9999 is deliberately unmapped
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 8 }, { provider_id: 337 }] } } },
    });
  }
  if (p === '/tv/214') {
    return send(200, {
      id: 214, name: 'Mock Show LongRunner',
      first_air_date: '2005-01-01', episode_run_time: [25],
      overview: 'Been on forever.', poster_path: null, backdrop_path: null,
      vote_average: 7.0, vote_count: 500, popularity: 20.0, original_language: 'en',
      number_of_episodes: 620, // exceeds TV_MAX_EPISODES
      genres: [{ id: 35, name: 'Comedy' }],
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 9 }] } } },
    });
  }

  // ---- TMDB provider list (runtime ID resolution) ----
  if (p === '/watch/providers/movie') {
    return send(200, { results: [
      { provider_id: 8, provider_name: 'Netflix' },
      { provider_id: 9, provider_name: 'Amazon Prime Video' },
      { provider_id: 337, provider_name: 'Disney Plus' },
      { provider_id: 15, provider_name: 'Hulu' },
      { provider_id: 1899, provider_name: 'Max' },
      { provider_id: 350, provider_name: 'Apple TV+' },
      { provider_id: 386, provider_name: 'Peacock Premium' },
      { provider_id: 531, provider_name: 'Paramount Plus' },
    ]});
  }

  // ---- Supabase REST ----
  if (p === '/rest/v1/tmdb_genre_map') {
    return send(200, [
      { tmdb_genre_id: 28, media_type: 'movie', canonical_genre_id: 1 },
      { tmdb_genre_id: 12, media_type: 'movie', canonical_genre_id: 1 },
      { tmdb_genre_id: 18, media_type: 'movie', canonical_genre_id: 3 },
      { tmdb_genre_id: 18, media_type: 'tv', canonical_genre_id: 3 },
      { tmdb_genre_id: 35, media_type: 'tv', canonical_genre_id: 2 },
      { tmdb_genre_id: 10766, media_type: 'tv', canonical_genre_id: 12 },
      { tmdb_genre_id: 10764, media_type: 'tv', canonical_genre_id: 12 },
      // 9999 intentionally omitted, to exercise the unmapped-genre warning path
    ]);
  }
  if (p === '/rest/v1/rooms') {
    return send(200, [{ platforms: ['netflix', 'hulu'] }]);
  }
  // Trailer backfill queue (Phase C)
  if (p === '/rest/v1/titles' && req.method === 'GET'
      && url.searchParams.get('trailer_checked_at') === 'is.null') {
    if (backfillServed) return send(200, []); // terminates once served
    backfillServed = true;
    return send(200, [{ tmdb_id: 902, media_type: 'movie' }]);
  }

  if (p === '/rest/v1/titles' && req.method === 'GET') {
    // A real Postgres would apply the providers_updated_at filter
    // server-side; this mock doesn't implement real filtering, so it
    // returns both candidates for every GET and lets the script's own
    // logic (the .filter() against inPlayKeys in getStaleTitles) do the
    // actual work -- that's the part under test, not the mock's SQL.
    return send(200, [
      { tmdb_id: 900, media_type: 'movie', providers_updated_at: '2020-01-01T00:00:00Z' },
      { tmdb_id: 901, media_type: 'movie', providers_updated_at: '2020-01-01T00:00:00Z' },
    ]);
  }
  if (p === '/rest/v1/user_title_buckets') {
    return send(200, [{ tmdb_id: 901, media_type: 'movie' }]);
  }
  if (p === '/movie/902') {
    return send(200, {
      id: 902, title: 'Backfill Movie', release_date: '2018-01-01', runtime: 95,
      overview: 'x', poster_path: null, backdrop_path: null,
      vote_average: 7.2, vote_count: 400, popularity: 33, original_language: 'en',
      genres: [{ id: 18, name: 'Drama' }],
      videos: { results: [
        { site: 'YouTube', type: 'Featurette', key: 'IGNORE_ME', official: true },
        { site: 'YouTube', type: 'Trailer', key: 'REAL_TRAILER', official: true },
      ]},
      'watch/providers': { results: { US: { link: 'https://justwatch.test/902',
        flatrate: [{ provider_id: 8 }] } } },
    });
  }
  if (p === '/movie/900') {
    return send(200, {
      id: 900, title: 'Stale Movie', release_date: '2015-05-05', runtime: 100,
      overview: 'x', poster_path: null, backdrop_path: null,
      vote_average: 6.0, vote_count: 200, popularity: 10, original_language: 'en',
      genres: [{ id: 18, name: 'Drama' }],
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 8 }] } } },
    });
  }
  if (p === '/movie/901') {
    return send(200, {
      id: 901, title: 'InPlay Movie', release_date: '2016-05-05', runtime: 100,
      overview: 'x', poster_path: null, backdrop_path: null,
      vote_average: 7.0, vote_count: 300, popularity: 12, original_language: 'en',
      genres: [{ id: 28, name: 'Action' }],
      'watch/providers': { results: { US: { flatrate: [{ provider_id: 9 }] } } },
    });
  }

  if (p === '/rest/v1/titles' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      upserts.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end();
    });
    return;
  }
  if (p === '/rest/v1/titles' && req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Range': '0-9/123' });
    return res.end();
  }

  console.error(`Mock server got unexpected request: ${req.method} ${p}${url.search}`);
  send(404, { error: 'not found in mock' });
});

const firstSeenPage = {};
let backfillServed = false;

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const child = spawn(
    process.execPath,
    [path.join(__dirname, '..', '..', 'scripts', 'refresh-pool.mjs')],
    {
      env: {
        ...process.env,
        TMDB_API_KEY: 'mock-key',
        TMDB_BASE_URL: `http://localhost:${port}`,
        SUPABASE_URL: `http://localhost:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: 'mock-service-key',
      },
      stdio: 'inherit',
    }
  );

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  server.close();

  console.log('\n--- assertions ---');
  let failures = 0;
  const assert = (cond, msg) => {
    if (cond) {
      console.log(`PASS: ${msg}`);
    } else {
      console.log(`FAIL: ${msg}`);
      failures++;
    }
  };

  assert(exitCode === 0, `script exited 0 (got ${exitCode})`);

  const allRows = upserts.flat();
  const byId = Object.fromEntries(allRows.map((r) => [`${r.tmdb_id}:${r.media_type}`, r]));

  assert(allRows.length > 0, 'at least one row was upserted');

  const soap = byId['211:tv'];
  assert(soap && soap.excluded === true, 'Soap-genre show is hard-excluded');
  assert(soap && soap.is_reality === false, 'Soap show is not flagged as reality');

  const reality = byId['212:tv'];
  assert(reality && reality.is_reality === true, 'Reality-genre show is flagged is_reality');
  assert(reality && reality.excluded === false, 'Reality show is NOT globally excluded (room-conditional per §4.4)');

  const longRunner = byId['214:tv'];
  assert(longRunner && longRunner.excluded === true, 'Show with 620 episodes exceeds TV_MAX_EPISODES and is excluded');

  const normal = byId['213:tv'];
  assert(normal && normal.excluded === false, 'Ordinary drama is not excluded');
  assert(normal && normal.genres.includes(3), 'Drama (canonical id 3) mapped correctly for a TV title');
  assert(normal && normal.providers.includes('netflix') && normal.providers.includes('disney'),
    'Providers correctly extracted from watch/providers.US.flatrate (netflix=8, disney=337)');

  const movieOne = byId['111:movie'];
  assert(movieOne && movieOne.year === 2021, 'Year extracted correctly from release_date');
  assert(movieOne && movieOne.genres.includes(1), 'Action+Adventure both map to canonical Action (id 1)');
  assert(movieOne && movieOne.providers.length === 1 && movieOne.providers[0] === 'netflix',
    'Untracked provider id (99) correctly ignored, only netflix kept');

  const movieTwo = byId['112:movie'];
  assert(movieTwo && movieTwo.year === null, 'Empty-string release_date correctly yields year=null, no throw');
  assert(movieTwo && movieTwo.runtime === null, 'Null runtime handled without throwing');
  assert(movieTwo && Array.isArray(movieTwo.providers) && movieTwo.providers.length === 0,
    'Title with no US providers still upserted, with an empty providers array (§4.1: not dropped)');

  const staleRefreshed = byId['900:movie'];
  assert(staleRefreshed !== undefined, 'Phase B refreshed the generally-stale title (900)');

  const inPlayRefreshed = byId['901:movie'];
  assert(inPlayRefreshed !== undefined, 'Phase B refreshed the in-play (Together/Solo) stale title (901)');

  const backfilled = byId['902:movie'];
  assert(backfilled !== undefined, 'Phase C backfilled a title that had never been checked');
  assert(backfilled && backfilled.trailer_key === 'REAL_TRAILER',
    'picks the official Trailer, not the Featurette');
  assert(backfilled && backfilled.trailer_checked_at,
    'stamps trailer_checked_at so the backfill terminates');
  assert(backfilled && backfilled.watch_link === 'https://justwatch.test/902',
    'captures the watch link');

  const teaserOnly = byId['111:movie'];
  assert(teaserOnly && teaserOnly.trailer_key === 'TEASER_KEY',
    'falls back to a Teaser when no Trailer exists, and ignores non-YouTube');

  const noVideos = byId['112:movie'];
  assert(noVideos && noVideos.trailer_key === null,
    'a title with no videos block gets a null key rather than throwing');

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
