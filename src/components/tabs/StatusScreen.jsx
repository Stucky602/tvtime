import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';

// Feature 10: a status screen.
//
// This earned its place from lived experience rather than a wishlist.
// Across several debugging rounds -- "why are there no trailers", "why
// is the pool empty", "which migrations did I actually run" -- the
// answer was always in the database, and the only way to see it was to
// go write SQL by hand. Every one of those sessions would have been
// minutes instead of hours with this screen.
//
// It is read-only and intentionally boring.

const EXPECTED = [
  { col: 'is_reality', label: 'Reality toggle', migration: '20260722220700' },
  { col: 'is_anime', label: 'Anime detection', migration: '20260723150000' },
  { col: 'trailer_key', label: 'Trailers + watch links', migration: '20260723160000' },
  { col: 'trailer_checked_at', label: 'Trailer backfill', migration: '20260723200000' },
];

export default function StatusScreen({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const count = async (build) => {
          const { count: n, error: e } = await build(
            supabase.from('titles').select('tmdb_id', { count: 'exact', head: true })
          );
          if (e) throw e;
          return n ?? 0;
        };

        const total = await count((q) => q);
        const usable = await count((q) => q.eq('excluded', false));
        const withTrailer = await count((q) => q.not('trailer_key', 'is', null));
        const unchecked = await count((q) => q.is('trailer_checked_at', null));

        // Freshest provider timestamp is the best proxy for "when did
        // the refresh job last succeed" -- the job stamps it on every
        // row it writes, and a failed run writes nothing.
        const { data: fresh } = await supabase
          .from('titles')
          .select('providers_updated_at')
          .order('providers_updated_at', { ascending: false })
          .limit(1);

        // Column presence tells us which migrations landed.
        const migrations = [];
        for (const e of EXPECTED) {
          const { error: colErr } = await supabase.from('titles').select(e.col).limit(1);
          migrations.push({ ...e, present: !colErr });
        }

        setData({
          total,
          usable,
          withTrailer,
          unchecked,
          lastRefresh: fresh?.[0]?.providers_updated_at ?? null,
          migrations,
        });
      } catch (err) {
        setError(err.message || 'Could not read status.');
      }
    })();
  }, []);

  if (error) {
    return (
      <div className="stats">
        <div className="pick__head">
          <h1 className="pick__title">Status</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (!data) return <div className="stats" aria-busy="true" />;

  const ago = (iso) => {
    if (!iso) return 'never';
    const h = (Date.now() - new Date(iso).getTime()) / 3600000;
    if (h < 1) return 'under an hour ago';
    if (h < 48) return `${Math.round(h)} hours ago`;
    return `${Math.round(h / 24)} days ago`;
  };

  const stale = data.lastRefresh
    ? (Date.now() - new Date(data.lastRefresh).getTime()) / 3600000 > 48
    : true;

  return (
    <div className="stats">
      <div className="pick__head">
        <h1 className="pick__title">Status</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-num shout">{data.usable}</span>
          <span className="stat-label">Titles available</span>
        </div>
        <div className="stat-box">
          <span className="stat-num shout">{data.withTrailer}</span>
          <span className="stat-label">With trailers</span>
        </div>
      </div>

      <section className="settings__group">
        <h2>Title pool</h2>
        <p className="settings__hint">
          {data.total} titles cached, {data.usable} usable after exclusions.
        </p>
        {data.unchecked > 0 ? (
          <p className="settings__hint">
            {data.unchecked} still waiting on a trailer check. The nightly job
            works through 250 per run, most popular first.
          </p>
        ) : (
          <p className="settings__hint">Every title has been checked for a trailer.</p>
        )}
      </section>

      <section className="settings__group">
        <h2>Last successful refresh</h2>
        <p className="settings__hint">{ago(data.lastRefresh)}</p>
        {stale && (
          <p className="stat-advice">
            Nothing has been written in over two days. The refresh job is
            probably failing — check GitHub Actions, "Refresh title pool", and
            open the "Run pool refresh" step.
          </p>
        )}
      </section>

      <section className="settings__group">
        <h2>Database migrations</h2>
        <p className="settings__hint">
          Detected by checking which columns exist. A missing one means that
          migration hasn't been run in the Supabase SQL Editor.
        </p>
        <ul className="bar-list">
          {data.migrations.map((m) => (
            <li key={m.col}>
              <span className="bar-label">{m.label}</span>
              <span className={`bar ${m.present ? 'bar--yes' : 'bar--no'}`} style={{ width: '30%' }} />
              <span className="bar-count">{m.present ? 'OK' : 'MISSING'}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
