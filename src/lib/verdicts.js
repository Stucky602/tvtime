import { supabase } from './supabase.js';

// Per-person verdicts.
//
// `watched.verdict` was a single room-scoped column, so one person's
// thumbs-down was stored as the couple's opinion and fed BOTH decks.
// In a two-person app that is not a rounding error: it is the
// recommender confidently learning the wrong thing about one of you,
// and then acting on it for months.
//
// The old column is still written for anything that reads it, but this
// table is the truth.

export async function fetchVerdicts(roomId) {
  const { data, error } = await supabase
    .from('watch_verdicts')
    .select('tmdb_id,media_type,user_id,verdict,rated_at')
    .eq('room_id', roomId);
  if (error) throw error;
  return data || [];
}

export async function setVerdict({ roomId, tmdbId, mediaType, userId, verdict }) {
  const { error } = await supabase
    .from('watch_verdicts')
    .upsert(
      {
        room_id: roomId,
        tmdb_id: tmdbId,
        media_type: mediaType,
        user_id: userId,
        verdict,
        rated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id,tmdb_id,media_type,user_id' }
    );
  if (error) throw error;
}

/** Only YOUR verdicts, for feeding your own deck. */
export function myVerdictRows(verdicts, userId) {
  return (verdicts || []).filter((v) => v.user_id === userId);
}

/**
 * Finished watches you have not rated.
 *
 * The four-second toast was the only chance to rate anything, which is
 * absurd given you form the opinion over the following day. This is the
 * queue that replaces it.
 */
export function unratedFinished(watchRows, verdicts, userId) {
  const rated = new Set(
    (verdicts || [])
      .filter((v) => v.user_id === userId)
      .map((v) => `${v.tmdb_id}:${v.media_type}`)
  );
  return (watchRows || [])
    .filter((w) => w.status === 'finished')
    .filter((w) => !rated.has(`${w.tmdb_id}:${w.media_type}`));
}

/** Where the two of you disagreed about something you both rated. */
export function verdictSplits(verdicts, myId, partnerId) {
  const mine = new Map();
  const theirs = new Map();
  for (const v of verdicts || []) {
    const k = `${v.tmdb_id}:${v.media_type}`;
    if (v.user_id === myId) mine.set(k, v.verdict);
    else if (v.user_id === partnerId) theirs.set(k, v.verdict);
  }
  const out = [];
  for (const [k, v] of mine) {
    const t = theirs.get(k);
    if (t && t !== v) out.push({ key: k, mine: v, theirs: t });
  }
  return out;
}
