import { useState } from 'react';
import { PLATFORMS, GENRES } from '../../lib/config.js';
import { supabase } from '../../lib/supabase.js';
import {
  createRoom,
  joinRoom,
  listReclaimMembers,
  reclaimMembership,
  updateGenrePrefs,
} from '../../lib/room.js';

// Architecture ref: ARCHITECTURE_v1.0.md §7 (join flow, reclaim), §5.4
// (onboarding genre picks seed the deck)
//
// A small state machine rather than a router (§6.5: "no router. Four
// tabs and a join screen need React state, not a router"). Steps:
//
//   welcome -> create -> genres -> done
//           -> join -> [ROOM_FULL -> reclaim-offer -> reclaim-pick] -> genres -> done
//
// Every RPC call surfaces its `status` as plain text rather than a
// generic error -- §6's jsonb status convention exists specifically so
// the client can show a real message instead of "something went wrong."

const STATUS_MESSAGES = {
  BAD_CODE: "That code doesn't match a room.",
  BAD_PIN: 'Wrong PIN.',
  RATE_LIMITED: 'Too many attempts. Wait 15 minutes and try again.',
  ROOM_FULL: 'That room already has two people.',
  ALREADY_IN_ROOM: "You're already in a room.",
  MEMBER_ACTIVE: "That person's been active recently -- ask them to check their own device.",
  NOT_A_MEMBER: 'That person is not in this room.',
  BAD_DISPLAY_NAME: 'Enter a name.',
  BAD_PIN_FORMAT: 'PIN must be 4 digits.',
  NO_PLATFORMS: 'Choose at least one streaming service.',
  BAD_PLATFORM: "That's not one of the four supported services.",
};

function friendlyError(status) {
  return STATUS_MESSAGES[status] || 'Something went wrong. Try again.';
}

export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState('welcome');
  const [pendingJoin, setPendingJoin] = useState(null); // { code, pin } for the reclaim path
  const [reclaimMembers, setReclaimMembers] = useState([]);
  const [genrePrefs, setGenrePrefs] = useState([]);
  const [userId, setUserId] = useState(null);

  const goToGenres = (uid) => {
    setUserId(uid);
    setStep('genres');
  };

  const finishGenres = async () => {
    if (userId) await updateGenrePrefs(userId, genrePrefs);
    onComplete();
  };

  return (
    <div className="onboarding">
      {step === 'welcome' && (
        <Welcome onCreate={() => setStep('create')} onJoin={() => setStep('join')} />
      )}
      {step === 'create' && (
        <CreateRoom
          onBack={() => setStep('welcome')}
          onCreated={(uid) => goToGenres(uid)}
        />
      )}
      {step === 'join' && (
        <JoinRoom
          onBack={() => setStep('welcome')}
          onJoined={(uid) => goToGenres(uid)}
          onRoomFull={async (code, pin) => {
            setPendingJoin({ code, pin });
            try {
              const res = await listReclaimMembers(code, pin);
              if (res.status === 'OK') {
                setReclaimMembers(res.members);
                setStep('reclaim');
              }
            } catch {
              /* stay on the join screen; its own error state already shows ROOM_FULL */
            }
          }}
        />
      )}
      {step === 'reclaim' && (
        <ReclaimPicker
          members={reclaimMembers}
          onBack={() => setStep('join')}
          onReclaimed={(uid) => goToGenres(uid)}
          pendingJoin={pendingJoin}
        />
      )}
      {step === 'genres' && (
        <GenrePicker
          selected={genrePrefs}
          onChange={setGenrePrefs}
          onDone={finishGenres}
        />
      )}
    </div>
  );
}

function Welcome({ onCreate, onJoin }) {
  return (
    <div className="onboard-screen">
      <h1 className="onboard-title">Streaming Swipe</h1>
      <p className="onboard-sub">Swipe on movies and shows together, see what you both want to watch.</p>
      <button className="onboard-btn onboard-btn--primary" onClick={onCreate}>
        Create a room
      </button>
      <button className="onboard-btn" onClick={onJoin}>
        Join with a code
      </button>
    </div>
  );
}

function CreateRoom({ onBack, onCreated }) {
  const [name, setName] = useState('');
  const [platforms, setPlatforms] = useState([]);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const togglePlatform = (slug) => {
    setPlatforms((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createRoom(name, platforms, pin);
      if (res.status === 'OK') {
        setResult(res.room);
      } else {
        setError(friendlyError(res.status));
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="onboard-screen">
        <h1 className="onboard-title">Room created</h1>
        <p className="onboard-sub">Share this code and PIN with your partner.</p>
        <p className="room-code">{result.code}</p>
        <p className="onboard-sub">PIN: {pin}</p>
        <button
          className="onboard-btn onboard-btn--primary"
          onClick={async () => {
            const {
              data: { user },
            } = await supabase.auth.getUser();
            onCreated(user.id);
          }}
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="onboard-screen">
      <button className="onboard-back" onClick={onBack}>
        Back
      </button>
      <h1 className="onboard-title">Create a room</h1>

      <label className="field">
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>

      <fieldset className="field">
        <legend>Streaming services</legend>
        {PLATFORMS.map((p) => (
          <label key={p.slug} className="checkbox">
            <input
              type="checkbox"
              checked={platforms.includes(p.slug)}
              onChange={() => togglePlatform(p.slug)}
            />
            {p.label}
          </label>
        ))}
      </fieldset>

      <label className="field">
        Room PIN (4 digits)
        <input
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
      </label>

      {error && <p className="field-error">{error}</p>}

      <button
        className="onboard-btn onboard-btn--primary"
        disabled={busy || !name || platforms.length === 0 || pin.length !== 4}
        onClick={submit}
      >
        {busy ? 'Creating…' : 'Create room'}
      </button>
    </div>
  );
}

function JoinRoom({ onBack, onJoined, onRoomFull }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await joinRoom(code, pin, name);
      if (res.status === 'OK') {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        onJoined(user.id);
      } else if (res.status === 'ROOM_FULL') {
        // §7: offer the reclaim path rather than a flat dead end.
        setError(friendlyError(res.status));
        onRoomFull(code, pin);
      } else {
        setError(friendlyError(res.status));
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboard-screen">
      <button className="onboard-back" onClick={onBack}>
        Back
      </button>
      <h1 className="onboard-title">Join a room</h1>

      <label className="field">
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>

      <label className="field">
        Room code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          autoCapitalize="characters"
        />
      </label>

      <label className="field">
        PIN
        <input
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
      </label>

      {error && <p className="field-error">{error}</p>}

      <button
        className="onboard-btn onboard-btn--primary"
        disabled={busy || !name || code.length !== 6 || pin.length !== 4}
        onClick={submit}
      >
        {busy ? 'Joining…' : 'Join room'}
      </button>
    </div>
  );
}

function ReclaimPicker({ members, onBack, onReclaimed, pendingJoin }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const pick = async (member) => {
    if (!member.reclaimable) return;
    setBusy(member.user_id);
    setError(null);
    try {
      const res = await reclaimMembership(pendingJoin.code, pendingJoin.pin, member.user_id);
      if (res.status === 'OK') {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        onReclaimed(user.id);
      } else {
        setError(friendlyError(res.status));
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="onboard-screen">
      <button className="onboard-back" onClick={onBack}>
        Back
      </button>
      <h1 className="onboard-title">Is this your room?</h1>
      <p className="onboard-sub">
        The room's full, but if you lost your session on another device, pick who you are below.
      </p>

      {error && <p className="field-error">{error}</p>}

      <ul className="reclaim-list">
        {members.map((m) => (
          <li key={m.user_id}>
            <button
              className="onboard-btn"
              disabled={!m.reclaimable || busy === m.user_id}
              onClick={() => pick(m)}
            >
              {m.display_name}
              {!m.reclaimable && <span className="reclaim-note"> — active recently</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GenrePicker({ selected, onChange, onDone }) {
  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div className="onboard-screen">
      <h1 className="onboard-title">What do you like?</h1>
      <p className="onboard-sub">
        Pick a few to start -- this shapes your first deck. It'll learn from your swipes after that.
      </p>
      <div className="genre-grid">
        {GENRES.map((g) => (
          <button
            key={g.id}
            className={`genre-chip ${selected.includes(g.id) ? 'genre-chip--on' : ''}`}
            onClick={() => toggle(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <button className="onboard-btn onboard-btn--primary" onClick={onDone}>
        Start swiping
      </button>
    </div>
  );
}
