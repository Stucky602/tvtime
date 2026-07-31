// The guessing game's scoreboard.
//
// Predictions resolve asynchronously: you guess, and the answer only
// arrives when your partner gets round to that card, which may be days
// later. So "instantly show +1" has to mean "the moment the result
// becomes known", not the moment you guessed.
//
// Which resolutions have already been celebrated is tracked on the
// device rather than in the database. It is purely cosmetic -- the
// worst case is a +1 you have already seen appearing once more on a new
// phone -- and a column plus a migration for that is not a fair trade.

const SEEN_KEY = 'flixpix.guesses.seen.v1';

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  try {
    // Bounded: only the recent tail matters, and an unbounded list would
    // grow forever for a purely cosmetic flag.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300)));
  } catch {
    /* nothing to do */
  }
}

/**
 * Resolved predictions the player has not been shown yet.
 * Oldest first, so a backlog is celebrated in the order it happened.
 */
export function unseenResults(predictions) {
  const seen = loadSeen();
  return (predictions || [])
    .filter((p) => p.resolved_at && p.was_correct !== null && !seen.has(p.id))
    .sort((a, b) => new Date(a.resolved_at) - new Date(b.resolved_at));
}

export function markResultsSeen(ids) {
  if (!ids?.length) return;
  const seen = loadSeen();
  for (const id of ids) seen.add(id);
  saveSeen(seen);
}

/**
 * Running tally. Score is correct minus wrong, so it reads the way the
 * +1 and -1 that produced it read.
 */
export function guessTally(predictions) {
  const resolved = (predictions || []).filter((p) => p.resolved_at && p.was_correct !== null);
  const correct = resolved.filter((p) => p.was_correct).length;
  const wrong = resolved.length - correct;
  return {
    total: resolved.length,
    correct,
    wrong,
    score: correct - wrong,
    rate: resolved.length ? correct / resolved.length : null,
    pending: (predictions || []).filter((p) => !p.resolved_at).length,
    // Below this, a percentage is a coin flip wearing a lab coat.
    confident: resolved.length >= 10,
  };
}

/**
 * Recent resolved guesses, newest first, shaped for display: what the
 * title was, what you said they would do, and what they actually did.
 */
export function recentResults(predictions, titlesByKey, limit = 20) {
  return (predictions || [])
    .filter((p) => p.resolved_at && p.was_correct !== null)
    .sort((a, b) => new Date(b.resolved_at) - new Date(a.resolved_at))
    .slice(0, limit)
    .map((p) => {
      const t = titlesByKey?.get(`${p.tmdb_id}:${p.media_type}`);
      // If the guess was right, their answer was your guess. If it was
      // wrong, it was the other one. Two options, so this is exact
      // rather than an approximation.
      const actual = p.was_correct ? p.guess : p.guess === 'right' ? 'left' : 'right';
      return {
        id: p.id,
        title: t?.title || 'A title we no longer have',
        guess: p.guess,
        actual,
        correct: p.was_correct,
        at: p.resolved_at,
      };
    });
}

export const SAID = { right: 'Yes', left: 'Pass' };
