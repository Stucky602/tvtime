// Architecture ref: ARCHITECTURE_v1.0.md §5.1, §5.3, §5.4
//
// Deck assembly. Takes a candidate pool plus both members' swipe history
// and produces the ordered list of cards this user sees.
//
// Three phases, and which one is active depends only on whether this
// user has finished their seeded cards (§5.4's per-user seed exit):
//
//   SEED   -- day one. Both users get the SAME set of titles, drawn from
//             the intersection of their onboarding genre picks. Exists
//             because the spine's selection function is undefined before
//             anyone has swiped: genre_affinity with no history is just
//             onboarding priors, and min() over two flat priors has
//             nothing to distinguish.
//   STEADY -- everything after. SHARED_SPINE_RATIO of the deck is
//             joint-affinity picks served to both users (the overlap
//             guarantee); the rest is scored purely per-user.
//
// The seed is not redundant with the spine -- they're load-bearing at
// different times, with a clean handoff. See §5.4.

import { CONFIG } from './config.js';
import {
  genreAffinities,
  verdictAffinities,
  makePopularityNormalizer,
  scoreTitle,
  jointAffinity,
  quality,
} from './scoring.js';

const key = (t) => `${t.tmdb_id}:${t.media_type}`;

/**
 * Deterministic PRNG (mulberry32). Used for the SEED phase specifically:
 * §5.4 requires both users receive the same seeded set, and they build
 * their decks independently on two different phones with no coordination
 * beyond shared room data. Seeding the RNG from the room id makes the
 * selection reproducible across devices without any sync.
 *
 * The steady-state deck deliberately uses Math.random instead -- §5.2's
 * jitter exists so the deck ISN'T identical across loads.
 */
export function seededRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the scoring context for one user: their smoothed genre
 * affinities plus the set of titles their partner has already voted on.
 */
function buildContext(user, allSwipes, titlesByKey, candidates, partnerId, watchedRows) {
  const ownSwipes = allSwipes.filter((s) => s.user_id === user.id);
  const { affinities, globalRightRate } = genreAffinities(
    ownSwipes,
    titlesByKey,
    user.genre_prefs
  );

  const partnerVotedKeys = new Set();
  if (partnerId) {
    for (const s of allSwipes) {
      if (s.user_id === partnerId) partnerVotedKeys.add(`${s.tmdb_id}:${s.media_type}`);
    }
  }
  // partner_pending means "partner voted, YOU haven't" -- so anything
  // this user has already voted on is removed from the set rather than
  // scored. (Those titles are excluded from candidates anyway; this
  // keeps the term honest if that ever changes.)
  for (const s of ownSwipes) {
    partnerVotedKeys.delete(`${s.tmdb_id}:${s.media_type}`);
  }

  return {
    affinities,
    globalRightRate,
    partnerVotedKeys,
    // Room-scoped, so both members' verdicts feed both decks. That is
    // correct: "we watched this and didn't like it" is a shared fact,
    // not a private one.
    verdictAffinities: verdictAffinities(watchedRows, titlesByKey),
    popularityNorm: makePopularityNormalizer(candidates),
    currentYear: new Date().getFullYear(),
  };
}

/**
 * §5.4 seed selection. Widening ladder: intersection of both users'
 * onboarding picks -> union -> unrestricted. Never blocks on an empty
 * intersection, because a couple with zero overlapping checkboxes is
 * exactly the couple that most needs the popular-consensus deck.
 */
export function selectSeedTitles(candidates, userA, userB, roomId, size = CONFIG.SEEDED_DECK_SIZE) {
  const prefsA = new Set(userA?.genre_prefs || []);
  const prefsB = new Set(userB?.genre_prefs || []);
  const intersection = [...prefsA].filter((g) => prefsB.has(g));
  const union = [...new Set([...prefsA, ...prefsB])];

  // High-popularity, high-quality, per §5.4. Quality gate first so the
  // warm-up deck isn't padded with obscure titles neither person will
  // recognize -- recognition is what makes early swipes fast.
  const rankByAppeal = (pool) =>
    [...pool].sort(
      (x, y) =>
        quality(y) + Math.log1p(y.popularity ?? 0) / 20 -
        (quality(x) + Math.log1p(x.popularity ?? 0) / 20)
    );

  const matching = (genreSet) =>
    genreSet.length === 0
      ? []
      : candidates.filter((t) => (t.genres || []).some((g) => genreSet.includes(g)));

  let pool = matching(intersection);
  if (pool.length < size) {
    const seen = new Set(pool.map(key));
    pool = pool.concat(matching(union).filter((t) => !seen.has(key(t))));
  }
  if (pool.length < size) {
    const seen = new Set(pool.map(key));
    pool = pool.concat(candidates.filter((t) => !seen.has(key(t))));
  }

  const ranked = rankByAppeal(pool).slice(0, size);

  // Shuffled with a room-seeded RNG: both phones produce the same SET
  // (required for the overlap guarantee) but §5.4 explicitly allows the
  // order to differ, and a per-user shuffle keeps two people sitting on
  // the same couch from seeing identical cards in lockstep.
  return ranked;
}

/**
 * Interleaves spine picks through the personalized deck rather than
 * front-loading them. §5.4: "so the session does not open with 45
 * consecutive compromise picks."
 */
function interleave(personalized, spine) {
  if (spine.length === 0) return personalized;
  if (personalized.length === 0) return spine;

  const out = [];
  const step = (personalized.length + spine.length) / spine.length;
  let spineIdx = 0;
  let nextSpineAt = step;

  for (let i = 0; i < personalized.length; i++) {
    out.push(personalized[i]);
    while (spineIdx < spine.length && out.length >= nextSpineAt) {
      out.push(spine[spineIdx++]);
      nextSpineAt += step;
    }
  }
  while (spineIdx < spine.length) out.push(spine[spineIdx++]);
  return out;
}

/**
 * §5.2: partner_pending is weighted to dominate (W_PARTNER = 3.0), which
 * is intentional -- but left unchecked it would turn the whole deck into
 * a catch-up queue with no discovery. PARTNER_PENDING_CAP bounds the
 * share of the deck those titles may occupy.
 *
 * This has to actually RESERVE slots for non-pending titles, not just
 * reorder. An earlier version pushed the overflow to the back of the
 * list, which reads as a cap but isn't one: when the partner has voted
 * on everything in the pool, "sorted with overflow at the end" is still
 * a deck that's 100% catch-up. Caught by the test that floods the pool
 * with partner-voted titles.
 *
 * When there genuinely aren't enough non-pending titles to fill the
 * remainder, the deck gives the leftover slots back to pending rather
 * than shipping a short deck -- a smaller deck would hit
 * MIN_FILTERED_DECK and show an empty state, which is worse than a
 * catch-up-heavy one.
 */
function applyPartnerPendingCap(scored, deckSize, partnerVotedKeys) {
  const cap = Math.floor(deckSize * CONFIG.PARTNER_PENDING_CAP);
  const pending = [];
  const rest = [];
  for (const entry of scored) {
    if (partnerVotedKeys.has(key(entry.title))) pending.push(entry);
    else rest.push(entry);
  }
  if (pending.length <= cap) return scored;

  const keptPending = pending.slice(0, cap);
  const overflowPending = pending.slice(cap);

  // Non-pending titles fill the remainder. Only if they run out do the
  // overflow pending titles come back in.
  const head = [...keptPending, ...rest].sort((a, b) => b.score.total - a.score.total);
  return [...head, ...overflowPending];
}

/**
 * Main entry point. Returns the ordered deck plus a `phase` marker the
 * UI can use for its empty states and the dev-mode readout (§13).
 *
 * @param {object} args
 * @param {Array} args.candidates    unvoted, unwatched, platform-filtered titles
 * @param {Array} args.allSwipes     BOTH members' swipe rows
 * @param {object} args.user         the viewing user
 * @param {object} args.partner      the other member, or null if not joined yet
 * @param {string} args.roomId
 * @param {number} [args.seededSwipeCount] how many of this user's swipes
 *        landed on seeded titles; drives §5.4's per-user seed exit
 */
export function buildDeck({
  candidates,
  allSwipes,
  user,
  partner,
  roomId,
  historyTitles = [],
  watchedRows = [],
  hasFinishedSeed = false,
  rng = Math.random,
}) {
  const titlesByKey = new Map(candidates.map((t) => [key(t), t]));
  // Swipe history references titles that are no longer candidates (they
  // were swiped, so they're filtered out of the pool). Genre affinity
  // needs those title rows to attribute past swipes to genres, so the
  // caller passes them separately.
  for (const t of historyTitles) {
    if (!titlesByKey.has(key(t))) titlesByKey.set(key(t), t);
  }

  const ctx = buildContext(user, allSwipes, titlesByKey, candidates, partner?.id, watchedRows);

  // ---- SEED phase (§5.4) ----
  if (!hasFinishedSeed && partner) {
    const seed = selectSeedTitles(candidates, user, partner, roomId);
    if (seed.length > 0) {
      const seedRng = seededRng(`${roomId}:${user.id}`);
      // Same set for both users, order shuffled per-user.
      const shuffled = [...seed];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(seedRng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return {
        phase: 'seed',
        cards: shuffled,
        seedKeys: new Set(seed.map(key)),
      };
    }
  }

  // ---- STEADY phase: spine + personalized (§5.4) ----
  const scored = candidates.map((title) => ({
    title,
    score: scoreTitle(title, ctx, rng),
  }));
  scored.sort((a, b) => b.score.total - a.score.total);

  const capped = applyPartnerPendingCap(scored, CONFIG.DECK_SIZE, ctx.partnerVotedKeys);

  const spineCount = partner ? Math.floor(CONFIG.DECK_SIZE * CONFIG.SHARED_SPINE_RATIO) : 0;
  const personalCount = CONFIG.DECK_SIZE - spineCount;

  let spine = [];
  if (spineCount > 0 && partner) {
    const ctxPartner = buildContext(partner, allSwipes, titlesByKey, candidates, user.id, watchedRows);
    // Ranked by joint affinity and served to BOTH users -- this is the
    // deterministic overlap guarantee. No jitter here: if the two phones
    // computed different spines, the guarantee would evaporate.
    spine = [...candidates]
      .map((t) => ({ title: t, joint: jointAffinity(t, ctx, ctxPartner) }))
      .sort((a, b) => b.joint - a.joint)
      .slice(0, spineCount)
      .map((e) => e.title);
  }

  const spineKeys = new Set(spine.map(key));
  const personalized = capped
    .filter((e) => !spineKeys.has(key(e.title)))
    .slice(0, personalCount)
    .map((e) => e.title);

  // score_debug for every card, keyed so submitSwipe can attach the
  // right breakdown when this card is voted on (§5.2, "log the score").
  const debugByKey = new Map();
  for (const e of scored) {
    debugByKey.set(key(e.title), { total: e.score.total, ...e.score.terms });
  }

  return {
    phase: 'steady',
    cards: interleave(personalized, spine),
    spineKeys,
    debugByKey,
  };
}

/**
 * §5.3: filters MASK the built deck client-side rather than re-querying.
 * All off by default.
 *
 * Nine dimensions now. Every one of them intersects (AND), never
 * unions -- "Comedy + under 90 min" means comedy AND short, which is
 * what someone deciding what to watch tonight actually means.
 */
export function applyFilters(cards, filters) {
  if (!filters) return cards;
  return cards.filter((t) => {
    // --- Type ---
    if (filters.mediaType && t.media_type !== filters.mediaType) return false;

    // --- Genre ---
    if (filters.genres?.length) {
      if (!(t.genres || []).some((g) => filters.genres.includes(g))) return false;
    }

    // --- Decade ---
    if (filters.decades?.length) {
      if (!t.year) return false;
      const decade = Math.floor(t.year / 10) * 10;
      if (!filters.decades.includes(decade)) return false;
    }

    // --- Anime ---
    // TMDB has no "anime" genre. The standard proxy, and the one
    // JustWatch/TMDB users land on, is Animation + Japanese original
    // language -- which correctly keeps Studio Ghibli and Demon Slayer
    // while excluding Pixar and Bluey. It is a proxy, so it will miss
    // the occasional co-production listed under another language.
    if (filters.anime === 'only' || filters.anime === 'hide') {
      const isAnime = (t.genres || []).includes(ANIME_GENRE_ID) && t.original_language === 'ja';
      if (filters.anime === 'only' && !isAnime) return false;
      if (filters.anime === 'hide' && isAnime) return false;
    }

    // --- Runtime cap ---
    // Titles with unknown runtime are KEPT rather than dropped. TV
    // episode_run_time is frequently missing (§4.3), and silently
    // hiding every show with no runtime would gut the TV side of the
    // deck for a filter the user thinks only affects length.
    if (filters.maxRuntime && t.runtime && t.runtime > filters.maxRuntime) return false;

    // --- Minimum rating ---
    // Same reasoning: an unrated title is unknown, not bad. But a
    // rating from a handful of votes is noise, so it is treated as
    // unknown rather than trusted.
    if (filters.minRating) {
      const trustworthy = (t.vote_count ?? 0) >= 100;
      if (trustworthy && (t.rating ?? 0) < filters.minRating) return false;
    }

    // --- Streaming service ---
    if (filters.services?.length) {
      if (!(t.providers || []).some((p) => filters.services.includes(p))) return false;
    }

    // --- Language ---
    if (filters.language === 'en' && t.original_language !== 'en') return false;
    if (filters.language === 'foreign' && t.original_language === 'en') return false;

    // --- Recent only ---
    if (filters.newOnly) {
      const cutoff = new Date().getFullYear() - 2;
      if (!t.year || t.year < cutoff) return false;
    }

    return true;
  });
}

/** Canonical Animation genre id, from component 4's mapping table. */
const ANIME_GENRE_ID = 8;
