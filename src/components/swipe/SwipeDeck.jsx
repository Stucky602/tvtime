import { useCallback, useEffect, useRef, useState } from 'react';
import SwipeCard from './SwipeCard.jsx';
import { CONFIG } from '../../lib/config.js';
import { submitSwipe, undoSwipe } from '../../lib/data.js';

// Architecture ref: ARCHITECTURE_v1.0.md §6 (whole section), §5.3, §9
//
// The swipe deck. §11 calls this "the component the whole app is judged
// by", and the parts that make or break it are all in the write path
// rather than the visuals:
//
//   - Optimistic UI: the card leaves immediately, the write happens
//     behind it. §6 is explicit that reversing a completed animation on
//     failure "feels broken" -- so failures queue silently instead.
//   - Undo: last swipe only, within a short window. Mis-swipes are
//     constant on touch and there is no other correction path, since a
//     swiped title never resurfaces.
//   - Gesture fallbacks: every action has a button. Gestures are the
//     primary interaction, not the only one -- this is an accessibility
//     floor and it also makes the app usable one-handed.
//
// Pointer Events rather than touch events: one code path covers touch,
// mouse, and stylus, and setPointerCapture means a drag that leaves the
// element still tracks correctly.

const COMMIT_PX = 110; // horizontal travel that commits a swipe
const FLING_VELOCITY = 0.45; // px/ms -- a fast flick commits at shorter distance

export default function SwipeDeck({ cards, debugByKey, onCardResolved, onExhausted, devMode }) {
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0, active: false });
  const [leaving, setLeaving] = useState(null);
  const [match, setMatch] = useState(false);
  const [undoable, setUndoable] = useState(null);
  const [queuedNotice, setQueuedNotice] = useState(false);

  const pointerRef = useRef({ id: null, startX: 0, startY: 0, startT: 0 });
  const undoTimer = useRef(null);

  const current = cards[index];
  const next = cards[index + 1];

  useEffect(() => {
    if (!current && cards.length > 0) onExhausted?.();
  }, [current, cards.length, onExhausted]);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const commit = useCallback(
    async (direction) => {
      const title = cards[index];
      if (!title) return;

      // Card animates out first, unconditionally. The write follows.
      setLeaving(direction);
      setDrag({ dx: 0, dy: 0, active: false });

      const result = await submitSwipe({
        tmdb_id: title.tmdb_id,
        media_type: title.media_type,
        direction,
        score_debug: debugByKey?.[`${title.tmdb_id}:${title.media_type}`] ?? null,
      });

      if (result.queued) {
        // §6: don't reverse the animation. Tell them quietly instead --
        // the swipe is saved locally and will sync.
        setQueuedNotice(true);
        setTimeout(() => setQueuedNotice(false), 2600);
      }

      if (result.is_new_match) {
        setMatch(true);
        setTimeout(() => setMatch(false), CONFIG.MATCH_INDICATOR_MS);
      }

      onCardResolved?.(title, direction, result);

      setIndex((i) => i + 1);
      setLeaving(null);

      // §6: undo is available briefly. Deleting the swipe row also
      // retracts a match for free, since Together is a view over swipes.
      setUndoable({ title, direction });
      clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(
        () => setUndoable(null),
        CONFIG.UNDO_WINDOW_SECONDS * 1000
      );
    },
    [cards, index, debugByKey, onCardResolved]
  );

  const handleUndo = useCallback(async () => {
    if (!undoable) return;
    const { title } = undoable;
    setUndoable(null);
    clearTimeout(undoTimer.current);

    const res = await undoSwipe({
      tmdb_id: title.tmdb_id,
      media_type: title.media_type,
    });
    if (res?.status === 'OK') {
      setIndex((i) => Math.max(0, i - 1));
      setMatch(false);
    }
    // On EXPIRED there is deliberately no message: the button is already
    // gone by then in normal use, and explaining a race the user did not
    // perceive is noise.
  }, [undoable]);

  // ---- pointer drag ----

  const onPointerDown = (e) => {
    if (leaving) return;
    pointerRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ dx: 0, dy: 0, active: true });
  };

  const onPointerMove = (e) => {
    if (pointerRef.current.id !== e.pointerId || !drag.active) return;
    const dx = e.clientX - pointerRef.current.startX;
    // Vertical travel is damped hard: this is a horizontal gesture, and
    // letting the card follow a finger vertically makes it feel loose.
    const dy = (e.clientY - pointerRef.current.startY) * 0.25;
    setDrag({ dx, dy, active: true });
  };

  const onPointerUp = (e) => {
    if (pointerRef.current.id !== e.pointerId) return;
    const dx = e.clientX - pointerRef.current.startX;
    const elapsed = Math.max(1, performance.now() - pointerRef.current.startT);
    const velocity = Math.abs(dx) / elapsed;

    pointerRef.current.id = null;

    // A short fast flick should commit as readily as a long slow drag --
    // matching either alone feels unresponsive in the other case.
    const committed = Math.abs(dx) > COMMIT_PX || velocity > FLING_VELOCITY;
    if (committed && Math.abs(dx) > 30) {
      commit(dx > 0 ? 'right' : 'left');
    } else {
      setDrag({ dx: 0, dy: 0, active: false });
    }
  };

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') commit('right');
      else if (e.key === 'ArrowLeft') commit('left');
      else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) handleUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, handleUndo]);

  if (!current) {
    // §9: an exhausted deck gets an explicit state, never a blank screen.
    return (
      <div className="deck deck--empty">
        <p className="empty__head">That's everything for now</p>
        <p className="empty__body">
          You've swiped through every title on your services. New ones arrive
          overnight, or widen your filters to see more.
        </p>
      </div>
    );
  }

  const dx = leaving ? (leaving === 'right' ? 600 : -600) : drag.dx;

  return (
    <div className="deck">
      <div className="deck__stack">
        {next && <SwipeCard title={next} isNext dx={drag.dx} />}
        <div
          className="deck__hit"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <SwipeCard
            title={current}
            dx={dx}
            dy={leaving ? 0 : drag.dy}
            dragging={drag.active}
          />
        </div>

        {match && (
          <div className="match" role="status">
            <span className="match__word">Match</span>
            <span className="match__sub">You both want to watch this</span>
          </div>
        )}
      </div>

      {devMode && debugByKey && (
        <pre className="devscore">
          {JSON.stringify(debugByKey[`${current.tmdb_id}:${current.media_type}`] ?? {}, null, 1)}
        </pre>
      )}

      {/* §6: every gesture needs a button equivalent. */}
      <div className="controls">
        <button
          className="ctl ctl--no"
          onClick={() => commit('left')}
          aria-label={`Pass on ${current.title}`}
        >
          Pass
        </button>

        <button
          className="ctl ctl--undo"
          onClick={handleUndo}
          disabled={!undoable}
          aria-label="Undo last swipe"
        >
          Undo
        </button>

        <button
          className="ctl ctl--yes"
          onClick={() => commit('right')}
          aria-label={`Yes to ${current.title}`}
        >
          Yes
        </button>
      </div>

      {queuedNotice && (
        <p className="notice" role="status">
          Saved on this device. It'll sync when you're back online.
        </p>
      )}
    </div>
  );
}
