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
      f.newOnly
  );
}
