import { supabase } from './supabase.js';
import { SECRET } from './secret-pure.js';

// The two secret votes, and the lists they produce.
//
//   only_with_you -- yes, but this one is ours
//   just_me       -- yes, but I'm watching this on my own
//
// Both are statements TO your partner, which is why they are votes
// stored in the shared table rather than private notes. The privacy is
// in the gesture that casts them, not in the vote itself.

export const SECRET_LABEL = {
  only_with_you: 'Only with you',
  just_me: 'Just me',
};

export const SECRET_BLURB = {
  only_with_you: "Yes, but this one's ours. Not on my own, not with anyone else.",
  just_me: "Yes, but I'm watching this one alone. Don't wait up.",
};

/**
 * Every secret vote in the room, both members.
 *
 * Reads `swipes` directly rather than going through the bucket views,
 * because the secret votes were deliberately kept out of those. RLS
 * already scopes swipe reads to room members, so this inherits exactly
 * the right boundary with no extra policy.
 */
/**
 * The three lists, computed server-side.
 *
 * Replaces reading `swipes` directly, which no longer works and should
 * not: RLS now hides a partner's secret votes entirely, so the mutual
 * set cannot be computed on the client. That is the correct shape --
 * the intersection is the only thing either person is entitled to, and
 * an unmatched claim never leaves the database.
 */
export async function fetchSecretLists() {
  const { data, error } = await supabase.rpc('my_secret_lists');
  if (error) throw error;
  if (!data || data.status !== 'OK') return { ours: [], claimed: [], alone: [] };
  const keys = (arr) => (arr || []).map((r) => `${r.tmdb_id}:${r.media_type}`);
  return { ours: keys(data.ours), claimed: keys(data.claimed), alone: keys(data.alone) };
}

export async function fetchSecretVotes() {
  const { data, error } = await supabase
    .from('swipes')
    .select('user_id,tmdb_id,media_type,direction,voted_at')
    .in('direction', [SECRET.ONLY_WITH_YOU, SECRET.JUST_ME]);
  if (error) throw error;
  return data || [];
}


/** Title rows for a set of `tmdb_id:media_type` keys. */
export async function fetchSecretTitles(keys) {
  const ids = [...new Set(keys.map((k) => Number(k.split(':')[0])))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('titles')
    .select('tmdb_id,media_type,title,year,runtime,poster_path,providers,genres,episode_count,season_count')
    .in('tmdb_id', ids);
  if (error) throw error;
  return new Map((data || []).map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));
}

export { SECRET, partitionSecret } from './secret-pure.js';
