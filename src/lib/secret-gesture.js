// The secret gesture.
//
// A per-person unlock that never leaves the device. You record a tap
// sequence once; performing it on any card opens the secret vote.
//
// WHY A TAP-ZONE SEQUENCE rather than a rhythm or a drawn shape:
//
//   - It cannot fire by accident. Four deliberate taps in specific
//     regions is not something a thumb does while scrolling.
//   - It does not collide with anything. The card's existing gestures
//     are horizontal drag (vote), vertical drag (scroll), and taps on
//     two explicit buttons. A plain tap on the poster currently does
//     nothing at all, so this claims unused space.
//   - It is reproducible. A knock rhythm is more charming and much
//     worse in practice: timing tolerance either rejects you when you
//     are slightly off, or is so loose it stops being secret.
//   - It is genuinely per-person. A 4-tap sequence over 9 zones is
//     6,561 combinations, and yours is stored only on your phone.
//
// Nothing about the gesture is ever sent to the server. The only thing
// that travels is the vote it produces, which is the point: the channel
// is private, the message is shared.

const STORE_KEY = 'flixpix.secret.v1';

export const GRID = 3; // 3x3 zones over the poster
export const MIN_TAPS = 4;
export const MAX_TAPS = 8;

/**
 * Which of the 9 zones a point falls in, 0-8, reading left to right and
 * top to bottom. Coordinates are relative to the element's box.
 */
export function zoneFor(x, y, width, height) {
  if (!width || !height) return null;
  const col = Math.min(GRID - 1, Math.max(0, Math.floor((x / width) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor((y / height) * GRID)));
  return row * GRID + col;
}

/** Two sequences match only if they are identical. No fuzziness. */
export function sequencesMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length || a.length < MIN_TAPS) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Is a candidate sequence usable as a secret?
 *
 * Rejects sequences that are all the same zone. Tapping one corner four
 * times is the first thing anyone tries, which makes it the one
 * sequence a curious partner would stumble into.
 */
export function isValidSequence(seq) {
  if (!Array.isArray(seq)) return false;
  if (seq.length < MIN_TAPS || seq.length > MAX_TAPS) return false;
  if (seq.some((z) => !Number.isInteger(z) || z < 0 || z > 8)) return false;
  if (new Set(seq).size < 2) return false;
  return true;
}

/**
 * Taps decay. Without this, three taps now and one tap a minute later
 * would count as a sequence, so any four taps over a long session would
 * eventually collide with somebody's secret.
 */
export const TAP_WINDOW_MS = 2600;

export function pruneTaps(taps, now = Date.now(), windowMs = TAP_WINDOW_MS) {
  return (taps || []).filter((t) => now - t.at <= windowMs);
}

// ---------------------------------------------------------------------
// Local storage. Deliberately the only persistence this feature has.
// ---------------------------------------------------------------------

export function loadSecret() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidSequence(parsed?.sequence) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSecret(sequence) {
  if (!isValidSequence(sequence)) return false;
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ sequence, setAt: new Date().toISOString() })
    );
    return true;
  } catch {
    return false;
  }
}

export function forgetSecret() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Has this person set up the secret at all? Drives whether tabs show. */
export function hasSecret() {
  return loadSecret() !== null;
}
