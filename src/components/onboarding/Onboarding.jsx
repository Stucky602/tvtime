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
  const [welcomeBack, setWelcomeBack] = useState(null);

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
          onJoined={(uid, res) => {
            // A returning member already has genre picks and history --
            // sending them back through onboarding would be asking
            // questions they have already answered. Confirm the
            // recognition instead, so it is obvious their swipes came
            // back rather than silently reappearing.
            if (res?.restored) {
              setWelcomeBack(res.restored_swipes ?? 0);
              setStep('welcomeback');
              return;
            }
            goToGenres(uid);
          }}
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
      {step === 'welcomeback' && (
        <div className="onboard-screen">
          <h1 className="brand">Welcome back</h1>
          <p className="onboard-sub">
            We recognised you from your name and put your history back.
            {welcomeBack ? ` ${welcomeBack} swipe${welcomeBack === 1 ? '' : 's'} restored.` : ''}
          </p>
          <p className="settings__hint">
            Your matches, your Solo list, and what the deck has learned about
            you are all where you left them.
          </p>
          <button className="onboard-btn onboard-btn--primary" onClick={onComplete}>
            Pick up where I left off
          </button>
        </div>
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
  const [showHow, setShowHow] = useState(false);

  return (
    <div className="onboard-screen">
      <h1 className="brand">FlixPix</h1>
      <p className="onboard-sub">
        Swipe on movies and shows together. Match on what you both want, and
        find out what you're free to watch without waiting.
      </p>

      <button className="onboard-btn onboard-btn--primary" onClick={onCreate}>
        Create a room
      </button>
      <button className="onboard-btn" onClick={onJoin}>
        Join with a code
      </button>

      {/* Collapsed by default. Someone who already knows what this is
          shouldn't have to scroll past an explanation to get started,
          and someone who doesn't gets a real answer in one tap. */}
      <button className="how-toggle" onClick={() => setShowHow((v) => !v)}>
        {showHow ? '\u2212' : '+'} How it works
      </button>

      {showHow && (
        <div className="how">
          <ol className="how__steps">
            <li>
              <span className="how__num shout">1</span>
              <div>
                <h3 className="how__head shout">One of you makes a room</h3>
                <p>
                  Pick your streaming services and a 4-digit PIN. You get a
                  6-character room code.
                </p>
              </div>
            </li>
            <li>
              <span className="how__num shout">2</span>
              <div>
                <h3 className="how__head shout">The other joins with it</h3>
                <p>
                  Send them the code and the PIN. A room holds exactly two
                  people. Until they join, nothing can match.
                </p>
              </div>
            </li>
            <li>
              <span className="how__num shout">3</span>
              <div>
                <h3 className="how__head shout">Both of you swipe</h3>
                <p>
                  Right for yes, left for pass, or use the buttons. Scroll a
                  card for the synopsis and a trailer. You don't have to swipe
                  at the same time or in the same place.
                </p>
              </div>
            </li>
            <li>
              <span className="how__num shout">4</span>
              <div>
                <h3 className="how__head shout">See where you landed</h3>
                <p>
                  <strong>Together</strong> is what you both said yes to.{' '}
                  <strong>Solo</strong> is what you want and they passed on, so
                  watch it without waiting. <strong>Pending</strong> is waiting
                  on them.
                </p>
              </div>
            </li>
            <li>
              <span className="how__num shout">5</span>
              <div>
                <h3 className="how__head shout">Still can't decide?</h3>
                <p>
                  Tonight's Pick runs a quick head-to-head over your matches and
                  gives you one answer.
                </p>
              </div>
            </li>
          </ol>

          <h3 className="how__head shout how__head--sep">Worth knowing</h3>
          <ul className="how__notes">
            <li>
              It learns as you go. Your first deck comes from the genres you
              pick; after that it follows your swipes, and what you rate after
              watching.
            </li>
            <li>
              Swiping left is close to permanent, so a title you pass on won't
              keep coming back. There's an undo button for a few seconds if you
              misfire.
            </li>
            <li>
              Filters narrow the deck without reloading it: length, rating,
              service, anime, genre, decade.
            </li>
            <li>
              New titles arrive overnight, so the deck refreshes on its own.
            </li>
          </ul>
        </div>
      )}
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
  // Prefill from an invite link (#join=CODE-PIN). Read once on mount and
  // then cleared from the URL, so a shared screenshot or a browser
  // history entry doesn't keep the PIN around longer than the moment it
  // was needed.
  const invite = (() => {
    try {
      const m = /#join=([A-Za-z0-9]{6})-(\d{4})/.exec(window.location.hash || '');
      if (m) {
        window.history.replaceState(null, '', window.location.pathname);
        return { code: m[1].toUpperCase(), pin: m[2] };
      }
    } catch {
      /* ignore */
    }
    return null;
  })();
  const [code, setCode] = useState(invite?.code || '');
  const [pin, setPin] = useState(invite?.pin || '');
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
        onJoined(user.id, res);
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

      <p className="settings__hint">
        Been here before? Use the same name you used last time and your
        swipes come back with you.
      </p>

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
