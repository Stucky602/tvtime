import { supabase } from './supabase.js';
import { KIND } from './notes-pure.js';

// The note primitive.
//
// The app was a shared database between two people with no way for
// either to say anything to the other. Every relationship-shaped idea in
// the queue (boost with a note, watch-alone blessing, and the next three
// nobody has asked for yet) was inventing its own narrow channel.
//
// One table, three kinds, identical storage. The kinds differ only in
// how they are presented and, for boosts, in whether they touch the
// deck.

/** All notes for a room, newest first. */
export async function fetchNotes(roomId) {
  const { data, error } = await supabase
    .from('title_notes')
    .select('id,tmdb_id,media_type,author_id,kind,body,created_at,seen_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

export async function addNote({ roomId, tmdbId, mediaType, authorId, kind = KIND.NOTE, body }) {
  const { data, error } = await supabase
    .from('title_notes')
    .insert({
      room_id: roomId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      author_id: authorId,
      kind,
      body: body?.trim() ? body.trim().slice(0, 500) : null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Mark someone else's notes as seen.
 *
 * This is what stops a boost shouting forever. Without it the badge
 * would persist until the title was swiped, which turns a helpful nudge
 * into a permanent piece of furniture.
 */
export async function markNotesSeen(roomId, noteIds) {
  if (!noteIds?.length) return;
  const { error } = await supabase
    .from('title_notes')
    .update({ seen_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .in('id', noteIds);
  if (error) throw error;
}

export async function deleteNote(noteId) {
  const { error } = await supabase.from('title_notes').delete().eq('id', noteId);
  if (error) throw error;
}

// Pure helpers live in notes-pure.js so they can be imported without
// dragging in the Supabase client (which reads import.meta.env and
// therefore cannot be loaded by the node test runner). Re-exported here
// so call sites have one import path.
export { unseenBoostKeys, notesByTitle, KIND, KIND_LABEL } from './notes-pure.js';
