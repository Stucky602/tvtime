// Pure half of the secret vote logic, split from secret.js so it can be
// imported and tested without pulling in the Supabase client. Same
// reason notes-pure.js exists: supabase.js reads import.meta.env at load
// and cannot be imported outside a Vite build.

export const SECRET = {
  ONLY_WITH_YOU: 'only_with_you',
  JUST_ME: 'just_me',
};

export function partitionSecret(votes, myId, partnerId) {
  const mine = new Map();
  const theirs = new Map();

  for (const v of votes || []) {
    const key = `${v.tmdb_id}:${v.media_type}`;
    if (v.user_id === myId) mine.set(key, v);
    else if (partnerId && v.user_id === partnerId) theirs.set(key, v);
  }

  const ours = [];
  const waitingOnThem = [];
  const myAlone = [];
  const theirAlone = [];

  for (const [key, v] of mine) {
    if (v.direction === SECRET.JUST_ME) {
      myAlone.push(key);
      continue;
    }
    const t = theirs.get(key);
    if (t && t.direction === SECRET.ONLY_WITH_YOU) ours.push(key);
    else waitingOnThem.push(key);
  }

  for (const [key, v] of theirs) {
    if (v.direction === SECRET.JUST_ME) theirAlone.push(key);
  }

  return { ours, waitingOnThem, myAlone, theirAlone };
}
