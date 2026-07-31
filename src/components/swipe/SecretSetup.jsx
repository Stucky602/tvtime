import { useState } from 'react';
import {
  GRID, MIN_TAPS, MAX_TAPS, zoneFor, isValidSequence, saveSecret, forgetSecret,
} from '../../lib/secret-gesture.js';

// Recording the secret.
//
// Shown once, from a deliberately obscure entry point. The grid is
// VISIBLE here and invisible everywhere else: you need to see the zones
// to choose a sequence, and you need to not see them afterwards or the
// secret announces itself on every card.
//
// Confirmation is required because a sequence you cannot reproduce is
// worse than no sequence at all: there is no recovery flow, by design,
// since a "forgot my secret" link would be the obvious thing for a
// curious partner to click.

export default function SecretSetup({ onDone, onCancel }) {
  const [phase, setPhase] = useState('record'); // record | confirm | done
  const [first, setFirst] = useState([]);
  const [second, setSecond] = useState([]);
  const [error, setError] = useState(null);

  const current = phase === 'record' ? first : second;
  const setCurrent = phase === 'record' ? setFirst : setSecond;

  const tap = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const z = zoneFor(e.clientX - box.left, e.clientY - box.top, box.width, box.height);
    if (z === null) return;
    const next = [...current, z].slice(0, MAX_TAPS);
    setCurrent(next);
    setError(null);
  };

  const commitFirst = () => {
    if (!isValidSequence(first)) {
      setError(
        first.length < MIN_TAPS
          ? `Use at least ${MIN_TAPS} taps.`
          : 'Use more than one square, or it is the first thing anyone would try.'
      );
      return;
    }
    setPhase('confirm');
  };

  const commitSecond = () => {
    if (first.length !== second.length || !first.every((v, i) => v === second[i])) {
      setError('That did not match. Start again.');
      setFirst([]);
      setSecond([]);
      setPhase('record');
      return;
    }
    if (saveSecret(first)) onDone(first);
    else setError('Could not save on this device.');
  };

  return (
    <div className="secret-setup">
      <h1 className="brand">Shh</h1>
      <p className="onboard-sub">
        Pick a pattern of taps. Do it on any poster afterwards and you get two
        extra ways to vote that nobody else knows about.
      </p>
      <p className="settings__hint">
        It lives on this phone and nowhere else. We never send it anywhere, and
        there is no way to recover it, which is rather the point.
      </p>
      <p className="settings__hint">
        You will need to do the pattern again each time you open the app. That
        is deliberate: nothing stays unlocked, so picking up the phone is not
        the same as being let in.
      </p>

      <div className="secret-grid" onClick={tap}>
        {Array.from({ length: GRID * GRID }).map((_, i) => (
          <span key={i} className="secret-grid__cell" />
        ))}
      </div>

      <p className="secret-setup__count">
        {current.length === 0
          ? phase === 'record'
            ? 'Tap a pattern'
            : 'Now do it again'
          : `${current.length} tap${current.length === 1 ? '' : 's'}`}
      </p>

      {error && <p className="field-error">{error}</p>}

      <button
        className="onboard-btn onboard-btn--primary"
        onClick={phase === 'record' ? commitFirst : commitSecond}
        disabled={current.length < MIN_TAPS}
      >
        {phase === 'record' ? 'Next' : 'Confirm'}
      </button>

      <button
        className="onboard-btn"
        onClick={() => {
          setCurrent([]);
          setError(null);
        }}
      >
        Clear
      </button>

      <button
        className="onboard-btn"
        onClick={() => {
          forgetSecret();
          onCancel();
        }}
      >
        Cancel
      </button>
    </div>
  );
}
