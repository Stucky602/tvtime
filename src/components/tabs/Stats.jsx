import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { computeStats, serviceAdvice } from '../../lib/stats.js';
import {
  scoreCalibration, calibrationSpread, verdictCalibration,
  termContribution, predictionAccuracy,
} from '../../lib/calibration.js';
import { fetchMyPredictions } from '../../lib/predictions.js';

// Feature 5: two halves on one screen.
//
// The charming half (how often you agree, where your tastes split) is
// what makes it feel like YOUR app. The useful half (per-service match
// counts) is a real subscription decision nothing else can make for
// you, because nothing else knows what you both jointly want.

export default function Stats({ room, user, partner, onClose }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [calib, setCalib] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: swipes, error: e1 }, { data: watched, error: e2 }] = await Promise.all([
          supabase.from('swipes').select('user_id,tmdb_id,media_type,direction,score_debug'),
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

        // Does the recommender actually work? Nothing had ever asked.
        const mySwipes = (swipes || []).filter((x) => x.user_id === user.id);
        const cal = scoreCalibration(mySwipes);
        const { data: myVerdicts } = await supabase
          .from('watch_verdicts')
          .select('tmdb_id,media_type,verdict')
          .eq('user_id', user.id);
        const preds = await fetchMyPredictions(room.id).catch(() => []);

        setCalib({
          buckets: cal,
          spread: calibrationSpread(cal),
          verdict: verdictCalibration(mySwipes, myVerdicts || []),
          terms: termContribution(mySwipes),
          prediction: predictionAccuracy(preds),
        });

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
  }, [user.id, partner?.id, room.id]);

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

      {calib && (
        <section className="settings__group">
          <h2>Is the deck any good?</h2>
          <p className="settings__hint">
            The app ranks every title and, until now, never checked whether it
            was right. This compares what it recommended against what you
            actually said.
          </p>

          {calib.spread === null || calib.spread === undefined ? (
            <p className="settings__hint">
              Not enough swipes yet to tell. Come back after a few hundred.
            </p>
          ) : (
            <>
              <p className="settings__hint">
                Titles the deck rated highest get a yes{' '}
                <strong>{Math.round(calib.spread * 100)} points</strong> more
                often than the ones it rated lowest.
                {calib.spread < 0.1 && ' Which is close to nothing, so the ranking is not doing much.'}
                {calib.spread >= 0.1 && calib.spread < 0.3 && ' Modest, but real.'}
                {calib.spread >= 0.3 && ' That is the ordering doing genuine work.'}
              </p>
              <ul className="bar-list">
                {calib.buckets.map((b) => (
                  <li key={b.bucket}>
                    <span className="bar-label">
                      {b.bucket === 0 ? 'Lowest rated' : b.bucket === calib.buckets.length - 1 ? 'Highest rated' : `Band ${b.bucket + 1}`}
                    </span>
                    <span
                      className="bar bar--cyan"
                      style={{ width: `${Math.max(4, b.rightRate * 100)}%` }}
                    />
                    <span className="bar-count">{Math.round(b.rightRate * 100)}%</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {calib.verdict?.enough && (
            <p className="settings__hint">
              Of things you finished, the ones the deck rated highly were liked{' '}
              <strong>{Math.round(calib.verdict.lift * 100)} points</strong> more
              often. That is the harder test and the one that matters.
            </p>
          )}
          {calib.verdict && !calib.verdict.enough && (
            <p className="settings__hint">
              {calib.verdict.n} of {calib.verdict.need} ratings needed before the
              stronger test means anything.
            </p>
          )}

          {calib.terms?.length > 0 && (
            <>
              <h2 style={{ marginTop: 12 }}>What's actually deciding</h2>
              <ul className="bar-list">
                {calib.terms.slice(0, 4).map((t) => (
                  <li key={t.term}>
                    <span className="bar-label">{t.term}</span>
                    <span
                      className={`bar ${t.separation >= 0 ? 'bar--yes' : 'bar--no'}`}
                      style={{ width: `${Math.min(100, Math.abs(t.separation) * 120)}%` }}
                    />
                    <span className="bar-count">{t.separation.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              <p className="settings__hint">
                How far apart each term sits between your yeses and your passes.
                Near zero means that weight is buying nothing.
              </p>
            </>
          )}

          {calib.prediction && (
            <p className="settings__hint">
              You've guessed {partner?.display_name || 'their'} vote{' '}
              {calib.prediction.n} time{calib.prediction.n === 1 ? '' : 's'} and been
              right {Math.round(calib.prediction.rate * 100)}% of the time.
              {!calib.prediction.confident && ' Too few to mean much yet.'}
            </p>
          )}
        </section>
      )}

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
