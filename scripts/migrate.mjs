#!/usr/bin/env node
// Migration runner.
//
// WHY THIS EXISTS. The manual SQL-Editor step has silently disabled
// features more than once: a missing column made every pool-refresh
// write fail for days, and the visible symptom was "no trailers", which
// pointed nowhere near the cause. The app has no way to run migrations
// itself (GitHub Pages is static, and auto-migrating on push was
// deliberately rejected as too dangerous), so the gap is real and the
// fix is tooling, not automation.
//
// This does not replace the SQL Editor. It tells you, in one command,
// exactly which migrations a database is missing and prints the SQL to
// paste. Read-only against your data: it never executes DDL.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate.mjs
//   ... --print 20260724140000     # dump one migration's SQL
//
// Detection is by PROBE rather than a ledger table: we ask the database
// whether the thing each migration creates actually exists. A ledger
// would be cleaner in principle, but this database already has eight
// migrations applied with no ledger, and back-filling one accurately by
// hand is exactly the error-prone step this script exists to remove.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

const URL_ = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

// What each migration is detectable by. Column probes are the most
// reliable signal available over PostgREST -- selecting a column that
// does not exist returns a clean error.
const PROBES = [
  { id: '20260722220700', label: 'Room activity + reality toggle', table: 'rooms', column: 'include_reality' },
  { id: '20260723150000', label: 'Anime detection', table: 'titles', column: 'is_anime' },
  { id: '20260723160000', label: 'Trailers + watch links', table: 'titles', column: 'trailer_key' },
  { id: '20260723180000', label: 'Returning members', table: 'room_past_members', column: 'user_id' },
  { id: '20260723200000', label: 'Trailer backfill marker', table: 'titles', column: 'trailer_checked_at' },
  { id: '20260724100000', label: 'Seen / Snooze', table: 'swipes', column: 'resurface_after', verify: 'seenSnooze' },
  { id: '20260724140000', label: 'Realtime presence', table: null, verify: 'realtime' },
];

async function probe(table, column) {
  const res = await fetch(`${URL_}/rest/v1/${table}?select=${column}&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  return res.ok;
}

async function rpcExists(name) {
  // A function with no args can be POSTed; a 404 means it isn't there.
  const res = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return res.status !== 404;
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function fileFor(id) {
  return migrationFiles().find((f) => f.startsWith(id));
}

async function main() {
  const printArg = process.argv.indexOf('--print');
  if (printArg > -1) {
    const id = process.argv[printArg + 1];
    const f = fileFor(id);
    if (!f) {
      console.error(`No migration starting with ${id}`);
      process.exit(1);
    }
    process.stdout.write(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    return;
  }

  console.log('Checking which migrations are applied...\n');
  const missing = [];

  for (const p of PROBES) {
    let present;
    if (p.verify === 'realtime') {
      // Realtime has no column to probe; app_snooze_window is from the
      // migration immediately before it, so this one is reported as
      // "can't detect" rather than guessed at.
      present = null;
    } else if (p.verify === 'seenSnooze') {
      present = await rpcExists('app_snooze_window');
    } else {
      present = await probe(p.table, p.column);
    }

    const file = fileFor(p.id) || `${p.id}_*.sql`;
    if (present === null) {
      console.log(`  ?  ${p.label.padEnd(32)} ${file}  (not auto-detectable -- run it if unsure, it's safe to re-run)`);
    } else if (present) {
      console.log(`  OK ${p.label.padEnd(32)} ${file}`);
    } else {
      console.log(`  >> ${p.label.padEnd(32)} ${file}   MISSING`);
      missing.push(p.id);
    }
  }

  if (missing.length === 0) {
    console.log('\nEverything detectable is applied.');
    return;
  }

  console.log(`\n${missing.length} migration(s) to run, oldest first:`);
  for (const id of missing) console.log(`  node scripts/migrate.mjs --print ${id}`);
  console.log('\nPaste each into the Supabase SQL Editor and Run. All are safe to re-run.');
  // Non-zero so CI could gate on this if it ever runs there.
  process.exit(2);
}

main().catch((err) => {
  console.error('Migration check failed:', err.message);
  process.exit(1);
});
