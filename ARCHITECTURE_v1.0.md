# Couples Streaming Swipe App: Architecture v1.0

**Author passes:** v0.1 Sonnet → v0.2 Opus → v0.3 Opus Max → v0.4 Fable → v1.0 Fable Max (this pass, final)
**Status:** Final. All open items resolved, tier assignments issued (§11). Coding may begin.

**Changes in this pass:**

1. **Hosting moved to GitHub Pages, Vercel deleted from the stack entirely.** Kevin's note that
   this is hosted on GitHub, taken to its conclusion: the client never needed a server. Deck
   build was already client-side, posters come straight from TMDB's public image CDN (no key),
   and the only TMDB callers are background jobs, which move into GitHub Actions where the keys
   live in repo secrets. Zero server runtime. Static PWA + Supabase + Actions. Simpler and
   cheaper than what four passes converged on. See §4.2, §6.5, §10.
2. **Two real bugs caught in prior convergence.** (a) §7 required bucket scoping to
   `voted_at >= joined_at` but the §3.2 view SQL never implemented it; fixed in the SQL. (b)
   GitHub disables scheduled workflows in repos with no commits for 60 days, which would silently
   kill the keep-warm job and let Supabase pause. The keep-warm workflow now pushes a heartbeat
   commit to reset that clock. See §10.
3. **Seed-exit rule simplified (§5.4).** v0.4's "both users have 30+ swipes" condition had an
   asymmetric-usage flaw: an eager user who exhausts the seed gets stuck waiting on a slow
   partner. Exit is now per-user: you graduate when you finish your seeded cards. The overlap
   guarantee survives because both users received the same set.
4. **On-demand pool refresh resolved via `workflow_dispatch`.** Without a server, the in-app
   manual refresh had no home. GitHub's Run Workflow button is the manual trigger: explicit,
   free, zero client-side secrets. The auto-trigger on low unvoted count moves inside the nightly
   job. See §5.1, §10.
5. **Routing deleted.** Four tabs and a join screen need React state, not a router. On GitHub
   Pages this also sidesteps the SPA-404 problem entirely. See §6.5.
6. **Simulation question resolved: no (§13).** With two real users, live usage is a better tuner
   than synthetic simulation. `score_debug` plus a dev-mode card readout is the tuning tool. The
   divergence unit test stays, since it guards correctness, not feel.
7. **§11 final tier assignments issued**, with sub-levels and build order. This pass's stated job.

---

## 1. Product Summary

Two-person "rooms." Each room has one shared streaming platform selection (subset of Netflix,
Prime Video, Disney+, Hulu). Each user swipes on movies and TV titles pulled from TMDB, filtered
to what the room can actually stream. Swipes are logged per user. Matches (both right) and
solo-watchable (split vote) surface in dedicated tabs. No push notifications, just a transient
in-swipe indicator plus tab lists.

**Design objective.** The metric this architecture optimizes for is *time to first match*. Two
people who swipe for ten minutes and see zero matches will not open the app again. Nearly every
non-obvious decision below (shared pool, partner-pending weighting, seeded first deck, divergence
guard) exists to serve that number. When a tradeoff is unclear, favor the option that produces a
match sooner.

Constraints carried from discussion:

- Friends and family scale. Two users to start, maybe a handful of rooms later.
- Exactly 2 users per room in v1. Households are a maybe, not a plan.
- One room per user in v1.
- Movies and TV. TV is one card per series, no season granularity.
- US region only. Flatrate only, no rent or buy.
- Room join is code + PIN. Third join attempt is rejected outright.
- Left swipes are soft-permanent. Field now, logic later.
- Deck of a few hundred titles, rebuilt on load, 70% popular / 30% back catalog, weighted by
  genre preference and later by swipe history.
- Swipe-time filters: type, genre, decade. All off by default.
- Match feedback is transient and in-card. Together tab is the durable record.
- Hosted on GitHub Pages. Supabase free tier, kept warm by a GitHub Actions cron every 4 days
  with a heartbeat commit (§10).
- Auth is Supabase anonymous sign-in. ✅ Confirmed.

---

## 2. Tabs

1. **Swipe.** The deck, one card at a time. Right is interested, left is not. Filter control here.
2. **Together.** Both users swiped right.
3. **Solo.** You swiped right, partner swiped left. Reads as "watch this without them."
4. **Pending.** Titles *you swiped right on* that your partner has not voted on yet. Your
   unreciprocated left swipes are excluded: there is no decision waiting on them and no action
   you would ever take from seeing the list. (The bucket predicate in §3.2 still counts all
   votes; this is a display filter, not a data-model change.)

No both-left tab. That data exists only to feed future resurfacing.

**Solo framing.** Build the query bidirectional, render one direction in v1. The Solo tab shows
titles *you* can watch alone. The reverse ("your partner is free to watch X without you") is the
same row read from the other side and costs nothing later, but showing both in v1 muddles the tab.

**Counts.** Each tab shows an unseen-since-last-visit badge, persisted per user in
`users.tab_seen_at` (jsonb). This is the closest thing to a notification the app has and it is
what makes Together worth opening. Cheap, no service workers.

### 2.4 Watched state (new in v0.3)

v0.2 had no concept of having watched something. Together is append-only in that design, so after
a few months it is a list of two hundred titles with no signal about which ones are still live
options. That makes the app's most valuable screen its least usable one.

Minimum viable fix, room-scoped rather than user-scoped, because watching is a joint act:

```sql
create table watched (
  room_id     uuid not null references rooms(id) on delete cascade,
  tmdb_id     int not null,
  media_type  text not null,
  marked_by   uuid not null references users(id),
  marked_at   timestamptz not null default now(),
  primary key (room_id, tmdb_id, media_type),
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);
```

Behavior:

- A swipe-up gesture on a Together or Solo card marks watched. Also available from the detail
  view for anyone who does not discover the gesture.
- Watched items move to a collapsed "Watched" section at the bottom of the tab, not deleted.
  Deleting loses the history that a future recommender wants, and people like seeing the list.
- Unmark is available, because mis-taps happen.
- Watched titles are excluded from the deck permanently (they are already excluded by having
  been swiped, but this matters if resurfacing ever ships).
- Either partner can mark. No confirmation flow, no per-user watched state. With two people who
  live together this is correct, and adding per-user state here would be solving a problem that
  does not exist yet.

**Post-watch rating ✅ RESOLVED IN v0.4: yes, but non-blocking.** The v0.3 framing treated
"capture the signal" and "keep the gesture instant" as a tradeoff. They are not. The mark-watched
action completes immediately and unconditionally; *then* a transient toast appears for ~4 seconds
with thumbs up / thumbs down buttons and auto-dismisses. Ignoring it costs nothing and records
nothing. Tapping records `verdict` on the watched row.

```sql
alter table watched add column verdict text
  check (verdict in ('up','down'));           -- null = no rating given
```

Rationale: a right swipe means "looks interesting," a post-watch verdict means "was actually
good," and the second is the highest-signal data the app can collect for the eventual real
recommender. The toast pattern collects it from people willing to give it without taxing anyone
who is not. Nothing in v1 *consumes* the verdict; it accumulates, exactly like `resurface_after`
and `score_debug`. Expected fill rate is maybe a third of watched rows, which is fine, since this
data is a gift, not a requirement.

---

## 3. Data Model

### 3.1 The N-user question ✅ RESOLVED IN v0.2

Schema is generic, bucket semantics are 2-user. A `room_members` join table plus an aggregate view
is not more complex than a self-join, just less brittle, and it fails loudly rather than silently
if a third row ever appears. The part that does not generalize is the product question (with three
people, is "Together" unanimous or majority?), which has no obvious answer and no current demand.
That seam sits in a single classification function, with `rooms.max_members` defaulting to 2 and
enforced by trigger.

```sql
create table rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,          -- 6 chars, unambiguous alphabet
  pin_hash       text not null,                 -- see §7
  platforms      text[] not null default '{}',  -- {netflix, prime, disney, hulu}
  max_members    int not null default 2,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create table users (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  genre_prefs   int[] not null default '{}',  -- canonical genre ids, see §4.3
  tab_seen_at   jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table room_members (
  room_id    uuid not null references rooms(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (user_id)                            -- one room per user, v1
);
create index on room_members (room_id);

create table titles (
  tmdb_id              int not null,
  media_type           text not null check (media_type in ('movie','tv')),
  title                text not null,
  year                 int,
  runtime              int,                   -- minutes, nullable, see §4.3
  synopsis             text,
  poster_path          text,
  backdrop_path        text,
  rating               numeric,               -- vote_average
  vote_count           int,
  popularity           numeric,
  original_language    text,
  genres               int[] not null default '{}',   -- canonical, see §4.3
  providers            text[] not null default '{}',
  providers_updated_at timestamptz,
  detail_updated_at    timestamptz,
  excluded             boolean not null default false, -- see §4.4
  primary key (tmdb_id, media_type)
);
create index on titles using gin (genres);
create index on titles using gin (providers);
create index on titles (popularity desc) where not excluded;

create table swipes (
  user_id          uuid not null references users(id) on delete cascade,
  tmdb_id          int not null,
  media_type       text not null,
  direction        text not null check (direction in ('left','right')),
  voted_at         timestamptz not null default now(),
  resurface_after  timestamptz,               -- null = never, v1 default
  score_debug      jsonb,                     -- see §5.2
  primary key (user_id, tmdb_id, media_type),
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);
create index on swipes (tmdb_id, media_type);
create index on swipes (user_id, voted_at desc);
```

Capacity enforced in a trigger, not app code:

```sql
create or replace function enforce_room_capacity() returns trigger as $$
declare
  cap int;
  current_count int;
begin
  select max_members into cap from rooms where id = new.room_id for update;
  select count(*) into current_count from room_members where room_id = new.room_id;
  if current_count >= cap then
    raise exception 'ROOM_FULL';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger room_capacity before insert on room_members
  for each row execute function enforce_room_capacity();
```

The `for update` matters. Without it two people entering the same code in the same second can both
pass the count check. Unlikely with two users, free to prevent.

### 3.2 Vote aggregation

```sql
create view room_votes as
select
  rm.room_id,
  s.tmdb_id,
  s.media_type,
  count(*) filter (where s.direction = 'right') as rights,
  count(*) filter (where s.direction = 'left')  as lefts,
  count(*)                                       as total_votes,
  (select count(*) from room_members m where m.room_id = rm.room_id) as member_count,
  array_agg(s.user_id) filter (where s.direction = 'right') as right_voters
from swipes s
join room_members rm on rm.user_id = s.user_id
where s.voted_at >= rm.joined_at   -- §7 re-rooming scope; v0.4 specified this but the SQL omitted it
group by rm.room_id, s.tmdb_id, s.media_type;
```

Classification for a viewing user, 2-user semantics:

- **Together:** `total_votes = member_count and lefts = 0`
- **Solo (yours):** `rights = 1 and lefts = 1 and <you> in right_voters`
- **Pending:** `total_votes < member_count and <you> voted`
- **Dead:** `rights = 0 and total_votes = member_count`

All four are one predicate apart, which is the point. Note that `member_count` is 1 while the
partner has not joined, so everything the first user votes on classifies as Together or Dead until
the second member exists. **Guard for this explicitly:** suppress bucket classification entirely
until `member_count = 2`, and show the waiting state described in §9. Without the guard, the first
user sees their entire swipe history land in Together, which looks like a bug because it is one.

### 3.3 Migrations

Supabase CLI migrations, checked into the repo, applied by `supabase db push`. No dashboard SQL
editor for anything structural. This matters more than it sounds like it does, because the schema
lives in three places otherwise (dashboard, local dev, your head) and they will diverge.

---

## 4. TMDB Integration

### 4.1 Provider and endpoint basics

- US flatrate provider IDs: Netflix 8, Prime Video 9, Disney+ 337, Hulu 15.
- Discover: `with_watch_providers=8|9|337|15`, `watch_region=US`,
  `with_watch_monetization_types=flatrate`.
- Detail: `/movie/{id}?append_to_response=watch/providers`, same for `/tv/{id}`. The append saves
  a round trip per title, which matters when seeding a thousand.
- Genres: `/genre/movie/list`, `/genre/tv/list`.

**Discover filtering is a prefilter, not truth.** `with_watch_providers` on discover is coarse and
sometimes stale. The authoritative provider list is the per-title `watch/providers` response. So:
discover narrows the candidate set cheaply, the detail fetch establishes what actually goes in
`titles.providers`, and a title that fails the check on detail is stored with an empty provider
list rather than dropped, so it is not re-fetched on every refresh cycle.

### 4.2 API key handling ✅ REVISED IN v1.0

The TMDB key never reaches the client because **the client never calls TMDB at all.** Every TMDB
consumer in this design is a background job (pool refresh, provider re-verification), and those
run in GitHub Actions with the key in repo secrets. The one client-facing TMDB dependency is
poster and backdrop images, which are served from TMDB's public image CDN
(`https://image.tmdb.org/t/p/{size}{poster_path}`) and require no key. Prior versions routed TMDB
through Vercel handlers to hide the key; with hosting on GitHub Pages there is no server, and it
turns out none was needed. The client talks to Supabase and to a public image CDN, nothing else.

### 4.3 Data gotchas

- **Genre ID namespaces differ.** Movie and TV genre lists are separate and overlap imperfectly.
  TV has Action & Adventure (10759) where movies have Action (28) and Adventure (12). Storing raw
  IDs in one column silently mixes namespaces and breaks filtering and scoring together. **Fix:**
  a canonical internal vocabulary (about a dozen buckets: Action, Comedy, Drama, Horror,
  SciFi/Fantasy, Thriller, Documentary, Animation, Romance, Crime/Mystery, Family, Other) with a
  static mapping table from both TMDB lists. Store canonical IDs in `titles.genres` and
  `users.genre_prefs`. This also makes the onboarding picker sane, since raw TMDB is 19 movie
  genres plus 16 TV genres with confusing overlap.
- **Runtime.** Movies have `runtime` (int, sometimes null). TV has `episode_run_time` (array, often
  empty, sometimes wrong). Take the first element if present, else null, and render an em dash
  rather than "0 min."
- **Year.** `release_date` for movies, `first_air_date` for TV. Both can be empty strings, which
  throws if parsed naively.
- **Poster path.** Frequently null. Needs a placeholder treatment, not a broken image.
- **Rating with low vote counts.** A 10.0 from 3 votes otherwise dominates any quality-weighted
  sort. Store `vote_count` and apply floors (see §5.2).
- **Provider drift.** Titles leave platforms constantly and TMDB gives no leaving-soon signal. A
  title in Together can become unstreamable. **Fix:** re-verify providers weekly for anything in
  Together or Solo, monthly for the rest. The deck tolerates staleness; the "let's watch this
  tonight" list does not.
- **Rate limits.** Roughly 50 rps, generous, but discover paging caps at 500 pages and results
  past a few pages get thin. Seeding is a background job regardless, so throttle to 5-10 rps and
  never do it in a request path.

### 4.4 TV data quality (new in v0.3)

TMDB TV popularity is not what you want. Sorting `/discover/tv` by popularity surfaces daytime
soaps, telenovelas, news programs, talk shows, kids' programming, and long-running reality
franchises, because they have enormous episode counts and steady traffic. A deck seeded this way is
mostly unswipeable and reads as broken.

Exclusions applied at pool refresh, stored as `titles.excluded = true` so the filtering decision is
inspectable rather than invisible:

- **Genre exclusions (TMDB TV IDs):** 10763 News, 10767 Talk, 10764 Reality, 10766 Soap.
  Reality is arguable and some couples want it. Make it a room setting rather than a hard rule,
  defaulting to excluded.
- **`with_original_language=en`** for the popularity slice. Drops telenovelas and imported dramas
  wholesale. The back-catalog slice can relax this, since that is where prestige international
  material lives and it is quality-gated anyway.
- **`vote_count` floor of 200** for TV in the popularity slice. Cuts the long tail of shows nobody
  has rated.
- **Episode count sanity.** TMDB returns `number_of_episodes` on detail. A show with 800+ episodes
  is a soap or a kids' show. Exclude above a threshold (say 300), with the caveat that this also
  catches a few legitimate long-runners like *The Simpsons*. Acceptable tradeoff, and the exclusion
  is a flag rather than a delete, so it is reversible.

Movies need none of this. Movie popularity is comparatively well-behaved.

---

## 5. Deck Generation and Scoring

### 5.1 Architecture, and the pool question ✅ RESOLVED IN v0.3

v0.2 described a "pool per room, 800-1200 titles" but the schema had no per-room pool table. That
was an unresolved inconsistency. Resolution: **`titles` is a single global cache. A room's pool is
a derived subset, not stored.**

```
room pool = titles
            where not excluded
              and providers && room.platforms   -- array overlap
```

There is no `room_pool` table and there should not be. With four platforms and a handful of rooms,
nearly every room's pool is a large overlapping slice of the same cache, so materializing per-room
copies would duplicate almost everything to save a GIN index lookup. Refresh jobs write to the
global cache, decks read a filtered view of it. If you ever run enough rooms with enough platform
diversity for this to matter, that is a good problem and a later refactor.

Two stages:

**Stage 1: Pool refresh (background).** Query TMDB discover across the union of platforms in use
by active rooms, both media types, applying the 70/30 split:

- 70% sorted by `popularity.desc`, recency-restricted (about 3 years back).
- 30% sorted by `vote_average.desc` with `vote_count.gte=500`, no recency restriction. That vote
  floor is what keeps the back-catalog slice from filling with obscure perfect scores.

Upsert into `titles`, apply §4.4 exclusions, fetch details and true providers. Target a global
cache of a few thousand titles, which yields several hundred unvoted per room for a long time.
Triggers, revised for the serverless stack: **nightly GitHub Actions cron** as the primary;
**`workflow_dispatch`** (the Run Workflow button in the GitHub Actions UI) as the manual trigger,
which costs nothing and matches the explicit-button preference; and the low-unvoted-count check
(`POOL_REFRESH_THRESHOLD`) runs *inside* the nightly job rather than as an in-app trigger, since
the client has no server to ask. With a 3000-title cache and two users, mid-session exhaustion is
a months-away event, so next-night latency on the automatic path is fine.

**Stage 2: Deck build (on app load).** Reads `titles`, `swipes`, and `watched` only. No network
beyond Supabase. Score, sort, take the top `DECK_SIZE`, hand to the client. One query plus a
scoring pass, comfortably sub-second.

v0.1 put TMDB in the app-load path. That is the one decision in the scaffold that would have
actively hurt: multi-second cold starts on a phone plus rate-limit exposure, for no benefit.

**Deck session caching.** Cache the built deck in `sessionStorage` keyed by a build timestamp. A
mid-session reload should resume where you were, not reshuffle. Rebuild on a fresh session or when
the cached deck is exhausted or older than an hour.

### 5.2 Scoring model ✅ RESOLVED IN v0.2

Additive, transparent, tunable. Not a learned model. For two users and a few thousand swipes there
is nothing to train on, and an opaque scorer you cannot debug is worse than an explicit one you can.

```
score(t, u) = W_partner * partner_pending(t, u)
            + W_genre   * genre_affinity(t, u)
            + W_quality * quality(t)
            + W_pop     * popularity_norm(t)
            + W_recency * recency(t)
            + jitter()
```

(v0.3 had a `W_joint * joint_affinity` term in this sum. Removed in v0.4: joint affinity now
lives exclusively in the shared-spine selection, §5.4, where it does the same job without
double-correcting the personalized slice.)

**partner_pending.** 1.0 if the partner has voted on this title and the viewing user has not, else
0. This is the term that makes the app feel responsive, because it resolves Pending into Together
or Solo quickly instead of letting two people swipe past each other for weeks. Weighted to dominate
(`W_PARTNER = 3.0`), capped so no more than `PARTNER_PENDING_CAP` of a served deck is catch-up,
otherwise the deck stops being discovery.

**genre_affinity.** Onboarding preferences at first, learned weights as swipes accumulate. Per
canonical genre `g`:

```
right_g = count of right swipes on titles containing g
total_g = count of all swipes on titles containing g
affinity(g) = (right_g + alpha * prior(g)) / (total_g + alpha)
```

`prior(g)` is 1.0 if checked at onboarding, else the user's global right-swipe rate. `alpha` around
5, so onboarding dominates until roughly 5 swipes exist in that genre, then behavior takes over.
That is the entire learning system: Laplace-smoothed per-genre right rates. Deliberately
unsophisticated. It is inspectable, degrades gracefully, and on a few hundred swipes it will beat
anything fancier fit on the same data. `genre_affinity(t, u)` is the mean over the title's genres,
rescaled toward 0-1 by subtracting the user's global right rate and clamping.

**quality.** `vote_average / 10`, zeroed below `QUALITY_VOTE_FLOOR`.

**popularity_norm.** Log-scaled, normalized within the candidate pool, since raw TMDB popularity is
unbounded and spiky.

**recency.** 1.0 for the current year decaying to 0 over about 10 years, floored at 0. Weighted
lightly, since the 70/30 pool split already handles the recency mix and double counting starves the
back catalog.

**jitter.** Small uniform random term so the deck is not identical across loads. Without it the
same top cards reappear until swiped, which reads as broken.

**Log the score.** Store the computed score and component breakdown in `swipes.score_debug`. Costs
nothing at this scale and turns "why did it show me that" from a mystery into a query. It is also
exactly what a future recommender would want, so accumulating it is free optionality.

### 5.3 Filters

Type, genre, decade. All off by default. Filters mask the built deck client-side rather than
re-querying, per the v1 decision. Build to `DECK_SIZE` 150 rather than the 40 someone actually
swipes, specifically so masking has room to work. Below `MIN_FILTERED_DECK` remaining, show a plain
empty state offering to widen filters or refresh the pool. Never a silent blank deck.

### 5.4 Taste divergence (new in v0.3)

The failure mode most likely to kill this app in week one, and it is not obvious from the design.

Both users draw from the same pool, which guarantees eventual overlap. But the deck is scored
*per user*, so if one person's affinities run to horror and thrillers while the other's run to
comedy and romance, their top 150 lists can be nearly disjoint. They each swipe forty cards a
night, they never see the same title, Pending stays empty, Together stays empty, and the app
appears to be doing nothing. Worse, `partner_pending` cannot help, because it only activates once
there is already an overlap to resolve.

**Mitigation design ✅ RESOLVED IN v0.4: two mechanisms, not three.** v0.3 proposed a joint
affinity scoring term, a shared spine, *and* a seeded first deck, and flagged the redundancy
itself. The flag was right. The scoring term and the spine were the same idea implemented twice:
both inject jointly-appealing titles into the deck, but the scoring term does it probabilistically
inside the personalized ranking while the spine does it deterministically. Running both means the
personalized slice is also joint-biased, the effective shared share becomes some untunable number
above the spine ratio, and diagnosing "the deck feels impersonal" requires disentangling two
interacting corrections. Keep the deterministic one, delete the probabilistic one.

**1. Shared spine.** Reserve `SHARED_SPINE_RATIO` of every deck (start at 0.30) for titles
selected by joint affinity and served to *both* users. Selection function:

```
joint_affinity(t, room) = min(genre_affinity(t, user_a), genre_affinity(t, user_b))
```

Minimum rather than mean, deliberately. Mean rewards a title one person loves and the other hates,
which is exactly the title that will not produce a match. Minimum surfaces titles both people are
at least warm on, which is where matches come from. Spine titles are interleaved through the deck,
not front-loaded, so the session does not open with 45 consecutive compromise picks. The remaining
0.70 of the deck is scored purely per-user by §5.2, which keeps the personalization clean and the
knob singular: if matches are scarce, raise the ratio; if the deck feels generic, lower it. One
number, one effect.

**2. Seeded first deck.** On day one neither user has swipe history and `partner_pending` is zero
for everything, which is exactly when the app most needs to impress. Serve both users the same
high-popularity, high-quality deck of `SEEDED_DECK_SIZE` titles drawn from the intersection of
their onboarding genre picks, before personalization takes over. Same set, order can differ. If
the intersection is empty or yields fewer than `SEEDED_DECK_SIZE` candidates, widen in order:
union of picks, then unrestricted popularity. Never block on an empty intersection; a couple with
zero overlapping checkboxes is precisely the couple that needs the popular-consensus deck.

**Seed exit ✅ REVISED IN v1.0: per-user, not joint.** v0.4 ended the seeded phase "when both
users have 30+ swipes," which fails under asymmetric usage: an eager user who burns through the
seed in one sitting would be stuck waiting for a partner who opens the app twice a week. Exit is
now individual: **you graduate when you have swiped through your seeded cards.** The overlap
guarantee is unaffected, because it comes from both users having *received* the same 60 titles,
not from exiting simultaneously. And the spine tolerates asymmetry by construction: `min()` over
one informed affinity and one near-prior affinity still computes, it just leans on the informed
side less, which is the correct behavior when one person has barely swiped.

The seeded deck is not redundant with the spine because the spine's selection function is
undefined on day one: `genre_affinity` with no swipes is just onboarding priors, and `min` over
two flat priors has nothing to distinguish. The seed covers the cold window; the spine covers
steady state. Clean handoff, no overlap in when each is load-bearing.

Note that this walks back the v0.1 conclusion that deck order and composition do not matter. That
conclusion was correct about *correctness* (matches key on TMDB ID, order is irrelevant to whether
a match fires) and wrong about *product* (composition determines whether a match ever happens at
all). Both things are true.

**Feel-numbers ✅ CONFIRMED IN v1.0.** `SHARED_SPINE_RATIO = 0.30` means 45 shared cards in a
150-card deck. Two people swiping ~40 cards a night each hit substantial guaranteed overlap within
the first session or two, which is the point, while 70% of the deck stays personal. `SEEDED_DECK_SIZE
= 60` at typical swipe rates is one to two sessions of shared warm-up, long enough to produce early
matches, short enough that personalization arrives before the deck feels generic. Both remain
config constants and both are the first knobs to turn if lived usage disagrees, but they are
reasonable starting positions, and no simulation would validate them better than a week of real
use will (§13).

---

## 6. Swipe Write Path

One round trip. The client sends a swipe, the server upserts it and returns the resulting bucket
classification so the transient match indicator renders before the next card animates in.

Requirements:

- **Idempotent.** PK is `(user_id, tmdb_id, media_type)`, write is an upsert. A flaky connection
  retrying must not duplicate or flip a vote.
- **Optimistic UI.** Card animates out immediately, write happens in background. On failure, queue
  and retry rather than reversing the animation, which feels broken.
- **Offline queue.** Swipes buffer in localStorage on write failure and flush on reconnect. Two
  people on phones will hit dead zones. Without this, swipes vanish silently and Pending lies.
- **Undo.** Last swipe only, for `UNDO_WINDOW_SECONDS`. Mis-swipes are constant on touch and there
  is no other correction path, since the title never resurfaces. Deletes the row, returns the card.
  **Undo after a fired match:** because Together is a view over `swipes`, deleting the row retracts
  the match automatically with no cleanup logic. The partner may have seen a badge increment that
  now silently decrements. Acceptable; a five-second window makes this rare, and the alternative
  (blocking undo on matched swipes) punishes the person who mis-swiped.
- **Gesture fallbacks.** Every swipe action needs a button equivalent (left / right / undo /
  detail). Gestures are the primary interaction, not the only one. This is an accessibility floor
  and it also makes the app usable one-handed on a large phone.
- **Simultaneous match race.** If both users swipe right on the same title within the same instant,
  both round trips may report "no match yet." Harmless, since Together is computed from the view
  and will be correct, but neither sees the indicator. Acceptable in v1. Do not fix with locking.

---

### 6.5 API Surface and Stack ✅ REVISED IN v1.0

**Stack.** Vite + React PWA, **hosted on GitHub Pages.** Supabase JS client. No Vercel, no server
runtime of any kind. Pages specifics that the scaffold must get right: `base` in the Vite config
set to the repo path (`/<repo-name>/`) unless a custom domain is used, and the PWA manifest and
service worker paths must respect that base. **No router.** Four tabs and a join screen are React
state and conditional rendering, not routes; this also sidesteps the SPA-404 problem on Pages
entirely, since the app only ever serves `index.html`. State management stays at React state plus
a thin context for session and room.

**Supabase RPCs (`security definer`, the only writes that touch protected logic):**

| RPC | Args | Returns | Notes |
|---|---|---|---|
| `create_room` | display_name, platforms, pin | room {id, code} | Creates user row if needed, room, membership |
| `join_room` | code, pin, display_name | room or ROOM_FULL / BAD_PIN | Rate-limited via `join_attempts` |
| `reclaim_membership` | code, pin, member_user_id | ok or MEMBER_ACTIVE | §7 rules, rate-limited |
| `submit_swipe` | tmdb_id, media_type, direction | bucket classification | Upsert + classify, one round trip (§6) |
| `undo_swipe` | tmdb_id, media_type | ok | Validates ownership and window server-side |
| `mark_watched` | tmdb_id, media_type, verdict? | ok | Verdict nullable, updatable |
| `leave_room` | none | ok | Deletes own membership |

**Plain table and view reads (RLS-guarded, no RPC needed):** deck candidates, bucket views,
watched list, room settings, own profile. Platform updates are a direct `update` on `rooms`
under RLS.

**Background jobs (GitHub Actions, replacing the v0.4 Vercel routes):**

| Job | Schedule | Purpose |
|---|---|---|
| `refresh-pool` | Nightly cron + `workflow_dispatch` | Stage-1 pool refresh (§5.1), Node script in repo, TMDB key + service role key from repo secrets |
| `keep-warm` | Every 4 days | Trivial Supabase read + heartbeat commit (§10) |

**Deck build locality ✅ CONFIRMED IN v1.0: client-side.** v0.4 flagged this as the one decision
without a cheap reversal path. Confirmed on the merits, and the GitHub Pages constraint removes
the alternative anyway; there is no server to move it to short of a Postgres function, which is
exactly the slow-iteration path the decision avoids. The client fetches up to `DECK_CANDIDATE_CAP`
candidate rows (unvoted, unwatched, platform-filtered, not excluded, server-capped by an ordered
view, selecting only the columns the card needs) plus both members' swipe rows, which RLS already
permits, then scores and assembles seed or spine-plus-personalized locally. The port path, if
scale ever demands it, is a Postgres function implementing §5.2 verbatim; the formula is specified
precisely so that port is transcription, not design.

**Badge refresh: poll on focus, no realtime.** Badge counts refresh when the app gains focus and
after each swipe response. Supabase Realtime would make the partner's matches appear live, but
the product explicitly has no notifications, both users are rarely in-app simultaneously, and a
realtime channel is a standing complexity tax. If simultaneous couch-swiping turns out to be the
dominant usage pattern, revisit; the subscription is additive later.

## 7. Auth and Room Flow ✅ RESOLVED IN v0.3

**Supabase anonymous sign-in.** Confirmed. Each device gets a real `auth.users` row and a JWT, so
RLS works properly, identity is durable across app restarts, and swipes are correctly attributed,
with zero signup friction. Room code and PIN remain the pairing mechanism, which is what they were
always for.

**The one real cost** is that an anonymous identity lives in device local storage. Clear browser
data or switch phones and the identity is gone along with room membership.

**Reclaim flow, specified rather than deferred.** It is about fifteen lines and it prevents the
single worst user-facing failure this design has, which is a person losing their entire swipe
history and their partner seeing a stranger appear in their room.

- A user entering a room code + PIN for a room that is already full is offered "this is my room, I
  lost my session" rather than a flat ROOM_FULL.
- Choosing it lists the room's members by display name. The user picks which one they are.
- If that member's `last_seen_at` is older than `RECLAIM_IDLE_HOURS` (start at 24), the reclaim
  succeeds: the `room_members` row is repointed to the new `user_id`, and the old user's `swipes`
  are reassigned by updating `user_id`. History is preserved, identity is transferred.
- If the member has been active more recently than that, refuse. Someone with the code and PIN
  should not be able to evict a live user.
- Rate limit reclaims like joins.

**Optional email linking** stays deferred. Supabase supports upgrading an anonymous user to a
permanent one, so the escape hatch exists whenever it is wanted, and with the reclaim flow in place
it is no longer load-bearing.

**Room codes.** 6 characters from an unambiguous alphabet (no 0/O, 1/I/L). Generate, check
uniqueness, retry on collision. Collisions are theoretical at this scale and the retry is three lines.

**PIN.** 4 digits, stored hashed (pgcrypto). Not because the threat model warrants it, but because
plaintext credentials in a database is a habit worth not forming. Rate limit join attempts to
`JOIN_ATTEMPT_LIMIT` per room per 15 minutes via a small `join_attempts` table. This mostly
prevents a buggy client from hammering the endpoint.

**Join flow.** A signs in anonymously, sets display name, picks platforms, creates a room, gets
code + PIN. B signs in, sets display name, enters code + PIN. Trigger enforces capacity. A third
attempt gets ROOM_FULL plus the reclaim offer, never a silent failure and never a bumped member.

**Anonymous auth abuse.** Anyone can mint unlimited anonymous users. At friends-only scale this is
not a threat, and Supabase applies its own rate limits to anonymous sign-in. Worth knowing it
exists, not worth building against.

**Leaving and re-rooming.** A user can leave a room (deletes `room_members`, retains swipes). Note
the consequence: if they later join a *different* room, their entire prior swipe history is
immediately visible to the new partner as Pending, which is both confusing and mildly invasive.
With one room per user in v1 this is a corner, but the fix is one line, so take it: scope the
bucket views to swipes with `voted_at >= room_members.joined_at`. Swipes before you joined the
room do not count toward that room's buckets.

**Orphaned rooms.** A monthly cleanup removes rooms with no members and no activity for 90 days.
Small, but without it the table only grows.

---

## 8. Security: RLS and Secrets

RLS on for every table, no exceptions. With the anon key in a public PWA bundle, RLS is the only
thing between a room and the entire database.

- `users`: read/write own row only.
- `room_members`: read rows for rooms you belong to. Insert and delete only your own membership.
- `rooms`: read only if a member. Update platforms only if a member. Insert open.
  **`pin_hash` is never selectable by clients.** Put it in a separate table or expose rooms through
  a view that omits it.
- `swipes`: read swipes of any member of your room (needed for bucket views). Write only your own.
- `watched`: read and write for members of the room.
- `titles`: read open to authenticated users. Writes service-role only, since only the refresh job
  writes here.

PIN verification, room join, and reclaim all run as `security definer` RPCs, never as client-side
selects, because the client must never be able to read a `pin_hash` to compare against.

Secrets: TMDB key server-side only, service role key never in the client bundle and never inline in
a workflow file. Repo secrets for Actions.

---

## 9. Failure Modes and Edge Cases

| Case | Behavior |
|---|---|
| Partner has not joined yet | Swipe works normally, votes accumulate. Bucket classification suppressed entirely (§3.2). Together/Solo/Pending show a "waiting for your partner" state with the room code displayed for re-sharing. |
| Deck exhausted | Explicit state offering refresh and filter widening. Background refresh auto-triggers. Never a blank screen. |
| Room platforms changed after swiping | Swipes retained. Deck rebuilds against new platforms. Together/Solo entries no longer streamable get a "not on your services" marker rather than vanishing. |
| Title left all room platforms | Same marker. Never delete from Together. |
| Supabase paused despite cron | Clear "waking up" state with backoff retry, not a generic error. |
| GitHub disables the cron (60-day rule) | Prevented by the heartbeat commit (§10). If it happens anyway, symptom is the Supabase pause above; fix is re-enabling the workflow in the Actions tab. |
| TMDB down during refresh | Refresh fails silently, existing cache is served, retry next cycle. Never blocks the app. |
| Simultaneous right swipes | Both may miss the indicator. Together is still correct. |
| Duplicate or retried write | Idempotent upsert, no-op. |
| Long synopsis | Truncate with expand-on-tap. Card layout must not depend on text length. |
| Missing poster | Placeholder with title text. |
| User clears browser data | Reclaim flow (§7). |
| User re-rooms with old history | Buckets scoped to `voted_at >= joined_at` (§7). |
| Both users swipe left on everything | Deck exhausts fast. This is the app working correctly and the users being difficult. Empty state should say something to that effect. |

---

## 10. Infrastructure ✅ REVISED IN v1.0

- **GitHub Pages:** hosts the static PWA. Deployed by an Actions workflow on push to main
  (`actions/deploy-pages`). HTTPS included. Custom domain optional and orthogonal.
- **Supabase** free tier: Postgres, anonymous auth, RLS, RPCs. No Edge Functions needed.
- **GitHub Actions**, three workflows:
  1. **Deploy** on push to main.
  2. **Keep-warm**, every 4 days (weekly is exactly the pause window, so weekly has no margin).
     Trivial authenticated Supabase read, **plus a heartbeat commit** (touch a `heartbeat` file
     and push). The commit is not decoration: **GitHub disables scheduled workflows in repos
     with no commit activity for 60 days.** Without the heartbeat, a quiet two months kills the
     cron, which kills the keep-warm, which pauses Supabase, and the failure is silent until
     someone opens the app. The heartbeat commit resets that clock every run.
  3. **Pool refresh**, nightly cron plus `workflow_dispatch` for manual runs. Node script in the
     repo. Skips inactivity: rooms with no swipes in 30 days do not drive discover paging.
- **Secrets** (repo secrets, never in code): `TMDB_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_URL`. The client bundle contains only the Supabase URL and anon key, which are
  public by design and guarded by RLS.
- **Repo visibility:** public works (no secrets in code, Actions minutes are unlimited on public
  repos) but private is fine too; the nightly job is a few minutes against a 2000-minute month.
- **PWA:** mobile-first, installable, service worker limited to the install manifest and a
  minimal offline shell. No push in v1.

---

## 11. Model Tier Assignments ✅ FINAL, v1.0

This pass's stated job. Tiers are Sonnet / Opus / Fable with effort level (low / medium / high)
within each. The principle: Sonnet executes what is fully specified, Opus handles components where
correctness depends on reasoning about interactions the spec cannot fully enumerate, Fable is
reserved for the one component whose quality is felt rather than verified. Escalate any component
one step if its first attempt fails review; do not start higher than assigned.

| # | Component | Tier | Rationale |
|---|---|---|---|
| 1 | Repo scaffold: Vite + Pages base path, manifest, deploy workflow | Sonnet medium | Mechanical, but the base-path/PWA interaction is a known footgun worth care |
| 2 | Schema, migrations, triggers, views (incl. §3.2 joined_at fix) | Sonnet high | Fully specified SQL; high effort because a schema bug taxes everything downstream |
| 3 | Seed script (fake users, titles, randomized swipes) | Sonnet low | Build this immediately after #2, everything else develops against it |
| 4 | Canonical genre mapping table | Sonnet low | Tedious, closed-ended |
| 5 | RLS policies | Opus medium | Highest blast radius per line in the project; the §8 spec is the contract, the reasoning is whether each policy actually enforces it |
| 6 | RPCs: join, reclaim, swipe, undo, watched | Opus medium | `security definer` + concurrency + rate limiting; §6.5 table is the contract |
| 7 | Pool refresh Actions script (TMDB paging, §4.4 exclusions, throttle, upserts) | Sonnet high | Long but linear; every rule is written down |
| 8 | Keep-warm + heartbeat workflow | Sonnet low | Twenty lines of YAML |
| 9 | Deck build client module (candidates, scoring, seed/spine/personal assembly, session cache) | Opus medium | Formula is explicit but the three-phase assembly and cap interactions (§5.2, §5.4) reward reasoning |
| 10 | Swipe UI: gestures, animation, optimistic writes, offline queue, undo | **Opus high** | The component the whole app is judged by. If the first pass does not feel right in hand, escalate to **Fable low** rather than iterating Opus a third time; touch feel is where taste outruns spec |
| 11 | Tab views, watched state, verdict toast, badges | Sonnet medium | Straightforward queries and rendering against #2's views |
| 12 | Onboarding, room create/join screens, reclaim UI | Sonnet medium | Specified flows; server logic already lives in #6 |
| 13 | Filters UI + deck masking | Sonnet low | Client-side masking over the built deck |
| 14 | Test suite (§13) | Sonnet medium | Table-driven; the divergence test design is already written |

**Build order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 10 → 11 → 12 → 13 → 14, with 8 anytime. The
seed script's position at #3 is deliberate: every UI component after it gets built against a
populated app instead of an empty one.

**Session sizing note:** components 5, 6, 9, and 10 each deserve their own session with this
document attached. The Sonnet items can batch two or three per session.

---

## 12. Config Constants

One module, not scattered:

```
POOL_TARGET_SIZE        3000     // global cache, not per room
POOL_REFRESH_THRESHOLD  100      // unvoted count triggering background refresh
DECK_SIZE               150
SEEDED_DECK_SIZE        60       // per-user exit on exhaustion, §5.4; no joint threshold
POPULAR_RATIO           0.70
BACKCATALOG_VOTE_FLOOR  500
QUALITY_VOTE_FLOOR      100
TV_VOTE_FLOOR           200
TV_MAX_EPISODES         300
PARTNER_PENDING_CAP     0.60
SHARED_SPINE_RATIO      0.30
W_PARTNER               3.0
W_GENRE                 1.0
W_QUALITY               0.5
W_POP                   0.4
W_RECENCY               0.2
JITTER_RANGE            0.1
GENRE_SMOOTHING_ALPHA   5
PROVIDER_REFRESH_DAYS   30       // 7 for titles in Together/Solo
MIN_FILTERED_DECK       5
UNDO_WINDOW_SECONDS     5
VERDICT_TOAST_SECONDS   4
DECK_CANDIDATE_CAP      500      // rows fetched for client-side build
DECK_CACHE_TTL_MINUTES  60
JOIN_ATTEMPT_LIMIT      5        // per room per 15 min
RECLAIM_IDLE_HOURS      24
ROOM_CODE_LENGTH        6
```

---

## 13. Testing

Minimal but non-zero. The places where a silent bug is expensive:

- **Bucket classification.** Pure function over a vote set. Table-driven tests for all four buckets
  plus the partner-has-not-joined case plus the `joined_at` scoping. This is the app's core logic
  and it is trivially testable, so there is no excuse.
- **Scoring.** Snapshot test that a known pool with known swipe history produces an expected
  ordering. Catches weight-tuning regressions. **Simulation question ✅ RESOLVED IN v1.0: no
  simulation harness.** With two real users, a week of lived usage tunes the weights better than
  any synthetic couple would, and building the harness costs more than the answer is worth at
  n=2. The tuning tools are `swipes.score_debug` plus a dev-mode toggle that renders each card's
  score breakdown in the corner. If the app ever has enough rooms for aggregate tuning, revisit.
- **Divergence guard.** Construct two users with deliberately opposed genre affinities and assert
  their decks share at least `SHARED_SPINE_RATIO` of titles. This is the test that catches the §5.4
  failure before your wife does.
- **Genre mapping.** Assert every TMDB movie and TV genre ID maps to exactly one canonical genre.
  A missing mapping silently degrades scoring for that genre forever.
- **Capacity trigger and reclaim.** Integration tests for third-join rejection and for reclaim
  succeeding on an idle member while refusing an active one.
- **Seed script.** Two fake users, a few hundred titles, randomized swipe history, so UI can be
  built against a populated app. Worth writing first, not last.

---

## 14. Deferred Past v1

- Resurfacing left swipes (`resurface_after` exists, nothing writes to it).
- A learned recommender beyond smoothed genre affinity.
- Households, N > 2, and the bucket semantics that would require.
- Push notifications.
- Rent/buy availability, non-US regions, more platforms.
- Season-level TV granularity.
- Optional email linking (reclaim flow covers the need).
- Anything that *consumes* the post-watch verdict (§2.4 collects it; nothing reads it in v1).

---

## 15. Sign-off

No open items remain. What this pass checked beyond its assigned questions, honoring v0.4's
instruction to distrust four-pass convergence: the bucket predicates against all vote
combinations (correct), the reclaim flow's swipe reassignment for PK collisions (safe, a fresh
anonymous identity has no swipes), pgcrypto's bcrypt availability (present), the RLS/client-deck
consistency (§8 read permissions cover exactly what §6.5 fetches), and the two bugs in the
changelog. The stack contradiction (Vercel in a GitHub-hosted project) was resolved by deletion
rather than accommodation, which is the correct direction for a friends-scale app: every runtime
removed is a thing that cannot break.

Coding begins at §11 component 1. Attach this document to every coding session. When lived usage
disagrees with a constant in §12, change the constant, not the architecture.
