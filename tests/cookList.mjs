// tests/cookList.mjs — the cooking-list roll-up.
//
// THE BUG: the list keyed on the category STORED ON THE ITEM, and orders from
// the customer form do not carry the same category value manual entries do. So
// one dish appeared as two lines with two counts, and Kevin added them by hand
// every week. Category is now DERIVED from the menu by name, and the key is
// name + variant only, which makes a split count structurally impossible.
//
// Run: node tests/cookList.mjs

import assert from 'node:assert';
import { buildCookList, categoryIndex, UNCATEGORIZED } from '../src/cookList.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

const MENU = {
  dinners: [{ name: 'Gumbo' }, { name: 'Bolognese' }],
  bag: [{ name: 'NY Strip' }],
  desserts: [{ name: 'Brownies' }],
};
const ORDER = ['dinners', 'bag', 'desserts'];

// ── THE FIX ─────────────────────────────────────────────────────────────────
// Same dish, same variant, one order from the form (no category on the item)
// and one entered by hand (category present). Previously: two lines.
const mixed = [
  { id: 'form', items: [{ name: 'Gumbo', variant: 'Small (~4)', qty: 2 }] },
  { id: 'manual', items: [{ name: 'Gumbo', variant: 'Small (~4)', qty: 3, category: 'dinners' }] },
];
let list = buildCookList(mixed, MENU, ORDER);
ok(list.length === 1, 'a form order and a manual entry for the same dish collapse into ONE line');
ok(list[0].qty === 5, 'and the counts add up (2 + 3), instead of sitting on two lines to add by hand');
ok(list[0].category === 'dinners', 'the category is DERIVED from the menu, so the form order is bucketed too');

// A stored category that disagrees with the menu never wins.
const lying = [{ items: [{ name: 'Gumbo', variant: 'Small (~4)', qty: 1, category: 'desserts' }] }];
ok(buildCookList(lying, MENU, ORDER)[0].category === 'dinners',
  'a stale or wrong stored category cannot move a dish out of its real bucket');

// ── Variants stay separate, because they are different work ─────────────────
const variants = [{ items: [
  { name: 'Gumbo', variant: 'Small (~4)', qty: 1 },
  { name: 'Gumbo', variant: 'Large (~8)', qty: 2 },
] }];
ok(buildCookList(variants, MENU, ORDER).length === 2, 'different variants of one dish stay on separate lines');

// A missing variant is not a different variant from an empty one.
const blank = [
  { items: [{ name: 'Brownies', qty: 1 }] },
  { items: [{ name: 'Brownies', variant: '', qty: 2 }] },
];
ok(buildCookList(blank, MENU, ORDER)[0].qty === 3, 'a missing variant and an empty variant are the same line');

// ── Bucketing and order ─────────────────────────────────────────────────────
const all = [{ items: [
  { name: 'Brownies', qty: 1 },
  { name: 'NY Strip', qty: 1 },
  { name: 'Gumbo', qty: 1 },
] }];
const sorted = buildCookList(all, MENU, ORDER);
ok(sorted.map(r => r.category).join() === 'dinners,bag,desserts', 'lines sort by the menu category order');

// ── Things the menu does not know ───────────────────────────────────────────
const offMenu = [{ items: [
  { name: 'Some One-Off', qty: 1, category: 'dinners' },
  { name: 'Totally Unknown', qty: 1 },
] }];
const off = buildCookList(offMenu, MENU, ORDER);
ok(off.find(r => r.name === 'Some One-Off').category === 'dinners',
  "an off-menu item keeps the category it was entered with — that is the only information there is");
ok(off.find(r => r.name === 'Totally Unknown').category === UNCATEGORIZED,
  'and one with nothing at all lands in a bucket of last resort rather than vanishing');
ok(buildCookList(offMenu, MENU, ORDER).every(r => r.qty >= 1), 'nothing is dropped');

// ── Tolerance ───────────────────────────────────────────────────────────────
ok(buildCookList(null, MENU, ORDER).length === 0, 'no orders means no list, not a throw');
ok(buildCookList([{ items: null }], MENU, ORDER).length === 0, 'an order with no items is skipped');
ok(buildCookList([{ items: [{ qty: 2 }] }], MENU, ORDER).length === 0, 'a nameless item is skipped');
ok(buildCookList([{ items: [{ name: 'Gumbo' }] }], MENU, ORDER)[0].qty === 1, 'a missing qty counts as one');
ok(categoryIndex(null).size === 0, 'a missing menu indexes to nothing');

console.log(`COOK LIST: ALL PASS (${pass} checks)`);
