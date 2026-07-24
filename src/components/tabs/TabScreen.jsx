import { useCallback, useEffect, useState } from 'react';
import TitleListItem from './TitleListItem.jsx';
import { fetchWatched } from '../../lib/tabs.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2, §2.4, §6.5 (poll on focus)
//
// Shared shell for Together, Solo, and Pending. Each of those is "fetch
// a bucket, split into still-active vs already-watched, render both" --
// the only thing that differs between the three call sites is the
// fetcher function and the copy in the empty state.
//
// §2.4: watched titles move to a collapsed section, they are not
// deleted from the tab -- the underlying bucket query has no idea
// what's watched (that's a separate table), so the split happens here
// on the client after both queries return.

export default function TabScreen({
  title,
  emptyHead,
  emptyBody,
  fetcher,
  roomId,
  roomPlatforms,
  onTonightsPick,
  // Increments when a partner swipe lands. We re-read rather than
  // applying the event payload -- realtime is an accelerator here, not
  // a source of truth.
  pulse = 0,
  // When true this tab shows ONLY watched titles (the new Watched tab);
  // otherwise watched titles are hidden entirely, because they now have
  // a home of their own rather than a collapsed section at the bottom.
  watchedOnly = false,
}) {
  const [rows, setRows] = useState(null);
  const [watchedKeys, setWatchedKeys] = useState(new Map());
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');

  const load = useCallback(async () => {
    try {
      const [bucketRows, watchedRows] = await Promise.all([fetcher(), fetchWatched(roomId)]);
      setRows(bucketRows);
      setWatchedKeys(
        new Map(watchedRows.map((w) => [`${w.tmdb_id}:${w.media_type}`, w.verdict]))
      );
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load this tab.');
    }
  }, [fetcher, roomId]);

  useEffect(() => {
    load();
    // §6.5: badges and tab content refresh on focus rather than a
    // realtime subscription -- the product has no push notifications
    // and a standing channel is a complexity tax this scale doesn't need.
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load, pulse]);

  const handleWatchedChange = (key, nowWatched) => {
    setWatchedKeys((prev) => {
      const next = new Map(prev);
      if (nowWatched) next.set(key, null);
      else next.delete(key);
      return next;
    });
  };

  if (error) {
    return (
      <div className="tabscreen tabscreen--empty">
        <p className="empty__head">Couldn't load this tab</p>
        <p className="empty__body">{error}</p>
      </div>
    );
  }

  if (rows === null) {
    return <div className="tabscreen tabscreen--loading" aria-busy="true" />;
  }

  const inScope = rows.filter((t) => {
    const isWatched = watchedKeys.has(`${t.tmdb_id}:${t.media_type}`);
    return watchedOnly ? isWatched : !isWatched;
  });

  // Feature 6: at 100+ matches an append-only list is a wall. Search and
  // sort make it navigable; both are local to already-fetched rows, so
  // they're instant and cost no round trip.
  const active = inScope
    .filter((t) => (q.trim() ? t.title.toLowerCase().includes(q.trim().toLowerCase()) : true))
    .sort((a, b) => {
      if (sort === 'rating') return (b.rating ?? 0) - (a.rating ?? 0);
      if (sort === 'runtime') return (a.runtime ?? 9999) - (b.runtime ?? 9999);
      if (sort === 'title') return a.title.localeCompare(b.title);
      return 0; // 'recent' -- server order, which is already newest-first
    });

  return (
    <div className="tabscreen">
      <h1 className="tabscreen__title">{title}</h1>

      {onTonightsPick && active.length >= 2 && (
        <button className="onboard-btn onboard-btn--primary pick-cta" onClick={onTonightsPick}>
          Tonight's Pick
        </button>
      )}

      {inScope.length > 6 && (
        <div className="tabtools">
          <input
            className="tabtools__search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${title.toLowerCase()}`}
            aria-label={`Search ${title}`}
          />
          <div className="filter-row filter-row--wrap">
            {[
              ['recent', 'Recent'],
              ['rating', 'Rating'],
              ['runtime', 'Shortest'],
              ['title', 'A-Z'],
            ].map(([k, label]) => (
              <button
                key={k}
                className={`filter-chip ${sort === k ? 'filter-chip--on' : ''}`}
                onClick={() => setSort(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {q.trim() && active.length === 0 && inScope.length > 0 && (
        <p className="settings__hint">Nothing here matches "{q.trim()}".</p>
      )}

      {inScope.length === 0 && (
        <div className="tabscreen__empty">
          <p className="empty__head">{emptyHead}</p>
          <p className="empty__body">{emptyBody}</p>
        </div>
      )}

      {active.length > 0 && (
        <ul className="rowlist">
          {active.map((t) => (
            <TitleListItem
              key={`${t.tmdb_id}:${t.media_type}`}
              title={t}
              roomId={roomId}
              roomPlatforms={roomPlatforms}
              watched={watchedOnly}
              onWatchedChange={(v) => handleWatchedChange(`${t.tmdb_id}:${t.media_type}`, v)}
            />
          ))}
        </ul>
      )}

          </div>
  );
}
