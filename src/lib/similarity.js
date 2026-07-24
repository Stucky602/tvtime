// Richer similarity: keywords, cast, directors.
//
// Genre-only similarity is close to useless for recommendation --
// "Drama" spans Paddington and Schindler's List. Keywords are what
// actually describe a title ("time loop", "heist", "found footage"),
// and shared cast or director is the strongest single signal a person
// will recognise.
//
// WEIGHTING, and why keywords beat everything else. A shared director is
// a strong signal but a rare one; most pairs of titles share none. A
// shared genre is common but weak. Keywords sit in the useful middle:
// common enough to fire regularly, specific enough to mean something.
// So keywords carry the most total weight, with director as a sharp
// bonus when it happens.
//
// All pure functions over rows already in memory -- no I/O, testable,
// and cheap enough to run over a 500-title candidate set on a phone.

const W = {
  keyword: 1.0,
  cast: 0.7,
  director: 1.4, // rare, so worth a lot when present
  genre: 0.35,   // common, so worth little
};

function overlapCount(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let n = 0;
  for (const x of b) if (set.has(x)) n++;
  return n;
}

/**
 * Similarity between two titles, roughly 0..1.
 *
 * Overlap counts are damped with a square root rather than used raw:
 * two titles sharing eight keywords are not twice as similar as two
 * sharing four, and without damping a handful of heavily-tagged
 * blockbusters would dominate every "more like this" list.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.tmdb_id === b.tmdb_id && a.media_type === b.media_type) return 0;

  const kw = Math.sqrt(overlapCount(a.keyword_ids, b.keyword_ids));
  const cast = Math.sqrt(overlapCount(a.cast_ids, b.cast_ids));
  const dir = overlapCount(a.director_ids, b.director_ids) > 0 ? 1 : 0;
  const gen = Math.sqrt(overlapCount(a.genres, b.genres));

  const raw = W.keyword * kw + W.cast * cast + W.director * dir + W.genre * gen;

  // Normalised against a "very similar" reference rather than a true
  // maximum: in practice ~4 shared keywords plus a shared director is
  // as alike as two distinct titles get, and anchoring there keeps the
  // scale meaningful instead of compressing everything into the bottom.
  const reference = W.keyword * 2 + W.director + W.genre * 1.4;
  return Math.min(1, raw / reference);
}

/**
 * Titles most similar to a seed. Used by "More like this".
 */
export function moreLikeThis(seed, candidates, limit = 12) {
  return candidates
    .map((t) => ({ title: t, score: similarity(seed, t) }))
    .filter((e) => e.score > 0.08) // below this it's noise, not a recommendation
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.title);
}

/**
 * A user's affinity for individual keywords, learned from swipes --
 * the same smoothed-rate approach the genre model uses, at a much finer
 * grain.
 *
 * Alpha is higher here (8) than for genres because keywords are far
 * sparser: any single keyword may have two or three swipes behind it,
 * and without heavy smoothing one right-swipe would make "time loop"
 * look like a defining preference.
 */
export function keywordAffinities(swipes, titlesByKey) {
  const right = new Map();
  const total = new Map();

  for (const s of swipes || []) {
    if (s.direction !== 'left' && s.direction !== 'right') continue; // seen/snooze carry no signal
    const t = titlesByKey.get(`${s.tmdb_id}:${s.media_type}`);
    if (!t) continue;
    for (const k of t.keyword_ids || []) {
      total.set(k, (total.get(k) || 0) + 1);
      if (s.direction === 'right') right.set(k, (right.get(k) || 0) + 1);
    }
  }

  const alpha = 8;
  const globalRate = (() => {
    const votes = (swipes || []).filter((s) => s.direction === 'left' || s.direction === 'right');
    if (!votes.length) return 0.5;
    return votes.filter((s) => s.direction === 'right').length / votes.length;
  })();

  const out = new Map();
  for (const k of total.keys()) {
    const r = right.get(k) || 0;
    const n = total.get(k) || 0;
    out.set(k, (r + alpha * globalRate) / (n + alpha));
  }
  return { affinities: out, globalRate };
}

/** Mean keyword affinity for a title, recentred so 0 = your baseline. */
export function keywordAffinityForTitle(title, kwAff, globalRate) {
  const ids = title?.keyword_ids || [];
  if (!ids.length || !kwAff || kwAff.size === 0) return 0;
  let sum = 0;
  let seen = 0;
  for (const k of ids) {
    if (kwAff.has(k)) {
      sum += kwAff.get(k);
      seen++;
    }
  }
  if (seen === 0) return 0;
  const mean = sum / seen;
  const headroom = Math.max(0.15, 1 - globalRate);
  return Math.max(-1, Math.min(1, (mean - globalRate) / headroom));
}

/**
 * People (cast + directors) the user reliably says yes to.
 * Powers "More from ..." and the person-discovery surface.
 */
export function favouritePeople(swipes, titlesByKey, minVotes = 2) {
  const tally = new Map(); // id -> { name, right, total }

  for (const s of swipes || []) {
    if (s.direction !== 'left' && s.direction !== 'right') continue;
    const t = titlesByKey.get(`${s.tmdb_id}:${s.media_type}`);
    if (!t) continue;

    const people = [
      ...(t.director_ids || []).map((id, i) => ({ id, name: (t.director_names || [])[i], kind: 'director' })),
      ...(t.cast_ids || []).slice(0, 4).map((id, i) => ({ id, name: (t.cast_names || [])[i], kind: 'cast' })),
    ];

    for (const p of people) {
      if (!p.id || !p.name) continue;
      const cur = tally.get(p.id) || { name: p.name, kind: p.kind, right: 0, total: 0 };
      cur.total++;
      if (s.direction === 'right') cur.right++;
      tally.set(p.id, cur);
    }
  }

  return [...tally.entries()]
    .filter(([, v]) => v.total >= minVotes && v.right / v.total >= 0.6)
    .map(([id, v]) => ({ id, ...v, rate: v.right / v.total }))
    // Directors first: a director you like predicts far better than the
    // fourth-billed actor in two films you happened to swipe right on.
    .sort((a, b) => (b.kind === 'director') - (a.kind === 'director') || b.right - a.right)
    .slice(0, 8);
}
