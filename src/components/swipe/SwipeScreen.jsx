import { useEffect, useMemo, useState } from 'react';
import SwipeDeck from './SwipeDeck.jsx';
import FilterPanel from './FilterPanel.jsx';
import { buildAndCacheDeck, loadCachedDeck, flushSwipeQueue, queuedSwipeCount } from '../../lib/data.js';
import { applyFilters } from '../../lib/deck.js';
import { CONFIG } from '../../lib/config.js';

// Architecture ref: ARCHITECTURE_v1.0.md §5.1 (session caching), §5.3
// (filters mask, never re-query), §6 (offline queue), §9 (waiting state)

const EMPTY_FILTERS = { mediaType: null, genres: [], decades: [] };

export default function SwipeScreen({ room, user, partner, devMode, onOpenSettings }) {
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
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
      } catch (err) {
        // Previously this threw into an unhandled rejection and left the
        // screen stuck on the loading state forever, with the real cause
        // only in the console.
        if (!cancelled) {
          setLoadError(err.message || 'Could not build your deck.');
          setLoading(false);
        }
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

  const hasFilters = Boolean(
    filters.mediaType || filters.genres.length || filters.decades.length
  );

  const filteredCards = useMemo(() => {
    if (!deck) return [];
    return hasFilters ? applyFilters(deck.cards, filters) : deck.cards;
  }, [deck, filters, hasFilters]);

  if (loading) {
    return <div className="tabscreen tabscreen--loading" aria-busy="true" />;
  }

  if (loadError) {
    return (
      <div className="tabscreen tabscreen--empty">
        <p className="empty__head">Couldn't load your deck</p>
        <p className="empty__body">{loadError}</p>
      </div>
    );
  }

  // §5.3: filters that mask the deck down to almost nothing get an
  // explicit state rather than a silently empty deck.
  const starvedByFilters =
    hasFilters && filteredCards.length < CONFIG.MIN_FILTERED_DECK && deck?.cards?.length > 0;

  return (
    <div className="swipescreen">
      <div className="swipescreen__bar">
        <button className="filter-toggle" onClick={() => setFilterOpen(true)}>
          Filters{hasFilters && ' •'}
        </button>
        {pendingSync > 0 && (
          <span className="sync-note">
            {pendingSync} swipe{pendingSync === 1 ? '' : 's'} syncing…
          </span>
        )}
        <button className="gear" onClick={onOpenSettings} aria-label="Settings">
          Settings
        </button>
      </div>

      {/* Update 5: §9 calls for a waiting-for-partner state that shows
          the room code for re-sharing. It was specified and never built
          -- until now the first user got a normal-looking app with no
          hint that nothing would ever match. */}
      {!partner && (
        <div className="waiting">
          <p className="waiting__text">
            Swipe away -- nothing can match until your partner joins with code{' '}
            <span className="waiting__code">{room.code}</span> and your PIN.
          </p>
        </div>
      )}

      {starvedByFilters ? (
        <div className="deck deck--empty">
          <p className="empty__head">Not much matches those filters</p>
          <p className="empty__body">
            Only {filteredCards.length} title{filteredCards.length === 1 ? '' : 's'} left.
            Widen them to see more.
          </p>
          <button className="onboard-btn" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </button>
        </div>
      ) : (
        <SwipeDeck
          cards={filteredCards}
          debugByKey={deck?.debugByKey}
          devMode={devMode}
          onExhausted={() => {}}
        />
      )}

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
