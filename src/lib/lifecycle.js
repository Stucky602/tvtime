// Watch lifecycle.
//
// The app modelled deciding and barely modelled watching: `watched` was
// one boolean plus an optional thumb. Five separate queue items
// (currently-watching, inferred watched, memory lane, taste drift, cost
// per match) were each trying to reconstruct a timeline that had never
// been stored. This is that timeline.
//
// Three statuses, no more. 'planned' is deliberately absent because a
// title you both said yes to is already planned and already lives in
// Together; adding a status for it would duplicate state the vote views
// derive correctly.
//
// Pure functions over rows the app already fetches.

export const STATUS = {
  WATCHING: 'watching',
  FINISHED: 'finished',
  ABANDONED: 'abandoned',
};

export const STATUS_LABEL = {
  watching: 'Watching',
  finished: 'Finished',
  abandoned: 'Gave up',
};

const key = (t) => `${t.tmdb_id}:${t.media_type}`;

/**
 * Index watch rows by title key for O(1) lookup while rendering lists.
 */
export function indexWatchRows(rows) {
  return new Map((rows || []).map((w) => [`${w.tmdb_id}:${w.media_type}`, w]));
}

/**
 * Split a bucket's titles by lifecycle state.
 *
 * `untouched` is the important one: those are things you agreed on and
 * then never started, which is the actual backlog. Previously they were
 * indistinguishable from things you had finished months ago.
 */
export function partitionByStatus(titles, watchIndex) {
  const out = { untouched: [], watching: [], finished: [], abandoned: [] };
  for (const t of titles || []) {
    const w = watchIndex.get(key(t));
    if (!w) out.untouched.push(t);
    else if (w.status === STATUS.WATCHING) out.watching.push({ ...t, watch: w });
    else if (w.status === STATUS.ABANDONED) out.abandoned.push({ ...t, watch: w });
    else out.finished.push({ ...t, watch: w });
  }
  return out;
}

/**
 * Titles worth asking about: started but not resolved, and stale.
 *
 * This is "inferred watched" from the queue, done honestly. The app
 * cannot know you finished something, and guessing would corrupt the
 * record it is supposed to be keeping. So it asks instead, and only
 * once a series has plausibly had time to end.
 *
 * The threshold is deliberately generous. Nagging someone about a show
 * they started nine days ago is how a prompt gets learned into
 * furniture and then ignored forever.
 */
export function staleWatching(watchRows, days = 21) {
  const cutoff = Date.now() - days * 86400_000;
  return (watchRows || []).filter((w) => {
    if (w.status !== STATUS.WATCHING) return false;
    const started = w.started_on ? new Date(w.started_on).getTime() : null;
    const touched = started ?? (w.marked_at ? new Date(w.marked_at).getTime() : null);
    return touched !== null && touched < cutoff;
  });
}

/**
 * Estimated hours to finish a series, for the commitment signal.
 *
 * Returns null rather than a guess when the data is missing. A wrong
 * number here is worse than no number: someone deciding whether to start
 * a 200-episode show needs the truth or nothing.
 */
export function commitmentHours(title) {
  if (title?.media_type !== 'tv') return null;
  const eps = title.episode_count;
  const runtime = title.runtime;
  if (!eps || !runtime) return null;
  return Math.round((eps * runtime) / 60);
}

/**
 * Human-readable commitment, e.g. "3 seasons · 24 eps · ~18 hrs".
 * Degrades gracefully as fields go missing rather than printing "0".
 */
export function commitmentLabel(title) {
  if (title?.media_type !== 'tv') return null;
  const parts = [];
  if (title.season_count) {
    parts.push(`${title.season_count} season${title.season_count === 1 ? '' : 's'}`);
  }
  if (title.episode_count) {
    parts.push(`${title.episode_count} ep${title.episode_count === 1 ? '' : 's'}`);
  }
  const hrs = commitmentHours(title);
  if (hrs) parts.push(`~${hrs} hr${hrs === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Rough commitment tier, for filtering and for colouring the badge.
 * Thresholds are in hours of total watch time, not episode count,
 * because 200 episodes of a 22-minute show is a smaller ask than 30
 * episodes of a 70-minute one.
 */
export function commitmentTier(title) {
  const hrs = commitmentHours(title);
  if (hrs === null) return null;
  if (hrs <= 6) return 'short';    // a weekend
  if (hrs <= 20) return 'medium';  // a few weeks
  return 'long';                    // a project
}

/**
 * "A year ago tonight" — memory lane, from the queue.
 *
 * Matches on month and day across previous years. Returns finished
 * watches only: reminding someone of a thing they abandoned is not a
 * fond memory.
 */
export function onThisDay(watchRows, titlesByKey, today = new Date()) {
  const m = today.getMonth();
  const d = today.getDate();
  const thisYear = today.getFullYear();

  return (watchRows || [])
    .filter((w) => w.status === STATUS.FINISHED)
    .map((w) => {
      const when = w.watched_on || w.marked_at;
      if (!when) return null;
      const date = new Date(when);
      if (Number.isNaN(date.getTime())) return null;
      if (date.getMonth() !== m || date.getDate() !== d) return null;
      if (date.getFullYear() >= thisYear) return null; // not "a year ago" if it is today
      const t = titlesByKey.get(`${w.tmdb_id}:${w.media_type}`);
      if (!t) return null;
      return { ...t, watch: w, when: date, yearsAgo: thisYear - date.getFullYear() };
    })
    .filter(Boolean)
    .sort((a, b) => a.yearsAgo - b.yearsAgo);
}

/**
 * Taste drift: how the genre mix of what you FINISH changes over time.
 *
 * Deliberately computed from finished watches rather than swipes. Swipes
 * measure what looks appealing on a poster; finishing something measures
 * what you actually wanted. Those diverge, and the second is the more
 * interesting number.
 */
export function tasteDrift(watchRows, titlesByKey, bucketMonths = 6) {
  const finished = (watchRows || [])
    .filter((w) => w.status === STATUS.FINISHED)
    .map((w) => {
      const when = w.watched_on || w.marked_at;
      const t = titlesByKey.get(`${w.tmdb_id}:${w.media_type}`);
      if (!when || !t) return null;
      const date = new Date(when);
      return Number.isNaN(date.getTime()) ? null : { date, genres: t.genres || [] };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  if (finished.length < 6) return null; // too little to say anything honest

  const first = finished[0].date;
  const buckets = new Map();
  for (const f of finished) {
    const months = (f.date.getFullYear() - first.getFullYear()) * 12
      + (f.date.getMonth() - first.getMonth());
    const b = Math.floor(months / bucketMonths);
    if (!buckets.has(b)) buckets.set(b, { count: 0, genres: new Map(), from: f.date });
    const bucket = buckets.get(b);
    bucket.count++;
    bucket.to = f.date;
    for (const g of f.genres) bucket.genres.set(g, (bucket.genres.get(g) || 0) + 1);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({
      from: b.from,
      to: b.to ?? b.from,
      count: b.count,
      top: [...b.genres.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([id, n]) => ({ id, n })),
    }));
}
