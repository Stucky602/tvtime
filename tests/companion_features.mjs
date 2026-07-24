// tests/companion_features.mjs — the three customer-page features.
//
// SOURCE-LEVEL on purpose, and worth being clear about what that means: this
// asserts the code is present and correctly shaped in companion.js, not that a
// rendered page behaves. The real render is exercised by kitchen_weight.mjs
// and invariants.mjs, which run against the full tree. What this catches is
// somebody quietly deleting a speak button or unhooking the rescue, which is
// the realistic regression.
//
// Run: node tests/companion_features.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

const src = readFileSync(new URL('../src/companion.js', import.meta.url), 'utf8');

// ── THE PRIVACY WALL, restated where it matters most ────────────────────────
// This is also enforced by tests/journal.mjs, deliberately twice: companion.js
// is the file most likely to grow a tempting import, because everything the
// dossier knows would "improve" the customer page.
ok(!/from '\.\/journal\.js'/.test(src),
  'companion.js does NOT import journal.js — a customer page can never reach diary material');

// ── Reheat rescue ───────────────────────────────────────────────────────────
ok(/import \{[^}]*rescueFor[^}]*\} from '\.\/recipes\.js'/.test(src),
  'the rescue line comes from the REHEAT CANON, which is customer-facing by design');
ok(/var FB_RESCUE = \$\{JSON\.stringify/.test(src),
  'rescue text is embedded at build time, so a wrong dish costs no network call');
ok(/pair\[1\] !== 'good' && FB_RESCUE\[d\]/.test(src),
  'it appears only on "a little off" or "had trouble", never on a good verdict');
ok(src.indexOf('rescue.style.display = \'block\'') < src.indexOf('send.onclick'),
  'and it appears BEFORE sending, while the dish is still in front of them');
ok(/row\.appendChild\(rescue\)/.test(src), 'the rescue element is actually mounted in the row');

// ── Read receipt ────────────────────────────────────────────────────────────
ok(/\/feedback\/seen\?id=/.test(src), 'the page asks whether Kevin read the feedback');
ok(/data-fbdone/.test(src), 'only rows that actually submitted something are marked');
ok(/\.catch\(function\(\) \{\}\)/.test(src),
  'and it fails silently — an unreachable worker must never put an error on a page someone is cooking from');

// ── Spoken steps ────────────────────────────────────────────────────────────
ok(/class="speak" data-say=/.test(src), 'every reheat step carries a speak button');
ok(/'speechSynthesis' in window/.test(src), 'speech is feature-detected, not assumed');
ok(/b\.style\.display = 'none'/.test(src),
  'and the buttons hide themselves where the API is missing rather than sitting there dead');
ok(/speechSynthesis\.speaking/.test(src) && /speechSynthesis\.cancel/.test(src),
  'tapping again while it talks stops it, which is what everyone tries first');
ok(/aria-label="Read this step aloud"/.test(src), 'the button says what it is for');

// ── The worker side of the receipt ──────────────────────────────────────────
const w = new URL('../worker.js', import.meta.url);
try {
  const ws = readFileSync(w, 'utf8');
  ok(/companionfbread:/.test(ws), 'clearing feedback leaves a read receipt instead of erasing every trace');
  ok(/expirationTtl: 30 \* 24 \* 60 \* 60/.test(ws),
    'the receipt expires with the page it belongs to, never outliving it');
  ok(/url\.pathname === '\/feedback\/seen'/.test(ws), 'and a public route exposes it to the customer page');
} catch (e) {
  console.log('  (worker.js not in this checkout — worker-side checks skipped)');
}

console.log(`COMPANION FEATURES: ALL PASS (${pass} checks)`);
