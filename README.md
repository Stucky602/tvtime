# Streaming Swipe

Two-person room, swipe on movies and TV, see what you both want to watch.
Full design in `ARCHITECTURE_v1.0.md` (attach it to every coding session).

This is component 1 of that document's build order (section 11): repo scaffold,
GitHub Pages base path, PWA manifest, deploy workflow. No screens, no
Supabase, no TMDB yet -- those are later components.

## One-time setup

1. Push this repo to GitHub as `couples-swipe-app`. If you name it
   something else, update `REPO_NAME` in `vite.config.js` to match, or
   the production build's asset paths will 404.
2. In the repo: **Settings -> Pages -> Build and deployment -> Source ->
   "GitHub Actions"**. That's the only manual step -- the workflow in
   `.github/workflows/deploy.yml` handles the rest on every push to `main`.
3. First push to `main` triggers the deploy. Check the Actions tab for
   the URL once it finishes (also shown in Settings -> Pages after the
   first successful run).

## Local development

```
npm install
npm run dev       # serves from / for convenience
npm run build     # local build also serves from /
CI=true npm run build   # matches what the deploy workflow produces --
                         # use this if you need to check the Pages-path
                         # build locally, e.g. with `npm run preview`
```

## Structure

```
src/
  components/
    swipe/     # the swipe deck UI -- component 10, Opus high
    tabs/      # Together / Solo / Pending views -- component 11, Sonnet
  lib/         # Supabase client, scoring module, deck build -- component 9
scripts/       # pool-refresh Actions script lands here -- component 7
.github/workflows/
  deploy.yml   # this component
```

`.gitkeep` files mark folders that are intentionally empty right now.
Delete each one as its component adds real files.

## Build order (from the architecture doc, section 11)

1. Repo scaffold (this) -> 2. Schema/migrations -> 3. Seed script ->
4. Genre mapping -> 5. RLS policies -> 6. RPCs -> 7. Pool refresh job ->
9. Deck build module -> 10. Swipe UI -> 11. Tabs -> 12. Onboarding/room
flow -> 13. Filters -> 14. Tests. (8, keep-warm, fits in anytime.)

Each numbered component has a model tier and effort level assigned in
section 11 of the architecture doc -- check there before starting the next one.

## Icons

`public/pwa-192x192.png` and `public/pwa-512x512.png` are placeholders
(a solid background with a letter). Swap them for real artwork whenever --
nothing downstream depends on their content, only their filenames
and dimensions.
