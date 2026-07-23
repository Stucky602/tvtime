import { useEffect, useState } from 'react';
import Onboarding from './components/onboarding/Onboarding.jsx';
import SwipeScreen from './components/swipe/SwipeScreen.jsx';
import Settings from './components/settings/Settings.jsx';
import TonightsPick from './components/tabs/TonightsPick.jsx';
import Stats from './components/tabs/Stats.jsx';
import { fetchTogether } from './lib/tabs.js';
import { TogetherTab, SoloTab, PendingTab } from './components/tabs/TabPages.jsx';
import TabBar from './components/tabs/TabBar.jsx';
import { ensureSession, isConfigured } from './lib/supabase.js';
import { getMyRoomState } from './lib/room.js';
import { rpc } from './lib/supabase.js';
import './components/swipe/swipe.css';
import './components/tabs/tabs.css';
import './components/onboarding/onboarding.css';
import './components/settings/settings.css';

// Architecture ref: ARCHITECTURE_v1.0.md §6.5 ("no router. Four tabs and
// a join screen need React state, not a router"), §7 (session bootstrap)
//
// Top-level shell: sign in anonymously, resolve room state, gate on
// onboarding if there's no room yet, then show the four tabs. Genuinely
// no router -- `tab` is a single piece of state, and every screen is a
// conditional render, matching the architecture's explicit call on this.

export default function App() {
  const [ready, setReady] = useState(false);
  const [configError, setConfigError] = useState(!isConfigured);
  const [session, setSession] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [tab, setTab] = useState('swipe');
  const [showSettings, setShowSettings] = useState(false);
  const [overlay, setOverlay] = useState(null); // 'pick' | 'stats' | null
  const [pickCandidates, setPickCandidates] = useState([]);
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    // §13: the dev-mode score readout is the tuning tool in place of a
    // simulation harness. No UI toggle needed for two users -- a query
    // param is enough (`?dev=1`) and doesn't cost a settings screen for
    // a debug affordance nobody but the person tuning weights will use.
    setDevMode(new URLSearchParams(window.location.search).has('dev'));
  }, []);

  useEffect(() => {
    if (!isConfigured) return; // configError already set; nothing to bootstrap
    (async () => {
      try {
        const s = await ensureSession();
        setSession(s);
        const state = await getMyRoomState(s.user.id);
        setRoomState(state);
      } catch (err) {
        console.error('Session bootstrap failed:', err);
        setConfigError(true);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // §7 / §6.5: keep last_seen_at fresh so the reclaim idle check means
  // something, riding on the focus poll the app already does.
  useEffect(() => {
    if (!session) return;
    const touch = () => {
      rpc('touch_session').catch(() => {
        /* best-effort; never surface this */
      });
    };
    touch();
    window.addEventListener('focus', touch);
    return () => window.removeEventListener('focus', touch);
  }, [session]);

  const refreshRoomState = async () => {
    if (!session) return;
    const state = await getMyRoomState(session.user.id);
    setRoomState(state);
  };

  if (configError) {
    return (
      <div className="app">
        <div className="onboard-screen">
          <h1 className="brand">FlixPix</h1>
          <h2 className="onboard-title">Not configured</h2>
          <p className="onboard-sub">
            This build is missing Supabase credentials. Copy <code>.env.example</code> to{' '}
            <code>.env</code>, fill in the two values, and rebuild. See the README's Database
            section for where to find them.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return <div className="app" aria-busy="true" />;
  }

  // Known gap: if a user reloads mid-onboarding after create/join but
  // before finishing the genre step, `roomState.room` is already set
  // (the room write succeeded) and they'd land straight in the tab
  // shell, skipping genre picks permanently -- there's no "resume
  // onboarding" state, only "has a room or doesn't." Narrow enough
  // (a reload in a ~10-second window) that it's not worth a persisted
  // onboarding-progress flag yet; genres are editable in Settings now,
  // which softens it further.

  if (!roomState?.room) {
    return (
      <div className="app">
        <Onboarding onComplete={refreshRoomState} />
      </div>
    );
  }

  const { room, user, partner } = roomState;

  if (overlay === 'pick') {
    return (
      <div className="app">
        <TonightsPick
          candidates={pickCandidates}
          roomPlatforms={roomState.room.platforms}
          onClose={() => setOverlay(null)}
        />
      </div>
    );
  }

  if (overlay === 'stats') {
    return (
      <div className="app">
        <Stats
          room={roomState.room}
          user={roomState.user}
          partner={roomState.partner}
          onClose={() => setOverlay(null)}
        />
      </div>
    );
  }

  if (showSettings) {
    return (
      <div className="app">
        <Settings
          room={room}
          user={user}
          partner={partner}
          onClose={async () => {
            setShowSettings(false);
            await refreshRoomState();
          }}
          onRoomLeft={async () => {
            setShowSettings(false);
            await refreshRoomState();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'swipe' && (
        <SwipeScreen
          room={room}
          user={user}
          partner={partner}
          devMode={devMode}
          onOpenSettings={() => setShowSettings(true)}
          onOpenStats={() => setOverlay('stats')}
        />
      )}
      {tab === 'together' && (
        <TogetherTab
          roomId={room.id}
          roomPlatforms={room.platforms}
          onTonightsPick={async () => {
            try {
              setPickCandidates(await fetchTogether());
            } catch {
              setPickCandidates([]);
            }
            setOverlay('pick');
          }}
        />
      )}
      {tab === 'solo' && <SoloTab roomId={room.id} />}
      {tab === 'pending' && <PendingTab roomId={room.id} />}

      <TabBar
        active={tab}
        onChange={setTab}
        userId={user.id}
        tabSeenAt={user.tab_seen_at}
      />
    </div>
  );
}
