import { useEffect, useMemo, useState } from 'react';
import SwipeDeck from './SwipeDeck.jsx';
import FilterPanel from './FilterPanel.jsx';
import { buildAndCacheDeck, loadCachedDeck, flushSwipeQueue, queuedSwipeCount } from '../../lib/data.js';
import { applyFilters } from '../../lib/deck.js';

// Architecture ref: ARCHITECTURE_v1.0.md §5.1 (session caching), §5.3
// (filters mask, never re-query), §6 (offline queue)

const EMPTY_FILTERS = { mediaType: null, genres: [], decades: [] };

export default function SwipeScreen({ room, user, partner, devMode }) {
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const cached = loadCachedDeck(room.id, user.id);
      if (cached) {
        if (!cancelled) {
          setDeck(cached);
          setLoading(false);
        }
        return;
      }
      const fresh = await buildAndCacheDeck({ room, user, partner });
      if (!cancelled) {
        setDeck(fresh);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // room/user/partner are re-fetched objects from the parent on every
    // render (getMyRoomState returns fresh objects each call), so
    // depending on their identity would refetch on every render rather
    // than only when the actual room/user/partner changes. The ids are
    // the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, user.id, partner?.id]);

  // §6: flush the offline queue on focus/reconnect.
  useEffect(() => {
    const trySync = async () => {
      const { remaining } = await flushSwipeQueue();
      setPendingSync(remaining);
    };
    setPendingSync(queuedSwipeCount());
    trySync();
    window.addEventListener('online', trySync);
    window.addEventListener('focus', trySync);
    return () => {
      window.removeEventListener('online', trySync);
      window.removeEventListener('focus', trySync);
    };
  }, []);

  const filteredCards = useMemo(() => {
    if (!deck) return [];
    const hasFilters = filters.mediaType || filters.genres.length || filters.decades.length;
    return hasFilters ? applyFilters(deck.cards, filters) : deck.cards;
  }, [deck, filters]);

  if (loading) {
    return <div className="tabscreen tabscreen--loading" aria-busy="true" />;
  }

  return (
    <div className="swipescreen">
      <div className="swipescreen__bar">
        <button className="filter-toggle" onClick={() => setFilterOpen(true)}>
          Filters
          {(filters.genres.length > 0 || filters.decades.length > 0 || filters.mediaType) && ' •'}
        </button>
        {pendingSync > 0 && (
          <span className="sync-note">{pendingSync} swipe{pendingSync === 1 ? '' : 's'} syncing…</span>
        )}
      </div>

      <SwipeDeck
        cards={filteredCards}
        debugByKey={deck?.debugByKey}
        devMode={devMode}
        onExhausted={() => {}}
      />

      <FilterPanel
        open={filterOpen}
        filters={filters}
        onChange={setFilters}
        onClose={() => setFilterOpen(false)}
        allCards={deck?.cards || []}
      />
    </div>
  );
}
