// Update 4: haptic feedback.
//
// Honest caveat up front: `navigator.vibrate` is supported on Android
// (Chrome/Firefox) and NOT on iOS Safari -- Apple has never shipped it,
// including for installed PWAs. So on an iPhone every function here is
// a silent no-op. It costs nothing and degrades invisibly, which is why
// it's worth having anyway, but don't expect to feel anything on iOS.
//
// Durations are deliberately short. A swipe happens dozens of times a
// session; anything longer than ~15ms starts to feel like the phone is
// buzzing at you rather than acknowledging a tap.

function canVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** The card has crossed the commit threshold while still being dragged. */
export function hapticThreshold() {
  if (canVibrate()) navigator.vibrate(8);
}

/** A swipe was committed. */
export function hapticCommit() {
  if (canVibrate()) navigator.vibrate(12);
}

/** A swipe was undone. Slightly different shape so it reads as "reversed". */
export function hapticUndo() {
  if (canVibrate()) navigator.vibrate([6, 40, 6]);
}

/** Both of you said yes. The one moment worth a distinctive pattern. */
export function hapticMatch() {
  if (canVibrate()) navigator.vibrate([0, 26, 70, 26]);
}
