/**
 * LTB Cloudflare Worker v4 — Custom Form Backend + AI Proxy + Push Notifications
 *
 * v4 (sync hardening):
 *   • Pending orders now stored ONE KV KEY PER ORDER ('pending:<id>') instead
 *     of a single array key. The old model did read-modify-write on one key:
 *     two overlapping submits (or a submit racing Kevin's "clear"), plus KV's
 *     eventual consistency, could silently DROP a customer order. Per-key
 *     writes cannot clobber each other; a clear deletes only the ids it was
 *     told to, so an order arriving mid-clear survives to the next poll.
 *   • MIGRATION: reads merge the legacy 'pending-orders' array (if present)
 *     with per-key entries; /pending/clear removes from both. Nothing writes
 *     the legacy key anymore, so it drains on the first clear and dies.
 *   • Idempotent submits: the form MAY send a clientId (8-64 url-safe chars);
 *     it becomes the storage key, so a double-tap / retry overwrites itself
 *     instead of duplicating. Absent (today's form), the worker generates an
 *     id — exactly the old behavior, zero regression for cached forms.
 *   • Queue cap (200 pending) so the open /submit endpoint can't be spammed
 *     into an unbounded queue. Real orders from friends never get near it.
 *   • API shapes unchanged: GET /pending → {pending:[...]}, clear → {ok,
 *     remaining}. Deploy order: app first, worker second — but this worker
 *     also serves the OLD app correctly, and the old worker serves the new
 *     app, so the order is about hygiene, not compatibility.
 *
 * v9 (backup ring):
 *   • RESTORED. The app has pushed snapshots to POST /backup every 15 minutes
 *     since July 6 2026. This worker never had the route, so every push 404'd
 *     into pushBackup()'s catch block for nine days without one visible symptom.
 *     tests/worker_sim.mjs scenario 6-9 had specified this the whole time and
 *     crashed on it; the crash was misread as a sandbox artifact. If you are
 *     about to paste over this file: THESE ROUTES ARE LOAD-BEARING. Diff first.
 *   • Ring is keyed 'backup:<ISO timestamp>', so KV's lexicographic key order
 *     is chronological order for free. Metadata carries size + order count so
 *     /backup/list never reads a payload.
 *   • Pruning is AGE-SHAPED, not newest-N. See pruneBackups().
 *
 * v10 (pipeline vote):
 *   • Public, unauthenticated vote on the "In the Works" dishes (pipeline.html).
 *     Deliberately trust-based: no identity, no dedupe, no cookie. Kevin's call.
 *     Friends-only audience; the ballot cap and the queue cap are the only guards.
 *   • ONE KV KEY PER BALLOT ('vote:<uuid>'), never a single running counter.
 *     A counter would be read-modify-write and would silently drop concurrent
 *     votes for exactly the reason the v4 note above describes. Tallying is a
 *     list on GET instead (picks ride in KV metadata, so no value body is read).
 *   • The write path is a single put() and does NOT list KV.
 *   • TWO bugs died here, both from writing against assumed KV behavior:
 *     (1) the write path listed KV with limit:2000; list() caps at 1000, so it
 *         threw and every POST 500'd.
 *     (2) the ballot was put() with an EMPTY value and picks in metadata only.
 *         KV rejects an empty value. Every POST 500'd. The value is now the
 *         ballot JSON; metadata is a tally-speed mirror, not the storage.
 *   • GET /votes returns ONLY the top VOTE_TOP_N (currently 10, was 5). The
 *     full ranking is never exposed. Zero-vote dishes never appear at all.
 *   • PIPELINE_DISHES is the whitelist. It MUST stay in sync with the dish
 *     names in pipeline.html or a vote for a real dish will 400.
 *
 * ACTIVE endpoints:
 *   GET  /config              — returns the current published week config
 *   POST /config              — app publishes a new week config (requires PUBLISH_TOKEN)
 *   POST /backup              — app pushes a data snapshot into the ring (requires PUBLISH_TOKEN)
 *   GET  /backup/list         — app lists the ring: timestamp + size + order count (token)
 *   GET  /backup?age=         — app restores the snapshot NEAREST an age target (token)
 *                               age ∈ recent | 1h | 1d | 3d — must match
 *                               resolveRestoreOptions() in src/App.jsx
 *   POST /submit              — customer form submits an order; queued as pending + push sent
 *   GET  /pending             — app fetches all queued submissions
 *   POST /pending/clear       — app marks submissions as handled (removes by id)
 *   POST /push/subscribe      — app registers its push subscription (requires PUBLISH_TOKEN)
 *   DELETE /push/subscribe    — app removes its push subscription (requires PUBLISH_TOKEN)
 *   POST /parse-order         — parses a free-text customer order via Claude
 *   POST /parse-amendment     — parses an amendment to an existing order via Claude
 *   POST /parse-notes         — parses free-text notes on an order via Claude
 *   POST /parse-receipt       — extracts line items from a store receipt photo via Claude
 *   GET  /votes               — public pipeline tallies (top 5 only) + total voters
 *   POST /votes               — public: cast up to 3 votes for pipeline dishes
 *   GET  /votes/full          — TOKEN: full ranking (incl. zero-vote) + last 50 ballots
 *   POST /requestable         — TOKEN: app publishes the requestable dish catalog
 *   POST /requests            — public: request a catalog dish back next week
 *   GET  /requests            — TOKEN: request counts + recent (live keys only)
 *
 * Requires a KV namespace bound as LTB_KV.
 *
 * Secrets (Cloudflare Worker Settings → Variables & Secrets):
 *   ANTHROPIC_API_KEY — your Anthropic API key (sk-ant-...)
 *   PUBLISH_TOKEN     — private token the app sends to authenticate (any random string)
 *   VAPID_PUBLIC_KEY  — VAPID public key (generate via steps in PUSH_SETUP.md)
 *   VAPID_PRIVATE_KEY — VAPID private key
 *   VAPID_SUBJECT     — mailto: or https: URL identifying you, e.g. mailto:you@example.com
 */

const ALLOWED_ORIGINS = [
  'https://ltb-app.strickland-kevinj.workers.dev',
];

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL  = 'claude-sonnet-4-6';

// ── KV keys ──────────────────────────────────────────────────────────────────
const KV_CONFIG       = 'week-config';
// Last few published configs, newest first. One small key, not one per
// publish: this is read and rewritten together, and it is capped, so the
// per-record discipline the pending/vote paths need does not apply here.
const KV_CONFIG_HIST  = 'config-history';
// Customer questions asked on kitchen pages. ONE rolling key, newest first,
// capped — the same shape as config-history and for the same reason: it is
// read and rewritten together and must stay bounded. These are the real
// confusions of real people at the moment of cooking, which is the one kind of
// teaching data a chef cannot generate from memory.
const KV_ASK_LOG      = 'ask-log';
const ASK_LOG_MAX     = 200;
const CONFIG_HIST_MAX = 5;

// ── Pipeline vote (v10) ────────────────────────────────────────────────────
// Whitelist of votable dishes. These strings MUST match the data-dish
// attributes in pipeline.html exactly. Cheesecake is deliberately absent: it
// is not pipeline. Removing a dish here retires it from voting; old ballots
// naming it are ignored at tally time, so no cleanup is needed.
const PIPELINE_DISHES = [
  // RETIRED Jul 17: Tea-Smoked Chicken won the vote and shipped to the real
  // menu. Removing it here stops it tallying and 400s any new vote naming it.
  // Ballots that picked it are NOT deleted — GET /votes ignores unknown dish
  // names at tally time, so those ballots simply carry one fewer pick. That is
  // the graceful path; do not "clean up" KV to match.
  //   'Tea-Smoked Chicken',
  'Suya Flank Steak',
  'Kabocha Char Siu',
  'Kare-Kare with XO',
  'Khoresh-e Gheimeh',
  'Fesenjan',
  'Sauerbraten Beef Cheeks',
  'Yogurt-Braised Lamb',
  'Nixtamal Grits',
  'Umeboshi Chicken',
  'Two-Garum Pasta',
  'Shrimp and Grits',
  'Collard Saag',
  'Pork Tenderloin Agrodolce',
  // Second pass, July 2026. Appended, never reordered: the existing keys are
  // load-bearing for votes already in KV. Renaming one orphans its ballots.
  'Octopus Soy-Dashi-Pimenton',
  'Three-Branch Caramel Pork',
  'Kufteh Tabrizi',
  'Garlic in Two Times Pork Chop',
  'Wok-Smoked Tri-Tip',
  'Pasta alla Genovese',
  'Wok-Smoked Dal Makhani',
  // Third pass, Jul 18. Appended, never reordered (existing keys are
  // load-bearing for votes already in KV). These keys are terse on purpose;
  // pipeline.html maps each to its full card title for the board via
  // DISPLAY_NAMES, so the key and the customer-facing label can differ safely.
  'Georgia Bomb Meatballs',
  'Smothered Turkey Yassa',
  'Quail Black Oil Celery Root',
  'Viet-Cajun Skillet Boil',
  'Wok-Smoked Flank White Sauce',
  'Hoja Santa Pork Tenderloin',
  'Charred Allium Trinity Pasta',
  'Lamb Leg Steak Black Lime Freekeh',
  'Mushroom Escabeche Polenta Cakes',
  'Blackened Hanger Steak Coconut Corn',
];
const VOTE_PREFIX      = 'vote:';
const VOTE_MAX_PICKS   = 3;    // per ballot, per Kevin: "up to 3"
// Was 5. Raised to 10 at Kevin's call once the board hit 21 dishes: at these
// vote counts a 2-vote cluster is real signal that a top-5 hides completely.
// The tradeoff he accepted: more visible losers. Still a hard ceiling — the
// full 21-dish ranking is never exposed.
const VOTE_TOP_N       = 10;   // public board shows this many, never more
// ── Dish requests (Jul 18) ──────────────────────────────────────────────────
// Customers ask for catalog dishes back next week. Same trust model as votes:
// public, anonymous, no dedupe, single-put write path (the v10 lesson — a
// pre-flight list in the write path is what 500'd every vote). One key per
// request, 14-day TTL so the signal stays fresh and cleanup is automatic.
// Validated against a whitelist the APP publishes (KV 'requestable-dishes'),
// not a second hand-kept list in this file.
const REQ_PREFIX       = 'req:';
const REQ_TTL          = 60 * 60 * 24 * 14;  // 14 days; requests are a freshness signal
const REQ_NOTE_MAX     = 200;                // note is stored, never rendered customer-facing
const REQUESTABLE_KEY  = 'requestable-dishes'; // JSON string[] the app writes on publish
const KV_PENDING      = 'pending-orders';    // LEGACY array key — read+cleared only, never written (drains, then dead)
const PENDING_PREFIX  = 'pending:';          // one key per order: 'pending:<id>'
const PENDING_CAP     = 200;                 // max queued submissions (spam bound on the open endpoint)
const KV_PUSH_SUB     = 'push-subscription'; // stores the app's push subscription object

// ── Backup ring ──────────────────────────────────────────────────────────────
const BACKUP_PREFIX    = 'backup:';           // one key per snapshot: 'backup:<ISO ts>'
const BACKUP_CAP       = 12;                  // max snapshots retained
const BACKUP_MAX_BYTES = 5 * 1024 * 1024;     // reject absurd payloads BEFORE any write
// The restore targets the app offers (resolveRestoreOptions() in src/App.jsx).
// The worker returns the snapshot NEAREST the target and reports its REAL
// timestamp, so "about 1 day ago" never lies about what actually exists.
// Adding a target here without adding it there (or vice versa) breaks restore.
const BACKUP_AGES = { recent: 0, '1h': 3600e3, '1d': 24 * 3600e3, '3d': 72 * 3600e3 };

// ── Legacy sheet (inactive) ───────────────────────────────────────────────────
const LEGACY_SHEET_ENABLED = false;
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYn0X7aAZ1xjr3pQpt0aR9lenIQDnxBtbqka7GA0wlYPZgfkZUZ4G_uYCnufRLxn29hEGi_CQdJf_n/pub?gid=1847554397&single=true&output=csv';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // ── GET /config ──────────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/config') {
        const cfg = await env.LTB_KV.get(KV_CONFIG);
        return json(cfg ? JSON.parse(cfg) : defaultConfig(), origin);
      }

      // ── POST /config ─────────────────────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/config') {
        const body = await request.json();
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        // Keep the outgoing config so a bad publish can be undone. Read first,
        // then write both keys; a failed history write must never block the
        // publish itself, so it is wrapped.
        try {
          const prevRaw = await env.LTB_KV.get(KV_CONFIG);
          if (prevRaw) {
            const histRaw = await env.LTB_KV.get(KV_CONFIG_HIST);
            const hist = histRaw ? JSON.parse(histRaw) : [];
            hist.unshift(JSON.parse(prevRaw));
            await env.LTB_KV.put(KV_CONFIG_HIST, JSON.stringify(hist.slice(0, CONFIG_HIST_MAX)));
          }
        } catch (e) { /* history is a convenience, never a gate on publishing */ }
        // Build from ONE declared field list (CONFIG_FIELDS, bottom of file)
        // and report anything the app sent that this worker does not know
        // about. See the note there for why the reporting matters.
        const config = { updatedAt: new Date().toISOString() };
        for (const key of Object.keys(CONFIG_FIELDS)) config[key] = CONFIG_FIELDS[key](body);
        const dropped = Object.keys(body).filter(k => k !== 'token' && !(k in CONFIG_FIELDS));
        await env.LTB_KV.put(KV_CONFIG, JSON.stringify(config));
        return json({ ok: true, config, dropped }, origin);
      }

      // ── GET /ask-log — the questions customers actually asked ──────────────
      // Token in the query string, same as /config-history (a GET has no body).
      if (request.method === 'GET' && url.pathname === '/ask-log') {
        if (url.searchParams.get('token') !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const raw = await env.LTB_KV.get(KV_ASK_LOG);
        return json({ questions: raw ? JSON.parse(raw) : [] }, origin);
      }

      // ── GET /config-history — metadata only, for the app's rollback list ────
      // Token rides the query string: a GET has no body to carry it.
      if (request.method === 'GET' && url.pathname === '/config-history') {
        if (url.searchParams.get('token') !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const raw = await env.LTB_KV.get(KV_CONFIG_HIST);
        const hist = raw ? JSON.parse(raw) : [];
        return json(hist.map((c, index) => ({
          index,
          weekLabel: c.weekLabel || '',
          updatedAt: c.updatedAt || '',
          dishCount: (c.dishes || []).length,
          paused: !!c.paused,
        })), origin);
      }

      // ── POST /config-restore — put an earlier publish back on the form ─────
      if (request.method === 'POST' && url.pathname === '/config-restore') {
        const body = await request.json();
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const raw = await env.LTB_KV.get(KV_CONFIG_HIST);
        const hist = raw ? JSON.parse(raw) : [];
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 0 || index >= hist.length) {
          return json({ error: 'No such publish in history' }, origin, 400);
        }
        const restored = { ...hist[index], updatedAt: new Date().toISOString() };
        const currentRaw = await env.LTB_KV.get(KV_CONFIG);
        const nextHist = hist.filter((_, i) => i !== index);
        if (currentRaw) nextHist.unshift(JSON.parse(currentRaw));
        await env.LTB_KV.put(KV_CONFIG, JSON.stringify(restored));
        await env.LTB_KV.put(KV_CONFIG_HIST, JSON.stringify(nextHist.slice(0, CONFIG_HIST_MAX)));
        return json({ ok: true, config: restored }, origin);
      }

      // ── POST /submit — queue order AND fire push notification ────────────────
      // One PUT to the order's OWN key. No read-modify-write, so a concurrent
      // submit or clear can never make this order disappear.
      if (request.method === 'POST' && url.pathname === '/submit') {
        const body = await request.json();
        // Optional idempotency key from the form: same clientId → same KV key
        // → a retry/double-tap overwrites itself instead of duplicating.
        const clientId = (typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientId))
          ? body.clientId : null;
        const submission = {
          id: clientId || ('sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
          customer: String(body.customer || '').slice(0, 120),
          address: String(body.address || '').slice(0, 300),
          phone: String(body.phone || '').slice(0, 40),
          items: Array.isArray(body.items) ? body.items.slice(0, 50) : [],
          notes: String(body.notes || '').slice(0, 1000),
          submittedAt: new Date().toISOString(),
        };
        if (!submission.customer || submission.items.length === 0) {
          return json({ error: 'Missing name or items' }, origin, 400);
        }

        // Spam bound: refuse when the queue is already absurd for a
        // friends-only shop. (list() is eventually consistent, so this is a
        // soft cap — that's fine, it only needs to bound abuse, not count.)
        const peek = await env.LTB_KV.list({ prefix: PENDING_PREFIX, limit: PENDING_CAP });
        if (peek.keys.length >= PENDING_CAP) {
          return json({ error: 'Order queue is full — please text Kevin directly.' }, origin, 429);
        }

        await env.LTB_KV.put(PENDING_PREFIX + submission.id, JSON.stringify(submission));

        // Fire push notification (non-blocking — don't let push failure break submit)
        ctx.waitUntil(sendPushNotification(env, submission));

        return json({ ok: true, id: submission.id }, origin);
      }

      // ── GET /pending ─────────────────────────────────────────────────────────
      // Contains customer PII (names, addresses, phones) — requires the token.
      // ── Kitchen companion pages (v6) ────────────────────────────────────
      // App pushes a rendered per-order HTML page; the customer opens a plain
      // unguessable link. Write requires the token; read is public by id.
      if (request.method === 'POST' && url.pathname === '/companion') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'unauthorized' }, origin, 401);
        }
        if (!body.id || typeof body.html !== 'string' || body.html.length === 0 || body.html.length > 200000) {
          return json({ error: 'bad companion payload' }, origin, 400);
        }
        await env.LTB_KV.put('companion:' + body.id, body.html, { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
        if (typeof body.context === 'string' && body.context.length <= 8000) {
          await env.LTB_KV.put('companionctx:' + body.id, body.context, { expirationTtl: 60 * 60 * 24 * 30 });
        }
        return json({ ok: true, id: body.id }, origin);
      }
      // ── Kitchen companion Q&A (v7) ──────────────────────────────────────
      // POST /ask { id, question }. The 5-question cap is enforced HERE, in
      // KV, because the page is a public URL and the client counter is
      // decoration — this is the wall between the internet and Kevin's API
      // budget. Answers are grounded ONLY in the stored order context and
      // hard-scoped by the system prompt: never guess allergens/ingredients,
      // defer anything uncertain to "text Kevin".
      if (request.method === 'POST' && url.pathname === '/ask') {
        const body = await request.json().catch(() => ({}));
        const id = typeof body.id === 'string' ? body.id.slice(0, 80) : '';
        const question = typeof body.question === 'string' ? body.question.trim().slice(0, 300) : '';
        if (!id || !question) return json({ error: 'bad request' }, origin, 400);
        // Page must exist (unguessable id doubles as the auth).
        const page = await env.LTB_KV.get('companion:' + id);
        if (!page) return json({ error: 'unknown page' }, origin, 404);
        // THE CAP: 5 per page, counted server-side.
        // Log it BEFORE the cap check so a question that gets refused is still
        // recorded: hitting the limit is itself a signal that a page left
        // someone with more questions than it answered.
        try {
          const rawLog = await env.LTB_KV.get(KV_ASK_LOG);
          const log = rawLog ? JSON.parse(rawLog) : [];
          log.unshift({ at: new Date().toISOString(), pageId: id, question: question });
          await env.LTB_KV.put(KV_ASK_LOG, JSON.stringify(log.slice(0, ASK_LOG_MAX)));
        } catch (e) { /* logging must never block an answer */ }
        const usedRaw = await env.LTB_KV.get('companionask:' + id);
        const used = usedRaw ? parseInt(usedRaw, 10) || 0 : 0;
        if (used >= 5) return json({ error: 'limit', remaining: 0 }, origin, 429);
        const ctx = (await env.LTB_KV.get('companionctx:' + id)) || 'No order context available.';
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, origin, 503);

        const system = [
          'You answer questions for a customer of Lettuce, Turnip, The Beet (LTB), a small meal-prep business run by Kevin, a professional chef.',
          "VOICE: write like Kevin talks — direct, casual, warm, a little funny, plain-spoken. Never use em-dashes. Never say 'genuinely'. No 'not only X but also Y' constructions. Use Oxford commas. No AI-speak filler.",
          "FOOD PHILOSOPHY: Kevin cares about ingredient integrity above convenience. When someone asks about freezing, storing, or reheating something, reason about whether that specific food SURVIVES the process with its texture and character intact, and say so honestly. Braises, stews, stocks, and stabilized sauces freeze beautifully. Potatoes turn grainy and wrecked in the freezer. High-moisture vegetables like peppers lose their bite. Cream emulsions break unless they were built to freeze. Rice and fresh pasta are cooked fresh for a reason. If the honest answer is 'you can, but it will not be as good', say that, and say why in one line. If you do not know how a specific dish was built, say so and point them to text Kevin rather than guessing.",
          'You may ONLY discuss: the items in their order below, the reheating/storage instructions provided, general reheating technique, and basic food-safety timing.',
          'HARD RULES:',
          '- NEVER guess or invent ingredients, allergens, or dietary suitability. If asked about allergies, ingredients, or dietary restrictions, always answer: that is a question for Kevin directly, please text him.',
          '- If the instructions provided conflict with general knowledge, the provided instructions win.',
          '- If you are not sure, or the question is outside their order and reheating, say so briefly and point them to text Kevin.',
          '- Garlic confit must stay frozen or refrigerated and used within 3 days. Never suggest storing it at room temperature.',
          '- Keep answers to 2-4 sentences, warm and plain-spoken. No markdown formatting.',
        ].join('\n');

        let answer = null;
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 300,
              system,
              messages: [{ role: 'user', content: 'CUSTOMER ORDER CONTEXT:\n' + ctx + '\n\nCUSTOMER QUESTION: ' + question }],
            }),
          });
          if (!resp.ok) throw new Error('api ' + resp.status);
          const data = await resp.json();
          answer = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        } catch (e) {
          return json({ error: 'answer failed' }, origin, 502);
        }
        if (!answer) return json({ error: 'answer failed' }, origin, 502);
        // Count AFTER a successful answer — a failed call should not burn a question.
        await env.LTB_KV.put('companionask:' + id, String(used + 1), { expirationTtl: 60 * 60 * 24 * 30 });
        return json({ answer, remaining: 5 - (used + 1) }, origin);
      }

      // ── Kitchen feedback loop (v8) ──────────────────────────────────────
      // Customers tap a per-dish verdict on their page; entries land in KV
      // capped at 20 per page (public endpoint = cap or it's a spam door).
      // Kevin's app pulls pending feedback (token) and persists it onto the
      // order record, then clears the consumed keys.
      if (request.method === 'POST' && url.pathname === '/feedback') {
        const body = await request.json().catch(() => ({}));
        const id = typeof body.id === 'string' ? body.id.slice(0, 80) : '';
        const dish = typeof body.dish === 'string' ? body.dish.slice(0, 80) : '';
        const verdict = ['good', 'meh', 'bad'].includes(body.verdict) ? body.verdict : '';
        const note = typeof body.note === 'string' ? body.note.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 240) : '';
        if (!id || !dish || !verdict) return json({ error: 'bad request' }, origin, 400);
        const page = await env.LTB_KV.get('companion:' + id);
        if (!page) return json({ error: 'unknown page' }, origin, 404);
        const key = 'companionfb:' + id;
        const raw = await env.LTB_KV.get(key);
        const list = raw ? JSON.parse(raw) : [];
        // Once-per-dish per order, device-independent: a resubmit for the same
        // dish REPLACES the prior entry (latest tap wins) instead of appending
        // a duplicate. Dedupe happens here in KV, so the app's triage queue
        // never sees two cards for one dish, from any device.
        const entry = { dish, verdict, ...(note ? { note } : {}), at: new Date().toISOString() };
        const existing = list.findIndex(e => e.dish === dish);
        if (existing >= 0) {
          list[existing] = entry;
        } else {
          if (list.length >= 20) return json({ error: 'limit' }, origin, 429);
          list.push(entry);
        }
        await env.LTB_KV.put(key, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 30 });
        return json({ ok: true }, origin);
      }
      if (request.method === 'GET' && url.pathname === '/feedback/pending') {
        if (url.searchParams.get('token') !== env.PUBLISH_TOKEN) return json({ error: 'unauthorized' }, origin, 401);
        const listing = await env.LTB_KV.list({ prefix: 'companionfb:' });
        const out = [];
        for (const k of listing.keys) {
          const raw = await env.LTB_KV.get(k.name);
          if (raw) out.push({ pageId: k.name.slice('companionfb:'.length), entries: JSON.parse(raw) });
        }
        return json({ feedback: out }, origin);
      }
      if (request.method === 'POST' && url.pathname === '/feedback/clear') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) return json({ error: 'unauthorized' }, origin, 401);
        const ids = Array.isArray(body.pageIds) ? body.pageIds.slice(0, 200) : [];
        for (const id of ids) {
          const clean = String(id).slice(0, 80);
          await env.LTB_KV.delete('companionfb:' + clean);
          // Leave a READ RECEIPT behind. Clearing used to erase every trace,
          // which meant a customer who took the trouble to say a dish came out
          // wrong got silence back forever. The receipt outlives the feedback
          // and is what closes that loop. TTL matches the companion page's own
          // 30-day life, so it cannot outlive the page it belongs to.
          await env.LTB_KV.put('companionfbread:' + clean, new Date().toISOString(),
            { expirationTtl: 30 * 24 * 60 * 60 });
        }
        return json({ ok: true, cleared: ids.length }, origin);
      }

      // ── GET /feedback/seen — did Kevin read it? ─────────────────────────
      // PUBLIC on purpose, like /ask: the unguessable page id is the auth, and
      // the only thing it discloses is whether feedback for that page has been
      // read. No token, because the customer's own page is the caller.
      if (request.method === 'GET' && url.pathname === '/feedback/seen') {
        const id = (url.searchParams.get('id') || '').slice(0, 80);
        if (!id) return json({ seen: false }, origin);
        const at = await env.LTB_KV.get('companionfbread:' + id);
        return json({ seen: !!at, at: at || null }, origin);
      }

      // ── Content studio (v8): dish storytelling in Kevin's voice ─────────
      // Token-gated (Kevin's app only). Grounded ONLY in the provided dish
      // facts; the voice rules mirror Kevin's actual style constraints.
      if (request.method === 'POST' && url.pathname === '/content') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) return json({ error: 'unauthorized' }, origin, 401);
        const dish = typeof body.dish === 'string' ? body.dish.slice(0, 120) : '';
        const angle = typeof body.angle === 'string' ? body.angle.slice(0, 60) : 'story';
        const facts = typeof body.facts === 'string' ? body.facts.slice(0, 6000) : '';
        if (!dish || !facts) return json({ error: 'bad request' }, origin, 400);
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, origin, 503);
        const system = [
          "You write short food content for Kevin, a former professional line cook and sushi chef who runs Lettuce, Turnip, The Beet, a small meal-prep business in Cedar Park, Texas.",
          "Voice rules, non-negotiable: direct, casual, humor-forward. NEVER use em-dashes. Never use the word 'genuinely'. No 'not only X but also Y' constructions. Use Oxford commas. No AI-speak filler, no 'elevate', no 'delve', no exclamation-point spam.",
          "Ground EVERYTHING in the dish facts provided. Never invent ingredients, techniques, or claims. If a fact is not provided, do not state it.",
          "Style model: science-forward food writing that explains WHY a technique works, like a chef talking to a curious friend.",
          "Output plain text only. No markdown, no headers, no hashtags unless the angle asks for a caption.",
        ].join('\n');
        const anglePrompt = {
          science: 'Write a 150-220 word food-science explainer about WHY the key technique in this dish works.',
          technique: 'Write a 150-220 word technique deep-dive a home cook could learn from.',
          story: 'Write a 120-180 word behind-the-dish story for the LTB newsletter.',
          caption: 'Write a 1-2 sentence Instagram caption plus a one-line follow-up. Warm, punchy, zero hashtag soup (2 hashtags max).',
        }[angle] || 'Write a 120-180 word behind-the-dish story.';
        let draft = null;
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6', max_tokens: 700, system,
              messages: [{ role: 'user', content: 'DISH: ' + dish + '\nFACTS:\n' + facts + '\n\nTASK: ' + anglePrompt }],
            }),
          });
          if (!resp.ok) throw new Error('api ' + resp.status);
          const data = await resp.json();
          draft = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        } catch (e) {
          return json({ error: 'draft failed' }, origin, 502);
        }
        if (!draft) return json({ error: 'draft failed' }, origin, 502);
        return json({ draft }, origin);
      }

      if (request.method === 'GET' && url.pathname === '/k') {
        const id = url.searchParams.get('id') || '';
        if (!id) {
          return new Response('No page id was given.', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        const html = await env.LTB_KV.get('companion:' + id);
        if (!html) {
          // KV's get() cannot distinguish "never written" from "expired" from
          // here (both return null), so the honest wording covers both rather
          // than guessing. What matters to the reader is the same either way:
          // ask for a fresh link.
          return new Response('This kitchen page is not available anymore. Ask for a new link.', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }

      if (request.method === 'GET' && url.pathname === '/pending') {
        const tok = request.headers.get('X-LTB-Token') || url.searchParams.get('token') || '';
        if (tok !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const pending = await readAllPending(env);
        return json({ pending }, origin);
      }

      // ── POST /pending/clear ───────────────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/pending/clear') {
        const body = await request.json();
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const ids = new Set(body.ids || []);
        // New model: delete exactly the named per-order keys. An order that
        // arrived after the app's last poll has a different key — untouched.
        await Promise.all([...ids].map(id => env.LTB_KV.delete(PENDING_PREFIX + id)));
        // Legacy array (pre-v4 leftovers): filter it too. Nothing writes this
        // key anymore, so this read-modify-write races nothing.
        let legacyRemaining = 0;
        const existing = await env.LTB_KV.get(KV_PENDING);
        if (existing) {
          const queue = JSON.parse(existing);
          const remaining = queue.filter(s => !ids.has(s.id));
          legacyRemaining = remaining.length;
          if (remaining.length) await env.LTB_KV.put(KV_PENDING, JSON.stringify(remaining));
          else await env.LTB_KV.delete(KV_PENDING);
        }
        const left = await env.LTB_KV.list({ prefix: PENDING_PREFIX, limit: 1000 });
        return json({ ok: true, remaining: legacyRemaining + left.keys.length }, origin);
      }

      // ── POST /push/subscribe — save the app's push subscription ─────────────
      if (request.method === 'POST' && url.pathname === '/push/subscribe') {
        const body = await request.json();
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        if (!body.subscription || !body.subscription.endpoint) {
          return json({ error: 'Invalid subscription object' }, origin, 400);
        }
        await env.LTB_KV.put(KV_PUSH_SUB, JSON.stringify(body.subscription));
        return json({ ok: true }, origin);
      }

      // ── DELETE /push/subscribe — remove push subscription ────────────────────
      if (request.method === 'DELETE' && url.pathname === '/push/subscribe') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        await env.LTB_KV.delete(KV_PUSH_SUB);
        return json({ ok: true }, origin);
      }

      // ── POST /backup — push a snapshot into the ring ─────────────────────────
      // Validate BEFORE writing. A bad push must never touch the ring; that is
      // the entire point of keeping one. The app fires this on open, every 15
      // minutes, and on visibilitychange→hidden, hash-deduped, so this endpoint
      // is hot and its failures are SILENT on the client by design.
      if (request.method === 'POST' && url.pathname === '/backup') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const snap = body.snapshot;
        if (!snap || typeof snap !== 'object') return json({ error: 'Missing snapshot' }, origin, 400);
        if (!snap.version) return json({ error: 'Snapshot has no version' }, origin, 400);
        if (!Array.isArray(snap.orders)) return json({ error: 'Snapshot has no orders array' }, origin, 400);

        const value = JSON.stringify(snap);
        if (value.length > BACKUP_MAX_BYTES) {
          return json({ error: 'Snapshot too large' }, origin, 413);
        }

        const timestamp = new Date().toISOString();
        await env.LTB_KV.put(BACKUP_PREFIX + timestamp, value, {
          metadata: { size: value.length, orders: snap.orders.length },
        });
        const kept = await pruneBackups(env);
        return json({ ok: true, timestamp, kept }, origin);
      }

      // ── GET /backup/list — the ring's index ──────────────────────────────────
      // Metadata only. Never reads a payload, so the modal opens instantly.
      if (request.method === 'GET' && url.pathname === '/backup/list') {
        const tok = request.headers.get('X-LTB-Token') || url.searchParams.get('token') || '';
        if (tok !== env.PUBLISH_TOKEN) return json({ error: 'Unauthorized' }, origin, 401);
        const ring = await readBackupRing(env);
        ring.sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // newest first
        return json({ ok: true, backups: ring }, origin);
      }

      // ── GET /backup?age=recent|1h|1d|3d — honest-nearest restore ─────────────
      if (request.method === 'GET' && url.pathname === '/backup') {
        const tok = request.headers.get('X-LTB-Token') || url.searchParams.get('token') || '';
        if (tok !== env.PUBLISH_TOKEN) return json({ error: 'Unauthorized' }, origin, 401);
        const age = url.searchParams.get('age') || 'recent';
        if (!Object.prototype.hasOwnProperty.call(BACKUP_AGES, age)) {
          return json({ error: 'Unknown age: ' + age }, origin, 400);
        }
        const ring = await readBackupRing(env);
        if (ring.length === 0) return json({ error: 'No backups stored yet.' }, origin, 404);
        const pick = nearestBackup(ring, BACKUP_AGES[age]);
        const raw = pick ? await env.LTB_KV.get(BACKUP_PREFIX + pick.timestamp) : null;
        if (!raw) return json({ error: 'That backup is no longer in the ring.' }, origin, 404);
        let snapshot;
        try {
          snapshot = JSON.parse(raw);
        } catch {
          return json({ error: 'That backup is unreadable. Nothing was changed.' }, origin, 500);
        }
        return json({ ok: true, timestamp: pick.timestamp, snapshot }, origin);
      }

      // ── AI proxy endpoints ────────────────────────────────────────────────────
      if (request.method === 'POST' && (
        url.pathname === '/parse-order' ||
        url.pathname === '/parse-amendment' ||
        url.pathname === '/parse-notes' ||
        url.pathname === '/parse-receipt'
      )) {
        return proxyToAnthropic(request, env, origin);
      }

      // ── Legacy sheet ──────────────────────────────────────────────────────────
      // ── GET /votes — public tally, TOP 5 ONLY ────────────────────────────
      // Tallies by listing ballots rather than reading a counter key. Costs a
      // list + N reads, which is nothing at this volume, and cannot lose a
      // concurrent write the way a counter would.
      if (request.method === 'GET' && url.pathname === '/votes') {
        const counts = {};
        for (const d of PIPELINE_DISHES) counts[d] = 0;
        let ballots = 0;
        let weightedBallots = 0;
        let cursor;
        do {
          // 1000 is KV's hard ceiling per list() call; the cursor loop below
          // handles anything beyond it.
          const listing = await env.LTB_KV.list({ prefix: VOTE_PREFIX, limit: 1000, cursor });
          for (const k of listing.keys) {
            // Picks ride in metadata so tallying never reads a value body.
            // The value carries the same list as the source of truth; if
            // metadata is ever missing, fall back to it rather than dropping
            // a real ballot on the floor.
            let picks = (k.metadata && Array.isArray(k.metadata.p)) ? k.metadata.p : null;
            let w = (k.metadata && Number(k.metadata.w)) || 0;
            if (!picks) {
              const raw = await env.LTB_KV.get(k.name);
              if (!raw) continue;
              try {
                const parsed = JSON.parse(raw);
                picks = parsed.p || [];
                if (!w) w = Number(parsed.w) || 1;
              } catch (e) { continue; }
            }
            if (!w) w = 1; // ballots cast before weighting existed still count once
            if (!picks.length) continue;
            ballots++;
            if (w > 1) weightedBallots++;
            for (const d of picks) {
              // A dish retired from PIPELINE_DISHES silently stops counting.
              if (Object.prototype.hasOwnProperty.call(counts, d)) counts[d] += w;
            }
          }
          cursor = listing.list_complete ? null : listing.cursor;
        } while (cursor);

        const top = Object.keys(counts)
          .map(d => ({ dish: d, votes: counts[d] }))
          .sort((a, b) => b.votes - a.votes || a.dish.localeCompare(b.dish))
          .slice(0, VOTE_TOP_N)
          .filter(r => r.votes > 0); // nothing shows until something is voted for

        return json({ top, ballots, weightedBallots }, origin);
      }

      // ── GET /votes/full — token-gated, FULL ranking + recent ballots ─────
      // Kevin's private view. Everything the public route hides: every
      // whitelist dish including zero-vote ones, and the last 50 ballots
      // newest-first so a vote-stuffing burst is visible (he caught a friend's
      // four-minute run by hand from the raw KV; this gives it to him properly).
      // Same list()+metadata tally as the public route — never a counter.
      if (request.method === 'GET' && url.pathname === '/votes/full') {
        const tok = request.headers.get('X-LTB-Token') || url.searchParams.get('token') || '';
        if (tok !== env.PUBLISH_TOKEN) return json({ error: 'Unauthorized' }, origin, 401);

        const counts = {};
        for (const d of PIPELINE_DISHES) counts[d] = 0;
        let ballots = 0;
        const recent = [];
        let cursor;
        do {
          const listing = await env.LTB_KV.list({ prefix: VOTE_PREFIX, limit: 1000, cursor });
          for (const k of listing.keys) {
            let picks = (k.metadata && Array.isArray(k.metadata.p)) ? k.metadata.p : null;
            let at = null;
            const raw = await env.LTB_KV.get(k.name);
            if (raw) {
              try { const parsed = JSON.parse(raw); if (!picks) picks = parsed.p || []; at = parsed.at || null; }
              catch (e) { if (!picks) continue; }
            }
            if (!picks || !picks.length) continue;
            ballots++;
            for (const d of picks) {
              if (Object.prototype.hasOwnProperty.call(counts, d)) counts[d]++;
            }
            recent.push({ at, picks });
          }
          cursor = listing.list_complete ? null : listing.cursor;
        } while (cursor);

        const ranking = Object.keys(counts)
          .map(d => ({ dish: d, votes: counts[d] }))
          .sort((a, b) => b.votes - a.votes || a.dish.localeCompare(b.dish));

        recent.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

        return json({ ranking, ballots, recent: recent.slice(0, 50) }, origin);
      }

      // ── POST /votes — cast a ballot of up to 3 ───────────────────────────
      // Open and unauthenticated on purpose. No identity, no dedupe: Kevin
      // trusts the list. Do NOT add a localStorage id here and call it one
      // vote per person; it would not be, and it would imply a guarantee the
      // endpoint cannot make.
      if (request.method === 'POST' && url.pathname === '/votes') {
        const body = await request.json().catch(() => ({}));
        const raw = Array.isArray(body.picks) ? body.picks : [];

        // Validate against the whitelist, dedupe within the ballot, then cap.
        const seen = {};
        const picks = [];
        for (const item of raw) {
          if (typeof item !== 'string') continue;
          if (!PIPELINE_DISHES.includes(item)) continue;
          if (seen[item]) continue;
          seen[item] = 1;
          picks.push(item);
          if (picks.length >= VOTE_MAX_PICKS) break;
        }
        if (!picks.length) return json({ error: 'bad request' }, origin, 400);

        // No pre-flight cap check here on purpose. It used to list the whole
        // namespace on every vote to enforce a ceiling this audience will never
        // reach: a KV read on every write, for nothing.
        //
        // The picks are the VALUE. They are also mirrored into metadata so
        // GET /votes can tally straight off list() without reading each body.
        // Do NOT "optimize" this back to an empty value with metadata-only:
        // KV rejects an empty value and every POST 500s. That was the bug.
        // Weight: people who actually order here get more say than a stranger
        // who found the page. Claimed by the client from its own order history
        // and CLAMPED to 1..3 — this is a friends-only shop, not an election,
        // and the worst case is a dish running a week earlier than it deserved.
        let weight = 1;
        const claimed = Number(body.orders);
        if (Number.isFinite(claimed) && claimed >= 1) weight = Math.min(3, 1 + Math.floor(claimed / 3));

        const ballot = JSON.stringify({ p: picks, w: weight, at: new Date().toISOString() });
        await env.LTB_KV.put(VOTE_PREFIX + crypto.randomUUID(), ballot, {
          metadata: { p: picks, w: weight },
        });
        return json({ ok: true, counted: picks.length, weight }, origin);
      }

      // ── POST /requestable — TOKEN: app publishes the requestable dish list ─
      // The full dinner catalog, written on every week publish. POST /requests
      // validates against this, so the worker never hand-keeps a dish list.
      if (request.method === 'POST' && url.pathname === '/requestable') {
        const body = await request.json().catch(() => ({}));
        if (!body.token || body.token !== env.PUBLISH_TOKEN) {
          return json({ error: 'Unauthorized' }, origin, 401);
        }
        const dishes = Array.isArray(body.dishes) ? body.dishes.filter(d => typeof d === 'string') : [];
        await env.LTB_KV.put(REQUESTABLE_KEY, JSON.stringify(dishes));
        return json({ ok: true, count: dishes.length }, origin);
      }

      // ── POST /requests — public, "want this dish back next week" ─────────
      // Trust model identical to votes: anonymous, no dedupe, single put(), no
      // pre-flight list. Validated against the app-published whitelist so the
      // worker never carries a second dish list to drift.
      if (request.method === 'POST' && url.pathname === '/requests') {
        const body = await request.json().catch(() => ({}));
        const dish = typeof body.dish === 'string' ? body.dish : '';
        if (!dish) return json({ error: 'bad request' }, origin, 400);

        let allowed = [];
        try {
          const raw = await env.LTB_KV.get(REQUESTABLE_KEY);
          if (raw) allowed = JSON.parse(raw);
        } catch (e) { allowed = []; }
        if (!Array.isArray(allowed) || !allowed.includes(dish)) {
          return json({ error: 'unknown dish' }, origin, 400);
        }

        const note = (typeof body.note === 'string' ? body.note : '').slice(0, REQ_NOTE_MAX);
        const rec = JSON.stringify({ d: dish, n: note, at: new Date().toISOString() });
        await env.LTB_KV.put(REQ_PREFIX + crypto.randomUUID(), rec, {
          metadata: { d: dish },
          expirationTtl: REQ_TTL,
        });
        return json({ ok: true }, origin);
      }

      // ── GET /requests — token-gated, counts + recent ─────────────────────
      // Counts only live (unexpired) keys — the TTL already dropped the dead
      // ones, so no windowing needed. Tally off metadata like votes.
      if (request.method === 'GET' && url.pathname === '/requests') {
        const tok = request.headers.get('X-LTB-Token') || url.searchParams.get('token') || '';
        if (tok !== env.PUBLISH_TOKEN) return json({ error: 'Unauthorized' }, origin, 401);

        const counts = {};
        const recent = [];
        let total = 0;
        let cursor;
        do {
          const listing = await env.LTB_KV.list({ prefix: REQ_PREFIX, limit: 1000, cursor });
          for (const k of listing.keys) {
            // Read the body (not just metadata) — this token-gated view is low
            // frequency and the note lives only in the value. counts still comes
            // off the dish either way. Note is Kevin-facing only, never rendered
            // to customers (it isn't returned by any public route).
            let dish = (k.metadata && k.metadata.d) || null;
            let at = null, note = '';
            const raw = await env.LTB_KV.get(k.name);
            if (raw) {
              try { const pp = JSON.parse(raw); dish = pp.d || dish; at = pp.at || null; note = pp.n || ''; }
              catch (e) { if (!dish) continue; }
            }
            if (!dish) continue;
            total++;
            counts[dish] = (counts[dish] || 0) + 1;
            recent.push({ at, dish, note });
          }
          cursor = listing.list_complete ? null : listing.cursor;
        } while (cursor);

        // Notes grouped by dish, so the Week tab can expand a dish's requests
        // and read the reasons. Empty notes dropped.
        const notesByDish = {};
        for (const r of recent) {
          if (!r.note) continue;
          (notesByDish[r.dish] = notesByDish[r.dish] || []).push({ at: r.at, note: r.note });
        }

        const out = Object.keys(counts)
          .map(d => ({ dish: d, requests: counts[d], notes: notesByDish[d] || [] }))
          .sort((a, b) => b.requests - a.requests || a.dish.localeCompare(b.dish));
        recent.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

        return json({ counts: out, total, recent: recent.slice(0, 50) }, origin);
      }

      if (request.method === 'GET' && url.pathname === '/sheet') {
        if (!LEGACY_SHEET_ENABLED) {
          return json({ error: 'Legacy sheet endpoint disabled' }, origin, 410);
        }
        const res = await fetch(SHEET_CSV_URL, { headers: { 'User-Agent': 'LTB-Order-Tracker/1.0' } });
        if (!res.ok) return new Response('Failed to fetch sheet: ' + res.status, { status: 502, headers: corsHeaders(origin) });
        const csv = await res.text();
        return new Response(csv, {
          status: 200,
          headers: { ...corsHeaders(origin), 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });

    } catch (err) {
      return json({ error: 'Worker error: ' + err.message }, origin, 500);
    }
  },
};

// ── Pending queue reader: per-key entries + legacy array, merged ──────────────
async function readAllPending(env) {
  // Per-order keys (paginate; list is eventually consistent — a brand-new
  // order can lag one poll cycle, but it can never be lost)
  const entries = [];
  let cursor = undefined;
  do {
    const page = await env.LTB_KV.list({ prefix: PENDING_PREFIX, limit: 1000, cursor });
    const values = await Promise.all(page.keys.map(k => env.LTB_KV.get(k.name)));
    for (const v of values) { if (v) { try { entries.push(JSON.parse(v)); } catch {} } }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // Legacy array key (pre-v4 queue contents, if any survive)
  const legacy = await env.LTB_KV.get(KV_PENDING);
  if (legacy) { try { entries.push(...JSON.parse(legacy)); } catch {} }

  // Dedup by id (an order could briefly appear in both during migration),
  // oldest first — same ordering the app has always shown.
  const byId = new Map();
  for (const s of entries) { if (s && s.id && !byId.has(s.id)) byId.set(s.id, s); }
  return [...byId.values()].sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
}

// ── Backup ring: read the INDEX, never the payloads ──────────────────────────
// One list() call returns every timestamp with its size and order count from
// KV metadata. Reading the ring properly would be 12 gets of up to 5MB each.
async function readBackupRing(env) {
  const out = [];
  let cursor = undefined;
  do {
    const page = await env.LTB_KV.list({ prefix: BACKUP_PREFIX, limit: 1000, cursor });
    for (const k of page.keys) {
      const md = k.metadata || {};
      out.push({
        timestamp: k.name.slice(BACKUP_PREFIX.length),
        size: Number(md.size) || 0,
        orders: Number(md.orders) || 0,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// Honest nearest: the snapshot closest to `targetMs` ago, whatever that is.
// The caller reports the REAL timestamp back to the app, so a "1 day" option
// that is actually 26 hours old says 26 hours. Never invent the age.
function nearestBackup(ring, targetMs) {
  const now = Date.now();
  let best = null, bestDiff = Infinity;
  for (const b of ring) {
    const t = Date.parse(b.timestamp);
    if (Number.isNaN(t)) continue;
    const diff = Math.abs((now - t) - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = b; }
  }
  return best;
}

// Bound the ring WITHOUT destroying the restore options the app offers.
// A naive "keep the newest 12" looks correct and is a trap: on a busy day the
// app pushes 12 snapshots in three hours, and the ~1d and ~3d snapshots get
// evicted. Kevin's three restore choices silently collapse into three flavors
// of "twenty minutes ago" — exactly when he needs to go further back. So:
// protect the nearest snapshot to EVERY age target first, then fill whatever
// slots remain with the newest.
async function pruneBackups(env) {
  const ring = await readBackupRing(env);
  if (ring.length <= BACKUP_CAP) return ring.length;

  const keep = new Set();
  for (const targetMs of Object.values(BACKUP_AGES)) {
    const pick = nearestBackup(ring, targetMs);
    if (pick) keep.add(pick.timestamp);
  }

  const newestFirst = [...ring].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const b of newestFirst) {
    if (keep.size >= BACKUP_CAP) break;
    keep.add(b.timestamp);
  }

  await Promise.all(
    ring.filter(b => !keep.has(b.timestamp))
      .map(b => env.LTB_KV.delete(BACKUP_PREFIX + b.timestamp)),
  );
  return keep.size;
}

// ── Push notification sender ──────────────────────────────────────────────────
async function sendPushNotification(env, submission) {
  try {
    const stored = await env.LTB_KV.get(KV_PUSH_SUB);
    if (!stored) return;

    const subscription = JSON.parse(stored);
    const itemCount = (submission.items || []).reduce((s, it) => s + (it.qty || 1), 0);
    const payload = JSON.stringify({
      title: `New order from ${submission.customer}`,
      body: `${itemCount} item${itemCount !== 1 ? 's' : ''}${submission.notes ? ' · ' + submission.notes.slice(0, 60) : ''}`,
    });

    const { body, salt, serverPublicKey } = await encryptPayload(payload, subscription);
    const vapidAuth = await buildVapidAuth(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT, subscription.endpoint);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': vapidAuth,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Push endpoint returned', res.status, text);
    }
  } catch (e) {
    console.error('Push notification failed:', e.message, e.stack);
  }
}

// ── VAPID auth header (RFC 8292) ──────────────────────────────────────────────
async function buildVapidAuth(publicKeyB64, privateKeyB64, subject, endpoint) {
  const audienceUrl = new URL(endpoint);
  const audience = `${audienceUrl.protocol}//${audienceUrl.host}`;
  const now = Math.floor(Date.now() / 1000);

  const jwtHeader = strToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jwtClaims = strToB64url(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject }));
  const sigInput = `${jwtHeader}.${jwtClaims}`;

  const pubKeyBytes = b64ToBytes(publicKeyB64);
  const x = bytesToB64url(pubKeyBytes.slice(1, 33));
  const y = bytesToB64url(pubKeyBytes.slice(33, 65));

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d: privateKeyB64, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(sigInput),
  );

  const jwt = `${sigInput}.${bytesToB64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

// ── Web Push payload encryption (RFC 8291 / aes128gcm) ───────────────────────
async function encryptPayload(plaintext, subscription) {
  const encoder = new TextEncoder();
  const keys = subscription.keys || {};

  const p256dh = b64ToBytes(keys.p256dh);
  const auth = b64ToBytes(keys.auth);

  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));

  const clientPublicKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256,
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const prkInfo = concat(encoder.encode('WebPush: info\x00'), p256dh, serverPublicKeyRaw);
  const sharedSecretKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const prk = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: auth, info: prkInfo },
    sharedSecretKey, 256,
  ));

  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);

  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: aes128gcm\x00') },
    prkKey, 128,
  );

  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: nonce\x00') },
    prkKey, 96,
  );

  const aesKey = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const payloadBytes = encoder.encode(plaintext);
  const paddedPayload = new Uint8Array(payloadBytes.length + 1);
  paddedPayload.set(payloadBytes);
  paddedPayload[payloadBytes.length] = 0x02;

  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits },
    aesKey,
    paddedPayload,
  ));

  const header = new Uint8Array(16 + 4 + 1 + serverPublicKeyRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublicKeyRaw.length;
  header.set(serverPublicKeyRaw, 21);

  const body = concat(header, encrypted);
  return { body, salt, serverPublicKey: serverPublicKeyRaw };
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

function strToB64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// ── The published config's field list ───────────────────────────────────────
// The customer pages read this object straight off KV, so the whitelist is
// deliberate: nothing unvetted should reach them, and every value is coerced
// to a known shape and bounded length here rather than trusted.
//
// WHAT WAS NOT DELIBERATE was dropping unknown fields SILENTLY. That has now
// bitten three times: `paused` was thrown away while the app and both customer
// pages fully supported taking a week off; and when this list was rewritten,
// BOTH `notice` (the Week tab's heads-up banner) and `oneBottle` (the "one
// bottle for the week" card on menu.html) were being discarded the same way —
// fully built on the app side, fully rendered on the page side, quietly
// deleted in transit here.
//
// Two changes stop it recurring:
//   1. This list is the single source of truth, and defaultConfig() is derived
//      FROM it, so a GET before the first publish returns the same SHAPE as one
//      after. No more "undefined before publish, empty string after".
//   2. POST /config returns a `dropped` array naming anything the app sent that
//      is not listed here. Adding a field to the app without adding it here now
//      announces itself on the very first publish instead of months later.
// ADDING A FIELD: add one line here. That is the whole change.
const CONFIG_FIELDS = {
  dishes:     b => (Array.isArray(b.dishes) ? b.dishes : []),
  spotlight:  b => (Array.isArray(b.spotlight) ? b.spotlight : []),
  fruit:      b => (Array.isArray(b.fruit) ? b.fruit : []),
  desserts:   b => (Array.isArray(b.desserts) ? b.desserts : []),
  addons:     b => (Array.isArray(b.addons) ? b.addons : []),
  bag:        b => (Array.isArray(b.bag) ? b.bag : []),
  sauces:     b => (Array.isArray(b.sauces) ? b.sauces : []),
  menuPdfUrl: b => String(b.menuPdfUrl || ''),
  weekLabel:  b => String(b.weekLabel || ''),
  paused:     b => !!b.paused,
  pausedMsg:  b => String(b.pausedMsg || '').slice(0, 200),
  // The Week tab's heads-up banner. ALWAYS written, even empty: an unchecked
  // box publishes '' and that empty value is what CLEARS a live banner. If this
  // were written only when truthy, last week's message would outlive its week.
  notice:     b => String(b.notice || '').slice(0, 280),
  // One bottle for the week, stamped at publish from the registry's pairing
  // data. Absent publishes as null, which menu.html already treats as "none".
  oneBottle:  b => ((b.oneBottle && typeof b.oneBottle === 'object') ? b.oneBottle : null),
};

function defaultConfig() {
  const out = { updatedAt: null };
  for (const key of Object.keys(CONFIG_FIELDS)) out[key] = CONFIG_FIELDS[key]({});
  return out;
}

async function proxyToAnthropic(request, env, origin) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('ANTHROPIC_API_KEY secret not set in Worker', { status: 500, headers: corsHeaders(origin) });
  }
  try {
    const body = await request.text();
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response('Anthropic proxy error: ' + err.message, { status: 500, headers: corsHeaders(origin) });
  }
}

function json(obj, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-LTB-Token',
  };
}
