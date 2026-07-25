import { supabase } from './supabase.js';

// Pairwise preference, from Tonight's Pick.
//
// The bracket asks you to choose between two titles, seven times, and
// used to discard every answer. Pairwise comparison is the strongest
// preference signal the app can collect: a swipe tells you a title
// cleared some private bar, a head-to-head tells you which of two
// specific things you actually wanted more, with no scale to
// interpret and no drift over time.
//
// Stored raw. A pile of comparisons can be re-analysed later with a
// better model; a running average cannot be un-averaged.

export async function recordPick({ roomId, userId, winner, loser }) {
  const { error } = await supabase.from('pick_outcomes').insert({
    room_id: roomId,
    user_id: userId,
    winner_tmdb_id: winner.tmdb_id,
    winner_media_type: winner.media_type,
    loser_tmdb_id: loser.tmdb_id,
    loser_media_type: loser.media_type,
  });
  if (error) throw error;
}

export async function fetchPicks(userId, limit = 400) {
  const { data, error } = await supabase
    .from('pick_outcomes')
    .select('winner_tmdb_id,winner_media_type,loser_tmdb_id,loser_media_type,decided_at')
    .eq('user_id', userId)
    .order('decided_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
