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
const REPO_NAME = 'couples-swipe-app'

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
      // Minimal offline shell only (per architecture: no push, no
      // background sync in v1). This just lets the installed app open
      // to a "you're offline" state instead of a browser error.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'Streaming Swipe',
        short_name: 'Swipe',
        description: 'Swipe on movies and shows together, see what you both want to watch.',
        // Scope and start_url are relative to `base` above -- vite-plugin-pwa
        // resolves them automatically, don't hardcode a leading slash here.
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
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
