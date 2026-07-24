// archiveExport.js — K10 (the yearly archive) + M3 (records as a byproduct).
// Pure builders returning SELF-CONTAINED HTML strings.
//
// THE STAKES: this is the only item in the queue whose failure mode is total.
// Everything the app knows lives in one device's localStorage; if the record
// is for Kevin's son, the record SURVIVING matters more than any feature. So
// the output obeys three rules, and tests/archive.mjs enforces all of them:
//   1. Self-contained — inline CSS, zero JS required to read, no external
//      reference of any kind. It must open in any browser in 2046.
//   2. Printable — real print CSS, because paper is the only format with a
//      century of proven shelf life.
//   3. Machine-recoverable — the same data rides in an embedded JSON block,
//      so a future tool can re-ingest without parsing prose.
// One file, two audiences.
//
// PRIVACY: the archive INCLUDES private journal entries (Kevin's explicit
// call — the archive is for him and his son, not customers). That makes this
// module owner-side diary machinery, and it inherits the journal's privacy
// wall: never import it from a customer surface. tests/journal.mjs scans for
// journal.js, and archiveExport imports journal.js, so a leak of THIS file
// onto a customer surface trips the same wall transitively.
//
// Dependency note: imports only dishes.js (import-free) and journal.js
// (dependency-free) plus utils for the rename history. No costing engines —
// the sales summary is pure COUNTING (units, households, first/last), because
// counting is reconstructible logic and costing is a moving target.

import { DISHES, ALWAYS_ITEMS } from './dishes.js';
import { RENAME_HISTORY, DISH_RENAMES } from './utils.js';
import {
  JOURNAL_TYPES, normalizeJournal, canonDishName,
  transferableEntries, principleIndex, UNNAMED_PRINCIPLE,
} from './journal.js';

// Every text field is Kevin's or a customer's — escape everything.
// Interchange schema version. Bump ONLY on a breaking shape change; additive
// fields do not need it. See the note at the embedded block below.
// ── The front door ─────────────────────────────────────────────────────────
// Written in Kevin's voice, Jul 2026. EDIT THIS FREELY — it is the one part of
// the archive that is addressed to a person rather than generated from data,
// and it is what turns the file from a database into a document written to
// someone. Plain text, one paragraph per line.
export const ARCHIVE_INTRO = [
  "If you are reading this, you found the file. Good.",
  "This is how I cook. All of it, as far as I could get it written down. It started as a way to feed some friends in Austin every Wednesday and turned into the only complete record of what I actually know, which is a thing I did not have and could not have reconstructed later.",
  "Some of what follows is a recipe. Most of it is not. A recipe tells you what to buy and how long to leave it on the heat, and it will not tell you the part that matters, which is what the thing is supposed to look like and smell like when it is right, and what to do when it is not right. That part is in here too, under each dish, in my own words, written the week I figured it out.",
  "Read it however you want. If you want the story of a dish, read its section top to bottom, oldest first. You will see me change my mind. That is not sloppiness, that is the whole point. The difference between the first version and the last version IS the knowledge, and if I had only written down the last one you would have the answer and none of the thinking.",
  "A few things are marked private. Those are for you, not for customers. Where a dish came from, who taught it to me, what I was trying to do. I kept them in here on purpose.",
  "Some entries are marked as holding beyond the dish they are under. Those are the ones worth learning first. A technique is for one plate. A principle is for every plate you will ever make.",
  "Where something is undated, I did not know the real date and I refused to make one up. An invented date is worse than no date.",
  "This file does not need me, or the app, or the internet. Open it anywhere, print it if you want. That was deliberate.",
  "Cook something.",
];

export const ARCHIVE_SCHEMA = 1;
export const ARCHIVE_FIELD_NOTES = {
  journal: 'All dossier entries. {id, ts (ISO, when WRITTEN), type, subject:{kind,dish}, text, private, transferable, undated?, migrated?, principle?}',
  transferable: 'Pre-extracted lessons: entries flagged as holding beyond their dish. principle is null until a naming pass assigns one.',
  renameHistory: 'Dish renames with dates and reasons. date null = the rename predates the record.',
  note: 'undated:true means the real date is unknown and was deliberately never invented.',
};

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtDate = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };

// Shared skeleton: inline styles only, print rules, serif body (this is a
// document, not an app), and NOTHING external.
function htmlShell(title, generatedAt, body, embeddedJson) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fdfcf8; max-width: 820px; margin: 0 auto; padding: 28px 20px; line-height: 1.55; }
  h1 { font-size: 26px; margin: 0 0 2px; } h2 { font-size: 19px; margin: 34px 0 8px; border-bottom: 2px solid #1a1a1a; padding-bottom: 3px; }
  h3 { font-size: 15px; margin: 20px 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 24px; }
  .meta { color: #666; font-size: 12px; }
  .entry { margin: 8px 0 12px; padding-left: 12px; border-left: 3px solid #d8d2c4; }
  .private { border-left-color: #b8860b; }
  .type { font-variant: small-caps; letter-spacing: 0.5px; font-weight: 700; font-size: 12px; }
  .lock { color: #b8860b; font-size: 11px; }
  .carries { color: #2e6b4f; font-size: 11px; font-weight: 700; }
  .intro { font-size: 15px; line-height: 1.7; max-width: 62ch; }
  .intro:first-of-type { font-size: 17px; }
  .principle { border-left: 3px solid #2e6b4f; padding-left: 12px; margin: 10px 0 14px; }
  .principle .src { color: #666; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
  th, td { border: 1px solid #ccc4b4; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #efe9dc; font-size: 12px; }
  .dish { page-break-inside: avoid; margin-bottom: 18px; }
  .recipeline { font-size: 13px; }
  .retired { color: #7a4a4a; }
  @media print {
    body { background: #fff; padding: 0; max-width: none; }
    h2 { page-break-after: avoid; }
    .noprint { display: none; }
  }
</style>
</head>
<body>
${body}
${embeddedJson ? `<script type="application/json" id="ltb-archive-data">
${embeddedJson.replace(/<\//g, '<\\/')}
</script>` : ''}
</body>
</html>`;
}

// name → allergen keys, from both registries. Declared claims only.
function allergenMap() {
  const map = {};
  for (const d of DISHES) map[d.name] = d.allergens ? Object.keys(d.allergens) : [];
  for (const items of Object.values(ALWAYS_ITEMS)) {
    for (const it of items) map[it.name] = it.allergens ? Object.keys(it.allergens) : [];
  }
  return map;
}

// Pure counting: units, distinct households, first/last date, per canonical
// dish name. House orders excluded (the canon rule: house never touches a
// metric); rejected nothing to exclude — orders handed in are all real.
function salesSummary(orders) {
  const by = {};
  for (const o of orders || []) {
    if (!o || o.house) continue;
    const when = o.createdAt || '';
    const who = o.regularId || o.customer || '?';
    for (const it of o.items || []) {
      if (!it || !it.name || it.omakase) continue;
      const name = canonDishName(it.name, DISH_RENAMES);
      const s = by[name] || (by[name] = { units: 0, households: new Set(), first: null, last: null });
      s.units += Number(it.qty) || 1;
      s.households.add(who);
      if (when) {
        if (!s.first || when < s.first) s.first = when;
        if (!s.last || when > s.last) s.last = when;
      }
    }
  }
  return by;
}

function journalSection(entries, renames) {
  if (!entries.length) return '<p class="meta">Nothing recorded.</p>';
  const rows = entries
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .map(e => {
      const t = JOURNAL_TYPES[e.type] || { label: e.type };
      return `<div class="entry${e.private ? ' private' : ''}">
  <span class="type">${esc(t.label)}</span> <span class="meta">${e.undated ? 'undated' : esc(fmtDate(e.ts))}</span>${e.private ? ' <span class="lock">private</span>' : ''}${e.transferable ? ' <span class="carries">holds beyond this dish</span>' : ''}${e.migrated ? ' <span class="meta">(migrated cook note)</span>' : ''}
  <div>${esc(e.text)}</div>
</div>`;
    });
  return rows.join('\n');
}

// ── K10: the yearly archive ────────────────────────────────────────────────
// { journal, orders, generatedAt? } → one self-contained HTML document.
export function buildArchiveHtml({ journal, orders, generatedAt, copiesNote } = {}) {
  const j = normalizeJournal(journal);
  const when = generatedAt || new Date().toISOString();
  const year = when.slice(0, 4);
  const sales = salesSummary(orders || []);
  const dishEntries = {};
  const general = [];
  for (const e of j.entries) {
    if (e.subject && e.subject.kind === 'dish') {
      const name = canonDishName(e.subject.dish, DISH_RENAMES);
      (dishEntries[name] || (dishEntries[name] = [])).push(e);
    } else general.push(e);
  }

  const knownNames = new Set([...DISHES.map(d => d.name), ...Object.values(ALWAYS_ITEMS).flat().map(i => i.name)]);
  // Dishes that exist only in history now: ordered, no longer served.
  const retiredNames = [...new Set(Object.keys(sales).filter(n => !knownNames.has(n)))].sort();

  const parts = [];
  parts.push(`<h1>Lettuce, Turnip, The Beet — The Record, ${esc(year)}</h1>
<div class="sub">Generated ${esc(fmtDate(when))} · ${DISHES.length} dinners on the register · ${j.entries.length} journal entr${j.entries.length === 1 ? 'y' : 'ies'} · This file is complete in itself: no app, no internet, no software beyond a browser is needed to read it, and it prints clean. The same data rides inside it in machine-readable form.</div>`);

  parts.push('<h2>Start here</h2>');
  for (const para of ARCHIVE_INTRO) parts.push(`<p class="intro">${esc(para)}</p>`);

  if (copiesNote && String(copiesNote).trim()) {
    // Printed INSIDE the artifact on purpose: the person who most needs to
    // know where the other copies are is the one who does not have the app,
    // or Kevin, to ask.
    parts.push('<h2>Where the copies are</h2>');
    parts.push(`<p class="intro">${esc(String(copiesNote).trim())}</p>`);
  }

  parts.push('<h2>The business journal</h2>');
  parts.push(journalSection(general, DISH_RENAMES));

  parts.push('<h2>The dishes</h2>');
  for (const d of DISHES) {
    const s = sales[d.name];
    const entries = dishEntries[d.name] || [];
    const lines = [];
    lines.push(`<div class="dish"><h3>${esc(d.name)}</h3>`);
    lines.push(`<div class="meta">${esc(d.cuisine || '')}${d.variants ? ' · ' + d.variants.map(v => `${esc(v.label)} $${v.price}`).join(' / ') : ''}${s ? ` · ${s.units} sold to ${s.households.size} household${s.households.size === 1 ? '' : 's'}${s.first ? `, ${esc(fmtDate(s.first))} to ${esc(fmtDate(s.last))}` : ''}` : ''}</div>`);
    if (d.copy && d.copy.desc) lines.push(`<p>${esc(d.copy.desc)}</p>`);
    if (d.recipe && Array.isArray(d.recipe.base)) {
      lines.push(`<div class="recipeline"><b>Recipe (base):</b> ${d.recipe.base.map(l => esc(`${l.name}${l.q != null ? ` — ${l.q}${l.u ? ' ' + l.u : ''}` : ''}`)).join('; ')}</div>`);
      if (Array.isArray(d.recipe.extras) && d.recipe.extras.length) {
        lines.push(`<div class="recipeline"><b>Extras:</b> ${d.recipe.extras.map(l => esc(`${l.name}${l.q != null ? ` — ${l.q}${l.u ? ' ' + l.u : ''}` : ''}`)).join('; ')}</div>`);
      }
    }
    if (d.copy && d.copy.reheat) lines.push(`<p><b>Reheat:</b> ${esc(d.copy.reheat)}</p>`);
    if (d.copy && d.copy.contains) lines.push(`<div class="meta"><b>Contains:</b> ${esc(d.copy.contains)}</div>`);
    if (entries.length) lines.push(journalSection(entries, DISH_RENAMES));
    lines.push('</div>');
    parts.push(lines.join('\n'));
  }

  if (retiredNames.length) {
    parts.push('<h2 class="retired">No longer served</h2>');
    for (const name of retiredNames) {
      const s = sales[name];
      const entries = dishEntries[name] || [];
      parts.push(`<div class="dish retired"><h3>${esc(name)}</h3>
<div class="meta">${s ? `${s.units} sold to ${s.households.size} household${s.households.size === 1 ? '' : 's'}${s.first ? `, ${esc(fmtDate(s.first))} to ${esc(fmtDate(s.last))}` : ''}` : ''}</div>
${entries.length ? journalSection(entries, DISH_RENAMES) : '<p class="meta">No retirement record. The reason left with the dish.</p>'}</div>`);
    }
  }

  // ── Principles: the only cross-dish structure in the record ──────────────
  // Derived entirely from the transferable flag — nothing here is authored
  // separately, so it cannot drift from the dossiers it came from. Until the
  // naming pass runs, everything sits under one unnamed heading, which is the
  // honest state: the statements exist, the taxonomy does not yet.
  const principles = principleIndex(j, DISH_RENAMES);
  const flagged = transferableEntries(j, DISH_RENAMES);
  if (flagged.length) {
    parts.push('<h2>Principles — what holds beyond one dish</h2>');
    parts.push(`<div class="meta">${flagged.length} statement${flagged.length === 1 ? '' : 's'} marked as carrying past the dish they were written under. These are the lessons; the dishes above are the exercises. Grouping and naming them is a later pass — this section is generated from the marks themselves and is never edited by hand.</div>`);
    for (const [name, list] of principles) {
      parts.push(`<h3>${esc(name === UNNAMED_PRINCIPLE ? 'Not yet grouped' : name)}</h3>`);
      for (const e of list) {
        parts.push(`<div class="principle">${esc(e.text)}
<div class="src">${esc(JOURNAL_TYPES[e.type] ? JOURNAL_TYPES[e.type].label : e.type)} · ${esc(e.dish || 'general')} · ${e.private ? 'private · ' : ''}${esc(fmtDate(e.ts))}</div></div>`);
      }
    }
  }

  if ((RENAME_HISTORY || []).length) {
    parts.push('<h2>Name changes</h2><table><tr><th>Was</th><th>Became</th><th>When</th><th>Why</th></tr>');
    for (const h of RENAME_HISTORY) {
      parts.push(`<tr><td>${esc(h.from)}</td><td>${esc(h.to)}</td><td>${h.date ? esc(fmtDate(h.date)) : 'unrecorded'}</td><td>${esc(h.reason || '')}</td></tr>`);
    }
    parts.push('</table>');
  }

  // ── The interchange contract ────────────────────────────────────────────
  // This block is not a convenience extra: it is the SEAM the eventual
  // separate teaching app will read, years from now, from a file written
  // today. That makes it an interface, so it is versioned and self-describing
  // rather than incidental. Rules for whoever changes it next:
  //   - BUMP `schema` on any breaking shape change; add fields freely without.
  //   - A reader must be able to open a file written under an older `schema`
  //     and know what it is holding WITHOUT this codebase.
  //   - `fields` documents the shape in the file itself, because the reader in
  //     2036 will not have these comments.
  const embedded = JSON.stringify({
    kind: 'ltb-archive',
    schema: ARCHIVE_SCHEMA,
    fields: ARCHIVE_FIELD_NOTES,
    generatedAt: when,
    journal: j, renameHistory: RENAME_HISTORY || [],
    // Pre-extracted so a future reader (the teaching app) does not have to
    // re-implement the filter to find the lessons.
    transferable: flagged,
  }, null, 1);

  return htmlShell(`LTB Archive ${year}`, when, parts.join('\n'), embedded);
}

// ── M3: records as a byproduct ─────────────────────────────────────────────
// What went out, to whom, when, allergens declared — retrievable as a set
// instead of reconstructed in a panic. House orders ARE included (this is a
// record of what physically left the kitchen, not a metric) and marked.
export function buildRecordsHtml({ orders, generatedAt } = {}) {
  const when = generatedAt || new Date().toISOString();
  const allergens = allergenMap();
  const rows = (orders || [])
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(o => {
      const items = (o.items || []).map(it =>
        `${Number(it.qty) || 1}× ${it.name}${it.variant ? ` (${it.variant})` : ''}`).join('; ');
      const declared = [...new Set((o.items || []).flatMap(it => {
        const canon = canonDishName(it && it.name, DISH_RENAMES);
        return allergens[canon] || [];
      }))].sort().join(', ');
      return `<tr><td>${esc(fmtDate(o.createdAt) || '?')}</td><td>${esc(o.customer || '?')}${o.house ? ' <span class="meta">(house)</span>' : ''}</td><td>${esc(items)}</td><td>${esc(declared || 'none declared')}</td><td>${esc(o.status || '')}${o.archived ? ' · archived' : ''}</td></tr>`;
    });
  const body = `<h1>LTB delivery records</h1>
<div class="sub">Generated ${esc(fmtDate(when))} · ${rows.length} order${rows.length === 1 ? '' : 's'} · what went out, to whom, when, and the allergens declared for it.</div>
<table><tr><th>Date</th><th>Customer</th><th>Items</th><th>Allergens declared</th><th>Status</th></tr>
${rows.join('\n')}
</table>`;
  return htmlShell('LTB delivery records', when, body, null);
}
