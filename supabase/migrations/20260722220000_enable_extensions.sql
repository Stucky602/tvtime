-- Architecture ref: ARCHITECTURE_v1.0.md §7
--
-- pgcrypto gives us crypt()/gen_salt() for bcrypt-hashing room PINs.
-- The RPCs that actually use it land in component 6, but the extension
-- is infrastructure, so it goes in with the rest of the schema setup.
--
-- gen_random_uuid() (used everywhere below for primary keys) does NOT
-- need this extension -- it's been built into Postgres core since v13,
-- and Supabase runs newer than that. Only crypt()/gen_salt() need it.
create extension if not exists pgcrypto;
