import { useMemo, useState } from 'react';
import { posterUrl } from '../../lib/config.js';
import { watchTarget } from '../../lib/links.js';
import { hapticCommit, hapticMatch } from '../../lib/haptics.js';

// Feature 1: Tonight's Pick.
//
// The app stopped one step short of its own purpose. You match on
// twenty things and then still have to argue about which one. This
// closes that gap: a short head-to-head over your Together list that
// ends with a single answer.
//
// Why a bracket rather than "pick a random match": a random pick is
// trivially dismissed ("no, not that one") and settles nothing. Making
// the choice yourself three or four times means the answer is one you
// both arrived at, which is the actual social function here.
//
// Deliberately short. Eight entrants is three rounds; the whole thing
// is over in about fifteen seconds, which is the entire point. A full
// bracket over forty matches would be another chore.

const FIELD_SIZE = 8;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function TonightsPick({ candidates, roomPlatforms, onClose }) {
  // Seeded once per open, so the field doesn't reshuffle on re-render.
  const [round, setRound] = useState(() => shuffle(candidates).slice(0, FIELD_SIZE));
  const [nextRound, setNextRound] = useState([]);
  const [pair, setPair] = useState(0);

  const winner = round.length === 1 ? round[0] : null;
  const a = round[pair * 2];
  const b = round[pair * 2 + 1];

  const roundsLeft = useMemo(
    () => Math.ceil(Math.log2(Math.max(2, round.length))),
    [round]
  );

  const choose = (pickedTitle) => {
    hapticCommit();
    const advanced = [...nextRound, pickedTitle];
    const isLastPairInRound = (pair + 1) * 2 >= round.length;

    if (!isLastPairInRound) {
      setNextRound(advanced);
      setPair((p) => p + 1);
      return;
    }

    // Odd one out gets a bye rather than being dropped.
    const leftover = round.length % 2 === 1 ? [round[round.length - 1]] : [];
    const next = [...advanced, ...leftover];

    if (next.length === 1) hapticMatch();
    setRound(next);
    setNextRound([]);
    setPair(0);
  };

  if (candidates.length === 0) {
    return (
      <div className="pick">
        <div className="pick__head">
          <h1 className="pick__title">Tonight's Pick</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <div className="tabscreen__empty">
          <p className="empty__head">Nothing to pick from</p>
          <p className="empty__body">
            You need at least a couple of matches in Together first. Go swipe.
          </p>
        </div>
      </div>
    );
  }

  if (winner) {
    const target = watchTarget(winner, roomPlatforms);
    return (
      <div className="pick">
        <div className="pick__head">
          <h1 className="pick__title">Tonight's Pick</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>

        <div className="pick__winner">
          <p className="pick__verdict shout">Watch this</p>
          <div className="pick__winnerposter">
            {winner.poster_path ? (
              <img src={posterUrl(winner.poster_path, 'w500')} alt="" />
            ) : (
              <div className="row__noart">{winner.media_type === 'tv' ? 'Series' : 'Film'}</div>
            )}
          </div>
          <h2 className="pick__winnertitle shout">{winner.title}</h2>
          <p className="pick__winnerfacts">
            {[winner.year, winner.runtime ? `${winner.runtime} min` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {target && (
            <a className="watch-btn shout" href={target.url} target="_blank" rel="noreferrer">
              {target.label}
            </a>
          )}
          <button
            className="onboard-btn"
            onClick={() => {
              setRound(shuffle(candidates).slice(0, FIELD_SIZE));
              setNextRound([]);
              setPair(0);
            }}
          >
            Run it again
          </button>
        </div>
      </div>
    );
  }

  // A round with an odd count can leave a single unpaired title.
  if (!b) {
    return (
      <div className="pick">
        <div className="pick__head">
          <h1 className="pick__title">Tonight's Pick</h1>
          <button className="settings__close" onClick={onClose}>Close</button>
        </div>
        <div className="tabscreen__empty">
          <button className="onboard-btn onboard-btn--primary" onClick={() => choose(a)}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  const Side = ({ t }) => (
    <button className="pick__side" onClick={() => choose(t)}>
      <div className="pick__poster">
        {t.poster_path ? (
          <img src={posterUrl(t.poster_path, 'w500')} alt="" draggable="false" />
        ) : (
          <div className="row__noart">{t.media_type === 'tv' ? 'Series' : 'Film'}</div>
        )}
      </div>
      <span className="pick__name shout">{t.title}</span>
    </button>
  );

  return (
    <div className="pick">
      <div className="pick__head">
        <h1 className="pick__title">Tonight's Pick</h1>
        <button className="settings__close" onClick={onClose}>Close</button>
      </div>

      <p className="pick__prompt shout">Which one?</p>
      <p className="pick__progress">
        {roundsLeft === 1 ? 'Final' : `${roundsLeft} rounds left`} · tap to choose
      </p>

      <div className="pick__ring">
        <Side t={a} />
        <span className="pick__vs shout">vs</span>
        <Side t={b} />
      </div>
    </div>
  );
}
