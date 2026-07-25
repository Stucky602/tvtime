import { supabase } from './supabase.js';

// "Do we actually know each other."
//
// Before your partner's vote is visible, guess it. No points, no
// streaks, nothing shaped like a game -- the interesting output is a
// single number about the two of you, and it happens to double as a
// check on how well each of you models the other.
//
// Resolution is handled by a database trigger rather than here, because
// the app cannot be relied upon to be running at the moment the other
// person votes.

export async function fetchMyPredictions(roomId) {
  const { data, error } = await supabase
    .from('predictions')
    .select('id,tmdb_id,media_type,guess,created_at,resolved_at,was_correct')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return data || [];
}

export async function guess({ roomId, tmdbId, mediaType, userId, direction }) {
  const { error } = await supabase
    .from('predictions')
    .upsert(
      {
        room_id: roomId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        guesser_id: userId,
        guess: direction,
      },
      { onConflict: 'room_id,tmdb_id,media_type,guesser_id' }
    );
  if (error) throw error;
}

/**
 * Titles worth being asked to guess about: your partner has not voted,
 * and you have not already guessed.
 *
 * Deliberately narrow. A prompt on every card would be exhausting and
 * would turn swiping into a quiz; this exists to be offered
 * occasionally, on cards where the answer is actually unknown.
 */
export function guessableKeys(partnerVotedKeys, myPredictions) {
  const guessed = new Set(
    (myPredictions || []).map((p) => `${p.tmdb_id}:${p.media_type}`)
  );
  return (key) => !partnerVotedKeys.has(key) && !guessed.has(key);
}
