-- FlixPix: live presence + instant matches.
--
-- This is the "revisit condition" the architecture wrote down rather
-- than a reversal of it. §6.5 chose poll-on-focus specifically because
-- "both users are rarely in-app simultaneously", and said in as many
-- words: "if simultaneous couch-swiping turns out to be the dominant
-- usage pattern, revisit; the subscription is additive later." It is,
-- so this is that.
--
-- TWO MECHANISMS, TWO SECURITY STORIES -- worth being precise, because
-- they are not the same and only one of them needs anything here.
--
--   Postgres Changes (instant matches) needs NOTHING below. Realtime
--   applies the existing table RLS to every change event, so a client
--   receives a swipe row only if its `swipes` SELECT policy would have
--   let it read that row anyway. Our policy already scopes reads to
--   room-mates, so the subscription inherits exactly the right
--   boundary. No new attack surface.
--
--   Presence ("your partner is swiping right now") DOES need this.
--   Presence state is not a database row, so table RLS cannot cover it.
--   Supabase gates it on RLS policies against `realtime.messages`,
--   evaluated once when the socket joins a channel topic. Without a
--   policy, a private channel simply refuses the join; without
--   `private: true`, ANY authenticated user could join ANY room's
--   channel and watch strangers' presence.
--
-- Topic convention: `room:<room_id>`. `realtime.topic()` returns the
-- topic being joined, so the policy is a straight membership test.

-- Read: you may observe presence on a channel for a room you belong to.
drop policy if exists "flixpix room members can read realtime" on realtime.messages;
create policy "flixpix room members can read realtime"
on realtime.messages
for select
to authenticated
using (
  exists (
    select 1
    from public.room_members rm
    where rm.user_id = auth.uid()
      and realtime.topic() = 'room:' || rm.room_id::text
  )
);

-- Write: you may announce your own presence on that same channel.
drop policy if exists "flixpix room members can write realtime" on realtime.messages;
create policy "flixpix room members can write realtime"
on realtime.messages
for insert
to authenticated
with check (
  exists (
    select 1
    from public.room_members rm
    where rm.user_id = auth.uid()
      and realtime.topic() = 'room:' || rm.room_id::text
  )
);

-- The policy runs on every channel join, and Supabase reports slow
-- policy evaluation as connection latency. room_members already has a
-- unique index on user_id, so this lookup is a single index hit.

-- ---------------------------------------------------------------------
-- Postgres Changes needs the table in the publication
-- ---------------------------------------------------------------------
-- Realtime only streams tables added to the supabase_realtime
-- publication. `swipes` is the only one we need: matches, badge counts
-- and the partner-activity digest are all derived from it. Deliberately
-- NOT adding `titles` -- it is rewritten in bulk every night by the
-- refresh job, and streaming a few hundred rows at 2am to sleeping
-- phones would be pure waste.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'swipes'
    ) then
      alter publication supabase_realtime add table public.swipes;
    end if;
  end if;
end $$;
