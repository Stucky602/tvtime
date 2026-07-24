// Storage keys, worker URLs, tokens.
export const SURCHARGE = 2;

export const ORDERS_KEY = 'ltb-orders';
export const CHECKS_KEY = 'ltb-cook-checks';
export const DELIVER_CHECKS_KEY = 'ltb-deliver-checks';
export const DISH_NOTES_KEY = 'ltb-dish-notes';
export const PIPELINE_JOURNAL_KEY = 'ltb-pipeline-journal';
export const WEEK_NOTES_KEY = 'ltb-week-notes';
// The Week tab's heads-up banner: { text, on }. Kept apart from the publish
// itself so last month's wording can sit in the box unchecked and harmless,
// then be re-armed in one tap. WeekTab.jsx imports this; it was missing here,
// which is a build-stopping error in esbuild ("no matching export"), so any
// checkout with WeekTab and without this key cannot build.
export const WEEK_NOTICE_KEY = 'ltb-week-notice';
export const SHOPPING_KEY = 'ltb-shopping';
export const WEEK_KEY = 'ltb-week';
export const PENDING_KEY = 'ltb-pending-orders';
export const FEEDBACK_KEY = 'ltb_dish_feedback_v1'; // per-dish feedback: { [dish]: { tally: {good,meh,bad}, notes: [...] } }
// The knowledge journal (K1–K8): decisions, price rationale, provenance,
// done-cues, adjustments, techniques, mistakes, retirements. Rides the
// backup ring. DISH_NOTES_KEY is retired into it (one-way boot migration,
// schema v2); the old key is kept above only so the migration can read it.
export const JOURNAL_KEY = 'ltb-journal';
// Forward-only record of what was on the menu each business week, UPSERTED by
// week stamp so the several publishes a single week receives collapse into one
// row. Exists for seasonal recall, not restore (that is config-history).
export const WEEK_LEDGER_KEY = 'ltb-week-ledger';
// Kevin's note about where archive copies are kept. Small, and it PRINTS INTO
// the archive, because the one person who needs it most will not have the app.
export const COPIES_NOTE_KEY = 'ltb-copies-note';
// M1: owned container counts + the meal-pool manual adjustment. Rides the
// backup ring. Costs and type definitions live in containers.js (they are
// registry facts, not per-device state); this key holds only what varies:
// how many Kevin OWNS, and his correction to the outstanding-pool math.
export const CONTAINER_INVENTORY_KEY = 'ltb-container-inventory';
export const SEEN_ROWS_KEY = 'ltb-seen-rows';
export const REGULARS_KEY = 'ltb-regulars';
export const INVENTORY_KEY = 'ltb-inventory';
// Backup health: { lastOkAt } — the last time the ring CONFIRMED it holds this
// device's data. Persisted because an in-memory flag resets on every refresh,
// and a health signal that forgets is a health signal that lies.
export const BACKUP_STATE_KEY = 'ltb-backup-state';
// A push failing right now is not an emergency: phones lose signal and the
// 15-minute tick retries. Three missed cycles is a real problem. Warn at the
// gap, not the blip — a warning that cries wolf gets learned into furniture.
export const BACKUP_STALE_MS = 45 * 60 * 1000;
// Append-only trail of money-affecting changes. Rides the backup snapshot.
export const AUDIT_LOG_KEY = 'ltb-audit-log';
// Last-seen catalog prices/costs. Dish prices live in dishes.js and change by
// DEPLOY, so nothing in the running app can witness the edit. Diffing this
// fingerprint on boot is the only way the app notices a deploy moved a number.
export const MENU_FINGERPRINT_KEY = 'ltb-menu-fingerprint';

export const WORKER_BASE = 'https://ltb-proxy.strickland-kevinj.workers.dev';
export const PENDING_POLL_URL = WORKER_BASE + '/pending';
export const CONFIG_PUBLISH_URL = WORKER_BASE + '/config';
// Omakase: saved component groups, and the review-later queue of things Kevin
// used that the ingredient registry does not know about yet.
// Last service-worker version this device saw, so an update banner only
// appears on a real change and never on first install.
export const SW_VERSION_KEY = 'ltb-sw-version';

export const OMAKASE_TEMPLATES_KEY = 'ltb-omakase-templates';
export const OMAKASE_REG_QUEUE_KEY = 'ltb-omakase-reg-queue';

export const PUBLISH_TOKEN = 'ltb-publish-2026';
export const VAPID_PUBLIC_KEY = 'BD96MjYlJ5dAdlTEzTMLi1hAlDmy-s2d6eO5B2aavlXFdueX9jSH4BOKJpDLE2MdOKvttlwOdSrs0tjFEio3EU8';

// Legacy Google Forms CSV polling — inactive (kept as fallback).
export const USE_LEGACY_CSV = false;
export const FORM_CSV_URL = 'https://ltb-proxy.strickland-kevinj.workers.dev/sheet';
