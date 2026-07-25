// Pure note helpers.
//
// Split from notes.js so they can be imported without the Supabase
// client. notes.js reads import.meta.env at module load, which means
// anything importing it is unloadable outside a Vite build -- including
// the node test runner. Keeping the logic separate from the I/O is the
// fix, and it is the right shape anyway.

export const KIND = {
  NOTE: 'note',
  BOOST: 'boost',
  BLESSING: 'blessing',
};

export const KIND_LABEL = {
  note: 'Note',
  boost: 'Take a look',
  blessing: 'Watch it without me',
};

/**
 * Titles your partner has boosted and you have not seen yet.
 *
 * Returned as a key set so the deck can promote them without a second
 * query per card.
 */
export function unseenBoostKeys(notes, myUserId) {
  const out = new Set();
  for (const n of notes || []) {
    if (n.kind !== KIND.BOOST) continue;
    if (n.author_id === myUserId) continue; // your own boost is not news to you
    if (n.seen_at) continue;                // a seen boost stops shouting
    out.add(`${n.tmdb_id}:${n.media_type}`);
  }
  return out;
}

/** Group notes by title, for rendering alongside a card or row. */
export function notesByTitle(notes) {
  const m = new Map();
  for (const n of notes || []) {
    const k = `${n.tmdb_id}:${n.media_type}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(n);
  }
  return m;
}
