// Update 1 verification. Run: node --test src/lib/gesture.test.mjs
//
// The point of this file is the first test: the exact scenario reported
// ("barely touching the screen" casting a vote), expressed as real
// numbers, asserted to no longer commit. Everything else guards the
// fix from being loosened back into a bug later.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from './config.js';
import { lockAxis, dragState, shouldCommit, commitDistance, swipeDirection } from './gesture.js';

const PHONE = 360; // typical card width on a 390px-wide phone

/** Convenience: the old single-call shape, composed from the new model. */
function classify(dx, dy) {
  const axis = lockAxis(dx, dy);
  if (axis === null) return 'pending';
  return dragState(axis, dx);
}


/** Reproduces the OLD logic exactly, to prove these cases used to pass. */
function oldShouldCommit(dx, totalElapsedMs) {
  const OLD_COMMIT_PX = 110;
  const OLD_FLING_VELOCITY = 0.45;
  const velocity = Math.abs(dx) / Math.max(1, totalElapsedMs);
  const committed = Math.abs(dx) > OLD_COMMIT_PX || velocity > OLD_FLING_VELOCITY;
  return committed && Math.abs(dx) > 30;
}

// ---------------------------------------------------------------------
// The reported bug
// ---------------------------------------------------------------------

test('THE REPORTED BUG: a light touch with slight drift no longer votes', () => {
  // A thumb landing on the card and slipping ~31px over 60ms. On a
  // 390px phone that's 8% of the screen -- nowhere near a deliberate
  // swipe, but it used to cast a permanent vote.
  const dx = 31;
  const elapsed = 60;

  assert.equal(
    oldShouldCommit(dx, elapsed),
    true,
    'sanity: this SHOULD have committed under the old logic, or this test proves nothing'
  );

  const phase = classify(dx, 4);
  const velocity = dx / elapsed; // 0.52 px/ms
  assert.equal(
    shouldCommit({ dx, velocity, cardWidth: PHONE, phase }),
    false,
    'a 31px twitch must not vote'
  );
});

test('a genuine fast flick still commits', () => {
  // A real flick: 130px in 90ms. This is someone decisively swiping.
  const dx = 130;
  const velocity = 100 / 80; // trailing-window velocity, 1.25 px/ms
  const phase = classify(dx, 10);
  assert.equal(phase, 'dragging');
  assert.equal(shouldCommit({ dx, velocity, cardWidth: PHONE, phase }), true);
});

test('a slow deliberate drag past the threshold still commits', () => {
  // Dragged slowly all the way across -- no fling velocity at all.
  const dx = 140;
  const phase = classify(dx, 8);
  assert.equal(shouldCommit({ dx, velocity: 0.02, cardWidth: PHONE, phase }), true);
});

// ---------------------------------------------------------------------
// Dead zone and direction lock
// ---------------------------------------------------------------------

test('dead zone: tiny movement is pending, so the card never even moves', () => {
  for (const dx of [0, 3, 8, 15]) {
    assert.equal(classify(dx, 2), 'pending', `${dx}px should stay pending`);
  }
  assert.equal(classify(20, 2), 'dragging', 'past the dead zone it becomes a drag');
});

test('a vertical scroll aborts instead of bleeding into a vote', () => {
  assert.equal(classify(10, 80), 'inert');
  assert.equal(
    shouldCommit({ dx: 10, velocity: 5, cardWidth: PHONE, phase: 'inert' }),
    false,
    'an aborted gesture cannot vote even at high velocity'
  );
});

test('a diagonal that is mostly vertical locks vertical and stays inert', () => {
  // 25px across, 24px down -- roughly 45 degrees. Ambiguous intent, so
  // the safe answer is "do not cast an irreversible vote": it locks
  // vertical and the card is inert for the rest of the touch.
  assert.equal(classify(25, 24), 'inert');
  // Clearly horizontal at the same distance.
  assert.equal(classify(25, 5), 'dragging');
});

// ---------------------------------------------------------------------
// The SECOND reported bug: holding and scrolling vertically threw the card
// ---------------------------------------------------------------------

test('THE REPORTED BUG: a vertical scroll can never become a swipe', () => {
  // Someone holding the card and dragging down to see what's below.
  // Sampled as the gesture progresses -- a little horizontal wobble is
  // normal and must not matter.
  const samples = [
    [2, 14], [5, 40], [9, 90], [14, 150], [22, 210], [30, 260],
  ];

  let axis = null;
  for (const [dx, dy] of samples) {
    if (axis === null) axis = lockAxis(dx, dy);
  }

  assert.equal(axis, 'y', 'a downward drag must lock the vertical axis');
  assert.equal(dragState(axis, 30), 'inert', 'and stay inert for the whole touch');
  assert.equal(
    shouldCommit({ dx: 30, velocity: 2.5, cardWidth: PHONE, phase: 'inert' }),
    false,
    'no amount of speed or drift can make a vertical gesture vote'
  );
});

test('once the axis locks vertical it NEVER flips, even on large later drift', () => {
  // This is precisely what broke before: the gesture starts vertical,
  // then the finger wanders a long way sideways. The old code
  // re-evaluated direction on every move and flipped into a swipe.
  const axis = lockAxis(3, 30); // locked on the first significant move
  assert.equal(axis, 'y');

  // Finger later drifts 250px horizontally. Irrelevant -- the axis is
  // already decided and the caller must not re-derive it.
  assert.equal(dragState(axis, 250), 'inert');
  assert.equal(
    shouldCommit({ dx: 250, velocity: 3, cardWidth: PHONE, phase: 'inert' }),
    false,
    'a locked-vertical touch cannot vote no matter how far it later travels'
  );
});

test('a browser-cancelled pointer can never commit', () => {
  // pointercancel means the browser took the gesture over to scroll.
  // The old code wired it to the same handler as pointerup, so a
  // browser-initiated scroll cast a real vote.
  assert.equal(
    shouldCommit({
      dx: 300, velocity: 5, cardWidth: PHONE, phase: 'dragging', cancelled: true,
    }),
    false,
    'even a textbook full-distance swipe must not commit if it was cancelled'
  );
  // Same gesture, actually released by the user.
  assert.equal(
    shouldCommit({ dx: 300, velocity: 5, cardWidth: PHONE, phase: 'dragging' }),
    true
  );
});

test('a slow vertical hold-and-drag stays undecided then locks vertical', () => {
  // Below the axis-lock threshold nothing is decided and the card is
  // completely still -- no tilt, no movement, no hint of a vote.
  assert.equal(lockAxis(2, 6), null, 'tiny movement stays undecided');
  assert.equal(classify(2, 6), 'pending');
  // Past the threshold, vertical wins.
  assert.equal(lockAxis(4, 20), 'y');
});

test('a tap that never became a drag cannot vote', () => {
  assert.equal(
    shouldCommit({ dx: 4, velocity: 9, cardWidth: PHONE, phase: 'pending' }),
    false
  );
});

// ---------------------------------------------------------------------
// Threshold scaling and fling floor
// ---------------------------------------------------------------------

test('commit distance scales with card width but never below the floor', () => {
  assert.equal(commitDistance(1000), 300, '30% of a wide card');
  assert.equal(
    commitDistance(200),
    CONFIG.SWIPE_COMMIT_MIN_PX,
    'narrow screens clamp to the floor rather than becoming hair-trigger'
  );
  assert.ok(commitDistance(360) >= CONFIG.SWIPE_COMMIT_MIN_PX);
});

test('a fling must still cover real ground', () => {
  const phase = 'dragging';
  // Very fast, but only 50px -- under SWIPE_FLING_MIN_PX.
  assert.equal(
    shouldCommit({ dx: 50, velocity: 3.0, cardWidth: PHONE, phase }),
    false,
    'speed alone must not commit -- this was the core of the original bug'
  );
  // Same speed, past the fling floor.
  assert.equal(
    shouldCommit({ dx: 95, velocity: 3.0, cardWidth: PHONE, phase }),
    true
  );
});

test('direction is read from the sign of travel', () => {
  assert.equal(swipeDirection(120), 'right');
  assert.equal(swipeDirection(-120), 'left');
});

// ---------------------------------------------------------------------
// Regression guard
// ---------------------------------------------------------------------

test('every accidental-touch scenario that used to vote now does not', () => {
  const accidents = [
    { label: 'thumb drift on tap', dx: 31, dy: 4, elapsed: 60 },
    { label: 'fast small flick', dx: 40, dy: 6, elapsed: 50 },
    { label: 'jab while scrolling', dx: 35, dy: 30, elapsed: 40 },
    { label: 'quick brush', dx: 45, dy: 8, elapsed: 70 },
  ];

  for (const a of accidents) {
    const oldVoted = oldShouldCommit(a.dx, a.elapsed);
    const phase = classify(a.dx, a.dy);
    const velocity = a.dx / a.elapsed;
    const nowVotes = shouldCommit({ dx: a.dx, velocity, cardWidth: PHONE, phase });

    assert.equal(oldVoted, true, `sanity: "${a.label}" should have voted under old logic`);
    assert.equal(nowVotes, false, `"${a.label}" must no longer vote`);
  }
});

test('deliberate swipes are unaffected by the tightening', () => {
  const deliberate = [
    { label: 'full drag right', dx: 200, dy: 12, velocity: 0.4 },
    { label: 'full drag left', dx: -220, dy: 18, velocity: 0.5 },
    { label: 'confident flick', dx: 120, dy: 6, velocity: 1.4 },
  ];

  for (const d of deliberate) {
    const phase = classify(d.dx, d.dy);
    assert.equal(phase, 'dragging', `"${d.label}" should register as a drag`);
    assert.equal(
      shouldCommit({ dx: d.dx, velocity: d.velocity, cardWidth: PHONE, phase }),
      true,
      `"${d.label}" must still commit`
    );
  }
});
