// Filter shape and helpers.
//
// These live in lib rather than alongside FilterPanel because both the
// panel and the swipe screen need them, and exporting non-components
// from a component file breaks React Fast Refresh.

export const EMPTY_FILTERS = {
  mediaType: null,   // null | 'movie' | 'tv'
  genres: [],        // canonical genre ids
  decades: [],       // e.g. [1990, 2020]
  anime: null,       // null | 'only' | 'hide'
  maxRuntime: null,  // minutes
  minRating: null,   // 6 | 7 | 8
  services: [],      // platform slugs
  language: null,    // null | 'en' | 'foreign'
  newOnly: false,    // last 2 years

  // ---- Exclusions (feature 4) ----
  // Inclusion and exclusion are genuinely different intents: "show me
  // comedies" is not the inverse of "never show me horror", and a user
  // wanting the second had no way to express it. These apply AFTER the
  // inclusive filters and always win a conflict -- an explicit "never"
  // should not be overridden by a broad "show me".
  excludeGenres: [],  // canonical genre ids to never show
  maxRating: null,    // hide anything rated ABOVE this (a ceiling, e.g. avoid 8+ prestige marathons)
  blocklist: [],      // `tmdb_id:media_type` keys the user never wants to see
};

/** Is anything actually filtering? Drives the dot on the Filters button. */
export function hasActiveFilters(f) {
  if (!f) return false;
  return Boolean(
    f.mediaType ||
      f.genres?.length ||
      f.decades?.length ||
      f.anime ||
      f.maxRuntime ||
      f.minRating ||
      f.services?.length ||
      f.language ||
      f.newOnly ||
      f.excludeGenres?.length ||
      f.maxRating ||
      f.blocklist?.length
  );
}
