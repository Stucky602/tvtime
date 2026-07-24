import { PLATFORMS } from './config.js';

// Watch history + recap (item 10), and provider-drift detection (item 6).
//
// Recap is the item that survived four rounds of cutting despite being
// the least technical, and it's the reason Watched is worth having a tab
// at all: without it, Watched is a graveyard. "23 things together this
// year" is the thing you'd actually show someone.
//
// Pure functions over rows the app already fetches -- no I/O, testable.

const PLATFORM_LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.slug, p.label]));

/**
 * Group watched titles into a year-by-year, month-by-month history.
 *
 * Falls back to marked_at when watched_on is absent, so rows that
 * predate the watched_on column still appear rather than silently
 * vanishing from a history that claims to be complete.
 */
export function buildHistory(watchedRows, titlesByKey) {
  const items = [];
  for (const w of watchedRows || []) {
    const t = titlesByKey.get(`${w.tmdb_id}:${w.media_type}`);
    if (!t) continue;
    const when = w.watched_on || w.marked_at;
    if (!when) continue;
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) continue;
    items.push({
      ...t,
      verdict: w.verdict ?? null,
      when: d,
      year: d.getFullYear(),
      month: d.getMonth(),
    });
  }

  items.sort((a, b) => b.when - a.when);

  const byYear = new Map();
  for (const it of items) {
    if (!byYear.has(it.year)) byYear.set(it.year, []);
    byYear.get(it.year).push(it);
  }
  return { items, byYear };
}

/**
 * Headline numbers for a period. Defaults to the current year, which is
 * what "our year in review" means without asking.
 */
export function recapStats(history, year = new Date().getFullYear()) {
  const items = (history.items || []).filter((i) => i.year === year);
  if (items.length === 0) return { year, count: 0 };

  const minutes = items.reduce((n, i) => n + (i.runtime || 0), 0);
  const liked = items.filter((i) => i.verdict === 'up').length;
  const disliked = items.filter((i) => i.verdict === 'down').length;

  const genreTally = new Map();
  const serviceTally = new Map();
  for (const i of items) {
    for (const g of i.genres || []) genreTally.set(g, (genreTally.get(g) || 0) + 1);
    for (const p of i.providers || []) serviceTally.set(p, (serviceTally.get(p) || 0) + 1);
  }

  const topOf = (m) => {
    const e = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return e ? { id: e[0], count: e[1] } : null;
  };

  const busiest = (() => {
    const months = new Map();
    for (const i of items) months.set(i.month, (months.get(i.month) || 0) + 1);
    const e = [...months.entries()].sort((a, b) => b[1] - a[1])[0];
    return e ? { month: e[0], count: e[1] } : null;
  })();

  const topService = topOf(serviceTally);

  return {
    year,
    count: items.length,
    minutes,
    hours: Math.round(minutes / 60),
    liked,
    disliked,
    topGenre: topOf(genreTally),
    topService: topService
      ? { ...topService, label: PLATFORM_LABEL[topService.id] || topService.id }
      : null,
    busiestMonth: busiest,
    longest: items.reduce((a, b) => ((b.runtime || 0) > (a?.runtime || 0) ? b : a), null),
  };
}

/**
 * Provider drift (item 6).
 *
 * §4.3 flagged this from the start and it was only half-handled: titles
 * leave services constantly, so a Together list quietly fills with
 * things you can no longer watch. The refresh job re-verifies providers,
 * but nothing ever told the user when a match went stale.
 *
 * Two separate cases, deliberately reported apart because the user's
 * response to each differs:
 *   gone     -- no longer on ANY service the room has. Actionable now.
 *   unknown  -- provider data hasn't been re-checked in a long time, so
 *               we genuinely don't know. NOT presented as "gone", which
 *               would be a confident claim we can't support.
 */
export function findDrift(titles, roomPlatforms, staleDays = 45) {
  const cutoff = Date.now() - staleDays * 86400_000;
  const gone = [];
  const unknown = [];

  for (const t of titles || []) {
    const providers = t.providers || [];
    const checked = t.providers_updated_at ? new Date(t.providers_updated_at).getTime() : 0;

    const onRoomService = providers.some((p) => (roomPlatforms || []).includes(p));
    if (!onRoomService) {
      if (checked && checked > cutoff) gone.push(t);   // recently verified: we're confident
      else unknown.push(t);                             // stale data: say so honestly
    }
  }
  return { gone, unknown };
}
