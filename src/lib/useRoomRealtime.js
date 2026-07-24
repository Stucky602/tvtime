import { useEffect, useRef, useState } from 'react';
import { joinRoomChannel } from './realtime.js';

// React binding for the room channel.
//
// Exposes three things the UI actually needs:
//   present   -- who else is in the app right now
//   live      -- is the socket genuinely connected? Drives whether we
//                trust presence at all, and lets the UI stay honest
//                rather than showing a stale dot forever.
//   pulse     -- increments whenever a partner swipe lands. Components
//                depend on it to re-read from the database.
//
// `pulse` is a counter rather than the event payload, on purpose. It
// makes the contract obvious at every call site -- "something changed,
// go look" -- so no component can accidentally start treating a socket
// payload as authoritative and drift from the database.

export function useRoomRealtime({ roomId, userId, displayName }) {
  const [present, setPresent] = useState([]);
  const [live, setLive] = useState(false);
  const [pulse, setPulse] = useState(0);
  const bump = useRef(null);

  useEffect(() => {
    if (!roomId || !userId) return undefined;

    // Coalesce bursts. Swiping quickly fires an event per card, and
    // re-reading the bucket views per swipe would hammer the database
    // for no visible benefit -- the user cannot perceive 300ms here.
    const scheduleBump = () => {
      clearTimeout(bump.current);
      bump.current = setTimeout(() => setPulse((n) => n + 1), 300);
    };

    const leave = joinRoomChannel({
      roomId,
      userId,
      displayName,
      onPresence: setPresent,
      onSwipeChange: scheduleBump,
      onStatus: (status) => {
        const connected = status === 'SUBSCRIBED';
        setLive(connected);
        // A dropped socket must not leave a stale "swiping now" dot on
        // screen. Clearing presence here is what keeps the indicator
        // honest when the phone sleeps or changes network.
        if (!connected) setPresent([]);
      },
    });

    return () => {
      clearTimeout(bump.current);
      leave();
      setLive(false);
      setPresent([]);
    };
  }, [roomId, userId, displayName]);

  return { present, live, pulse };
}
