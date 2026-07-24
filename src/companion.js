// companion.js — #2 the customer kitchen companion (engine, pure)
// Renders a self-contained, branded per-order HTML page: the LTB logo, their
// dishes, and exactly how to bring each home — all reheat/sear/frozen wording
// pulled from the canonical engine (buildReheatBlocks + itemHandling), so this
// page can never disagree with the order card or the labels.
import { buildReheatBlocks, itemHandling, rescueFor } from './recipes.js';
import { expandOrderForReheat, omakaseCustomReheat, omakaseItemsOf } from './omakase.js';
import { isPerLbItem } from './menu.js';
import { ALWAYS_ITEMS, DISHES } from './dishes.js';
import { DRINKS } from './drinks.js';
import { LTB_LOGO } from './ltbLogo.js';
import { parseServings } from './dishReport.js';

const CATEGORY_OF = {};
for (const [cat, items] of Object.entries(ALWAYS_ITEMS)) for (const it of items) CATEGORY_OF[it.name] = cat;

const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


// Compact grounding context for the /ask endpoint: the customer's order and
// the exact canon reheat text shown on their page. Kept small on purpose —
// this is the per-question token cost.
export function companionContext(order, opts = {}) {
  const items = (order.items || []).map(it =>
    `${Number(it.qty) || 1}x ${it.name}${it.variant ? ` (${it.variant})` : ''}`).join('; ');
  const blocks = buildReheatBlocks(expandOrderForReheat(order)).map(b =>
    `${b.title} [${b.dishes.join(', ')}]: ${(Array.isArray(b.body) ? b.body : [b.body]).join(' ')}`).join('\n');
  const handleNotes = (order.items || []).map(it => {
    const h = itemHandling(it.name, { category: CATEGORY_OF[it.name] || null, isPerLb: isPerLbItem(it.name) });
    return h.cue ? `${it.name}: ${h.cue}` : null;
  }).filter(Boolean).join('\n');

  // Pairings — the /ask bot must be grounded in what the page shows, or it
  // contradicts the card printed right above the question box. Same canon as
  // companionHtml (dishes.js copy.pairings), rendered as text. The one-bottle
  // intersection mirrors the page's logic so both agree.
  const PAIRINGS_BY_NAME = {};
  for (const d of DISHES) if (d.copy && d.copy.pairings) PAIRINGS_BY_NAME[d.name] = d.copy.pairings;
  const withPairs = (order.items || []).filter(it => PAIRINGS_BY_NAME[it.name]);
  let pairingText = '';
  if (withPairs.length) {
    const secs = withPairs.map(it =>
      `${it.name}: ` + PAIRINGS_BY_NAME[it.name].map(pr => `${pr.drink} (${pr.why})`).join('; ')
    ).join('\n');
    let oneBottle = '';
    if (withPairs.length >= 2) {
      const cover = {};
      for (const it of withPairs) for (const pr of PAIRINGS_BY_NAME[it.name]) {
        if (!pr.id) continue;
        (cover[pr.id] = cover[pr.id] || new Set()).add(it.name);
      }
      let best = null;
      for (const [id, set] of Object.entries(cover)) {
        const kind = (DRINKS[id] || {}).kind;
        const score = set.size * 10 + (kind === 'wine' ? 1 : 0);
        if (set.size >= 2 && (!best || score > best.score)) best = { id, set, score };
      }
      if (best) {
        const label = (DRINKS[best.id] || {}).label || best.id;
        oneBottle = best.set.size === withPairs.length
          ? `One bottle for the whole order: ${label} works with everything ordered.`
          : `Closest single bottle: ${label} covers ${best.set.size} of ${withPairs.length} dinners.`;
      }
    }
    pairingText = `\nDRINK PAIRINGS (what their page recommends):\n${oneBottle ? oneBottle + '\n' : ''}${secs}`;
  }

  // Passport — regulars only; the app supplies opts.passport when the order is
  // linked to a regular. Absent for everyone else, same as the page card.
  let passportText = '';
  if (opts.passport && opts.passport.total > 0) {
    const pp = opts.passport;
    const missing = (pp.missing || []).slice(0, 5);
    passportText = `\nDISH PASSPORT: had ${pp.tried} of ${pp.total} dinners on the full menu.` +
      (missing.length ? ` Not yet tried: ${missing.join(', ')}.` : ` Has tried everything.`);
  }

  return `CUSTOMER: ${order.customer || 'Friend'}\nORDER: ${items}\nINSTRUCTIONS SHOWN ON THEIR PAGE:\n${blocks}\nITEM HANDLING:\n${handleNotes}${pairingText}${passportText}`;
}

export function companionHtml(order, pageId = '', opts = {}) {
  const customer = esc(order.customer || 'Friend');
  const firstName = customer.split(' ')[0];
  const blocks = buildReheatBlocks(expandOrderForReheat(order));
  const items = order.items || [];
  const handleOf = (name) => itemHandling(name, { category: CATEGORY_OF[name] || null, isPerLb: isPerLbItem(name) });
  const frozen = items.filter(it => /FROZEN/.test(handleOf(it.name).cue));
  const noFuss = items.filter(it => { const h = handleOf(it.name); return !h.reheatable && !/FROZEN/.test(h.cue); });

  // Omakase reveal: they are holding an unlabeled box, so the page has to say
  // what it is. Menu components already have canon reheat text (the expanded
  // order above); anything Kevin typed a reheat note for is listed here.
  const omaItems = omakaseItemsOf(order);
  const omaCustom = omakaseCustomReheat(order);
  const omakaseCard = omaItems.length ? omaItems.map(it => {
    const comps = it.components || [];
    const body = comps.length
      ? `<ul>${comps.map(c => `<li><b>${esc(c.label || 'A dish')}</b></li>`).join('')}</ul>`
      : `<p>Still deciding what to make you. It will be worth the wait.</p>`;
    const price = (it.price != null && it.budgetMax != null && it.price < it.budgetMax)
      ? `<p class="omaprice">Charged ${esc('$' + it.price)} against your ${esc('$' + it.budgetMax)} max.${it.underNote ? ' ' + esc(it.underNote) : ''}</p>`
      : '';
    // Kevin's hand-written card for the improvised part of the order. Menu
    // components speak for themselves through the canon reheat blocks above,
    // so an omakase with both correctly shows both.
    const card = it.reheatCard
      ? `<div class="omaheat"><div class="omaheat-head">How to reheat this</div><div>${esc(it.reheatCard).replace(/\n/g, '<br>')}</div></div>`
      : '';
    const extra = omaCustom.length
      ? `<div class="omaheat">${omaCustom.map(x => `<div><b>${esc(x.label)}</b>: ${esc(x.reheat)}</div>`).join('')}</div>`
      : '';
    return `<div class="card"><h3>Your omakase</h3>${body}${price}${card}${extra}</div>`;
  }).join('') : '';

  const itemRows = items.map(it => {
    const servings = it.variant ? parseServings(it.variant) : null;
    const feeds = servings ? `<span class="feeds">feeds ~${servings}</span>` : '';
    return `<li><span class="qty">${Number(it.qty) || 1}×</span> <b>${esc(it.name)}</b>${it.variant ? ` <span class="v">${esc(it.variant)}</span>` : ''}${feeds}</li>`;
  }).join('');

  // Reheat/sear steps, numbered so the page reads like a short recipe. The
  // sear block (when present) is styled amber; canon owns all the wording.
  // Spoken steps: the person following these has wet hands and a hot pan, so
  // the screen is the wrong place to be looking. Uses the browser's own speech
  // synthesis — no audio files, no network, no install, and nothing to load.
  // iOS refuses to speak without a user gesture, so it is a button rather than
  // autoplay, which is what you would want anyway.
  const stepCards = blocks.map((b, i) => {
    const spoken = [b.title, ...(Array.isArray(b.body) ? b.body : [b.body])].join('. ');
    return `
    <div class="card step${/sear/i.test(b.title) ? ' sear' : ''}">
      <div class="stephead"><span class="stepnum">${i + 1}</span><h3>${esc(b.title)}</h3>
        <button class="speak" data-say="${esc(spoken)}" aria-label="Read this step aloud">🔊</button></div>
      <div class="dishes">${b.dishes.map(esc).join(' · ')}</div>
      ${(Array.isArray(b.body) ? b.body : [b.body]).map(p => `<p>${esc(p)}</p>`).join('')}
    </div>`; }).join('');

  const frozenCard = frozen.length ? `
    <div class="card warn">
      <h3>❄ Keep these frozen</h3>
      <p><b>${frozen.map(f => esc(f.name)).join(', ')}</b> stays in the freezer until you use it. Thaw in the fridge and use within 3 days. Never leave it out at room temperature.</p>
    </div>` : '';

  const noFussCard = noFuss.length ? `
    <div class="card ready">
      <h3>✓ Ready as-is</h3>
      <p><b>${noFuss.map(f => esc(f.name)).join(', ')}</b> — nothing to do. Enjoy straight from the fridge.</p>
    </div>` : '';

  // ── Pairings — for exactly what THIS customer ordered ────────────────────
  // Canon lives in dishes.js copy.pairings, same source the menus render. One
  // block per ordered dinner that has pairings; dishes without them (always-
  // available items, per-lb proteins) simply don't appear.
  const PAIRINGS_BY_NAME = {};
  for (const d of DISHES) if (d.copy && d.copy.pairings) PAIRINGS_BY_NAME[d.name] = d.copy.pairings;
  // ── One bottle for the whole order ──────────────────────────────────────
  // Canonical drink ids make the intersection trivial: if one drink appears in
  // every ordered dinner's pairings, say so up top. If no perfect cover, take
  // the drink covering the most dinners (>=2). Wine wins ties — it's the
  // bottle someone actually brings.
  const dinnersWithPairs = items.filter(it => PAIRINGS_BY_NAME[it.name]);
  let oneBottle = '';
  if (dinnersWithPairs.length >= 2) {
    const cover = {}; // id -> Set of dish names
    for (const it of dinnersWithPairs) {
      for (const pr of PAIRINGS_BY_NAME[it.name]) {
        if (!pr.id) continue;
        (cover[pr.id] = cover[pr.id] || new Set()).add(it.name);
      }
    }
    let best = null;
    for (const [id, set] of Object.entries(cover)) {
      const kind = (DRINKS[id] || {}).kind;
      const score = set.size * 10 + (kind === 'wine' ? 1 : 0);
      if (set.size >= 2 && (!best || score > best.score)) best = { id, set, score };
    }
    if (best) {
      const label = (DRINKS[best.id] || {}).label || best.id;
      const all = best.set.size === dinnersWithPairs.length;
      oneBottle = `<div class="one-bottle">${all
        ? `One bottle covers it: <b>${esc(label)}</b> works with everything you ordered this week.`
        : `Closest to one bottle: <b>${esc(label)}</b> covers ${best.set.size} of your ${dinnersWithPairs.length} dinners.`}</div>`;
    }
  }

  const pairingSections = items
    .filter(it => PAIRINGS_BY_NAME[it.name])
    .map(it => {
      const rows = PAIRINGS_BY_NAME[it.name].map(pr =>
        `<div class="prow"><b>${esc(pr.drink)}</b> — ${esc(pr.why)}</div>`).join('');
      return `<div class="pdish"><div class="pname">${esc(it.name)}</div>${rows}</div>`;
    });
  const pairingsCard = pairingSections.length ? `
    <div class="card pair">
      <h3>What to drink with it</h3>
      ${oneBottle}
      ${pairingSections.join('')}
    </div>` : '';

  // ── Dish passport — REGULARS ONLY (opts.passport supplied by the app when
  // the order is linked to a regular; absent = card absent). Two pieces: a
  // compact strip near the top, and a full passport book that opens over the
  // page when tapped. The book is IN THIS PAGE, not a second URL: no extra KV
  // key, no second link to expire, and it works offline once loaded.
  // First order gets a different page. You only get one first impression, and
  // right now a new customer's page is identical to their fiftieth. This is
  // the welcome, the explanation of what the passport is, and the one thing
  // worth knowing about reheating, all in one card that never appears again.
  const pp0 = opts.passport;
  const isFirstOrder = !!pp0 && pp0.tried <= (pp0.newStamps || []).length && (pp0.visas || []).length <= 1;
  const welcomeCard = isFirstOrder ? `
    <div class="card welcome">
      <h3>First one. Welcome.</h3>
      <p>Everything here is cooked to be reheated, not just survived. The instructions below
      are the actual difference between a good version and a sad one, so they are worth the
      thirty seconds.</p>
      <p>You also just started a <b>dish passport</b>. Every dinner and dessert you try stamps a
      page, grouped by cuisine. It is not a loyalty card and there is nothing to collect toward.
      It is just a record of what you have eaten here, and it is quietly satisfying to fill.</p>
      <p>Anything at all, text me.</p>
    </div>` : '';

  let passportStrip = '';
  let passportBook = '';
  if (opts.passport && opts.passport.total > 0) {
    const pp = opts.passport;
    const visited = pp.pages.filter(p => p.stamped > 0);
    const newLine = pp.newStamps.length
      ? `<div class="pp-new">New stamps earned from this delivery: ${pp.newStamps.map(esc).join(', ')}</div>`
      : '';

    passportStrip = `
    <button class="pp-strip" onclick="openPassport()" aria-label="Open your dish passport">
      <div class="pp-strip-top">
        <span class="pp-strip-title">Your dish passport</span>
        <span class="pp-strip-open">Open &rsaquo;</span>
      </div>
      <div class="pp-strip-count"><b>${pp.tried}</b> of ${pp.total} stamps &middot; <b>${pp.cuisinesVisited}</b> of ${pp.cuisinesTotal} chapters</div>
      ${newLine}
      <div class="pp-strip-chips">${visited.map(p => `<span class="pp-chip">${esc(p.label)}</span>`).join('')}</div>
    </button>`;

    const issuedTxt = pp.issued
      ? new Date(pp.issued).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : '';
    const coverPage = `
      <div class="pp-page pp-cover" data-page="0">
        <div class="pp-cover-crest">LTB</div>
        <div class="pp-cover-title">Dish Passport</div>
        <div class="pp-cover-owner">${customer}</div>
        ${issuedTxt ? `<div class="pp-cover-issued">Issued ${esc(issuedTxt)}</div>` : ''}
        <div class="pp-cover-stats">
          <div class="pp-cs"><b>${pp.tried}</b><span>of ${pp.total} stamps</span></div>
          <div class="pp-cs"><b>${pp.cuisinesVisited}</b><span>of ${pp.cuisinesTotal} chapters</span></div>
          ${pp.chaptersComplete > 0 ? `<div class="pp-cs"><b>${pp.chaptersComplete}</b><span>chapter${pp.chaptersComplete === 1 ? '' : 's'} filled</span></div>` : ''}
          ${pp.visas.length ? `<div class="pp-cs"><b>${pp.visas.length}</b><span>omakase visa${pp.visas.length === 1 ? '' : 's'}</span></div>` : ''}
        </div>
        ${pp.newCuisines.length ? `<div class="pp-cover-note">First time in ${pp.newCuisines.map(esc).join(' and ')}. That is a new chapter opened.</div>` : ''}
      </div>`;

    const visaPage = pp.visas.length ? `
      <div class="pp-page pp-visas" data-page="1">
        <div class="pp-page-head">
          <div class="pp-page-name"><span class="pp-emblem">\u2708</span>Omakase visas</div>
          <div class="pp-page-count">${pp.visas.length}</div>
        </div>
        <div class="pp-visa-note">Every time you handed over the menu and said cook me something.</div>
        ${pp.visas.map(v => `
          <div class="pp-visa${v.isNew ? ' pp-visa-new' : ''}">
            <div class="pp-visa-l">
              <div class="pp-visa-date">${v.date ? esc(new Date(v.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : ''}</div>
              <div class="pp-visa-size">${esc(v.size || 'Omakase')}</div>
            </div>
            <div class="pp-visa-budget">${v.budget ? '$' + v.budget : ''}</div>
          </div>`).join('')}
      </div>` : '';

    const retiredPage = (pp.retired && pp.retired.length) ? `
      <div class="pp-page pp-retired" data-page="RETIRED_IDX">
        <div class="pp-page-head">
          <div class="pp-page-name"><span class="pp-emblem">\u2020</span>No longer served</div>
          <div class="pp-page-count">${pp.retired.length}</div>
        </div>
        <div class="pp-visa-note">Dishes you ate that have since come off the menu. They still count for something.</div>
        <div class="pp-stamps">
          ${pp.retired.map((r, j) => {
            const seed = r.name.length + r.name.charCodeAt(0) + j;
            const rot = ((seed * 13) % 15) - 7;
            const when = r.firstHad
              ? new Date(r.firstHad).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()
              : '';
            const short = r.name.length > 34 ? r.name.slice(0, 32).trim() + '\u2026' : r.name;
            return `<div class="pp-stamp pp-stamp-retired" style="--rot:${rot}deg"
                        onclick="stampDetail(this)"
                        data-detail="${esc(r.name)}${r.times > 1 ? ' \u00b7 ' + r.times + ' times' : ''}${when ? ' \u00b7 first had ' + esc(when) : ''} \u00b7 no longer on the menu">
                     <div class="pp-ink">
                       <div class="pp-ring">
                         <div class="pp-arc">RETIRED</div>
                         <div class="pp-stamp-name">${esc(short)}</div>
                         <div class="pp-date">${esc(when)}</div>
                       </div>
                     </div>
                   </div>`;
          }).join('')}
        </div>
      </div>` : '';

    const offset = pp.visas.length ? 2 : 1;
    const spreads = coverPage + visaPage + pp.pages.map((page, iRaw) => {
      const i = iRaw + offset;
      return `
      <div class="pp-page" data-page="${i}">
        <div class="pp-page-head">
          <div class="pp-page-name"><span class="pp-emblem">${esc((page.label || '?').slice(0, 1))}</span>${esc(page.label)}</div>
          <div class="pp-page-count">${page.stamped} / ${page.total}</div>
        </div>
        ${page.complete ? '<div class="pp-seal"><div class="pp-seal-in">chapter<br>complete</div></div>' : ''}
        <div class="pp-stamps">
          ${page.dishes.map((d, j) => {
            // Deterministic per-dish jitter so a stamp sits the same way every
            // time you open the book, but no two look identical.
            const seed = d.name.length + d.name.charCodeAt(0) + j;
            const rot = ((seed * 13) % 15) - 7;
            const when = d.firstHad
              ? new Date(d.firstHad).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()
              : '';
            const short = d.name.length > 34 ? d.name.slice(0, 32).trim() + '\u2026' : d.name;
            const marks = [];
            if (d.firstEver) marks.push('<span class="pp-mark pp-mark-first" title="First person to ever order this">1st</span>');
            if (d.requested) marks.push('<span class="pp-mark pp-mark-req" title="You asked for this one">asked</span>');
            const detail = [
              d.times > 1 ? d.times + ' times' : (d.times === 1 ? 'once' : ''),
              when ? 'first had ' + when : '',
              d.granted ? 'added by Kevin' : '',
            ].filter(Boolean).join(' \u00b7 ');
            return d.stamped
              ? `<div class="pp-stamp${d.isNew ? ' pp-stamp-new' : ''}" style="--rot:${rot}deg"
                     onclick="stampDetail(this)" data-detail="${esc(d.name)}${detail ? ' \u2014 ' + esc(detail) : ''}">
                   <div class="pp-ink">
                     <div class="pp-ring">
                       <div class="pp-arc">${esc(page.label.toUpperCase())}</div>
                       <div class="pp-stamp-name">${esc(short)}</div>
                       <div class="pp-date">${esc(when)}</div>
                     </div>
                   </div>
                   ${d.isNew ? '<div class="pp-stamp-flag">new</div>' : ''}
                   ${marks.length ? `<div class="pp-marks">${marks.join('')}</div>` : ''}
                 </div>`
              : `<div class="pp-blank" style="--rot:${rot / 3}deg"><div class="pp-blank-name">${esc(short)}</div></div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('') + retiredPage.replace('RETIRED_IDX', String(pp.pages.length + offset));

    passportBook = `
    <div class="pp-overlay" id="ppOverlay" role="dialog" aria-label="Dish passport" hidden>
      <div class="pp-book">
        <div class="pp-book-head">
          <div>
            <div class="pp-book-title">Dish passport</div>
            <div class="pp-book-owner">${customer}</div>
          </div>
          <button class="pp-close" onclick="closePassport()" aria-label="Close">&times;</button>
        </div>
        <div class="pp-tabs" id="ppTabs">
          <button class="pp-tab" data-tab="0" onclick="gotoPassport(0)">
            <span class="pp-tab-name">Cover</span>
            <span class="pp-tab-count">${pp.tried}/${pp.total}</span>
          </button>
          ${pp.visas.length ? `
          <button class="pp-tab" data-tab="1" onclick="gotoPassport(1)">
            <span class="pp-tab-name">Visas</span>
            <span class="pp-tab-count">${pp.visas.length}</span>
          </button>` : ''}
          ${pp.pages.map((page, iRaw) => {
            const i = iRaw + (pp.visas.length ? 2 : 1);
            return `
            <button class="pp-tab" data-tab="${i}" onclick="gotoPassport(${i})">
              <span class="pp-tab-name">${esc(page.label)}</span>
              <span class="pp-tab-count${page.complete ? ' pp-tab-done' : ''}${page.stamped === 0 ? ' pp-tab-empty' : ''}">${page.stamped}/${page.total}</span>
            </button>`;
          }).join('')}
          ${(pp.retired && pp.retired.length) ? `
          <button class="pp-tab" data-tab="${pp.pages.length + offset}" onclick="gotoPassport(${pp.pages.length + offset})">
            <span class="pp-tab-name">Retired</span>
            <span class="pp-tab-count">${pp.retired.length}</span>
          </button>` : ''}
        </div>
        <div class="pp-pages" id="ppPages">${spreads}</div>
        <div class="pp-nav">
          <button class="pp-nav-btn" onclick="flipPassport(-1)" aria-label="Previous chapter">&lsaquo;</button>
          <div class="pp-nav-label" id="ppNavLabel"></div>
          <button class="pp-nav-btn" onclick="flipPassport(1)" aria-label="Next chapter">&rsaquo;</button>
        </div>
      </div>
    </div>`;
  }

  const stepsIntro = blocks.length ? `<div class="lead">When you're ready to eat, here's the plan:</div>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#14201d">
<meta name="robots" content="noindex">
<title>Your LTB kitchen page</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #14201d; color: #e8ede9; margin: 0; padding: 0 18px 40px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 560px; margin: 0 auto; }
  .brand { text-align: center; padding: 26px 0 6px; }
  .brand img { width: 96px; height: 96px; border-radius: 20px; display: block; margin: 0 auto 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.35); }
  .brand .name { color: #5DCAA5; font-weight: 800; letter-spacing: 1.5px; font-size: 12px; text-transform: uppercase; }
  h1 { font-size: 23px; margin: 14px 0 3px; text-align: center; font-weight: 800; }
  .sub { color: #9aa5a0; font-size: 13.5px; margin: 0 auto 20px; text-align: center; max-width: 420px; }
  .lead { color: #cfe0d8; font-size: 14px; font-weight: 600; margin: 22px 4px 4px; }
  ul { list-style: none; padding: 0; margin: 4px 0 0; }
  li { padding: 7px 0; font-size: 14.5px; border-bottom: 1px solid #26322e; }
  li:last-child { border-bottom: none; }
  .qty { color: #5DCAA5; font-weight: 800; margin-right: 4px; }
  .card.pair { border-left: 2px solid #2d6a6a; }
  .card.pair h3 { color: #5DCAA5; }
  .pdish { margin-bottom: 12px; }
  .pdish:last-child { margin-bottom: 0; }
  .pname { font-size: 12px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; color: #9aa5a0; margin-bottom: 4px; }
  .prow { font-size: 13px; color: #cfe0d8; line-height: 1.5; margin-bottom: 3px; }
  .prow b { color: #e8ede9; font-weight: 600; }
  .one-bottle { font-size: 13.5px; color: #cfe0d8; background: rgba(93,202,165,0.10); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; line-height: 1.5; }
  .one-bottle b { color: #5DCAA5; }
  /* ── Dish passport ──────────────────────────────────────────────────────
     Stamps are circular double-ruled ink marks, rotated and slightly blotchy,
     the way a real passport looks after a few trips. The book is aged paper
     with a spine. All pure CSS: no images, so the page stays light and the
     whole thing works offline. */
  .welcome { border-left: 3px solid #5DCAA5; }
  .welcome h3 { color: #5DCAA5; }
  .welcome p { margin: 0 0 9px; }
  .welcome p:last-child { margin-bottom: 0; }
  .welcome b { color: #d4b06a; }
  .pp-strip { display: block; width: 100%; text-align: left; margin: 0 0 18px; padding: 13px 15px;
    background: linear-gradient(145deg, rgba(184,152,90,0.14), rgba(184,152,90,0.03));
    border: 1px solid #6b5a34; border-radius: 12px; cursor: pointer; font: inherit; color: inherit;
    position: relative; overflow: hidden; }
  .pp-strip::after { content: ''; position: absolute; top: -30px; right: -30px; width: 110px; height: 110px;
    border: 2px solid rgba(212,176,106,0.16); border-radius: 50%; }
  .pp-strip:active { transform: scale(0.995); }
  .pp-strip-top { display: flex; justify-content: space-between; align-items: baseline; }
  .pp-strip-title { font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; color: #d4b06a; font-weight: 700; }
  .pp-strip-open { font-size: 12px; color: #9aa5a0; }
  .pp-strip-count { font-size: 15px; color: #e8ede9; margin-top: 5px; font-family: Georgia, 'Times New Roman', serif; }
  .pp-strip-count b { color: #d4b06a; }
  .pp-new { font-size: 12.5px; color: #5DCAA5; margin-top: 5px; font-weight: 600; line-height: 1.45; }
  .pp-strip-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 9px; }
  .pp-chip { font-size: 10px; color: #cfe0d8; border: 1px solid #3a453f; border-radius: 999px;
    padding: 2px 9px; letter-spacing: 0.4px; }

  .pp-overlay { position: fixed; inset: 0; background: rgba(6,11,10,0.94); z-index: 50;
    display: flex; align-items: center; justify-content: center; padding: 14px; }
  .pp-overlay[hidden] { display: none; }
  .pp-book { width: 100%; max-width: 580px; max-height: 90vh; display: flex; flex-direction: column;
    border-radius: 6px 14px 14px 6px; overflow: hidden; position: relative;
    background: #6b5a34;
    box-shadow: 0 30px 70px rgba(0,0,0,0.65), 0 0 0 1px rgba(212,176,106,0.35);
    animation: ppOpen 260ms cubic-bezier(.2,.8,.3,1); }
  @keyframes ppOpen { from { opacity: 0; transform: perspective(1200px) rotateY(-12deg) scale(0.94); }
                      to   { opacity: 1; transform: none; } }
  /* The spine: a darker strip down the left edge of the whole book. */
  .pp-book::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 14px; z-index: 3;
    background: linear-gradient(90deg, rgba(0,0,0,0.5), rgba(0,0,0,0.12) 60%, transparent);
    pointer-events: none; }
  .pp-book-head { display: flex; justify-content: space-between; align-items: flex-start;
    padding: 15px 17px 15px 26px;
    background: linear-gradient(160deg, #7a663c, #5c4d2c);
    border-bottom: 2px solid rgba(0,0,0,0.28); }
  .pp-book-title { font-size: 10px; letter-spacing: 2.6px; text-transform: uppercase;
    color: #f0dfae; font-weight: 700; }
  .pp-book-owner { font-size: 19px; color: #fff6e2; margin-top: 3px;
    font-family: Georgia, 'Times New Roman', serif; }
  .pp-close { background: none; border: none; color: #e8d5a4; font-size: 27px; line-height: 1;
    cursor: pointer; padding: 0 4px; opacity: 0.85; }
  .pp-tabs { display: flex; gap: 4px; overflow-x: auto; padding: 8px 10px 8px 24px;
    background: linear-gradient(180deg, #4a3e24, #40361f);
    border-bottom: 2px solid rgba(0,0,0,0.3); scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .pp-tabs::-webkit-scrollbar { display: none; }
  .pp-tab { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 1px;
    background: rgba(255,246,226,0.06); border: 1px solid rgba(240,223,174,0.22);
    border-bottom: none; border-radius: 7px 7px 0 0; padding: 5px 10px 6px; cursor: pointer;
    font: inherit; color: #cbb98c; transition: background 140ms ease, color 140ms ease; }
  .pp-tab-name { font-size: 11px; letter-spacing: 0.4px; white-space: nowrap; }
  .pp-tab-count { font-size: 8.5px; letter-spacing: 0.6px; opacity: 0.75; }
  .pp-tab-empty { opacity: 0.45; }
  .pp-tab-done { color: #7fd8b4; opacity: 1; font-weight: 700; }
  .pp-tab.on { background: #efe4cd; color: #3d3016; border-color: #efe4cd; }
  .pp-tab.on .pp-tab-count { opacity: 0.7; }
  .pp-tab.on .pp-tab-done { color: #1f6b4f; }
  .pp-pages { flex: 1 1 auto; min-height: 0; overflow: hidden; position: relative; padding-left: 14px;
    /* aged paper, with faint ruled lines like a real document page */
    background:
      repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(90,70,40,0.055) 27px, rgba(90,70,40,0.055) 28px),
      radial-gradient(circle at 18% 12%, rgba(120,95,55,0.10), transparent 55%),
      radial-gradient(circle at 82% 88%, rgba(120,95,55,0.09), transparent 55%),
      linear-gradient(170deg, #efe4cd, #e2d4b8); }
  .pp-page { display: none; position: relative; padding: 16px 16px 22px; height: 100%; overflow-y: auto;
    -webkit-overflow-scrolling: touch; animation: ppFlip 300ms ease; }
  .pp-page.on { display: block; }
  @keyframes ppFlip { from { opacity: 0; transform: perspective(900px) rotateY(9deg); }
                      to   { opacity: 1; transform: none; } }
  .pp-page-head { display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 2px double #a08a5a; padding-bottom: 8px; margin-bottom: 15px; }
  .pp-page-name { font-size: 21px; color: #3d3016; font-family: Georgia, 'Times New Roman', serif;
    letter-spacing: 0.4px; }
  .pp-page-count { font-size: 11px; color: #7a6740; letter-spacing: 1px; text-transform: uppercase; }
  .pp-stamps { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 12px 9px; }

  /* A stamp: circle, double rule, cuisine arc on top, dish name, date below. */
  .pp-stamp { position: relative; aspect-ratio: 1; transform: rotate(var(--rot, 0deg)); }
  .pp-ink { width: 100%; height: 100%; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; padding: 5px;
    border: 2.5px solid #8c3b2f; color: #8c3b2f; opacity: 0.88;
    box-shadow: inset 0 0 0 1.5px #8c3b2f, inset 0 0 14px rgba(140,59,47,0.16); }
  .pp-ring { text-align: center; width: 100%; }
  .pp-arc { font-size: 6.5px; letter-spacing: 1.1px; font-weight: 700; opacity: 0.85; margin-bottom: 1px; }
  .pp-stamp-name { font-size: 8.5px; font-weight: 800; line-height: 1.12; text-transform: uppercase;
    letter-spacing: 0.1px; word-break: break-word; }
  .pp-date { font-size: 6.5px; letter-spacing: 0.9px; margin-top: 2px; opacity: 0.8; }
  /* A new stamp reads as fresher ink, not a different system. */
  /* Retired: the same stamp, faded, the way old ink looks. */
  .pp-stamp-retired .pp-ink { border-color: #6b6357; color: #6b6357; opacity: 0.6;
    box-shadow: inset 0 0 0 1.5px #6b6357, inset 0 0 14px rgba(107,99,87,0.12); }
  .pp-stamp-new .pp-ink { border-color: #1f6b4f; color: #1f6b4f; opacity: 1;
    box-shadow: inset 0 0 0 1.5px #1f6b4f, inset 0 0 16px rgba(31,107,79,0.20); }
  .pp-stamp-flag { position: absolute; top: -2px; right: -2px; font-size: 8px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.7px; color: #f4fbf7; background: #1f6b4f;
    border-radius: 999px; padding: 2px 7px; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
  /* Not yet earned: a dashed placeholder, quiet, never a scolding. */
  .pp-blank { aspect-ratio: 1; border: 1.5px dashed #b3a179; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; padding: 8px;
    transform: rotate(var(--rot, 0deg)); }
  .pp-blank-name { font-size: 8px; color: #a08a5a; line-height: 1.15; text-align: center;
    text-transform: uppercase; letter-spacing: 0.2px; word-break: break-word; }

  /* Cover page: the inside flap of the document. */
  .pp-cover { text-align: center; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 3px; }
  .pp-cover-crest { width: 54px; height: 54px; border-radius: 50%; border: 2.5px solid #8c6d34;
    color: #8c6d34; display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 800; letter-spacing: 1px; margin-bottom: 10px;
    box-shadow: inset 0 0 0 1.5px #8c6d34; }
  .pp-cover-title { font-size: 11px; letter-spacing: 3.4px; text-transform: uppercase; color: #7a6740; }
  .pp-cover-owner { font-size: 27px; color: #3d3016; font-family: Georgia, 'Times New Roman', serif; margin-top: 2px; }
  .pp-cover-issued { font-size: 11px; color: #8a7a52; }
  .pp-cover-stats { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; margin-top: 16px;
    padding-top: 14px; border-top: 2px double #a08a5a; width: 100%; }
  .pp-cs { display: flex; flex-direction: column; align-items: center; }
  .pp-cs b { font-size: 21px; color: #8c3b2f; font-family: Georgia, serif; }
  .pp-cs span { font-size: 9.5px; color: #7a6740; letter-spacing: 0.5px; text-transform: uppercase; }
  .pp-cover-note { font-size: 12px; color: #1f6b4f; margin-top: 14px; font-weight: 600; line-height: 1.5; }

  /* Chapter emblem + completion seal. */
  .pp-emblem { display: inline-flex; align-items: center; justify-content: center;
    width: 25px; height: 25px; border-radius: 50%; border: 1.5px solid #8c6d34; color: #8c6d34;
    font-size: 12px; font-weight: 700; margin-right: 8px; vertical-align: middle;
    font-family: Georgia, serif; }
  .pp-seal { position: absolute; right: 18px; top: 74px; width: 84px; height: 84px; border-radius: 50%;
    border: 3px double #1f6b4f; color: #1f6b4f; display: flex; align-items: center; justify-content: center;
    transform: rotate(-13deg); opacity: 0.72; pointer-events: none; z-index: 2;
    box-shadow: inset 0 0 12px rgba(31,107,79,0.16); }
  .pp-seal-in { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px;
    text-align: center; line-height: 1.3; }

  /* Marks on a stamp: first ever, requested. */
  .pp-marks { position: absolute; bottom: -5px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 3px; white-space: nowrap; }
  .pp-mark { font-size: 7px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px;
    border-radius: 999px; padding: 1px 5px; }
  .pp-mark-first { background: #8c6d34; color: #fff6e2; }
  .pp-mark-req { background: #2f6f57; color: #eafaf3; }

  /* Omakase visas: a different kind of page on purpose. */
  .pp-visa-note { font-size: 11.5px; color: #7a6740; font-style: italic; margin-bottom: 12px; }
  .pp-visa { display: flex; justify-content: space-between; align-items: center; padding: 9px 11px;
    border: 1.5px dashed #8c6d34; border-radius: 8px; margin-bottom: 8px; background: rgba(140,109,52,0.05); }
  .pp-visa-new { border-style: solid; border-color: #1f6b4f; background: rgba(31,107,79,0.07); }
  .pp-visa-date { font-size: 12.5px; color: #3d3016; font-weight: 700; }
  .pp-visa-size { font-size: 10.5px; color: #7a6740; letter-spacing: 0.4px; text-transform: uppercase; }
  .pp-visa-budget { font-size: 15px; color: #8c3b2f; font-family: Georgia, serif; }

  /* Tap a stamp for its story. */
  .pp-detail { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 4;
    background: #2b2418; color: #f0e5cc; border-radius: 9px; padding: 9px 12px; font-size: 12px;
    line-height: 1.45; box-shadow: 0 8px 24px rgba(0,0,0,0.4); animation: ppIn 180ms ease; }
  @keyframes ppIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .pp-nav { display: flex; align-items: center; justify-content: space-between;
    padding: 11px 15px 11px 26px; background: linear-gradient(160deg, #5c4d2c, #4a3e24);
    border-top: 2px solid rgba(0,0,0,0.25); }
  .pp-nav-btn { background: rgba(255,246,226,0.08); border: 1px solid rgba(240,223,174,0.35);
    border-radius: 8px; color: #f0dfae; font-size: 17px; line-height: 1; padding: 5px 16px; cursor: pointer; }
  .pp-nav-btn:active { background: rgba(255,246,226,0.16); }
  .pp-nav-label { font-size: 11px; color: #d8c9a0; letter-spacing: 1.2px; text-transform: uppercase; }
  .v { color: #9aa5a0; font-size: 12.5px; }
  .feeds { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 10px; background: #24413a; color: #5DCAA5; font-size: 11px; font-weight: 700; vertical-align: middle; }
  .card { background: #1c2422; border: 1px solid #2d3a36; border-radius: 14px; padding: 15px 17px; margin: 12px 0; }
  .card h3 { margin: 0; font-size: 15.5px; color: #5DCAA5; font-weight: 800; }
  .stephead { display: flex; align-items: center; gap: 10px; margin-bottom: 5px; }
  .stepnum { flex: 0 0 24px; height: 24px; border-radius: 50%; background: #24413a; color: #5DCAA5; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .card.sear { border-color: #4a3a1e; } .card.sear h3 { color: #EF9F27; } .card.sear .stepnum { background: #3d3016; color: #EF9F27; }
  .card.warn { border-color: #5a3237; } .card.warn h3 { color: #e0828a; }
  .card.ready { border-color: #28483d; } .card.ready h3 { color: #5DCAA5; }
  .dishes { font-size: 12px; color: #8a958f; margin: 2px 0 6px 34px; }
  .step p { margin: 6px 0 6px 34px; }
  p { margin: 6px 0; font-size: 13.5px; }
  .foot { color: #6b7570; font-size: 12px; margin-top: 26px; text-align: center; line-height: 1.7; }
  .foot .heart { color: #5DCAA5; }
  .card.fb { border-color: #2f4a42; }
  .fbrow { padding: 8px 0; border-bottom: 1px solid #26322e; }
  .fbrow:last-child { border-bottom: none; }
  .fbname { font-size: 13.5px; font-weight: 700; margin-bottom: 6px; }
  .fbbtns { display: flex; gap: 7px; flex-wrap: wrap; }
  .fbbtn { border-radius: 9px; padding: 7px 11px; font-size: 12.5px; font-weight: 700; border: 1px solid #2d3a36; background: #14201d; color: #b7c4be; }
  .fbbtn.good { color: #5DCAA5; } .fbbtn.meh { color: #EF9F27; } .fbbtn.bad { color: #e0828a; }
  .fbdone { color: #5DCAA5; font-size: 12.5px; font-weight: 700; }
    .fbrescue { background:rgba(212,160,80,0.10); border:1px solid #D4A050; border-radius:8px;
      padding:9px 11px; margin:6px 0 0; font-size:13px; line-height:1.5; color:#e8e2d4; }
    .fbseen { color:#5DCAA5; font-weight:600; }
    .speak { margin-left:auto; background:transparent; border:1px solid #37403c; color:#9aa5a0;
      border-radius:8px; min-width:40px; min-height:36px; font-size:15px; cursor:pointer; }
  .fbbtn.sel { border-color: #5DCAA5; background: #1d2a26; }
  .fbnotewrap { display: flex; gap: 7px; margin-top: 8px; }
  .fbnote { flex: 1; background: #14201d; border: 1px solid #2d3a36; border-radius: 9px; color: #e8ede9; padding: 8px 11px; font-size: 13px; }
  .fbnote:focus { outline: none; border-color: #5DCAA5; }
  .fbsend { background: #1D9E75; color: #0f1513; border: none; border-radius: 9px; padding: 8px 14px; font-weight: 800; font-size: 12.5px; }
  .card.ask { border-color: #2f4a42; }
  .asknote { color: #9fb3ab; font-size: 12.5px; }
  .askrow { display: flex; gap: 8px; margin-top: 10px; }
  #q { flex: 1; background: #14201d; border: 1px solid #2d3a36; border-radius: 10px; color: #e8ede9; padding: 10px 12px; font-size: 14px; }
  #q:focus { outline: none; border-color: #5DCAA5; }
  #askbtn { background: #1D9E75; color: #0f1513; border: none; border-radius: 10px; padding: 10px 16px; font-weight: 800; font-size: 14px; }
  #askbtn:disabled { opacity: 0.45; }
  .remain { color: #6b7570; font-size: 11.5px; margin-top: 7px; text-align: right; }
  .qa { margin: 10px 0; }
  .qa .q { color: #cfe0d8; font-weight: 700; font-size: 13.5px; }
  .qa .a { color: #b7c4be; font-size: 13.5px; margin-top: 3px; white-space: pre-wrap; }
  .qa .err { color: #e0828a; font-size: 13px; }
</style></head><body><div class="wrap">
  <div class="brand">
    <img src="${LTB_LOGO}" alt="Lettuce, Turnip, The Beet">
    <div class="name">Lettuce, Turnip, The Beet</div>
  </div>
  <h1>${firstName}, here's your kitchen page</h1>
  <div class="sub">Everything in your order, and exactly how to bring each dish home for its best.</div>
  ${passportStrip}
  ${welcomeCard}
  <div class="card"><h3>Your order</h3><ul>${itemRows}</ul></div>
  ${omakaseCard}
  ${stepsIntro}
  ${stepCards}
  ${frozenCard}
  ${noFussCard}
  ${pairingsCard}
  ${passportBook}
  <div class="card fb">
    <h3>How did everything come out?</h3>
    <p class="asknote">One tap per dish tells Kevin what worked, and a line about why helps even more. It makes the food better for everyone. You can submit feedback once per dish for this order.</p>
    <div id="fbrows"></div>
  </div>
  <div class="card ask">
    <h3>Ask about your order</h3>
    <p class="asknote">Not sure about a reheat, a swap, or how long something keeps? Ask here. <b>You get 5 questions on this page</b>, so make them count. For anything about allergies or ingredients, text Kevin directly.</p>
    <div id="thread"></div>
    <div class="askrow">
      <input id="q" type="text" maxlength="300" placeholder="e.g. Can I reheat the gumbo in a microwave?" autocomplete="off">
      <button id="askbtn" onclick="ask()">Ask</button>
    </div>
    <div id="remain" class="remain">5 questions remaining</div>
  </div>
  <div class="foot">Made with care <span class="heart">♥</span><br>Questions about anything? Just text Kevin.<br>This page is yours for 30 days.</div>
</div><script>
// ── Passport book ─────────────────────────────────────────────────────────
// The book lives in this page, so opening it costs no network. Escape closes,
// arrows and swipe flip chapters. It opens on the first chapter with a new
// stamp, because that is the thing worth seeing.
var ppPage = 0, ppTotal = 0;
function ppRender() {
  var openDetail = document.querySelector('.pp-detail');
  if (openDetail) openDetail.parentNode.removeChild(openDetail);
  var pages = document.querySelectorAll('.pp-page');
  ppTotal = pages.length;
  // classList, not className: the cover and visa pages carry extra classes
  // (pp-cover, pp-visas) that a wholesale className rewrite would erase.
  for (var i = 0; i < pages.length; i++) {
    if (i === ppPage) pages[i].classList.add('on');
    else pages[i].classList.remove('on');
  }
  var tabs = document.querySelectorAll('.pp-tab');
  for (var j = 0; j < tabs.length; j++) {
    var on = j === ppPage;
    tabs[j].className = 'pp-tab' + (on ? ' on' : '');
    // Keep the current chapter reachable: with 13 tabs on a phone the active
    // one is often off-screen after an arrow flip or a swipe.
    if (on && tabs[j].scrollIntoView) {
      try { tabs[j].scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }
      catch (e) { tabs[j].scrollIntoView(false); }
    }
  }
  var label = document.getElementById('ppNavLabel');
  if (label) label.textContent = (ppPage + 1) + ' of ' + ppTotal;
}
function stampDetail(el) {
  var txt = el && el.getAttribute('data-detail');
  if (!txt) return;
  var host = document.querySelector('.pp-page.on');
  if (!host) return;
  var old = document.querySelector('.pp-detail');
  if (old) old.parentNode.removeChild(old);
  var box = document.createElement('div');
  box.className = 'pp-detail';
  box.textContent = txt;
  host.appendChild(box);
  clearTimeout(window.__ppDetailT);
  window.__ppDetailT = setTimeout(function () {
    if (box.parentNode) box.parentNode.removeChild(box);
  }, 3200);
}
function gotoPassport(i) {
  if (i < 0 || i >= ppTotal) return;
  ppPage = i;
  ppRender();
}
function openPassport() {
  var ov = document.getElementById('ppOverlay');
  if (!ov) return;
  var withNew = document.querySelector('.pp-stamp-new');
  var host = withNew ? withNew.closest('.pp-page') : null;
  ppPage = host ? Number(host.getAttribute('data-page')) : 0;
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  ppRender();
}
function closePassport() {
  var ov = document.getElementById('ppOverlay');
  if (!ov) return;
  ov.hidden = true;
  document.body.style.overflow = '';
}
function flipPassport(dir) {
  if (!ppTotal) return;
  ppPage = (ppPage + dir + ppTotal) % ppTotal;
  ppRender();
}
document.addEventListener('keydown', function (e) {
  var ov = document.getElementById('ppOverlay');
  if (!ov || ov.hidden) return;
  if (e.key === 'Escape') closePassport();
  else if (e.key === 'ArrowRight') flipPassport(1);
  else if (e.key === 'ArrowLeft') flipPassport(-1);
});
(function () {
  var ov = document.getElementById('ppOverlay');
  if (!ov) return;
  // Tap the backdrop to close, but never a tap inside the book itself.
  ov.addEventListener('click', function (e) { if (e.target === ov) closePassport(); });
  var x0 = null;
  var pages = document.getElementById('ppPages');
  if (!pages) return;
  pages.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  pages.addEventListener('touchend', function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 45) flipPassport(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });
})();

var FB_DISHES = ${JSON.stringify(items.map(it => it.name))};
// What to say when a dish came out wrong. Embedded at build time from the
// REHEAT CANON, never from the dossier: journal.js sits behind the privacy
// wall and this file can never import it.
var FB_RESCUE = ${JSON.stringify(Object.fromEntries(items.map(it => [it.name, rescueFor(it.name)])))};
var FB_PAGE = "${esc(pageId)}";
var fbSent = {};
// Feedback is once-per-dish PER ORDER. We remember what was already submitted
// in this browser (keyed by this page's id) so a reload can't double-submit —
// the row locks to a read-only "You said: X" state instead of live buttons.
var FB_STORE = 'ltb_fb_' + FB_PAGE;
function fbLoad() {
  try { return JSON.parse(localStorage.getItem(FB_STORE) || '{}') || {}; } catch (e) { return {}; }
}
function fbRemember(dish, label) {
  try {
    var cur = fbLoad();
    cur[dish] = label;
    localStorage.setItem(FB_STORE, JSON.stringify(cur));
  } catch (e) { /* storage off (private mode): in-memory fbSent still guards this session */ }
}
(function buildFb() {
  var wrap = document.getElementById('fbrows');
  var already = fbLoad();
  FB_DISHES.forEach(function(d) {
    var row = document.createElement('div'); row.className = 'fbrow';
    var nm = document.createElement('div'); nm.className = 'fbname'; nm.textContent = d;

    // Already submitted for this order (persisted): render a locked confirmation.
    if (already[d]) {
      fbSent[d] = true;
      var done = document.createElement('div'); done.className = 'fbdone';
      done.textContent = 'You said: ' + already[d] + ' \\u2713';
      done.setAttribute('data-fbdone', '1');
      row.appendChild(nm); row.appendChild(done); wrap.appendChild(row);
      return;
    }

    var btns = document.createElement('div'); btns.className = 'fbbtns';
    var noteWrap = document.createElement('div'); noteWrap.className = 'fbnotewrap'; noteWrap.style.display = 'none';
    var note = document.createElement('input'); note.type = 'text'; note.maxLength = 240; note.className = 'fbnote';
    note.placeholder = 'Tell Kevin why (optional)';
    var send = document.createElement('button'); send.className = 'fbsend'; send.textContent = 'Send';
    noteWrap.appendChild(note); noteWrap.appendChild(send);
    // The rescue line. A tap that says "this came out wrong" is the one moment
    // the customer is most receptive to being told how to fix it, and it turns
    // a complaint into a save. Shown BEFORE sending, so they read it while the
    // dish is still in front of them.
    var rescue = document.createElement('div'); rescue.className = 'fbrescue'; rescue.style.display = 'none';
    var picked = null;
    [['Perfect','good'],['A little off','meh'],['Had trouble','bad']].forEach(function(pair) {
      var b = document.createElement('button'); b.className = 'fbbtn ' + pair[1]; b.textContent = pair[0];
      b.onclick = function() {
        if (fbSent[d]) return;
        picked = pair;
        Array.prototype.forEach.call(btns.children, function(x) { x.classList.remove('sel'); });
        b.classList.add('sel');
        if (pair[1] !== 'good' && FB_RESCUE[d]) {
          rescue.textContent = FB_RESCUE[d];
          rescue.style.display = 'block';
        } else {
          rescue.style.display = 'none';
        }
        noteWrap.style.display = 'flex';
        note.focus();
      };
      btns.appendChild(b);
    });
    send.onclick = function() {
      if (fbSent[d] || !picked) return;
      fbSent[d] = true;
      var chosenLabel = picked[0];
      fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PAGE_ID, dish: d, verdict: picked[1], note: (note.value || '').trim() }) })
        .then(function(r) {
          var done = document.createElement('div'); done.className = 'fbdone';
          if (r.ok) {
            fbRemember(d, chosenLabel); // persist so a reload keeps it locked
            done.textContent = 'Noted: ' + chosenLabel + '. Thanks!';
            row.replaceChildren(nm, done);
          } else {
            fbSent[d] = false;
            done.textContent = 'That did not send. No worries.';
            row.replaceChildren(nm, done);
          }
        })
        .catch(function() { fbSent[d] = false; });
    };
    row.appendChild(nm); row.appendChild(btns); row.appendChild(rescue); row.appendChild(noteWrap); wrap.appendChild(row);
  });
})();
</script><script>
var PAGE_ID = "${esc(pageId)}";
var remaining = 5;
function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }
function setRemain(n) {
  remaining = n;
  var r = document.getElementById('remain');
  r.textContent = n > 0 ? (n + ' question' + (n === 1 ? '' : 's') + ' remaining') : 'No questions left on this page. Text Kevin for anything else.';
  if (n <= 0) { document.getElementById('q').disabled = true; document.getElementById('askbtn').disabled = true; }
}
function ask() {
  var input = document.getElementById('q');
  var btn = document.getElementById('askbtn');
  var q = (input.value || '').trim();
  if (!q || remaining <= 0) return;
  btn.disabled = true; input.disabled = true;
  var box = el('div', 'qa');
  box.appendChild(el('div', 'q', 'You: ' + q));
  var a = el('div', 'a', 'Thinking...');
  box.appendChild(a);
  document.getElementById('thread').appendChild(box);
  fetch('/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PAGE_ID, question: q }) })
    .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(res) {
      if (res.ok && res.j.answer) {
        a.textContent = res.j.answer;
        setRemain(typeof res.j.remaining === 'number' ? res.j.remaining : remaining - 1);
        input.value = '';
      } else if (res.j && res.j.error === 'limit') {
        a.className = 'err'; a.textContent = 'That was the last question for this page. Text Kevin for anything else.';
        setRemain(0);
      } else {
        a.className = 'err'; a.textContent = 'That did not go through. Give it another try, or just text Kevin.';
      }
    })
    .catch(function() { a.className = 'err'; a.textContent = 'That did not go through. Give it another try, or just text Kevin.'; })
    .finally(function() { if (remaining > 0) { btn.disabled = false; input.disabled = false; input.focus(); } });
}
document.getElementById('q').addEventListener('keydown', function(e) { if (e.key === 'Enter') ask(); });

// ── Did Kevin read it? ─────────────────────────────────────────────────────
// Somebody who took the trouble to say a dish came out wrong used to get
// silence back forever, because clearing the feedback erased every trace of
// it. The worker now leaves a read receipt behind and this closes the loop.
// Silent on failure: an unreachable worker must never put an error on a page
// whose whole job is to be calm while someone cooks.
(function fbSeen() {
  var rows = document.querySelectorAll('[data-fbdone]');
  if (!rows.length) return;
  try {
    fetch('/feedback/seen?id=' + encodeURIComponent(PAGE_ID))
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j || !j.seen) return;
        Array.prototype.forEach.call(rows, function(el) {
          var tag = document.createElement('span');
          tag.className = 'fbseen';
          tag.textContent = ' Kevin read this.';
          el.appendChild(tag);
        });
      })
      .catch(function() {});
  } catch (e) {}
})();

// ── Read a step aloud ──────────────────────────────────────────────────────
// The browser's own voice: no audio files, no network, no install. The person
// following these has wet hands and a hot pan, so the screen is the wrong
// place to be looking. iOS will not speak without a user gesture, hence a
// button rather than autoplay. Tapping again while it talks stops it, which
// is what everyone tries first.
(function speakSteps() {
  var btns = document.querySelectorAll('.speak');
  if (!('speechSynthesis' in window)) {
    Array.prototype.forEach.call(btns, function(b) { b.style.display = 'none'; });
    return;
  }
  Array.prototype.forEach.call(btns, function(btn) {
    btn.addEventListener('click', function() {
      if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); return; }
      var u = new SpeechSynthesisUtterance(btn.getAttribute('data-say') || '');
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    });
  });
})();
</script></body></html>`;
}
