import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { posterUrl } from '../../lib/config.js';
import { submitSwipe } from '../../lib/data.js';
import { watchTarget } from '../../lib/links.js';

// Feature 3: search.
//
// There was no way to ask "do we both want to watch Dune?" -- you could
// only wait for the deck to surface it, which for a specific title you
// have in mind is close to never. That is a real hole in a movie app.
//
// This searches the LOCAL title cache rather than TMDB directly, for two
// reasons: the client has no TMDB key by design (§4.2), and the cache is
// already several thousand titles filtered to services you actually
// have. A title that isn't in the cache isn't streamable on your
// services anyway, so finding it would only be able to disappoint you.

export default function TitleSearch({ userId, partner, roomPlatforms, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [votes, setVotes] = useState(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const term = useMemo(() => q.trim(), [q]);

  useEffect(() => {
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const { data, error: e } = await supabase
          .from('titles')
          .select('tmdb_id,media_type,title,year,runtime,poster_path,rating,vote_count,providers,watch_link')
          .ilike('title', `%${term}%`)
          .eq('excluded', false)
          .order('popularity', { ascending: false })
          .limit(20);
        if (e) throw e;
        if (cancelled) return;
        setResults(data || []);

        // Show what each of you has already said, so the answer to
        // "have we both seen this?" is immediate.
        const ids = (data || []).map((d) => d.tmdb_id);
        if (ids.length) {
          const { data: sw } = await supabase
            .from('swipes')
            .select('user_id,tmdb_id,media_type,direction')
            .in('tmdb_id', ids);
          if (!cancelled) {
            const m = new Map();
            for (const s of sw || []) {
              const k = `${s.tmdb_id}:${s.media_type}`;
              const cur = m.get(k) || {};
              if (s.user_id === userId) cur.mine = s.direction;
              else if (s.user_id === partner?.id) cur.theirs = s.direction;
              m.set(k, cur);
            }
            setVotes(m);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Search failed.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250); // debounce: typing shouldn't fire a query per keystroke

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, userId, partner?.id]);

  const vote = async (t, direction) => {
    await submitSwipe({ tmdb_id: t.tmdb_id, media_type: t.media_type, direction });
    setVotes((prev) => {
      const next = new Map(prev);
      const k = `${t.tmdb_id}:${t.media_type}`;
      next.set(k, { ...(next.get(k) || {}), mine: direction });
      return next;
    });
  };

  const statusLine = (t) => {
    const v = votes.get(`${t.tmdb_id}:${t.media_type}`) || {};
    if (v.mine === 'right' && v.theirs === 'right') return { text: 'You both said yes', tone: 'yes' };
    if (v.mine === 'right' && v.theirs === 'left') return { text: 'Only you want this', tone: 'solo' };
    if (v.mine === 'left' && v.theirs === 'right') return { text: 'Only they want this', tone: 'solo' };
    if (v.mine === 'right') return { text: 'You said yes, waiting on them', tone: 'pending' };
    if (v.mine === 'left') return { text: 'You passed on this', tone: 'no' };
    if (v.mine === 'seen') return { text: "You've seen this", tone: 'no' };
    if (v.theirs === 'right') return { text: 'They said yes — your turn', tone: 'pending' };
    return null;
  };

  return (
    <div className="search">
      <div className="pick__head">
        <h1 className="pick__title">Search</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      <label className="field">
        Find a title
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Dune, The Bear, ..."
          autoFocus
          aria-label="Search titles"
        />
      </label>

      {error && <p className="field-error">{error}</p>}
      {busy && <p className="settings__hint">Searching…</p>}
      {!busy && term.length >= 2 && results.length === 0 && (
        <p className="settings__hint">
          Nothing matching on your services. If it's not here, it isn't
          streaming on the services this room has.
        </p>
      )}

      <ul className="rowlist">
        {results.map((t) => {
          const st = statusLine(t);
          const target = watchTarget(t, roomPlatforms);
          const v = votes.get(`${t.tmdb_id}:${t.media_type}`) || {};
          return (
            <li className="row" key={`${t.tmdb_id}:${t.media_type}`}>
              <div className="row__poster">
                {t.poster_path ? (
                  <img src={posterUrl(t.poster_path, 'w185')} alt="" />
                ) : (
                  <div className="row__noart">{t.media_type === 'tv' ? 'Series' : 'Film'}</div>
                )}
              </div>
              <div className="row__body">
                <p className="row__title">{t.title}</p>
                <p className="row__facts">
                  {[t.year, t.runtime ? `${t.runtime} min` : null].filter(Boolean).join(' · ')}
                </p>
                {st && <p className={`row__verdict row__verdict--${st.tone}`}>{st.text}</p>}
                {target && (
                  <a className="row__watch" href={target.url} target="_blank" rel="noreferrer">
                    {target.label}
                  </a>
                )}
              </div>
              {!v.mine && (
                <div className="search__actions">
                  <button className="row__action" onClick={() => vote(t, 'right')}>Yes</button>
                  <button className="row__action" onClick={() => vote(t, 'left')}>Pass</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
