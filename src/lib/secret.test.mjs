import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneFor, sequencesMatch, isValidSequence, pruneTaps, GRID, MIN_TAPS,
} from './secret-gesture.js';
import { partitionSecret, SECRET } from './secret-pure.js';

const V = (user, id, direction) => ({
  user_id: user, tmdb_id: id, media_type: 'movie', direction,
});

// ---------------------------------------------------------------------
// Gesture
// ---------------------------------------------------------------------

test('zones map corners and centre correctly on a 3x3 grid', () => {
  const w = 300, h = 600;
  assert.equal(zoneFor(10, 10, w, h), 0, 'top-left');
  assert.equal(zoneFor(290, 10, w, h), 2, 'top-right');
  assert.equal(zoneFor(150, 300, w, h), 4, 'centre');
  assert.equal(zoneFor(10, 590, w, h), 6, 'bottom-left');
  assert.equal(zoneFor(290, 590, w, h), 8, 'bottom-right');
});

test('a point exactly on the far edge stays in the last zone', () => {
  // Without clamping, x === width computes zone 3 on a 3-wide grid and
  // produces an out-of-range index.
  assert.equal(zoneFor(300, 600, 300, 600), GRID * GRID - 1);
});

test('zone is null when the element has no size yet', () => {
  assert.equal(zoneFor(10, 10, 0, 0), null);
});

test('matching is exact, never fuzzy', () => {
  assert.ok(sequencesMatch([0, 4, 8, 2], [0, 4, 8, 2]));
  assert.ok(!sequencesMatch([0, 4, 8, 2], [0, 4, 8, 1]), 'one wrong zone fails');
  assert.ok(!sequencesMatch([0, 4, 8, 2], [0, 4, 8]), 'a prefix is not a match');
  assert.ok(!sequencesMatch([0, 4, 8, 2], [2, 8, 4, 0]), 'order matters');
});

test('a too-short sequence can never match, even against itself', () => {
  assert.ok(!sequencesMatch([0, 1], [0, 1]),
    'below the minimum length nothing counts as a secret');
});

test('a single repeated zone is rejected as a secret', () => {
  // The first thing a curious partner tries is tapping one corner
  // repeatedly, so that must not be allowed as anyone's secret.
  assert.ok(!isValidSequence([4, 4, 4, 4]));
  assert.ok(isValidSequence([4, 4, 4, 1]), 'any variation is enough');
});

test('sequence validation rejects nonsense and out-of-range zones', () => {
  assert.ok(!isValidSequence(null));
  assert.ok(!isValidSequence([0, 1, 2]), 'shorter than the minimum');
  assert.ok(!isValidSequence([0, 1, 2, 9]), 'zone 9 does not exist');
  assert.ok(!isValidSequence([0, 1, 2, 'x']));
  assert.ok(isValidSequence(Array(MIN_TAPS).fill(0).map((_, i) => i)));
});

test('taps decay, so scattered taps never accumulate into a secret', () => {
  const now = 100_000;
  const taps = [
    { zone: 0, at: now - 9000 },  // ancient
    { zone: 1, at: now - 500 },
    { zone: 2, at: now - 100 },
  ];
  const kept = pruneTaps(taps, now);
  assert.deepEqual(kept.map((t) => t.zone), [1, 2],
    'taps outside the window are dropped before matching');
});

// ---------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------

test('"ours" requires BOTH to have marked it, independently', () => {
  const votes = [
    V('me', 1, SECRET.ONLY_WITH_YOU),
    V('them', 1, SECRET.ONLY_WITH_YOU),   // mutual -> ours
    V('me', 2, SECRET.ONLY_WITH_YOU),      // one-sided -> waiting
  ];
  const p = partitionSecret(votes, 'me', 'them');
  assert.deepEqual(p.ours, ['1:movie']);
  assert.deepEqual(p.waitingOnThem, ['2:movie']);
});

test('a partner who has not found the gesture yet leaves "ours" empty', () => {
  // This is the charm of the feature and it must not leak: until they
  // independently discover it, you see nothing mutual.
  const votes = [V('me', 1, SECRET.ONLY_WITH_YOU), V('me', 2, SECRET.ONLY_WITH_YOU)];
  const p = partitionSecret(votes, 'me', 'them');
  assert.equal(p.ours.length, 0);
  assert.equal(p.waitingOnThem.length, 2);
});

test('a partner marking it "just me" does not make it ours', () => {
  const votes = [V('me', 1, SECRET.ONLY_WITH_YOU), V('them', 1, SECRET.JUST_ME)];
  const p = partitionSecret(votes, 'me', 'them');
  assert.equal(p.ours.length, 0, 'they want it alone, so it is not ours');
  assert.deepEqual(p.waitingOnThem, ['1:movie']);
  assert.deepEqual(p.theirAlone, ['1:movie']);
});

test('just-me lists stay on the right side of the room', () => {
  const votes = [V('me', 1, SECRET.JUST_ME), V('them', 2, SECRET.JUST_ME)];
  const p = partitionSecret(votes, 'me', 'them');
  assert.deepEqual(p.myAlone, ['1:movie']);
  assert.deepEqual(p.theirAlone, ['2:movie']);
  assert.equal(p.ours.length, 0);
});

test('with no partner yet, nothing can be mutual and nothing throws', () => {
  const votes = [V('me', 1, SECRET.ONLY_WITH_YOU), V('me', 2, SECRET.JUST_ME)];
  const p = partitionSecret(votes, 'me', null);
  assert.equal(p.ours.length, 0);
  assert.deepEqual(p.waitingOnThem, ['1:movie']);
  assert.deepEqual(p.myAlone, ['2:movie']);
});

test('a third party\'s votes are ignored entirely', () => {
  const votes = [
    V('me', 1, SECRET.ONLY_WITH_YOU),
    V('stranger', 1, SECRET.ONLY_WITH_YOU),
  ];
  const p = partitionSecret(votes, 'me', 'them');
  assert.equal(p.ours.length, 0, 'only the named partner can complete a pair');
});
