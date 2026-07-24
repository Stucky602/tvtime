import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// Why this exists, not just the default auto-injected registration:
// see the comment on `injectRegister: false` in vite.config.js. Short
// version -- a home-screen PWA is usually resumed from the OS's app
// switcher, not freshly loaded, so a register-once-on-load script never
// checks for a new deploy again. This registers once AND re-checks
// every time the app becomes visible, which is the moment that actually
// matters: someone opening the app after you've pushed a change.
//
// registerType: 'autoUpdate' (vite.config.js) means skipWaiting and
// clientsClaim are already baked into the generated service worker, and
// the plugin's own generated code handles reloading once a new one
// takes control -- we don't need to call the function this returns
// ourselves, just trigger checks at the right moments below.
registerSW({
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return

    // Check immediately in case one was missed while the app was closed.
    registration.update()

    // The actual fix: check again every time the app comes back into
    // view. This is what fires when the app is reopened from the home
    // screen after being backgrounded, which is the normal way people
    // use an installed PWA and exactly when a stale version would
    // otherwise go unnoticed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        registration.update()
      }
    })

    // Backstop for a session left open a long time without ever being
    // backgrounded (e.g. left on a TV-adjacent tablet).
    setInterval(() => registration.update(), 60 * 60 * 1000)
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
