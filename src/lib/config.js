// Architecture ref: ARCHITECTURE_v1.0.md §12
//
// Every tunable number in the deck system, in one place. §12 is explicit
// that these are feel-numbers to be tuned by lived usage rather than
// fixed constants -- keeping them here means tuning is one file edit and
// one deploy, which is exactly why §6.5 put the deck build client-side.
//
// The three most likely to move first, per §15:
//   SHARED_SPINE_RATIO -- raise if matches are scarce, lower if the deck
//                          feels generic. One number, one effect.
//   SEEDED_DECK_SIZE   -- length of the shared warm-up before
//                          personalization takes over.
//   W_PARTNER          -- how aggressively the deck chases resolving
//                          Pending into Together/Solo.

export const CONFIG = {
  // ---- Deck shape (§5.1, §5.3) ----
  DECK_SIZE: 150,
  // Deliberately larger than a session's ~40 swipes so §5.3's
  // client-side filter masking has room to work without emptying.
  DECK_CANDIDATE_CAP: 500,
  DECK_CACHE_TTL_MINUTES: 60,
  MIN_FILTERED_DECK: 5,

  // ---- Cold start and divergence (§5.4) ----
  SEEDED_DECK_SIZE: 60,
  SHARED_SPINE_RATIO: 0.30,
  PARTNER_PENDING_CAP: 0.60,

  // ---- Scoring weights (§5.2) ----
  W_PARTNER: 3.0,
  W_GENRE: 1.0,
  W_QUALITY: 0.5,
  W_POP: 0.4,
  W_RECENCY: 0.2,
  JITTER_RANGE: 0.1,

  // ---- Scoring inputs (§5.2) ----
  GENRE_SMOOTHING_ALPHA: 5,
  QUALITY_VOTE_FLOOR: 100,
  RECENCY_DECAY_YEARS: 10,

  // ---- Interaction (§6) ----
  UNDO_WINDOW_SECONDS: 12,
  VERDICT_TOAST_SECONDS: 4,
  MATCH_INDICATOR_MS: 1600,

  // ---- Swipe gesture tuning (update 1) ----
  // The originals here were far too loose in the hand: COMMIT_PX 110 was
  // fine on its own, but it was OR'd with a 0.45 px/ms fling check that
  // only required 30px of travel. A 31px twitch over 60ms is 0.52 px/ms,
  // so any quick tap with a little drift -- scrolling, or just putting a
  // thumb down -- registered as a full vote. On a 390px phone that's 8%
  // of the screen width committing an irreversible swipe.
  //
  // Now: distance scales with the card so it feels the same on any
  // screen, a fling still works but has to actually travel, and there's
  // a dead zone plus a direction lock so the card doesn't even begin to
  // follow a finger until the gesture is clearly a horizontal drag.
  SWIPE_COMMIT_RATIO: 0.30,       // of card width; the primary threshold
  SWIPE_COMMIT_MIN_PX: 115,       // floor, for very narrow screens
  SWIPE_FLING_VELOCITY: 0.95,     // px/ms -- roughly double the old value
  SWIPE_FLING_MIN_PX: 90,         // a fling must still cover real ground
  SWIPE_DEAD_ZONE_PX: 16,         // card doesn't move at all below this
  SWIPE_DIRECTION_LOCK: 1.25,     // |dx| must beat |dy| by this to count
  SWIPE_VERTICAL_ABORT_PX: 55,    // clearly a scroll -> cancel the swipe
};

// §1: the four platforms, and the canonical genre vocabulary from
// component 4's `genres` table. Duplicated here as display metadata
// only -- the database remains the source of truth for what a canonical
// genre id MEANS; this is just how we label it in the UI.
export const PLATFORMS = [
  { slug: 'netflix', label: 'Netflix' },
  { slug: 'prime', label: 'Prime Video' },
  { slug: 'disney', label: 'Disney+' },
  { slug: 'hulu', label: 'Hulu' },
];

export const GENRES = [
  { id: 1, label: 'Action' },
  { id: 2, label: 'Comedy' },
  { id: 3, label: 'Drama' },
  { id: 4, label: 'Horror' },
  { id: 5, label: 'Sci-Fi & Fantasy' },
  { id: 6, label: 'Thriller' },
  { id: 7, label: 'Documentary' },
  { id: 8, label: 'Animation' },
  { id: 9, label: 'Romance' },
  { id: 10, label: 'Crime & Mystery' },
  { id: 11, label: 'Family' },
  { id: 12, label: 'Other' },
];

// §4.2: posters come straight from TMDB's public image CDN, which needs
// no API key. This is the only TMDB endpoint the client ever touches.
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
export function posterUrl(path, size = 'w500') {
  return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}
