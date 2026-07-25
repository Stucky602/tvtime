# Stub harness

Builds the REAL App component tree against a fake Supabase, so browser
tests exercise the actual app rather than a rebuilt approximation.

    npx vite build --config tools/stub/vite.stub.config.js
    (cd dist-stub && python3 -m http.server 8291)

## Why this exists

Every earlier browser test rebuilt the mechanism under test inside a
throwaway App.jsx. Those tests passed consistently while a real bug sat
in the shipped tree, because they tested an understanding of the code
rather than the code itself.

Two things to know if you extend it:

- Aliases must be anchored (`/^.*supabase\.js$/`, not `/supabase\.js$/`).
  Vite replaces only the matched portion of the specifier, so an
  unanchored pattern produces `./lib/<absolute path>`.
- The stub's query builder needs every method the app calls. A missing
  one surfaces as a deck error, not a build error -- `overlaps` was the
  first.
