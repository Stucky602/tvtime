// journal.js — the knowledge base (K1–K8), pure and UI-free.
//
// WHY THIS EXISTS: the app is a structured body of knowledge about how Kevin
// cooks, which currently earns its keep by running a meal-prep business. The
// journal is where the WHY lives — decisions, price rationale, provenance,
// what done looks like, fixes, techniques, mistakes, retirements. Costs are
// reconstructible from receipts; "this sauce has broken, you can see it" is
// gone when Kevin forgets it. Perishability outranks convenience.
//
// PRIVACY IS STRUCTURAL, NOT A CHECKBOX. This module must NEVER be imported
// by companion.js, form/menu/main-menu tooling, or anything that composes
// customer-facing output. Diary-shaped material (provenance especially) is
// for Kevin and his son, not for customers. tests/journal.mjs enforces the
// no-import rule by scanning the customer surfaces; the private flag on top
// of that governs the few owner-side paths (the content studio) that draft
// text which LEAVES the device.
//
// Shape follows the pipelineJournal house pattern ({ version, ... }) but the
// body is an append-friendly ARRAY, not a keyed map: a dish accumulates many
// entries over years, and order-of-telling is part of the record.
// One store, one localStorage key (JOURNAL_KEY), rides the backup ring.

export const JOURNAL_VERSION = 1;

// type → { label, hint, privateDefault }
// provenance is private BY DEFAULT (Kevin's explicit call): where a dish came
// from and who taught it is the most perishable thing in the system and the
// most personal. Everything else defaults public-to-the-owner-app but can be
// flipped per entry.
export const JOURNAL_TYPES = {
  decision:   { label: 'Decision',        hint: 'A deliberate call that should not be "fixed" later (passthroughs, sub-floor pricing, exemptions).', privateDefault: false },
  price:      { label: 'Price rationale', hint: 'Why this price is what it is. Sub-floor warnings will cite this.', privateDefault: false },
  provenance: { label: 'Provenance',      hint: 'Where this came from, who taught it, what it is adapted from.', privateDefault: true },
  doneCues:   { label: 'What done looks like', hint: 'Sensory terms, not temperatures. The thing a recipe cannot carry.', privateDefault: false },
  adjustment: { label: 'Adjustment',      hint: 'Tastes flat → what fixes it (acid, salt, fat, heat).', privateDefault: false },
  technique:  { label: 'Technique',       hint: 'How it is actually made. Written while fresh — some dishes run twice a year.', privateDefault: false },
  mistake:    { label: 'Mistake',         hint: 'What went wrong and what fixed it. Kept as data, not fixed and forgotten.', privateDefault: false },
  retirement: { label: 'Retirement',      hint: 'Why a shipped dish was killed.', privateDefault: false },
};
export const JOURNAL_TYPE_ORDER = ['decision', 'price', 'provenance', 'doneCues', 'adjustment', 'technique', 'mistake', 'retirement'];

// ── Transferable principles ────────────────────────────────────────────────
// The ONE piece of cross-dish structure in the system. Every dossier entry is
// filed under a dish, which sorts the corpus perfectly for reading the story
// of that dish — but a guided path needs SEQUENCE, and sequence is inherently
// cross-dish ("these five dishes all teach the same thing about heat").
// No dossier can hold that fact, because it belongs to all of them equally.
//
// CAPTURE IS A FLAG, NOT A TAXONOMY (Kevin's call, and the right one): mark
// the entry as holding beyond this dish, write it in that dish's voice, save
// it to that dish. Nothing else. Naming and grouping the principles happens
// LATER, in one pass over the flagged set, once there is enough of it to name
// from evidence instead of guesswork. `principle` is reserved in the shape now
// so that later pass needs no migration; nothing writes it yet.
//
// Only craft types can carry a principle. A price rationale or a retirement is
// business history, not a lesson that transfers.
export const TRANSFERABLE_TYPES = new Set(['technique', 'adjustment', 'doneCues', 'mistake']);
export const canBeTransferable = (type) => TRANSFERABLE_TYPES.has(type);

// Dependency-free id. utils.uid exists, but importing utils would drag menu.js
// and dishes.js into every consumer (including node tests) for eight random
// characters. Not worth the coupling.
const jid = () => 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function emptyJournal() {
  return { version: JOURNAL_VERSION, entries: [], deleted: [] };
}

// Tolerate anything localStorage or a hand-made payload can throw at us.
// Unknown fields on entries are PRESERVED (same non-destructive rule as
// migrations.js): a future field must survive a round-trip through old code.
export function normalizeJournal(raw) {
  if (!raw || typeof raw !== 'object') return emptyJournal();
  const entries = Array.isArray(raw.entries) ? raw.entries.filter(e => e && typeof e === 'object' && typeof e.text === 'string') : [];
  const deleted = Array.isArray(raw.deleted) ? raw.deleted.filter(e => e && typeof e === 'object' && typeof e.text === 'string') : [];
  return { version: JOURNAL_VERSION, entries, deleted };
}

// ── The one stamping decision (T3 lives here) ──────────────────────────────
// Every entry is born with ts at write time. `undated: true` marks entries
// whose REAL date is unknown (migrated legacy notes): ts still orders them,
// but the UI must show "undated" — a backfilled date would measure when the
// migration ran, not when the note was true. Same principle that killed the
// rare badge.
export function stampEntry(partial, now) {
  const type = JOURNAL_TYPES[partial && partial.type] ? partial.type : 'technique';
  const subject = partial && partial.subject && partial.subject.kind === 'dish' && partial.subject.dish
    ? { kind: 'dish', dish: String(partial.subject.dish) }
    : { kind: 'general' };
  const priv = partial && typeof partial.private === 'boolean'
    ? partial.private
    : JOURNAL_TYPES[type].privateDefault;
  // The transferable flag only means anything on craft types. If the type is
  // switched to a non-craft one after the toggle was set, the flag is dropped
  // rather than left dangling on an entry that can never be a lesson.
  const transferable = canBeTransferable(type) && !!(partial && partial.transferable);
  const entry = {
    ...partial, // unknown fields ride along (non-destructive)
    id: (partial && partial.id) || jid(),
    ts: (partial && partial.ts) || (now || new Date()).toISOString(),
    type,
    subject,
    text: String((partial && partial.text) || '').trim(),
    private: priv,
    transferable,
  };
  // Reserved for the later naming pass. Only carried if something set it;
  // never invented here.
  if (partial && typeof partial.principle === 'string' && partial.principle.trim()) {
    entry.principle = partial.principle.trim();
  } else {
    delete entry.principle;
  }
  return entry;
}

export function addEntry(journal, partial, now) {
  const j = normalizeJournal(journal);
  const entry = stampEntry(partial, now);
  if (!entry.text) return j; // an empty entry is a mis-tap, not a record
  return { ...j, entries: [...j.entries, entry] };
}

// How long a deleted entry stays recoverable. The record is meant to last a
// decade and the only other backstop is a MANUAL yearly archive, so an
// accidental delete could otherwise be unrecoverable for up to a year. This is
// not softening what removal means (a removed entry is gone from every read,
// every export, and the archive) — it is a window for the fat-finger case.
export const UNDO_WINDOW_DAYS = 30;

// The journal is Kevin's own diary, so unlike the audit log it is editable:
// correcting your own record is not tampering.
export function updateEntry(journal, id, patch) {
  const j = normalizeJournal(journal);
  return { ...j, entries: j.entries.map(e => (e.id === id ? stampEntry({ ...e, ...patch, id: e.id, ts: e.ts }) : e)) };
}

// Removal moves the entry to a tombstone list rather than dropping it on the
// floor. Everything that READS the journal ignores tombstones, so removed
// really is removed everywhere it counts; purgeTombstones drops them for good
// once the window closes.
export function removeEntry(journal, id, now) {
  const j = normalizeJournal(journal);
  const gone = j.entries.find(e => e.id === id);
  if (!gone) return j;
  return {
    ...j,
    entries: j.entries.filter(e => e.id !== id),
    deleted: [...(j.deleted || []), { ...gone, deletedAt: (now || new Date()).toISOString() }],
  };
}

export function restoreEntry(journal, id) {
  const j = normalizeJournal(journal);
  const back = (j.deleted || []).find(e => e.id === id);
  if (!back) return j;
  const { deletedAt, ...clean } = back;
  return {
    ...j,
    entries: [...j.entries, clean],
    deleted: (j.deleted || []).filter(e => e.id !== id),
  };
}

// Entries still inside the undo window, newest deletion first.
export function recentlyDeleted(journal, now) {
  const j = normalizeJournal(journal);
  const cutoff = (now || new Date()).getTime() - UNDO_WINDOW_DAYS * 86400000;
  return (j.deleted || [])
    .filter(e => Date.parse(e.deletedAt) >= cutoff)
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

// Drops anything past the window. Called on boot; safe to call any time.
export function purgeTombstones(journal, now) {
  const j = normalizeJournal(journal);
  const keep = recentlyDeleted(j, now);
  if ((j.deleted || []).length === keep.length) return j;
  return { ...j, deleted: keep };
}

// ── Reading ────────────────────────────────────────────────────────────────
// renames: pass utils.DISH_RENAMES so an entry written under an old dish name
// follows the dish (the exact silent break that hit the passport). Chain-
// following, capped at 5 hops, same as passport.js.
export function canonDishName(name, renames) {
  let n = name;
  const map = renames || {};
  for (let hop = 0; hop < 5 && map[n]; hop++) n = map[n];
  return n;
}

export function entriesForDish(journal, dishName, renames) {
  const j = normalizeJournal(journal);
  const target = canonDishName(dishName, renames);
  return j.entries.filter(e => e.subject && e.subject.kind === 'dish'
    && canonDishName(e.subject.dish, renames) === target);
}

export function generalEntries(journal) {
  const j = normalizeJournal(journal);
  return j.entries.filter(e => !e.subject || e.subject.kind !== 'dish');
}

// Owner-side surfaces that compose text which LEAVES the device (the content
// studio's worker call) must draw from this, never from raw entries.
export function publicEntries(entries) {
  return (entries || []).filter(e => !e.private);
}

// Newest price rationale for a dish — what the sub-floor warning cites so a
// deliberate spotlight price stops looking like an oversight six months on.
export function latestPriceRationale(journal, dishName, renames) {
  const list = entriesForDish(journal, dishName, renames)
    .filter(e => e.type === 'price' || e.type === 'decision')
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const priced = list.find(e => e.type === 'price') || list[0];
  return priced || null;
}

// Every flagged statement, with the dish it was written under and when.
// This is the raw material for the naming pass: in a few months, this one
// call is the whole dataset to aggregate. Sorted oldest first so the order
// reads as the order Kevin learned to say it.
export function transferableEntries(journal, renames) {
  return normalizeJournal(journal).entries
    .filter(e => e.transferable && canBeTransferable(e.type))
    .map(e => ({
      id: e.id,
      ts: e.ts,
      type: e.type,
      dish: e.subject && e.subject.kind === 'dish' ? canonDishName(e.subject.dish, renames) : null,
      text: e.text,
      principle: e.principle || null, // null until the naming pass fills it
      private: !!e.private,
    }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// Groups flagged statements by principle name. Until the naming pass runs,
// everything lands under UNNAMED — which is the correct and honest state, not
// an error. Deliberately does NOT guess names from the text: the whole point
// of deferring is that the taxonomy is Kevin's, not a clustering artifact.
export const UNNAMED_PRINCIPLE = '(unnamed — pending the naming pass)';
export function principleIndex(journal, renames) {
  const out = new Map();
  for (const e of transferableEntries(journal, renames)) {
    const key = e.principle || UNNAMED_PRINCIPLE;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(e);
  }
  return out;
}

// ── The record's own shape ─────────────────────────────────────────────────
// COVERAGE answers "what should I write about next": how many entries each
// dish has. Operational, acted on while already in the writing surface.
//
// COMPOSITION answers a different and less comfortable question: what KIND of
// record is this. If the corpus is ninety percent technique and almost no
// mistakes, then the file quietly tells whoever reads it that cooking is a
// thing that goes right. Kevin knows better and would never say it, but the
// shape of the record would say it for him. That is not visible from inside
// the writing, which is exactly why it needs to be computed.
export function dossierCoverage(journal, dishNames, renames) {
  const j = normalizeJournal(journal);
  const counts = new Map((dishNames || []).map(n => [n, 0]));
  const canonOf = new Map((dishNames || []).map(n => [canonDishName(n, renames), n]));
  for (const e of j.entries) {
    if (!e.subject || e.subject.kind !== 'dish') continue;
    const target = canonOf.get(canonDishName(e.subject.dish, renames));
    if (target) counts.set(target, counts.get(target) + 1);
  }
  const rows = [...counts.entries()]
    .map(([dish, entries]) => ({ dish, entries }))
    .sort((a, b) => a.entries - b.entries || a.dish.localeCompare(b.dish));
  return {
    rows,
    empty: rows.filter(r => r.entries === 0).length,
    documented: rows.filter(r => r.entries > 0).length,
    total: rows.length,
  };
}

export function dossierComposition(journal) {
  const j = normalizeJournal(journal);
  const byType = {};
  for (const t of JOURNAL_TYPE_ORDER) byType[t] = 0;
  for (const e of j.entries) if (byType[e.type] !== undefined) byType[e.type] += 1;
  const total = j.entries.length;
  return {
    total,
    byType,
    // Types with nothing at all. The interesting output is usually here, not
    // in the counts: a record with zero mistakes is the finding.
    missing: JOURNAL_TYPE_ORDER.filter(t => byType[t] === 0),
    transferable: j.entries.filter(e => e.transferable).length,
    private: j.entries.filter(e => e.private).length,
  };
}

// ── On this day ────────────────────────────────────────────────────────────
// The single most rewarding thing about keeping a journal is the day it starts
// talking back. Returns entries written on this calendar day in a PREVIOUS
// year. Deliberately excludes today's own writing (that is not a memory) and
// anything marked `undated`, whose date is a migration artifact rather than a
// real day.
export function entriesOnThisDay(journal, now, renames) {
  const at = now || new Date();
  const m = at.getMonth(), d = at.getDate(), y = at.getFullYear();
  return normalizeJournal(journal).entries
    .filter(e => {
      if (e.undated) return false;
      const t = new Date(e.ts);
      if (Number.isNaN(t.getTime())) return false;
      return t.getMonth() === m && t.getDate() === d && t.getFullYear() < y;
    })
    .map(e => ({
      ...e,
      yearsAgo: y - new Date(e.ts).getFullYear(),
      dish: e.subject && e.subject.kind === 'dish' ? canonDishName(e.subject.dish, renames) : null,
    }))
    .sort((a, b) => a.yearsAgo - b.yearsAgo);
}

// ── Orphaned dish names (data integrity) ───────────────────────────────────
// Names sitting in order history that the registry does not know AND that
// DISH_RENAMES does not map. Every one of them silently fragments the app:
// passport stamps, per-dish sales counts, and dossier lookups all treat the
// orphan as a separate dish that no longer exists. Three of these were found
// by eye on Jul 24 (Curry of the Week, Cumin Mushroom Noodles, Chicken
// Breast); this is what finds the next one without anybody squinting at a
// screenshot.
//
// NOT a gate test on purpose: order history lives in this device's
// localStorage, so no build-time check can see it. It runs where the data is.
export function orphanedDishNames(orders, knownNames, renames) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  const map = renames || {};
  const out = new Map();
  for (const o of orders || []) {
    for (const it of (o && o.items) || []) {
      if (!it || !it.name || it.omakase) continue;
      const canon = canonDishName(it.name, map);
      if (known.has(canon)) continue;
      // A name that DOES map through DISH_RENAMES is handled, even if its
      // target is off the menu now — that is a retirement, not an orphan.
      if (map[it.name]) continue;
      out.set(canon, (out.get(canon) || 0) + 1);
    }
  }
  return [...out.entries()]
    .map(([name, orderCount]) => ({ name, orderCount }))
    .sort((a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name));
}

// ── Legacy dishNotes migration (one-way, idempotent) ───────────────────────
// dishNotes was { [dishName]: string } — flat, undated, one slot per dish.
// Each non-empty note becomes ONE technique entry marked migrated+undated.
// Idempotent by content: an identical migrated entry for the same dish is
// never added twice, so boot-migration and payload-migration can both run
// without doubling anything.
export function migrateDishNotes(journal, dishNotes, now) {
  let j = normalizeJournal(journal);
  if (!dishNotes || typeof dishNotes !== 'object') return j;
  for (const [dish, text] of Object.entries(dishNotes)) {
    const t = String(text || '').trim();
    if (!t) continue;
    const dupe = j.entries.some(e => e.migrated === true
      && e.subject && e.subject.kind === 'dish' && e.subject.dish === dish
      && e.text === t);
    if (dupe) continue;
    j = addEntry(j, {
      type: 'technique',
      subject: { kind: 'dish', dish },
      text: t,
      migrated: true,
      undated: true, // real date unknown; never invent one
    }, now);
  }
  return j;
}

// ── The retirement nudge (K8, runtime — a gate test cannot see localStorage)
// Dishes that appear in real order history but are no longer in the registry
// and have no retirement entry. Caller passes the name sets so this module
// stays dependency-free:
//   knownNames — every name the app still serves (dinners + always items,
//                per-lb included). Anything outside it that people ORDERED
//                is a dish that left the menu.
// Nudge, never block (Kevin's call).
export function missingRetirementRecords(journal, orders, knownNames, renames) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  const recorded = new Set(
    normalizeJournal(journal).entries
      .filter(e => e.type === 'retirement' && e.subject && e.subject.kind === 'dish')
      .map(e => canonDishName(e.subject.dish, renames))
  );
  const missing = new Set();
  for (const o of orders || []) {
    for (const it of (o && o.items) || []) {
      if (!it || !it.name || it.omakase) continue; // an omakase is an act of trust, not a catalog dish
      const canon = canonDishName(it.name, renames);
      if (known.has(canon) || recorded.has(canon)) continue;
      missing.add(canon);
    }
  }
  return [...missing].sort();
}
