import { useEffect, useMemo, useRef, useState } from 'react';
import SwipeDeck from './SwipeDeck.jsx';
import FilterPanel from './FilterPanel.jsx';
import {
  buildAndCacheDeck,
  loadCachedDeck,
  flushSwipeQueue,
  queuedSwipeCount,
  loadSwipedKeys,
  addSwipedKey,
  removeSwipedKey,
} from '../../lib/data.js';
import { applyFilters } from '../../lib/deck.js';
import { partnerActivity } from '../../lib/tabs.js';
import IntentBar from './IntentBar.jsx';
import { findIntent, filterByCommitment } from '../../lib/intent.js';
import { commitmentHours } from '../../lib/lifecycle.js';
import { hasSecret } from '../../lib/secret-gesture.js';
import { updateSessionPresets } from '../../lib/room.js';
import { CONFIG } from '../../lib/config.js';
import { EMPTY_FILTERS as EMPTY, hasActiveFilters } from '../../lib/filters.js';

// Architecture ref: ARCHITECTURE_v1.0.md §5.1 (session caching), §5.3
// (filters mask, never re-query), §6 (offline queue), §9 (waiting state)

const EMPTY_FILTERS = EMPTY;

export default function SwipeScreen({ room, user, partner, devMode, onOpenSettings, onOpenStats, onOpenSearch, onOpenRecap, onOpenSecret, onKnockComplete, presentPartners = [], liveConnection = false }) {
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [activity, setActivity] = useState(null);
  const [intentId, setIntentId] = useState(null);
  // Hidden entry point. Seven deliberate taps on the titles-left counter
  // within a few seconds. Chosen because the counter is always on screen,
  // is not a button, and nobody taps a status line by accident -- so it
  // is findable if you have been told and invisible if you have not.
  const [knock, setKnock] = useState({ n: 0, at: 0 });
  const [presets, setPresets] = useState(user?.session_presets || []);

  // Captured ONCE per mount. Cards swiped in previous visits to this tab
  // are filtered out here so the deck resumes where it left off; cards
  // swiped during THIS visit are handled by SwipeDeck's own index, so
  // this set deliberately does not update mid-session (that would make
  // the list shift under the index and skip cards).
  const swipedAtMount = useRef(new Set());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        swipedAtMount.current = loadSwipedKeys(room.id, user.id);
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

  // Partner digest, read once per mount. Uses the Swipe tab's own
  // last-seen marker so it means "since you last opened this".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = user?.tab_seen_at?.swipe;
      const a = await partnerActivity(partner?.id, since);
      if (!cancelled) setActivity(a);
    })();
    return () => {
      cancelled = true;
    };
  }, [partner?.id, user?.tab_seen_at?.swipe]);

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

  const hasFilters = hasActiveFilters(filters);

  const intent = findIntent(intentId, presets);

  const filteredCards = useMemo(() => {
    if (!deck) return [];
    const unswiped = deck.cards.filter(
      (c) => !swipedAtMount.current.has(`${c.tmdb_id}:${c.media_type}`)
    );
    const base = hasFilters ? applyFilters(unswiped, filters) : unswiped;
    // Commitment is the one dimension applyFilters cannot express: it
    // needs episode count times runtime, which is derived rather than
    // stored. Applied separately so the filter layer stays a pure
    // predicate over title rows.
    const cap = intent && typeof intent.derive === 'function'
      ? intent.derive().maxCommitmentHours
      : intent?.filters?.maxCommitmentHours;
    return filterByCommitment(base, cap, commitmentHours);
  }, [deck, filters, hasFilters, intent]);

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
        {liveConnection && presentPartners.length > 0 && (
          <span className="presence" role="status">
            <span className="presence__dot" aria-hidden="true" />
            {presentPartners[0].display_name || 'Your partner'} is here
          </span>
        )}
        {pendingSync > 0 && (
          <span className="sync-note">
            {pendingSync} swipe{pendingSync === 1 ? '' : 's'} syncing…
          </span>
        )}
        <button className="gear" onClick={onOpenSearch} aria-label="Search titles">
          Search
        </button>
        <button className="gear" onClick={onOpenStats} aria-label="Stats">
          Stats
        </button>
        <button className="gear" onClick={onOpenRecap} aria-label="Your year">
          Year
        </button>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings">
          Settings
        </button>
      </div>

      {/* Update 5: §9 calls for a waiting-for-partner state that shows
          the room code for re-sharing. It was specified and never built
          -- until now the first user got a normal-looking app with no
          hint that nothing would ever match. */}
      <IntentBar
        activeIntent={intentId}
        savedPresets={presets}
        currentFilters={filters}
        onPick={(id, derived) => {
          setIntentId(id);
          // An intent IS a filter set, so it writes through to the same
          // state rather than becoming a parallel narrowing mechanism.
          setFilters(derived || EMPTY_FILTERS);
        }}
        onSavePreset={async (preset) => {
          const next = [...presets, preset].slice(0, 8);
          setPresets(next);
          try {
            await updateSessionPresets(user.id, next);
          } catch {
            /* a preset that fails to persist still works this session */
          }
        }}
      />

      {partner && activity && activity.swipes >= 3 && (
        <div className="waiting waiting--activity">
          <p className="waiting__text">
            {partner.display_name} swiped {activity.swipes} title
            {activity.swipes === 1 ? '' : 's'} since you were last here
            {activity.yes > 0 ? ` — ${activity.yes} yes` : ''}.
          </p>
        </div>
      )}

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
          roomPlatforms={room.platforms}
          resetKey={JSON.stringify(filters)}
          secretUnlocked={hasSecret()}
          onOpenSecret={onOpenSecret}
          onKnock={() => {
            const now = Date.now();
            // Reset if the taps got slow: this should require intent,
            // not a stray double-tap two minutes apart.
            const n = now - knock.at > 1800 ? 1 : knock.n + 1;
            setKnock({ n, at: now });
            if (n >= 7) {
              setKnock({ n: 0, at: 0 });
              onKnockComplete?.();
            }
          }}
          onCardResolved={(t) => addSwipedKey(room.id, user.id, `${t.tmdb_id}:${t.media_type}`)}
          onCardUndone={(t) => removeSwipedKey(room.id, user.id, `${t.tmdb_id}:${t.media_type}`)}
          onExhausted={() => {}}
        />
      )}

      <FilterPanel
        open={filterOpen}
        filters={filters}
        onChange={setFilters}
        onClose={() => setFilterOpen(false)}
        allCards={filteredCards}
        roomPlatforms={room.platforms}
      />
    </div>
  );
}
