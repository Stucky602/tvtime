// Architecture ref: ARCHITECTURE_v1.0.md §5.1 (stage 2), §6, §6.5
//
// Everything between Supabase and the deck builder. Two responsibilities
// that don't belong in the pure scoring code:
//
//   1. Fetching the candidate set and building/caching the deck.
//   2. The swipe write path -- optimistic, idempotent, and offline-safe.

import { supabase, rpc } from './supabase.js';
import { CONFIG } from './config.js';
import { buildDeck } from './deck.js';

const QUEUE_KEY = 'tvtime.swipeQueue.v1';
const DECK_KEY = 'tvtime.deck.v1';

// ---------------------------------------------------------------------
// Candidate fetch (§5.1 stage 2, §6.5)
// ---------------------------------------------------------------------

/**
 * Reads `titles`, `swipes`, and `watched` only -- no network beyond
 * Supabase, no TMDB. §5.1: deck build is a local scoring pass over a
 * server-capped candidate set, which is why it's sub-second.
 *
 * Selects only the columns a card actually needs. `titles` has a
 * synopsis on every row and the candidate cap is 500, so `select *`
 * would pull a lot of text nobody reads until they tap a card.
 */
export async function fetchDeckInputs({ userId, platforms, includeReality }) {
  const [{ data: swipes, error: swipeErr }, { data: watched, error: watchedErr }] =
    await Promise.all([
      supabase.from('swipes').select('user_id,tmdb_id,media_type,direction,voted_at'),
      supabase.from('watched').select('tmdb_id,media_type'),
    ]);
  if (swipeErr) throw swipeErr;
  if (watchedErr) throw watchedErr;

  const ownVoted = new Set(
    (swipes || [])
      .filter((s) => s.user_id === userId)
      .map((s) => `${s.tmdb_id}:${s.media_type}`)
  );
  const watchedKeys = new Set((watched || []).map((w) => `${w.tmdb_id}:${w.media_type}`));

  let query = supabase
    .from('titles')
    .select(
      'tmdb_id,media_type,title,year,runtime,synopsis,poster_path,rating,vote_count,popularity,genres,providers,is_reality,original_language'
    )
    .eq('excluded', false)
    .order('popularity', { ascending: false })
    .limit(CONFIG.DECK_CANDIDATE_CAP);

  // §5.1: a room's pool is `titles` filtered by provider overlap. There
  // is deliberately no per-room pool table.
  if (platforms?.length) {
    query = query.overlaps('providers', platforms);
  }
  // §4.4's per-room reality toggle, enforced here rather than globally
  // (that's why component 7 flags is_reality instead of setting
  // `excluded` on reality titles).
  if (!includeReality) {
    query = query.eq('is_reality', false);
  }

  const { data: titles, error: titleErr } = await query;
  if (titleErr) throw titleErr;

  const candidates = (titles || []).filter((t) => {
    const k = `${t.tmdb_id}:${t.media_type}`;
    return !ownVoted.has(k) && !watchedKeys.has(k);
  });

  // Genre affinity needs the titles behind past swipes to attribute
  // them, but those are excluded from `candidates` by definition
  // (they've been voted on). Fetch them separately, capped -- affinity
  // converges long before a user has 400 swipes, so there's no value in
  // pulling an unbounded history.
  const votedKeys = [...ownVoted].slice(0, 400);
  let historyTitles = [];
  if (votedKeys.length > 0) {
    const ids = [...new Set(votedKeys.map((k) => Number(k.split(':')[0])))];
    const { data: hist } = await supabase
      .from('titles')
      .select('tmdb_id,media_type,genres')
      .in('tmdb_id', ids);
    historyTitles = hist || [];
  }

  return { candidates, allSwipes: swipes || [], historyTitles };
}

// ---------------------------------------------------------------------
// Deck caching (§5.1)
// ---------------------------------------------------------------------

/**
 * §5.1: "Cache the built deck in sessionStorage keyed by a build
 * timestamp. A mid-session reload should resume where you were, not
 * reshuffle."
 *
 * sessionStorage rather than localStorage on purpose -- the deck should
 * survive a reload but not a fresh session, since §5.1 also says the
 * deck rebuilds on app load.
 */
export function loadCachedDeck(roomId, userId) {
  try {
    const raw = sessionStorage.getItem(DECK_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (cached.roomId !== roomId || cached.userId !== userId) return null;
    const ageMinutes = (Date.now() - cached.builtAt) / 60000;
    if (ageMinutes > CONFIG.DECK_CACHE_TTL_MINUTES) return null;
    return cached;
  } catch {
    return null;
  }
}

export function saveCachedDeck(roomId, userId, deck, position) {
  try {
    sessionStorage.setItem(
      DECK_KEY,
      JSON.stringify({
        roomId,
        userId,
        builtAt: Date.now(),
        phase: deck.phase,
        cards: deck.cards,
        position,
        debug: deck.debugByKey ? Object.fromEntries(deck.debugByKey) : {},
      })
    );
  } catch {
    // Quota errors are not worth breaking a session over -- worst case
    // the deck rebuilds on reload, which is the pre-cache behavior.
  }
}

// ---------------------------------------------------------------------
// Swiped-key tracking
// ---------------------------------------------------------------------
//
// Fixes: leaving the Swipe tab and coming back restarted the deck from
// the first card, so you re-swiped titles you'd already voted on.
//
// The cause was that the deck's position lived in SwipeDeck's local
// component state. App.jsx renders the swipe screen conditionally
// (`{tab === 'swipe' && <SwipeScreen/>}`), so switching tabs unmounts
// the whole subtree and destroys that state; coming back remounted at
// index 0 with the same cached cards.
//
// Persisting an index would have worked but is brittle -- it means
// something different the moment filters change the visible list.
// Recording WHICH titles have been swiped is stable under any
// reordering or filtering, and it also covers the case where a swipe
// is still sitting in the offline queue and therefore isn't excluded
// by the server-side query yet.
//
// sessionStorage, matching the deck cache: this is position within the
// current deck, and a fresh session rebuilds from the database anyway.
const SWIPED_KEY = 'flixpix.swiped.v1';

export function loadSwipedKeys(roomId, userId) {
  try {
    const raw = sessionStorage.getItem(SWIPED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (parsed.roomId !== roomId || parsed.userId !== userId) return new Set();
    return new Set(parsed.keys || []);
  } catch {
    return new Set();
  }
}

function persistSwipedKeys(roomId, userId, set) {
  try {
    sessionStorage.setItem(
      SWIPED_KEY,
      JSON.stringify({ roomId, userId, keys: [...set] })
    );
  } catch {
    /* quota: worst case the deck restarts, i.e. the old behaviour */
  }
}

export function addSwipedKey(roomId, userId, key) {
  const set = loadSwipedKeys(roomId, userId);
  set.add(key);
  persistSwipedKeys(roomId, userId, set);
}

export function removeSwipedKey(roomId, userId, key) {
  const set = loadSwipedKeys(roomId, userId);
  set.delete(key);
  persistSwipedKeys(roomId, userId, set);
}

export function clearSwipedKeys() {
  try {
    sessionStorage.removeItem(SWIPED_KEY);
  } catch {
    /* no-op */
  }
}

export function clearCachedDeck() {
  try {
    sessionStorage.removeItem(DECK_KEY);
    // Must go together: a fresh deck filtered by a stale swiped-list
    // would silently hide titles it just legitimately fetched.
    sessionStorage.removeItem(SWIPED_KEY);
  } catch {
    /* no-op */
  }
}

// §5.4 seed-exit support. The seed set a user was first served is frozen
// here so graduation can be tested exactly against it. localStorage, not
// sessionStorage: the seed spans multiple sessions (it's "one to two
// sessions of shared warm-up"), so it must outlive a single session the
// way the deck cache does not.
const SEED_KEY = 'tvtime.seedSet.v1';

export function loadSeedSet(roomId, userId) {
  try {
    const raw = localStorage.getItem(SEED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.roomId !== roomId || parsed.userId !== userId) return null;
    return parsed.keys;
  } catch {
    return null;
  }
}

export function persistSeedSet(roomId, userId, keys) {
  try {
    localStorage.setItem(SEED_KEY, JSON.stringify({ roomId, userId, keys }));
  } catch {
    /* no-op: worst case the user gets a slightly longer seed phase */
  }
}

/** Full stage-2 build: fetch inputs, score, assemble, cache. */
export async function buildAndCacheDeck({ room, user, partner }) {
  const { candidates, allSwipes, historyTitles } = await fetchDeckInputs({
    userId: user.id,
    platforms: room.platforms,
    includeReality: room.include_reality,
  });

  // §5.4 per-user seed exit: "you graduate when you have swiped through
  // your seeded cards." The exact check needs the specific seed set the
  // user was first served, frozen at that moment -- not recomputed,
  // because selectSeedTitles is defined over the CURRENT candidate pool,
  // which shrinks as titles are voted on, so a fresh call returns a
  // different set than what was originally shown.
  //
  // So: the first time this user gets a SEED-phase deck, we persist its
  // title keys (persistSeedSet, below). Graduation is then exact -- the
  // user has finished when every persisted seed key is in their voted
  // set. A user who swipes non-seed cards first no longer graduates
  // early, because those swipes don't touch the persisted seed keys.
  //
  // No persisted set yet means this is the user's first-ever build, so
  // they're mid-seed by definition (unless they have no partner, in
  // which case there is no seed at all).
  let hasFinishedSeed = true;
  if (partner) {
    const ownVoted = new Set(
      allSwipes.filter((s) => s.user_id === user.id).map((s) => `${s.tmdb_id}:${s.media_type}`)
    );
    const persistedSeed = loadSeedSet(room.id, user.id);
    if (persistedSeed) {
      hasFinishedSeed = persistedSeed.every((k) => ownVoted.has(k));
    } else {
      // First build for this user: they haven't been served (or
      // finished) a seed yet. buildDeck will produce the SEED phase and
      // we persist its set below.
      hasFinishedSeed = false;
    }
  }

  const deck = buildDeck({
    candidates,
    allSwipes,
    user,
    partner,
    roomId: room.id,
    historyTitles,
    hasFinishedSeed,
  });

  // Freeze the seed set the first time we actually serve one, so future
  // builds test graduation against this exact set.
  if (deck.phase === 'seed' && deck.seedKeys && !loadSeedSet(room.id, user.id)) {
    persistSeedSet(room.id, user.id, [...deck.seedKeys]);
  }

  saveCachedDeck(room.id, user.id, deck, 0);
  return deck;
}

// ---------------------------------------------------------------------
// Swipe write path (§6)
// ---------------------------------------------------------------------

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* no-op */
  }
}

/**
 * §6: "Swipes buffer in localStorage on write failure and flush on
 * reconnect. Two people on phones will hit dead zones. Without this,
 * swipes vanish silently and Pending lies."
 *
 * localStorage rather than sessionStorage here, deliberately and
 * unlike the deck cache -- a queued swipe must survive the app being
 * closed, which is exactly when a dead-zone swipe would otherwise be
 * lost for good.
 */
export function enqueueSwipe(entry) {
  const queue = readQueue();
  // Idempotency at the queue level too: re-queueing the same title
  // replaces rather than duplicates, matching the RPC's upsert.
  const idx = queue.findIndex(
    (q) => q.tmdb_id === entry.tmdb_id && q.media_type === entry.media_type
  );
  if (idx >= 0) queue[idx] = entry;
  else queue.push(entry);
  writeQueue(queue);
}

export async function flushSwipeQueue() {
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0 };

  const stillQueued = [];
  let flushed = 0;

  for (const entry of queue) {
    try {
      await rpc('submit_swipe', {
        p_tmdb_id: entry.tmdb_id,
        p_media_type: entry.media_type,
        p_direction: entry.direction,
        p_score_debug: entry.score_debug ?? null,
      });
      flushed++;
    } catch {
      stillQueued.push(entry);
    }
  }

  writeQueue(stillQueued);
  return { flushed, remaining: stillQueued.length };
}

export function queuedSwipeCount() {
  return readQueue().length;
}

/**
 * §6: one round trip. The write and the match check happen together so
 * the transient match indicator can render before the next card
 * animates in.
 *
 * On failure the swipe is queued rather than surfaced as an error --
 * §6 is explicit that the card should animate out regardless, because
 * reversing a completed animation "feels broken".
 */
export async function submitSwipe({ tmdb_id, media_type, direction, score_debug }) {
  try {
    const result = await rpc('submit_swipe', {
      p_tmdb_id: tmdb_id,
      p_media_type: media_type,
      p_direction: direction,
      p_score_debug: score_debug ?? null,
    });
    return { ok: true, ...result };
  } catch {
    enqueueSwipe({ tmdb_id, media_type, direction, score_debug });
    return { ok: false, queued: true, bucket: null, is_new_match: false };
  }
}

export async function undoSwipe({ tmdb_id, media_type }) {
  // Drop it from the queue too -- undoing a swipe that never reached the
  // server should not later flush and resurrect itself.
  const queue = readQueue().filter(
    (q) => !(q.tmdb_id === tmdb_id && q.media_type === media_type)
  );
  writeQueue(queue);

  try {
    return await rpc('undo_swipe', { p_tmdb_id: tmdb_id, p_media_type: media_type });
  } catch {
    return { status: 'EXPIRED' };
  }
}
