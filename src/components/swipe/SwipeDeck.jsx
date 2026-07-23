import { useCallback, useEffect, useRef, useState } from 'react';
import SwipeCard from './SwipeCard.jsx';
import { CONFIG } from '../../lib/config.js';
import { submitSwipe, undoSwipe } from '../../lib/data.js';
import { hapticThreshold, hapticCommit, hapticUndo, hapticMatch } from '../../lib/haptics.js';
import { lockAxis, dragState, shouldCommit, commitDistance, swipeDirection } from '../../lib/gesture.js';

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
//
// ---------------------------------------------------------------------
// UPDATE 1: gesture sensitivity rework
// ---------------------------------------------------------------------
// Reported symptom: "barely touching the screen" cast a vote. The cause
// was the commit test:
//
//     const committed = Math.abs(dx) > COMMIT_PX || velocity > FLING_VELOCITY;
//     if (committed && Math.abs(dx) > 30) { ... }
//
// The fling arm only required 30px of travel, and velocity was computed
// over the whole gesture with a 1ms floor -- so a 31px twitch in 60ms
// scored 0.52 px/ms and cleared the 0.45 threshold. Putting a thumb
// down with any drift, or starting a vertical scroll, voted on a title
// permanently. Four changes:
//
//   1. DEAD ZONE. The card does not move at all until the finger has
//      travelled past SWIPE_DEAD_ZONE_PX. Below that it is a tap, not a
//      drag, and taps must never vote.
//   2. DIRECTION LOCK. Horizontal travel has to beat vertical by
//      SWIPE_DIRECTION_LOCK before the gesture is treated as a swipe at
//      all, and a clearly-vertical gesture aborts outright. A scroll can
//      no longer bleed into a vote.
//   3. THRESHOLD SCALES WITH THE CARD. 30% of card width rather than a
//      fixed pixel count, so it feels identical on a small phone and a
//      tablet, with a floor for very narrow screens.
//   4. FLING NEEDS REAL TRAVEL. A flick still commits early, but only
//      after SWIPE_FLING_MIN_PX (90px), and velocity is now measured
//      over the last ~80ms of movement rather than the whole gesture --
//      so a slow drag that ends with a tiny jerk no longer reads as a
//      fling.
//
// Net effect: a deliberate swipe feels the same, and an accidental one
// is close to impossible.

// Velocity is sampled over a trailing window rather than the full
// gesture. Total-elapsed velocity is wrong for this: drag slowly for a
// second, twitch 5px at the end, and the average is meaningless while
// the instantaneous flick is what the user actually did.
const VELOCITY_WINDOW_MS = 80;

export default function SwipeDeck({ cards, debugByKey, onCardResolved, onExhausted, devMode }) {
  const [index, setIndex] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0, active: false });
  const [leaving, setLeaving] = useState(null);
  const [match, setMatch] = useState(false);
  const [undoable, setUndoable] = useState(null);
  const [queuedNotice, setQueuedNotice] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const stackRef = useRef(null);
  const undoTimer = useRef(null);
  const crossedThreshold = useRef(false);

  // Full gesture state. A ref rather than state because it updates on
  // every pointermove and must not trigger a re-render on its own.
  const gesture = useRef({
    id: null,
    startX: 0,
    startY: 0,
    startT: 0,
    // Locked ONCE at SWIPE_AXIS_LOCK_PX of travel, then permanent for
    // the life of this touch. 'y' means the card is inert -- it cannot
    // move or vote regardless of what the finger does afterwards.
    axis: null,
    // 'pending'  -- touching, but not yet established as a swipe
    // 'dragging' -- confirmed horizontal drag, card follows the finger
    // 'inert'    -- vertical gesture; nothing this touch does matters
    phase: 'idle',
    sampleX: 0,
    sampleT: 0,
  });

  const current = cards[index];
  const next = cards[index + 1];

  // Collapse an expanded synopsis whenever the card changes -- carrying
  // the expanded state onto the next title would hide its poster for no
  // reason.
  useEffect(() => {
    setExpanded(false);
  }, [index]);

  useEffect(() => {
    if (!current && cards.length > 0) onExhausted?.();
  }, [current, cards.length, onExhausted]);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  /** Card width drives the commit threshold (see lib/gesture.js). */
  const cardWidth = useCallback(() => stackRef.current?.offsetWidth || 360, []);

  const commit = useCallback(
    async (direction) => {
      const title = cards[index];
      if (!title) return;

      hapticCommit();

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
        hapticMatch();
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
    hapticUndo();

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
    gesture.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
      axis: null,
      phase: 'pending',
      sampleX: e.clientX,
      sampleT: performance.now(),
    };
    crossedThreshold.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (g.id !== e.pointerId || g.phase === 'idle' || g.phase === 'inert') return;

    const rawDx = e.clientX - g.startX;
    const rawDy = e.clientY - g.startY;

    // Decide the axis exactly once, then never revisit it. Re-deriving
    // direction on every move is what let a vertical scroll drift into
    // a swipe and throw the card.
    if (g.axis === null) {
      const axis = lockAxis(rawDx, rawDy);
      if (axis === null) return; // undecided; card stays completely still
      g.axis = axis;
      if (axis === 'y') {
        // Vertical, permanently. Nothing else this touch does can move
        // or vote on the card.
        g.phase = 'inert';
        return;
      }
    }

    const state = dragState(g.axis, rawDx);
    if (state !== 'dragging') return; // inside the dead zone; card inert
    g.phase = 'dragging';

    // Trailing-window velocity sample.
    const now = performance.now();
    if (now - g.sampleT > VELOCITY_WINDOW_MS) {
      g.sampleX = e.clientX;
      g.sampleT = now;
    }

    // The card no longer follows the finger vertically AT ALL. It used
    // to track dy * 0.25, which meant a mostly-vertical drag still
    // visibly dragged the card around -- reinforcing the impression
    // that a vertical gesture was doing something to it. Horizontal
    // gestures move the card horizontally; that is the whole vocabulary.
    const dy = 0;

    // One light tick the moment the card passes the commit threshold, so
    // you can feel where the line is without watching the screen.
    const past = Math.abs(rawDx) > commitDistance(cardWidth());
    if (past && !crossedThreshold.current) {
      crossedThreshold.current = true;
      hapticThreshold();
    } else if (!past && crossedThreshold.current) {
      crossedThreshold.current = false;
    }

    setDrag({ dx: rawDx, dy, active: true });
  };

  const onPointerUp = (e, cancelled = false) => {
    const g = gesture.current;
    if (g.id !== e.pointerId) return;

    const wasDragging = g.phase === 'dragging';
    const dx = e.clientX - g.startX;

    // Velocity over the trailing window, not the whole gesture.
    const elapsed = Math.max(16, performance.now() - g.sampleT);
    const velocity = Math.abs(e.clientX - g.sampleX) / elapsed;

    gesture.current = { ...g, id: null, axis: null, phase: 'idle' };
    crossedThreshold.current = false;

    if (!wasDragging || cancelled) {
      // A tap, a vertical gesture, or -- critically -- a pointercancel.
      // Cancel means the BROWSER took the gesture over to scroll, not
      // that the user finished a swipe. Treating cancel like a normal
      // release is how holding and scrolling ended up throwing the card.
      setDrag({ dx: 0, dy: 0, active: false });
      return;
    }

    if (shouldCommit({ dx, velocity, cardWidth: cardWidth(), phase: 'dragging', cancelled })) {
      commit(swipeDirection(dx));
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
  const remaining = cards.length - index;

  return (
    <div className="deck">
      <div className="deck__stack" ref={stackRef}>
        {next && <SwipeCard title={next} isNext dx={drag.dx} />}
        <div
          className="deck__hit"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => onPointerUp(e, true)}
        >
          <SwipeCard
            title={current}
            dx={dx}
            dy={leaving ? 0 : drag.dy}
            dragging={drag.active}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
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

      {/* Update 5: how much is left, so an empty deck is never a surprise. */}
      <p className="deck__progress">
        {remaining} {remaining === 1 ? 'title' : 'titles'} left
        {undoable && <span className="deck__undohint"> · undo available</span>}
      </p>

      {queuedNotice && (
        <p className="notice" role="status">
          Saved on this device. It'll sync when you're back online.
        </p>
      )}
    </div>
  );
}
