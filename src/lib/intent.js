import { EMPTY_FILTERS } from './filters.js';

// Session intent.
//
// The recommender modelled a stable taste profile and had no concept of
// tonight, so it served the same deck at 9am Saturday and 11:30pm
// Tuesday. Three queue items (time-aware deck, saved presets, mood
// clusters) were three different input mechanisms aimed at that one gap.
// This is the single concept underneath them.
//
// An intent is just a named filter set plus an optional scoring nudge.
// That is deliberate: it means intent composes with the existing filter
// system instead of becoming a second, parallel way to narrow the deck.
// A second mechanism would have been the actual mistake here.

/**
 * Built-in intents. These live in code rather than the database because
 * they are logic, not user data. Saved custom presets are the data half
 * and live on `users.session_presets`.
 *
 * `derive` returns a partial filter object merged over EMPTY_FILTERS, so
 * an intent can only ever narrow, never widen unexpectedly.
 */
export const INTENTS = [
  {
    id: 'quick',
    label: 'Quick one',
    blurb: 'Under 90 minutes, nothing that needs commitment.',
    derive: () => ({ mediaType: 'movie', maxRuntime: 90 }),
  },
  {
    id: 'film',
    label: 'Proper film',
    blurb: 'A real one. Well rated, feature length.',
    derive: () => ({ mediaType: 'movie', minRating: 7 }),
  },
  {
    id: 'series',
    label: 'Start a series',
    blurb: 'Something to live in for a few weeks.',
    derive: () => ({ mediaType: 'tv' }),
  },
  {
    id: 'short-series',
    label: 'Short series',
    blurb: 'A season you can actually finish.',
    // maxCommitmentHours is intent-only; applyFilters ignores unknown
    // keys, and the deck applies it via filterByIntent below.
    derive: () => ({ mediaType: 'tv', maxCommitmentHours: 12 }),
  },
  {
    id: 'comfort',
    label: 'Comfort',
    blurb: 'Familiar shapes. Nothing demanding.',
    derive: () => ({ genres: [2, 9, 11] }), // Comedy, Romance, Family
  },
  {
    id: 'switch-off',
    label: 'Switch off',
    blurb: 'Loud, fun, no subtitles.',
    derive: () => ({ genres: [1, 5], language: 'en' }), // Action, Sci-Fi & Fantasy
  },
  {
    id: 'new',
    label: "What's new",
    blurb: 'Recent arrivals only.',
    derive: () => ({ newOnly: true }),
  },
];

/**
 * Time-of-day default.
 *
 * This is the "time-aware deck" item, and it is deliberately a
 * SUGGESTION rather than an automatic filter. Silently narrowing
 * someone's deck because of the clock is the kind of helpfulness that
 * reads as a bug: you would have no way to tell whether the app was
 * being clever or broken. So it pre-selects, visibly, and you can
 * ignore it.
 *
 * Returns an intent id or null.
 */
export function suggestedIntent(now = new Date()) {
  const h = now.getHours();
  const weekend = now.getDay() === 0 || now.getDay() === 6;

  if (h >= 22 || h < 2) return 'quick';        // late: nobody is starting a 3-hour epic
  if (h >= 20) return weekend ? 'film' : 'quick';
  if (h >= 17) return 'series';                 // early evening: settling in
  if (weekend && h >= 10) return 'film';
  return null;                                  // no opinion, do not pretend to have one
}

/** Look up an intent by id, including user-saved presets. */
export function findIntent(id, savedPresets = []) {
  return (
    INTENTS.find((i) => i.id === id) ||
    savedPresets.find((p) => p.id === id) ||
    null
  );
}

/**
 * Turn an intent into a filter object.
 * Saved presets carry their filters literally; built-ins compute them.
 */
export function intentFilters(intent) {
  if (!intent) return EMPTY_FILTERS;
  const partial = typeof intent.derive === 'function' ? intent.derive() : (intent.filters || {});
  return { ...EMPTY_FILTERS, ...partial };
}

/**
 * The one filter dimension that needs title data rather than a plain
 * field comparison: total commitment for a series.
 *
 * Kept out of applyFilters on purpose. applyFilters is a pure predicate
 * over a title row; this needs the lifecycle module's derivation, and
 * wiring that dependency into the filter layer would tangle two things
 * that are currently independent.
 */
export function filterByCommitment(cards, maxHours, commitmentHoursFn) {
  if (!maxHours) return cards;
  return cards.filter((t) => {
    if (t.media_type !== 'tv') return true; // a film has no commitment problem
    const hrs = commitmentHoursFn(t);
    // Unknown commitment is KEPT, matching how unknown runtime is
    // handled elsewhere: missing data is not evidence of a long show,
    // and hiding everything unmeasured would gut the TV side.
    if (hrs === null) return true;
    return hrs <= maxHours;
  });
}

/**
 * Build a saved preset from the current filter state.
 * Ids are prefixed so a preset can never collide with a built-in.
 */
export function makePreset(label, filters) {
  return {
    id: `saved:${Date.now().toString(36)}`,
    label: (label || 'Saved').slice(0, 32),
    blurb: 'Your preset.',
    filters,
  };
}
