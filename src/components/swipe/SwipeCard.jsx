import { useEffect, useRef, useState } from 'react';
import { posterUrl, adaptivePosterSize, backdropUrl } from '../../lib/config.js';
import { watchTarget, trailerEmbedUrl } from '../../lib/links.js';
import { commitmentLabel } from '../../lib/lifecycle.js';

// One card.
//
// LAYOUT, rewritten after a screenshot showed three problems that all
// had the same cause: the Trailer button and the "scroll for details"
// badge were positioned absolutely INSIDE the scroll container. So they
// scrolled with the content, drifted over the synopsis, and sat on top
// of the provider row and the watch button.
//
// Anything that floats over the card is now a sibling of the scroller,
// not a descendant. It is anchored to the card and stays put while the
// content moves underneath, which is what "floating" is supposed to
// mean.
//
// The scroll hint is also measured rather than assumed. It used to
// render unconditionally, so it promised details on cards that had
// none.

export default function SwipeCard({
  title,
  dx = 0,
  dy = 0,
  dragging = false,
  isNext = false,
  roomPlatforms = [],
  // Owned by SwipeDeck now. The Trailer control lives down in the
  // button row rather than on the artwork, so the state has to live
  // somewhere both can see.
  playing = false,
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const [canScroll, setCanScroll] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef(null);

  const poster = posterUrl(title.poster_path, adaptivePosterSize());
  const backdrop = backdropUrl(title.backdrop_path);
  const trailer = trailerEmbedUrl(title.trailer_key);
  const watch = watchTarget(title, roomPlatforms);

  // Measure real overflow rather than promising details that may not
  // exist. Runs after layout and again if the image finishes loading
  // and changes the height.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setCanScroll(el.scrollHeight > el.clientHeight + 8);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [title.tmdb_id, title.media_type, playing]);

  // Reset per card.
  useEffect(() => {
    setScrolled(false);
    setPosterFailed(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [title.tmdb_id, title.media_type]);

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
  const commitment = commitmentLabel(title);

  return (
    <article className={`card ${isNext ? 'card--next' : ''}`} style={style} aria-hidden={isNext}>
      <div
        className="card__scroll"
        ref={scrollRef}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 12)}
      >
        <div className="card__art">
          {backdrop && !playing && (
            <div
              className="card__backdrop"
              style={{ backgroundImage: `url(${backdrop})` }}
              aria-hidden="true"
            />
          )}

          {playing && trailer ? (
            <iframe
              className="card__trailer"
              src={trailer}
              title={`${title.title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : poster && !posterFailed ? (
            <img
              src={poster}
              alt=""
              draggable="false"
              decoding="async"
              fetchPriority={isNext ? 'low' : 'high'}
              onError={() => setPosterFailed(true)}
            />
          ) : (
            <div className="card__noart">
              <span className="card__noart-mark shout">
                {title.media_type === 'tv' ? 'Series' : 'Film'}
              </span>
              {title.year && <span className="card__noart-year shout">{title.year}</span>}
              <span className="card__noart-note">No artwork</span>
            </div>
          )}

          {/* Title burned onto the poster. Scrolls WITH the art on
              purpose -- it belongs to the image, unlike the floating
              controls below. */}
          {!playing && (
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
              {commitment && <p className="card__commit">{commitment}</p>}
            </div>
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
          {!isNext && watch && (
            <a
              className="watch-btn shout"
              href={watch.url}
              target="_blank"
              rel="noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {watch.label}
            </a>
          )}
        </div>
      </div>

      {/* ---- Floating layer: siblings of the scroller, not children ----
          These stay anchored to the card while the content moves. When
          they lived inside .card__scroll they drifted down over the
          synopsis and the watch button, which is what the screenshot
          showed. */}
      {/* The Trailer control used to float here, over the poster. It
          now sits in the button row below the card (see SwipeDeck),
          where it is permanently visible without covering artwork and
          without needing to hide itself on scroll. */}

      {/* Only when there is genuinely something below the fold, and only
          until you have gone looking. */}
      {!isNext && canScroll && !scrolled && !playing && (
        <span className="card__scrollcue" aria-hidden="true">
          More below
        </span>
      )}

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
