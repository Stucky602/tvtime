// Pure ranking maths for pairwise picks. Separate from picks.js so it
// can be tested without the Supabase client.

/**
 * Elo over head-to-head results.
 *
 * Chosen over "count the wins" because wins are not comparable: beating
 * the title you love most is worth more than beating one you were
 * lukewarm about, and a raw tally cannot express that. Elo also handles
 * the sparse case sanely, which matters when a bracket only ever
 * produces seven comparisons a session.
 *
 * K is low (16) on purpose. These are opinions about films on a
 * Tuesday, not tournament results, and a single contrarian pick should
 * nudge rather than upend.
 */
export function eloRatings(picks, { start = 1500, k = 16 } = {}) {
  const r = new Map();
  const get = (key) => (r.has(key) ? r.get(key) : start);

  // Oldest first: ratings are path-dependent, and applying recent
  // results before old ones would give a different and wrong answer.
  const ordered = [...(picks || [])].sort(
    (a, b) => new Date(a.decided_at) - new Date(b.decided_at)
  );

  for (const p of ordered) {
    const w = `${p.winner_tmdb_id}:${p.winner_media_type}`;
    const l = `${p.loser_tmdb_id}:${p.loser_media_type}`;
    const rw = get(w);
    const rl = get(l);
    const expected = 1 / (1 + Math.pow(10, (rl - rw) / 400));
    r.set(w, rw + k * (1 - expected));
    r.set(l, rl - k * (1 - expected));
  }
  return r;
}

/**
 * Normalised to roughly -1..1 for use as a scoring term, centred on the
 * starting rating so an unrated title contributes exactly nothing.
 */
export function pickAffinity(titleKey, ratings, { start = 1500, spread = 200 } = {}) {
  if (!ratings || !ratings.has(titleKey)) return 0;
  return Math.max(-1, Math.min(1, (ratings.get(titleKey) - start) / spread));
}

/**
 * Your most and least wanted, by head-to-head record.
 * Requires a minimum number of comparisons, since one win against one
 * opponent is not a ranking.
 */
export function rankedTitles(picks, minComparisons = 2) {
  const seen = new Map();
  for (const p of picks || []) {
    const w = `${p.winner_tmdb_id}:${p.winner_media_type}`;
    const l = `${p.loser_tmdb_id}:${p.loser_media_type}`;
    seen.set(w, (seen.get(w) || 0) + 1);
    seen.set(l, (seen.get(l) || 0) + 1);
  }
  const ratings = eloRatings(picks);
  return [...ratings.entries()]
    .filter(([key]) => (seen.get(key) || 0) >= minComparisons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, rating]) => ({ key, rating, comparisons: seen.get(key) || 0 }));
}
