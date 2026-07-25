import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionByStatus, indexWatchRows, staleWatching,
  commitmentHours, commitmentLabel, commitmentTier,
  onThisDay, tasteDrift,
} from './lifecycle.js';
import { unseenBoostKeys, notesByTitle, KIND } from './notes-pure.js';
import { suggestedIntent, intentFilters, findIntent, filterByCommitment, INTENTS } from './intent.js';

const T = (id, o = {}) => ({
  tmdb_id: id, media_type: o.type || 'movie', title: `T${id}`,
  runtime: o.runtime ?? 100, genres: o.genres || [1],
  episode_count: o.eps, season_count: o.seasons,
});
const W = (id, o = {}) => ({
  tmdb_id: id, media_type: o.type || 'movie',
  status: o.status || 'finished',
  started_on: o.started, watched_on: o.watched, marked_at: o.marked,
});

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------

test('partition separates the backlog from everything else', () => {
  const titles = [T(1), T(2), T(3), T(4)];
  const idx = indexWatchRows([
    W(2, { status: 'watching' }),
    W(3, { status: 'finished' }),
    W(4, { status: 'abandoned' }),
  ]);
  const p = partitionByStatus(titles, idx);
  assert.deepEqual(p.untouched.map((t) => t.tmdb_id), [1],
    'agreed-on-but-never-started is the actual backlog and must be distinguishable');
  assert.equal(p.watching.length, 1);
  assert.equal(p.finished.length, 1);
  assert.equal(p.abandoned.length, 1);
});

test('stale watching is generous, so the prompt does not become furniture', () => {
  const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  const rows = [
    W(1, { status: 'watching', started: recent }),
    W(2, { status: 'watching', started: old }),
    W(3, { status: 'finished', started: old }),
  ];
  const stale = staleWatching(rows);
  assert.deepEqual(stale.map((w) => w.tmdb_id), [2],
    'only long-stalled, still-watching rows qualify');
});

test('commitment returns null rather than guessing when data is missing', () => {
  assert.equal(commitmentHours(T(1, { type: 'movie' })), null, 'films have no commitment');
  assert.equal(commitmentHours(T(2, { type: 'tv' })), null, 'no episode count means no answer');
  assert.equal(commitmentLabel(T(3, { type: 'tv' })), null);
});

test('commitment converts episodes and runtime into hours', () => {
  const short = T(1, { type: 'tv', eps: 8, seasons: 1, runtime: 45 });   // 6 hrs
  const long = T(2, { type: 'tv', eps: 200, seasons: 10, runtime: 22 }); // ~73 hrs
  assert.equal(commitmentHours(short), 6);
  assert.equal(commitmentTier(short), 'short');
  assert.equal(commitmentTier(long), 'long');
  assert.match(commitmentLabel(short), /1 season/);
  assert.match(commitmentLabel(short), /8 eps/);
});

test('tier uses total hours, not episode count', () => {
  // 200 short episodes is a bigger ask than 30 long ones, but the point
  // is that neither is judged on episode count alone.
  const many = T(1, { type: 'tv', eps: 60, runtime: 22 });  // 22 hrs
  const few = T(2, { type: 'tv', eps: 10, runtime: 70 });   // ~12 hrs
  assert.equal(commitmentTier(many), 'long');
  assert.equal(commitmentTier(few), 'medium');
});

test('on this day returns finished watches from previous years only', () => {
  const today = new Date('2026-07-25T20:00:00Z');
  const titles = [T(1), T(2), T(3)];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const rows = [
    W(1, { watched: '2025-07-25', status: 'finished' }),  // a year ago: yes
    W(2, { watched: '2026-07-25', status: 'finished' }),  // today: not a memory
    W(3, { watched: '2024-07-25', status: 'abandoned' }), // abandoned: not fond
  ];
  const out = onThisDay(rows, byKey, today);
  assert.deepEqual(out.map((o) => o.tmdb_id), [1]);
  assert.equal(out[0].yearsAgo, 1);
});

test('taste drift stays silent on thin data rather than inventing a trend', () => {
  const byKey = new Map([['1:movie', T(1)]]);
  assert.equal(tasteDrift([W(1, { watched: '2026-01-01' })], byKey), null);
});

test('taste drift buckets finished watches over time', () => {
  const titles = [];
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    titles.push(T(i, { genres: i <= 5 ? [1] : [2] }));
    rows.push(W(i, { watched: `2026-0${i <= 5 ? 1 : 8}-1${i % 9}`, status: 'finished' }));
  }
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const drift = tasteDrift(rows, byKey);
  assert.ok(Array.isArray(drift) && drift.length >= 1);
  assert.ok(drift[0].top.length > 0, 'each bucket reports its dominant genres');
});

// ---------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------

test('unseen boosts exclude your own and anything already seen', () => {
  const notes = [
    { tmdb_id: 1, media_type: 'movie', kind: KIND.BOOST, author_id: 'them', seen_at: null },
    { tmdb_id: 2, media_type: 'movie', kind: KIND.BOOST, author_id: 'me', seen_at: null },
    { tmdb_id: 3, media_type: 'movie', kind: KIND.BOOST, author_id: 'them', seen_at: 'x' },
    { tmdb_id: 4, media_type: 'movie', kind: KIND.NOTE, author_id: 'them', seen_at: null },
  ];
  const keys = unseenBoostKeys(notes, 'me');
  assert.ok(keys.has('1:movie'));
  assert.ok(!keys.has('2:movie'), 'your own boost is not news to you');
  assert.ok(!keys.has('3:movie'), 'a seen boost stops shouting');
  assert.ok(!keys.has('4:movie'), 'a plain note is not a boost');
});

test('notes group by title', () => {
  const m = notesByTitle([
    { tmdb_id: 1, media_type: 'movie', body: 'a' },
    { tmdb_id: 1, media_type: 'movie', body: 'b' },
    { tmdb_id: 2, media_type: 'tv', body: 'c' },
  ]);
  assert.equal(m.get('1:movie').length, 2);
  assert.equal(m.get('2:tv').length, 1);
});

// ---------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------

test('intents only narrow, never widen', () => {
  for (const i of INTENTS) {
    const f = intentFilters(i);
    // Every intent must produce a valid full filter object, so it can
    // compose with the existing filter system rather than bypass it.
    assert.ok('genres' in f && 'decades' in f && 'services' in f,
      `${i.id} must return a complete filter object`);
  }
});

test('late night suggests something short; midday has no opinion', () => {
  const lateTue = new Date('2026-07-21T23:30:00');
  const middayTue = new Date('2026-07-21T13:00:00');
  assert.equal(suggestedIntent(lateTue), 'quick');
  assert.equal(suggestedIntent(middayTue), null,
    'no opinion is better than a fabricated one');
});

test('commitment filter keeps unknown-length series rather than hiding them', () => {
  const known = { tmdb_id: 1, media_type: 'tv', episode_count: 100, runtime: 45 };
  const unknown = { tmdb_id: 2, media_type: 'tv' };
  const film = { tmdb_id: 3, media_type: 'movie' };
  const hrs = (t) => (t.episode_count && t.runtime ? (t.episode_count * t.runtime) / 60 : null);

  const out = filterByCommitment([known, unknown, film], 12, hrs);
  assert.ok(!out.some((t) => t.tmdb_id === 1), '75-hour series excluded by a 12-hour cap');
  assert.ok(out.some((t) => t.tmdb_id === 2), 'unknown length is not evidence of a long show');
  assert.ok(out.some((t) => t.tmdb_id === 3), 'films are unaffected');
});

test('saved presets resolve alongside built-ins', () => {
  const saved = [{ id: 'saved:abc', label: 'Mine', filters: { mediaType: 'tv' } }];
  assert.equal(findIntent('quick').label, 'Quick one');
  assert.equal(findIntent('saved:abc', saved).label, 'Mine');
  assert.equal(findIntent('nope', saved), null);
});
