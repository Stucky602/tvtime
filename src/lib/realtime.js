import { supabase } from './supabase.js';

// Live presence + instant matches.
//
// THE HARD PART IS NOT THE SOCKET.
//
// It is that the app now has two paths to the same information --
// realtime when connected, poll-on-focus when not -- and mobile sockets
// drop *silently*. A phone that sleeps, changes network, or backgrounds
// for a while can hold a channel that looks subscribed and delivers
// nothing. If the app trusts it, state quietly diverges from the
// database and the user never learns why their matches stopped
// appearing.
//
// So the rule here is: realtime is an ACCELERATOR, never a source of
// truth. Every event does exactly one thing -- ask the caller to
// re-read from the database. Nothing is applied from the payload
// itself. That means a missed event costs latency, not correctness, and
// the existing poll-on-focus remains a complete fallback rather than a
// vestige. It also means we never have to reconcile two divergent
// in-memory states, because there is only ever one.
//
// Presence is the exception, since it has no database representation --
// but presence is cosmetic by design. If it is wrong you see a stale
// "swiping now" dot, and nothing else in the app depends on it.

const TOPIC = (roomId) => `room:${roomId}`;

/**
 * Join a room's realtime channel.
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} opts.userId
 * @param {string} opts.displayName
 * @param {(present: Array) => void} opts.onPresence  members currently online
 * @param {(evt: object) => void} opts.onSwipeChange  a swipe row changed; re-read
 * @param {(status: string) => void} [opts.onStatus]  channel lifecycle
 * @returns {() => void} unsubscribe
 */
export function joinRoomChannel({
  roomId,
  userId,
  displayName,
  onPresence,
  onSwipeChange,
  onStatus,
}) {
  if (!roomId || !userId) return () => {};

  const channel = supabase.channel(TOPIC(roomId), {
    config: {
      // Private: authorization is checked against the RLS policies on
      // realtime.messages (see the migration). Without this flag any
      // authenticated user could join any room's topic and watch
      // strangers' presence.
      private: true,
      presence: { key: userId },
    },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      // Presence state is keyed by our presence key (the user id), and
      // each key holds an array because the same user can be present
      // from more than one device.
      const present = Object.entries(state)
        .filter(([key]) => key !== userId)
        .map(([key, metas]) => ({ userId: key, ...(metas?.[0] || {}) }));
      onPresence?.(present);
    })
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'swipes' },
      (payload) => {
        // Deliberately NOT filtered by room here. `swipes` has no
        // room_id column to filter on, and it does not need one:
        // Realtime evaluates the table's own RLS before delivering, and
        // our swipes SELECT policy already scopes reads to room-mates.
        // The security boundary is the same one the REST path uses.
        //
        // Payload contents are ignored on purpose -- see the header.
        onSwipeChange?.({
          eventType: payload.eventType,
          userId: payload.new?.user_id ?? payload.old?.user_id ?? null,
        });
      }
    )
    .subscribe(async (status) => {
      onStatus?.(status);
      if (status === 'SUBSCRIBED') {
        await channel.track({
          display_name: displayName,
          online_at: new Date().toISOString(),
        });
      }
    });

  return () => {
    try {
      supabase.removeChannel(channel);
    } catch {
      /* already gone */
    }
  };
}
