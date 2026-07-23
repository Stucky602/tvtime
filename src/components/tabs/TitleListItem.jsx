import { useRef, useState } from 'react';
import { posterUrl, CONFIG } from '../../lib/config.js';
import { markWatched, unmarkWatched } from '../../lib/tabs.js';
import { watchTarget } from '../../lib/links.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2.4, §6 (gesture fallback pattern)
//
// One row in Together/Solo/Pending/Watched. §2.4: "a swipe-up gesture on
// a Together or Solo card marks watched. Also available from the detail
// view for anyone who does not discover the gesture" -- so the button is
// not a secondary option, it's the documented alternative, same as the
// Pass/Yes buttons in the swipe deck.

export default function TitleListItem({ title, roomId, roomPlatforms = [], watched = false, verdict, onWatchedChange }) {
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [busy, setBusy] = useState(false);
  const startRef = useRef(0);

  const commitWatch = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // §2.4 v0.4: the mark completes immediately and unconditionally --
      // the toast is what's optional, not the mark itself.
      await markWatched(title.tmdb_id, title.media_type, null);
      onWatchedChange?.(true);
      setShowToast(true);
      setTimeout(() => setShowToast(false), CONFIG.VERDICT_TOAST_SECONDS * 1000);
    } finally {
      setBusy(false);
      setDy(0);
    }
  };

  const commitUnwatch = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await unmarkWatched(roomId, title.tmdb_id, title.media_type);
      onWatchedChange?.(false);
    } finally {
      setBusy(false);
    }
  };

  const giveVerdict = async (v) => {
    setShowToast(false);
    await markWatched(title.tmdb_id, title.media_type, v);
  };

  const onPointerDown = (e) => {
    if (watched) return;
    startRef.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    // Upward only -- clamp positive travel so a downward drag does
    // nothing rather than fighting the list's own scroll.
    const delta = Math.min(0, e.clientY - startRef.current);
    setDy(delta);
  };
  const onPointerUp = () => {
    setDragging(false);
    if (dy < -70) commitWatch();
    else setDy(0);
  };

  const leak = Math.min(1, Math.abs(dy) / 90);

  return (
    <li
      className={`row ${watched ? 'row--watched' : ''}`}
      style={{ transform: `translateY(${dy}px)`, opacity: 1 - leak * 0.3 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="row__poster">
        {title.poster_path ? (
          <img src={posterUrl(title.poster_path, 'w185')} alt="" draggable="false" />
        ) : (
          <div className="row__noart">{title.media_type === 'tv' ? 'Series' : 'Film'}</div>
        )}
      </div>

      <div className="row__body">
        <p className="row__title">{title.title}</p>
        <p className="row__facts">
          {[title.year, title.runtime ? `${title.runtime} min` : null, title.media_type === 'tv' ? 'Series' : 'Film']
            .filter(Boolean)
            .join(' · ')}
        </p>
        {title.providers?.length > 0 && (
          <p className="row__providers">{title.providers.join(', ')}</p>
        )}
        {(() => {
          const t = watchTarget(title, roomPlatforms);
          return t ? (
            <a
              className="row__watch"
              href={t.url}
              target="_blank"
              rel="noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {t.label}
            </a>
          ) : null;
        })()}
        {watched && verdict && (
          <p className={`row__verdict row__verdict--${verdict}`}>
            {verdict === 'up' ? 'Liked it' : 'Not for us'}
          </p>
        )}
      </div>

      <button
        className="row__action"
        onClick={() => (watched ? commitUnwatch() : commitWatch())}
        disabled={busy}
        aria-label={watched ? `Unmark ${title.title} as watched` : `Mark ${title.title} as watched`}
      >
        {watched ? 'Unmark' : 'Watched'}
      </button>

      {showToast && (
        <div className="row__toast" role="status">
          <span>How was it?</span>
          <button onClick={() => giveVerdict('up')} aria-label="Liked it">👍</button>
          <button onClick={() => giveVerdict('down')} aria-label="Not for us">👎</button>
        </div>
      )}
    </li>
  );
}
