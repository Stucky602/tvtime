-- FlixPix: the secret votes were not actually secret.
--
-- Reported the hard way: one partner installed the app and could read
-- the other's private picks. Two separate leaks, and the UI one was the
-- lesser of them.
--
--   1. The screen rendered a section headed "<partner>'s alone",
--      listing their `just_me` votes outright. My design note at the
--      time said "these are statements TO your partner, the privacy is
--      in the gesture that casts them" -- which was a defensible model
--      and the wrong one. The whole point of a secret gesture is that
--      what it produces is private.
--
--   2. Underneath that, RLS let either member SELECT the other's swipe
--      rows, secret directions included. So even with the section gone,
--      anyone who opened the network tab -- or any future screen that
--      queried swipes without thinking -- would see them.
--
-- Fixing only the screen would have left a privacy promise resting on
-- nobody writing the wrong query later. This fixes the data.

-- =====================================================================
-- 1. Secret votes are readable only by their author
-- =====================================================================
-- Everything else about the policy is unchanged: you still read your own
-- rows, and you still read your room-mate's ORDINARY votes, which is
-- what Together / Solo / Pending are built on.

drop policy if exists swipes_select_room on swipes;
create policy swipes_select_room on swipes
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id in (select current_room_user_ids())
      and direction not in ('only_with_you', 'just_me')
    )
  );

-- =====================================================================
-- 2. The mutual set, computed where the client cannot see the inputs
-- =====================================================================
-- "Ours" needs both people's secret votes, and the policy above now
-- forbids the client from reading half of them. That is the point: the
-- intersection is the only thing either person is entitled to, so it is
-- computed here and only the intersection comes back.
--
-- A one-sided pick therefore never leaves the database, which is what
-- makes the mutual reveal mean anything. If a partner could see an
-- unmatched claim, the surprise would be gone and so would the reason
-- for the whole feature.

create or replace function my_secret_lists()
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_partner uuid;
  v_ours jsonb;
  v_claimed jsonb;
  v_alone jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'NOT_AUTHENTICATED');
  end if;

  select room_id into v_room_id from room_members where user_id = v_uid;

  select user_id into v_partner
  from room_members
  where room_id = v_room_id and user_id <> v_uid
  limit 1;

  -- Both of you, independently, on the same title.
  select coalesce(jsonb_agg(jsonb_build_object('tmdb_id', m.tmdb_id, 'media_type', m.media_type)), '[]'::jsonb)
    into v_ours
  from swipes m
  join swipes t
    on t.tmdb_id = m.tmdb_id
   and t.media_type = m.media_type
   and t.user_id = v_partner
   and t.direction = 'only_with_you'
  where m.user_id = v_uid
    and m.direction = 'only_with_you'
    and v_partner is not null;

  -- Yours, still unanswered. Deliberately says nothing about whether
  -- they have found the gesture, let alone what they picked.
  select coalesce(jsonb_agg(jsonb_build_object('tmdb_id', s.tmdb_id, 'media_type', s.media_type)), '[]'::jsonb)
    into v_claimed
  from swipes s
  where s.user_id = v_uid
    and s.direction = 'only_with_you'
    and not exists (
      select 1 from swipes t
      where t.user_id = v_partner
        and t.tmdb_id = s.tmdb_id
        and t.media_type = s.media_type
        and t.direction = 'only_with_you'
    );

  select coalesce(jsonb_agg(jsonb_build_object('tmdb_id', s.tmdb_id, 'media_type', s.media_type)), '[]'::jsonb)
    into v_alone
  from swipes s
  where s.user_id = v_uid and s.direction = 'just_me';

  -- No partner key of any kind in this payload, by construction.
  return jsonb_build_object(
    'status', 'OK',
    'ours', v_ours,
    'claimed', v_claimed,
    'alone', v_alone
  );
end;
$$;

revoke all on function my_secret_lists() from public, anon;
grant execute on function my_secret_lists() to authenticated;
