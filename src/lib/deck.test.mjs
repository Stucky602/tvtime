// Architecture ref: ARCHITECTURE_v1.0.md §13
//
// Tests for the deck build module. Node's built-in test runner, no
// dependencies (`node --test src/lib/deck.test.mjs`).
//
// The one that matters most is "divergence guard" below. §5.4 calls
// taste divergence "the failure mode most likely to kill this app in
// week one," and it is invisible in normal use -- two people swipe every
// night, nothing matches, and the app looks like it's working. §13 asks
// specifically for a test that constructs two users with opposed
// affinities and asserts their decks overlap. That's this file's reason
// to exist; the rest is supporting coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from './config.js';
import {
  genreAffinities,
  genreAffinityForTitle,
  quality,
  recency,
  makePopularityNormalizer,
  scoreTitle,
  jointAffinity,
} from './scoring.js';
import { buildDeck, selectSeedTitles, applyFilters, seededRng } from './deck.js';

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const GENRE = { ACTION: 1, COMEDY: 2, DRAMA: 3, HORROR: 4, SCIFI: 5, THRILLER: 6, ROMANCE: 9, FAMILY: 11 };

function makeTitle(id, genres, opts = {}) {
  return {
    tmdb_id: id,
    media_type: opts.media_type || 'movie',
    title: `Title ${id}`,
    // `'year' in opts` rather than `??` on purpose: a title with a
    // genuinely unknown year is a real case (§4.3 -- TMDB's
    // release_date/first_air_date can be empty), and `?? 2022` would
    // silently swap null for the default and make it untestable.
    year: 'year' in opts ? opts.year : 2022,
    runtime: 100,
    synopsis: 'x',
    poster_path: '/p.jpg',
    rating: opts.rating ?? 7,
    vote_count: opts.vote_count ?? 1000,
    popularity: opts.popularity ?? 50,
    genres,
    providers: opts.providers || ['netflix'],
    is_reality: false,
    excluded: false,
  };
}

/** A pool split cleanly between two opposed taste profiles. */
function buildOpposedPool(n = 200) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    // Alternate between "his lane" (horror/thriller) and "her lane"
    // (comedy/romance), with a thin band of shared drama.
    if (i % 3 === 0) pool.push(makeTitle(1000 + i, [GENRE.HORROR, GENRE.THRILLER], { popularity: 40 + i }));
    else if (i % 3 === 1) pool.push(makeTitle(1000 + i, [GENRE.COMEDY, GENRE.ROMANCE], { popularity: 40 + i }));
    else pool.push(makeTitle(1000 + i, [GENRE.DRAMA], { popularity: 30 + i }));
  }
  return pool;
}

const USER_A = { id: 'user-a', genre_prefs: [GENRE.HORROR, GENRE.THRILLER] };
const USER_B = { id: 'user-b', genre_prefs: [GENRE.COMEDY, GENRE.ROMANCE] };

/** Deterministic RNG so scoring tests don't flake on jitter. */
const noJitter = () => 0.5;

// ---------------------------------------------------------------------
// Scoring terms (§5.2)
// ---------------------------------------------------------------------

test('quality: zeroed below the vote-count floor', () => {
  const lowSample = makeTitle(1, [GENRE.DRAMA], { rating: 10, vote_count: 3 });
  const wellRated = makeTitle(2, [GENRE.DRAMA], { rating: 8, vote_count: 5000 });
  assert.equal(quality(lowSample), 0, 'a 10.0 from 3 votes must not dominate the sort');
  assert.equal(quality(wellRated), 0.8);
});

test('recency: current year is 1, decays to 0, never negative', () => {
  const year = 2026;
  assert.equal(recency(makeTitle(1, [], { year: 2026 }), year), 1);
  assert.equal(recency(makeTitle(2, [], { year: 2021 }), year), 0.5);
  assert.equal(recency(makeTitle(3, [], { year: 1990 }), year), 0);
  assert.equal(recency(makeTitle(4, [], { year: null }), year), 0);
});

test('popularity: normalized within the pool, not against a fixed scale', () => {
  const small = [makeTitle(1, [], { popularity: 5 }), makeTitle(2, [], { popularity: 10 })];
  const withBlockbuster = [...small, makeTitle(3, [], { popularity: 5000 })];

  const normSmall = makePopularityNormalizer(small);
  const normBig = makePopularityNormalizer(withBlockbuster);

  assert.equal(normSmall(small[1]), 1, 'top of pool normalizes to 1');
  assert.ok(normBig(small[1]) < 0.4, 'same title scores far lower once a blockbuster joins the pool');
});

test('genre affinity: onboarding priors dominate before ~alpha swipes, behavior takes over after', () => {
  const titles = [makeTitle(1, [GENRE.HORROR]), makeTitle(2, [GENRE.HORROR])];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));

  // No history at all: the onboarding pick should sit near the 1.0 prior.
  const cold = genreAffinities([], byKey, [GENRE.HORROR]);
  assert.ok(cold.affinities.get(GENRE.HORROR) > 0.9, 'checked genre starts near 1.0');

  // Heavy contrary evidence: 20 left-swipes on horror should pull it down.
  const contrary = [];
  for (let i = 0; i < 20; i++) {
    contrary.push({ user_id: 'u', tmdb_id: 1, media_type: 'movie', direction: 'left' });
  }
  const warm = genreAffinities(contrary, byKey, [GENRE.HORROR]);
  assert.ok(
    warm.affinities.get(GENRE.HORROR) < 0.3,
    'observed behavior overrides the onboarding prior once evidence accumulates'
  );
});

test('genre affinity survives an extreme global right rate instead of collapsing to zero', () => {
  // Regression test for a real bug. §5.2 says to rescale by subtracting
  // the global right rate, which divides by (1 - rate) -- so a user who
  // right-swipes nearly everything had every genre scored at exactly 0,
  // killing the entire learning signal for precisely the user whose
  // onboarding picks were most accurate.
  const titles = [makeTitle(1, [GENRE.HORROR]), makeTitle(2, [GENRE.COMEDY])];
  const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));

  const swipes = [];
  for (let i = 0; i < 30; i++) {
    swipes.push({ user_id: 'u', tmdb_id: 1, media_type: 'movie', direction: 'right' });
  }
  // One left swipe on comedy: a real preference, but the rate is still ~0.97.
  swipes.push({ user_id: 'u', tmdb_id: 2, media_type: 'movie', direction: 'left' });

  const { affinities, globalRightRate } = genreAffinities(swipes, byKey, [GENRE.HORROR]);
  assert.ok(globalRightRate > 0.9, 'fixture should produce an extreme baseline');

  const horrorScore = genreAffinityForTitle(titles[0], affinities, globalRightRate);
  const comedyScore = genreAffinityForTitle(titles[1], affinities, globalRightRate);

  assert.ok(
    horrorScore > comedyScore,
    'the genre the user actually likes must still outrank the one they rejected'
  );
  assert.ok(horrorScore > 0, 'the term must carry signal rather than flatlining at 0');
});

test('partner_pending dominates the sum, as §5.2 intends', () => {
  const pool = [makeTitle(1, [GENRE.DRAMA]), makeTitle(2, [GENRE.DRAMA])];
  const ctx = {
    affinities: new Map(),
    globalRightRate: 0.5,
    partnerVotedKeys: new Set(['1:movie']),
    popularityNorm: makePopularityNormalizer(pool),
    currentYear: 2026,
  };
  const withPending = scoreTitle(pool[0], ctx, noJitter);
  const without = scoreTitle(pool[1], ctx, noJitter);
  assert.ok(
    withPending.total - without.total >= CONFIG.W_PARTNER - 0.01,
    'a partner-pending title outranks an otherwise identical one by ~W_PARTNER'
  );
});

test('joint affinity uses min, not mean', () => {
  const loved = makeTitle(1, [GENRE.HORROR]);
  const ctxA = { affinities: new Map([[GENRE.HORROR, 1.0]]), globalRightRate: 0.5 };
  const ctxB = { affinities: new Map([[GENRE.HORROR, 0.0]]), globalRightRate: 0.5 };

  const joint = jointAffinity(loved, ctxA, ctxB);
  const meanWouldBe = 0.5;
  assert.ok(
    joint < meanWouldBe,
    'a title one person loves and the other hates must not score like a compromise pick'
  );
  assert.equal(joint, 0);
});

// ---------------------------------------------------------------------
// §13's divergence guard -- the test this file exists for
// ---------------------------------------------------------------------

test('divergence guard: opposed tastes still share at least SHARED_SPINE_RATIO of the deck', () => {
  const candidates = buildOpposedPool(200);

  // Give both users real, sharply opposed swipe history so the spine is
  // operating on learned affinities rather than flat onboarding priors.
  // Both directions, deliberately -- a right-only fixture pushes
  // globalRightRate to 1.0 and flattens the very signal under test.
  const allSwipes = [];
  for (const t of candidates) {
    const g = t.genres;
    if (g.includes(GENRE.HORROR)) {
      allSwipes.push({ user_id: 'user-a', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right' });
      allSwipes.push({ user_id: 'user-b', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'left' });
    } else if (g.includes(GENRE.COMEDY)) {
      allSwipes.push({ user_id: 'user-a', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'left' });
      allSwipes.push({ user_id: 'user-b', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right' });
    } else {
      // Shared drama band: both lukewarm, one right one left, so the
      // baseline rate stays mid-range for both users.
      allSwipes.push({ user_id: 'user-a', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right' });
      allSwipes.push({ user_id: 'user-b', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right' });
    }
  }

  // Fresh pool of unvoted titles, same opposed structure.
  const freshPool = buildOpposedPool(200).map((t) => ({ ...t, tmdb_id: t.tmdb_id + 100000 }));

  const deckA = buildDeck({
    candidates: freshPool,
    allSwipes,
    user: USER_A,
    partner: USER_B,
    roomId: 'room-1',
    historyTitles: candidates,
    hasFinishedSeed: true,
    rng: noJitter,
  });
  const deckB = buildDeck({
    candidates: freshPool,
    allSwipes,
    user: USER_B,
    partner: USER_A,
    roomId: 'room-1',
    historyTitles: candidates,
    hasFinishedSeed: true,
    rng: noJitter,
  });

  const keysA = new Set(deckA.cards.map((t) => `${t.tmdb_id}:${t.media_type}`));
  const shared = deckB.cards.filter((t) => keysA.has(`${t.tmdb_id}:${t.media_type}`));

  const sharedRatio = shared.length / Math.min(deckA.cards.length, deckB.cards.length);

  assert.ok(
    sharedRatio >= CONFIG.SHARED_SPINE_RATIO * 0.9,
    `decks for opposed users shared only ${(sharedRatio * 100).toFixed(1)}% ` +
      `(need ~${CONFIG.SHARED_SPINE_RATIO * 100}%). Without this overlap two people swipe ` +
      `every night and never match.`
  );
});

test('divergence guard: without a spine, opposed decks overlap far less (proves the guard is load-bearing)', () => {
  // The pool must be substantially larger than DECK_SIZE for this test
  // to mean anything. With 200 candidates and a 150-card deck, both
  // users take 75% of the pool no matter how they rank it, and the
  // overlap is an artifact of pool size rather than a statement about
  // scoring. 800 candidates makes a 150-card deck genuinely selective.
  const candidates = buildOpposedPool(800);
  const byKey = new Map(candidates.map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));

  // Realistic history: each user swipes BOTH directions -- right on
  // their lane, left on the other's. A one-directional fixture would
  // push globalRightRate to 1.0 and flatten the signal under test.
  const historyFor = (userId, lovedGenre, hatedGenre) =>
    candidates.flatMap((t) => {
      if (t.genres.includes(lovedGenre)) {
        return [{ user_id: userId, tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right' }];
      }
      if (t.genres.includes(hatedGenre)) {
        return [{ user_id: userId, tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'left' }];
      }
      return [];
    });

  const affA = genreAffinities(historyFor('user-a', GENRE.HORROR, GENRE.COMEDY), byKey, USER_A.genre_prefs);
  const affB = genreAffinities(historyFor('user-b', GENRE.COMEDY, GENRE.HORROR), byKey, USER_B.genre_prefs);

  const ctxFor = (aff) => ({
    ...aff,
    partnerVotedKeys: new Set(),
    popularityNorm: makePopularityNormalizer(candidates),
    currentYear: 2026,
  });

  const rank = (aff) =>
    [...candidates]
      .map((t) => ({ t, s: scoreTitle(t, ctxFor(aff), noJitter).total }))
      .sort((x, y) => y.s - x.s)
      .slice(0, CONFIG.DECK_SIZE)
      .map((e) => `${e.t.tmdb_id}:${e.t.media_type}`);

  const purelyPersonalA = new Set(rank(affA));
  const purelyPersonalB = rank(affB);
  const overlap = purelyPersonalB.filter((k) => purelyPersonalA.has(k)).length / CONFIG.DECK_SIZE;

  assert.ok(
    overlap < CONFIG.SHARED_SPINE_RATIO,
    `purely personalized decks overlapped ${(overlap * 100).toFixed(1)}%, at or above the ` +
      `${CONFIG.SHARED_SPINE_RATIO * 100}% the spine guarantees -- if personalization alone ` +
      `already produces this much overlap, the spine isn't earning its complexity`
  );
});

// ---------------------------------------------------------------------
// Seed phase (§5.4)
// ---------------------------------------------------------------------

test('seed: both users receive the same SET of titles', () => {
  const candidates = buildOpposedPool(200);
  const seedA = selectSeedTitles(candidates, USER_A, USER_B, 'room-1');
  const seedB = selectSeedTitles(candidates, USER_B, USER_A, 'room-1');

  const keysA = new Set(seedA.map((t) => t.tmdb_id));
  const keysB = new Set(seedB.map((t) => t.tmdb_id));
  assert.deepEqual([...keysA].sort(), [...keysB].sort(), 'the overlap guarantee requires an identical set');
});

test('seed: empty genre intersection widens instead of returning nothing', () => {
  // No overlapping picks at all -- exactly the couple §5.4 says most
  // needs the popular-consensus deck.
  const candidates = buildOpposedPool(200);
  const noOverlapA = { id: 'a', genre_prefs: [GENRE.HORROR] };
  const noOverlapB = { id: 'b', genre_prefs: [GENRE.ROMANCE] };

  const seed = selectSeedTitles(candidates, noOverlapA, noOverlapB, 'room-1');
  assert.equal(seed.length, CONFIG.SEEDED_DECK_SIZE, 'must never block on an empty intersection');
});

test('seed: survives a pool smaller than SEEDED_DECK_SIZE', () => {
  const tiny = buildOpposedPool(10);
  const seed = selectSeedTitles(tiny, USER_A, USER_B, 'room-1');
  assert.equal(seed.length, 10, 'returns what exists rather than throwing or padding');
});

test('seed order differs per user but the set does not', () => {
  const candidates = buildOpposedPool(200);
  const allSwipes = [];

  const deckA = buildDeck({
    candidates, allSwipes, user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: false, rng: noJitter,
  });
  const deckB = buildDeck({
    candidates, allSwipes, user: USER_B, partner: USER_A,
    roomId: 'room-1', hasFinishedSeed: false, rng: noJitter,
  });

  assert.equal(deckA.phase, 'seed');
  assert.equal(deckB.phase, 'seed');

  const setA = new Set(deckA.cards.map((t) => t.tmdb_id));
  const setB = new Set(deckB.cards.map((t) => t.tmdb_id));
  assert.deepEqual([...setA].sort(), [...setB].sort(), 'same set');

  const orderA = deckA.cards.map((t) => t.tmdb_id).join(',');
  const orderB = deckB.cards.map((t) => t.tmdb_id).join(',');
  assert.notEqual(orderA, orderB, 'order should differ so two people on a couch are not in lockstep');
});

test('seededRng is deterministic for the same seed and different across seeds', () => {
  const a1 = seededRng('room:user')();
  const a2 = seededRng('room:user')();
  const b = seededRng('room:other')();
  assert.equal(a1, a2, 'same seed must reproduce across devices');
  assert.notEqual(a1, b);
});

test('seed graduation is by seed-set coverage, not total swipe count', () => {
  // The buildDeck-level contract this rests on: a user in the seed phase
  // gets phase 'seed' with a seedKeys set, and once hasFinishedSeed is
  // true they get 'steady'. The exact-coverage logic (persisting that
  // set and testing voted-coverage against it) lives in data.js's
  // buildAndCacheDeck, but the invariant it depends on is here: passing
  // hasFinishedSeed:false yields seed, true yields steady -- regardless
  // of how many swipes exist. A count-based shortcut would couple these.
  const candidates = buildOpposedPool(200);

  const stillSeeding = buildDeck({
    candidates, allSwipes: [], user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: false, rng: noJitter,
  });
  assert.equal(stillSeeding.phase, 'seed');
  assert.ok(stillSeeding.seedKeys.size > 0, 'seed phase must expose its set for graduation tracking');

  // Even with a large swipe history, hasFinishedSeed:false keeps them in
  // seed -- proving the phase is driven by the explicit flag (which
  // data.js derives from seed-set coverage) and not an implicit count.
  const bigHistory = candidates.slice(0, 100).map((t) => ({
    user_id: USER_A.id, tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right',
  }));
  const stillSeedingWithHistory = buildDeck({
    candidates: buildOpposedPool(200).map((t) => ({ ...t, tmdb_id: t.tmdb_id + 50000 })),
    allSwipes: bigHistory, user: USER_A, partner: USER_B,
    roomId: 'room-1', historyTitles: candidates, hasFinishedSeed: false, rng: noJitter,
  });
  assert.equal(stillSeedingWithHistory.phase, 'seed', 'a big swipe count must not force graduation');

  const graduated = buildDeck({
    candidates, allSwipes: [], user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });
  assert.equal(graduated.phase, 'steady');
});

// ---------------------------------------------------------------------
// Steady phase composition
// ---------------------------------------------------------------------

test('partner-pending cap bounds the catch-up share when discovery titles exist', () => {
  // Realistic mid-life state: partner has swiped a lot, but the pool
  // still holds plenty they haven't touched. The cap must hold here.
  const candidates = buildOpposedPool(300);
  const partnerVotedSlice = candidates.slice(0, 200);
  const allSwipes = partnerVotedSlice.map((t) => ({
    user_id: 'user-b', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right',
  }));

  const deck = buildDeck({
    candidates, allSwipes, user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });

  const partnerVoted = new Set(allSwipes.map((s) => `${s.tmdb_id}:${s.media_type}`));
  const pendingInDeck = deck.cards.filter((t) => partnerVoted.has(`${t.tmdb_id}:${t.media_type}`)).length;
  const ratio = pendingInDeck / deck.cards.length;

  assert.ok(
    ratio <= CONFIG.PARTNER_PENDING_CAP + 0.02,
    `catch-up titles filled ${(ratio * 100).toFixed(0)}% of the deck, above the ` +
      `${CONFIG.PARTNER_PENDING_CAP * 100}% cap; the cap exists so the deck stays discovery ` +
      `rather than becoming a queue`
  );
  assert.ok(ratio > 0.3, 'cap should not suppress catch-up entirely -- it is the highest-value term');
});

test('partner-pending cap: a fully-voted pool yields a full deck, not a short one', () => {
  // Degenerate case: the partner has swiped literally everything
  // available. There are no discovery titles to reserve slots for, so
  // the cap deliberately yields -- a short deck would trip
  // MIN_FILTERED_DECK and show an empty state, which is strictly worse
  // than a catch-up-heavy deck the user can actually act on.
  const candidates = buildOpposedPool(300);
  const allSwipes = candidates.map((t) => ({
    user_id: 'user-b', tmdb_id: t.tmdb_id, media_type: 'movie', direction: 'right',
  }));

  const deck = buildDeck({
    candidates, allSwipes, user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });

  assert.equal(deck.cards.length, CONFIG.DECK_SIZE, 'must still fill the deck');
});

test('spine titles are interleaved, not front-loaded', () => {
  const candidates = buildOpposedPool(200);
  const deck = buildDeck({
    candidates, allSwipes: [], user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });

  const spinePositions = deck.cards
    .map((t, i) => (deck.spineKeys.has(`${t.tmdb_id}:${t.media_type}`) ? i : -1))
    .filter((i) => i >= 0);

  assert.ok(spinePositions.length > 0, 'spine should be non-empty when a partner exists');
  const firstQuarter = spinePositions.filter((i) => i < deck.cards.length / 4).length;
  assert.ok(
    firstQuarter < spinePositions.length,
    'not every spine card should sit in the opening stretch -- §5.4 warns against 45 consecutive compromise picks'
  );
});

test('no partner yet: deck still builds, with no spine', () => {
  const candidates = buildOpposedPool(100);
  const deck = buildDeck({
    candidates, allSwipes: [], user: USER_A, partner: null,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });
  assert.equal(deck.phase, 'steady');
  assert.ok(deck.cards.length > 0, 'a solo user must still get something to swipe');
  assert.equal(deck.spineKeys.size, 0, 'joint affinity is undefined without a second person');
});

test('deck never exceeds DECK_SIZE', () => {
  const candidates = buildOpposedPool(500);
  const deck = buildDeck({
    candidates, allSwipes: [], user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });
  assert.ok(deck.cards.length <= CONFIG.DECK_SIZE, `got ${deck.cards.length}`);
});

test('empty candidate pool returns an empty deck rather than throwing', () => {
  const deck = buildDeck({
    candidates: [], allSwipes: [], user: USER_A, partner: USER_B,
    roomId: 'room-1', hasFinishedSeed: true, rng: noJitter,
  });
  assert.equal(deck.cards.length, 0);
});

// ---------------------------------------------------------------------
// Filters (§5.3)
// ---------------------------------------------------------------------

test('filters mask by type, genre, and decade; no filters is a passthrough', () => {
  const cards = [
    makeTitle(1, [GENRE.HORROR], { year: 1995 }),
    makeTitle(2, [GENRE.COMEDY], { year: 2015, media_type: 'tv' }),
    makeTitle(3, [GENRE.DRAMA], { year: 2023 }),
  ];
  cards[1].media_type = 'tv';

  assert.equal(applyFilters(cards, null).length, 3);
  assert.equal(applyFilters(cards, { mediaType: 'tv' }).length, 1);
  assert.equal(applyFilters(cards, { genres: [GENRE.HORROR] }).length, 1);
  assert.equal(applyFilters(cards, { decades: [1990] }).length, 1);
  assert.equal(applyFilters(cards, { decades: [2010, 2020] }).length, 2);
  assert.equal(
    applyFilters(cards, { mediaType: 'movie', genres: [GENRE.HORROR], decades: [2020] }).length,
    0,
    'combined filters intersect rather than union'
  );
});
