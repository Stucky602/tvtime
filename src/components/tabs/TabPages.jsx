import TabScreen from './TabScreen.jsx';
import { fetchTogether, fetchSolo, fetchPending } from '../../lib/tabs.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2
//
// Each tab is just TabScreen wired to its own fetcher. Keeping them as
// separate named components (rather than one parameterized component
// used directly) is deliberate -- it's what error boundaries and route
// transitions attach to, and it keeps the copy for each empty state
// next to the tab it belongs to instead of in a lookup table.

export function TogetherTab({ roomId, roomPlatforms, onTonightsPick }) {
  return (
    <TabScreen
      title="Together"
      fetcher={fetchTogether}
      roomId={roomId}
      roomPlatforms={roomPlatforms}
      onTonightsPick={onTonightsPick}
      emptyHead="Nothing yet"
      emptyBody="When you both swipe right on the same title, it shows up here."
    />
  );
}

export function SoloTab({ roomId, roomPlatforms }) {
  return (
    <TabScreen
      title="Solo"
      fetcher={fetchSolo}
      roomId={roomId}
      roomPlatforms={roomPlatforms}
      emptyHead="Nothing here yet"
      emptyBody="Titles you're into that your partner passed on land here -- watch these without waiting."
    />
  );
}

export function WatchedTab({ roomId, roomPlatforms }) {
  return (
    <TabScreen
      title="Watched"
      fetcher={fetchTogether}
      roomId={roomId}
      roomPlatforms={roomPlatforms}
      watchedOnly
      emptyHead="Nothing watched yet"
      emptyBody="Mark a match as watched and it moves here, with the option to rate it."
    />
  );
}

export function PendingTab({ roomId, roomPlatforms }) {
  return (
    <TabScreen
      title="Pending"
      fetcher={fetchPending}
      roomId={roomId}
      roomPlatforms={roomPlatforms}
      emptyHead="All caught up"
      emptyBody="Titles you've said yes to, waiting on your partner's swipe, show up here."
    />
  );
}
