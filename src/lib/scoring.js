// Architecture ref: ARCHITECTURE_v1.0.md §5.2
//
// Pure scoring functions. No I/O, no Supabase, no React -- everything
// here takes plain data and returns plain data, which is what makes
// §13's "snapshot test that a known pool with known swipe history
// produces an expected ordering" possible at all.
//
// The whole learning system lives in genreAffinities() below: Laplace-
// smoothed per-genre right-swipe rates. §5.2 is emphatic that this is
// deliberately unsophisticated -- inspectable beats clever when there
// are two users and a few hundred swipes to learn from.

import { CONFIG } from './config.js';

// ---------------------------------------------------------------------
// Genre affinity (§5.2)
// ---------------------------------------------------------------------

/**
 * Per-genre smoothed right-swipe rate for one user.
 *
 *   affinity(g) = (right_g + alpha * prior(g)) / (total_g + alpha)
 *
 * prior(g) is 1.0 for genres checked at onboarding, else the user's
 * global right-swipe rate. alpha ~5 means onboarding dominates until
 * roughly 5 swipes exist in that genre, then observed behavior takes
 * over. Returns a Map so lookups in the hot scoring loop are O(1).
 *
 * @param {Array<{tmdb_id:number, media_type:string, direction:string}>} swipes
 * @param {Map<string, {genres:number[]}>} titlesByKey  keyed `${tmdb_id}:${media_type}`
 * @param {number[]} genrePrefs canonical genre ids checked at onboarding
 */
export function genreAffinities(swipes, titlesByKey, genrePrefs) {
  const alpha = CONFIG.GENRE_SMOOTHING_ALPHA;
  const prefs = new Set(genrePrefs || []);

  // Global right rate, used as the prior for genres NOT picked at
  // onboarding. With no swipes at all this is 0.5 -- a neutral prior
  // rather than 0, which would make every unpicked genre look actively
  // disliked on day one instead of merely unknown.
  const totalSwipes = swipes.length;
  const totalRights = swipes.filter((s) => s.direction === 'right').length;
  const globalRightRate = totalSwipes === 0 ? 0.5 : totalRights / totalSwipes;

  const rightByGenre = new Map();
  const totalByGenre = new Map();

  for (const swipe of swipes) {
    const title = titlesByKey.get(`${swipe.tmdb_id}:${swipe.media_type}`);
    // A swipe whose title has fallen out of the candidate set still
    // counts toward the global rate above, but can't be attributed to
    // any genre. Skipping is correct -- guessing would poison the model.
    if (!title) continue;
    for (const g of title.genres || []) {
      totalByGenre.set(g, (totalByGenre.get(g) || 0) + 1);
      if (swipe.direction === 'right') {
        rightByGenre.set(g, (rightByGenre.get(g) || 0) + 1);
      }
    }
  }

  const affinities = new Map();
  const allGenres = new Set([...totalByGenre.keys(), ...prefs]);
  for (const g of allGenres) {
    const right = rightByGenre.get(g) || 0;
    const total = totalByGenre.get(g) || 0;
    const prior = prefs.has(g) ? 1.0 : globalRightRate;
    affinities.set(g, (right + alpha * prior) / (total + alpha));
  }

  return { affinities, globalRightRate };
}

/**
 * §5.2: "the mean over the title's genres, rescaled toward 0-1 by
 * subtracting the user's global right rate and clamping."
 *
 * The subtraction is what makes this a *relative* signal: a user who
 * right-swipes everything has a high global rate, so a genre only scores
 * above zero if it beats their own baseline. Without it, an
 * indiscriminate swiper would score every genre near 1.0 and the term
 * would carry no information.
 *
 * DEVIATION FROM THE LITERAL SPEC, and why. Taken exactly as written,
 * "subtract the global right rate and clamp" divides by a headroom of
 * (1 - globalRightRate), which goes to zero as the rate approaches 1.
 * That kills the genre term entirely for any user who mostly
 * right-swipes -- and that is not an edge case, it is precisely the user
 * whose onboarding picks were accurate. Verified in testing: a user with
 * a 1.0 right rate scored every genre at 0, horror and comedy alike, so
 * the whole learning system silently stopped contributing.
 *
 * Fix: floor the headroom. Below MIN_HEADROOM the rescaling falls back
 * to spreading affinities around the observed mean instead of around the
 * global rate, which preserves the relative ordering between genres --
 * the only thing the deck actually needs from this term -- without
 * dividing by something near zero. Mid-range users (the common case) are
 * unaffected; the change only engages at the extremes where the original
 * formula produced no signal at all.
 */
const MIN_HEADROOM = 0.15;

export function genreAffinityForTitle(title, affinities, globalRightRate) {
  const genres = title.genres || [];
  if (genres.length === 0) return 0;

  let sum = 0;
  for (const g of genres) {
    sum += affinities.get(g) ?? globalRightRate;
  }
  const mean = sum / genres.length;

  const headroom = 1 - globalRightRate;
  if (headroom >= MIN_HEADROOM) {
    return Math.max(0, Math.min(1, (mean - globalRightRate) / headroom));
  }

  // Extreme-baseline path: centre on the baseline but scale by a fixed
  // window so genres still separate from each other.
  return Math.max(0, Math.min(1, 0.5 + (mean - globalRightRate) / (2 * MIN_HEADROOM)));
}

// ---------------------------------------------------------------------
// The other scoring terms (§5.2)
// ---------------------------------------------------------------------

/** vote_average / 10, zeroed below QUALITY_VOTE_FLOOR. */
export function quality(title) {
  if ((title.vote_count ?? 0) < CONFIG.QUALITY_VOTE_FLOOR) return 0;
  return Math.max(0, Math.min(1, (title.rating ?? 0) / 10));
}

/**
 * Log-scaled and normalized WITHIN the candidate pool, per §5.2 --
 * raw TMDB popularity is unbounded and spiky, so a fixed divisor would
 * be wrong the moment one blockbuster enters the pool. Returns a
 * function so the pool-wide max is computed once, not per title.
 */
export function makePopularityNormalizer(candidates) {
  let maxLog = 0;
  for (const t of candidates) {
    const l = Math.log1p(Math.max(0, t.popularity ?? 0));
    if (l > maxLog) maxLog = l;
  }
  return (title) => {
    if (maxLog <= 0) return 0;
    return Math.log1p(Math.max(0, title.popularity ?? 0)) / maxLog;
  };
}

/** 1.0 for the current year, decaying linearly to 0 over ~10 years. */
export function recency(title, currentYear = new Date().getFullYear()) {
  if (!title.year) return 0;
  const age = currentYear - title.year;
  if (age <= 0) return 1;
  return Math.max(0, 1 - age / CONFIG.RECENCY_DECAY_YEARS);
}

/**
 * §5.2: "1.0 if the partner has voted on this title and the viewing user
 * has not, else 0." The term that resolves Pending into Together/Solo
 * instead of letting two people swipe past each other for weeks.
 */
/**
 * VERDICT AFFINITY -- closing the learning loop.
 *
 * The post-watch thumbs collected by the §2.4 toast have been
 * accumulating with nothing reading them. That was a deliberate v1
 * decision (collect now, consume later); this is "later".
 *
 * Why a separate term rather than folding into genre affinity: a right
 * swipe means "this LOOKS interesting" -- a judgement about a poster
 * and one line of synopsis. A post-watch thumb means "we actually
 * enjoyed this" -- a judgement about the thing itself. The second is
 * strictly better, but arrives far more rarely, which is exactly why it
 * can't just replace the first.
 *
 * Returns a per-genre score centred on 0:
 *    > 0  genres you liked once you'd actually watched them
 *    < 0  genres that looked good and then disappointed you
 *
 * Smoothing is heavier than the swipe model (alpha 2 against very few
 * data points) because verdicts are scarce: one thumbs-down on the only
 * horror film you've finished should nudge, not condemn the genre.
 */
export function verdictAffinities(watchedRows, titlesByKey) {
  const up = new Map();
  const total = new Map();

  for (const w of watchedRows || []) {
    if (w.verdict !== 'up' && w.verdict !== 'down') continue; // unrated: no signal
    const title = titlesByKey.get(`${w.tmdb_id}:${w.media_type}`);
    if (!title) continue;
    for (const g of title.genres || []) {
      total.set(g, (total.get(g) || 0) + 1);
      if (w.verdict === 'up') up.set(g, (up.get(g) || 0) + 1);
    }
  }

  const alpha = 2;
  const out = new Map();
  for (const g of total.keys()) {
    const u = up.get(g) || 0;
    const n = total.get(g) || 0;
    // Laplace-smoothed toward 0.5 (neutral), then recentred to [-1, 1].
    const rate = (u + alpha * 0.5) / (n + alpha);
    out.set(g, (rate - 0.5) * 2);
  }
  return out;
}

/** Mean verdict affinity across a title's genres. 0 when unknown. */
export function verdictAffinityForTitle(title, verdictAff) {
  const genres = title.genres || [];
  if (!genres.length || !verdictAff || verdictAff.size === 0) return 0;
  let sum = 0;
  let seen = 0;
  for (const g of genres) {
    if (verdictAff.has(g)) {
      sum += verdictAff.get(g);
      seen++;
    }
  }
  return seen === 0 ? 0 : sum / seen;
}

export function partnerPending(title, partnerVotedKeys) {
  return partnerVotedKeys.has(`${title.tmdb_id}:${title.media_type}`) ? 1 : 0;
}

// ---------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------

/**
 * The §5.2 sum. Returns both the total and the per-term breakdown --
 * the breakdown goes into `swipes.score_debug` on submit, which is what
 * turns "why did it show me that" from a mystery into a query, and is
 * exactly the data a future real recommender would want.
 *
 * `rng` is injectable so tests can run deterministically; production
 * passes nothing and gets Math.random.
 */
export function scoreTitle(title, ctx, rng = Math.random) {
  const terms = {
    partner: partnerPending(title, ctx.partnerVotedKeys),
    genre: genreAffinityForTitle(title, ctx.affinities, ctx.globalRightRate),
    // Signed, unlike every other term: this one can push a title DOWN,
    // which is the whole point of learning from disappointment.
    verdict: verdictAffinityForTitle(title, ctx.verdictAffinities),
    quality: quality(title),
    pop: ctx.popularityNorm(title),
    recency: recency(title, ctx.currentYear),
  };

  const jitter = (rng() - 0.5) * CONFIG.JITTER_RANGE;

  const total =
    CONFIG.W_PARTNER * terms.partner +
    CONFIG.W_GENRE * terms.genre +
    CONFIG.W_VERDICT * terms.verdict +
    CONFIG.W_QUALITY * terms.quality +
    CONFIG.W_POP * terms.pop +
    CONFIG.W_RECENCY * terms.recency +
    jitter;

  return { total, terms, jitter };
}

/**
 * §5.4's spine selection function:
 *
 *   joint_affinity(t, room) = min(affinity_a(t), affinity_b(t))
 *
 * Minimum rather than mean, deliberately: mean rewards a title one
 * person loves and the other hates, which is precisely the title that
 * will never produce a match. Minimum surfaces titles both people are at
 * least warm on.
 */
export function jointAffinity(title, ctxA, ctxB) {
  return Math.min(
    genreAffinityForTitle(title, ctxA.affinities, ctxA.globalRightRate),
    genreAffinityForTitle(title, ctxB.affinities, ctxB.globalRightRate)
  );
}
