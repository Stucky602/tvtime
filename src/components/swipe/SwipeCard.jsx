import { useState } from 'react';
import { posterUrl } from '../../lib/config.js';

// Architecture ref: ARCHITECTURE_v1.0.md §4.3 (missing posters, runtime,
// year), §6 (gesture feel)
//
// One card. Purely presentational -- drag state is owned by SwipeDeck and
// passed down, so the deck can render the next card underneath without
// this component knowing anything about the stack.
//
// The signature interaction lives here: as the card is dragged, a
// light-leak edge glows along the leading side -- amber right, cold slate
// left. It's readable peripherally, which matters because the actual use
// case is two people half-watching their own screens while talking to
// each other.
//
// Update 3: the synopsis is now expandable. Previously the meta block
// was capped at 38% of card height with `overflow-y: auto`, so a long
// synopsis became a tiny internal scroll area that fought the swipe
// gesture for the same touch. Now it clamps to three lines with a
// "More" affordance, and expanding it grows the panel over the poster
// instead of introducing a nested scroller.

export default function SwipeCard({
  title,
  dx = 0,
  dy = 0,
  dragging = false,
  isNext = false,
  expanded = false,
  onToggleExpand,
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const poster = posterUrl(title.poster_path);

  // Rotation is tied to horizontal travel, capped so the card never
  // reads as spinning. Divisor chosen by feel: a full-width drag lands
  // around 12 degrees, enough to feel physical, short of theatrical.
  const rotation = Math.max(-12, Math.min(12, dx / 14));
  const verdict = dx > 40 ? 'yes' : dx < -40 ? 'no' : null;
  // Opacity ramps to full over ~140px so the signal arrives well before
  // the commit threshold, giving a chance to change your mind.
  const leak = Math.min(1, Math.abs(dx) / 140);

  const style = isNext
    ? {
        // The card underneath scales up slightly as the top card leaves,
        // so the stack reads as depth rather than a hard swap.
        transform: `scale(${0.94 + Math.min(1, Math.abs(dx) / 220) * 0.06})`,
        opacity: 0.55 + Math.min(1, Math.abs(dx) / 220) * 0.45,
      }
    : {
        transform: `translate(${dx}px, ${dy}px) rotate(${rotation}deg)`,
        transition: dragging ? 'none' : 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
      };

  const year = title.year || null;
  // §4.3: TV episode_run_time is often empty and movie runtime can be
  // null. An em dash reads better than "0 min".
  const runtime = title.runtime ? `${title.runtime} min` : null;
  const rating = title.vote_count >= 100 && title.rating ? title.rating.toFixed(1) : null;

  const hasLongSynopsis = (title.synopsis || '').length > 150;

  return (
    <article
      className={`card ${isNext ? 'card--next' : ''}`}
      style={style}
      aria-hidden={isNext}
    >
      <div className="card__art">
        {poster && !posterFailed ? (
          <img
            src={poster}
            alt=""
            draggable="false"
            onError={() => setPosterFailed(true)}
          />
        ) : (
          // §4.3: poster_path is frequently null. The title already
          // appears in the meta block below, so repeating it here reads
          // as a rendering bug -- caught on a screenshot pass. Show the
          // medium and year instead: still enough to orient, without the
          // echo.
          <div className="card__noart">
            <span className="card__noart-mark">
              {title.media_type === 'tv' ? 'Series' : 'Film'}
            </span>
            {title.year && <span className="card__noart-year">{title.year}</span>}
            <span className="card__noart-note">No artwork</span>
          </div>
        )}

        {!isNext && (
          <>
            <div className="card__leak card__leak--yes" style={{ opacity: dx > 0 ? leak : 0 }} />
            <div className="card__leak card__leak--no" style={{ opacity: dx < 0 ? leak : 0 }} />
          </>
        )}

        {!isNext && verdict && (
          <div className={`card__verdict card__verdict--${verdict}`} style={{ opacity: leak }}>
            {verdict === 'yes' ? 'Yes' : 'Pass'}
          </div>
        )}
      </div>

      <div className={`card__meta ${expanded ? 'card__meta--expanded' : ''}`}>
        <h2 className="card__title">{title.title}</h2>
        <p className="card__facts">
          {[
            title.media_type === 'tv' ? 'Series' : 'Film',
            year,
            runtime,
            rating ? `${rating}/10` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {title.synopsis && (
          <p className={`card__synopsis ${expanded ? '' : 'card__synopsis--clamped'}`}>
            {title.synopsis}
          </p>
        )}
        {!isNext && hasLongSynopsis && (
          <button
            className="card__more"
            // Pointer events on the deck handle dragging; stop this tap
            // from also being read as the start of a swipe.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        {title.providers?.length > 0 && (
          <ul className="card__providers">
            {title.providers.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
