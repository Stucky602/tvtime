import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Architecture ref: ARCHITECTURE_v1.0.md §6.5, §10
//
// This app deploys to GitHub Pages, which serves the repo under
// https://<user>.github.io/<repo-name>/ unless a custom domain is configured.
// That means every asset path, the manifest, and the service worker all need
// to know the repo name at build time -- Vite's `base` option handles this,
// but it must match REPO_NAME below or every asset 404s in production while
// working fine in local dev (dev always serves from `/`).
//
// If you rename the repo or use a custom domain, update REPO_NAME (or set
// base to '/' for a custom domain) and nothing else needs to change.
const REPO_NAME = 'tvtime'

// GitHub Actions sets CI=true. Local `npm run dev` and `npm run build` run
// without it, so this only forces the Pages base path during the deploy
// workflow -- local builds still serve from '/' for convenience.
const isCI = process.env.CI === 'true'

export default defineConfig({
  base: isCI ? `/${REPO_NAME}/` : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Manual registration (see src/main.jsx) instead of the default
      // auto-injected registerSW.js. The default only registers once on
      // window 'load' and never checks again -- fine for a fresh
      // navigation, but a home-screen PWA is usually RESUMED from the
      // OS's app switcher rather than freshly loaded, so that listener
      // never refires. Without an explicit check-on-resume, a new
      // deploy only reaches the installed app whenever the browser's
      // own background check happens to fire (per spec, capped around
      // 24h, and not tied to when the person actually opens the app).
      // That's the exact "why doesn't my home screen icon update"
      // symptom. See main.jsx for the fix.
      injectRegister: false,
      // Minimal offline shell only (per architecture: no push, no
      // background sync in v1). This just lets the installed app open
      // to a "you're offline" state instead of a browser error.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
        // Explicit rather than relying on defaults: switching to manual
        // registration (injectRegister: false, above) changes what the
        // plugin generates here. With the default auto-injected
        // registration, the generated service worker calls
        // self.skipWaiting() and clientsClaim() unconditionally. With
        // manual registration it switches to a message-based handshake
        // instead (skipWaiting only on a postMessage) and dropped
        // clientsClaim entirely -- found by inspecting the actual build
        // output, not assumed. Setting both explicitly here restores
        // the immediate-activation behavior regardless of which
        // registration path generated the service worker, so a future
        // change to injectRegister doesn't silently reintroduce the
        // "closes the gap sometimes" bug this fixes.
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: {
        name: 'FlixPix',
        short_name: 'FlixPix',
        description: 'Swipe on movies and shows together. See what you both want to watch.',
        // Scope and start_url are relative to `base` above -- vite-plugin-pwa
        // resolves them automatically, don't hardcode a leading slash here.
        theme_color: '#10111a',
        background_color: '#10111a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
