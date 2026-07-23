import { useMemo, useState } from 'react';
import { GENRES, CONFIG } from '../../lib/config.js';
import { applyFilters } from '../../lib/deck.js';

// Architecture ref: ARCHITECTURE_v1.0.md §5.3
//
// "Filters mask the built deck client-side rather than triggering a new
// TMDB query." All the actual masking logic (applyFilters) lives in
// deck.js next to buildDeck, since it operates on the same card shape --
// this component is only the panel that produces a filter object and
// hands it to the caller. All off by default, per §5.3.

const DECADES = [1980, 1990, 2000, 2010, 2020];

export default function FilterPanel({ open, filters, onChange, onClose, allCards }) {
  const [draft, setDraft] = useState(filters);

  // Recomputed from the LIVE draft, not the already-applied filters --
  // otherwise the "too few results" warning would only update after the
  // user hits Show results, one step too late to be useful while they're
  // still toggling chips.
  const remainingCount = useMemo(() => {
    const hasFilters = draft.mediaType || draft.genres?.length || draft.decades?.length;
    return hasFilters ? applyFilters(allCards || [], draft).length : (allCards || []).length;
  }, [draft, allCards]);

  if (!open) return null;

  const toggleGenre = (id) => {
    const genres = draft.genres || [];
    setDraft({
      ...draft,
      genres: genres.includes(id) ? genres.filter((g) => g !== id) : [...genres, id],
    });
  };

  const toggleDecade = (d) => {
    const decades = draft.decades || [];
    setDraft({
      ...draft,
      decades: decades.includes(d) ? decades.filter((x) => x !== d) : [...decades, d],
    });
  };

  const apply = () => {
    onChange(draft);
    onClose();
  };

  const clear = () => {
    const empty = { mediaType: null, genres: [], decades: [] };
    setDraft(empty);
    onChange(empty);
    onClose();
  };

  // §5.3: if a filter combination leaves too few cards, say so plainly
  // rather than silently going blank.
  const tooFew = remainingCount < CONFIG.MIN_FILTERED_DECK;

  return (
    <div className="filter-sheet" role="dialog" aria-label="Filters">
      <div className="filter-sheet__head">
        <h2>Filters</h2>
        <button onClick={onClose} aria-label="Close filters">
          Done
        </button>
      </div>

      <section className="filter-group">
        <h3>Type</h3>
        <div className="filter-row">
          {[
            { id: null, label: 'Both' },
            { id: 'movie', label: 'Movies' },
            { id: 'tv', label: 'TV' },
          ].map((opt) => (
            <button
              key={opt.label}
              className={`filter-chip ${draft.mediaType === opt.id ? 'filter-chip--on' : ''}`}
              onClick={() => setDraft({ ...draft, mediaType: opt.id })}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="filter-group">
        <h3>Genre</h3>
        <div className="filter-row filter-row--wrap">
          {GENRES.map((g) => (
            <button
              key={g.id}
              className={`filter-chip ${(draft.genres || []).includes(g.id) ? 'filter-chip--on' : ''}`}
              onClick={() => toggleGenre(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </section>

      <section className="filter-group">
        <h3>Decade</h3>
        <div className="filter-row filter-row--wrap">
          {DECADES.map((d) => (
            <button
              key={d}
              className={`filter-chip ${(draft.decades || []).includes(d) ? 'filter-chip--on' : ''}`}
              onClick={() => toggleDecade(d)}
            >
              {d}s
            </button>
          ))}
        </div>
      </section>

      {tooFew && (
        <p className="filter-warning">
          Only {remainingCount} title{remainingCount === 1 ? '' : 's'} match. Try widening these.
        </p>
      )}

      <div className="filter-sheet__actions">
        <button className="onboard-btn" onClick={clear}>
          Clear all
        </button>
        <button className="onboard-btn onboard-btn--primary" onClick={apply}>
          Show results
        </button>
      </div>
    </div>
  );
}
