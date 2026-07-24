import { useState } from 'react';
import { PLATFORMS, GENRES } from '../../lib/config.js';
import {
  updatePlatforms,
  updateIncludeReality,
  updateGenrePrefs,
  leaveRoom,
  removeMember,
  resetMyData,
} from '../../lib/room.js';
import { clearCachedDeck } from '../../lib/data.js';

// Update 2: a settings screen.
//
// This closes a real hole rather than adding a nicety. The room code was
// shown exactly once -- on the "Room created" screen during onboarding --
// and then became permanently unreachable. If your partner didn't join
// in that same sitting, or reinstalled, or you simply closed the app
// before writing it down, there was no way to recover it short of a SQL
// query. The room code is the entire mechanism by which a second person
// gets in, so it needs a permanent home.
//
// Everything else here was similarly write-once during onboarding:
// platforms, genre preferences, the reality-TV toggle (§4.4, which had
// a database column and no UI at all). Leaving a room was implemented as
// an RPC in component 6 and never wired to anything.
//
// The PIN is deliberately NOT shown. It's stored bcrypt-hashed (§7) and
// is not readable even by the server -- showing a placeholder would just
// invite the question. If it's forgotten, the recovery path is leaving
// and recreating the room.

export default function Settings({ room, user, partner, onClose, onRoomLeft }) {
  const [platforms, setPlatforms] = useState(room.platforms || []);
  const [includeReality, setIncludeReality] = useState(room.include_reality || false);
  const [genrePrefs, setGenrePrefs] = useState(user.genre_prefs || []);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetGenres, setResetGenres] = useState(false);
  const [copied, setCopied] = useState(false);
  // Needed to build a share link. Never displayed -- the stored PIN is
  // bcrypt-hashed and unreadable, so this is only populated if the user
  // types it here to generate a link.
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);

  const dirty =
    JSON.stringify([...platforms].sort()) !== JSON.stringify([...(room.platforms || [])].sort()) ||
    includeReality !== (room.include_reality || false) ||
    JSON.stringify([...genrePrefs].sort()) !== JSON.stringify([...(user.genre_prefs || [])].sort());

  const togglePlatform = (slug) =>
    setPlatforms((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));

  const toggleGenre = (id) =>
    setGenrePrefs((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  // Reading a 6-character code and a 4-digit PIN aloud is the worst
  // moment in the product, and every new user has to do it exactly
  // once. A share link carries both, so the other person taps rather
  // than transcribes.
  //
  // The PIN travels in the URL fragment (#) rather than the query
  // string, deliberately: fragments are never sent to the server and
  // stay out of server logs, referrer headers, and analytics. It is
  // still a link that grants room access, so it is treated like one --
  // the UI says so plainly rather than implying it is safe to post
  // publicly.
  const joinUrl = `${window.location.origin}${window.location.pathname}#join=${room.code}-${pin || ''}`;

  const shareInvite = async () => {
    const text = `Join me on FlixPix — room ${room.code}${pin ? `, PIN ${pin}` : ''}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'FlixPix', text, url: pin ? joinUrl : undefined });
        return;
      }
      await navigator.clipboard.writeText(pin ? `${text}\n${joinUrl}` : text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Sharing failed — the code is shown above, send it manually.');
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API needs a secure context and can be refused. The
      // code is displayed in full right above the button, so a failed
      // copy is a minor inconvenience, not a dead end.
      setError('Copy failed -- the code is shown above, type it manually.');
    }
  };

  const save = async () => {
    if (platforms.length === 0) {
      setError('Pick at least one streaming service.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updatePlatforms(room.id, platforms);
      await updateIncludeReality(room.id, includeReality);
      await updateGenrePrefs(user.id, genrePrefs);
      // Any of these changes what belongs in the deck, and the deck is
      // cached in sessionStorage (§5.1) -- without clearing it you'd
      // keep swiping the old one until the cache aged out.
      clearCachedDeck();
      setSavedNote('Saved. Your deck will rebuild next time you open Swipe.');
      setTimeout(() => setSavedNote(null), 4000);
    } catch (err) {
      setError(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const doLeave = async () => {
    setSaving(true);
    try {
      await leaveRoom();
      clearCachedDeck();
      onRoomLeft();
    } catch (err) {
      setError(err.message || 'Could not leave the room.');
      setSaving(false);
    }
  };

  return (
    <div className="settings">
      <div className="settings__head">
        <h1>Settings</h1>
        <button className="settings__close" onClick={onClose}>
          Done
        </button>
      </div>

      <section className="settings__group">
        <h2>Room code</h2>
        <p className="settings__hint">
          {partner
            ? `You and ${partner.display_name} are in this room.`
            : "Share this code and your PIN so your partner can join. They'll need both."}
        </p>
        <p className="settings__code">{room.code}</p>
        <button className="onboard-btn" onClick={copyCode}>
          {copied ? 'Copied' : 'Copy code'}
        </button>

        {!partner && (
          <>
            <label className="field">
              Add your PIN to make a one-tap invite
              <input
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="4 digits"
              />
            </label>
            <p className="settings__hint">
              We can't read your stored PIN — it's hashed. Type it once here and
              we'll build a link that fills in both for them. Treat that link
              like a key: anyone with it can join.
            </p>
            <button
              className="onboard-btn onboard-btn--primary"
              onClick={shareInvite}
              disabled={pin.length !== 4}
            >
              Share invite link
            </button>
          </>
        )}
      </section>

      <section className="settings__group">
        <h2>Streaming services</h2>
        <p className="settings__hint">Shared by the room -- changing these changes both decks.</p>
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
      </section>

      <section className="settings__group">
        <h2>Reality TV</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeReality}
            onChange={(e) => setIncludeReality(e.target.checked)}
          />
          Include reality shows
        </label>
        <p className="settings__hint">
          Off by default. News, talk shows, and soaps are always excluded.
        </p>
      </section>

      <section className="settings__group">
        <h2>Your genres</h2>
        <p className="settings__hint">
          Just a starting point -- the deck learns from your swipes regardless.
        </p>
        <div className="genre-grid">
          {GENRES.map((g) => (
            <button
              key={g.id}
              className={`genre-chip ${genrePrefs.includes(g.id) ? 'genre-chip--on' : ''}`}
              onClick={() => toggleGenre(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </section>

      {error && <p className="field-error">{error}</p>}
      {savedNote && <p className="settings__saved">{savedNote}</p>}

      <button
        className="onboard-btn onboard-btn--primary"
        onClick={save}
        disabled={saving || !dirty}
      >
        {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
      </button>

      {partner && (
        <section className="settings__group">
          <h2>Partner</h2>
          <p className="settings__hint">
            {partner.display_name} is in this room. Removing them frees the second
            slot so someone else can join with the code and PIN. Their swipes are
            kept, not deleted.
          </p>
          {confirmKick ? (
            <div className="settings__confirm">
              <button className="onboard-btn" onClick={() => setConfirmKick(false)}>
                Cancel
              </button>
              <button
                className="onboard-btn settings__leave"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setError(null);
                  try {
                    const res = await removeMember(partner.id);
                    if (res.status === 'OK') {
                      clearCachedDeck();
                      onRoomLeft();
                    } else {
                      setError(res.status);
                    }
                  } catch (err) {
                    setError(err.message || 'Could not remove them.');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Yes, remove
              </button>
            </div>
          ) : (
            <button className="onboard-btn settings__leave" onClick={() => setConfirmKick(true)}>
              Remove {partner.display_name}
            </button>
          )}
        </section>
      )}

      <section className="settings__group">
        <h2>Start over</h2>
        <p className="settings__hint">
          Deletes every swipe you've made and rebuilds your deck from scratch.
          Your partner's swipes are untouched, and your shared Watched list is
          kept. This cannot be undone.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={resetGenres}
            onChange={(e) => setResetGenres(e.target.checked)}
          />
          Also clear my genre picks
        </label>
        {confirmReset ? (
          <div className="settings__confirm">
            <button className="onboard-btn" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              className="onboard-btn settings__leave"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  const res = await resetMyData(resetGenres);
                  if (res.status === 'OK') {
                    clearCachedDeck();
                    setSavedNote(
                      `Wiped ${res.swipes_deleted} swipe${res.swipes_deleted === 1 ? '' : 's'}. Your deck is fresh.`
                    );
                    setConfirmReset(false);
                    setTimeout(() => setSavedNote(null), 5000);
                  } else {
                    setError(res.status);
                  }
                } catch (err) {
                  setError(err.message || 'Could not reset.');
                } finally {
                  setSaving(false);
                }
              }}
            >
              Yes, wipe my swipes
            </button>
          </div>
        ) : (
          <button className="onboard-btn settings__leave" onClick={() => setConfirmReset(true)}>
            Reset my data
          </button>
        )}
      </section>

      <section className="settings__group settings__danger">
        <h2>Leave room</h2>
        <p className="settings__hint">
          Your swipes are kept, but they stop counting toward this room and you'll
          need a code to join another.
        </p>
        {confirmLeave ? (
          <div className="settings__confirm">
            <button className="onboard-btn" onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
            <button className="onboard-btn settings__leave" onClick={doLeave} disabled={saving}>
              Yes, leave
            </button>
          </div>
        ) : (
          <button className="onboard-btn settings__leave" onClick={() => setConfirmLeave(true)}>
            Leave room
          </button>
        )}
      </section>
    </div>
  );
}
