import { useCallback, useEffect, useState } from 'react';
import { fetchBadgeCounts, markTabSeen } from '../../lib/tabs.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2 ("Counts"), §6.5 (poll on focus)
//
// The four tabs (Swipe has no badge -- there's nothing to "catch up on"
// there, the deck is always current). Badge counts refresh on focus and
// after each swipe response (the caller passes onSwipeResolved through
// to trigger a refresh) rather than a realtime subscription.

const TABS = [
  { id: 'swipe', label: 'Swipe' },
  { id: 'together', label: 'Together' },
  { id: 'solo', label: 'Solo' },
  { id: 'pending', label: 'Pending' },
];

export default function TabBar({ active, onChange, userId, tabSeenAt, refreshToken }) {
  const [badges, setBadges] = useState({ together: 0, solo: 0, pending: 0 });

  const refresh = useCallback(async () => {
    try {
      const counts = await fetchBadgeCounts(tabSeenAt);
      setBadges(counts);
    } catch {
      // A failed badge refresh is not worth surfacing -- the tabs
      // themselves will show the real error if the underlying fetch
      // is actually broken.
    }
  }, [tabSeenAt]);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh, refreshToken]);

  const handleChange = async (tabId) => {
    onChange(tabId);
    if (tabId !== 'swipe') {
      // Opening a tab clears its own badge -- the whole point of
      // tab_seen_at is that a badge means "since you last opened this."
      try {
        await markTabSeen(userId, tabId);
        setBadges((b) => ({ ...b, [tabId]: 0 }));
      } catch {
        /* badge staying stale for one visit is not worth surfacing */
      }
    }
  };

  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`tabbar__btn ${active === tab.id ? 'tabbar__btn--active' : ''}`}
          onClick={() => handleChange(tab.id)}
          aria-current={active === tab.id ? 'page' : undefined}
        >
          <span>{tab.label}</span>
          {badges[tab.id] > 0 && <span className="tabbar__badge">{badges[tab.id]}</span>}
        </button>
      ))}
    </nav>
  );
}
