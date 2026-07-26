import { useMemo, useState } from 'react';
import { GENRES, CONFIG, PLATFORMS } from '../../lib/config.js';
import { applyFilters } from '../../lib/deck.js';
import { EMPTY_FILTERS, hasActiveFilters } from '../../lib/filters.js';
import { INTENTS, suggestedIntent, intentFilters, makePreset } from '../../lib/intent.js';

// §5.3: filters MASK the built deck client-side rather than triggering a
// new TMDB query. The masking logic lives in deck.js next to buildDeck,
// since it operates on the same card shape; this is just the panel that
// produces a filter object.
//
// Nine dimensions. Everything defaults to off.

const DECADES = [1970, 1980, 1990, 2000, 2010, 2020];
const RUNTIMES = [
  { v: 30, label: '30 min' },
  { v: 60, label: '1 hr' },
  { v: 90, label: '90 min' },
  { v: 120, label: '2 hr' },
];
const RATINGS = [
  { v: 6, label: '6+' },
  { v: 7, label: '7+' },
  { v: 8, label: '8+' },
];


export default function FilterPanel({
  open, filters, onChange, onClose, allCards, roomPlatforms,
  activeIntent, onPickIntent, savedPresets = [], onSavePreset,
}) {
  const [draft, setDraft] = useState(filters);

  // Recomputed from the LIVE draft, not the applied filters, so the
  // count updates while you're still toggling rather than one step late.
  const remainingCount = useMemo(
    () => (hasActiveFilters(draft) ? applyFilters(allCards || [], draft).length : (allCards || []).length),
    [draft, allCards]
  );

  if (!open) return null;

  const toggleIn = (key, value) => {
    const list = draft[key] || [];
    setDraft({
      ...draft,
      [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value],
    });
  };
  const setOne = (key, value) =>
    setDraft({ ...draft, [key]: draft[key] === value ? null : value });

  const apply = () => {
    onChange(draft);
    onClose();
  };
  const clear = () => {
    setDraft(EMPTY_FILTERS);
    onChange(EMPTY_FILTERS);
    onClose();
  };

  const tooFew = remainingCount < CONFIG.MIN_FILTERED_DECK;

  // Only offer services the room actually subscribes to -- filtering by
  // a service you don't have would guarantee an empty deck.
  const services = PLATFORMS.filter((p) => (roomPlatforms || []).includes(p.slug));

  const Chip = ({ on, onClick, children }) => (
    <button className={`filter-chip ${on ? 'filter-chip--on' : ''}`} onClick={onClick}>
      {children}
    </button>
  );

  return (
    <div className="filter-sheet" role="dialog" aria-label="Filters">
      <div className="filter-sheet__head">
        <h2>Filters</h2>
        <button onClick={onClose} aria-label="Close filters">Done</button>
      </div>

      {/* Intent first: it is the coarsest choice and it sets everything
          below, so asking it last would be backwards. Lives here rather
          than as a permanent row on the deck, because it is a filter and
          a second always-visible filter mechanism was the clutter. */}
      <section className="filter-group">
        <h3>What kind of night</h3>
        <div className="filter-row filter-row--wrap">
          <button
            className={`filter-chip ${!activeIntent ? 'filter-chip--on' : ''}`}
            onClick={() => onPickIntent?.(null, EMPTY_FILTERS)}
          >
            Anything
          </button>
          {[...INTENTS, ...savedPresets].map((i) => (
            <button
              key={i.id}
              className={`filter-chip ${activeIntent === i.id ? 'filter-chip--on' : ''} ${
                !activeIntent && suggestedIntent() === i.id ? 'filter-chip--suggested' : ''
              }`}
              onClick={() => {
                const f = intentFilters(i);
                setDraft(f);
                onPickIntent?.(i.id, f);
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
        {!activeIntent && suggestedIntent() && (
          <p className="filter-hint">
            Going by the time, {INTENTS.find((i) => i.id === suggestedIntent())?.label.toLowerCase()}{' '}
            probably fits.
          </p>
        )}
      </section>

      <section className="filter-group">
        <h3>Type</h3>
        <div className="filter-row">
          {[
            { id: null, label: 'Both' },
            { id: 'movie', label: 'Movies' },
            { id: 'tv', label: 'TV' },
          ].map((o) => (
            <Chip
              key={o.label}
              on={draft.mediaType === o.id}
              onClick={() => setDraft({ ...draft, mediaType: o.id })}
            >
              {o.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="filter-group">
        <h3>Anime</h3>
        <div className="filter-row">
          <Chip on={draft.anime === 'only'} onClick={() => setOne('anime', 'only')}>
            Anime only
          </Chip>
          <Chip on={draft.anime === 'hide'} onClick={() => setOne('anime', 'hide')}>
            Hide anime
          </Chip>
        </div>
      </section>

      <section className="filter-group">
        <h3>Max length</h3>
        <div className="filter-row filter-row--wrap">
          {RUNTIMES.map((r) => (
            <Chip
              key={r.v}
              on={draft.maxRuntime === r.v}
              onClick={() => setOne('maxRuntime', r.v)}
            >
              Under {r.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="filter-group">
        <h3>Minimum rating</h3>
        <div className="filter-row">
          {RATINGS.map((r) => (
            <Chip key={r.v} on={draft.minRating === r.v} onClick={() => setOne('minRating', r.v)}>
              {r.label}
            </Chip>
          ))}
        </div>
      </section>

      {services.length > 1 && (
        <section className="filter-group">
          <h3>Service</h3>
          <div className="filter-row filter-row--wrap">
            {services.map((p) => (
              <Chip
                key={p.slug}
                on={(draft.services || []).includes(p.slug)}
                onClick={() => toggleIn('services', p.slug)}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        </section>
      )}

      <section className="filter-group">
        <h3>Language</h3>
        <div className="filter-row">
          <Chip on={draft.language === 'en'} onClick={() => setOne('language', 'en')}>
            English
          </Chip>
          <Chip on={draft.language === 'foreign'} onClick={() => setOne('language', 'foreign')}>
            Foreign
          </Chip>
        </div>
      </section>

      <section className="filter-group">
        <h3>Genre</h3>
        <div className="filter-row filter-row--wrap">
          {GENRES.map((g) => (
            <Chip
              key={g.id}
              on={(draft.genres || []).includes(g.id)}
              onClick={() => toggleIn('genres', g.id)}
            >
              {g.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="filter-group">
        <h3>Released</h3>
        <div className="filter-row filter-row--wrap">
          <Chip on={draft.newOnly} onClick={() => setDraft({ ...draft, newOnly: !draft.newOnly })}>
            Last 2 years
          </Chip>
          {DECADES.map((d) => (
            <Chip
              key={d}
              on={(draft.decades || []).includes(d)}
              onClick={() => toggleIn('decades', d)}
            >
              {d}s
            </Chip>
          ))}
        </div>
      </section>

      {tooFew && (
        <p className="filter-warning">
          Only {remainingCount} title{remainingCount === 1 ? '' : 's'} match. Try widening these.
        </p>
      )}
      {!tooFew && hasActiveFilters(draft) && (
        <p className="filter-count">{remainingCount} titles match</p>
      )}

      {onSavePreset && (
        <button
          className="filter-save"
          onClick={() => {
            const label = window.prompt('Name this preset');
            if (label) onSavePreset(makePreset(label, draft));
          }}
        >
          Save these as a preset
        </button>
      )}

      <div className="filter-sheet__actions">
        <button className="onboard-btn" onClick={clear}>Clear all</button>
        <button className="onboard-btn onboard-btn--primary" onClick={apply}>
          Show results
        </button>
      </div>
    </div>
  );
}
