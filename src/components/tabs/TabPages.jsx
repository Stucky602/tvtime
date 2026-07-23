import TabScreen from './TabScreen.jsx';
import { fetchTogether, fetchSolo, fetchPending } from '../../lib/tabs.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2
//
// Each tab is just TabScreen wired to its own fetcher. Keeping them as
// separate named components (rather than one parameterized component
// used directly) is deliberate -- it's what error boundaries and route
// transitions attach to, and it keeps the copy for each empty state
// next to the tab it belongs to instead of in a lookup table.

export function TogetherTab({ roomId }) {
  return (
    <TabScreen
      title="Together"
      fetcher={fetchTogether}
      roomId={roomId}
      emptyHead="Nothing yet"
      emptyBody="When you both swipe right on the same title, it shows up here."
    />
  );
}

export function SoloTab({ roomId }) {
  return (
    <TabScreen
      title="Solo"
      fetcher={fetchSolo}
      roomId={roomId}
      emptyHead="Nothing here yet"
      emptyBody="Titles you're into that your partner passed on land here -- watch these without waiting."
    />
  );
}

export function PendingTab({ roomId }) {
  return (
    <TabScreen
      title="Pending"
      fetcher={fetchPending}
      roomId={roomId}
      emptyHead="All caught up"
      emptyBody="Titles you've said yes to, waiting on your partner's swipe, show up here."
    />
  );
}
