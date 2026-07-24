import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { GENRES, posterUrl } from '../../lib/config.js';
import { buildHistory, recapStats, findDrift } from '../../lib/recap.js';

// Watch history + recap, and the provider-drift prompt.
//
// This is the screen that makes Watched more than a graveyard, and the
// one item on the list that's about the relationship rather than the
// mechanics. It's also where drift cleanup lives, because that's the
// natural place to be looking at your back catalogue anyway.

const GENRE_LABEL = Object.fromEntries(GENRES.map((g) => [g.id, g.label]));
const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

export default function Recap({ room, onClose }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    (async () => {
      try {
        const { data: watched, error: e1 } = await supabase
          .from('watched')
          .select('tmdb_id,media_type,verdict,marked_at,watched_on')
          .eq('room_id', room.id);
        if (e1) throw e1;

        const ids = [...new Set((watched || []).map((w) => w.tmdb_id))];
        let titles = [];
        if (ids.length) {
          const { data, error: e2 } = await supabase
            .from('titles')
            .select('tmdb_id,media_type,title,year,runtime,poster_path,genres,providers,providers_updated_at')
            .in('tmdb_id', ids);
          if (e2) throw e2;
          titles = data || [];
        }
        const byKey = new Map(titles.map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));
        setState({ history: buildHistory(watched || [], byKey), titles });
      } catch (err) {
        setError(err.message || 'Could not load your history.');
      }
    })();
  }, [room.id]);

  if (error) {
    return (
      <div className="stats">
        <div className="pick__head">
          <h1 className="pick__title">Your year</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (!state) return <div className="stats" aria-busy="true" />;

  const s = recapStats(state.history, year);
  const years = [...state.history.byYear.keys()].sort((a, b) => b - a);
  const drift = findDrift(state.titles, room.platforms);

  return (
    <div className="stats">
      <div className="pick__head">
        <h1 className="pick__title">Your year</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      {years.length > 1 && (
        <div className="filter-row filter-row--wrap">
          {years.map((y) => (
            <button
              key={y}
              className={`filter-chip ${y === year ? 'filter-chip--on' : ''}`}
              onClick={() => setYear(y)}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      {s.count === 0 ? (
        <div className="tabscreen__empty">
          <p className="empty__head">Nothing watched in {year}</p>
          <p className="empty__body">
            Mark something as watched from Together and it'll show up here.
          </p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-box">
              <span className="stat-num shout">{s.count}</span>
              <span className="stat-label">Watched together</span>
            </div>
            <div className="stat-box">
              <span className="stat-num shout">{s.hours}</span>
              <span className="stat-label">Hours</span>
            </div>
          </div>

          <section className="settings__group">
            <h2>The headlines</h2>
            <ul className="how__notes">
              {s.topGenre && (
                <li>
                  Mostly <strong>{GENRE_LABEL[s.topGenre.id] || 'mixed'}</strong> —{' '}
                  {s.topGenre.count} of {s.count}.
                </li>
              )}
              {s.topService && (
                <li>
                  <strong>{s.topService.label}</strong> carried {s.topService.count} of them.
                </li>
              )}
              {s.busiestMonth && (
                <li>
                  Busiest month was <strong>{MONTHS[s.busiestMonth.month]}</strong> with{' '}
                  {s.busiestMonth.count}.
                </li>
              )}
              {s.longest && (
                <li>
                  Longest sit was <strong>{s.longest.title}</strong> at {s.longest.runtime} min.
                </li>
              )}
              {(s.liked > 0 || s.disliked > 0) && (
                <li>
                  You rated {s.liked} good and {s.disliked} not-for-us.
                </li>
              )}
            </ul>
          </section>

          <section className="settings__group">
            <h2>Everything, most recent first</h2>
            <ul className="rowlist">
              {state.history.items
                .filter((i) => i.year === year)
                .map((i) => (
                  <li className="row" key={`${i.tmdb_id}:${i.media_type}`}>
                    <div className="row__poster">
                      {i.poster_path ? (
                        <img src={posterUrl(i.poster_path, 'w185')} alt="" />
                      ) : (
                        <div className="row__noart">
                          {i.media_type === 'tv' ? 'Series' : 'Film'}
                        </div>
                      )}
                    </div>
                    <div className="row__body">
                      <p className="row__title">{i.title}</p>
                      <p className="row__facts">
                        {i.when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        {i.runtime ? ` · ${i.runtime} min` : ''}
                      </p>
                      {i.verdict && (
                        <p className={`row__verdict row__verdict--${i.verdict}`}>
                          {i.verdict === 'up' ? 'Liked it' : 'Not for us'}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        </>
      )}

      {(drift.gone.length > 0 || drift.unknown.length > 0) && (
        <section className="settings__group">
          <h2>Might have left your services</h2>
          {drift.gone.length > 0 && (
            <>
              <p className="settings__hint">
                These are no longer on any service this room has, as of the last
                check:
              </p>
              <ul className="how__notes">
                {drift.gone.slice(0, 8).map((t) => (
                  <li key={`${t.tmdb_id}:${t.media_type}`}>{t.title}</li>
                ))}
              </ul>
            </>
          )}
          {drift.unknown.length > 0 && (
            <p className="settings__hint">
              {drift.unknown.length} more haven't been re-checked recently, so we
              genuinely don't know — they may still be available.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
