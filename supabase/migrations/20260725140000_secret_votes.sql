-- FlixPix: the two secret votes.
--
-- Requested, half-jokingly, as "I want to watch this but only with you,
-- and only if you're actually involved" and "I want to watch this but
-- by myself". Both are real things people mean, so they are built as
-- real votes rather than as a gag.
--
--   only_with_you -- yes, but this one is ours. Not alone, not with
--                    anyone else.
--   just_me       -- yes, but I'm watching this on my own. Don't wait
--                    for me, and don't feel obliged.
--
-- DESIGN DECISION THAT MATTERS: these are deliberately EXCLUDED from
-- room_votes, and therefore from Together / Solo / Pending / Dead.
--
-- The tempting move is to treat only_with_you as a right vote so it can
-- produce a normal match. That would mean touching the vote view, which
-- is the single most heavily tested piece of logic in the app and the
-- one whose failure mode (silently wrong buckets) is hardest to notice.
-- The secret votes get their own space instead. Nothing existing
-- changes behaviour, and the secret channel stays genuinely separate,
-- which suits what it is for.
--
-- room_votes already filters `direction in ('left','right')`, so no view
-- change is needed at all. That filter, written for seen/snooze, turns
-- out to be exactly the right boundary again.

alter table swipes drop constraint if exists swipes_direction_check;
alter table swipes add constraint swipes_direction_check
  check (direction in ('left', 'right', 'seen', 'snooze', 'only_with_you', 'just_me'));

-- =====================================================================
-- submit_swipe accepts the two new directions
-- =====================================================================
-- They return early like seen and snooze: neither produces a bucket,
-- neither fires a match indicator. The payoff is in the secret screen,
-- not in the swipe deck.

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

  if p_direction not in ('left', 'right', 'seen', 'snooze', 'only_with_you', 'just_me') then
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

  -- None of these four produce a bucket. seen and snooze carry no
  -- preference; the secret votes carry plenty, but deliberately express
  -- it somewhere other than the shared buckets.
  if v_room_id is null
     or p_direction in ('seen', 'snooze', 'only_with_you', 'just_me') then
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

-- The secret screen queries these directly and often, filtered by
-- direction within a room's members.
create index if not exists swipes_secret_idx
  on swipes (direction, user_id)
  where direction in ('only_with_you', 'just_me');
