-- FlixPix: "Seen it" and "Snooze" as outcomes distinct from a pass.
--
-- THE CORRECTNESS PROBLEM THIS FIXES.
--
-- Three completely different intentions were collapsing into one left
-- swipe:
--
--   "not my thing"        -> a genuine negative signal
--   "already watched it"  -> no preference signal at all; you may well
--                            have loved it
--   "not tonight"         -> a timing signal, not a taste one
--
-- The recommender treated all three as dislike. So passing on a film you
-- adored five years ago actively taught it you dislike that genre. Every
-- left swipe on something already seen was poisoning the model. The
-- longer the app was used, the more wrong it got.
--
-- Now they are separate directions, and each is handled on its own
-- terms:
--
--   seen   -- removed from the deck permanently, contributes NOTHING to
--             genre affinity, and never appears in a bucket.
--   snooze -- removed for a while, then returns. `resurface_after` has
--             existed since the original schema for exactly this and
--             nothing has ever written to it until now.

-- =====================================================================
-- 1. Allow the new directions
-- =====================================================================

alter table swipes drop constraint if exists swipes_direction_check;
alter table swipes add constraint swipes_direction_check
  check (direction in ('left', 'right', 'seen', 'snooze'));

create or replace function app_snooze_window() returns interval
  language sql immutable as $$ select interval '45 days' $$;

-- =====================================================================
-- 2. Keep them out of the vote tallies
-- =====================================================================
-- Critical, and easy to miss: room_votes counts every swipe row, so
-- without this a "seen" would count toward total_votes and could make a
-- title read as Together or Dead. Neither seen nor snooze is a vote, so
-- they are filtered out at the source.
--
-- Column list is unchanged, so `create or replace` works and the
-- dependent user_title_buckets view keeps working untouched.

create or replace view room_votes as
select
  rm.room_id,
  s.tmdb_id,
  s.media_type,
  count(*) filter (where s.direction = 'right') as rights,
  count(*) filter (where s.direction = 'left')  as lefts,
  count(*)                                       as total_votes,
  (select count(*) from room_members m where m.room_id = rm.room_id) as member_count,
  array_agg(s.user_id) filter (where s.direction = 'right') as right_voters,
  jsonb_object_agg(s.user_id, s.direction) as votes_by_user
from swipes s
join room_members rm on rm.user_id = s.user_id
where s.voted_at >= rm.joined_at
  -- Only left/right are opinions about whether you want to watch it.
  and s.direction in ('left', 'right')
group by rm.room_id, s.tmdb_id, s.media_type;

-- =====================================================================
-- 3. submit_swipe accepts the new outcomes
-- =====================================================================

create or replace function submit_swipe(
  p_tmdb_id int,
  p_media_type text,
  p_direction text,
  p_score_debug jsonb default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_joined_at timestamptz;
  v_prior_direction text;
  v_rights int;
  v_lefts int;
  v_total int;
  v_members int;
  v_bucket text;
  v_is_new_match boolean := false;
  v_resurface timestamptz := null;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  if p_direction not in ('left', 'right', 'seen', 'snooze') then
    return jsonb_build_object('status', 'BAD_DIRECTION');
  end if;
  if p_media_type not in ('movie', 'tv') then
    return jsonb_build_object('status', 'BAD_MEDIA_TYPE');
  end if;

  if not exists (
    select 1 from titles where tmdb_id = p_tmdb_id and media_type = p_media_type
  ) then
    return jsonb_build_object('status', 'UNKNOWN_TITLE');
  end if;

  if p_direction = 'snooze' then
    v_resurface := now() + app_snooze_window();
  end if;

  select rm.room_id, rm.joined_at into v_room_id, v_joined_at
  from room_members rm where rm.user_id = v_uid;

  select direction into v_prior_direction
  from swipes
  where user_id = v_uid and tmdb_id = p_tmdb_id and media_type = p_media_type;

  insert into swipes (user_id, tmdb_id, media_type, direction, voted_at, score_debug, resurface_after)
  values (v_uid, p_tmdb_id, p_media_type, p_direction, now(), p_score_debug, v_resurface)
  on conflict (user_id, tmdb_id, media_type) do update
    set direction = excluded.direction,
        voted_at = excluded.voted_at,
        score_debug = coalesce(excluded.score_debug, swipes.score_debug),
        resurface_after = excluded.resurface_after;

  update users set last_seen_at = now() where id = v_uid;
  if v_room_id is not null then
    update rooms set last_active_at = now() where id = v_room_id;
  end if;

  -- Neither seen nor snooze produces a bucket, so there is nothing to
  -- classify and nothing to celebrate.
  if v_room_id is null or p_direction in ('seen', 'snooze') then
    return jsonb_build_object('status', 'OK', 'bucket', null, 'is_new_match', false);
  end if;

  select
    count(*) filter (where s.direction = 'right'),
    count(*) filter (where s.direction = 'left'),
    count(*)
  into v_rights, v_lefts, v_total
  from swipes s
  join room_members rm on rm.user_id = s.user_id
  where rm.room_id = v_room_id
    and s.tmdb_id = p_tmdb_id
    and s.media_type = p_media_type
    and s.voted_at >= rm.joined_at
    and s.direction in ('left', 'right');

  select count(*) into v_members from room_members where room_id = v_room_id;

  if v_members < 2 then
    v_bucket := null;
  elsif v_total = v_members and v_lefts = 0 then
    v_bucket := 'together';
  elsif v_rights = 1 and v_lefts = 1 and p_direction = 'right' then
    v_bucket := 'solo';
  elsif v_total < v_members then
    v_bucket := 'pending';
  elsif v_rights = 0 and v_total = v_members then
    v_bucket := 'dead';
  end if;

  v_is_new_match := coalesce(
    (v_bucket = 'together') and (v_prior_direction is distinct from 'right'),
    false
  );

  return jsonb_build_object(
    'status', 'OK',
    'bucket', v_bucket,
    'is_new_match', v_is_new_match
  );
end;
$$;

revoke all on function app_snooze_window() from public, anon;
grant execute on function app_snooze_window() to authenticated;

-- Snoozed titles are queried by "is it time to bring this back yet",
-- which is a small selective slice of a large table.
create index if not exists swipes_resurface_idx
  on swipes (user_id, resurface_after)
  where resurface_after is not null;
