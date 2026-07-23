import { useState } from 'react';
import { posterUrl } from '../../lib/config.js';

// FlixPix card.
//
// LAYOUT (rewritten this round). The previous version split the card
// into a flexed poster area plus a capped meta panel, which squashed the
// poster: real posters are 2:3, the available space was not, and
// object-fit: cover cropped the difference away.
//
// Now the poster keeps its true 2:3 aspect ratio and fills the card,
// and the details live BELOW it in the same scrollable column. You
// scroll down to read them. That is only safe because of the axis lock
// in lib/gesture.js -- a vertical drag is classified as vertical and
// goes inert, so native scrolling and horizontal swiping no longer
// compete for the same touch. This layout would have been unusable
// before that fix.
//
// The bottom strip of the poster carries a gradient scrim with the
// title on it, so you can identify the card without scrolling at all.

export default function SwipeCard({
  title,
  dx = 0,
  dy = 0,
  dragging = false,
  isNext = false,
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const poster = posterUrl(title.poster_path, 'w780');

  const rotation = Math.max(-12, Math.min(12, dx / 14));
  const verdict = dx > 40 ? 'yes' : dx < -40 ? 'no' : null;
  const leak = Math.min(1, Math.abs(dx) / 140);

  const style = isNext
    ? {
        transform: `scale(${0.94 + Math.min(1, Math.abs(dx) / 220) * 0.06}) rotate(-1.5deg)`,
        opacity: 0.55 + Math.min(1, Math.abs(dx) / 220) * 0.45,
      }
    : {
        transform: `translate(${dx}px, ${dy}px) rotate(${rotation}deg)`,
        transition: dragging ? 'none' : 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
      };

  const year = title.year || null;
  const runtime = title.runtime ? `${title.runtime} min` : null;
  const rating = title.vote_count >= 100 && title.rating ? title.rating.toFixed(1) : null;

  return (
    <article className={`card ${isNext ? 'card--next' : ''}`} style={style} aria-hidden={isNext}>
      {/* The scroll container. touch-action: pan-y lets the browser own
          vertical scrolling here while the deck owns horizontal swipes. */}
      <div className="card__scroll">
        <div className="card__art">
          {poster && !posterFailed ? (
            <img src={poster} alt="" draggable="false" onError={() => setPosterFailed(true)} />
          ) : (
            <div className="card__noart">
              <span className="card__noart-mark shout">
                {title.media_type === 'tv' ? 'Series' : 'Film'}
              </span>
              {title.year && <span className="card__noart-year shout">{title.year}</span>}
              <span className="card__noart-note">No artwork</span>
            </div>
          )}

          {/* Title burned onto the poster so the card is identifiable
              without scrolling. */}
          <div className="card__scrim">
            <h2 className="card__title shout inked-text">{title.title}</h2>
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
          </div>

          {!isNext && (
            <span className="card__scrollcue" aria-hidden="true">
              Scroll for details
            </span>
          )}
        </div>

        <div className="card__meta">
          {title.synopsis && <p className="card__synopsis">{title.synopsis}</p>}
          {title.providers?.length > 0 && (
            <>
              <h3 className="card__metahead shout">Streaming on</h3>
              <ul className="card__providers">
                {title.providers.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* Verdict overlays sit OUTSIDE the scroller so they stay put
          while the card content scrolls under them. */}
      {!isNext && (
        <>
          <div className="card__leak card__leak--yes" style={{ opacity: dx > 0 ? leak : 0 }} />
          <div className="card__leak card__leak--no" style={{ opacity: dx < 0 ? leak : 0 }} />
        </>
      )}

      {!isNext && verdict && (
        <div className={`card__verdict card__verdict--${verdict} shout`} style={{ opacity: leak }}>
          {verdict === 'yes' ? 'Yes!' : 'Nope'}
        </div>
      )}
    </article>
  );
}
