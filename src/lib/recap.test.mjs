import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, recapStats, findDrift } from './recap.js';

const T = (id, o = {}) => ({
  tmdb_id: id, media_type: 'movie', title: `T${id}`,
  runtime: o.runtime ?? 100, genres: o.genres || [1],
  providers: o.providers || ['netflix'],
  providers_updated_at: o.checked ?? new Date().toISOString(),
});

test('history falls back to marked_at when watched_on is missing', () => {
  const titles = [T(1), T(2)];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const rows = [
    { tmdb_id: 1, media_type: 'movie', watched_on: '2026-03-04', verdict: 'up' },
    { tmdb_id: 2, media_type: 'movie', marked_at: '2026-05-06T10:00:00Z' }, // legacy row
  ];
  const h = buildHistory(rows, byKey);
  assert.equal(h.items.length, 2, 'a row without watched_on must still appear');
  assert.equal(h.items[0].tmdb_id, 2, 'sorted newest first');
});

test('recap totals hours, verdicts, and the top genre and service', () => {
  const titles = [
    T(1, { runtime: 120, genres: [3], providers: ['netflix'] }),
    T(2, { runtime: 90, genres: [3], providers: ['netflix'] }),
    T(3, { runtime: 60, genres: [2], providers: ['max'] }),
  ];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const rows = [
    { tmdb_id: 1, media_type: 'movie', watched_on: '2026-01-10', verdict: 'up' },
    { tmdb_id: 2, media_type: 'movie', watched_on: '2026-02-11', verdict: 'up' },
    { tmdb_id: 3, media_type: 'movie', watched_on: '2026-02-12', verdict: 'down' },
  ];
  const s = recapStats(buildHistory(rows, byKey), 2026);
  assert.equal(s.count, 3);
  assert.equal(s.minutes, 270);
  assert.equal(s.hours, 5);
  assert.equal(s.liked, 2);
  assert.equal(s.disliked, 1);
  assert.equal(s.topGenre.id, 3);
  assert.equal(s.topService.id, 'netflix');
  assert.equal(s.busiestMonth.month, 1, 'February, zero-indexed');
  assert.equal(s.longest.tmdb_id, 1);
});

test('an empty year reports zero rather than throwing', () => {
  const s = recapStats({ items: [] }, 2026);
  assert.equal(s.count, 0);
});

test('drift separates "gone" from "we do not know"', () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  const titles = [
    T(1, { providers: ['netflix'] }),                       // still fine
    T(2, { providers: ['peacock'], checked: recent }),      // verified elsewhere -> gone
    T(3, { providers: ['peacock'], checked: old }),         // stale data -> unknown
  ];
  const { gone, unknown } = findDrift(titles, ['netflix']);
  assert.deepEqual(gone.map((t) => t.tmdb_id), [2]);
  assert.deepEqual(unknown.map((t) => t.tmdb_id), [3]);
  assert.ok(!gone.some((t) => t.tmdb_id === 3),
    'stale data must never be reported as a confident "gone"');
});

test('a title with no providers at all is unknown, not gone, when data is stale', () => {
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  const { gone, unknown } = findDrift([T(9, { providers: [], checked: old })], ['netflix']);
  assert.equal(gone.length, 0);
  assert.equal(unknown.length, 1);
});
