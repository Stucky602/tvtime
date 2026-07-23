// Architecture ref: ARCHITECTURE_v1.0.md §7, §6.5
//
// Thin wrappers around component 6's RPCs, plus the plain-table reads
// component 5 already grants directly (platforms, genre_prefs -- no RPC
// needed for those, per §6.5's "plain table/view reads" list).

import { supabase, rpc } from './supabase.js';

/**
 * Resolves the signed-in user's current room, if any. Returns null
 * rather than throwing when there is no membership yet -- that's the
 * normal state for someone who hasn't joined or created a room.
 */
export async function getMyRoomState(userId) {
  const { data: membership, error: memErr } = await supabase
    .from('room_members')
    .select('room_id,joined_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (memErr) throw memErr;
  if (!membership) return { room: null, user: null, partner: null };

  const { data: room, error: roomErr } = await supabase
    .from('rooms')
    .select('id,code,platforms,include_reality,max_members')
    .eq('id', membership.room_id)
    .single();
  if (roomErr) throw roomErr;

  const { data: members, error: membersErr } = await supabase
    .from('room_members')
    .select('user_id,joined_at')
    .eq('room_id', membership.room_id);
  if (membersErr) throw membersErr;

  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id,display_name,genre_prefs,tab_seen_at')
    .in(
      'id',
      members.map((m) => m.user_id)
    );
  if (usersErr) throw usersErr;

  const usersById = new Map(users.map((u) => [u.id, u]));
  const me = usersById.get(userId);
  const partnerMember = members.find((m) => m.user_id !== userId);
  const partner = partnerMember ? usersById.get(partnerMember.user_id) : null;

  return { room, user: me, partner };
}

export function createRoom(displayName, platforms, pin) {
  return rpc('create_room', { p_display_name: displayName, p_platforms: platforms, p_pin: pin });
}

export function joinRoom(code, pin, displayName) {
  return rpc('join_room', { p_code: code, p_pin: pin, p_display_name: displayName });
}

export function listReclaimMembers(code, pin) {
  return rpc('room_members_for_reclaim', { p_code: code, p_pin: pin });
}

export function reclaimMembership(code, pin, memberUserId) {
  return rpc('reclaim_membership', { p_code: code, p_pin: pin, p_member_user_id: memberUserId });
}

export function leaveRoom() {
  return rpc('leave_room');
}

/** Kick your partner out of the room (either member may do this). */
export function removeMember(memberUserId) {
  return rpc('remove_member', { p_member_user_id: memberUserId });
}

/**
 * Wipe YOUR swipes (and optionally genre picks) without leaving the
 * room or touching your partner's data. The shared watched list is
 * deliberately left alone -- see the migration for why.
 */
export function resetMyData(clearGenres = false) {
  return rpc('reset_my_data', { p_clear_genres: clearGenres });
}

/** §5's column grant: members may update platforms, nothing else on rooms. */
export async function updatePlatforms(roomId, platforms) {
  const { error } = await supabase.from('rooms').update({ platforms }).eq('id', roomId);
  if (error) throw error;
}

/** §4.4's per-room reality toggle -- same grant as platforms. */
export async function updateIncludeReality(roomId, includeReality) {
  const { error } = await supabase.from('rooms').update({ include_reality: includeReality }).eq('id', roomId);
  if (error) throw error;
}

/** Onboarding genre picks. Own-row update, granted directly (component 5). */
export async function updateGenrePrefs(userId, genrePrefs) {
  const { error } = await supabase.from('users').update({ genre_prefs: genrePrefs }).eq('id', userId);
  if (error) throw error;
}
