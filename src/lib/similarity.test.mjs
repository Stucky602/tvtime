import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  similarity, moreLikeThis, keywordAffinities,
  keywordAffinityForTitle, favouritePeople,
} from './similarity.js';

const T = (id, o = {}) => ({
  tmdb_id: id, media_type: 'movie', title: `T${id}`,
  genres: o.genres || [], keyword_ids: o.kw || [],
  cast_ids: o.cast || [], cast_names: o.castNames || [],
  director_ids: o.dir || [], director_names: o.dirNames || [],
});
const sw = (id, dir) => ({ user_id: 'u', tmdb_id: id, media_type: 'movie', direction: dir });

test('keywords beat genre: same genre alone is weak, shared keywords are strong', () => {
  const a = T(1, { genres: [3], kw: [100, 101, 102] });
  const genreOnly = T(2, { genres: [3] });
  const keywordMatch = T(3, { genres: [3], kw: [100, 101, 102] });

  const weak = similarity(a, genreOnly);
  const strong = similarity(a, keywordMatch);

  assert.ok(strong > weak * 2,
    `shared keywords should dominate shared genre (got ${strong.toFixed(2)} vs ${weak.toFixed(2)})`);
});

test('a shared director is a strong signal even with nothing else in common', () => {
  const a = T(1, { genres: [3], dir: [500] });
  const sameDir = T(2, { genres: [9], dir: [500] });
  const nothing = T(3, { genres: [9] });
  assert.ok(similarity(a, sameDir) > similarity(a, nothing) + 0.2);
});

test('a title is never similar to itself (guards self-recommendation)', () => {
  const a = T(1, { kw: [1, 2, 3], dir: [9] });
  assert.equal(similarity(a, a), 0);
});

test('overlap is damped, so heavily-tagged titles cannot run away with it', () => {
  const a = T(1, { kw: [1, 2, 3, 4, 5, 6, 7, 8] });
  const four = T(2, { kw: [1, 2, 3, 4] });
  const eight = T(3, { kw: [1, 2, 3, 4, 5, 6, 7, 8] });
  const r = similarity(a, eight) / similarity(a, four);
  assert.ok(r < 1.8, `double the overlap must not double the score (ratio ${r.toFixed(2)})`);
});

test('moreLikeThis ranks by similarity and drops noise', () => {
  const seed = T(1, { genres: [1], kw: [10, 11, 12], dir: [77] });
  const pool = [
    T(2, { genres: [1], kw: [10, 11, 12], dir: [77] }), // very close
    T(3, { genres: [1], kw: [10] }),                    // loosely related
    T(4, { genres: [9] }),                              // unrelated
  ];
  const out = moreLikeThis(seed, pool);
  assert.equal(out[0].tmdb_id, 2, 'closest match first');
  assert.ok(!out.some((t) => t.tmdb_id === 4), 'unrelated titles are filtered out, not just ranked low');
});

test('keyword affinity learns direction and ignores seen/snooze', () => {
  const titles = [T(1, { kw: [50] }), T(2, { kw: [51] }), T(3, { kw: [52] })];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));

  const swipes = [];
  for (let i = 0; i < 12; i++) swipes.push(sw(1, 'right'));
  for (let i = 0; i < 12; i++) swipes.push(sw(2, 'left'));
  // "seen" must contribute nothing -- that's the whole reason it exists.
  for (let i = 0; i < 12; i++) swipes.push(sw(3, 'seen'));

  const { affinities, globalRate } = keywordAffinities(swipes, byKey);
  assert.ok(affinities.get(50) > affinities.get(51), 'liked keyword outranks disliked');
  assert.ok(!affinities.has(52), '"seen" contributed no keyword signal');

  const liked = keywordAffinityForTitle(titles[0], affinities, globalRate);
  const disliked = keywordAffinityForTitle(titles[1], affinities, globalRate);
  assert.ok(liked > disliked);
});

test('favourite people need repeat evidence and favour directors', () => {
  const titles = [
    T(1, { dir: [900], dirNames: ['Denis'], cast: [1], castNames: ['A'] }),
    T(2, { dir: [900], dirNames: ['Denis'], cast: [2], castNames: ['B'] }),
    T(3, { dir: [901], dirNames: ['OneOff'], cast: [3], castNames: ['C'] }),
  ];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:movie`, t]));
  const swipes = [sw(1, 'right'), sw(2, 'right'), sw(3, 'right')];

  const fav = favouritePeople(swipes, byKey);
  assert.ok(fav.some((p) => p.id === 900), 'director seen twice qualifies');
  assert.ok(!fav.some((p) => p.id === 901), 'a single appearance is not evidence');
  assert.equal(fav[0].kind, 'director', 'directors rank above cast');
});

test('missing keyword/credit data degrades to zero rather than throwing', () => {
  const bare = { tmdb_id: 1, media_type: 'movie', title: 'X' };
  const other = { tmdb_id: 2, media_type: 'movie', title: 'Y' };
  assert.equal(similarity(bare, other), 0);
  assert.equal(keywordAffinityForTitle(bare, new Map(), 0.5), 0);
  assert.deepEqual(favouritePeople([], new Map()), []);
});
