// Architecture ref: ARCHITECTURE_v1.0.md §2, §2.4
//
// Data layer for the three durable tabs (Together/Solo/Pending). All
// three read from `user_title_buckets` (component 2's view), filtered by
// `bucket` and, for Pending, by direction -- §2's v0.4 note is explicit
// that Pending's "only your right swipes" framing is a display filter,
// not a change to the underlying predicate, so that filtering happens
// here in the client rather than in the view itself.

import { supabase, rpc } from './supabase.js';

const BUCKET_COLUMNS =
  'viewer_id,tmdb_id,media_type,viewer_direction,bucket,rights,lefts,total_votes,member_count';

const TITLE_COLUMNS =
  'tmdb_id,media_type,title,year,runtime,synopsis,poster_path,rating,vote_count,providers,watch_link,trailer_key,episode_count,season_count,genres';

/**
 * Fetches one bucket's rows plus the title data to render them, joined
 * client-side rather than via a Postgres join -- `user_title_buckets` is
 * a view over swipes, and titles change far less often, so two simple
 * queries are easier to reason about than widening the view.
 */
async function fetchBucket(bucket, { direction } = {}) {
  // viewer_id filter is NOT optional. `user_title_buckets` has one row
  // per VIEWER per title, so a Together match returns two rows -- yours
  // and your partner's -- and the tab listed every match twice. This
  // one missing predicate was the whole bug.
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return [];

  let query = supabase
    .from('user_title_buckets')
    .select(BUCKET_COLUMNS)
    .eq('bucket', bucket)
    .eq('viewer_id', uid);
  if (direction) query = query.eq('viewer_direction', direction);

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => r.tmdb_id);
  const { data: titles, error: titleErr } = await supabase
    .from('titles')
    .select(TITLE_COLUMNS)
    .in('tmdb_id', ids);
  if (titleErr) throw titleErr;

  const byKey = new Map((titles || []).map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));
  return rows
    .map((r) => byKey.get(`${r.tmdb_id}:${r.media_type}`))
    .filter(Boolean);
}

/** §2: both swiped right. */
export function fetchTogether() {
  return fetchBucket('together');
}

/** §2: you swiped right, partner left. "Watch this without them." */
export function fetchSolo() {
  return fetchBucket('solo');
}

/**
 * §2 v0.4: Pending shows only titles YOU swiped right on that your
 * partner hasn't voted on yet -- unreciprocated lefts are excluded since
 * there's no decision waiting on them.
 */
export function fetchPending() {
  return fetchBucket('pending', { direction: 'right' });
}

// ---------------------------------------------------------------------
// Watched (§2.4)
// ---------------------------------------------------------------------

export async function fetchWatched(roomId) {
  const { data: rows, error } = await supabase
    .from('watched')
    .select('tmdb_id,media_type,verdict,marked_at,status,started_on,watched_on,progress_note')
    .eq('room_id', roomId)
    .order('marked_at', { ascending: false });
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => r.tmdb_id);
  const { data: titles, error: titleErr } = await supabase
    .from('titles')
    .select(TITLE_COLUMNS)
    .in('tmdb_id', ids);
  if (titleErr) throw titleErr;

  const byKey = new Map((titles || []).map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));
  return rows
    .map((r) => ({ ...byKey.get(`${r.tmdb_id}:${r.media_type}`), verdict: r.verdict }))
    .filter((t) => t.tmdb_id);
}

/** §2.4: mark watched, non-blocking verdict follows via the toast. */
/**
 * Lifecycle transition. Replaces the old boolean "mark watched".
 *
 * Status is written directly rather than through the RPC because the
 * RPC predates the lifecycle and only knows about verdicts; the table
 * policies already scope writes to room members, so a direct update is
 * both correct and simpler than widening the function signature.
 */
export async function setWatchStatus({ roomId, tmdbId, mediaType, userId, status, verdict, progressNote }) {
  const now = new Date();
  const row = {
    room_id: roomId,
    tmdb_id: tmdbId,
    media_type: mediaType,
    marked_by: userId,
    marked_at: now.toISOString(),
    status,
  };
  if (status === 'watching') row.started_on = now.toISOString().slice(0, 10);
  // watched_on is the date it FINISHED, so it is only meaningful here.
  if (status === 'finished') row.watched_on = now.toISOString().slice(0, 10);
  if (verdict !== undefined) row.verdict = verdict;
  if (progressNote !== undefined) row.progress_note = progressNote;

  const { error } = await supabase
    .from('watched')
    .upsert(row, { onConflict: 'room_id,tmdb_id,media_type' });
  if (error) throw error;
}

export function markWatched(tmdb_id, media_type, verdict) {
  return rpc('mark_watched', { p_tmdb_id: tmdb_id, p_media_type: media_type, p_verdict: verdict ?? null });
}

/** §2.4: unmark is a plain delete, granted directly to room members (component 5). */
export async function unmarkWatched(roomId, tmdb_id, media_type) {
  const { error } = await supabase
    .from('watched')
    .delete()
    .eq('room_id', roomId)
    .eq('tmdb_id', tmdb_id)
    .eq('media_type', media_type);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Badge counts (§2: "Counts")
// ---------------------------------------------------------------------

const TAB_NAMES = ['together', 'solo', 'pending'];

/**
 * Unseen-since-last-visit counts, per §2: "each tab shows an
 * unseen-since-last-visit badge... persisted per user in
 * `users.tab_seen_at`."
 *
 * `user_title_buckets` has no "when did this become Together" column of
 * its own -- a bucket is a property of the current vote set, not a row
 * with its own timestamp. The honest resolution time for a title is the
 * LATER of the two swipes that produced its bucket (whichever partner
 * voted second is the moment the match/solo/pending state came into
 * being). So: fetch the bucket rows, then fetch the underlying swipes
 * for those exact titles and take max(voted_at) per title, and compare
 * that against tab_seen_at[tab]. A title with no prior seen timestamp
 * counts as unseen.
 */
export async function fetchBadgeCounts(tabSeenAt) {
  const seenAt = tabSeenAt || {};
  const results = {};

  for (const tab of TAB_NAMES) {
    const rows =
      tab === 'together' ? await fetchTogether() : tab === 'solo' ? await fetchSolo() : await fetchPending();

    if (rows.length === 0) {
      results[tab] = 0;
      continue;
    }

    const ids = rows.map((r) => r.tmdb_id);
    const { data: swipes, error } = await supabase
      .from('swipes')
      .select('tmdb_id,media_type,voted_at')
      .in('tmdb_id', ids);
    if (error) throw error;

    const resolvedAt = new Map();
    for (const s of swipes || []) {
      const key = `${s.tmdb_id}:${s.media_type}`;
      const t = new Date(s.voted_at).getTime();
      if (!resolvedAt.has(key) || t > resolvedAt.get(key)) resolvedAt.set(key, t);
    }

    const seenTs = seenAt[tab] ? new Date(seenAt[tab]).getTime() : 0;
    results[tab] = rows.filter((r) => (resolvedAt.get(`${r.tmdb_id}:${r.media_type}`) || 0) > seenTs)
      .length;
  }

  return results;
}

/**
 * What your partner has been up to since you last looked.
 *
 * Closes the feedback loop that push notifications would otherwise
 * handle -- the architecture rules those out, and presence only helps
 * when you're both in the app at the same moment. This covers the far
 * more common case: you open the app hours later and have no idea
 * whether anything happened.
 *
 * Deliberately reports SWIPES rather than new matches. Matches are
 * already visible as badges; the useful and otherwise invisible fact is
 * "she went through 30 titles last night", which tells you whether
 * there's anything worth looking at.
 */
export async function partnerActivity(partnerId, since) {
  if (!partnerId) return null;
  const cutoff = since ? new Date(since).toISOString() : null;

  let q = supabase
    .from('swipes')
    .select('direction,voted_at')
    .eq('user_id', partnerId)
    .order('voted_at', { ascending: false })
    .limit(200);
  if (cutoff) q = q.gt('voted_at', cutoff);

  const { data, error } = await q;
  if (error) return null;

  const rows = data || [];
  if (rows.length === 0) return null;

  return {
    swipes: rows.length,
    yes: rows.filter((r) => r.direction === 'right').length,
    lastAt: rows[0]?.voted_at ?? null,
  };
}

export async function markTabSeen(userId, tab) {
  const { data, error } = await supabase.from('users').select('tab_seen_at').eq('id', userId).single();
  if (error) throw error;
  const next = { ...(data?.tab_seen_at || {}), [tab]: new Date().toISOString() };
  const { error: updateErr } = await supabase
    .from('users')
    .update({ tab_seen_at: next })
    .eq('id', userId);
  if (updateErr) throw updateErr;
  return next;
}
