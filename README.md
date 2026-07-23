# Streaming Swipe

Two-person room, swipe on movies and TV, see what you both want to watch.
Full design in `ARCHITECTURE_v1.0.md` (attach it to every coding session).

**All 14 components from the architecture doc's build order are done.**
Schema, RLS, RPCs, the TMDB pool-refresh job, keep-warm, deck build and
scoring, the swipe UI, the four tabs, onboarding/room flow, filters, and
the test suites (JS + SQL). This is a working app, not a scaffold --
what's left is real Supabase/TMDB credentials, pushing to GitHub, and
using it.

## First deploy checklist -- do this once, in order

The code in this repo is complete, but a few things can't live in a
zip file no matter what: creating external accounts, pasting in keys,
and clicking a couple of one-time toggles. This is the full list --
skip nothing, the app will build fine and then silently not work if you
do.

**1. Push this repo to GitHub, named `tvtime`.**
If you name it something else, update `REPO_NAME` in `vite.config.js`
to match, or every asset in the production build 404s.

**2. Create a Supabase project** (free tier, [supabase.com](https://supabase.com)).

**3. Turn on anonymous sign-in.** Supabase dashboard -> Authentication
-> Sign In / Providers -> enable **Anonymous Sign-Ins**. This is OFF by
default and the whole app depends on it (§7) -- without it, nobody can
even open the app, let alone create a room.

**4. Apply the schema.** Nothing automated does this for you (see the
note below on why). Pick one:
- **Supabase CLI** (recommended): `npx supabase link --project-ref
  <your-project-ref>`, then `npx supabase db push`. Applies every file
  in `supabase/migrations/` in order.
- **Manual**: open the SQL Editor in the Supabase dashboard and run
  each file in `supabase/migrations/` yourself, in filename order
  (they're numbered, `20260722220000_...` through
  `20260722220700_...`).

Either way: **do not run `supabase/seed.sql`** against this project.
It's local dev/test fixtures only (fake users, fake titles) -- see the
comment at the top of that file.

**5. Get a free TMDB API key.** [themoviedb.org](https://www.themoviedb.org) ->
create an account -> Settings -> API -> request a key (the "API Read
Access Token" isn't what you want here, use the v3 API key).

**6. Add five repository secrets.** GitHub repo -> Settings -> Secrets
and variables -> Actions -> New repository secret. All five:

| Secret name | Value | Used by |
|---|---|---|
| `VITE_SUPABASE_URL` | your Supabase project URL | deploy build (baked into the client bundle) |
| `VITE_SUPABASE_ANON_KEY` | your Supabase anon key | deploy build (baked into the client bundle) |
| `SUPABASE_URL` | the SAME project URL again | pool-refresh and keep-warm scripts |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service role key | pool-refresh and keep-warm scripts |
| `TMDB_API_KEY` | your TMDB key from step 5 | pool-refresh script |

Yes, the project URL goes in twice under two different names -- Vite
only exposes build-time env vars prefixed `VITE_`, so the client build
needs its own copy even though the value is identical to `SUPABASE_URL`.
Both URL and anon key are public by design (RLS is the real gate, see
the Security model section below); the service role key and TMDB key
are the two that actually matter to keep secret.

**7. Turn on GitHub Pages.** Repo -> Settings -> Pages -> Build and
deployment -> Source -> **"GitHub Actions."**

**8. Push to `main`** (or Actions tab -> "Deploy to GitHub Pages" ->
Run workflow) to trigger the first deploy. Check the Actions tab for
the live URL once it finishes.

**9. Seed the title pool once, by hand.** Actions tab -> "Refresh title
pool" -> Run workflow. Without this the deck is empty until the nightly
2am UTC cron happens to run -- triggering it manually the first time
means you can actually open the app and swipe right away instead of
waiting.

**10. Open the deployed URL, create a room, add it to your home
screen.** From here, every future `git push` to `main` redeploys
automatically, and the PWA auto-update fix means your home-screen icon
picks up each new version the next time you open it -- no reinstalling,
ever.

**Why nothing automates step 4.** A GitHub Action that runs schema
migrations against production on every push is one bad migration away
from silently breaking the app for both of you with no review step in
between -- for two users and infrequent schema changes, a deliberate
one-time (or as-needed) manual push is the safer trade. If that
changes, this is the first thing worth automating.

## Local development

```
npm install
npm run dev       # serves from / for convenience
npm run build     # local build also serves from /
CI=true npm run build   # matches what the deploy workflow produces --
                         # use this if you need to check the Pages-path
                         # build locally, e.g. with `npm run preview`
```

For local dev against a real Supabase project (rather than the local
CLI stack described under Database below), copy `.env.example` to
`.env` and fill in the same `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` values from step 6 above.

## Database (Supabase)

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) and
Docker, for the local stack. Not needed to work on the frontend alone.

```
npx supabase start      # spins up local Postgres + Auth + Studio
npx supabase db reset    # applies every migration in supabase/migrations/,
                          # then runs supabase/seed.sql once
```

`db reset` is the one to reach for after pulling schema changes, or any
time the local database gets into a state you don't trust -- it's a full
wipe and rebuild from the migration files, not an incremental apply.

`supabase/seed.sql` is local-dev/test only (see the comment at the top of
that file for why) and gives you: two fake users with genre preferences
that partly overlap and partly diverge, one room pairing them (code
`DEV001`, PIN `4242`), ~320 synthetic titles spanning genres/decades/
providers, and a realistic mix of Together/Solo/Pending swipe history so
the tab UI has something real to render against. It was run against a
real local Postgres instance while building it, not just written and
assumed correct -- see the migration testing notes below for what that
caught.

### Security model (component 5, and what component 6 must respect)

RLS is live on every table. The short version of who can see what:

- A user sees **their own room only** -- one `rooms` row, their two
  `room_members` rows, their own and their partner's `users` rows and
  `swipes`, and their room's `watched` rows. Verified against a database
  seeded with two unrelated couples; cross-room reads return zero rows.
- `titles`, `genres`, and `tmdb_genre_map` are readable by any signed-in
  user (the title cache is global by design, section 5.1) and writable by
  nobody except the service role, which the component 7 pool-refresh job
  uses.
- `room_secrets` and `join_attempts` are readable by nobody. Not "no rows
  returned" -- the table grants are revoked outright, so a query errors.
  **This is deliberate. Do not add policies to those two tables.** They
  exist to be touched only by `SECURITY DEFINER` RPCs, which bypass RLS.
- `anon` (the pre-sign-in role) has no access to anything. Anonymous
  sign-in still produces the `authenticated` role, so this costs nothing.

Three things in that migration are load-bearing and were each verified by
deliberately breaking them and watching the failure:

1. **`enforce_room_capacity` had to become `SECURITY DEFINER`.** As
   written in component 2 it ran with the caller's rights, so once RLS
   was live the trigger's `count(*)` was itself RLS-filtered -- a
   non-member could see zero existing members, so the check passed and a
   third person landed in a two-person room. Reverting the fix in a test
   reproduced exactly that: three members in a room capped at two.
2. **The bucket views needed `security_invoker = on`.** Postgres views
   run as their owner by default, which bypasses RLS on the tables
   underneath. With it off, one couple could read another couple's rows
   straight through `user_title_buckets`. Confirmed, then fixed.
3. **Policy recursion.** The obvious `room_members` read policy queries
   `room_members`, which re-invokes the policy, which Postgres rejects
   outright. The `current_room_id()` / `current_room_user_ids()` helpers
   are `SECURITY DEFINER` specifically to break that cycle, and are
   `STABLE` so the planner calls them once per statement.

Column-level grants back up the row-level policies where RLS can't reach:
members can update `rooms.platforms` but not `code` or `max_members`
(rewriting `max_members` would defeat the capacity trigger), and users can
edit their own `display_name` and `genre_prefs` but not `id` or
`created_at`.

Two deviations from the letter of section 8, both deliberate:

- **`users` read is widened from "own row only" to "own row or
  room-mate."** The Solo tab's framing, the waiting-for-partner state,
  and the reclaim screen's member list all need the partner's display
  name. The alternative was proxying names through an RPC purely to
  satisfy the wording. Room-mates only, nothing global.
- **`rooms` insert is NOT granted**, where section 8 says "insert is
  open." Creating a room is three writes that must land together (the
  room, its PIN hash, the creator's membership); a client-side insert can
  only do the first, leaving a PIN-less room nobody can join. Component
  6's `create_room` RPC is `SECURITY DEFINER` and does all three
  atomically, so it doesn't need the policy.

`supabase/tests/rls_harness.sql` emulates Supabase's roles, `auth.uid()`,
and default grants so all of the above can be re-verified against a plain
Postgres instance. See the header of that file for usage.

### RPCs (component 6)

Every write that needs to see past RLS is a `SECURITY DEFINER` function
with a pinned `search_path`. They bypass RLS by design -- each one has to
touch rows the caller cannot see (PIN hashes, the rate-limit log, a
partner's swipes, a room not yet joined) -- so each re-derives
authorization itself from `auth.uid()` and never trusts a caller-supplied
user id.

All of them return `jsonb` with a `status` key. Expected outcomes
(`BAD_PIN`, `ROOM_FULL`, `RATE_LIMITED`, `MEMBER_ACTIVE`, ...) come back
as data rather than raised exceptions, so the client branches instead of
wrapping every call in a try/catch.

| RPC | Notes |
|---|---|
| `create_room` | Room + PIN hash + membership in one transaction |
| `join_room` | Code + PIN, rate-limited, idempotent re-join |
| `room_members_for_reclaim` | Member list for the "I lost my session" screen; PIN-gated |
| `reclaim_membership` | Transfers a membership and its swipe history |
| `submit_swipe` | Upsert + bucket classification + match flag, one round trip |
| `undo_swipe` | Ownership and window enforced server-side |
| `mark_watched` | Verdict optional, applied later by the toast |
| `leave_room` | Drops membership, retains swipes |
| `touch_session` | Keeps `last_seen_at` fresh (see below) |

Three things worth knowing before changing any of it:

1. **`last_seen_at` is load-bearing and nothing was updating it.** The
   reclaim guard refuses to evict a member who has been active within
   `RECLAIM_IDLE_HOURS`. But that column defaulted to signup time and was
   never written again, so every user would look permanently idle 24
   hours after creating their account, and anyone holding the code and
   PIN could evict a live partner. `submit_swipe` and `touch_session` now
   both refresh it. `touch_session` rides on the focus poll the client
   already does for badge counts, so it costs no extra round trip.
2. **`join_attempts.succeeded` means "the credential check passed," not
   "the join completed."** A `ROOM_FULL` response is logged as a success
   because the PIN was correct. Logging it as a failure looked right and
   was actively harmful: a user who lost their session enters the correct
   code and PIN, gets `ROOM_FULL`, and is offered the reclaim flow -- and
   under the wrong version, five taps would rate-limit them out of their
   own recovery path. Caught in testing.
3. **Reclaim merges swipe histories rather than assuming a clean slate.**
   The architecture assumed a reclaiming identity has no swipes of its
   own, which is usually but not always true (sign in fresh, swipe a few,
   then realize you should reclaim). Since `swipes` is keyed on
   `(user_id, tmdb_id, media_type)`, a blind reassignment would hit a
   primary key collision. Only the caller's *colliding* rows are dropped:
   the restored history wins on conflicts, anything unique to the new
   identity survives, nothing is lost. `joined_at` is deliberately
   preserved too -- resetting it would orphan every restored swipe behind
   the bucket views' `voted_at >= joined_at` scoping and empty the
   Together tab.

Code enumeration is deliberately not rate-limited (only PIN guessing is),
because the rate-limit log is keyed on `room_id` and a bad code resolves
to no room. A wrong code reveals only that no room has it, against a
~887M keyspace.

Unmarking a watched title needs no RPC -- component 5 grants room members
`delete` on `watched` directly.

### Pool refresh (component 7) and keep-warm (component 8)

`scripts/refresh-pool.mjs` is the only thing that writes to `titles`. It
has zero npm dependencies on purpose (Node 20's built-in `fetch` is
enough) so it doesn't need `npm ci` in its own workflow. Two phases each
run:

- **Discovery** -- pulls new titles for whichever platforms are actually
  in use (rooms active in the last 30 days; falls back to all four
  platforms if nothing qualifies yet, so a fresh deploy isn't stuck with
  an empty cache). 70% popular/recent, 30% back-catalog by rating, per
  section 5.1. Paging is stateless -- the page number is derived from the
  day of year rather than tracked in a cursor table, so there's nothing
  that can drift or get stuck.
- **Refresh** -- re-verifies provider data on titles that have gone
  stale, on a tighter cadence for anything currently sitting in any
  room's Together or Solo tab (section 4.3: the deck can tolerate
  staleness, "let's watch this tonight" can't).

Section 4.4's TV exclusions are enforced twice, deliberately: once at the
TMDB query level (`without_genres`, cheaper, skips wasted detail calls)
and again after the detail fetch (the actual source of truth, in case a
title's genres don't match what the query assumed). Reality is the one
exception -- flagged (`titles.is_reality`) rather than excluded, because
whether to show reality shows is a per-room choice (see below), not a
universal rule the way News/Talk/Soap are.

Since this sandbox can't reach `api.themoviedb.org` or a live Supabase
project, the script was verified against a local mock server instead --
`supabase/tests/pool-refresh.test.mjs` stands up an HTTP server that
speaks just enough of both APIs' shapes to exercise the real logic
(pagination, genre mapping, every exclusion rule, provider extraction,
the upsert payload) end to end. Run it with `node
supabase/tests/pool-refresh.test.mjs`. Not part of the deployed app --
it's a one-off harness for whoever touches this script next.

`.github/workflows/keep-warm.yml` does two things every 4 days: pings
Supabase (so the free tier never sees 7 days of inactivity and pauses)
and pushes a heartbeat commit (so GitHub's 60-day rule never disables
the cron itself -- see section 10 for why both halves matter).

### Two gaps this component found and fixed (schema, not just scripts)

Building the refresh job surfaced two places where the schema had a
column that nothing was actually writing to -- the same shape of bug as
`users.last_seen_at` in component 6:

- **`rooms.last_active_at`** existed since component 2 but only ever got
  set at room creation. A room would silently read as "abandoned" 30
  days after it was created, regardless of how much anyone actually used
  it. `submit_swipe` and `mark_watched` now touch it, matching how they
  already touch `users.last_seen_at`.
- **The reality-show toggle had no column at all.** Section 4.4 calls
  for it to be "a room setting... defaulting to excluded," but nothing
  in components 2-6 added anywhere to store that choice. `rooms` now has
  `include_reality` (boolean, default false) and `titles` has
  `is_reality` -- a signal distinct from `excluded`, since reality can't
  be globally excluded the way News/Talk/Soap are. Component 9's deck
  build is what will actually filter on it.

Both fixes are their own migration
(`20260722220700_room_activity_and_reality_toggle.sql`) rather than
edits to already-shipped files, since migrations are append-only.

### Deck build and swipe UI (components 9-10)

The deck logic is pure and lives in `src/lib/` split three ways:
`scoring.js` (the section 5.2 term-by-term score), `deck.js` (the
seed/spine/personalized assembly from sections 5.1 and 5.4), and
`data.js` (everything with I/O -- candidate fetch, deck caching, the
offline swipe queue). Keeping the scoring pure is what makes
`deck.test.mjs` possible; run it with `node --test src/lib/deck.test.mjs`
(22 tests, no dependencies).

The test that matters most is the section 13 divergence guard: it
constructs two users with opposed tastes and asserts their decks still
overlap by the spine ratio. Without that overlap, two people swipe every
night and never match -- the failure mode section 5.4 calls the one most
likely to kill the app, and it's invisible in normal use. There's a
paired control test proving the spine actually earns its keep (opposed
users' purely-personalized decks overlap far less than the guaranteed
share).

Two deliberate deviations from the letter of the architecture, both
found by testing and documented at their call sites:

- **Genre affinity floors its headroom.** Section 5.2 says to rescale by
  subtracting the global right rate, which divides by `(1 - rate)`. Taken
  literally that zeroes the entire genre term for anyone who mostly
  right-swipes -- precisely the user whose onboarding picks were most
  accurate. The floor keeps the term carrying signal at the extremes;
  mid-range users are unaffected. See `genreAffinityForTitle`.
- **The partner-pending cap reserves slots rather than reordering.** An
  earlier version pushed overflow to the back of the deck, which reads as
  a cap but isn't one -- a fully partner-voted pool still came back 100%
  catch-up. It now reserves deck slots for discovery titles, yielding
  only when the pool genuinely has nothing else. See
  `applyPartnerPendingCap`.

**Seed graduation is exact, not approximate.** Section 5.4's per-user
seed exit ("you graduate when you have swiped through your seeded cards")
is implemented by freezing the seed set to localStorage the first time
it's served, then testing whether every seed title is in the user's voted
set. A total-swipe-count proxy would graduate a user early if they swiped
non-seed cards first (e.g. from a filtered view), skipping the shared
warm-up the seed exists to provide.

The swipe UI (`src/components/swipe/`) uses Pointer Events for one drag
path across touch, mouse, and stylus. The write path is optimistic: the
card animates out immediately and the write follows, because section 6 is
explicit that reversing a completed animation "feels broken" -- failures
queue to localStorage and sync later instead. Every gesture has a button
equivalent (Pass / Yes / Undo) and arrow-key support, per section 6's
accessibility floor. The signature interaction is a light-leak edge that
glows along the leading side as you drag (amber for yes, cold slate for
pass), readable peripherally so you can swipe without looking straight at
a label. Verified on a phone viewport by screenshot and DOM inspection.

## Structure

```
supabase/
  migrations/  # schema, in order -- see file headers for what each does
  tests/       # RLS harness, pool-refresh mock test, schema test suite
  seed.sql     # local dev/test fixtures, see "Database" above
  config.toml  # local Supabase stack config
scripts/
  refresh-pool.mjs  # component 7 -- see "Pool refresh" above
src/
  components/
    swipe/
      SwipeDeck.jsx, SwipeCard.jsx  # component 10 -- drag, undo, match indicator
      FilterPanel.jsx               # component 13 -- type/genre/decade masking
      SwipeScreen.jsx               # wires deck build + cache + filters + offline queue
      swipe.css
    tabs/
      TabPages.jsx, TabScreen.jsx   # component 11 -- Together/Solo/Pending
      TitleListItem.jsx             # swipe-up-to-watch + verdict toast (section 2.4)
      TabBar.jsx                    # bottom nav with unseen-count badges
      tabs.css
    onboarding/
      Onboarding.jsx  # component 12 -- welcome/create/join/reclaim/genres
      onboarding.css
  lib/
    config.js    # every tunable from architecture section 12, one place
    scoring.js   # pure scoring functions (section 5.2)
    deck.js      # seed/spine/personalized assembly (sections 5.1, 5.4)
    deck.test.mjs  # component 9+ JS test suite (run: node --test)
    data.js      # candidate fetch, deck cache, offline swipe queue (section 6)
    tabs.js      # bucket queries, watched mutations, badge counts (component 11)
    room.js      # create/join/reclaim wrappers, settings updates (component 12)
    supabase.js  # client + anonymous sign-in (section 7)
  App.jsx        # session bootstrap -> onboarding gate -> four-tab shell, no router
.github/workflows/
  deploy.yml        # component 1
  pool-refresh.yml  # component 7
  keep-warm.yml     # component 8
.env.example        # copy to .env -- both values are public, RLS is the gate
```

All components have real files now -- no `.gitkeep` placeholders remain.

## Build order (from the architecture doc, section 11) -- complete

1. Repo scaffold -> 2. Schema/migrations -> 3. Seed script ->
4. Genre mapping -> 5. RLS policies -> 6. RPCs -> 7. Pool refresh job ->
8. Keep-warm -> 9. Deck build module -> 10. Swipe UI -> 11. Tab views ->
12. Onboarding/room flow -> 13. Filters -> 14. Tests

Each numbered component has a model tier and effort level assigned in
section 11 of the architecture doc -- useful context if you're revisiting
a specific piece, though the build itself is done.

## Components 11-14

**11, tab views.** Together/Solo/Pending each read `user_title_buckets`
(component 2) filtered by bucket; Pending additionally filters to your
own right-swipes on the client, per section 2's v0.4 note that this is a
display filter, not a change to the underlying predicate. Watched titles
partition into a collapsed section rather than disappearing (section
2.4) -- the bucket view has no idea what's watched, so `TabScreen` fetches
both and splits them.

Badge counts (`fetchBadgeCounts` in `src/lib/tabs.js`) do real work
rather than approximating: `user_title_buckets` has no per-row timestamp
of its own, so "unseen since last visit" is computed as the LATER of the
two swipes that produced each title's bucket, compared against
`users.tab_seen_at`. A title with no prior seen timestamp counts as
unseen.

**12, onboarding/room flow.** A state machine, not a router (section
6.5's explicit call). Welcome -> create/join -> reclaim offer on
`ROOM_FULL` -> genre picker. Every RPC status maps to a real message
(`BAD_PIN`, `RATE_LIMITED`, `MEMBER_ACTIVE`, etc.) rather than a generic
error.

Known gap, documented in `App.jsx` rather than silently left in: a
reload mid-onboarding, after room creation succeeds but before the genre
step finishes, skips straight to the tab shell with genre_prefs still
empty -- there's no persisted "resume onboarding" state, only "has a
room or doesn't." Narrow window (a few seconds), not worth a persisted
progress flag unless it turns out to matter.

**13, filters.** Type/genre/decade, all off by default, masking the
built deck client-side (section 5.3) -- `applyFilters` in `deck.js`,
`FilterPanel.jsx` for the UI. One bug caught before it shipped: the "too
few results" warning was originally computed from the already-applied
filters, so it never updated while someone was actively toggling chips
in the panel. Fixed to recompute from the live draft on every toggle.

**14, tests.** Two suites:

- `node --test src/lib/deck.test.mjs` -- 22 tests, pure JS, no
  dependencies. Scoring terms, the section 13 divergence guard (plus a
  control test proving the spine actually earns its complexity), seed
  selection and exact per-user graduation, the partner-pending cap, and
  filter masking.
- `supabase/tests/run-schema-tests.sh` -- bootstraps a scratch Postgres
  database from nothing (every migration, the RLS-emulation harness),
  runs `schema.test.sql`, and reports pass/fail. 14 checks: all four
  buckets plus the partner-not-joined suppression plus joined_at
  scoping, the capacity trigger, full genre-mapping completeness (every
  TMDB id maps to exactly one canonical genre), and the reclaim flow
  including a deliberate swipe-collision merge. Verified to actually
  catch regressions, not just pass once: deleting a genre mapping row
  and re-running produces the exact expected failure. Requires a local
  Postgres superuser, same footing as the JS suite -- not run by any
  Actions workflow, it's a local developer check.

## PWA auto-update on the home screen

If you've deployed this before and reinstalled to get changes: that
shouldn't be necessary anymore. `registerType: 'autoUpdate'`
(`vite.config.js`) was already set, but the default registration only
checks for a new version once, on the page's initial load -- an
installed home-screen PWA is almost always *resumed* from the OS app
switcher rather than freshly loaded, so that check never re-fires, and
the browser's own background check is capped around 24 hours with no
tie to when you actually open the app.

Fixed with manual registration (`injectRegister: false` +
`src/main.jsx`) that explicitly checks for an update every time the app
becomes visible again -- the moment that actually matters. `skipWaiting`
and `clientsClaim` are set explicitly in the workbox config too, since
switching to manual registration silently drops `clientsClaim` from
vite-plugin-pwa's defaults otherwise (found by inspecting the built
`sw.js`, not assumed).

Verified with a real, not simulated, test: deployed a build to a plain
static server, installed it into a persistent browser profile (so the
service worker was genuinely activated and controlling, matching a real
install), then rebuilt with an actual source change and redeployed to
the same path while that same browser page sat open and untouched --
zero reloads, zero navigation. Firing only the resume event picked up
the new version within a few seconds, exactly as a phone would behave
after you push to GitHub and someone reopens the app later.

## Icons

`public/pwa-192x192.png` and `public/pwa-512x512.png` are placeholders
(a solid background with a letter). Swap them for real artwork whenever --
nothing downstream depends on their content, only their filenames
and dimensions.


