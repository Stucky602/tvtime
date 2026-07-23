import { GENRES, PLATFORMS } from './config.js';

// Feature 5: taste stats + per-service value.
//
// Pure functions over data the app already has, so they're testable and
// carry no I/O. The component just renders what these return.
//
// The second half is the one that earns its place: FlixPix knows every
// title you BOTH wanted and which service it was on. "You've matched on
// 47 Netflix titles and 2 Paramount+ titles" is a real subscription
// decision, made from data no other app has -- because no other app
// knows what two specific people jointly want.

const key = (t) => `${t.tmdb_id}:${t.media_type}`;
const GENRE_LABEL = Object.fromEntries(GENRES.map((g) => [g.id, g.label]));
const PLATFORM_LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.slug, p.label]));

/**
 * @param {Array} swipes      every swipe row for both members
 * @param {string} userId     the viewing user
 * @param {string} partnerId  the other member, or null
 * @param {Map} titlesByKey   title rows keyed `tmdb_id:media_type`
 */
export function computeStats({ swipes, userId, partnerId, titlesByKey, watchedRows = [] }) {
  const mine = new Map();
  const theirs = new Map();
  for (const s of swipes || []) {
    const k = `${s.tmdb_id}:${s.media_type}`;
    if (s.user_id === userId) mine.set(k, s.direction);
    else if (s.user_id === partnerId) theirs.set(k, s.direction);
  }

  // Only titles BOTH have voted on can say anything about agreement.
  // Counting one-sided votes would make agreement look worse the more
  // one person swiped, which measures effort rather than compatibility.
  let bothRight = 0;
  let bothLeft = 0;
  let split = 0;
  const decidedKeys = [];
  for (const [k, dir] of mine) {
    if (!theirs.has(k)) continue;
    decidedKeys.push(k);
    const other = theirs.get(k);
    if (dir === 'right' && other === 'right') bothRight++;
    else if (dir === 'left' && other === 'left') bothLeft++;
    else split++;
  }
  const decided = decidedKeys.length;

  // "Agreement" counts both-left as agreeing. Two people who both pass
  // on a film agree about it just as much as two who both want it --
  // measuring only matches would call a picky couple incompatible.
  const agreementPct = decided === 0 ? null : Math.round(((bothRight + bothLeft) / decided) * 100);

  // Genre tallies for matches vs splits.
  const sharedGenres = new Map();
  const splitGenres = new Map();
  for (const k of decidedKeys) {
    const t = titlesByKey.get(k);
    if (!t) continue;
    const bump = (m) => {
      for (const g of t.genres || []) m.set(g, (m.get(g) || 0) + 1);
    };
    const other = theirs.get(k);
    const dir = mine.get(k);
    if (dir === 'right' && other === 'right') bump(sharedGenres);
    else if (dir !== other) bump(splitGenres);
  }

  // Per-service value: matches attributable to each service. A title on
  // two services counts for both, because it justifies either one.
  const serviceMatches = new Map();
  for (const k of decidedKeys) {
    if (!(mine.get(k) === 'right' && theirs.get(k) === 'right')) continue;
    const t = titlesByKey.get(k);
    for (const p of t?.providers || []) {
      serviceMatches.set(p, (serviceMatches.get(p) || 0) + 1);
    }
  }

  const watchedCount = (watchedRows || []).length;
  const ratedUp = (watchedRows || []).filter((w) => w.verdict === 'up').length;
  const ratedDown = (watchedRows || []).filter((w) => w.verdict === 'down').length;

  const top = (m, labels, n = 4) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id, count]) => ({ id, label: labels[id] || String(id), count }));

  return {
    totalMine: mine.size,
    totalTheirs: theirs.size,
    decided,
    matches: bothRight,
    splits: split,
    bothPassed: bothLeft,
    agreementPct,
    sharedGenres: top(sharedGenres, GENRE_LABEL),
    splitGenres: top(splitGenres, GENRE_LABEL),
    services: [...serviceMatches.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, count]) => ({ slug, label: PLATFORM_LABEL[slug] || slug, count })),
    watchedCount,
    ratedUp,
    ratedDown,
  };
}

/**
 * Services the room pays for that have produced few or no matches.
 * The actionable half of the stats screen.
 *
 * Only speaks up once there's enough evidence to be worth saying --
 * telling someone to cancel a service after nine swipes would be
 * confidently wrong.
 */
export function serviceAdvice(stats, roomPlatforms, minMatchesForSignal = 25) {
  if (stats.matches < minMatchesForSignal) return null;
  const counts = new Map(stats.services.map((s) => [s.slug, s.count]));
  const weak = (roomPlatforms || [])
    .map((slug) => ({ slug, label: PLATFORM_LABEL[slug] || slug, count: counts.get(slug) || 0 }))
    .filter((s) => s.count <= Math.max(1, Math.round(stats.matches * 0.05)))
    .sort((a, b) => a.count - b.count);
  return weak.length ? weak : null;
}

export { key };
