-- Architecture ref: ARCHITECTURE_v1.0.md §8, §13
--
-- LOCAL VERIFICATION HARNESS -- not applied by `supabase db reset`, and
-- never run against the hosted project.
--
-- Emulates the parts of Supabase that RLS depends on (the anon /
-- authenticated / service_role roles, auth.uid(), and Supabase's default
-- "broad grants, RLS as the gate" privilege posture) so the policies in
-- 20260722220500_rls_policies.sql can be exercised against a plain
-- Postgres instance without Docker or the full local stack.
--
-- Usage against a scratch database:
--     psql -d scratch -f supabase/tests/rls_harness.sql
--     for f in supabase/migrations/*.sql; do psql -d scratch -f "$f"; done
--     psql -d scratch -f supabase/seed.sql
--
-- Then impersonate a user and query normally:
--     set role authenticated;
--     set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
--     select count(*) from rooms;   -- should be 1, not 2
--
-- Reproducing Supabase's default grants (the ALTER DEFAULT PRIVILEGES at
-- the bottom) is the part that's easy to skip and important not to: the
-- RLS migration REVOKEs against exactly those grants, so a harness
-- without them would make every revoke look like a no-op and the tests
-- would pass for the wrong reason.
--
-- Component 14 (test suite) should build on this rather than reinvent it.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

-- Supabase's real auth.uid() reads the sub claim out of the request JWT.
-- Locally we drive it off a session GUC that the tests set directly.
create or replace function auth.uid() returns uuid
  language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- The three roles Supabase provisions. NOLOGIN is fine; tests use SET ROLE.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's default posture: broad table grants, with RLS as the real
-- gate. Reproducing it here matters -- the component 5 migration revokes
-- against exactly these grants, so testing without them would make the
-- revokes look like no-ops.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
