// Update 1 + 6: the swipe gesture decision logic, as pure functions.
//
// This lives outside the React component on purpose. Both gesture bugs
// so far ("barely touching votes", then "scrolling vertically votes")
// were logic errors of a few lines each, and neither was testable while
// buried in pointer event handlers. Now the decisions are pure functions
// and gesture.test.mjs runs both reported scenarios against them.
//
// ---------------------------------------------------------------------
// THE MODEL: lock the axis once, then honour it absolutely
// ---------------------------------------------------------------------
// A touch goes through exactly three states:
//
//   1. UNDECIDED -- finger is down but has travelled less than
//      SWIPE_AXIS_LOCK_PX. The card does not move. Nothing can vote.
//
//   2. AXIS LOCKED -- at SWIPE_AXIS_LOCK_PX of total travel we decide,
//      ONCE, whether this is a horizontal or a vertical gesture. That
//      decision is permanent for the life of the touch.
//
//        'y' -> the card is inert for the rest of this touch. It will
//               not move, tilt, or vote, no matter what happens next.
//        'x' -> a swipe, once it also clears the dead zone.
//
//   3. DRAGGING -- horizontal, past the dead zone, card follows the
//      finger.
//
// The previous version re-evaluated direction on every move while
// undecided, which is what caused the vertical-scroll bug: a gesture
// that was clearly vertical could later drift far enough horizontally
// to flip into 'dragging', with no path back. Deciding once and never
// revisiting removes that whole class of failure.
//
// A 45-degree diagonal deliberately locks VERTICAL. When intent is
// ambiguous the safe default is "don't cast an irreversible vote."

import { CONFIG } from './config.js';

/**
 * The distance a card must travel to commit, scaled to the card so the
 * gesture feels identical on a small phone and a tablet. A fixed pixel
 * threshold is proportionally twice as strict on a 720px tablet as on a
 * 360px phone.
 */
export function commitDistance(cardWidth) {
  const width = cardWidth || 360;
  return Math.max(CONFIG.SWIPE_COMMIT_MIN_PX, width * CONFIG.SWIPE_COMMIT_RATIO);
}

/**
 * Decide the gesture's axis, once. Returns:
 *
 *   null -- not enough travel yet to tell; stay undecided, card inert
 *   'x'  -- horizontal gesture, may become a swipe
 *   'y'  -- vertical gesture, inert for the rest of this touch
 *
 * Call this ONLY while the axis is still null, then store the result for
 * the life of the pointer. Re-deriving it on later moves is exactly what
 * caused the vertical-scroll bug.
 */
export function lockAxis(dx, dy) {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (Math.hypot(dx, dy) < CONFIG.SWIPE_AXIS_LOCK_PX) return null;

  // Horizontal has to clearly win, not merely tie. Anything ambiguous
  // (including a straight 45-degree diagonal) is treated as vertical.
  return absDx > absDy * CONFIG.SWIPE_DIRECTION_LOCK ? 'x' : 'y';
}

/**
 * Given an already-locked axis, is the card being dragged yet?
 *
 *   'inert'    -- vertical axis; this touch can never move or vote
 *   'pending'  -- horizontal but still inside the dead zone
 *   'dragging' -- horizontal and past the dead zone
 */
export function dragState(axis, dx) {
  if (axis === 'y') return 'inert';
  if (axis !== 'x') return 'pending';
  return Math.abs(dx) >= CONFIG.SWIPE_DEAD_ZONE_PX ? 'dragging' : 'pending';
}

/**
 * On release: does this gesture commit a vote?
 *
 * `velocity` is px/ms measured over a trailing window (~80ms), NOT over
 * the whole gesture. Whole-gesture velocity was part of the original
 * bug: with a 1ms floor on elapsed time, a 31px twitch scored high
 * enough to clear the old 0.45 threshold on its own.
 *
 * A fling still commits early, but has to actually travel
 * SWIPE_FLING_MIN_PX first -- the old code let it fire at 30px.
 *
 * `cancelled` is the second gesture fix. A pointercancel means the
 * BROWSER took the gesture away (it decided to scroll instead), not that
 * the user finished a swipe. The old code wired pointercancel straight
 * to the same handler as pointerup, so a browser-initiated scroll cast a
 * vote. A cancelled pointer can never commit, full stop.
 */
export function shouldCommit({ dx, velocity, cardWidth, phase, cancelled = false }) {
  if (cancelled) return false;
  // A tap, an undecided touch, or a vertical gesture can never vote,
  // regardless of how fast it was.
  if (phase !== 'dragging') return false;

  const absDx = Math.abs(dx);
  const farEnough = absDx > commitDistance(cardWidth);
  const flung = velocity > CONFIG.SWIPE_FLING_VELOCITY && absDx > CONFIG.SWIPE_FLING_MIN_PX;

  return farEnough || flung;
}

/** Which way the committed swipe went. Only meaningful if shouldCommit. */
export function swipeDirection(dx) {
  return dx > 0 ? 'right' : 'left';
}
