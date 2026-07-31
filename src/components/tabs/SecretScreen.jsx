import { useEffect, useState } from 'react';
import { posterUrl } from '../../lib/config.js';
import { fetchSecretLists, fetchSecretTitles } from '../../lib/secret.js';
import { forgetSecret } from '../../lib/secret-gesture.js';

// The secret lists.
//
// Three sections, in the order that matters:
//
//   Ours       -- both of you marked it "only with you", independently.
//                 The payoff, and the only one that requires two people.
//   Waiting    -- you marked it, they have not. Deliberately worded so
//                 it never says whether they have found the gesture at
//                 all, because that is theirs to discover.
//   Alone      -- what each of you has claimed for yourselves.
//
// Reached from an unmarked control that only exists once you have set up
// a gesture, so nobody stumbles in.

export default function SecretScreen({ user, partner, onClose, onReset }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        // Server-side now. The client is no longer permitted to read a
        // partner's secret votes at all, so it cannot compute the
        // mutual set itself -- which is the point.
        const p = await fetchSecretLists();
        const titles = await fetchSecretTitles([...p.ours, ...p.claimed, ...p.alone]);
        setState({ p, titles });
      } catch (err) {
        setError(err.message || 'Could not load.');
      }
    })();
  }, [user.id, partner?.id]);

  if (error) {
    return (
      <div className="stats">
        <div className="pick__head">
          <h1 className="pick__title">Between us</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (!state) return <div className="stats" aria-busy="true" />;

  const { p, titles } = state;

  const List = ({ keys, empty }) => {
    if (!keys.length) return <p className="settings__hint">{empty}</p>;
    return (
      <ul className="rowlist">
        {keys.map((k) => {
          const t = titles.get(k);
          if (!t) return null;
          return (
            <li className="row" key={k}>
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
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="stats secret-screen">
      <div className="pick__head">
        <h1 className="pick__title">Between us</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      <section className="settings__group secret-ours">
        <h2>Ours</h2>
        <p className="settings__hint">
          You both picked these, separately, without discussing it.
        </p>
        <List
          keys={p.ours}
          empty="Nothing yet. It only lands here when you've both marked the same thing."
        />
      </section>

      <section className="settings__group">
        <h2>You've claimed these</h2>
        <p className="settings__hint">
          Marked "only with you". Nothing has come back on them yet.
        </p>
        <List keys={p.claimed} empty="Nothing waiting." />
      </section>

      <section className="settings__group">
        <h2>Yours alone</h2>
        <List keys={p.alone} empty="You haven't claimed anything for yourself." />
      </section>

      {/* There used to be a "<partner>'s alone" section here, listing
          their private picks. That defeated the entire purpose of a
          secret gesture and has been removed -- and the database will
          no longer serve that data even if something asks for it. */}

      <section className="settings__group settings__danger">
        <h2>Forget the pattern</h2>
        <p className="settings__hint">
          Wipes it from this phone. Your votes stay; you'd just need to set a new
          pattern to add more. There's no recovery, so only do this if you mean it.
        </p>
        <button
          className="onboard-btn settings__leave"
          onClick={() => {
            forgetSecret();
            onReset();
          }}
        >
          Forget it
        </button>
      </section>
    </div>
  );
}
