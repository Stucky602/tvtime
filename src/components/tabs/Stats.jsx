import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { computeStats, serviceAdvice } from '../../lib/stats.js';

// Feature 5: two halves on one screen.
//
// The charming half (how often you agree, where your tastes split) is
// what makes it feel like YOUR app. The useful half (per-service match
// counts) is a real subscription decision nothing else can make for
// you, because nothing else knows what you both jointly want.

export default function Stats({ room, user, partner, onClose }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: swipes, error: e1 }, { data: watched, error: e2 }] = await Promise.all([
          supabase.from('swipes').select('user_id,tmdb_id,media_type,direction'),
          supabase.from('watched').select('tmdb_id,media_type,verdict'),
        ]);
        if (e1) throw e1;
        if (e2) throw e2;

        const ids = [...new Set((swipes || []).map((s) => s.tmdb_id))];
        let titles = [];
        if (ids.length) {
          const { data, error: e3 } = await supabase
            .from('titles')
            .select('tmdb_id,media_type,genres,providers')
            .in('tmdb_id', ids);
          if (e3) throw e3;
          titles = data || [];
        }
        const titlesByKey = new Map(titles.map((t) => [`${t.tmdb_id}:${t.media_type}`, t]));

        setStats(
          computeStats({
            swipes: swipes || [],
            userId: user.id,
            partnerId: partner?.id ?? null,
            titlesByKey,
            watchedRows: watched || [],
          })
        );
      } catch (err) {
        setError(err.message || 'Could not load stats.');
      }
    })();
  }, [user.id, partner?.id]);

  if (error) {
    return (
      <div className="stats">
        <div className="pick__head">
          <h1 className="pick__title">Stats</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (!stats) return <div className="stats" aria-busy="true" />;

  const advice = serviceAdvice(stats, room.platforms);

  return (
    <div className="stats">
      <div className="pick__head">
        <h1 className="pick__title">Stats</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-num shout">{stats.matches}</span>
          <span className="stat-label">Matches</span>
        </div>
        <div className="stat-box">
          <span className="stat-num shout">
            {stats.agreementPct === null ? '--' : `${stats.agreementPct}%`}
          </span>
          <span className="stat-label">You agree</span>
        </div>
        <div className="stat-box">
          <span className="stat-num shout">{stats.totalMine}</span>
          <span className="stat-label">Your swipes</span>
        </div>
        <div className="stat-box">
          <span className="stat-num shout">{stats.watchedCount}</span>
          <span className="stat-label">Watched</span>
        </div>
      </div>

      {stats.decided === 0 && (
        <p className="settings__hint">
          Nothing to compare yet. Once you've both swiped on the same titles,
          this fills in.
        </p>
      )}

      {stats.sharedGenres.length > 0 && (
        <section className="settings__group">
          <h2>What you both love</h2>
          <ul className="bar-list">
            {stats.sharedGenres.map((g) => (
              <li key={g.id}>
                <span className="bar-label">{g.label}</span>
                <span
                  className="bar bar--yes"
                  style={{ width: `${(g.count / stats.sharedGenres[0].count) * 100}%` }}
                />
                <span className="bar-count">{g.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats.splitGenres.length > 0 && (
        <section className="settings__group">
          <h2>Where you disagree</h2>
          <ul className="bar-list">
            {stats.splitGenres.map((g) => (
              <li key={g.id}>
                <span className="bar-label">{g.label}</span>
                <span
                  className="bar bar--no"
                  style={{ width: `${(g.count / stats.splitGenres[0].count) * 100}%` }}
                />
                <span className="bar-count">{g.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="settings__group">
        <h2>Which services earn their keep</h2>
        <p className="settings__hint">
          Matches you've found on each service. Only counts titles you both
          said yes to.
        </p>
        {stats.services.length === 0 ? (
          <p className="settings__hint">No matches yet.</p>
        ) : (
          <ul className="bar-list">
            {stats.services.map((s) => (
              <li key={s.slug}>
                <span className="bar-label">{s.label}</span>
                <span
                  className="bar bar--cyan"
                  style={{ width: `${(s.count / stats.services[0].count) * 100}%` }}
                />
                <span className="bar-count">{s.count}</span>
              </li>
            ))}
          </ul>
        )}
        {advice && (
          <p className="stat-advice">
            {advice.map((a) => a.label).join(' and ')}{' '}
            {advice.length === 1 ? 'has' : 'have'} barely produced a match. Worth
            asking whether {advice.length === 1 ? "it's" : "they're"} pulling
            {advice.length === 1 ? ' its' : ' their'} weight.
          </p>
        )}
      </section>

      {(stats.ratedUp > 0 || stats.ratedDown > 0) && (
        <section className="settings__group">
          <h2>After watching</h2>
          <p className="settings__hint">
            {stats.ratedUp} liked · {stats.ratedDown} not for you. These feed
            back into what the deck shows you.
          </p>
        </section>
      )}
    </div>
  );
}
