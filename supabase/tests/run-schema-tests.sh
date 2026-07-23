#!/usr/bin/env bash
# Architecture ref: ARCHITECTURE_v1.0.md §13
#
# Runs supabase/tests/schema.test.sql against a fresh scratch database:
# every migration, the RLS-emulation harness, then the test file itself.
# Scans the NOTICE output for PASS/FAIL and exits non-zero on any
# failure or if psql itself errors (a raised EXCEPTION aborts psql with
# a non-zero exit, so both paths are covered).
#
# Requires a local Postgres superuser (matches how components 2-8 were
# verified during development -- see those migrations' own testing
# notes). Not run by any GitHub Actions workflow; this is a local
# developer check, same footing as `node --test src/lib/deck.test.mjs`.
#
# Usage: ./supabase/tests/run-schema-tests.sh [database-name]

set -euo pipefail

DB_NAME="${1:-tvtime_schema_test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"
HARNESS="$SCRIPT_DIR/rls_harness.sql"
TEST_FILE="$SCRIPT_DIR/schema.test.sql"

PSQL="psql -v ON_ERROR_STOP=1 -q"

echo "== Resetting scratch database: $DB_NAME =="
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
$PSQL -d postgres -c "CREATE DATABASE $DB_NAME;" >/dev/null

echo "== Applying RLS-emulation harness =="
$PSQL -d "$DB_NAME" -f "$HARNESS" >/dev/null

echo "== Applying migrations =="
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "  -> $(basename "$f")"
  $PSQL -d "$DB_NAME" -f "$f" >/dev/null
done

echo "== Running schema tests =="
set +e
OUTPUT="$($PSQL -d "$DB_NAME" -f "$TEST_FILE" 2>&1)"
STATUS=$?
set -e

echo "$OUTPUT" | grep -E "PASS:|FAIL:" | sed -E 's/^(NOTICE|ERROR):\s*//'

PASS_COUNT=$(echo "$OUTPUT" | grep -c "PASS:" || true)
FAIL_COUNT=$(echo "$OUTPUT" | grep -c "FAIL:" || true)

echo "== Cleaning up =="
$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null

echo ""
if [ "$STATUS" -ne 0 ] || [ "$FAIL_COUNT" -gt 0 ]; then
  echo "SCHEMA TESTS FAILED ($PASS_COUNT passed, $FAIL_COUNT failed, psql exit $STATUS)"
  exit 1
fi

echo "ALL SCHEMA TESTS PASSED ($PASS_COUNT checks)"
