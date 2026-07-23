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
  UNDO_WINDOW_SECONDS: 5,
  VERDICT_TOAST_SECONDS: 4,
  MATCH_INDICATOR_MS: 1600,
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
