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

export default function TabScreen({ title, emptyHead, emptyBody, fetcher, roomId, roomPlatforms, onTonightsPick }) {
  const [rows, setRows] = useState(null);
  const [watchedKeys, setWatchedKeys] = useState(new Map());
  const [watchedOpen, setWatchedOpen] = useState(false);
  const [error, setError] = useState(null);

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
  }, [load]);

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

  const active = rows.filter((t) => !watchedKeys.has(`${t.tmdb_id}:${t.media_type}`));
  const watched = rows.filter((t) => watchedKeys.has(`${t.tmdb_id}:${t.media_type}`));

  return (
    <div className="tabscreen">
      <h1 className="tabscreen__title">{title}</h1>

      {onTonightsPick && active.length >= 2 && (
        <button className="onboard-btn onboard-btn--primary pick-cta" onClick={onTonightsPick}>
          Tonight's Pick
        </button>
      )}

      {active.length === 0 && watched.length === 0 && (
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
              watched={false}
              onWatchedChange={(v) => handleWatchedChange(`${t.tmdb_id}:${t.media_type}`, v)}
            />
          ))}
        </ul>
      )}

      {watched.length > 0 && (
        <div className="watched-section">
          <button className="watched-toggle" onClick={() => setWatchedOpen((o) => !o)}>
            {watchedOpen ? 'Hide' : 'Show'} watched ({watched.length})
          </button>
          {watchedOpen && (
            <ul className="rowlist rowlist--dim">
              {watched.map((t) => {
                const key = `${t.tmdb_id}:${t.media_type}`;
                return (
                  <TitleListItem
                    key={key}
                    title={t}
                    roomId={roomId}
                    watched
                    verdict={watchedKeys.get(key)}
                    onWatchedChange={(v) => handleWatchedChange(key, v)}
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
