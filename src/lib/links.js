import { PLATFORMS } from './config.js';

// Feature 4: getting from a match to actually watching the thing.
//
// AN HONEST NOTE ON WHY THIS ISN'T "REAL" DEEP LINKING.
//
// TMDB does not hand out per-service deep links. What it gives you
// (watch/providers.results.US.link, stored as titles.watch_link) is a
// JustWatch page. Constructing true native deep links -- nflx://,
// hbomax://, etc. -- requires each service's internal content ID, which
// TMDB doesn't expose, and the URL schemes differ per OS and break
// without warning when apps update.
//
// So this uses two reliable mechanisms instead, in order:
//
//   1. A per-service SEARCH url on the service's own web domain. On
//      iOS and Android these are universal links: if the app is
//      installed, the OS opens the app rather than the browser. You
//      land on a search result for the title rather than the title
//      itself -- one extra tap, but it never breaks.
//
//   2. The TMDB/JustWatch link as a fallback, which lists every way to
//      watch it. Used when we have no search template for a service.
//
// This trades a tap for reliability, deliberately. A deep link that
// works for six months and then silently dead-ends is worse than a
// search link that always works.

const SEARCH_URLS = {
  netflix: (q) => `https://www.netflix.com/search?q=${q}`,
  prime: (q) => `https://www.amazon.com/s?k=${q}&i=instant-video`,
  disney: (q) => `https://www.disneyplus.com/search?q=${q}`,
  hulu: (q) => `https://www.hulu.com/search?q=${q}`,
  max: (q) => `https://play.max.com/search?q=${q}`,
  appletv: (q) => `https://tv.apple.com/search?term=${q}`,
  peacock: (q) => `https://www.peacocktv.com/search?q=${q}`,
  paramount: (q) => `https://www.paramountplus.com/search/?query=${q}`,
};

const LABELS = Object.fromEntries(PLATFORMS.map((p) => [p.slug, p.label]));

/**
 * Where to send someone for a given title.
 *
 * @param {object} title      row from `titles` (needs providers, title, watch_link)
 * @param {string[]} roomPlatforms  the room's services, so we prefer one they have
 * @returns {{url: string, label: string, kind: 'service'|'justwatch'}|null}
 */
export function watchTarget(title, roomPlatforms = []) {
  const providers = title?.providers || [];

  // Prefer a service the room actually subscribes to -- sending someone
  // to a service they don't pay for is worse than useless.
  const preferred =
    providers.find((p) => roomPlatforms.includes(p) && SEARCH_URLS[p]) ||
    providers.find((p) => SEARCH_URLS[p]);

  if (preferred) {
    const q = encodeURIComponent(title.title || '');
    return {
      url: SEARCH_URLS[preferred](q),
      label: `Open ${LABELS[preferred] || preferred}`,
      kind: 'service',
    };
  }

  if (title?.watch_link) {
    return { url: title.watch_link, label: 'Where to watch', kind: 'justwatch' };
  }

  return null;
}

/** YouTube embed URL for a trailer key, or null. */
export function trailerEmbedUrl(key) {
  if (!key) return null;
  // `playsinline=1` matters on iOS: without it, tapping play hijacks the
  // whole screen into the native fullscreen player and leaves the card.
  return `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&playsinline=1&rel=0`;
}
