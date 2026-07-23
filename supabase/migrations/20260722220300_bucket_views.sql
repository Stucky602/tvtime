-- Architecture ref: ARCHITECTURE_v1.0.md §3.2, §7 (re-rooming scope), §2 (tab definitions)
--
-- Matches are a VIEW, not a stored table, on purpose (§3.2): there is no
-- match "state" that can drift from the swipes that produced it. This
-- migration builds that in two layers:
--
--   room_votes         -- one row per (room, title): vote tallies + who voted how
--   user_title_buckets -- one row per (viewing user, title): which of the
--                          four tabs it belongs to, from THAT user's side
--
-- The second view is what component 11 (tab UI) queries directly, filtered
-- by `where viewer_id = auth.uid()` and `where bucket = 'together'` etc.

create view room_votes as
select
  rm.room_id,
  s.tmdb_id,
  s.media_type,
  count(*) filter (where s.direction = 'right') as rights,
  count(*) filter (where s.direction = 'left')  as lefts,
  count(*)                                       as total_votes,
  (select count(*) from room_members m where m.room_id = rm.room_id) as member_count,
  array_agg(s.user_id) filter (where s.direction = 'right') as right_voters,
  -- Every voter's own direction, keyed by user id. This is what lets
  -- user_title_buckets below read back "what did THIS viewer vote"
  -- without a second join to swipes -- which matters because it would
  -- otherwise be easy to forget the joined_at filter on that second join
  -- and let a stale re-rooming leak through. One filtered aggregate,
  -- one source of truth.
  jsonb_object_agg(s.user_id, s.direction) as votes_by_user
from swipes s
join room_members rm on rm.user_id = s.user_id
-- §7 re-rooming fix: a user's swipes from BEFORE they joined this room
-- (e.g. leftover history from a previous room) never count toward this
-- room's votes. v0.4 specified this; the SQL in earlier drafts omitted
-- it. Fixed here.
where s.voted_at >= rm.joined_at
group by rm.room_id, s.tmdb_id, s.media_type;

create view user_title_buckets as
select
  rm.user_id as viewer_id,
  rv.room_id,
  rv.tmdb_id,
  rv.media_type,
  rv.votes_by_user ->> rm.user_id::text as viewer_direction,
  rv.rights,
  rv.lefts,
  rv.total_votes,
  rv.member_count,
  case
    -- §3.2 guard: while the partner hasn't joined yet, member_count = 1,
    -- so everything the first user votes on would otherwise satisfy the
    -- "together" predicate below. Suppress classification entirely until
    -- both members exist -- the app shows a "waiting for your partner"
    -- state instead (§9), not a room full of false matches.
    when rv.member_count < 2 then null
    when rv.total_votes = rv.member_count and rv.lefts = 0 then 'together'
    when rv.rights = 1 and rv.lefts = 1 and rm.user_id = any(rv.right_voters) then 'solo'
    -- Pending: this viewer has voted (either direction) and the partner
    -- hasn't yet. §2's v0.4 note applies here -- the UI only *displays*
    -- your right-swipes in the Pending tab, but the underlying bucket
    -- still covers both directions. That's a display filter component 11
    -- applies on top of this row, not something this view should narrow.
    when rv.total_votes < rv.member_count
         and (rv.votes_by_user ? rm.user_id::text) then 'pending'
    when rv.rights = 0 and rv.total_votes = rv.member_count then 'dead'
    else null
  end as bucket
from room_votes rv
join room_members rm on rm.room_id = rv.room_id;
