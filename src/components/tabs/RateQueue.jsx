import { useEffect, useState } from 'react';
import { posterUrl } from '../../lib/config.js';
import { fetchWatched, fetchTitlesByKeys } from '../../lib/tabs.js';
import { fetchVerdicts, setVerdict, unratedFinished } from '../../lib/verdicts.js';

// Rating, after the fact.
//
// The verdict toast lasted four seconds and was the only chance to rate
// anything, ever. That is precisely backwards: you form the opinion
// over the following day, in the car, a week later when it comes up in
// conversation. The window was open at the one moment you had least to
// say.
//
// This is the queue that replaces it. Nothing expires.

export default function RateQueue({ room, user, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    try {
      const [watchRows, verdicts] = await Promise.all([
        fetchWatched(room.id),
        fetchVerdicts(room.id),
      ]);
      const pending = unratedFinished(watchRows, verdicts, user.id);
      const titles = await fetchTitlesByKeys(
        pending.map((w) => `${w.tmdb_id}:${w.media_type}`)
      );
      setItems(
        pending
          .map((w) => ({ w, t: titles.get(`${w.tmdb_id}:${w.media_type}`) }))
          .filter((x) => x.t)
      );
    } catch (err) {
      setError(err.message || 'Could not load.');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, user.id]);

  const rate = async (item, verdict) => {
    setBusy(`${item.w.tmdb_id}:${item.w.media_type}`);
    try {
      await setVerdict({
        roomId: room.id,
        tmdbId: item.w.tmdb_id,
        mediaType: item.w.media_type,
        userId: user.id,
        verdict,
      });
      setItems((prev) => prev.filter((x) => x !== item));
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="stats">
        <div className="pick__head">
          <h1 className="pick__title">Rate these</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (!items) return <div className="stats" aria-busy="true" />;

  return (
    <div className="stats">
      <div className="pick__head">
        <h1 className="pick__title">Rate these</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      {items.length === 0 ? (
        <div className="tabscreen__empty">
          <p className="empty__head">All caught up</p>
          <p className="empty__body">
            Nothing waiting on a verdict. These feed what your deck shows you,
            so they're worth doing when you get to them.
          </p>
        </div>
      ) : (
        <>
          <p className="settings__hint">
            Your rating, not both of yours. It only changes your deck.
          </p>
          <ul className="rowlist">
            {items.map((item) => {
              const key = `${item.w.tmdb_id}:${item.w.media_type}`;
              return (
                <li className="row" key={key}>
                  <div className="row__poster">
                    {item.t.poster_path ? (
                      <img src={posterUrl(item.t.poster_path, 'w185')} alt="" />
                    ) : (
                      <div className="row__noart">
                        {item.t.media_type === 'tv' ? 'Series' : 'Film'}
                      </div>
                    )}
                  </div>
                  <div className="row__body">
                    <p className="row__title">{item.t.title}</p>
                    <p className="row__facts">
                      {item.w.watched_on || (item.w.marked_at || '').slice(0, 10)}
                    </p>
                  </div>
                  <div className="row__actions">
                    <button
                      className="row__action"
                      disabled={busy === key}
                      onClick={() => rate(item, 'up')}
                    >
                      Liked it
                    </button>
                    <button
                      className="row__action row__action--minor"
                      disabled={busy === key}
                      onClick={() => rate(item, 'down')}
                    >
                      Not for me
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
