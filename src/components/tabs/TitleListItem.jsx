import { useState } from 'react';
import { posterUrl, CONFIG } from '../../lib/config.js';
import { markWatched, unmarkWatched, setWatchStatus } from '../../lib/tabs.js';
import { commitmentLabel, commitmentTier, STATUS, STATUS_LABEL } from '../../lib/lifecycle.js';
import { addNote } from '../../lib/notes.js';
import { addPlan } from '../../lib/plans.js';
import { KIND } from '../../lib/notes-pure.js';
import { watchTarget } from '../../lib/links.js';

// Architecture ref: ARCHITECTURE_v1.0.md §2.4, §6 (gesture fallback pattern)
//
// One row in Together/Solo/Pending/Watched. §2.4: "a swipe-up gesture on
// a Together or Solo card marks watched. Also available from the detail
// view for anyone who does not discover the gesture" -- so the button is
// not a secondary option, it's the documented alternative, same as the
// Pass/Yes buttons in the swipe deck.

export default function TitleListItem({
  title, roomId, roomPlatforms = [], watched = false, verdict,
  onWatchedChange, watchRow, userId, onStatusChange, notes = [],
}) {
  const [showToast, setShowToast] = useState(false);
  const [busy, setBusy] = useState(false);

  const sendNote = async (kind) => {
    const prompt = kind === KIND.BOOST
      ? 'Say something about it (optional)'
      : 'Anything to add? (optional)';
    const body = window.prompt(prompt) ?? '';
    if (body === null) return;
    setBusy(true);
    try {
      await addNote({
        roomId, tmdbId: title.tmdb_id, mediaType: title.media_type,
        authorId: userId, kind, body,
      });
      onStatusChange?.('noted');
    } finally {
      setBusy(false);
    }
  };

  const transition = async (status, company) => {
    if (busy) return;
    setBusy(true);
    try {
      await setWatchStatus({
        roomId, tmdbId: title.tmdb_id, mediaType: title.media_type,
        userId, status, company,
      });
      onStatusChange?.(status);
      // Only a finish is worth asking about. Nobody wants to rate
      // something they just started, and rating something they gave up
      // on is a question with an obvious answer.
      if (status === STATUS.FINISHED) {
        setShowToast(true);
        setTimeout(() => setShowToast(false), CONFIG.VERDICT_TOAST_SECONDS * 1000);
      }
    } finally {
      setBusy(false);
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



  return (
    <li
      className={`row ${watched ? 'row--watched' : ''}`}
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
        {commitmentLabel(title) && (
          <p className={`row__commit row__commit--${commitmentTier(title) || 'unknown'}`}>
            {commitmentLabel(title)}
          </p>
        )}
        {title.providers?.length > 0 && (
          <p className="row__providers">{title.providers.join(', ')}</p>
        )}
        {watchRow?.status === STATUS.WATCHING && (
          <p className="row__verdict row__verdict--pending">
            {STATUS_LABEL.watching}
            {watchRow.progress_note ? ` · ${watchRow.progress_note}` : ''}
          </p>
        )}
        {notes.length > 0 && (
          <p className="row__note">
            {notes[0].body || 'Left you a note'}
          </p>
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

      <div className="row__actions">
        {/* Lifecycle, not a boolean. "Started" is the state the old
            model could not express, and it is the one that makes a
            60-hour series make sense. */}
        {!watchRow && (
          <>
            <button
              className="row__action"
              disabled={busy}
              onClick={() => transition(STATUS.WATCHING)}
              aria-label={`Mark ${title.title} as started`}
            >
              Started
            </button>
            <button
              className="row__action"
              disabled={busy}
              onClick={() => transition(STATUS.FINISHED, 'together')}
              aria-label={`Mark ${title.title} as finished together`}
            >
              Finished
            </button>
            {/* Solo watches used to vanish. `watched` is room-scoped, so
                a film watched alone had nowhere to go, which made Solo
                the one tab with no follow-through. */}
            <button
              className="row__action row__action--minor"
              disabled={busy}
              onClick={() => transition(STATUS.FINISHED, 'alone')}
              aria-label={`Mark ${title.title} as watched alone`}
            >
              Alone
            </button>
          </>
        )}
        {watchRow?.status === STATUS.WATCHING && (
          <>
            <button
              className="row__action"
              disabled={busy}
              onClick={() => transition(STATUS.FINISHED)}
            >
              Finished
            </button>
            <button
              className="row__action"
              disabled={busy}
              onClick={() => transition(STATUS.ABANDONED)}
            >
              Gave up
            </button>
          </>
        )}
        {/* The note primitive, surfaced as the two things people
            actually want to say. Both are the same row in the same
            table; only the presentation differs. */}
        {!watchRow && userId && (
          <button
            className="row__action row__action--plan"
            disabled={busy}
            onClick={async () => {
              const when = window.prompt(
                'When? Leave blank for tonight, or YYYY-MM-DD for an occasion.'
              );
              if (when === null) return;
              setBusy(true);
              try {
                await addPlan({
                  roomId, tmdbId: title.tmdb_id, mediaType: title.media_type,
                  userId, plannedFor: /^\d{4}-\d{2}-\d{2}$/.test(when.trim()) ? when.trim() : null,
                });
                onStatusChange?.('planned');
              } finally {
                setBusy(false);
              }
            }}
          >
            Plan it
          </button>
        )}
        {!watchRow && userId && (
          <>
            <button
              className="row__action row__action--minor"
              disabled={busy}
              onClick={() => sendNote(KIND.BOOST)}
              aria-label={`Ask your partner to look at ${title.title}`}
            >
              Nudge
            </button>
            <button
              className="row__action row__action--minor"
              disabled={busy}
              onClick={() => sendNote(KIND.BLESSING)}
              aria-label={`Tell your partner to watch ${title.title} without you`}
            >
              Go ahead
            </button>
          </>
        )}
        {(watchRow?.status === STATUS.FINISHED || watchRow?.status === STATUS.ABANDONED) && (
          <button
            className="row__action"
            onClick={() => commitUnwatch()}
            disabled={busy}
            aria-label={`Clear watch status for ${title.title}`}
          >
            Clear
          </button>
        )}
      </div>

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
