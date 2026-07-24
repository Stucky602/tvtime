// Recipe aggregation (shopping list) and per-order reheat blocks.
// ═══════════════════════════════════════════════════════════════════════════
// Per-dish DATA (recipes, reheat buckets, rice/pasta/noodle membership, stew
// veg copy) lives in the dish registry (src/dishes.js) and is DERIVED here.
// This module keeps the same public exports as before (RECIPES, RICE_DISHES,
// DINNER_REHEAT_BUCKET, buildReheatBlocks, ...) so nothing downstream changes.
// The LOGIC (shopping aggregation, reheat card assembly with all its per-dish
// special cases) still lives here. To add/edit a dish: edit dishes.js.
// ═══════════════════════════════════════════════════════════════════════════
import { ALL_DINNERS, ALWAYS_MENU, PER_LB_ITEMS, isPerLbItem } from './menu.js';
import { DISHES, ALL_ALWAYS_ITEMS, I } from './dishes.js';
import { expandOmakaseForShopping } from './omakase.js';

// Recipe-line helper — now defined in dishes.js; re-exported for compatibility.
export { I };

// RECIPES — per-batch ingredients for shopping list generation, keyed by dish
// name. "staple: true" = pantry items Kevin keeps stocked (skipped unless
// toggled on). "factors" maps each menu variant to a batch multiplier of the
// base recipe. "extras" adds variant-specific ingredients (scaled by the same
// factor). Assembled from the registry: dinners first, then always-menu items.
export const RECIPES = {};
DISHES.forEach(d => { if (d.recipe) RECIPES[d.name] = d.recipe; });
ALL_ALWAYS_ITEMS.forEach(it => { if (it.recipe) RECIPES[it.name] = it.recipe; });

// Pantry staples Kevin always keeps stocked: they never belong on a shopping
// list even when a recipe line forgot the staple flag. Centralized here (by
// recipe-line NAME) so the rule holds for every dish, present and future, and
// one edit adds a new staple everywhere. Kevin's rule (Jul 20): ALL spices, the
// black tea, raw rice, sugars, salt, the queso mason jar, and dried orange peel.
export const ALWAYS_STAPLE = new Set([
  'Kosher salt', 'Salt', 'Sugar', 'Brown sugar',
  'Cinnamon stick', 'Star anise', 'Sichuan peppercorns', 'Black pepper (oz)',
  'Loose black tea', 'Raw rice (smoke mix)', 'Dried orange peel',
  'Pint mason jar',
]);

// Normalize an ingredient name so near-duplicates merge:
// lowercase, strip trailing parenthetical notes, singularize simple plurals,
// collapse whitespace, and map a few known synonyms.
export const INGREDIENT_SYNONYMS = {
  'scallion': 'green onion',
  'scallions': 'green onion',
  // Spring onion is DISTINCT from scallion/green onion (Kevin, Jul 14). It IS
  // the same thing as the bulb onion he stocks, so route it there — never to
  // green onion. Whole-string match (fires after word-level processing).
  'spring onion': 'bulb onion',
  // 'coriander' -> 'cilantro' REMOVED (Kevin, Jul 14): in his usage coriander
  // ALWAYS means the seed, cilantro always means the leaves. The old word-level
  // rule also mangled "coriander seed" into "cilantro seed", which matched
  // nothing and missed the real coriander_seed ingredient.
  'chili': 'chile',
  'chilli': 'chile',
  'courgette': 'zucchini',
  'courgettes': 'zucchini',
  // Whole-string safety nets for pre-Jul-13 ingredient names typed or pasted
  // by hand. Keys are the POST-processed (lowercased, singularized) forms.
  'kitchen basic chicken stock': 'chicken stock',
  'canned peeled tomatoe': 'canned tomatoe',
  'whole milk': 'milk',
};
export function normalizeIngredientName(name) {
  let n = String(name).toLowerCase().trim();
  n = n.replace(/\s*\(.*?\)\s*/g, ' ').trim(); // drop parentheticals
  n = n.replace(/\s+/g, ' ');
  // word-level synonym + naive singularization
  n = n.split(' ').map(w => {
    if (INGREDIENT_SYNONYMS[w]) return INGREDIENT_SYNONYMS[w];
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }).join(' ');
  return INGREDIENT_SYNONYMS[n] || n;
}

// Aggregate ingredients across all active orders into shopping list lines.
// Shares the unit machinery with mergeShoppingRows (resolveCanUnit,
// classifyUnit, foldNormGroups, renderQty — defined below) so BOTH paths
// consolidate identically: can sizes resolve to oz, bare oz folds into the
// ingredient's existing family, volume renders in oz, butter folds to sticks.
export function generateShoppingItems(activeOrders, includeStaples) {
  const groups = new Map(); // norm|family -> group
  const byNorm = new Map(); // norm -> [groups] for the post-aggregation fold
  const unknown = [];
  let ord = 0;

  const addIng = (name, qty, unit, staple, factor) => {
    const norm = normalizeIngredientName(name);
    // Singularize the unit so '2 knobs' and '1 knob' use the same bucket,
    // then resolve can sizes ("14oz can" -> oz) and classify the family.
    const su = singularizeUnit(String(unit || '').toLowerCase());
    const rc = resolveCanUnit(qty * factor, su);
    const fam = classifyUnit(rc.unit);
    const key = `${norm}|${fam}`;
    let g = groups.get(key);
    if (!g) {
      g = { norm, name, vol: null, wt: null, amb: null, plain: 0, unit: rc.unit, checked: true, staple: !!staple, ord: ord++, dead: false };
      groups.set(key, g);
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(g);
    }
    if (fam === 'vol') g.vol = (g.vol || 0) + rc.qty * VOL_TO_CUP[rc.unit];
    else if (fam === 'wt') g.wt = (g.wt || 0) + rc.qty * WT_TO_LB[rc.unit];
    else if (fam === 'amb') g.amb = (g.amb || 0) + rc.qty;
    else g.plain += rc.qty;
    g.staple = g.staple && !!staple;
  };

  activeOrders.forEach(o => {
    (o.items || []).forEach(it => {
      // Sous vide proteins priced by weight: use the actual requested weight
      if (isPerLbItem(it.name)) {
        const lbs = (typeof it.weight === 'number' && it.weight > 0 ? it.weight : 1) * it.qty;
        addIng(it.name, lbs, 'lb', false, 1);
        if (includeStaples) addIng('Sous vide bag + seasonings', 1, '', true, it.qty);
        return;
      }
      const recipe = RECIPES[it.name];
      if (!recipe) {
        unknown.push(`${it.qty}x ${it.name} (${it.variant}) — no recipe data, plan manually`);
        return;
      }
      const factor = (recipe.factors?.[it.variant] ?? 1) * it.qty;
      const ings = [...(recipe.base || []), ...((recipe.extras || {})[it.variant] || [])];
      ings.forEach(ing => {
        const staple = ing.staple || ALWAYS_STAPLE.has(ing.name);
        if (staple && !includeStaples) return;
        // fixed extras (e.g. Asian Greens) are always 1 lb per order regardless of batch size
        addIng(ing.name, ing.q, ing.u, staple, ing.fixed ? it.qty : factor);
      });
    });
  });

  for (const [norm, list] of byNorm) foldNormGroups(norm, list);

  const lines = Array.from(groups.values())
    .filter(g => !g.dead)
    .sort((a, b) => (a.staple === b.staple ? a.name.localeCompare(b.name) : a.staple ? 1 : -1))
    .map(g => {
      const qty = pluralizeQty(renderQty(g.vol, g.wt, g.amb, g.plain, g.unit));
      return `${g.name} — ${qty}${g.staple ? ' (staple)' : ''}`;
    });

  return [...lines, ...unknown];
}

// ═══════════════════════════════════════════════════════════════════════════
// REHEAT INSTRUCTIONS — groups a customer's reheatable items into shared
// method buckets and renders copy/paste-ready instructions (one image per
// order, mirroring the invoice share flow).
//
// Each dinner maps to a bucket id. Items in the same bucket are listed
// together under one shared instruction block. Sous vide proteins, sous vide
// vegetables, and queso are handled by their own dedicated buckets.
// Non-reheatable items (fruit, desserts, syrups, sauces, pickles, etc.) are
// simply omitted.
// ═══════════════════════════════════════════════════════════════════════════

// Sous vide vegetable names (from ALWAYS_MENU.bag, the non-perLb entries).
export const SOUS_VIDE_VEG = ['Carrots', 'Baby Gold Potatoes', 'Corn (off the cob)', 'Kabocha Squash', 'Parsnips', 'Asparagus'];

// ── All the per-dish reheat/starch identity data below is DERIVED from the
// dish registry (dishes.js). Rename or add a dish there; these follow. ──────

// Dinner → reheat bucket id ('bagged' | 'stovetop' | 'pasta' | 'kit').
export const DINNER_REHEAT_BUCKET = {};
DISHES.forEach(d => { if (d.reheat) DINNER_REHEAT_BUCKET[d.name] = d.reheat; });

// Dishes that include uncooked rice with the order.
export const RICE_DISHES = new Set(DISHES.filter(d => d.rice).map(d => d.name));
// Dishes that include uncooked pasta/noodles.
export const PASTA_DISHES = new Set(DISHES.filter(d => d.pasta).map(d => d.name));
export const NOODLE_DISHES = new Set(DISHES.filter(d => d.noodle).map(d => d.name));
// Bagged dishes whose reheat ends with "mix with cooked pasta" instead of "plate"
export const BAGGED_PASTA_DISHES = new Set(DISHES.filter(d => d.baggedPasta).map(d => d.name));

// Stovetop dishes with a separate sous vide veg bag get fully dedicated cards
// (main + veg bag), never the shared generic stovetop block — each one's title
// is its own dish name, never combined with another dish on the same card.
export const STEW_VEG_COPY = {};
DISHES.forEach(d => { if (d.stewVegCopy) STEW_VEG_COPY[d.name] = d.stewVegCopy; });

// Per-veg reheat copy for the sous vide vegetables. Each ordered veg with an
// entry here gets its OWN titled card (like the stew veg / split ragu cards),
// because these veg genuinely finish differently — asparagus overcooks and
// drains, corn soaks everything up, kabocha wants a butter drizzle. Any veg
// NOT listed here falls back to the shared generic veg card below, so the
// glaze-optional veg (Carrots, Baby Gold, Parsnips) are unaffected.
export const VEG_REHEAT_COPY = {
  'Asparagus': 'Place the sealed bag in simmering water, but go easy here. Asparagus overcooks fast, so a minute at a simmer is really all it needs. Cut open and drain off the excess liquid, then plate. The liquid contains butter, so avoid pouring it down the drain.',
  'Corn (off the cob)': 'Place the sealed bag in simmering water for a few minutes to reheat. Cut open, pick out the thyme sprigs, and plate as-is. The corn soaks up all the seasoning, so there\'s nothing to drain.',
  'Kabocha Squash': 'Place the sealed bag in simmering water for a few minutes to reheat. Cut open and plate as-is; the squash soaks up all the seasoning, so there\'s nothing to drain. A drizzle of melted butter over the top right before serving takes it up a notch.',
};

// Build the grouped reheat blocks for an order. Returns an array of
// { title, dishes: [names], body: '...' } ready to render.
export function buildReheatBlocks(order) {
  const items = (order.items || []);
  const blocks = [];

  // Collect dish names by bucket (dedup, preserve first-seen order)
  const byBucket = { bagged: [], stovetop: [], pasta: [], kit: [] };
  const proteins = [];
  const veg = [];
  let hasQueso = false;
  let hasBoSsam = false;

  const seen = new Set();

  // Saffron Pork Ragu's starch is variant-dependent (Polenta REPLACES pasta,
  // never both), so this has to be resolved by scanning every line item for
  // this dish up front — the dedup loop below only looks at the first
  // occurrence of each dish name, which would silently miss a second Ragu
  // line item with a different variant (e.g. one Small plain + one Large +
  // Polenta in the same order).
  let hasPolenta = false;
  let raguNeedsPasta = false;
  items.forEach(it => {
    if (it.name !== 'Saffron Pork Ragu') return;
    if (it.variant && it.variant.includes('Polenta')) hasPolenta = true;
    else raguNeedsPasta = true;
  });

  // Mushroom Ragu — same variant-dependent starch as Saffron Ragu (Polenta
  // REPLACES the egg pappardelle), but it gets its own dedicated cards with
  // its own wording rather than the shared generic pasta text. Up-front scan
  // so a mixed pasta + polenta order keeps both cards.
  let mushroomRaguPasta = false;
  let mushroomRaguPolenta = false;
  items.forEach(it => {
    if (it.name !== 'Mushroom Ragu') return;
    if (it.variant && it.variant.includes('Polenta')) mushroomRaguPolenta = true;
    else mushroomRaguPasta = true;
  });

  // Pork with Mustard Tarragon Cream Sauce — dedicated 3-part card (sear the
  // sous vide pork, warm the sauce, cook the taglierini fresh).
  let porkMustardOrdered = items.some(it => it.name === 'Pork with Mustard Tarragon Cream Sauce');

  // Orecchiette with Bitter Greens and Anchovies — dedicated card (warm the
  // sauce, cook the orecchiette fresh; no pasta substitution).
  let orecchietteOrdered = items.some(it => it.name === 'Orecchiette with Bitter Greens and Anchovies');

  // Coriander Lamb Steak over Gigantes Beans (Spotlight) — dedicated two-part card: sear the lamb
  // (remove bone, pat dry, hard sear, no rest — thin cut), warm the bean/leek
  // bag in simmering water, slice the lamb over the top.
  let lambSpotlightOrdered = items.some(it => it.name === 'Coriander Lamb Steak over Gigantes Beans');

  // Thick-Cut Pork Chop (Spotlight) — dedicated four-part card: sear the thick
  // pork (30+ min counter-warm), warm the purée + broccolini bags, gentle
  // reheat on the stabilized "beurre blanc," plate it all.
  let porkChopSpotlightOrdered = items.some(it => it.name === 'Bone-In Pork Rib Chop with All the Fixings');

  // Pork Chop with Kabocha Puree and Charred Broccolini — the non-spotlight
  // tier. Three parts, not four: no sauce, so the butter suggestion at the end
  // does that job for anyone who has butter in the house.
  let porkChopBaseOrdered = items.some(it => it.name === 'Pork Chop with Kabocha Purée and Charred Broccolini');
  const teaSmokedOrdered = items.some(it => it.name === 'Tea-Smoked Chicken with Dashi Polenta and Alabama White Sauce');

  // Steak au Poivre (Spotlight) — dedicated four-part card: sear the thick
  // filet (30 min counter-warm, 131°F no exceptions), warm the pommes purée +
  // asparagus bags, gentle reheat on the stabilized peppercorn-cognac sauce.
  let steakAuPoivreOrdered = items.some(it => it.name === 'Steak au Poivre');

  // Cumin Mushroom Noodles / Cumin Beef or Lamb on Rice: the Beef/Lamb
  // noodles for rice, so they need their own rice-cooking instructions
  // instead of being lumped into the shared noodle/pasta bucket text. Same
  // up-front full-item scan as Ragu above, so a mixed order (one noodle
  // variant + one beef variant) keeps both cards.
  const CUMIN_DUAL = 'Cumin Mushroom Noodles / Cumin Beef or Lamb on Rice';
  let cuminNoodleOrdered = false;
  let cuminMeatOnRiceOrdered = false;
  items.forEach(it => {
    if (it.name !== CUMIN_DUAL) return;
    if (it.variant && /^(beef|lamb),/i.test(it.variant)) cuminMeatOnRiceOrdered = true;
    else cuminNoodleOrdered = true;
  });

  items.forEach(it => {
    const name = it.name;
    if (seen.has(name)) return;
    if (isPerLbItem(name)) { proteins.push(name); seen.add(name); return; }
    if (SOUS_VIDE_VEG.includes(name)) { veg.push(name); seen.add(name); return; }
    if (name === 'Queso') { hasQueso = true; seen.add(name); return; }
    if (name === 'Bo Ssam') { hasBoSsam = true; seen.add(name); return; }
    if (name === 'Saffron Pork Ragu') {
      // Only goes in the shared pasta card if at least one ordered batch
      // actually includes pasta; a Polenta-only order gets no pasta card at
      // all for this dish (it never had pasta to cook).
      seen.add(name);
      if (raguNeedsPasta) byBucket.pasta.push(name);
      return;
    }
    if (name === CUMIN_DUAL) {
      // Same idea: only goes in the shared noodle/pasta card when a noodle
      // variant was actually ordered. The Beef variant gets its own card
      // (added near Bo Ssam's dedicated block below).
      seen.add(name);
      if (cuminNoodleOrdered) byBucket.pasta.push(name);
      return;
    }
    if (name === 'Mushroom Ragu') {
      // Dedicated cards (below), never the shared generic pasta text.
      seen.add(name);
      return;
    }
    if (name === 'Pork with Mustard Tarragon Cream Sauce') {
      // Dedicated 3-part card (below), never the shared generic pasta text.
      seen.add(name);
      return;
    }
    if (name === 'Orecchiette with Bitter Greens and Anchovies') {
      // Dedicated card (below), never the shared generic pasta text.
      seen.add(name);
      return;
    }
    const b = DINNER_REHEAT_BUCKET[name];
    if (b && byBucket[b]) { byBucket[b].push(name); seen.add(name); }
  });

  // Helper: does a list of dish names include any rice dish? any pasta? noodle?
  const listHasRice = (names) => names.some(n => RICE_DISHES.has(n));
  const listHasPasta = (names) => names.some(n => PASTA_DISHES.has(n));
  const listHasNoodle = (names) => names.some(n => NOODLE_DISHES.has(n));

  // ── Bagged dishes ──────────────────────────────────────────────────────
  if (byBucket.bagged.length) {
    const regularBagged = byBucket.bagged.filter(n => !BAGGED_PASTA_DISHES.has(n));
    const baggedPasta = byBucket.bagged.filter(n => BAGGED_PASTA_DISHES.has(n));

    if (regularBagged.length) {
      let body = 'Bring a pot of water to a gentle simmer and place the sealed bag in until heated through, then cut open and plate. Microwave or stovetop work too if you prefer. See the main menu for additional details.';
      if (listHasRice(regularBagged)) body += ' Cook the included rice fresh.';
      blocks.push({ title: 'Reheat in the bag', dishes: regularBagged, body });
    }

    if (baggedPasta.length) {
      blocks.push({
        title: 'Reheat in the bag (pasta)',
        dishes: baggedPasta,
        body: 'Bring a pot of water to a gentle simmer and place the sealed bag in until heated through, then cut open and mix with cooked pasta.',
      });
    }
  }

  // ── Stovetop in a container ────────────────────────────────────────────
  // Boeuf and Leblanc get their own dedicated cards (never the shared generic
  // text), so the rest of the stovetop dishes use the shared block below.
  const genericStovetop = byBucket.stovetop.filter(n => !STEW_VEG_COPY[n]);
  if (genericStovetop.length) {
    let body = 'Comes in a container. Warm gently on the stove over medium-low until heated through. If it looks a little thick, add a splash of water to loosen it.';
    if (listHasRice(genericStovetop)) body += ' Cook the included rice fresh.';
    blocks.push({ title: 'Reheat on the stovetop', dishes: genericStovetop, body });
  }

  // Stew/curry dishes with a separate sous vide veg bag — one card per dish
  // (never combined with another dish), with the main reheat and the veg-bag
  // instructions as two paragraphs within that single card.
  byBucket.stovetop.filter(n => STEW_VEG_COPY[n]).forEach(name => {
    const copy = STEW_VEG_COPY[name];
    let mainBody = copy.main;
    if (RICE_DISHES.has(name)) mainBody += ' Cook the included rice fresh.';
    blocks.push({ title: name, dishes: [name], body: [mainBody, copy.veg] });
  });

  // ── Pasta / noodle dishes ──────────────────────────────────────────────
  if (byBucket.pasta.length) {
    const hasP = listHasPasta(byBucket.pasta);
    const hasN = listHasNoodle(byBucket.pasta);
    const carb = hasP && hasN ? 'pasta/noodles' : hasN ? 'noodles' : 'pasta';
    let body = `Cook the included ${carb} fresh. Warm the sauce gently on the stove, adding a splash of pasta water to loosen if needed, then toss together.`;
    blocks.push({ title: 'Cook fresh, warm the sauce', dishes: byBucket.pasta, body });
  }

  // ── Polenta bag (Saffron Pork Ragu polenta variants) ──────────────────
  if (hasPolenta) {
    blocks.push({
      title: 'Reheat the polenta bag',
      dishes: ['Saffron Pork Ragu'],
      body: 'Bring a pot of water to a gentle simmer and place the sealed polenta bag in until heated through, then cut open and plate alongside the ragu.',
    });
  }

  // ── Mushroom Ragu — dedicated cards, split by variant ─────────────────
  if (mushroomRaguPasta) {
    blocks.push({
      title: 'Reheat the sauce, cook the pasta',
      dishes: ['Mushroom Ragu'],
      body: 'Comes in a container, ready to go. Empty the sauce into a saucepan and warm it over medium-low, stirring now and then, while you boil your pasta in lightly salted water. Once the pasta is cooked and drained, toss it with the sauce and a splash of the pasta water to loosen it, then finish with a little parm if you have it.',
    });
  }
  if (mushroomRaguPolenta) {
    blocks.push({
      title: 'Reheat the sauce and polenta',
      dishes: ['Mushroom Ragu'],
      body: 'Comes in a container with the polenta sealed in a separate sous vide bag. Warm the sauce in a saucepan over medium-low, stirring now and then. Reheat the polenta bag in simmering water for a few minutes until hot, then cut it open, spoon it out, and top with the sauce and a little parm if you have it.',
    });
  }

  // ── Orecchiette with Bitter Greens and Anchovies — dedicated card ─────
  if (orecchietteOrdered) {
    blocks.push({
      title: 'Warm the sauce and cook the pasta',
      dishes: ['Orecchiette with Bitter Greens and Anchovies'],
      body: 'Warm the sauce gently in a pan, adding a few ounces of the pasta water if it needs loosening. Cook the orecchiette in lightly salted water, then drain and toss it straight into the sauce.',
    });
  }

  // ── Coriander Lamb Steak over Gigantes Beans (Spotlight) — dedicated two-part card ──────────────
  if (lambSpotlightOrdered) {
    blocks.push({
      title: 'Sear the lamb, warm the beans',
      dishes: ['Coriander Lamb Steak over Gigantes Beans'],
      body: 'Two parts: the lamb in a sealed bag, and the gigantes beans and leeks together in their own bag. Start with the lamb. Pull it out and remove the bone first so it sears clean, then pat it very dry. Sear hard in a blazing-hot pan with a little oil, just until deeply browned on each side. This is a thinner cut, so do not let it come to room temperature first, take it straight from cold to the hot pan. While it sears, warm the beans and leeks: drop the sealed bag into a pot of simmering water for a few minutes until hot, then spoon them onto the plate. Slice the lamb thin and lay it over the top.',
    });
  }

  // ── Steak au Poivre (Spotlight) — dedicated four-part card ───────────
  if (steakAuPoivreOrdered) {
    blocks.push({
      title: 'Sear the steak, warm everything else',
      dishes: ['Steak au Poivre'],
      body: 'Four parts: the filet in a sealed bag, the pommes puree in a bag, the asparagus in a bag, and the peppercorn-cognac "beurre blanc" in a container. Start with the steak. This is a thick cut, so let it sit out on the counter for 30 minutes before searing, then pat it very dry and sear hard on each side in a blazing-hot pan until deeply browned, and rest it a few minutes before serving. It is cooked to 131F, a perfect medium rare. While it rests, reheat the puree bag in a pot of simmering water for a few minutes. The asparagus goes in the simmering water too, but go easy, it overcooks fast, so a minute is plenty. Warm the sauce gently in a small saucepan over low heat. It is stabilized to hold up to a home reheat, so you have some room, just do not rush it over high heat. To plate: spoon the puree down, lay the filet over it, the asparagus alongside, and pour the sauce over the steak.',
    });
  }

  // ── Thick-Cut Pork Chop (Spotlight) — dedicated four-part card ────────
  if (porkChopSpotlightOrdered) {
    blocks.push({
      title: 'Sear the pork, warm everything else',
      dishes: ['Bone-In Pork Rib Chop with All the Fixings'],
      body: 'Four parts: the pork in a sealed bag, the kabocha puree in a bag, the broccolini in a container, and the spiced cider beurre blanc in a container. Start the pork first since it needs a head start. This is a very thick cut, so let it sit out on the counter for 30 minutes or more before searing, then pat it very dry and sear hard on each side in a blazing-hot pan until deeply browned. Pull the pork and let it rest, then drop the broccolini into that same hot pan with the pork fat and toss it a minute or two, just until it is heated through and picks up a little extra char. Meanwhile reheat the puree bag in a pot of simmering water until hot. Warm the sauce gently in a small saucepan over low heat. It is a beurre blanc, so in theory it can break, but this one is stabilized to hold up to a home reheat, so you have some room. Just do not rush it over high heat. To plate: spread the puree down first, lay the pork chop on one side, the broccolini on the other, then drizzle the sauce over all of it.',
    });
  }

  // ── Pork Chop with Kabocha Puree and Charred Broccolini — 3-part card ──
  if (porkChopBaseOrdered) {
    blocks.push({
      title: 'Sear the pork, warm the sides',
      dishes: ['Pork Chop with Kabocha Purée and Charred Broccolini'],
      body: 'Three parts: the pork in a sealed bag, the kabocha puree in a bag, and the broccolini in a container. There are two thick chops here, meant to be sliced and split among four people. Let the pork sit out on the counter for 30 minutes or more before searing since these are very thick cuts, then pat dry and sear hard on each side in a blazing-hot pan until deeply browned. Pull the pork and let it rest, then drop the broccolini into that same hot pan with the pork fat and toss it a minute or two, just until it is heated through and picks up a little extra char. Meanwhile reheat the puree bag in a pot of simmering water until hot. To plate: spread the puree down first, slice the chops against the grain and lay them over the top, broccolini alongside. If you have butter in the house, melt a little over the pork and broccolini right before it goes to the table. Not required, but it is doing the job the spotlight version\'s sauce does, and it takes ten seconds.',
    });
  }

  // ── Tea-Smoked Chicken — dedicated 3-part card ────────────────────────
  // Its own bucket, not 'bagged': the chicken ships in a CONTAINER, not a bag,
  // because Kevin pulls it out of the sous vide bag for the smoke step and is
  // not going to re-bag it just to save a container. The polenta IS bagged.
  // The white sauce must never be heated — cold against the smoke is the dish.
  if (teaSmokedOrdered) {
    blocks.push({
      title: 'Sear the chicken, warm the polenta, add the sauce',
      dishes: ['Tea-Smoked Chicken with Dashi Polenta and Alabama White Sauce'],
      body: 'Two parts: the chicken in a container, the polenta in a sealed bag. Polenta bag into simmering water until hot. The chicken is fully cooked and already smoked, so all it needs is color: pat it very dry, get a pan blazing hot with a neutral oil, and sear hard just until browned. Same treatment as any sous vide protein. Polenta down, chicken over, then the white sauce poured cold across the top. Do not heat the white sauce, it is meant to be cold against the smoke. If you asked for skin-on, do not go blazing hot. Pat it very dry, lay it skin-side down in a moderate pan with a little oil, and let the fat render and the skin tighten before you bring the heat up. Rushing it is how the skin welds itself to the pan.',
    });
  }

  // ── Pork with Mustard Tarragon Cream Sauce — dedicated 3-part card ─────
  if (porkMustardOrdered) {
    blocks.push({
      title: 'Sear the pork, warm the sauce, cook the pasta',
      dishes: ['Pork with Mustard Tarragon Cream Sauce'],
      body: 'Three parts: the pork in a sealed bag, the sauce in a container, and the taglierini to cook fresh. For the pork, pat it very dry, then sear hard on each side in a blazing-hot pan just until deeply browned on each side. Cut it into half-inch to one-inch medallions after searing. Warm the sauce in a saucepan over medium-low, stirring now and then, while you boil your pasta in lightly salted water. Once the pasta is cooked and drained, toss it with the sauce, then plate with the pork on top.',
    });
  }

  // ── Tex-Mex Kit ────────────────────────────────────────────────────────
  if (byBucket.kit.length) {
    blocks.push({
      title: 'Assemble at home',
      dishes: byBucket.kit,
      body: 'Components travel separately with assembly notes. Warm the protein gently before building. The beans travel in a separate bag — warm them on the stovetop or in the microwave.',
    });
  }

  // ── Bo Ssam (pork pre-pulled and bagged; sauce + kimchi are cold, ready) ──
  if (hasBoSsam) {
    blocks.push({
      title: 'Bo Ssam',
      dishes: ['Bo Ssam'],
      body: 'The pork comes pre-pulled and sealed in a bag — bring a pot of water to a gentle simmer and place the sealed bag in until heated through. The ginger scallion sauce and kimchi are ready straight from the fridge, no reheating needed. Cook the rice fresh.',
    });
  }

  // ── Cumin Beef/Lamb on Rice (same sauce as the noodle version, rice instead) ──
  if (cuminMeatOnRiceOrdered) {
    blocks.push({
      title: CUMIN_DUAL,
      dishes: [CUMIN_DUAL],
      body: 'Warm the meat and sauce gently on the stove, adding a splash of water to loosen if needed. Cook the included rice fresh and serve the meat over the top.',
    });
  }

  // ── Sous vide proteins (unified sear block) ────────────────────────────
  if (proteins.length) {
    blocks.push({
      title: 'Sear the proteins',
      dishes: proteins,
      body: 'Already cooked through, they just need a sear. Pat dry, then sear in a hot pan with a little oil until a nice crust forms on each side. Rest a few minutes before slicing.',
    });
  }

  // ── Sous vide vegetables ───────────────────────────────────────────────
  // Veg with their own copy (asparagus/corn/kabocha finish differently) get a
  // dedicated titled card each; the rest share the generic two-option card.
  if (veg.length) {
    const specialVeg = veg.filter(n => VEG_REHEAT_COPY[n]);
    const genericVeg = veg.filter(n => !VEG_REHEAT_COPY[n]);
    specialVeg.forEach(name => {
      blocks.push({ title: name, dishes: [name], body: VEG_REHEAT_COPY[name] });
    });
    if (genericVeg.length) {
      blocks.push({
        title: 'Reheat the vegetables',
        dishes: genericVeg,
        body: 'Bring a pot of water to a gentle simmer and place the sealed bag in until heated through. Plate as-is, or, if you have a few extra minutes, strain the liquid from the bag into a pan and reduce it down into a glaze to spoon over the top.',
      });
    }
  }

  // ── Queso (verbatim) ───────────────────────────────────────────────────
  if (hasQueso) {
    blocks.push({
      title: 'Reheat the queso',
      dishes: ['Queso'],
      body: 'Remove the lid and microwave at 50% power for 5 minutes. This should loosen it enough to transfer to a sauce pot, then heat on low until it reaches the temperature you want. You can keep microwaving at 50% power instead, but the stovetop finish is the better way to go.',
    });
  }

  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL ITEM HANDLING — the single source every surface (labels, cards,
// future menu copy) consults for "how does this item reheat and package."
// Wording drift across surfaces was a recurring bug (labels said one thing,
// order cards another; cantaloupe got a reheat cue). Fix: derive everything
// from registry data through ONE function, with ONE canonical phrase per
// concept. Never write reheat wording anywhere else — reference these.
// ═══════════════════════════════════════════════════════════════════════════

// The canonical short cues (label-length). The long-form order-card bodies in
// buildReheatBlocks are composed views of the SAME concepts; if a cue concept
// changes, change it here and the label + any consumer changes with it.
export const REHEAT_CUES = {
  simmerBag: 'Reheat sealed bag in simmering water',
  simmerBagGentle: 'Reheat sealed bag in simmering water, briefly. Overcooks fast',
  searProtein: 'Pat very dry, sear hard in a blazing-hot pan',
  stovetop: 'Warm gently on the stovetop',
  stovetopSplash: 'Warm gently on the stove, splash of water if thick',
  cookFreshPasta: 'Cook pasta fresh, warm the sauce gently',
  cookFreshNoodle: 'Cook noodles fresh, toss with warmed sauce',
  keepFrozen: 'KEEP FROZEN until use. Thaw in fridge, use within 3 days',
  toaster: 'Toast from frozen',
  fridge: 'Keep refrigerated',
};

// Per-lb protein set (sear cues) — derived from menu data at call time via
// the injected isPerLb, so this module stays free of menu.js imports.
const SEAR_BUCKETS = new Set(['sear']);

// itemHandling(name, { category, isPerLb }) →
//   { reheatable, cue, packaging }
//   packaging: 'per-qty'  → one container per unit of qty (dinners, SV veg, sauces)
//              'per-bag'  → weighed per-lb items: one label per BAG (2 pieces/bag)
//              'single'   → ONE package regardless of qty (cookies, fruit, syrups)
// Category comes from the caller (labels knows it via ALWAYS_ITEMS/ALL_DINNERS);
// unknown items default to a safe no-cue single package.
export function itemHandling(name, opts = {}) {
  const { category = null, isPerLb = false } = opts;

  // Dinners: cue derives from the SAME bucket map the order card uses.
  const bucket = DINNER_REHEAT_BUCKET[name];
  if (bucket) {
    const cue =
      bucket === 'bagged' ? REHEAT_CUES.simmerBag
      : bucket === 'pasta' ? REHEAT_CUES.cookFreshPasta
      : bucket === 'noodle' ? REHEAT_CUES.cookFreshNoodle
      : bucket === 'stovetop' ? REHEAT_CUES.stovetopSplash
      // Spotlight multi-part dishes: the label must say SEAR, not "warm
      // gently" — these are sear-to-finish plates with bagged sides.
      : bucket === 'lambSpotlight' ? 'Sear the lamb (no rest, thin cut); beans reheat in the bag'
      : bucket === 'porkChopSpotlight' ? 'Counter-warm 30+ min, then sear; sides reheat in their bags'
      : bucket === 'steakAuPoivreSpotlight' ? 'Counter-warm 30 min, then sear to 131F; sides reheat in their bags'
      : REHEAT_CUES.stovetop;
    return { reheatable: true, cue, packaging: 'per-qty' };
  }

  // Named special cases from the bag section
  if (name === 'Garlic Confit') return { reheatable: false, cue: REHEAT_CUES.keepFrozen, packaging: 'per-qty' };
  if (name === 'Homemade Waffles') return { reheatable: true, cue: REHEAT_CUES.toaster, packaging: 'single' };
  if (name === 'Queso') return { reheatable: true, cue: REHEAT_CUES.stovetopSplash, packaging: 'per-qty' };

  // Per-lb proteins: customer sears; weighed → per-BAG labels.
  if (isPerLb) return { reheatable: true, cue: REHEAT_CUES.searProtein, packaging: 'per-bag' };

  // Category rules for everything else
  if (category === 'bag') {
    // Sous vide veg (non-perLb bag items): each qty is its own sealed bag.
    const gentle = /asparagus/i.test(name);
    return { reheatable: true, cue: gentle ? REHEAT_CUES.simmerBagGentle : REHEAT_CUES.simmerBag, packaging: 'per-qty' };
  }
  if (category === 'sauces') return { reheatable: false, cue: REHEAT_CUES.fridge, packaging: 'per-qty' };
  // Fruit containers and addon jars are one PHYSICAL package per qty (two
  // cantaloupe containers = two labels); only desserts and waffles ship as a
  // genuinely single package however many you order (the cookies bug).
  if (category === 'fruit' || category === 'addons') {
    return { reheatable: false, cue: '', packaging: 'per-qty' };
  }
  if (category === 'desserts' || category === 'breakfast') {
    return { reheatable: false, cue: '', packaging: 'single' };
  }

  // Unknown: safe default — no invented instructions, one package.
  return { reheatable: false, cue: '', packaging: 'single' };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHOPPING LIST MERGE ENGINE (Jul 9) — one ingredient, one line, always.
// The list mixes two text formats ("Celery — 3 stalks" from the generator,
// "3 stalks Celery" from the single-dish adder) and repeated adds used to
// stack duplicate rows. This engine parses both formats, unifies quantities
// across unit families (tsp→tbs→cup, oz→lb), and combines rows whose
// ingredient names normalize to the same thing. Anything unparseable passes
// through untouched — merging must never eat a note.
// ═══════════════════════════════════════════════════════════════════════════

const VOL_TO_CUP = { cup: 1, cups: 1, c: 1, tbs: 1 / 16, tbsp: 1 / 16, tablespoon: 1 / 16, tsp: 1 / 48, teaspoon: 1 / 48,
  // Universal unit layer (Jul 14): the rest of the volume family, so a recipe
  // or hand-typed line in any sane liquid unit sums into the same bucket.
  floz: 1 / 8, ml: 1 / 236.588, l: 1000 / 236.588, liter: 1000 / 236.588, qt: 4, qts: 4, quart: 4, pt: 2, pint: 2 };
const WT_TO_LB = { lb: 1, lbs: 1, pound: 1, g: 1 / 453.592, gram: 1 / 453.592, kg: 1000 / 453.592, kgs: 1000 / 453.592, kilogram: 1000 / 453.592 };
// Bare ounces are AMBIGUOUS (fluid vs weight) — Kevin shops in oz either way.
// They live in their own bucket and fold into whichever family the SAME
// ingredient already uses: volume if any (stock in cups + stock in oz),
// heavy weight if any (thighs in lb + thighs in oz), else they stand alone
// and render as a plain oz total (canned tomatoes). Different ingredients
// never share a bucket, so flour-by-cup can't contaminate stock-by-cup.
const OZ_UNITS = new Set(['oz', 'ounce', 'ounces']);
const OZ_PER_CUP = 8, OZ_PER_LB = 16;
const singularizeUnit = (u) => (u.length > 3 && u.endsWith('s') && !u.endsWith('ss')) ? u.slice(0, -1) : u;

// "NNoz can" units (14oz can, 28 oz can, ...) resolve to plain ounces so
// different can sizes of the same item SUM. Kevin does the cans-per-oz math
// himself in the aisle, by choice — never translate oz back to cans.
// "small can" / bare "can" have no stated size and stay opaque counts.
const CAN_OZ_RE = /^(\d+(?:\.\d+)?)\s*oz\s+cans?$/;
function resolveCanUnit(qty, unit) {
  const m = CAN_OZ_RE.exec(unit || '');
  return m ? { qty: qty * parseFloat(m[1]), unit: 'oz' } : { qty, unit };
}

// Unit → summing family. 'u:' prefixed families are opaque per-unit buckets.
function classifyUnit(u) {
  if (OZ_UNITS.has(u)) return 'amb';
  if (VOL_TO_CUP[u] != null) return 'vol';
  if (WT_TO_LB[u] != null) return 'wt';
  return `u:${u}`;
}

// Butter is bought in sticks; every butter quantity folds to sticks.
// (1 stick = 0.5 cup = 8 tbsp = 4 oz = 0.25 lb.) Keyed by NORMALIZED name.
const STICK_FOLD = { 'butter': { cupPerStick: 0.5, ozPerStick: 4, lbPerStick: 0.25 } };

// Post-aggregation fold across one ingredient's family groups. Mutates the
// groups; absorbed groups get dead:true and are dropped at render.
function foldNormGroups(norm, list) {
  const absorb = (into, from) => {
    if (from.vol != null) into.vol = (into.vol || 0) + from.vol;
    if (from.wt != null) into.wt = (into.wt || 0) + from.wt;
    if (from.amb != null) into.amb = (into.amb || 0) + from.amb;
    into.plain += from.plain || 0;
    into.checked = into.checked && from.checked;
    into.staple = into.staple && from.staple;
    if (from.ord < into.ord) {
      into.ord = from.ord;
      if (from.id !== undefined) into.id = from.id;
      if (from.name !== undefined) into.name = from.name;
    }
    from.dead = true;
  };
  const sf = STICK_FOLD[norm];
  if (sf) {
    for (const g of list) {
      if (g.dead) continue;
      if (g.vol != null) { g.plain += g.vol / sf.cupPerStick; g.vol = null; g.unit = 'stick'; }
      if (g.amb != null) { g.plain += g.amb / sf.ozPerStick; g.amb = null; g.unit = 'stick'; }
      if (g.wt != null) { g.plain += g.wt / sf.lbPerStick; g.wt = null; g.unit = 'stick'; }
    }
    const sticks = list.filter(g => !g.dead && g.unit === 'stick').sort((a, b) => a.ord - b.ord);
    for (let i = 1; i < sticks.length; i++) absorb(sticks[0], sticks[i]);
    return;
  }
  const amb = list.find(g => !g.dead && g.amb != null);
  if (amb) {
    const host = list.find(g => !g.dead && g.vol != null) || list.find(g => !g.dead && g.wt != null);
    if (host) {
      if (host.vol != null) host.vol += amb.amb / OZ_PER_CUP;
      else host.wt += amb.amb / OZ_PER_LB;
      amb.amb = null;
      absorb(host, amb);
    }
  }
}

// parseShoppingLine(text) → { name, qty, unit, staple } | { passthrough: text }
export function parseShoppingLine(text) {
  const t = String(text || '').trim();
  if (!t || /^──/.test(t) || /^—/.test(t)) return { passthrough: text };
  const staple = /\(staple\)\s*$/.test(t);
  const body = t.replace(/\s*\(staple\)\s*$/, '');
  // Format A (generator): "Name — 2 lb" / "Name — 3"
  let m = body.match(/^(.+?)\s+—\s+([\d.]+)\s*(.*)$/);
  if (m) {
    const r = resolveCanUnit(parseFloat(m[2]), singularizeUnit(m[3].trim().toLowerCase()));
    return { name: m[1].trim(), qty: r.qty, unit: r.unit, staple };
  }
  // Format B can-size: "3 14oz can Canned tomatoes" — the numeric can size
  // defeats the generic Format B unit match, so catch it first.
  m = body.match(/^([\d.]+)\s+(\d+(?:\.\d+)?\s*oz\s+cans?)\s+(.*)$/i);
  if (m) {
    const r = resolveCanUnit(parseFloat(m[1]), m[2].toLowerCase().replace(/\s+/g, ' ').trim());
    return { name: m[3].trim(), qty: r.qty, unit: r.unit, staple };
  }
  // Format B (dish adder): "2 lb Name" / "3 Name"
  m = body.match(/^([\d.]+)\s+([a-zA-Z]+)?\s*(.*)$/);
  if (m && m[3]) {
    const maybeUnit = (m[2] || '').toLowerCase();
    const known = VOL_TO_CUP[maybeUnit] != null || WT_TO_LB[maybeUnit] != null || OZ_UNITS.has(maybeUnit) ||
      ['clove', 'cloves', 'stalk', 'stalks', 'bunch', 'bunches', 'each', 'can', 'cans', 'head', 'heads', 'fillet', 'fillets', 'ear', 'ears', 'stick', 'sticks', 'sprig', 'sprigs', 'knob', 'knobs', 'pinch', 'pinches', 'jar', 'jars', 'pack', 'packs', 'block', 'blocks', 'batch', 'kg', 'kgs', 'kilogram', 'ml', 'l', 'liter', 'qt', 'qts', 'quart', 'quarts', 'pt', 'pint', 'pints', 'floz'].includes(maybeUnit);
    if (known) return { name: m[3].trim(), qty: parseFloat(m[1]), unit: singularizeUnit(maybeUnit), staple };
    // no unit — the second token is part of the name
    return { name: `${m[2] || ''} ${m[3]}`.trim(), qty: parseFloat(m[1]), unit: '', staple };
  }
  return { passthrough: text };
}

const fmtQ = (q) => String(Math.round(q * 100) / 100);
// Volume renders in OUNCES by default (>= 2 oz) — packages list oz and Kevin
// does the container math in the store. Tiny amounts keep tbs/tsp so a
// teaspoon of vanilla never shows as "0.17 oz". Weight keeps lb (oz under a
// quarter pound), and plain ambiguous-oz totals render as oz directly.
function renderQty(volCups, wtLb, ambOz, plain, unit) {
  if (volCups != null) {
    const oz = volCups * OZ_PER_CUP;
    if (oz >= 2) return `${fmtQ(oz)} oz`;
    const tbs = volCups * 16;
    if (tbs >= 1) return `${fmtQ(tbs)} tbs`;
    return `${fmtQ(volCups * 48)} tsp`;
  }
  if (wtLb != null) {
    if (wtLb >= 0.25) return `${fmtQ(wtLb)} lb`;
    return `${fmtQ(wtLb * OZ_PER_LB)} oz`;
  }
  if (ambOz != null) return `${fmtQ(ambOz)} oz`;
  return unit ? `${fmtQ(plain)} ${unit}` : fmtQ(plain);
}

const PLURAL_OK = new Set(['stalk', 'clove', 'bunch', 'can', 'head', 'fillet', 'ear', 'stick', 'sprig', 'knob', 'pinch', 'jar', 'pack', 'block', 'cup']);
function pluralizeQty(qty) {
  const [num, ...uParts] = qty.split(' ');
  const u = uParts.join(' ');
  return (u && PLURAL_OK.has(u) && parseFloat(num) !== 1) ? `${num} ${u}s` : qty;
}

// mergeShoppingRows(rows) — rows are the list's {id, text, checked} shape.
// Same normalized ingredient + compatible units → ONE row, quantities summed
// in the family base, rendered in the most readable unit. Headers ("── dish
// ──") are dropped when a merge happens under them — a combined line can't
// honestly belong to one dish's section. checked survives only if EVERY
// merged constituent was checked (an unchecked need keeps the row open).
export function mergeShoppingRows(rows) {
  const groups = new Map(); // norm|family -> group
  const byNorm = new Map(); // norm -> [groups] for the post-aggregation fold
  const out = [];
  let ord = 0;
  for (const row of (rows || [])) {
    const p = parseShoppingLine(row.text);
    if (p.passthrough !== undefined) {
      // keep notes; drop dish section headers (they lie once rows combine)
      if (!/^──/.test(String(row.text).trim())) out.push(row);
      continue;
    }
    const norm = normalizeIngredientName(p.name);
    const fam = classifyUnit(p.unit);
    const key = `${norm}|${fam}`;
    let g = groups.get(key);
    if (!g) {
      g = { norm, name: p.name, vol: null, wt: null, amb: null, plain: 0, unit: p.unit, checked: true, id: row.id, staple: p.staple, ord: ord++, dead: false };
      groups.set(key, g);
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(g);
      out.push(g); // placeholder keeps original ordering
    }
    if (fam === 'vol') g.vol = (g.vol || 0) + p.qty * VOL_TO_CUP[p.unit];
    else if (fam === 'wt') g.wt = (g.wt || 0) + p.qty * WT_TO_LB[p.unit];
    else if (fam === 'amb') g.amb = (g.amb || 0) + p.qty;
    else g.plain += p.qty;
    g.checked = g.checked && !!row.checked;
    g.staple = g.staple && p.staple;
  }
  for (const [norm, list] of byNorm) foldNormGroups(norm, list);
  return out.filter(r => r.text !== undefined || !r.dead).map(r => {
    if (r.text !== undefined) return r; // passthrough rows
    const qty = pluralizeQty(renderQty(r.vol, r.wt, r.amb, r.plain, r.unit));
    return { id: r.id, text: `${r.name} — ${qty}${r.staple ? ' (staple)' : ''}`, checked: r.checked };
  });
}

// ═══ SELF-MAINTAINING SHOPPING LIST (Jul 9 automation pass) ═════════════════
// buildAutoShoppingRows(activeOrders, includeStaples, prevRows) → next rows.
// The auto layer regenerates atomically from orders; manual rows pass through
// untouched. Checkmarks survive by INGREDIENT NAME, not exact text — so
// "Chicken thighs — 2 lb" staying checked when a late order makes it 3 lb.
// (The old exact-text keying silently lost checkmarks whenever a quantity
// moved, which is exactly mid-shop when it hurts most.)
export function buildAutoShoppingRows(activeOrders, includeStaples, prevRows, mkId) {
  // Omakase: menu-pick components are expanded into real dishes so their
  // recipes contribute actual ingredient quantities. Everything else (typed
  // ingredients, off-menu improvisation, and any omakase Kevin has not decided
  // on yet) becomes a plain reminder line so the list is never silently short
  // by a whole order.
  const { pseudoItems, extraLines } = expandOmakaseForShopping(activeOrders);
  // Strip the omakase line itself from the base pass: it has no recipe, so the
  // generator would emit a "no recipe data" row on top of the explicit lines
  // built above.
  const stripped = (activeOrders || []).map(o => (
    (o.items || []).some(it => it.omakase)
      ? { ...o, items: (o.items || []).filter(it => !it.omakase) }
      : o
  ));
  const ordersForShopping = pseudoItems.length
    ? [...stripped, { id: '__omakase__', createdAt: new Date().toISOString(), items: pseudoItems }]
    : stripped;
  const lines = generateShoppingItems(ordersForShopping, includeStaples);
  const checkedByName = new Map();
  for (const it of (prevRows || [])) {
    if (!it.checked) continue;
    const p = parseShoppingLine(it.text);
    if (p.passthrough === undefined) checkedByName.set(normalizeIngredientName(p.name), true);
  }
  const manual = (prevRows || []).filter(it => !it.auto);
  const autos = lines.map(text => {
    const p = parseShoppingLine(text);
    const key = p.passthrough === undefined ? normalizeIngredientName(p.name) : null;
    return { id: mkId(), text, checked: key ? !!checkedByName.get(key) : false, auto: true };
  });
  const omaRows = extraLines.map(l => ({
    id: mkId(), text: l.note ? `${l.label} — ${l.note}` : l.label, checked: false, auto: true,
  }));
  return [...autos, ...omaRows, ...manual];
}


// ─── Reheat rescue (customer-facing) ─────────────────────────────────────────
// What to say when someone taps "a little off" or "had trouble". Sourced from
// the reheat canon, NOT from the dossier: journal.js is behind the privacy
// wall and companion.js can never import it. A per-dish override lives in
// dishes.js under copy.rescue when a dish needs something specific.
//
// The default cases are the failure modes that actually happen, in order of
// how often: stopping at warm (starch retrogradation reverses above 140F, so
// a lukewarm polenta stays grainy while a steaming one comes back), too much
// heat too fast on emulsions, and overcooking proteins on the second pass.
const RESCUE_BY_BUCKET = {
  simmer: 'Next time take it further than warm. Heat until it is steaming all the way through, not just hot at the edges. Most of the texture comes back at the top of that range and almost none of it comes back below.',
  sear: 'Next time get the pan hotter and leave it alone longer before turning. A grey edge usually means the pan was not ready yet.',
  oven: 'Next time give it a few more minutes covered, then uncover at the end. Covered brings it up evenly, uncovered brings the surface back.',
  gentle: 'Next time keep the heat lower and go slower. This one breaks if it is pushed, and it cannot be un-broken once it splits.',
};

export function rescueFor(itemName, bucket) {
  const d = DISHES.find(x => x.name === itemName);
  if (d && d.copy && d.copy.rescue) return d.copy.rescue;
  const b = bucket || DINNER_REHEAT_BUCKET[itemName];
  if (b && RESCUE_BY_BUCKET[b]) return RESCUE_BY_BUCKET[b];
  return RESCUE_BY_BUCKET.simmer;
}
