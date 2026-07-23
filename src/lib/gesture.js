// Update 1: the swipe gesture decision logic, extracted as pure
// functions.
//
// This lives outside the React component on purpose. The reported bug --
// "barely touching the screen" casting a vote -- was a logic error in
// three numbers and one boolean operator, and there was no way to test
// it while it was buried in pointer event handlers. Now the actual
// decisions are pure functions over (dx, dy, velocity, cardWidth), and
// gesture.test.mjs runs the real reported scenario against them.

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
 * Should a still-in-progress touch be treated as a horizontal swipe yet?
 *
 * Returns one of:
 *   'pending'  -- keep watching, card must NOT move
 *   'dragging' -- confirmed horizontal drag
 *   'aborted'  -- clearly vertical, this pointer will never vote
 *
 * The dead zone is what actually fixes the reported bug: below it the
 * card doesn't move and no vote is possible, so a tap with a few pixels
 * of thumb drift is inert.
 */
export function classifyGesture(dx, dy) {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDy > CONFIG.SWIPE_VERTICAL_ABORT_PX && absDy > absDx) return 'aborted';
  if (absDx < CONFIG.SWIPE_DEAD_ZONE_PX) return 'pending';
  if (absDx < absDy * CONFIG.SWIPE_DIRECTION_LOCK) return 'pending';
  return 'dragging';
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
 */
export function shouldCommit({ dx, velocity, cardWidth, phase }) {
  // A tap or an aborted vertical gesture can never vote, regardless of
  // how fast it was.
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
