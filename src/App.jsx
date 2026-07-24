import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Plus, Trash2, Check, ChevronDown, ChevronUp, X, Pencil, Copy, RotateCcw,
  ClipboardPaste, ArrowUpDown, Archive, ImageIcon, AlertTriangle, FileText,
  Scale, Camera, Download, Upload, Flame, Bell,
} from './icons.jsx';
import {
  ALL_DINNERS, ALWAYS_MENU, DEFAULT_WEEK, PER_LB_ITEMS, FULL_MENU,
  isPerLbItem, buildMenu, CATEGORY_LABELS, STATUSES, STATUS_COLORS,
} from './menu.js';
import {
  RECIPES, INGREDIENT_SYNONYMS, SOUS_VIDE_VEG, DINNER_REHEAT_BUCKET,
  RICE_DISHES, PASTA_DISHES, NOODLE_DISHES,
  normalizeIngredientName, generateShoppingItems, buildAutoShoppingRows, buildReheatBlocks,
} from './recipes.js';
import {
  SURCHARGE, WORKER_BASE, PENDING_POLL_URL, CONFIG_PUBLISH_URL,
  PUBLISH_TOKEN, VAPID_PUBLIC_KEY, USE_LEGACY_CSV, FORM_CSV_URL,
  ORDERS_KEY, CHECKS_KEY, DELIVER_CHECKS_KEY, DISH_NOTES_KEY, PIPELINE_JOURNAL_KEY, WEEK_NOTES_KEY,
  JOURNAL_KEY, CONTAINER_INVENTORY_KEY, WEEK_LEDGER_KEY, COPIES_NOTE_KEY, SW_VERSION_KEY,
  SHOPPING_KEY, WEEK_KEY, PENDING_KEY, SEEN_ROWS_KEY, REGULARS_KEY, INVENTORY_KEY, FEEDBACK_KEY,
  BACKUP_STATE_KEY, BACKUP_STALE_MS, AUDIT_LOG_KEY, MENU_FINGERPRINT_KEY,
} from './config.js';
const INGREDIENTS_KEY = 'ltb_ingredients_v1';
const COST_HISTORY_KEY = 'ltb_cost_history_v1';
// T2: the last business-week stamp this device has SEEN (not the same as
// SCHEMA_VERSION or any other guard — just a rollover flag). One key, one
// banner, per the plan.
const LAST_SEEN_WEEK_KEY = 'ltb-last-seen-week';
const RECEIPT_ALIASES_KEY = 'ltb_receipt_aliases_v1';
// Worker pending ids Kevin has already accepted or rejected. The worker is the
// durable order queue; this ledger stops a re-poll from resurrecting an order
// he already handled if the worker's own delete didn't land.
const HANDLED_PENDING_KEY = 'ltb_handled_pending_v1';
import {
  uid, currency, round2, DISH_CUISINE, dishCuisine, normName,
  MIN_ORDERS_FOR_INSIGHT, localStore, store, PHOTO_PREFIX, PHOTO_TTL_DAYS, fmtBytes,
  urlBase64ToUint8Array, onStorageFull, storageFootprint, nameMatchType, regularNames, regularDisplayName,
  regularMatchType, buildInsights, insightStamp, loadHtml2Canvas,
  discountAmount, itemsUpchargeTotal, customChargesTotal, itemsBaseTotal,
  orderTotal, repricePerLbItem, itemCost, orderCostInfo, stampItemCosts, normalizePendingItems,
  optionsSummary, noteWithoutOptions, normalizeAddons, itemAddons, applyFeedbackSave, resetDishFeedback,
  groupKeyFor, formatDate, orderToText, copyText, loadJSON, saveJSON, saveError,
  photoKey, savePhoto, loadPhoto, deletePhoto, photoStorageBytes, cleanupPhotos,
  menuForPrompt, fileToJpegBase64, parseOrderText, validateParsedOrder, parseAmendment,
  parseFormRow, parseDelimited, rowToOrderText, parseFormNotes,
  mergeRegulars, unmergeRegular, backfillRegularLinks, regularAllNames,
  houseOrderPatch, isHouseOrder, HOUSE_DISCOUNT_PERCENT,
} from './utils.js';
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY, assessForwardCompat, migrateForward, REFUSE_MESSAGE } from './migrations.js';
import { emptyJournal, normalizeJournal, migrateDishNotes, purgeTombstones } from './journal.js';
import { recordWeek, normalizeLedger } from './weekLedger.js';
import { useWakeLock } from './useWakeLock.js';
import { usePreserveScroll } from './usePreserveScroll.js';
import { currentWeekInfo, msUntilDeadline, formatCountdown, intakeVsMedian, weekRolledOver } from './timeBanners.js';
import { sortList, filterByStatus, searchList, orderHaystacks, windowList, DEFAULT_WINDOW } from './listControls.js';
import { containerReport, normalizeContainerConfig } from './containers.js';
import { extractNotice } from './weekNotice.js';
import {
  SOURCES, appendAudit, auditEntry, diffIngredientCosts,
  menuFingerprint, diffMenuFingerprint, diffAliases, diffReconcile,
} from './auditLog.js';
import { reconcileIngredients, pruneCostHistory, summarizeReconcile } from './seedReconcile.js';
import { TEAL_DARK, TEAL_MID, TEAL_LIGHT, GOLD, CREAM, DARK, CARD, styles } from './styles.js';

import { ImportModal } from './components/ImportModal.jsx';
import { LinkRegularPrompt, RegularsTab, RegularForm, RegularProfile } from './components/RegularsTab.jsx';
import { WeekTab } from './components/WeekTab.jsx';
import { StatsBar, QtyControl, PasteOrderCard, AmendOrderCard, CsvImportCard, ReviewModal } from './components/OrderInputs.jsx';
import { OrderForm } from './components/OrderForm.jsx';
import { InvoiceModal, ReheatModal, WeightPhotoModal } from './components/Modals.jsx';
import { OrderCard } from './components/OrderCard.jsx';
import { ArchiveDeliveredButton, CookingList, DeliverList } from './components/CookTabs.jsx';
import { ShoppingList } from './components/ShoppingList.jsx';
import { MoneyTab } from './components/MoneyTab.jsx';
import { undecidedOmakases, omakaseStats, omakasePriceUnsettled } from './omakase.js';
import { weekOneBottle } from './weekPlanner.js';
import { customerFavorites } from './favorites.js';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { RecipesTab } from './components/RecipesTab.jsx';
import { RecordTab } from './components/RecordTab.jsx';
import { reportableDishes } from './dishReport.js';
import { buildCookList } from './cookList.js';
import { FeedbackCard } from './components/FeedbackCard.jsx';
import { PlannerPanel } from './components/PlannerPanel.jsx';
import { RegularsIntelPanel } from './components/RegularsIntelPanel.jsx';
import { LabelsSheet } from './components/LabelsSheet.jsx';
import { DigestPanel } from './components/DigestPanel.jsx';
import { SchedulePanel } from './components/SchedulePanel.jsx';
import { IngredientsTab } from './components/IngredientsTab.jsx';
import { ReceiptScan } from './components/ReceiptScan.jsx';
import { INGREDIENT_SEED } from './ingredients.js';
import { baselineCostMap, liveCostMapFrom } from './dishCosting.js';

export default function LTBOrderTracker() {
  React.useEffect(() => {
    if (!document.getElementById('ltb-spin-style')) {
      const s = document.createElement('style');
      s.id = 'ltb-spin-style';
      s.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
      document.head.appendChild(s);
    }
  }, []);

  const [notifPerm, setNotifPerm] = React.useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );

  // The service worker does two jobs: it receives push, and it tells us when a
  // new build landed. The second one matters even without push configured, so
  // registration is no longer gated on VAPID.
  const [swUpdate, setSwUpdate] = useState(null);
  React.useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(e => {
      console.warn('SW registration failed:', e.message);
    });
    const onMsg = (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'sw-updated' || !d.version) return;
      // Silent on first install: there is nothing to reload INTO yet.
      loadJSON(SW_VERSION_KEY, null).then(seen => {
        saveJSON(SW_VERSION_KEY, d.version);
        if (seen && seen !== d.version) setSwUpdate(d.version);
      });
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  // Storage: a hard stop when writes start failing, and a soft warning while
  // there is still room to act. 4MB of a ~5MB budget is the warning line.
  const [storageFull, setStorageFull] = useState(false);
  const [storageBytes, setStorageBytes] = useState(0);
  React.useEffect(() => {
    onStorageFull(() => setStorageFull(true));
    const check = () => setStorageBytes(storageFootprint());
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);

  const enablePushNotifications = async () => {
    if (!VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const permission = await Notification.requestPermission();
      setNotifPerm(permission);
      if (permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await fetch(WORKER_BASE + '/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: PUBLISH_TOKEN, subscription: sub.toJSON() }),
      });
    } catch (e) {
      console.warn('Push setup failed:', e.message);
    }
  };

  const [orders, setOrders] = useState(null);
  const [cookChecks, setCookChecks] = useState({});
  const [deliverChecks, setDeliverChecks] = useState({});
  const [cookSubView, setCookSubView] = useState('cook');
  // The knowledge journal (K1–K8). Replaced dishNotes (schema v2): a flat
  // { dish: text } map had one undated slot per dish, and the whole point of
  // the record is dated, typed, accumulating entries.
  const [journal, setJournal] = useState(emptyJournal());
  // Customer questions pulled from the worker. Not persisted: the worker holds
  // the rolling log, so this is a view of it, not a second copy to drift.
  const [askLog, setAskLog] = useState([]);
  const [weekLedger, setWeekLedger] = useState(() => normalizeLedger(null));
  // Where the archive copies live. Prints INTO the archive, so it is readable
  // by someone who does not have Kevin to ask.
  const [copiesNote, setCopiesNote] = useState('');
  const saveCopiesNote = useCallback((text) => {
    const v = String(text || '').slice(0, 600);
    setCopiesNote(v);
    saveJSON(COPIES_NOTE_KEY, v).then(r => setError(saveError(r)));
  }, []);
  // M1: owned container counts + meal-pool adjustment (containers.js).
  const [containerConfig, setContainerConfig] = useState(() => normalizeContainerConfig(null));
  // Pipeline test-kitchen journal: { version, entries: { key: { journal:[], status, promoteChecklist } } }
  // Rides the backup ring (below) — day-three verdicts are the whole point of
  // the feature and a device wipe must not lose them.
  const [pipelineJournal, setPipelineJournal] = useState({ version: 1, entries: {} });
  // Per-dish feedback store (persistent) + incoming triage queue (transient).
  // Feedback is dish-linked only — never attached to orders. Queue entries
  // keep their worker pageId; a pageId is cleared from KV only once ALL its
  // entries are triaged, so closing the app mid-triage loses nothing.
  const [dishFeedback, setDishFeedback] = useState({});
  const [pendingFeedback, setPendingFeedback] = useState([]);
  const [shopping, setShopping] = useState([]);
  const [booted, setBooted] = useState(false);
  const [includeStaples, setIncludeStaples] = useState(() => localStore.get('ltb_staples_pref') === '1');
  const [weekDishes, setWeekDishes] = useState(DEFAULT_WEEK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('orders');
  // P1: the screen sleeping mid-cook, by Kevin's own account probably the
  // single most annoying daily thing in the app. Held on cook and shop only
  // — the two tabs a phone sits propped up for while hands are busy.
  useWakeLock(view === 'cook' || view === 'shop');

  // T1: a minute-granularity clock for the deadline countdown. A full
  // re-render every 60s is negligible and keeps "3h 12m" honest without any
  // per-second churn a phone battery would notice.
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [clockTick]);

  // T2: the business-week rollover flag. Dismissed by TAP, not silently and
  // not by a timer — same rule already applied to `notice` below: an
  // informational banner should not vanish before Kevin has read it.
  const [lastSeenWeek, setLastSeenWeek] = useState(null);
  const markWeekSeen = useCallback((stamp) => {
    setLastSeenWeek(stamp);
    saveJSON(LAST_SEEN_WEEK_KEY, stamp);
  }, []);
  const [showLabels, setShowLabels] = useState(false); // bag-labels print sheet
  const [formMode, setFormMode] = useState(null);
  const [showPaste, setShowPaste] = useState(false);
  const [showAmend, setShowAmend] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [pendingOrders, setPendingOrders] = useState([]);
  // Ledger of worker pending ids already accepted/rejected (see HANDLED_PENDING_KEY).
  const handledPendingRef = useRef({});
  const [ingredientsDb, setIngredientsDb] = useState([]);
  const [costHistory, setCostHistory] = useState([]); // [{ t, id, cost }] lightweight time-series
  const [receiptAliases, setReceiptAliases] = useState({}); // normReceiptStr -> { ingredientId?, action?, pricing? }
  const [auditLog, setAuditLog] = useState([]);

  // ── Audit trail (v9.23) ───────────────────────────────────────────────────
  // Declared HERE, immediately after its state, and NOT further down: every
  // consumer below (publishWeek, updateIngredients, commitReceiptCosts,
  // saveReceiptAliases) names it in a dep array, and a dep array is
  // evaluated during render. Declared late, those arrays hit the temporal
  // dead zone and the whole app dies at boot with 'can't access lexical
  // declaration recordAudit before initialization'. Keep it above line ~576.
  // ONE writer, so every money-affecting path bounds and persists identically.
  // Append-only: a correction is a new entry, never an edit to an old one.
  const recordAudit = useCallback((entries) => {
    if (!entries || !entries.length) return;
    setAuditLog(prev => {
      const next = appendAudit(prev, entries);
      saveJSON(AUDIT_LOG_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  // Boot notice. Distinct from `error` (which renders as a "tap to retry
  // saving" button, the wrong affordance for good news) and from `exportMsg`
  // (which self-clears in 2.5s — too fast for a message about money moving).
  // Dismissed by tap, not by timer: a silent cost rewrite is exactly the
  // failure mode this whole task exists to end, so the telling can't expire
  // before Kevin has read it.
  const [notice, setNotice] = useState(null);
  const [showReceiptScan, setShowReceiptScan] = useState(false);
  const [debugScan, setDebugScan] = useState(false);
  const [showPendingIdx, setShowPendingIdx] = useState(null);
  const [checkingForm, setCheckingForm] = useState(false);
  const [parsedNotes, setParsedNotes] = useState({});
  const [parsingNotes, setParsingNotes] = useState(null);
  const [regulars, setRegulars] = useState([]);
  const [inventory, setInventory] = useState({});
  const [linkPrompt, setLinkPrompt] = useState(null);
  const [expandedOrder, setExpandedOrder] = useState(null);
  // V1/V2/V3: orders-list sort, status filter, search, and per-section
  // windowing. One shared helper (listControls.js) behind all three; the
  // list itself stays exactly as fast at 300 orders as it is at 30.
  const [orderSort, setOrderSort] = useState('newest');
  const [orderStatusFilter, setOrderStatusFilter] = useState(null);
  const [orderSearch, setOrderSearch] = useState('');
  const [showAllActive, setShowAllActive] = useState(false);
  const [showAllDelivered, setShowAllDelivered] = useState(false);
  // V4: bulk actions. selectMode is off by default so the list looks and
  // behaves exactly as it always has until Kevin asks for it — the
  // checkboxes are not in the way of the normal one-order-at-a-time flow.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    let mounted = true;
    (async () => {
      // ── Schema forward-compat guard (v9.22) ─────────────────────────────
      // Checked BEFORE anything else loads. If this device's stored schema
      // version is NEWER than the code currently running here, that means
      // this device backed up on a later version and is now running older
      // code — the exact "old code, new data" case. Refuse to touch local
      // state rather than silently downgrading it. An unstamped device
      // (storedVersion undefined) is pre-versioning data, not a threat, and
      // reads as v0 — always safe to proceed and stamp forward.
      const storedVersion = await loadJSON(SCHEMA_VERSION_KEY, undefined);
      const compat = assessForwardCompat(storedVersion);
      if (compat.outcome === 'refuse') {
        if (mounted) {
          setLoading(false);
          setError(REFUSE_MESSAGE);
        }
        return;
      }
      if (compat.outcome !== 'current') {
        // Older or unstamped — this device is behind, which is always safe
        // to bring forward. Stamp now so a crash mid-load doesn't leave the
        // device perpetually re-detecting as "needs migration."
        await saveJSON(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
      }

      const [loadedOrders, loadedChecks, loadedShopping, loadedWeek, loadedDeliverChecks, loadedDishNotes, loadedDishFeedback, loadedPipelineJournal, loadedJournal, loadedLastSeenWeek, loadedContainerCfg, loadedLedger, loadedCopiesNote] = await Promise.all([
        loadJSON(ORDERS_KEY, []),
        loadJSON(CHECKS_KEY, {}),
        loadJSON(SHOPPING_KEY, []),
        loadJSON(WEEK_KEY, null),
        loadJSON(DELIVER_CHECKS_KEY, {}),
        loadJSON(DISH_NOTES_KEY, {}),
        loadJSON(FEEDBACK_KEY, {}),
        loadJSON(PIPELINE_JOURNAL_KEY, { version: 1, entries: {} }),
        loadJSON(JOURNAL_KEY, null),
        loadJSON(LAST_SEEN_WEEK_KEY, null),
        loadJSON(CONTAINER_INVENTORY_KEY, null),
        loadJSON(WEEK_LEDGER_KEY, null),
        loadJSON(COPIES_NOTE_KEY, ''),
      ]);
      if (!mounted) return;
      const migrated = loadedOrders.map(o => ({
        ...o,
        // Cost-basis migration: items stamped at creation keep their frozen
        // cost (tagged 'snapshot'); items predating stamping get today's
        // registry anchor, honestly tagged 'backfilled'. Idempotent.
        items: stampItemCosts((o.items || []).map(it => {
          const clean = { ...it };
          if (clean.upcharge != null && typeof clean.upcharge !== 'object') {
            delete clean.upcharge;
          }
          if ('lbs' in clean) delete clean.lbs;
          return clean;
        }), 'backfilled'),
        paid: o.paid === undefined ? o.status === 'Delivered' : o.paid,
        archived: o.archived || false,
        discountType: o.discountType || null,
        discountValue: o.discountValue || 0,
        customCharges: o.customCharges || [],
        jarSwaps: o.jarSwaps || 0,
        containerReturns: o.containerReturns || 0,
        waiveSurcharge: o.waiveSurcharge || false,
        total: Number(o.total) || 0,
      }));
      setOrders(migrated);
      setCookChecks(loadedChecks || {});
      setDeliverChecks(loadedDeliverChecks || {});
      // Journal hydrate + the one-way dishNotes migration (schema v2).
      // Each legacy note becomes a technique entry marked migrated+undated —
      // its real date is unknown and is never invented. Idempotent by
      // content, and the old key is emptied after the fold so a second boot
      // is a no-op. The key itself stays in config.js so THIS read works.
      let bootJournal = normalizeJournal(loadedJournal);
      if (loadedDishNotes && Object.keys(loadedDishNotes).some(k => String(loadedDishNotes[k] || '').trim())) {
        bootJournal = migrateDishNotes(bootJournal, loadedDishNotes);
        await saveJSON(JOURNAL_KEY, bootJournal);
        await saveJSON(DISH_NOTES_KEY, {});
      }
      // Drop journal entries whose 30-day undo window has closed.
      bootJournal = purgeTombstones(bootJournal);
      setJournal(bootJournal);
      setLastSeenWeek(loadedLastSeenWeek ?? null);
      setContainerConfig(normalizeContainerConfig(loadedContainerCfg));
      setWeekLedger(normalizeLedger(loadedLedger));
      setCopiesNote(typeof loadedCopiesNote === 'string' ? loadedCopiesNote : '');
      setDishFeedback(loadedDishFeedback || {});
      if (loadedPipelineJournal && typeof loadedPipelineJournal === 'object') {
        setPipelineJournal({ version: 1, entries: loadedPipelineJournal.entries || {} });
      }
      setShopping(loadedShopping || []);
      setBooted(true);
      if (loadedWeek && Array.isArray(loadedWeek.selected)) {
        const valid = loadedWeek.selected.filter(n => ALL_DINNERS.some(d => d.name === n));
        setWeekDishes(valid.length > 0 ? valid : DEFAULT_WEEK);
      }
      const savedPending = await loadJSON(PENDING_KEY, []);
      if (mounted) setPendingOrders(savedPending || []);
      const savedHandled = await loadJSON(HANDLED_PENDING_KEY, {});
      handledPendingRef.current = savedHandled || {};

      const savedRegulars = await loadJSON(REGULARS_KEY, []);
      const migratedRegulars = (savedRegulars || []).map(r => {
        if (Array.isArray(r.names) && r.names.length) return r;
        const names = r.name ? [String(r.name).trim()] : [];
        return { ...r, names, name: names[0] || '' };
      });
      if (mounted) setRegulars(migratedRegulars);
      // Retroactive house backfill (Jul 20): stamp house:true and the free-order
      // fields onto any order linked to a house regular that's missing them, so
      // isHouseOrder (books, Money tab, digest) excludes it from every metric.
      // Catches orders that predate the flag or were linked via a path that
      // didn't stamp it. The wife must not touch any number. Idempotent: once an
      // order is house + $0 it no longer matches.
      const houseRegs = migratedRegulars.filter(r => r.house);
      if (houseRegs.length > 0) {
        const houseMatch = (o) => houseRegs.find(r => o.regularId === r.id || regularMatchType(r, o.customer) === 'exact');
        let houseFixed = 0;
        const houseBackfilled = migrated.map(o => {
          const reg = houseMatch(o);
          if (reg && (!o.house || o.total !== 0 || o.regularId !== reg.id)) {
            houseFixed++;
            return { ...o, house: true, regularId: reg.id, waiveSurcharge: true, discountType: 'percent', discountValue: HOUSE_DISCOUNT_PERCENT, total: 0 };
          }
          return o;
        });
        if (houseFixed > 0 && mounted) {
          setOrders(houseBackfilled);
          saveJSON(ORDERS_KEY, houseBackfilled);
        }
      }
      const savedInventory = await loadJSON(INVENTORY_KEY, {});
      if (mounted) setInventory(savedInventory || {});

      const savedIngredients = await loadJSON(INGREDIENTS_KEY, null);
      let ingForHistory = null;
      // Reconcile entries are produced here but LOGGED in the audit block
      // below, alongside the deploy fingerprint diff — same boot, same write,
      // one log. Both describe "a file edit moved your money," so splitting
      // them across two saves would just mean two chances to lose one.
      let reconcileChanges = [];
      if (savedIngredients && Array.isArray(savedIngredients) && savedIngredients.length) {
        // ── Seed reconciliation (Jul 15) ──────────────────────────────────
        // The stored DB is authoritative, which used to mean INGREDIENT_SEED
        // was inert after first install: editing a baseline in ingredients.js
        // changed nothing here, forever. That would merely be useless. It was
        // worse, because the drift engine reads the seed LIVE on one side of
        // its own ratio (baselineCostMap() -> seed, liveCostMapFrom() ->
        // storage). So a seed edit didn't do nothing; it made every dish using
        // that ingredient report drift against an anchor its `current` had
        // never been compared to. Thyme's unit change read as 1144%.
        //
        // This runs on EVERY boot, not once, because it is not a one-time
        // shape fix — it is a standing invariant. Kevin edits prices
        // regularly, and the next edit needs the same treatment as this one
        // with nobody having to remember. See src/seedReconcile.js.
        const rec = reconcileIngredients(savedIngredients, INGREDIENT_SEED);
        reconcileChanges = rec.changes;
        if (mounted) setIngredientsDb(rec.next);
        ingForHistory = rec.next;
        if (rec.changes.length) saveJSON(INGREDIENTS_KEY, rec.next);
      } else {
        // First run: seed from the canonical baseline. current = baseline at seed time.
        const seeded = INGREDIENT_SEED.map(i => ({ ...i, current: i.baseline }));
        if (mounted) setIngredientsDb(seeded);
        saveJSON(INGREDIENTS_KEY, seeded);
        ingForHistory = seeded;
      }

      // Cost history (lightweight time-series). Seed an initial snapshot on first run
      // so trends have a starting anchor; afterward append on each cost edit.
      const savedHistory = await loadJSON(COST_HISTORY_KEY, null);
      if (savedHistory && Array.isArray(savedHistory) && savedHistory.length) {
        // A unit-changed ingredient's history is denominated in the OLD unit.
        // Plotting per-bunch points on a per-sprig axis is not stale data, it
        // is a lie with a chart around it. Drop those points and let the
        // series restart; this is a lightweight trend, not the books.
        const pruned = pruneCostHistory(savedHistory, reconcileChanges);
        if (mounted) setCostHistory(pruned);
        if (pruned !== savedHistory) saveJSON(COST_HISTORY_KEY, pruned);
      } else {
        const t = Date.now();
        const snapshot = (ingForHistory || []).map(i => ({ t, id: i.id, cost: i.current }));
        if (mounted) setCostHistory(snapshot);
        saveJSON(COST_HISTORY_KEY, snapshot);
      }

      // Receipt aliases (Phase 3): learned receipt-string -> ingredient mappings,
      // always-ignore items, and flat-price flags. Empty map on first run.
      const savedAliases = await loadJSON(RECEIPT_ALIASES_KEY, null);
      if (mounted && savedAliases && typeof savedAliases === 'object') {
        setReceiptAliases(savedAliases);
      }

      // ── Audit trail + file-deploy detection (v9.23) ────────────────────
      // Dish prices and cost anchors live in dishes.js, so they change by
      // DEPLOY. Nothing in the running app can witness that edit happening —
      // by the time this code runs, the new number simply IS the number.
      // Diffing a stored fingerprint of the catalog against the one now in
      // the bundle is the only way the app can notice a deploy moved money.
      // This is the check that would have caught the $0 filet the morning it
      // shipped, instead of weeks later.
      const savedAudit = await loadJSON(AUDIT_LOG_KEY, []);
      const prevFp = await loadJSON(MENU_FINGERPRINT_KEY, null);
      const nextFp = menuFingerprint(FULL_MENU);
      // First run has no prior fingerprint: establish the baseline silently
      // rather than logging the entire catalog as if it just changed.
      const deployEntries = diffMenuFingerprint(prevFp, nextFp);
      // Seed reconciliation from above. This one is louder than a deploy diff:
      // a deploy entry records that the app NOTICED a number move, while a
      // reconcile entry records that the app CHANGED Kevin's stored data. An
      // unlogged migration that silently rewrites costs would be repeating the
      // exact sin the audit log was built to end.
      const seedEntries = diffReconcile(reconcileChanges);
      const startingLog = appendAudit(
        Array.isArray(savedAudit) ? savedAudit : [],
        [...deployEntries, ...seedEntries]
      );
      if (mounted) setAuditLog(startingLog);
      if (deployEntries.length || seedEntries.length) saveJSON(AUDIT_LOG_KEY, startingLog);
      if (!prevFp || deployEntries.length) saveJSON(MENU_FINGERPRINT_KEY, nextFp);

      // Tell Kevin his costs moved. Silently correcting money is how the filet
      // bug hid for weeks; a boot that quietly rewrites prices and says nothing
      // is the same failure wearing a fix's clothes.
      if (mounted && reconcileChanges.length) setNotice(summarizeReconcile(reconcileChanges));

      setLoading(false);
      cleanupPhotos(migrated);
      if (USE_LEGACY_CSV) {
        pollFormOrders(migrated, savedPending || []);
      } else {
        pollWorkerPending();
      }
    })();
    return () => { mounted = false; };
  }, []);

  const persistOrders = useCallback(async (next) => {
    setOrders(next);
    const res = await saveJSON(ORDERS_KEY, next);
    setError(saveError(res));
    return res;
  }, []);

  const persistShopping = useCallback((next) => {
    setShopping(next);
    saveJSON(SHOPPING_KEY, next).then(res => setError(saveError(res)));
  }, []);

  const INVENTORY_ADDON_MAP = {
    'Queso': 'queso_0',
    'Chili Oil': 'chiliOil',
    'Chimichurri': 'chimichurri',
    'Romesco': 'romesco',
    'Chermoula': 'chermoula',
    'Miso Butter Sauce': 'misoButter',
    'Whipped Lemon Garlic Herb Butter': 'whippedButter',
  };

  const saveOrder = useCallback((order) => {
    // Auto-house: a manual "New order" builds the order in OrderForm without a
    // regularId or house flag, so an order for the wife (a house regular) was
    // counted against metrics and Kevin had to enter the 100% by hand. If the
    // customer matches a house regular by link OR exact name, make it a proper
    // house order here (free, flagged, linked) so isHouseOrder excludes it
    // everywhere. Exact name only, since house means free. Idempotent.
    let o = order;
    const houseReg = (regulars || []).find(r => r.house && (o.regularId === r.id || regularMatchType(r, o.customer) === 'exact'));
    if (houseReg && (!o.house || o.total !== 0 || o.regularId !== houseReg.id)) {
      o = { ...o, house: true, regularId: houseReg.id, waiveSurcharge: true, discountType: 'percent', discountValue: HOUSE_DISCOUNT_PERCENT, total: 0 };
    }
    setOrders(prev => {
      const exists = (prev || []).some(x => x.id === o.id);
      const next = exists
        ? (prev || []).map(x => (x.id === o.id ? o : x))
        : [o, ...(prev || [])];
      saveJSON(ORDERS_KEY, next).then(res => setError(saveError(res)));
      if (!exists) {
        (o.items || []).forEach(it => {
          const invKey = INVENTORY_ADDON_MAP[it.name];
          if (invKey) {
            setInventory(inv => {
              const current = Number(inv[invKey]) || 0;
              const updated = { ...inv, [invKey]: Math.max(0, current - (it.qty || 1)) };
              saveJSON(INVENTORY_KEY, updated);
              return updated;
            });
          }
        });
      }
      return next;
    });
    setFormMode(null);
  }, [regulars]);

  const importOrders = useCallback((parsedOrders) => {
    const newOrders = parsedOrders.map(p => {
      const items = p.items || [];
      const total = orderTotal(items, p.jarSwaps || 0, p.containerReturns || 0, null, 0, [], false);
      return {
        id: uid(),
        customer: p.customer,
        items,
        jarSwaps: p.jarSwaps || 0,
        containerReturns: p.containerReturns || 0,
        notes: p.notes || '',
        discountType: null,
        discountValue: 0,
        customCharges: [],
        waiveSurcharge: false,
        total,
        status: 'Ordered',
        paid: false,
        archived: false,
        createdAt: new Date().toISOString(),
      };
    });
    setOrders(prev => {
      const next = [...newOrders, ...(prev || [])];
      saveJSON(ORDERS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
    setShowCsv(false);
    setExportMsg(`Imported ${newOrders.length} order${newOrders.length !== 1 ? 's' : ''} from the sheet.`);
    setTimeout(() => setExportMsg(null), 4000);
  }, []);

  const checkFormNow = React.useCallback(async () => {
    setCheckingForm(true);
    try {
      alert('Fetching from: ' + FORM_CSV_URL);
      const rows = await fetchFormRows();
      alert('Done. rows=' + (rows === null ? 'null' : Array.isArray(rows) ? rows.length : typeof rows));
      if (!rows) { setCheckingForm(false); return; }
      const seenRaw = await loadJSON(SEEN_ROWS_KEY, {});
      const seen = seenRaw || {};
      const newPending = [];
      rows.forEach(row => {
        const ts = row['Timestamp'] || row['timestamp'] || '';
        if (!ts || seen[ts]) return;
        const { customer, items, notes } = parseFormRow(row);
        if (items.length === 0 && !notes) return;
        newPending.push({
          pendingId: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2),
          timestamp: ts,
          customer,
          items,
          notes,
        });
        seen[ts] = true;
      });
      if (newPending.length > 0) {
        setPendingOrders(prev => {
          const updated = [...prev, ...newPending];
          saveJSON(PENDING_KEY, updated);
          return updated;
        });
        await saveJSON(SEEN_ROWS_KEY, seen);
      } else {
        await saveJSON(SEEN_ROWS_KEY, seen);
      }
    } catch(e) { alert('ERROR: ' + e.message); }
    setCheckingForm(false);
  }, []);

  const resetRecentSeenRows = React.useCallback(async () => {
    const seenRaw = await loadJSON(SEEN_ROWS_KEY, {});
    const seen = seenRaw || {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let removed = 0;
    const updated = {};
    Object.entries(seen).forEach(([ts, val]) => {
      const parsed = new Date(ts);
      if (!isNaN(parsed.getTime()) && parsed.getTime() >= cutoff) {
        removed++;
      } else {
        updated[ts] = val;
      }
    });
    await saveJSON(SEEN_ROWS_KEY, updated);
    alert('Reset ' + removed + ' recent order' + (removed !== 1 ? 's' : '') + ' from seen history. Tap "Check for new orders" to re-import them.');
  }, []);

  const pollFormOrders = React.useCallback(async (existingOrders, existingPending) => {
    const rows = await fetchFormRows();
    if (!rows) return;
    const seenRaw = await loadJSON(SEEN_ROWS_KEY, {});
    const seen = seenRaw || {};
    const newPending = [];
    rows.forEach(row => {
      const ts = row['Timestamp'] || row['timestamp'] || '';
      if (!ts || seen[ts]) return;
      const { customer, items, notes } = parseFormRow(row);
      if (items.length === 0 && !notes) return;
      newPending.push({
        pendingId: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        timestamp: ts,
        customer,
        items,
        notes,
      });
      seen[ts] = true;
    });
    if (newPending.length > 0) {
      const updated = [...existingPending, ...newPending];
      setPendingOrders(updated);
      await saveJSON(PENDING_KEY, updated);
      await saveJSON(SEEN_ROWS_KEY, seen);
    } else {
      await saveJSON(SEEN_ROWS_KEY, seen);
    }
    setTimeout(() => pollFormOrders(existingOrders, existingPending), 5 * 60 * 1000);
  }, []);

  const workerPollRef = React.useRef(null);
  const pollWorkerPending = React.useCallback(async (reschedule = true) => {
    try {
      const res = await fetch(PENDING_POLL_URL, { cache: 'no-store', headers: { 'X-LTB-Token': PUBLISH_TOKEN } });
      if (res.ok) {
        const data = await res.json();
        const submissions = (data && data.pending) || [];
        if (submissions.length > 0) {
          const mapped = submissions.map(s => ({
            pendingId: s.id,
            timestamp: s.submittedAt || new Date().toISOString(),
            customer: s.customer || 'Unknown',
            address: s.address || '',
            phone: s.phone || '',
            items: Array.isArray(s.items) ? s.items.map(it => ({
              name: it.name, variant: it.variant, qty: it.qty || 1,
              price: it.price, cost: it.cost || 0,
              note: it.note || '', hasPhoto: false,
              // Preserve customer-selected options (spice level, pasta shape).
              // These were being dropped here, so spice/pasta never reached the
              // order card even though the form sent them correctly.
              ...(it.options ? { options: it.options } : {}),
              // At-cost add-on requests (parm block, fixings): normalize to
              // pending line items — cost unknown until Kevin shops, exactly
              // like the weight system. normalizeAddons dedupes + sanitizes.
              ...((() => { const a = normalizeAddons(it.addons); return a ? { addons: a } : {}; })()),
              ...(it.perLb ? { perLb: it.perLb } : {}),
              ...(it.avgWeightLb != null ? { avgWeightLb: it.avgWeightLb } : {}),
            })) : [],
            notes: s.notes || '',
          }));
          setPendingOrders(prev => {
            const have = new Set((prev || []).map(p => p.pendingId));
            const handled = handledPendingRef.current || {};
            const fresh = mapped.filter(m => !have.has(m.pendingId) && !handled[m.pendingId]);
            if (fresh.length === 0) return prev;
            const updated = [...(prev || []), ...fresh];
            saveJSON(PENDING_KEY, updated);
            return updated;
          });
          // Do NOT clear the worker here. The worker is the durable queue; an
          // order leaves it only when Kevin accepts or rejects it (see
          // dismissPending). Poll is a pure idempotent sync, so a failed local
          // save, a reload, or a restore-over-pending can no longer lose an
          // order the worker had already deleted. Re-syncing a still-queued
          // order is harmless: dedup skips anything already in local pending or
          // in the handled ledger.
        }
      }
    } catch (e) {}
    if (reschedule) {
      if (workerPollRef.current) clearTimeout(workerPollRef.current);
      workerPollRef.current = setTimeout(() => pollWorkerPending(true), 2 * 60 * 1000);
    }
  }, []);

  const checkWorkerNow = React.useCallback(async () => {
    setCheckingForm(true);
    await pollWorkerPending(false);
    setCheckingForm(false);
  }, [pollWorkerPending]);

  // Publish history: the config drives the entire customer surface and had no
  // undo. The worker keeps the last few; these two just read and restore.
  const fetchConfigHistory = React.useCallback(async () => {
    const res = await fetch(`${WORKER_BASE}/config-history?token=${encodeURIComponent(PUBLISH_TOKEN)}`);
    if (!res.ok) throw new Error('Could not load publish history.');
    return res.json();
  }, []);
  const restoreConfig = React.useCallback(async (index) => {
    const res = await fetch(`${WORKER_BASE}/config-restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: PUBLISH_TOKEN, index }),
    });
    if (!res.ok) throw new Error('Restore failed.');
    return res.json();
  }, []);

  const publishWeek = React.useCallback(async (currentWeekDishes, menuPdfUrl, weekLabel, pausedOpts, extras) => {
    const activeMenu = buildMenu(currentWeekDishes || []);
    const toVariants = (item) => {
      const info = PER_LB_ITEMS[item.name];
      if (info) {
        return {
          name: item.name,
          perLb: true,
          pricePerLb: info.pricePerLb,
          avgWeightLb: info.avgWeightLb,
          variants: [{ label: 'By weight', price: info.pricePerLb, cost: info.costPerLb }],
        };
      }
      return {
        name: item.name,
        variants: (item.variants || []).map(v => ({ label: v.label, price: v.price, cost: v.cost || 0 })),
        ...(item.spotlight ? { spotlight: true } : {}), // spotlight dinners route to their own form header
        ...(item.options ? { options: item.options } : {}), // form.html renders pickers from this (Batch 3)
        ...(item.diet ? { diet: item.diet } : {}), // menu.html dietary filter reads veg/pesc tags from this
      };
    };
    const allDinners = (activeMenu.dinner || []).map(toVariants);
    const req = (extras && extras.requestCounts) || {};
    // Customer favorites, earned from repeat orders and feedback rather than
    // declared. Computed at publish so the customer pages need no history.
    const favSet = new Set(((extras && extras.favorites) || []).map(f => f.name));
    const allDinnersTagged = allDinners.map(d => {
      let out = d;
      if (req[d.name] > 0) out = { ...out, requested: true };
      if (favSet.has(d.name)) out = { ...out, favorite: true };
      return out;
    });
    const dishes = allDinnersTagged.filter(d => !d.spotlight);
    const spotlight = allDinnersTagged.filter(d => d.spotlight);
    const fruit = (activeMenu.fruit || []).map(toVariants);
    const desserts = (activeMenu.desserts || []).map(toVariants);
    const addons = (activeMenu.addons || []).map(toVariants);
    const bag = (activeMenu.bag || []).map(toVariants);
    const sauces = (activeMenu.sauces || []).map(toVariants);
    const payload = {
      token: PUBLISH_TOKEN,
      dishes, spotlight, fruit, desserts, addons, bag, sauces,
      menuPdfUrl: menuPdfUrl || '',
      weekLabel: weekLabel || '',
      // One bottle that covers the week, computed from the registry's pairing
      // data at publish time so the customer pages need no drink logic.
      ...(() => { const ob = weekOneBottle(currentWeekDishes || []); return ob ? { oneBottle: ob } : {}; })(),
      // Week off: the form and menu page show a friendly notice instead of an
      // empty menu. Publishing a normal week clears it.
      ...(pausedOpts && pausedOpts.paused
        ? { paused: true, pausedMsg: String(pausedOpts.pausedMsg || '').slice(0, 200) }
        : { paused: false, pausedMsg: '' }),
      // The heads-up banner. This line is the fix for a feature that was
      // wired end to end EXCEPT here: WeekTab collected the message and
      // publishWeek dropped it on the floor, so it never reached the worker
      // and no customer page could have shown it. Always present, never
      // conditional — an unchecked box must publish '' to CLEAR last week's
      // banner, exactly like pausedMsg above.
      notice: extractNotice(pausedOpts, extras),
    };
    const res = await fetch(CONFIG_PUBLISH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('Publish failed (' + res.status + '): ' + txt.slice(0, 120));
    }
    // The worker builds the stored config from its OWN field list and reports
    // anything it did not recognize. Surfacing that is the whole defense
    // against a class of bug that has now bitten three times (paused, notice,
    // oneBottle): a field fully built here, fully rendered on the customer
    // page, and silently discarded in transit. A publish that quietly loses
    // data must never look like a clean publish.
    // READ THE BODY EXACTLY ONCE. A Response body is a one-shot stream: this
    // function already ended with `return res.json()`, so adding a second read
    // here threw "body is disturbed or locked" AFTER the publish had actually
    // succeeded. That is the worst shape a bug can take, because it reports
    // failure for work that landed and teaches you to distrust the success
    // message. The parsed value is reused for both jobs below.
    let published = null;
    try {
      published = await res.json();
    } catch (_) { /* an unparseable body is not a failed publish */ }
    // Forward-only seasonal record. UPSERTED by business week, so publishing
    // three times in one week (menu, then omakase, then a notice) leaves one
    // row holding the final state rather than three rows to reconcile later.
    setWeekLedger(prev => {
      const next = recordWeek(prev, allDinners.map(d => d.name), new Date(),
        { paused: !!(pausedOpts && pausedOpts.paused) });
      saveJSON(WEEK_LEDGER_KEY, next);
      return next;
    });
    if (published && Array.isArray(published.dropped) && published.dropped.length) {
      setNotice(
        'Published, but the worker ignored ' + published.dropped.join(', ') +
        '. Those never reach the customer pages; the worker needs the field added to CONFIG_FIELDS.'
      );
    }
    // Publish the full dinner catalog as the request whitelist. Fire-and-forget:
    // a failure here must never block the week publish, and POST /requests just
    // rejects everything until the next successful write. Full ALL_DINNERS, not
    // this week's subset — customers request dishes that AREN'T on this week.
    try {
      await fetch(WORKER_BASE + '/requestable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: PUBLISH_TOKEN, dishes: ALL_DINNERS.map(d => d.name) }),
      });
    } catch (e) { /* non-fatal: week publish already succeeded */ }
    // Logged only on SUCCESS — a failed publish changed nothing customer-facing
    // and shouldn't leave a trail suggesting it did. Records WHEN a price set
    // went live, which is the other half of "why did a customer see that
    // price?" — the file-deploy entries say what the number became, this says
    // when it reached the form. Dish names only, no customer data.
    recordAudit([auditEntry({
      target: 'week',
      field: 'published',
      from: null,
      to: dishes.length + spotlight.length,
      source: SOURCES.PUBLISH,
      meta: {
        dishes: allDinners.map(d => d.name).slice(0, 40),
        ...(weekLabel ? { weekLabel: String(weekLabel).slice(0, 80) } : {}),
      },
    })]);
    return published; // already parsed above; never re-read res
  }, [recordAudit]);

  // ── Auto-fill regular contact info from incoming order ─────────────────────
  // Called after linking an order to a regular. If the regular has no address
  // or phone and the order does, fills in the blank fields and shows a banner.
  const autoFillRegularContact = useCallback((reg, order) => {
    const infoPatch = {};
    if (!reg.address && order.address) infoPatch.address = order.address;
    if (!reg.phone && order.phone) infoPatch.phone = order.phone;
    if (Object.keys(infoPatch).length > 0) {
      updateRegular(reg.id, infoPatch);
      const fields = [infoPatch.address && 'address', infoPatch.phone && 'phone']
        .filter(Boolean).join(' and ');
      const name = (reg.names && reg.names[0]) || reg.name || 'Regular';
      setExportMsg(`${name}'s ${fields} saved to Regulars.`);
      setTimeout(() => setExportMsg(null), 4000);
    }
  }, []);

  const acceptPending = useCallback((pending) => {
    // EC-1 idempotency guard: a double-tap on a slow phone fires acceptPending
    // twice before the card unmounts, and each call mints a fresh uid() order,
    // doubles the inventory decrement, and double-links the regular. Claim the
    // id synchronously up front so a repeat call bails. dismissPending marks it
    // again at the end, which is idempotent.
    if (!pending) return;
    const claimId = pending.pendingId;
    if (claimId) {
      if (handledPendingRef.current[claimId]) return;
      handledPendingRef.current[claimId] = Date.now();
    }
    const orderId = uid();

    let exactReg = null;
    const partialRegs = [];
    regulars.forEach(r => {
      const m = regularMatchType(r, pending.customer);
      if (m === 'exact') exactReg = r;
      else if (m === 'partial') partialRegs.push(r);
    });

    // A house regular (the wife) is free, full stop: the flag alone implies
    // 100% off, so there is no discount field to set and no way to half-apply
    // it. A normal regular's lifetime discount applies as before.
    const isHouse = !!(exactReg && exactReg.house);
    const discountType = isHouse ? 'percent' : (exactReg && exactReg.discountPercent > 0 ? 'percent' : null);
    const discountValue = isHouse ? HOUSE_DISCOUNT_PERCENT : (exactReg && exactReg.discountPercent > 0 ? exactReg.discountPercent : 0);

    // Normalize the customer-form item shape FIRST (per-lb proteins arrive with
    // the $/lb rate in price/cost and no weightPending — see normalizePendingItems),
    // then total and stamp. Order of operations matters: totaling before
    // normalizing counts a rate as a price; stamping before normalizing freezes
    // a rate as a cost basis.
    const normalizedItems = normalizePendingItems(pending.items);
    const total = orderTotal(normalizedItems, 0, 0, discountType, discountValue, [], isHouse);

    // Re-stamp cost bases from the app's own registry at acceptance — the
    // registry is authoritative over whatever the customer form submitted
    // (which can be stale, zero-coerced, or tampered). Items the registry
    // can't match keep any client value they carried.
    const stampedItems = stampItemCosts(normalizedItems, 'snapshot', { reStamp: true });

    const order = {
      id: orderId,
      customer: pending.customer,
      address: pending.address || '',
      phone: pending.phone || '',
      items: stampedItems,
      jarSwaps: 0,
      containerReturns: 0,
      notes: pending.notes || '',
      discountType,
      discountValue,
      customCharges: [],
      // EC-6: a house order (the wife) is free, full stop, so the $2 surcharge
      // is waived too. Leaving it false billed her $2 and fed $2 of phantom
      // revenue into books on every house order.
      waiveSurcharge: isHouse,
      total,
      status: 'Ordered',
      paid: false,
      archived: false,
      regularId: exactReg ? exactReg.id : null,
      // Copied from the regular at link time, not looked up later: books.js and
      // weekPlanner.js only ever see `orders`, never `regulars`.
      house: isHouse,
      createdAt: new Date().toISOString(),
    };
    setOrders(prev => {
      const next = [order, ...(prev || [])];
      saveJSON(ORDERS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });

    (order.items || []).forEach(it => {
      const invKey = INVENTORY_ADDON_MAP[it.name];
      if (invKey) adjustInventory(invKey, -(it.qty || 1));
    });

    if (exactReg) {
      linkOrderToRegular(exactReg.id, orderId);
      autoFillRegularContact(exactReg, order);
    } else if (partialRegs.length > 0) {
      setLinkPrompt({ order, candidates: partialRegs });
    }

    dismissPending(pending.pendingId);
    setShowPendingIdx(null);
  }, [regulars, autoFillRegularContact]);

  const dismissPending = useCallback((pendingId) => {
    setPendingOrders(prev => {
      const next = prev.filter(p => p.pendingId !== pendingId);
      saveJSON(PENDING_KEY, next);
      return next;
    });
    // This is where an order actually leaves the worker queue: Kevin accepted
    // it (acceptPending calls through here) or rejected it. Record the id as
    // handled so a re-poll can't resurrect it, then tell the worker to drop it.
    // The ledger is the durable guard; the network clear is best-effort on top,
    // so a failed clear degrades to a harmless dedup, never a lost order.
    if (pendingId) {
      const ledger = handledPendingRef.current || {};
      ledger[pendingId] = Date.now();
      const keys = Object.keys(ledger);
      if (keys.length > 800) {
        const trimmed = {};
        keys.slice(-400).forEach(k => { trimmed[k] = ledger[k]; });
        handledPendingRef.current = trimmed;
      } else {
        handledPendingRef.current = ledger;
      }
      saveJSON(HANDLED_PENDING_KEY, handledPendingRef.current);
      fetch(WORKER_BASE + '/pending/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [pendingId], token: PUBLISH_TOKEN }),
      }).catch(() => {});
    }
    setShowPendingIdx(null);
  }, []);

  const persistRegulars = useCallback((next) => {
    setRegulars(next);
    saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
  }, []);

  const addRegular = useCallback((profile) => {
    const names = (Array.isArray(profile.names) ? profile.names : [profile.name])
      .map(n => String(n || '').trim())
      .filter(Boolean);
    const reg = {
      id: uid(),
      names,
      name: names[0] || '',
      address: profile.address || '',
      phone: profile.phone || '',
      dietary: profile.dietary || '',
      spice: profile.spice || '',
      discountPercent: Number(profile.discountPercent) || 0,
      notes: profile.notes || '',
      linkedOrderIds: profile.linkedOrderIds || [],
      lastInsightSig: '',
      createdAt: new Date().toISOString(),
    };
    setRegulars(prev => {
      const next = [...prev, reg];
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
    return reg.id;
  }, []);

  const updateRegular = useCallback((id, patch) => {
    setRegulars(prev => {
      const next = prev.map(r => (r.id === id ? { ...r, ...patch } : r));
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const deleteRegular = useCallback((id) => {
    setRegulars(prev => {
      const next = prev.filter(r => r.id !== id);
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  // ── STARTUP AUTOMATIONS (Jul 9): run once per session, silently. Feedback
  // pull only fires when any order carries a kitchenPageId; backfill is safe
  // by construction (exact/alias matches only — partials never auto-link).
  const startupRan = useRef(false);
  useEffect(() => {
    if (!booted || startupRan.current) return;
    startupRan.current = true;
    pullKitchenFeedback().catch(() => {}); // offline or v8 not deployed: silently skip
    if ((regulars || []).length && (orders || []).some(o => !o.regularId)) {
      try { runBackfill(); } catch (e) { /* silent */ }
    }
  }, [booted]);

  const linkOrderToRegular = useCallback((regularId, orderId) => {
    setRegulars(prev => {
      const next = prev.map(r => {
        if (r.id !== regularId) return r;
        const linkedOrderIds = r.linkedOrderIds.includes(orderId)
          ? r.linkedOrderIds
          : [...r.linkedOrderIds, orderId];
        return { ...r, linkedOrderIds };
      });
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const unlinkOrderFromRegular = useCallback((regularId, orderId) => {
    setRegulars(prev => {
      const next = prev.map(r =>
        r.id === regularId
          ? { ...r, linkedOrderIds: r.linkedOrderIds.filter(oid => oid !== orderId) }
          : r
      );
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const adjustInventory = useCallback((key, delta) => {
    setInventory(prev => {
      const current = Number(prev[key]) || 0;
      const next = { ...prev, [key]: Math.max(0, current + delta) };
      saveJSON(INVENTORY_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const setInventoryCount = useCallback((key, value) => {
    setInventory(prev => {
      const next = { ...prev, [key]: Math.max(0, Number(value) || 0) };
      saveJSON(INVENTORY_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const updateIngredients = useCallback((next) => {
    // Diff against current state to log only changed costs into history.
    setIngredientsDb(prev => {
      // Same prev/next pair the cost-history diff below already uses — the
      // audit trail is a second reader of a diff this function already had.
      recordAudit(diffIngredientCosts(prev, next, SOURCES.MANUAL));
      const prevById = {};
      (prev || []).forEach(i => { prevById[i.id] = i.current; });
      const t = Date.now();
      const points = [];
      (next || []).forEach(i => {
        const before = prevById[i.id];
        // log when a new ingredient appears or its current cost moved
        if (before === undefined || Math.abs((before || 0) - (i.current || 0)) > 0.0001) {
          points.push({ t, id: i.id, cost: i.current });
        }
      });
      if (points.length) {
        setCostHistory(h => {
          const merged = [...(h || []), ...points];
          // cap history to keep storage small (~last 4000 points)
          const capped = merged.length > 4000 ? merged.slice(merged.length - 4000) : merged;
          saveJSON(COST_HISTORY_KEY, capped).then(res => setError(saveError(res)));
          return capped;
        });
      }
      return next;
    });
    saveJSON(INGREDIENTS_KEY, next).then(res => setError(saveError(res)));
  }, [recordAudit]);

  // Phase 3 — receipt commit. Twin of updateIngredients, but stamps cost-history
  // points with the receipt's PURCHASE date (not the scan moment). `updates` is
  // [{ id, cost }] for accepted lines only. `purchaseDate` is an ISO 'YYYY-MM-DD'
  // string or null (fallback: now). Never touches baseline.
  const commitReceiptCosts = useCallback((updates, purchaseDate, newIngredients) => {
    if ((!updates || !updates.length) && (!newIngredients || !newIngredients.length)) return;
    const stamp = (() => {
      if (purchaseDate) {
        const ms = Date.parse(purchaseDate);
        if (!isNaN(ms)) return ms;
      }
      return Date.now();
    })();
    const byId = {};
    (updates || []).forEach(u => { byId[u.id] = u.cost; });
    // Per-ingredient provenance for the audit trail: the receipt line's raw
    // text and the derivation basis that produced this number. This is what
    // makes "why is this cost wrong?" answerable — it traces a bad cost to
    // the exact scanned line and the exact rule that read it.
    const metaById = {};
    (updates || []).forEach(u => {
      const m = {};
      if (u.raw) m.raw = String(u.raw).slice(0, 80);
      if (u.basis) m.basis = u.basis;
      if (purchaseDate) m.receiptDate = purchaseDate;
      if (Object.keys(m).length) metaById[u.id] = m;
    });
    setIngredientsDb(prev => {
      // first, append any inline-created ingredients (so cost updates resolve)
      const created = (newIngredients || []).filter(ni => !(prev || []).some(i => i.id === ni.id));
      const base = [...(prev || []), ...created];
      const next = base.map(i => (byId[i.id] != null ? { ...i, current: byId[i.id] } : i));
      recordAudit(diffIngredientCosts(base, next, SOURCES.RECEIPT, metaById));
      const prevById = {};
      base.forEach(i => { prevById[i.id] = i.current; });
      const t = stamp;
      const points = [];
      // log created ingredients' initial cost + any moved currents
      created.forEach(ni => { points.push({ t, id: ni.id, cost: ni.current }); });
      Object.keys(byId).forEach(id => {
        const before = prevById[id];
        const after = byId[id];
        if (before === undefined || Math.abs((before || 0) - (after || 0)) > 0.0001) {
          // avoid double-logging a just-created ingredient whose cost equals its seed
          if (!created.some(c => c.id === id && Math.abs((c.current || 0) - (after || 0)) < 0.0001)) {
            points.push({ t, id, cost: after });
          }
        }
      });
      if (points.length) {
        setCostHistory(h => {
          const merged = [...(h || []), ...points].sort((a, b) => a.t - b.t);
          const capped = merged.length > 4000 ? merged.slice(merged.length - 4000) : merged;
          saveJSON(COST_HISTORY_KEY, capped).then(res => setError(saveError(res)));
          return capped;
        });
      }
      saveJSON(INGREDIENTS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, [recordAudit]);

  // Persist learned receipt aliases (merge + save).
  const saveReceiptAliases = useCallback((nextAliases) => {
    setReceiptAliases(prev => {
      // Only REMAPS are logged. The alias map also churns sighting counters
      // and store facts on every scan, and none of that moves money — logging
      // it would bury the one thing that does: which ingredient a receipt
      // string resolves to.
      recordAudit(diffAliases(prev, nextAliases));
      return nextAliases;
    });
    saveJSON(RECEIPT_ALIASES_KEY, nextAliases).then(res => setError(saveError(res)));
  }, [recordAudit]);

  const updateOrder = useCallback((id, patch) => {
    setOrders(prev => {
      const next = (prev || []).map(o => (o.id === id ? { ...o, ...patch } : o));
      saveJSON(ORDERS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  // ── Make-a-regular star (OrderCard) ────────────────────────────────────────
  const makeRegularFromOrder = useCallback((order) => {
    const id = addRegular({
      names: [order.customer || ''],
      address: order.address || '',
      phone: order.phone || '',
      linkedOrderIds: [order.id],
    });
    updateOrder(order.id, { regularId: id });
  }, [addRegular, updateOrder]);

  // Link an order to an EXISTING regular from the star's near-miss chooser.
  // The order's name becomes an alias on the regular (non-destructive merge
  // mechanism) so all past and future orders under that name match too.
  const linkOrderWithAlias = useCallback((regularId, order) => {
    setRegulars(prev => {
      const next = prev.map(r => {
        if (r.id !== regularId) return r;
        const has = regularAllNames(r).some(n => n.toLowerCase() === String(order.customer || '').toLowerCase());
        return {
          ...r,
          aliases: has ? (r.aliases || []) : [...(r.aliases || []), order.customer],
          linkedOrderIds: r.linkedOrderIds.includes(order.id) ? r.linkedOrderIds : [...r.linkedOrderIds, order.id],
        };
      });
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
    updateOrder(order.id, { regularId });
  }, [updateOrder]);

  // ── Merge / unmerge (non-destructive, reversible) ───────────────────────────
  const doMergeRegulars = useCallback((targetId, sourceId) => {
    setRegulars(prev => {
      const { regulars: next, relinkOrderIds } = mergeRegulars(prev, targetId, sourceId);
      if (relinkOrderIds.length) {
        setOrders(po => {
          const on = (po || []).map(o => (relinkOrderIds.includes(o.id) ? { ...o, regularId: targetId } : o));
          saveJSON(ORDERS_KEY, on).then(res => setError(saveError(res)));
          return on;
        });
      }
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const doUnmergeRegular = useCallback((targetId, snapshotId) => {
    setRegulars(prev => {
      const next = unmergeRegular(prev, targetId, snapshotId);
      saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  // ── Backfill pre-regulars orders (exact/alias auto; partial = suggestions) ──
  // Voice add-item: append a single-variant item to an order, repriced via
  // the same math every other item flows through (stamp totals via updateOrder).
  // ── CLOSE OUT THE WEEK (one tap): pull any last kitchen feedback, then
  // archive everything delivered. The ritual, automated.
  const closeOutWeek = useCallback(async () => {
    let fb = { attached: 0 };
    try { fb = await pullKitchenFeedback(); } catch (e) { /* offline is fine */ }
    const deliveredCount = (orders || []).filter(o => o.status === 'Delivered' && !o.archived).length;
    archiveDelivered();
    return { feedback: fb.pulled || 0, archived: deliveredCount };
  }, [orders]);

  // ── Kitchen feedback sync (triage flow, Jul 11) ────────────────────────────
  // Pulls tapped verdicts from the worker into a TRIAGE QUEUE (pendingFeedback).
  // Nothing is attached to orders and nothing is cleared on pull — each entry
  // is cleared from KV only when Kevin Saves or Ignores it (and only once all
  // entries sharing its pageId are triaged), so mid-triage app closes are safe.
  const pullKitchenFeedback = useCallback(async () => {
    const res = await fetch(WORKER_BASE + '/feedback/pending?token=' + encodeURIComponent(PUBLISH_TOKEN));
    if (!res.ok) throw new Error('pull failed');
    const { feedback } = await res.json();
    if (!feedback || !feedback.length) return { pulled: 0 };
    const incoming = [];
    for (const page of feedback) {
      (page.entries || []).forEach((e, i) => {
        incoming.push({ id: page.pageId + ':' + i, pageId: page.pageId, dish: e.dish, verdict: e.verdict, note: e.note || '', at: e.at });
      });
    }
    let pulled = 0;
    setPendingFeedback(prev => {
      const have = new Set(prev.map(e => e.id));
      const fresh = incoming.filter(e => !have.has(e.id));
      pulled = fresh.length;
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    return { pulled: incoming.length };
  }, []);

  // Clear a pageId from worker KV once no queued entries reference it.
  const clearPageIfDone = useCallback(async (queue, pageId) => {
    if (queue.some(e => e.pageId === pageId)) return;
    try {
      await fetch(WORKER_BASE + '/feedback/clear', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: PUBLISH_TOKEN, pageIds: [pageId] }),
      });
    } catch (e) { /* offline: KV entry lingers, harmless — dedupe by id on next pull */ }
  }, []);

  // Save one triaged entry to the per-dish store. mode: 'tally' | 'tallyNote'.
  const saveFeedbackEntry = useCallback((entry, mode) => {
    setDishFeedback(prev => {
      const next = applyFeedbackSave(prev, entry, mode);
      saveJSON(FEEDBACK_KEY, next).then(r => setError(saveError(r)));
      return next;
    });
    setPendingFeedback(prev => {
      const next = prev.filter(e => e.id !== entry.id);
      clearPageIfDone(next, entry.pageId);
      return next;
    });
  }, [clearPageIfDone]);

  const ignoreFeedbackEntry = useCallback((entry) => {
    setPendingFeedback(prev => {
      const next = prev.filter(e => e.id !== entry.id);
      clearPageIfDone(next, entry.pageId);
      return next;
    });
  }, [clearPageIfDone]);

  // Reset one dish's live tally (archives current tally+notes to history first).
  const resetDishFeedbackTally = useCallback((dish) => {
    setDishFeedback(prev => {
      const next = resetDishFeedback(prev, dish);
      saveJSON(FEEDBACK_KEY, next).then(r => setError(saveError(r)));
      return next;
    });
  }, []);

  // Resolve a backfill near-miss inline: link an order (by id, archived or
  // not) to the chosen regular, reusing the alias-merge mechanism so the
  // order's name is remembered on that regular going forward.
  const linkSuggestionToRegular = useCallback((orderId, regularId) => {
    const order = (orders || []).find(o => o.id === orderId);
    if (order) linkOrderWithAlias(regularId, order);
  }, [orders, linkOrderWithAlias]);

  const runBackfill = useCallback(() => {
    const { auto, suggestions } = backfillRegularLinks(regulars, orders || []);
    if (auto.length) {
      setOrders(po => {
        const byId = new Map(auto.map(a => [a.orderId, a.regularId]));
        const on = (po || []).map(o => (byId.has(o.id) ? { ...o, regularId: byId.get(o.id) } : o));
        saveJSON(ORDERS_KEY, on).then(res => setError(saveError(res)));
        return on;
      });
      setRegulars(prev => {
        const next = prev.map(r => {
          const mine = auto.filter(a => a.regularId === r.id).map(a => a.orderId);
          if (!mine.length) return r;
          return { ...r, linkedOrderIds: [...new Set([...(r.linkedOrderIds || []), ...mine])] };
        });
        saveJSON(REGULARS_KEY, next).then(res => setError(saveError(res)));
        return next;
      });
    }
    return { autoCount: auto.length, suggestions };
  }, [regulars, orders]);

  const deleteOrder = useCallback((id) => {
    setOrders(prev => {
      const target = (prev || []).find(o => o.id === id);
      if (target) (target.items || []).forEach((it, i) => { if (it.hasPhoto) deletePhoto(id, i); });
      const next = (prev || []).filter(o => o.id !== id);
      saveJSON(ORDERS_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const archiveDelivered = useCallback(() => {
    persistOrders((orders || []).map(o =>
      o.status === 'Delivered' && !o.archived ? { ...o, archived: true } : o
    ));
  }, [orders, persistOrders]);

  // ── V4: bulk actions ──────────────────────────────────────────────────────
  // ONE state commit and ONE localStorage write for N orders, never N
  // sequential updateOrder calls: N writes would be N chances to hit the
  // quota guard halfway through, leaving some orders marked and some not
  // with no record of where it stopped. Idempotent by construction — an
  // order already in the target state is returned untouched, so a
  // double-tap can never double-apply.
  const bulkUpdateOrders = useCallback((ids, patch) => {
    const idSet = ids instanceof Set ? ids : new Set(ids || []);
    if (idSet.size === 0) return;
    persistOrders((orders || []).map(o => (idSet.has(o.id) ? { ...o, ...patch } : o)));
  }, [orders, persistOrders]);

  // House orders are $0 and never enter the books, so "mark paid" is
  // meaningless for them — they are filtered out at the selection layer
  // (see selectableOrders) rather than silently skipped here, so the count
  // Kevin sees on the button is the count that actually changes.
  const bulkMarkPaid = useCallback((ids) => bulkUpdateOrders(ids, { paid: true }), [bulkUpdateOrders]);
  const bulkArchive = useCallback((ids) => bulkUpdateOrders(ids, { archived: true }), [bulkUpdateOrders]);

  const [exportMsg, setExportMsg] = useState(null);

  // ── Backup payload + online backup ring (v9.20) ──────────────────────────
  // One builder for every path that serializes app data (clipboard copy,
  // file download, auto-push). Shape unchanged from the v9.18 exportData —
  // the worker validates version + orders on push, and restore validates
  // the same fields, so old Notes-paste backups stay importable.
  const buildBackupPayload = useCallback(() => ({
    version: 'ltb-v1',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    orders: orders || [],
    shopping,
    weekDishes,
    regulars,
    inventory,
    ingredientsDb,
    costHistory,
    receiptAliases,
    auditLog,
    pipelineJournal,
    // The knowledge journal MUST ride the ring: it is the one store whose
    // loss is total (reasons live nowhere else — costs are on receipts,
    // orders are on the worker, but the whys are only here).
    journal,
    containerInventory: containerConfig,
    weekLedger,
    copiesNote,
    // EC-3: the handled-pending ledger guards against a re-poll resurrecting an
    // order Kevin already accepted (when a worker clear failed). It lived only
    // on-device, so a restore blanked it and could resurrect. Ride the backup.
    handledPending: handledPendingRef.current,
  }), [orders, shopping, weekDishes, regulars, inventory, ingredientsDb, costHistory, receiptAliases, auditLog, pipelineJournal, journal, containerConfig, weekLedger, copiesNote]);

  const copyBackupToClipboard = useCallback(async () => {
    const json = JSON.stringify(buildBackupPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setExportMsg('Copied! Paste into Notes or anywhere to save.');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setExportMsg('Copied! Paste into Notes or anywhere to save.');
      } catch {
        setExportMsg('Could not copy automatically. Try the export from Safari (not home screen).');
      }
    }
    setTimeout(() => setExportMsg(null), 4000);
  }, [buildBackupPayload]);

  const downloadBackupFile = useCallback(() => {
    try {
      const payload = buildBackupPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ltb-backup-' + payload.exportedAt.slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setExportMsg('Backup file saved.');
      setTimeout(() => setExportMsg(null), 4000);
    } catch {
      setExportMsg('Could not save a file here — use Copy to clipboard instead.');
      setTimeout(() => setExportMsg(null), 4000);
    }
  }, [buildBackupPayload]);

  // Auto-push: silent backup to the worker's KV ring on app open, every
  // 15 minutes while open, and when the app goes to the background (iOS
  // kills timers in background — the visibilitychange push captures the
  // latest state on the way out). Hash-throttled: the hash EXCLUDES
  // exportedAt (which changes every call), so a no-op state pushes nothing.
  // Never fires before the initial load completes, and never pushes a
  // fully-empty state (that's either a brand-new install with nothing worth
  // backing up, or a broken load that must not enter the ring).
  const lastPushedHash = useRef(null);
  const payloadRef = useRef(buildBackupPayload);
  useEffect(() => { payloadRef.current = buildBackupPayload; }, [buildBackupPayload]);

  // ── Backup health (v9.21) ─────────────────────────────────────────────────
  // pushBackup() swallows every failure on purpose, and that silence ran a
  // dead /backup route for nine days without one visible symptom. The retry
  // loop still shouldn't interrupt anything, so the failure doesn't get a
  // dialog. It gets the backup arrow in the header, in red. Both header arrows
  // are normally grey, so one turning red is noticeable without being readable.
  const lastOkAtRef = useRef(null);
  const [backupFailing, setBackupFailing] = useState(false);

  useEffect(() => {
    loadJSON(BACKUP_STATE_KEY, null).then(s => {
      if (s && typeof s.lastOkAt === 'number') lastOkAtRef.current = s.lastOkAt;
    }).catch(() => {});
  }, []);

  const markBackupOk = useCallback(() => {
    lastOkAtRef.current = Date.now();
    setBackupFailing(false);
    saveJSON(BACKUP_STATE_KEY, { lastOkAt: lastOkAtRef.current }).catch(() => {});
  }, []);

  // Red only once the gap is real. lastOkAt === null means this device has
  // never had a confirmed backup, which IS the alarm condition — that is the
  // exact state the app sat in from July 6 while reporting nothing.
  const markBackupFailed = useCallback(() => {
    const last = lastOkAtRef.current;
    setBackupFailing(last === null || (Date.now() - last) > BACKUP_STALE_MS);
  }, []);

  const pushBackup = useCallback(async () => {
    try {
      const payload = payloadRef.current();
      // EC-4: skip the push whenever there are no orders, not only when BOTH
      // orders and costHistory are empty. costHistory is effectively permanent,
      // so the old AND-guard let every post-wipe (or post-archive-to-empty)
      // state push a 0-order snapshot into the most-recent ring slot. Over days
      // that evicts the good buckets. A 0-order state has nothing worth saving,
      // so it never enters the ring.
      if ((payload.orders || []).length === 0) return;
      const { exportedAt, ...stable } = payload;
      const hash = String(djb2(JSON.stringify(stable)));
      // Hash match = the ring already holds exactly this data. That's a
      // confirmation, not a gap, so it counts as backed up. Otherwise an idle
      // week would slowly turn the icon red while nothing was wrong.
      if (hash === lastPushedHash.current) { markBackupOk(); return; }
      const res = await fetch(WORKER_BASE + '/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: PUBLISH_TOKEN, snapshot: payload }),
      });
      if (res.ok) { lastPushedHash.current = hash; markBackupOk(); }
      else markBackupFailed();
    } catch {
      // Offline or worker down. Next tick retries; the arrow carries the news.
      markBackupFailed();
    }
  }, [markBackupOk, markBackupFailed]);

  useEffect(() => {
    if (loading) return;
    pushBackup(); // on-open push, once data is actually loaded
    const tick = setInterval(pushBackup, 15 * 60 * 1000);
    const onVis = () => { if (document.visibilityState === 'hidden') pushBackup(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(tick); document.removeEventListener('visibilitychange', onVis); };
  }, [loading, pushBackup]);

  // ── Shared restore body (v9.20) ───────────────────────────────────────────
  // ONE implementation applied by all three restore paths (file/paste/online)
  // — previously importData and submitImport were 45-line twins, the exact
  // "same logic in N places" footgun. Validation and any confirm dialog stay
  // with the CALLER; this just applies a validated payload.
  const applyBackupPayload = useCallback(async (payload) => {
    // ── Schema forward-compat guard (v9.22) ─────────────────────────────
    // This is the REAL cross-device schema gap, not a service-worker cache:
    // Device A updates first and pushes a v2 snapshot into the shared ring.
    // Device B is still running old code (only understands v1) and restores
    // that same ring entry. Refuse before any write. An older snapshot is
    // safe — migrate it forward first.
    const snapVersion = payload && typeof payload.schemaVersion !== 'undefined' ? payload.schemaVersion : undefined;
    const compat = assessForwardCompat(snapVersion);
    if (compat.outcome === 'refuse') {
      setError(REFUSE_MESSAGE);
      return false;
    }
    const migrated = compat.outcome === 'migrate' ? migrateForward(payload, compat.storedVersion) : payload;
    payload = migrated;

    const res = await persistOrders((payload.orders || []).map(o => ({ ...o, items: stampItemCosts(o.items, 'backfilled') })));
    if (!res.ok) return false;
    if (Array.isArray(payload.shopping)) {
      setShopping(payload.shopping);
      await saveJSON(SHOPPING_KEY, payload.shopping);
    }
    if (Array.isArray(payload.weekDishes)) {
      setWeekDishes(payload.weekDishes);
      await saveJSON(WEEK_KEY, { selected: payload.weekDishes });
    }
    if (Array.isArray(payload.regulars)) {
      setRegulars(payload.regulars);
      await saveJSON(REGULARS_KEY, payload.regulars);
    }
    if (payload.inventory && typeof payload.inventory === 'object') {
      setInventory(payload.inventory);
      await saveJSON(INVENTORY_KEY, payload.inventory);
    }
    if (payload.pipelineJournal && typeof payload.pipelineJournal === 'object') {
      const pj = { version: 1, entries: payload.pipelineJournal.entries || {} };
      setPipelineJournal(pj);
      await saveJSON(PIPELINE_JOURNAL_KEY, pj);
    }
    if (payload.journal && typeof payload.journal === 'object') {
      const jr = normalizeJournal(payload.journal);
      setJournal(jr);
      await saveJSON(JOURNAL_KEY, jr);
    }
    if (typeof payload.copiesNote === 'string') {
      setCopiesNote(payload.copiesNote);
      await saveJSON(COPIES_NOTE_KEY, payload.copiesNote);
    }
    if (payload.weekLedger && typeof payload.weekLedger === 'object') {
      const wl = normalizeLedger(payload.weekLedger);
      setWeekLedger(wl);
      await saveJSON(WEEK_LEDGER_KEY, wl);
    }
    if (payload.containerInventory && typeof payload.containerInventory === 'object') {
      const cc = normalizeContainerConfig(payload.containerInventory);
      setContainerConfig(cc);
      await saveJSON(CONTAINER_INVENTORY_KEY, cc);
    }
    // Seed reconciliation on restore. A snapshot is a photograph of the DB as
    // it was up to three days ago, so it carries whatever baselines were
    // current THEN — including the stale ones this whole mechanism exists to
    // fix. Restoring without reconciling would quietly undo the boot fix and
    // put thyme back at 1144%, which is the worst version of this bug: fixed,
    // then broken again by a button labelled "restore."
    let restoreChanges = [];
    if (Array.isArray(payload.ingredientsDb)) {
      const rec = reconcileIngredients(payload.ingredientsDb, INGREDIENT_SEED);
      restoreChanges = rec.changes;
      setIngredientsDb(rec.next);
      await saveJSON(INGREDIENTS_KEY, rec.next);
    }
    if (Array.isArray(payload.costHistory)) {
      const pruned = pruneCostHistory(payload.costHistory, restoreChanges);
      setCostHistory(pruned);
      await saveJSON(COST_HISTORY_KEY, pruned);
    }
    if (payload.receiptAliases && typeof payload.receiptAliases === 'object') {
      setReceiptAliases(payload.receiptAliases);
      await saveJSON(RECEIPT_ALIASES_KEY, payload.receiptAliases);
    }
    // EC-3: restore the handled-pending ledger alongside orders. Restore rolls
    // state back to the backup point, so the ledger of what was handled THEN is
    // the correct guard: orders accepted before the backup stay suppressed;
    // orders accepted after it are rolled back and correctly re-sync as pending.
    // Only overwrite when the field is present, so restoring a pre-EC-3 backup
    // doesn't blank a good live ledger.
    if (payload.handledPending && typeof payload.handledPending === 'object') {
      handledPendingRef.current = payload.handledPending;
      await saveJSON(HANDLED_PENDING_KEY, handledPendingRef.current);
    }
    // The trail rides the snapshot, so a restore rewinds it to whatever that
    // snapshot held. That's the accepted cost of not giving it its own
    // storage. Stamp the restore itself onto the RESTORED log so the rewind
    // is visible rather than looking like history quietly changed.
    if (Array.isArray(payload.auditLog)) {
      const restored = appendAudit(payload.auditLog, [
        auditEntry({
          target: 'app', field: 'restored', from: null,
          to: (payload.orders || []).length, source: SOURCES.MANUAL,
          meta: { from: payload.exportedAt || 'unknown snapshot' },
        }),
        // Must ride THIS write. The restored log replaces the live one
        // wholesale, so reconcile entries appended anywhere else would be
        // overwritten a line later and the cost rewrite would go unrecorded.
        ...diffReconcile(restoreChanges),
      ]);
      setAuditLog(restored);
      await saveJSON(AUDIT_LOG_KEY, restored);
    }
    setExportMsg(`Imported ${(payload.orders || []).length} orders successfully.`);
    setTimeout(() => setExportMsg(null), 4000);
    setError(null);
    if (restoreChanges.length) setNotice(summarizeReconcile(restoreChanges));
    return true;
  }, [persistOrders]);

  // ── Online restore (v9.20) ────────────────────────────────────────────────
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupList, setBackupList] = useState(null); // null=loading, []=none, 'error'=unreachable

  const openBackupModal = useCallback(async () => {
    setShowBackupModal(true);
    setBackupList(null);
    try {
      const res = await fetch(WORKER_BASE + '/backup/list', { cache: 'no-store', headers: { 'X-LTB-Token': PUBLISH_TOKEN } });
      const j = await res.json();
      setBackupList(res.ok && Array.isArray(j.backups) ? j.backups : 'error');
    } catch {
      setBackupList('error');
    }
  }, []);

  const restoreFromOnline = useCallback(async (age) => {
    try {
      const res = await fetch(WORKER_BASE + '/backup?age=' + age, { cache: 'no-store', headers: { 'X-LTB-Token': PUBLISH_TOKEN } });
      const j = await res.json();
      if (!res.ok || !j.snapshot) {
        setError(j.error || 'Could not fetch that backup.');
        return;
      }
      const snap = j.snapshot;
      if (!snap.version || !Array.isArray(snap.orders)) {
        setError("That online backup doesn't look right. Nothing was changed.");
        return;
      }
      // Preview-before-apply: real timestamp, real counts, explicit warning.
      const ok = window.confirm(
        `Restore backup from ${relativeAge(j.timestamp)} (${formatDate(j.timestamp)})?\n\n` +
        `It has ${snap.orders.length} orders — you currently have ${(orders || []).length}.\n\n` +
        `This REPLACES what's on this device. Anything newer than that backup will be lost.`
      );
      if (!ok) return;
      const applied = await applyBackupPayload(snap);
      if (applied) setShowBackupModal(false);
    } catch {
      setError('Could not reach the backup server.');
    }
  }, [orders, applyBackupPayload]);

  const importData = useCallback(async (e) => {
    let json;
    if (typeof e === 'string') {
      json = e;
    } else {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      e.target.value = '';
      json = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = ev => res(ev.target.result);
        r.onerror = () => rej(new Error('Could not read file'));
        r.readAsText(file);
      });
    }
    try {
      const payload = JSON.parse(json);
      if (!payload.version || !Array.isArray(payload.orders)) {
        setError("That doesn't look like an LTB backup. Nothing was changed.");
        return;
      }
      const ok = window.confirm(
        `Import ${payload.orders.length} orders from ${payload.exportedAt?.slice(0, 10) || 'backup'}?\n\nThis will replace your current orders.`
      );
      if (!ok) return;
      await applyBackupPayload(payload);
    } catch {
      setError("Couldn't read that backup — make sure you copied the full text.");
    }
  }, [applyBackupPayload]);

  const [showImportModal, setShowImportModal] = useState(false);

  const pasteImport = useCallback(() => {
    setShowImportModal(true);
  }, []);

  const submitImport = useCallback(async (text) => {
    setShowImportModal(false);
    if (!text.trim()) return;
    try {
      const payload = JSON.parse(text.trim());
      if (!payload.version || !Array.isArray(payload.orders)) {
        setError("That doesn't look like an LTB backup. Nothing was changed.");
        return;
      }
      await applyBackupPayload(payload);
    } catch {
      setError("Couldn't read that — make sure you copied the full backup text.");
    }
  }, [applyBackupPayload]);

  const currentOrders = useMemo(() => (orders || []).filter(o => !o.archived), [orders]);
  const activeOrders = useMemo(() => currentOrders.filter(o => o.status !== 'Delivered'), [currentOrders]);
  const deliveredOrders = useMemo(() => currentOrders.filter(o => o.status === 'Delivered'), [currentOrders]);

  // V1/V2/V3: the same pipeline for both sections — status filter (active
  // section only; "Delivered" is itself a status, so the filter would be a
  // no-op there and just confuses the control), search, sort, then window.
  // Search and sort apply to both, since a name search should find someone
  // whether they're still cooking or already delivered.
  const visibleActiveOrders = useMemo(() => {
    const filtered = filterByStatus(activeOrders, orderStatusFilter);
    const searched = searchList(filtered, orderSearch, orderHaystacks);
    return sortList(searched, orderSort);
  }, [activeOrders, orderStatusFilter, orderSearch, orderSort]);
  const activeWindow = useMemo(
    () => windowList(visibleActiveOrders, showAllActive ? null : DEFAULT_WINDOW),
    [visibleActiveOrders, showAllActive]
  );

  const visibleDeliveredOrders = useMemo(() => {
    const searched = searchList(deliveredOrders, orderSearch, orderHaystacks);
    return sortList(searched, orderSort);
  }, [deliveredOrders, orderSearch, orderSort]);
  const deliveredWindow = useMemo(
    () => windowList(visibleDeliveredOrders, showAllDelivered ? null : DEFAULT_WINDOW),
    [visibleDeliveredOrders, showAllDelivered]
  );

  // P3: arm scroll restoration on any action that changes the order list.
  // Keyed on the count, since that is what changes the page height and thus
  // what moves Kevin's place out from under him.
  const preserveScroll = usePreserveScroll((orders || []).length);

  // ── V4 selection ──────────────────────────────────────────────────────────
  // Selection is scoped to what is VISIBLE. Selecting "all" while a search
  // is active must mean "all six of these", never "all three hundred
  // including the ones filtered out of sight" — a bulk action that reaches
  // past the filter is how someone marks the wrong orders paid.
  // House orders are excluded outright: they are $0 and never enter the
  // books, so "mark paid" is meaningless for them, and including them would
  // make the button's count lie about what it is going to change.
  const selectableActive = useMemo(
    () => activeWindow.shown.filter(o => !isHouseOrder(o)),
    [activeWindow]
  );
  const selectedCount = selectedIds.size;
  const toggleSelected = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(selectableActive.map(o => o.id)));
  }, [selectableActive]);
  // Leaving select mode always clears the selection: a stale selection
  // surviving out of sight is exactly how a later bulk tap hits orders
  // Kevin forgot were checked.
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  const runBulk = useCallback((fn) => {
    preserveScroll();
    fn(selectedIds);
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [preserveScroll, selectedIds]);

  // Money headline numbers exclude house orders. NOTE the filter is here and
  // NOT on currentOrders: the Week tab, cook schedule, shopping list, labels,
  // and packing slips all read currentOrders and MUST still see her orders —
  // you still buy the food and cook it. Only the money is blind to her.
  const stats = useMemo(() => {
    const billable = currentOrders.filter(o => !isHouseOrder(o));
    const booked = billable.reduce((s, o) => s + o.total, 0);
    const unpaid = billable.filter(o => !o.paid).reduce((s, o) => s + o.total, 0);
    return { active: activeOrders.length, booked: round2(booked), unpaid: round2(unpaid) };
  }, [currentOrders, activeOrders]);

  const activeFinancials = useMemo(() => {
    let revenue = 0;
    let cost = 0;
    activeOrders.forEach(o => {
      if (isHouseOrder(o)) return; // free, and her ingredients are a household expense
      revenue += o.total;
      cost += orderCostInfo(o).cost;
    });
    return { revenue: round2(revenue), cost: round2(cost), profit: round2(revenue - cost) };
  }, [activeOrders]);

  // T1: deadline countdown + this-week intake vs the trailing median. Reads
  // from ALL currentOrders (archived still counts, matching the Money tab's
  // own "archived still counts as revenue" rule), not just activeOrders.
  const deadlineMs = useMemo(() => msUntilDeadline(now), [now]);
  const intake = useMemo(() => intakeVsMedian(currentOrders, now, 5), [currentOrders, now]);

  // T2: has the business week rolled over since this device last saw it?
  const weekRollover = useMemo(() => weekRolledOver(lastSeenWeek, now), [lastSeenWeek, now]);

  // M1: the Sunday container check. Demand from every undelivered order,
  // availability from owned counts (jars via the ledger).
  const containerStatus = useMemo(
    () => containerReport(orders || [], regulars || [], containerConfig),
    [orders, regulars, containerConfig]
  );

  const recentCustomers = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const o of orders || []) {
      const name = (o.customer || '').trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
      if (names.length >= 6) break;
    }
    return names;
  }, [orders]);

  // Category is DERIVED from the menu by name rather than trusted from the
  // item, and the key is name + variant only. Orders from the customer form
  // do not carry the same category value manual entries do, so the old key
  // split one dish across two lines with two counts. See cookList.js.
  const cookingList = useMemo(
    () => buildCookList(activeOrders, FULL_MENU, Object.keys(CATEGORY_LABELS)),
    [activeOrders]
  );

  const deliverList = useMemo(() => {
    const catOrder = Object.keys(CATEGORY_LABELS);
    return activeOrders.map(o => {
      const items = (o.items || []).map((it, i) => ({
        key: `${o.id}::${i}`,
        category: it.category,
        name: it.name,
        variant: it.variant,
        qty: it.qty,
      })).sort(
        (a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category) || a.name.localeCompare(b.name)
      );
      return { orderId: o.id, customer: o.customer || 'Unnamed', items };
    }).filter(grp => grp.items.length > 0)
      .sort((a, b) => a.customer.localeCompare(b.customer));
  }, [activeOrders]);

  const toggleCheck = useCallback((key) => {
    setCookChecks(prev => {
      const next = { ...prev, [key]: !prev[key] };
      const validKeys = new Set(cookingList.map(it => it.key));
      Object.keys(next).forEach(k => { if (!validKeys.has(k)) delete next[k]; });
      saveJSON(CHECKS_KEY, next);
      return next;
    });
  }, [cookingList]);

  const resetChecks = useCallback(() => {
    setCookChecks({});
    saveJSON(CHECKS_KEY, {});
  }, []);

  const toggleDeliverCheck = useCallback((key) => {
    setDeliverChecks(prev => {
      const next = { ...prev, [key]: !prev[key] };
      const validKeys = new Set();
      deliverList.forEach(grp => grp.items.forEach(it => validKeys.add(it.key)));
      Object.keys(next).forEach(k => { if (!validKeys.has(k)) delete next[k]; });
      saveJSON(DELIVER_CHECKS_KEY, next);
      return next;
    });
  }, [deliverList]);

  const resetDeliverChecks = useCallback(() => {
    setDeliverChecks({});
    saveJSON(DELIVER_CHECKS_KEY, {});
  }, []);

  // Journal writer: accepts the next store OR an updater fn, same contract as
  // savePipelineJournal. Writes surface quota failures through saveError —
  // this is the knowledge base, and a silent lost entry is the exact failure
  // the record exists to prevent.
  const pullQuestions = useCallback(async () => {
    const r = await fetch(WORKER_BASE + '/ask-log?token=' + encodeURIComponent(PUBLISH_TOKEN));
    if (!r.ok) throw new Error('ask-log ' + r.status);
    const { questions } = await r.json();
    setAskLog(Array.isArray(questions) ? questions : []);
    return (questions || []).length;
  }, []);

  const saveContainerConfig = useCallback((next) => {
    setContainerConfig(prev => {
      const cfg = normalizeContainerConfig(typeof next === 'function' ? next(prev) : next);
      saveJSON(CONTAINER_INVENTORY_KEY, cfg).then(r => setError(saveError(r)));
      return cfg;
    });
  }, []);

  const saveJournal = useCallback((next) => {
    setJournal(prev => {
      const j = normalizeJournal(typeof next === 'function' ? next(prev) : next);
      saveJSON(JOURNAL_KEY, j).then(r => setError(saveError(r)));
      return j;
    });
  }, []);

  // Pipeline journal: full-object replace, matching the localStorage-JSON pattern.
  // RecipesTab hands back the whole next-state (add entry, set status, etc).
  const savePipelineJournal = useCallback((nextEntries) => {
    setPipelineJournal(prev => {
      const next = { version: 1, entries: typeof nextEntries === 'function' ? nextEntries(prev.entries || {}) : nextEntries };
      saveJSON(PIPELINE_JOURNAL_KEY, next);
      return next;
    });
  }, []);

  const menu = useMemo(() => buildMenu(weekDishes), [weekDishes]);

  // Every name the app still serves, for the K8 retirement nudge: anything
  // people ORDERED that falls outside this set is a dish that left the menu.
  // FULL_MENU is the whole catalog (dinners + always items, per-lb included),
  // so retired ALWAYS items nudge too — a dessert that left has a story just
  // as much as a dinner does. Static registry, so no deps.
  // Names the coverage map walks. Same set the Recipes picker offers, so
  // coverage measures exactly what Kevin can actually write about.
  const reportableDishNames = useMemo(() => reportableDishes(), []);
  const knownDishNames = useMemo(() => new Set(Object.values(FULL_MENU).flat().map(m => m.name)), []);

  // Cost maps for live dish costing (Option B). baseline is static from the seed;
  // live reflects the current edited ingredient costs.
  // Omakase whose final price is still sitting at the customer's max: the
  // deliver pass is the last honest moment to settle it.
  const undecidedOma = useMemo(() => undecidedOmakases(orders || []), [orders]);
  const omakaseUnconfirmed = useMemo(() => {
    const out = [];
    for (const o of (orders || [])) {
      if (o.archived) continue;
      if (!omakasePriceUnsettled(o)) continue;
      for (const it of (o.items || [])) {
        if (it.omakase && !it.priceConfirmed) out.push({ orderId: o.id, customer: o.customer, price: it.price || 0 });
      }
    }
    return out;
  }, [orders]);
  const confirmOmakasePrice = useCallback((orderId) => {
    setOrders(prev => {
      const next = (prev || []).map(o => (o.id === orderId
        ? { ...o, items: (o.items || []).map(it => (it.omakase ? { ...it, priceConfirmed: true } : it)) }
        : o));
      saveJSON(ORDERS_KEY, next);
      return next;
    });
  }, []);

  const baseCostMap = useMemo(() => baselineCostMap(), []);
  const liveCostMap = useMemo(() => liveCostMapFrom(ingredientsDb), [ingredientsDb]);
  // (id) => name lookup for the Money-tab margin-trend "driven by [ingredients]" line.
  const ingredientName = useMemo(() => {
    const m = new Map((ingredientsDb || []).map(i => [i.id, i.name]));
    return (id) => m.get(id) || id;
  }, [ingredientsDb]);
  // Money-tab badge: under-floor dishes only (not "watch") so the badge
  // means something and clears when the real problem is fixed, not when
  // every borderline dish happens to drift above 47%.
  const toggleWeekDish = useCallback((name) => {
    setWeekDishes(prev => {
      const next = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
      saveJSON(WEEK_KEY, { selected: next }).then(res => setError(saveError(res)));
      return next;
    });
  }, []);

  const generateShopping = useCallback((staples) => {
    setShopping(prev => {
      const next = buildAutoShoppingRows(activeOrders, staples, prev, uid);
      saveJSON(SHOPPING_KEY, next).then(res => setError(saveError(res)));
      return next;
    });
  }, [activeOrders]);

  // NOTE (Jul 10, Kevin's explicit request): the shopping list is MANUAL-REFRESH
  // ONLY. Do NOT re-add any effect that auto-regenerates it when orders change.
  // Auto-regen wiped his in-progress list mid-shop (find an item missing today,
  // come back tomorrow, list rebuilt from scratch and lost his progress). The
  // list rebuilds ONLY when he taps the Refresh button. Leave it that way.

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingText}>Loading orders...</div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {storageFull && (
        <div style={{ background: '#3a1f22', borderBottom: '1px solid #E24B4A', padding: '9px 12px', fontSize: 12.5, color: '#ffd9d9', lineHeight: 1.5 }}>
          <b>Storage is full and changes are not saving.</b> Delete some order photos to free space, then reload. Nothing already saved has been lost.
        </div>
      )}
      {!storageFull && storageBytes > 4 * 1024 * 1024 && (
        <div style={{ background: 'rgba(212,160,80,0.10)', borderBottom: '1px solid #D4A050', padding: '7px 12px', fontSize: 12, color: '#e8ede9' }}>
          Storage is at {(storageBytes / (1024 * 1024)).toFixed(1)}MB of about 5MB. Order photos take the most room.
        </div>
      )}
      {swUpdate && (
        <div
          onClick={() => window.location.reload()}
          style={{ background: 'rgba(93,202,165,0.12)', borderBottom: '1px solid #5DCAA5', padding: '8px 12px', fontSize: 12.5, color: '#e8ede9', cursor: 'pointer' }}
        >
          A new version is ready. <b>Tap to reload.</b>
        </div>
      )}
      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.logoMark}>LTB</div>
          <div style={styles.headerCenter}>
            <div style={styles.title}>Order tracker</div>
            <div style={styles.subtitle}>Lettuce, Turnip, The Beet · v10.0-GH</div>
          </div>
          <div style={styles.headerActions}>
            {VAPID_PUBLIC_KEY && notifPerm !== 'granted' && notifPerm !== 'unsupported' && (
              <button
                style={{ ...styles.headerActionBtn, color: notifPerm === 'denied' ? '#993556' : GOLD }}
                onClick={enablePushNotifications}
                title={notifPerm === 'denied' ? 'Notifications blocked — enable in Settings' : 'Enable order notifications'}
              >
                <Bell size={16} />
              </button>
            )}
            <button
              style={{ ...styles.headerActionBtn, ...(backupFailing ? { color: '#E24B4A' } : {}) }}
              onClick={openBackupModal}
              title={backupFailing ? "Backups are failing — tap for detail" : "Backup & restore"}
            >
              <Download size={16} />
            </button>
            <button style={styles.headerActionBtn} onClick={pasteImport} title="Paste backup from clipboard">
              <Upload size={16} />
            </button>
          </div>
        </div>
        {exportMsg && <div style={styles.exportMsg}>{exportMsg}</div>}
        {notice && (
          <button
            onClick={() => setNotice(null)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
              background: '#2a2f2d', border: '1px solid ' + GOLD, borderRadius: 8,
              padding: '10px 12px', margin: '8px 0', color: '#F5F0E8',
              fontSize: 12, lineHeight: 1.45, font: 'inherit',
            }}
          >
            {notice}
            <span style={{ display: 'block', marginTop: 4, color: '#5F5E5A', fontSize: 11 }}>
              Tap to dismiss
            </span>
          </button>
        )}
        <nav style={{ borderBottom: '1px solid #2d3a36' }}>
          <div style={{ display: 'flex' }}>
            {[
              ['orders', 'Orders'],
              ['cook', 'Cook'],
              ['shop', 'Shop'],
              ['ingredients', 'Ingredients'],
            ].map(([key, label]) => (
              <button
                key={key}
                style={{ ...styles.tab, ...(view === key ? styles.tabActive : {}), flex: 1 }}
                onClick={() => setView(key)}
              >
                {label}
                {key === 'orders' && stats.active > 0 && <span style={styles.tabBadge}>{stats.active}</span>}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', borderTop: '1px solid #2d3a36' }}>
            {[
              ['money', 'Money'],
              ['regulars', 'Regulars'],
              ['recipes', 'Recipes'],
              ['record', 'Record'],
              ['week', 'Week'],
            ].map(([key, label]) => (
              <button
                key={key}
                style={{ ...styles.tab, ...(view === key ? styles.tabActive : {}), flex: 1, borderBottom: 'none' }}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      {error && (
        <button
          style={styles.errorBanner}
          onClick={async () => {
            const res = await saveJSON(ORDERS_KEY, orders || []);
            setError(saveError(res));
            if (res.ok) {
              setExportMsg('Saved.');
              setTimeout(() => setExportMsg(null), 2500);
            }
          }}
        >
          {error}
          <span style={styles.errorRetry}>Tap to retry saving</span>
        </button>
      )}
      {showImportModal && (
        <ImportModal onSubmit={submitImport} onCancel={() => setShowImportModal(false)} />
      )}
      {showBackupModal && (
        <BackupModal
          list={backupList}
          onRestore={restoreFromOnline}
          onRestoreFile={importData}
          onDownloadFile={downloadBackupFile}
          onCopy={copyBackupToClipboard}
          onClose={() => setShowBackupModal(false)}
        />
      )}

      {linkPrompt && (
        <LinkRegularPrompt
          order={linkPrompt.order}
          candidates={linkPrompt.candidates}
          onLink={(regularId) => {
            linkOrderToRegular(regularId, linkPrompt.order.id);
            const reg = regulars.find(r => r.id === regularId);
            if (reg) {
              const patch = { regularId };
              // House beats any lifetime discount: the flag means free.
              const housePatch = houseOrderPatch(reg);
              if (housePatch) {
                Object.assign(patch, housePatch);
                patch.total = orderTotal(linkPrompt.order.items, linkPrompt.order.jarSwaps, linkPrompt.order.containerReturns, 'percent', HOUSE_DISCOUNT_PERCENT, linkPrompt.order.customCharges, linkPrompt.order.waiveSurcharge);
              } else if (reg.discountPercent > 0) {
                patch.discountType = 'percent';
                patch.discountValue = reg.discountPercent;
                patch.total = orderTotal(linkPrompt.order.items, linkPrompt.order.jarSwaps, linkPrompt.order.containerReturns, 'percent', reg.discountPercent, linkPrompt.order.customCharges, linkPrompt.order.waiveSurcharge);
              }
              updateOrder(linkPrompt.order.id, patch);
              // Auto-fill blank address/phone on partial-match confirm
              autoFillRegularContact(reg, linkPrompt.order);
            }
            setLinkPrompt(null);
          }}
          onSkip={() => setLinkPrompt(null)}
        />
      )}

      <main style={styles.main}>
        {view === 'orders' && (
          <>
            {/* T2: week rollover — dismissed by tap, not silently, not by a
                timer (same rule as `notice` below: don't let the telling
                expire before Kevin has read it). */}
            {weekRollover.rolled && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'rgba(93,202,165,0.10)', border: '1px solid #2f6f57', borderRadius: 10, padding: '9px 12px', marginBottom: 10 }}>
                <span style={{ fontSize: 12.5, color: '#e8ede9' }}>New business week: {weekRollover.currentLabel}.</span>
                <button
                  onClick={() => markWeekSeen(weekRollover.currentStamp)}
                  style={{ minHeight: 32, padding: '4px 12px', borderRadius: 6, border: '1px solid #2f6f57', background: 'transparent', color: '#5DCAA5', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                >
                  Got it
                </button>
              </div>
            )}
            {/* M1: the Sunday check. Fires only on a genuine shortage —
                next week's pack needs more of a type than Kevin owns
                (jars: owns minus held). Silent otherwise. */}
            {containerStatus.shortages.length > 0 && (
              <div style={{ background: 'rgba(224,130,138,0.10)', border: '1px solid #e0828a', borderRadius: 10, padding: '9px 12px', marginBottom: 10, fontSize: 12.5, color: '#e8ede9' }}>
                <b style={{ color: '#e0828a' }}>Short on containers for this pack:</b>
                {' '}{containerStatus.shortages.map(s => `${s.label} — need ${s.need}, have ${s.have}`).join(' · ')}.
                {containerStatus.mealOut > 0 ? ` ${containerStatus.mealOut} meal container${containerStatus.mealOut !== 1 ? 's' : ''} still out with customers — some may come back before Wednesday.` : ''}
                {' '}Counts live in Money → Packaging.
              </div>
            )}
            {/* T1: Sunday deadline pressure + intake vs a normal week. Pure
                information, never blocking — Kevin already knows his own
                deadline; this just puts the countdown where he's looking. */}
            {deadlineMs > 0 && deadlineMs < 3 * 86400000 && (
              <div style={{ background: 'rgba(212,160,80,0.10)', border: '1px solid #D4A050', borderRadius: 10, padding: '9px 12px', marginBottom: 10, fontSize: 12.5, color: '#e8ede9' }}>
                <b style={{ color: '#D4A050' }}>Orders close in {formatCountdown(deadlineMs)}.</b>
                {' '}{intake.thisWeekCount} order{intake.thisWeekCount !== 1 ? 's' : ''} so far this week
                {intake.median != null ? (
                  intake.thisWeekCount < intake.median
                    ? `, below the usual ${intake.median} — a normal week still has time to catch up.`
                    : `, at or above the usual ${intake.median}.`
                ) : '.'}
              </div>
            )}
            <StatsBar stats={stats} />

            {!formMode && !showPaste && !showAmend && !showCsv && (
              <div style={styles.topActions}>
                <button style={styles.newOrderBtn} onClick={() => setFormMode('new')}>
                  <Plus size={18} />
                  New order
                </button>
                <button style={styles.pasteBtn} onClick={() => setShowPaste(true)}>
                  <ClipboardPaste size={18} />
                  Paste a text
                </button>
                <button style={styles.amendBtn} onClick={() => setShowAmend(true)}>
                  <Pencil size={16} />
                  Amend via text
                </button>
                {USE_LEGACY_CSV && (
                  <button style={styles.csvBtn} onClick={() => setShowCsv(true)}>
                    <FileText size={16} />
                    Import from sheet
                  </button>
                )}
                {USE_LEGACY_CSV && (
                  <button
                    style={styles.checkFormBtn}
                    onClick={checkFormNow}
                    onContextMenu={(e) => { e.preventDefault(); resetRecentSeenRows(); }}
                    onTouchStart={(e) => {
                      const t = setTimeout(() => resetRecentSeenRows(), 700);
                      e.currentTarget._ltbLongPress = t;
                    }}
                    onTouchEnd={(e) => { clearTimeout(e.currentTarget._ltbLongPress); }}
                    onTouchMove={(e) => { clearTimeout(e.currentTarget._ltbLongPress); }}
                    disabled={checkingForm}
                  >
                    <RotateCcw size={16} style={checkingForm ? styles.spinning : undefined} />
                    {checkingForm ? 'Checking...' : 'Check for new orders'}
                  </button>
                )}
              </div>
            )}

            {showPaste && (
              <PasteOrderCard
                menu={menu}
                onParsed={(draft) => { setShowPaste(false); setFormMode(draft); }}
                onCancel={() => setShowPaste(false)}
              />
            )}

            {showAmend && (
              <AmendOrderCard
                menu={menu}
                orders={activeOrders}
                onAmended={(draft) => { setShowAmend(false); setFormMode(draft); }}
                onCancel={() => setShowAmend(false)}
              />
            )}

            {showCsv && (
              <CsvImportCard
                menu={menu}
                onImport={importOrders}
                onCancel={() => setShowCsv(false)}
              />
            )}

            {formMode && (
              <OrderForm
                menu={menu}
                initial={formMode === 'new' ? null : formMode}
                recentCustomers={recentCustomers}
                regulars={regulars}
                orders={orders || []}
                weekDishes={weekDishes}
                perLbLiveCost={liveCostMap}
                onSave={saveOrder}
                onCancel={() => setFormMode(null)}
              />
            )}

            {activeOrders.length === 0 && !formMode && !showPaste && pendingOrders.length === 0 && (
              <div style={styles.emptyState}>
                <div style={styles.emptyTitle}>No active orders</div>
                <div style={styles.emptyBody}>Tap "New order" to build one, "Paste a text" to auto-read an order, or "Import from sheet" to pull in Google Form orders.</div>
              </div>
            )}

            {pendingFeedback.length > 0 && !formMode && !showPaste && !showCsv && (
              <div style={styles.pendingSection}>
                <div style={styles.pendingSectionHeader}>
                  <span style={{ ...styles.pendingBadge, background: GOLD, color: '#1a1a1a' }}>{pendingFeedback.length}</span>
                  <span style={styles.pendingSectionTitle}>Dish feedback</span>
                </div>
                {pendingFeedback.map(entry => (
                  <FeedbackCard key={entry.id} entry={entry} onSave={saveFeedbackEntry} onIgnore={ignoreFeedbackEntry} />
                ))}
              </div>
            )}

            {pendingOrders.length > 0 && !formMode && !showPaste && !showCsv && (
              <div style={styles.pendingSection}>
                <div style={styles.pendingSectionHeader}>
                  <span style={styles.pendingBadge}>{pendingOrders.length}</span>
                  <span style={styles.pendingSectionTitle}>Pending form order{pendingOrders.length !== 1 ? 's' : ''}</span>
                </div>
                {pendingOrders.map((p, idx) => (
                  showPendingIdx === idx ? (
                    <div key={p.pendingId} style={styles.pendingCard}>
                      <div style={styles.pendingCardHeader}>
                        <div style={styles.pendingCardName}>{p.customer}</div>
                        <div style={styles.pendingCardTime}>{p.timestamp}</div>
                        {(p.address || p.phone) && (
                          <div style={styles.pendingContactRow}>
                            {p.address && <span style={styles.pendingContact}>📍 {p.address}</span>}
                            {p.phone && <span style={styles.pendingContact}>📞 {p.phone}</span>}
                          </div>
                        )}
                      </div>
                      <div style={styles.pendingItemList}>
                        {p.items.map((it, i) => (
                          <div key={i} style={styles.pendingItem}>
                            <span style={styles.pendingItemName}>{it.name}</span>
                            {it.variant && <span style={styles.pendingItemVariant}> — {it.variant}</span>}
                            <span style={styles.pendingItemPrice}> ${it.price.toFixed(2)}</span>
                            {optionsSummary(it) && <span style={{ ...styles.pendingItemVariant, color: TEAL_LIGHT, fontWeight: 700 }}> · {optionsSummary(it)}</span>}
                            {noteWithoutOptions(it.note) && <span style={styles.pendingItemVariant}> · “{noteWithoutOptions(it.note)}”</span>}
                            {itemAddons(it).map((a, ai) => (
                              <div key={ai} style={{ ...styles.pendingItemVariant, display: 'block', marginLeft: 10, color: GOLD }}>
                                + {a.request} <span style={{ fontStyle: 'italic', opacity: 0.85 }}>(at cost, price pending)</span>
                              </div>
                            ))}
                          </div>
                        ))}
                        {(() => {
                          // Accept is the last moment a money mistake is cheap,
                          // and it was blind. Omakase carries cost 0 until it is
                          // logged, so it is held out of the margin rather than
                          // flattering it.
                          const items = p.items || [];
                          const priced = items.filter(it => !it.omakase);
                          const hasOma = items.some(it => it.omakase);
                          const rev = items.reduce((n, it) => n + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
                          const pRev = priced.reduce((n, it) => n + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
                          const pCost = priced.reduce((n, it) => n + (Number(it.cost) || 0) * (Number(it.qty) || 1), 0);
                          const pct = pRev > 0 ? Math.round((1 - pCost / pRev) * 100) : null;
                          if (!items.length) return null;
                          return (
                            <div style={{ fontSize: 11.5, color: '#9aa5a0', marginTop: 6, paddingTop: 6, borderTop: '1px solid #2a332f' }}>
                              Revenue {currency(rev)} · est. cost {currency(pCost)}
                              {pct != null ? ` · ~${pct}% margin` : ''}
                              {hasOma ? ' · omakase cost TBD, not counted' : ''}
                            </div>
                          );
                        })()}
                        {p.notes && (
                          <div style={styles.pendingNotesSection}>
                            <div style={styles.pendingNotes}>Notes: {p.notes}</div>
                            {parsedNotes[p.pendingId] ? (
                              <div style={styles.parsedNotesCard}>
                                <div style={styles.parsedNotesTitle}>AI interpretation</div>
                                {parsedNotes[p.pendingId].summary && (
                                  <div style={styles.parsedNotesSummary}>{parsedNotes[p.pendingId].summary}</div>
                                )}
                                {['spice','substitutions','extras','delivery','other'].map(k =>
                                  parsedNotes[p.pendingId][k] ? (
                                    <div key={k} style={styles.parsedNotesItem}>
                                      <span style={styles.parsedNotesKey}>{k}:</span> {parsedNotes[p.pendingId][k]}
                                    </div>
                                  ) : null
                                )}
                              </div>
                            ) : (
                              <button
                                style={styles.parseNotesBtn}
                                disabled={parsingNotes === p.pendingId}
                                onClick={async () => {
                                  setParsingNotes(p.pendingId);
                                  const result = await parseFormNotes(p.notes);
                                  if (result) setParsedNotes(prev => ({ ...prev, [p.pendingId]: result }));
                                  setParsingNotes(null);
                                }}
                              >
                                {parsingNotes === p.pendingId ? 'Parsing...' : 'Parse notes with AI'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <div style={styles.pendingActions}>
                        <button style={styles.pendingAcceptBtn} onClick={() => acceptPending(p)}>
                          <Check size={16} /> Accept
                        </button>
                        <button style={styles.pendingRejectBtn} onClick={() => dismissPending(p.pendingId)}>
                          <X size={16} /> Reject
                        </button>
                        <button style={styles.pendingBackBtn} onClick={() => setShowPendingIdx(null)}>
                          Back
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button key={p.pendingId} style={styles.pendingRow} onClick={() => setShowPendingIdx(idx)}>
                      <span style={styles.pendingRowName}>{p.customer}</span>
                      <span style={styles.pendingRowCount}>{p.items.length} item{p.items.length !== 1 ? 's' : ''}</span>
                      <ChevronDown size={16} />
                    </button>
                  )
                ))}
              </div>
            )}

            {undecidedOma.length > 0 && (
              <div style={{ background: 'rgba(212,160,80,0.10)', border: '1px solid #D4A050', borderRadius: 10, padding: '8px 10px', marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#D4A050' }}>Omakase undecided: </span>
                <span style={{ fontSize: 12, color: '#e8ede9' }}>
                  {undecidedOma.map(u => `${u.customer} (${new Date(u.createdAt).toLocaleDateString()})`).join(', ')}
                </span>
              </div>
            )}

            {/* V1/V2/V3: sort, status filter, and search — the same list is
                one house or three hundred, and this is what keeps it from
                becoming a scroll marathon at scale. */}
            {(activeOrders.length > 6 || deliveredOrders.length > 6) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                <input
                  value={orderSearch}
                  onChange={e => setOrderSearch(e.target.value)}
                  placeholder="Search name, dish, or note…"
                  style={{ ...styles.input, flex: '1 1 160px', minWidth: 140, padding: '8px 10px', fontSize: 13 }}
                />
                <select
                  value={orderSort}
                  onChange={e => setOrderSort(e.target.value)}
                  style={{ background: '#1a1a1a', border: '1px solid #37403c', borderRadius: 8, color: CREAM, fontSize: 12.5, padding: '8px 8px', minHeight: 36 }}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">By name</option>
                  <option value="unpaidFirst">Unpaid first</option>
                  <option value="status">By status</option>
                </select>
                {STATUSES.length > 0 && (
                  <select
                    value={orderStatusFilter || ''}
                    onChange={e => setOrderStatusFilter(e.target.value || null)}
                    style={{ background: '#1a1a1a', border: '1px solid #37403c', borderRadius: 8, color: CREAM, fontSize: 12.5, padding: '8px 8px', minHeight: 36 }}
                  >
                    <option value="">All statuses</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
                <button
                  onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                  style={{ minHeight: 36, padding: '7px 12px', borderRadius: 8, border: `1px solid ${selectMode ? GOLD : '#37403c'}`, background: selectMode ? 'rgba(212,160,80,0.15)' : 'transparent', color: selectMode ? GOLD : '#9aa5a0', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}
                >
                  {selectMode ? 'Done' : 'Select'}
                </button>
              </div>
            )}

            {/* V4: the bulk bar. Only appears in select mode, and every
                button names the exact count it will affect — a bulk action
                that does not say how many is a bulk action you check twice. */}
            {selectMode && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', background: 'rgba(212,160,80,0.08)', border: '1px solid #D4A050', borderRadius: 10, padding: '8px 10px', marginBottom: 10 }}>
                <span style={{ fontSize: 12.5, color: '#e8ede9', fontWeight: 700 }}>
                  {selectedCount} selected
                </span>
                <button
                  onClick={selectAllVisible}
                  style={{ minHeight: 36, padding: '6px 10px', borderRadius: 7, border: '1px solid #37403c', background: 'transparent', color: '#9aa5a0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Select all {selectableActive.length} shown
                </button>
                {selectedCount > 0 && (
                  <button
                    onClick={clearSelection}
                    style={{ minHeight: 36, padding: '6px 10px', borderRadius: 7, border: '1px solid #37403c', background: 'transparent', color: '#9aa5a0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Clear
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <button
                  disabled={selectedCount === 0}
                  onClick={() => runBulk(bulkMarkPaid)}
                  style={{ minHeight: 44, padding: '9px 14px', borderRadius: 8, border: 'none', background: selectedCount ? '#2f6f57' : '#232d2a', color: selectedCount ? '#fff' : '#5a635f', fontWeight: 700, fontSize: 12.5, cursor: selectedCount ? 'pointer' : 'default' }}
                >
                  Mark {selectedCount || ''} paid
                </button>
                <button
                  disabled={selectedCount === 0}
                  onClick={() => runBulk(bulkArchive)}
                  style={{ minHeight: 44, padding: '9px 14px', borderRadius: 8, border: `1px solid ${selectedCount ? '#37403c' : '#232d2a'}`, background: 'transparent', color: selectedCount ? '#9aa5a0' : '#5a635f', fontWeight: 700, fontSize: 12.5, cursor: selectedCount ? 'pointer' : 'default' }}
                >
                  Archive {selectedCount || ''}
                </button>
              </div>
            )}

            <div style={styles.orderList}>
              {activeWindow.shown.map(order => {
                const house = isHouseOrder(order);
                const card = (
                  <ErrorBoundary key={order.id} compact label={order.customer || order.id} raw={order}>
                  <OrderCard allOrders={orders || []} perLbLiveCost={liveCostMap} weekDishes={weekDishes}
                    key={order.id}
                    order={order}
                    regulars={regulars}
                    expanded={expandedOrder === order.id}
                    onToggle={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                    onUpdate={(patch) => { preserveScroll(); updateOrder(order.id, patch); }}
                    onDelete={() => { preserveScroll(); deleteOrder(order.id); }}
                    onEdit={() => { setFormMode(order); setExpandedOrder(null); }}
                    onMakeRegular={makeRegularFromOrder}
                    onLinkRegular={linkOrderWithAlias}
                  />
                  </ErrorBoundary>
                );
                if (!selectMode) return card;
                // A house order shows in the list but cannot be selected:
                // $0 and outside the books, so both bulk actions are
                // meaningless for it. Greyed rather than hidden, so the
                // list Kevin sees in select mode is still the list he
                // knows.
                return (
                  <div key={order.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <button
                      onClick={() => !house && toggleSelected(order.id)}
                      aria-label={house ? 'House orders cannot be selected' : 'Select order'}
                      style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: house ? 'default' : 'pointer', flexShrink: 0, opacity: house ? 0.3 : 1 }}
                    >
                      <span style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${selectedIds.has(order.id) ? GOLD : '#5F5E5A'}`, background: selectedIds.has(order.id) ? GOLD : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {selectedIds.has(order.id) && <Check size={13} color="#1a1a1a" />}
                      </span>
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>{card}</div>
                  </div>
                );
              })}
              {activeWindow.hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllActive(true)}
                  style={{ width: '100%', minHeight: 44, marginTop: 6, padding: '10px', borderRadius: 8, border: '1px dashed #37403c', background: 'transparent', color: '#9aa5a0', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}
                >
                  Show {activeWindow.hiddenCount} older order{activeWindow.hiddenCount !== 1 ? 's' : ''}
                </button>
              )}
              {activeWindow.total === 0 && (orderSearch || orderStatusFilter) && (
                <div style={{ ...styles.emptyBody, textAlign: 'center', padding: '14px 0' }}>No orders match.</div>
              )}
            </div>

            {deliveredOrders.length > 0 && (
              <details style={styles.deliveredSection}>
                <summary style={styles.deliveredSummary}>
                  Delivered ({deliveredOrders.length})
                </summary>
                <div style={styles.orderList}>
                  {deliveredWindow.shown.map(order => (
                    <ErrorBoundary key={order.id} compact label={order.customer || order.id} raw={order}>
                    <OrderCard allOrders={orders || []} perLbLiveCost={liveCostMap} weekDishes={weekDishes}
                      key={order.id}
                      order={order}
                      regulars={regulars}
                      expanded={expandedOrder === order.id}
                      onToggle={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}
                      onUpdate={(patch) => { preserveScroll(); updateOrder(order.id, patch); }}
                      onDelete={() => { preserveScroll(); deleteOrder(order.id); }}
                      onEdit={() => { setFormMode(order); setExpandedOrder(null); }}
                      onMakeRegular={makeRegularFromOrder}
                      onLinkRegular={linkOrderWithAlias}
                    />
                    </ErrorBoundary>
                  ))}
                  {deliveredWindow.hiddenCount > 0 && (
                    <button
                      onClick={() => setShowAllDelivered(true)}
                      style={{ width: '100%', minHeight: 44, marginTop: 6, padding: '10px', borderRadius: 8, border: '1px dashed #37403c', background: 'transparent', color: '#9aa5a0', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}
                    >
                      Show {deliveredWindow.hiddenCount} more delivered order{deliveredWindow.hiddenCount !== 1 ? 's' : ''}
                    </button>
                  )}
                </div>
                <ArchiveDeliveredButton count={deliveredOrders.length} onArchive={archiveDelivered} />
              </details>
            )}
          </>
        )}

        {view === 'cook' && (
          <>
            <div style={styles.cookSubToggle}>
              <button
                style={{ ...styles.cookSubBtn, ...(cookSubView === 'cook' ? styles.cookSubBtnActive : {}) }}
                onClick={() => setCookSubView('cook')}
              >
                Cook
              </button>
              <button
                style={{ ...styles.cookSubBtn, ...(cookSubView === 'deliver' ? styles.cookSubBtnActive : {}) }}
                onClick={() => setCookSubView('deliver')}
              >
                Deliver
              </button>
            </div>
            {cookSubView === 'cook' ? (
              <CookingList
                items={cookingList}
                orderCount={activeOrders.length}
                revenue={activeFinancials.revenue}
                checks={cookChecks}
                onToggle={toggleCheck}
                onReset={resetChecks}
              />
            ) : (
              <DeliverList
                omakaseUnconfirmed={omakaseUnconfirmed}
                onConfirmOmakase={confirmOmakasePrice}
                groups={deliverList}
                orderCount={activeOrders.length}
                checks={deliverChecks}
                onToggle={toggleDeliverCheck}
                onReset={resetDeliverChecks}
              />
            )}
          </>
        )}

        {view === 'shop' && (
          <ShoppingList
            items={shopping}
            onChange={persistShopping}
            onGenerate={generateShopping}
            includeStaples={includeStaples}
            onToggleStaples={(v) => { setIncludeStaples(v); localStore.set('ltb_staples_pref', v ? '1' : '0'); }}
            activeCount={activeOrders.length}
            estCost={activeFinancials.cost}
            weekDishes={weekDishes}
            inventory={inventory}
            onAdjustInventory={adjustInventory}
            onSetInventory={setInventoryCount}
          />
        )}

        {view === 'money' && (
          <>
            <MoneyTab orders={orders || []} onUpdate={updateOrder} auditLog={auditLog} costHistory={costHistory} baseCostMap={baseCostMap} ingredientName={ingredientName} containerStatus={containerStatus} onSaveContainerConfig={saveContainerConfig} />
            <DigestPanel orders={orders || []} regulars={regulars} liveCostMap={liveCostMap} baseCostMap={baseCostMap} onPullFeedback={pullKitchenFeedback} onCloseOut={closeOutWeek} />
          </>
        )}

        {view === 'record' && (
          <RecordTab
            journal={journal}
            onSaveJournal={saveJournal}
            dishNames={reportableDishNames}
            weekDishes={weekDishes}
            orders={orders || []}
            knownNames={knownDishNames}
            weekLedger={weekLedger}
            askLog={askLog}
            onPullQuestions={pullQuestions}
            copiesNote={copiesNote}
            onSaveCopiesNote={saveCopiesNote}
          />
        )}

        {view === 'recipes' && (
          <RecipesTab auditLog={auditLog}
            dishFeedback={dishFeedback}
            onResetDishFeedback={resetDishFeedbackTally}
            liveCostMap={liveCostMap}
            baseCostMap={baseCostMap}
            costHistory={costHistory}
            journal={journal}
            onSaveJournal={saveJournal}
            knownNames={knownDishNames}
            weekDishes={weekDishes}
            orders={orders || []}
            pipelineJournal={pipelineJournal}
            onSavePipelineJournal={savePipelineJournal}
          />
        )}

        {view === 'regulars' && (
          <>
            <RegularsTab
              regulars={regulars}
              orders={orders || []}
              onAdd={addRegular}
              onUpdate={updateRegular}
              onDelete={deleteRegular}
              onLink={linkOrderToRegular}
              onUnlink={unlinkOrderFromRegular}
            />
            <RegularsIntelPanel orders={orders || []} regulars={regulars} weekDishes={weekDishes} onMerge={doMergeRegulars} onUnmerge={doUnmergeRegular} onUpdateRegular={updateRegular} onBackfill={runBackfill} onLinkSuggestion={linkSuggestionToRegular} />
          </>
        )}

        {view === 'week' && (
          <>
            <WeekTab selected={weekDishes} onToggle={toggleWeekDish} onPublish={publishWeek} liveCostMap={liveCostMap} baseCostMap={baseCostMap} orders={orders || []} dishFeedback={dishFeedback} onFetchHistory={fetchConfigHistory} onRestoreConfig={restoreConfig} />
            <PlannerPanel orders={orders || []} weekDishes={weekDishes} liveCostMap={liveCostMap} baseCostMap={baseCostMap} />
            <SchedulePanel orders={orders || []} />
            <div style={{ margin: '10px 0 24px' }}>
              <button
                onClick={() => setShowLabels(true)}
                style={{ width: '100%', padding: '11px', borderRadius: 10, border: '1px solid #2d3a36', background: '#1c2422', color: '#5DCAA5', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
              >
                Print bag labels + packing slips
              </button>
            </div>
            {showLabels && <LabelsSheet orders={orders || []} onClose={() => setShowLabels(false)} />}
          </>
        )}

        {view === 'ingredients' && (
          <IngredientsTab ingredients={ingredientsDb} costHistory={costHistory} onChange={updateIngredients} onScanReceipt={() => { setDebugScan(false); setShowReceiptScan(true); }} onDebugScan={() => { setDebugScan(true); setShowReceiptScan(true); }} aliases={receiptAliases} onSaveAliases={saveReceiptAliases} />
        )}
      </main>

      {showReceiptScan && (
        <ReceiptScan
          ingredients={ingredientsDb}
          costHistory={costHistory}
          aliases={receiptAliases}
          onSaveAliases={saveReceiptAliases}
          onCommit={commitReceiptCosts}
          onClose={() => { setShowReceiptScan(false); setDebugScan(false); }}
          debug={debugScan}
        />
      )}
    </div>
  );
}

// ── Backup helpers + modal (v9.20) ──────────────────────────────────────────
// djb2 string hash — throttles auto-push (skip identical payloads). Not
// crypto, just cheap change detection.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// "26 hours ago" style honesty for the restore picker — never pretend a
// snapshot is exactly the age Kevin asked for.
function relativeAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.round(ms / 60e3);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(ms / 3600e3);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(ms / 86400e3)} days ago`;
}

// The four approximate restore targets, resolved against the REAL list:
// each option shows the actual nearest snapshot's true age, and options
// that resolve to the same snapshot collapse into one (no fake choices).
function resolveRestoreOptions(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const now = Date.now();
  const targets = [
    { age: 'recent', label: 'Most recent', ms: 0 },
    { age: '1h', label: 'About 1 hour ago', ms: 3600e3 },
    { age: '1d', label: 'About 1 day ago', ms: 24 * 3600e3 },
    { age: '3d', label: 'About 3 days ago', ms: 72 * 3600e3 },
  ];
  const seen = new Set();
  const options = [];
  for (const t of targets) {
    let best = null;
    let bestDiff = Infinity;
    for (const b of list) {
      const diff = Math.abs((now - Date.parse(b.timestamp)) - t.ms);
      if (diff < bestDiff) { bestDiff = diff; best = b; }
    }
    if (!best || seen.has(best.timestamp)) continue;
    seen.add(best.timestamp);
    options.push({ ...t, timestamp: best.timestamp, orders: best.orders });
  }
  return options;
}

function BackupModal({ list, onRestore, onRestoreFile, onDownloadFile, onCopy, onClose }) {
  const m = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
    box: { background: '#1c2422', border: '1px solid #2d3a36', borderRadius: 12, padding: 18, width: '100%', maxWidth: 420, maxHeight: '85vh', overflowY: 'auto', color: '#e8e6df' },
    h: { margin: '0 0 4px', fontSize: 17, fontWeight: 700 },
    sub: { margin: '0 0 14px', fontSize: 12.5, color: '#9aa5a0', lineHeight: 1.45 },
    section: { fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#9aa5a0', margin: '16px 0 8px' },
    opt: { display: 'block', width: '100%', textAlign: 'left', background: '#232d2a', border: '1px solid #2d3a36', borderRadius: 10, padding: '10px 12px', marginBottom: 8, color: '#e8e6df', cursor: 'pointer' },
    optTitle: { fontSize: 14.5, fontWeight: 600 },
    optMeta: { fontSize: 12, color: '#9aa5a0', marginTop: 2 },
    row: { display: 'flex', gap: 8 },
    smallBtn: { flex: 1, background: '#232d2a', border: '1px solid #2d3a36', borderRadius: 10, padding: '10px 8px', color: '#e8e6df', fontSize: 13.5, cursor: 'pointer' },
    close: { display: 'block', width: '100%', marginTop: 14, background: 'none', border: 'none', color: '#9aa5a0', fontSize: 14, padding: 8, cursor: 'pointer' },
    note: { fontSize: 12, color: '#9aa5a0', lineHeight: 1.45 },
    fileLabel: { display: 'block', width: '100%', textAlign: 'center', background: '#232d2a', border: '1px solid #2d3a36', borderRadius: 10, padding: '10px 8px', color: '#e8e6df', fontSize: 13.5, cursor: 'pointer', boxSizing: 'border-box' },
  };
  const options = Array.isArray(list) ? resolveRestoreOptions(list) : [];
  return (
    <div style={m.overlay} onClick={onClose}>
      <div style={m.box} onClick={e => e.stopPropagation()}>
        <h3 style={m.h}>Backup &amp; Restore</h3>
        <p style={m.sub}>The app backs itself up online automatically while it's open. Restoring replaces what's on this device.</p>

        <div style={m.section}>Restore from online</div>
        {list === null && <div style={m.note}>Checking for backups…</div>}
        {list === 'error' && <div style={m.note}>Couldn't reach the backup server. You can still restore from a file below.</div>}
        {Array.isArray(list) && options.length === 0 && <div style={m.note}>No online backups yet. They'll start appearing after the app has been open with data in it.</div>}
        {options.map(o => (
          <button key={o.age} style={m.opt} onClick={() => onRestore(o.age)}>
            <div style={m.optTitle}>{o.label}</div>
            <div style={m.optMeta}>
              {relativeAge(o.timestamp)} · {formatDate(o.timestamp)}
              {o.orders != null ? ` · ${o.orders} orders` : ''}
            </div>
          </button>
        ))}

        <div style={m.section}>Restore from file</div>
        <label style={m.fileLabel}>
          Choose a backup file…
          <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onRestoreFile} />
        </label>

        <div style={m.section}>Save a copy</div>
        <div style={m.row}>
          <button style={m.smallBtn} onClick={onDownloadFile}>Download file</button>
          <button style={m.smallBtn} onClick={onCopy}>Copy to clipboard</button>
        </div>

        <button style={m.close} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
