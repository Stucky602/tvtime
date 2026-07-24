import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Trash2, Check, ChevronDown, ChevronUp, X, Pencil, Copy, RotateCcw,
  ClipboardPaste, ArrowUpDown, Archive, ImageIcon, AlertTriangle, FileText,
  Scale, Camera, Download, Upload, Flame, Bell,
} from '../icons.jsx';
import {
  ALL_DINNERS, ALWAYS_MENU, DEFAULT_WEEK, PER_LB_ITEMS, FULL_MENU,
  isPerLbItem, buildMenu, CATEGORY_LABELS, STATUSES, STATUS_COLORS,
} from '../menu.js';
import {
  RECIPES, INGREDIENT_SYNONYMS, SOUS_VIDE_VEG, DINNER_REHEAT_BUCKET,
  RICE_DISHES, PASTA_DISHES, NOODLE_DISHES,
  normalizeIngredientName, generateShoppingItems, buildReheatBlocks,
} from '../recipes.js';
import {
  SURCHARGE, WORKER_BASE, PENDING_POLL_URL, CONFIG_PUBLISH_URL,
  PUBLISH_TOKEN, VAPID_PUBLIC_KEY, USE_LEGACY_CSV, FORM_CSV_URL,
  ORDERS_KEY, CHECKS_KEY, DELIVER_CHECKS_KEY, DISH_NOTES_KEY, WEEK_NOTES_KEY,
  SHOPPING_KEY, WEEK_KEY, PENDING_KEY, SEEN_ROWS_KEY, REGULARS_KEY, INVENTORY_KEY,
} from '../config.js';
import {
  uid, currency, round2, DISH_CUISINE, dishCuisine, normName,
  MIN_ORDERS_FOR_INSIGHT, localStore, store, PHOTO_PREFIX, PHOTO_TTL_DAYS, fmtBytes,
  urlBase64ToUint8Array, nameMatchType, regularNames, regularDisplayName,
  regularMatchType, buildInsights, insightStamp, loadHtml2Canvas,
  discountAmount, itemsUpchargeTotal, customChargesTotal, itemsBaseTotal,
  orderTotal, repricePerLbItem, orderCostInfo, isHouseOrder,
  groupKeyFor, formatDate, orderToText, copyText, loadJSON, saveJSON, saveError,
  photoKey, savePhoto, loadPhoto, deletePhoto, photoStorageBytes, cleanupPhotos,
  menuForPrompt, fileToJpegBase64, parseOrderText, validateParsedOrder, parseAmendment,
  parseFormRow, parseDelimited, rowToOrderText, parseFormNotes,
} from '../utils.js';
import { TEAL_DARK, TEAL_MID, TEAL_LIGHT, GOLD, CREAM, DARK, CARD, styles } from '../styles.js';
import { BooksPanel } from './BooksPanel.jsx';
import { AuditPanel } from './AuditPanel.jsx';
import { WeeklySummaryModal } from './WeeklySummary.jsx';
import { CONTAINER_TYPES, CONTAINER_TYPE_ORDER, packagingCost } from '../containers.js';

export function ProfitChart({ series }) {
  const W = 320, H = 160;
  const padL = 40, padR = 8, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const profits = series.map(s => s.profit);
  const maxP = Math.max(...profits, 0);
  const minP = Math.min(...profits, 0);
  const range = maxP - minP || 1;

  const yFor = (p) => padT + plotH - ((p - minP) / range) * plotH;
  const zeroY = yFor(0);

  // Y-axis ticks: pick a "nice" round step so labels read cleanly ($0, $250,
  // $500...) instead of odd values, then place ticks across the actual range.
  const niceStep = (raw) => {
    if (raw <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  };
  const step = niceStep(range / 4.5);
  const tickStart = Math.ceil(minP / step) * step;
  const yTicks = [];
  for (let v = tickStart; v <= maxP + 0.001; v += step) yTicks.push(round2(v));
  if (!yTicks.includes(0) && minP < 0 && maxP > 0) yTicks.push(0);

  const n = series.length;
  const slotW = plotW / n;
  const barW = Math.min(slotW * 0.6, 34);

  const labelStep = Math.ceil(n / 6);

  const linePts = series.map((s, i) => {
    const cx = padL + slotW * i + slotW / 2;
    return `${cx},${yFor(s.profit)}`;
  }).join(' ');

  const totalProfit = round2(series.reduce((sum, s) => sum + s.profit, 0));
  const avgProfit = round2(totalProfit / n);

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeader}>
        <span style={styles.chartTitle}>Profit over time</span>
        <span style={styles.chartSubtitle}>avg {currency(avgProfit)}/period</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={styles.chartSvg} preserveAspectRatio="xMidYMid meet">
        {yTicks.map((v, i) => {
          const y = yFor(v);
          const isZero = v === 0;
          return (
            <g key={`yt${i}`}>
              <line
                x1={padL} y1={y} x2={W - padR} y2={y}
                stroke={isZero ? '#4a5551' : '#2b322f'}
                strokeWidth="1"
                strokeDasharray={isZero ? '3,3' : undefined}
              />
              <text x={padL - 5} y={y + 3} textAnchor="end" fontSize="8" fill="#7a8480">
                {compactMoney(v)}
              </text>
            </g>
          );
        })}
        {series.map((s, i) => {
          const cx = padL + slotW * i + slotW / 2;
          const y = yFor(s.profit);
          const barTop = Math.min(y, zeroY);
          const barH = Math.abs(y - zeroY);
          const positive = s.profit >= 0;
          return (
            <rect
              key={i}
              x={cx - barW / 2}
              y={barTop}
              width={barW}
              height={Math.max(barH, 1)}
              rx="2"
              fill={positive ? '#1D9E7544' : '#EF444444'}
            />
          );
        })}
        {n >= 2 && <polyline points={linePts} fill="none" stroke="#5DCAA5" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {series.map((s, i) => {
          const cx = padL + slotW * i + slotW / 2;
          return <circle key={i} cx={cx} cy={yFor(s.profit)} r="2.5" fill="#5DCAA5" />;
        })}
        {series.map((s, i) => {
          if (i % labelStep !== 0 && i !== n - 1) return null;
          const cx = padL + slotW * i + slotW / 2;
          return (
            <text key={i} x={cx} y={H - 8} textAnchor="middle" fontSize="8" fill="#7a8480">
              {shortLabel(s.label)}
            </text>
          );
        })}
      </svg>
      <div style={styles.chartLegend}>
        Each bar is one {series.length > 1 ? 'period' : 'period'}'s estimated profit. Green line shows the trend.
      </div>
    </div>
  );
}

export function shortLabel(label) {
  if (!label) return '';
  return label.replace(/^Week of /, '').replace(/^Week /, 'W').slice(0, 9);
}

// Compact dollar label for the Y axis, sized to fit a ~40px gutter.
// $0, $250, $1.2k, -$500, etc.
export function compactMoney(v) {
  const neg = v < 0;
  const abs = Math.abs(v);
  let s;
  if (abs >= 1000) {
    const k = abs / 1000;
    s = '$' + (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
  } else {
    s = '$' + Math.round(abs);
  }
  return neg ? '-' + s : s;
}

// ─── Money Tab ──────────────────────────────────────────────────────────────
export function MoneyTab({ orders, onUpdate, auditLog, costHistory, baseCostMap, ingredientName, containerStatus, onSaveContainerConfig }) {
  const [sortField, setSortField] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [groupMode, setGroupMode] = useState('none');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [openPhotos, setOpenPhotos] = useState(null);
  const [storage, setStorage] = useState(null);
  const [search, setSearch] = useState('');
  const [showChart, setShowChart] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const [weekNotes, setWeekNotes] = useState({});
  const [weekNotesDraft, setWeekNotesDraft] = useState('');
  const [editingWeekNote, setEditingWeekNote] = useState(false);
  const [showReports, setShowReports] = useState(false); // Graph/Recap/Books/Change-log expander
  const [showPast, setShowPast] = useState(false);        // Past (archived) orders dropdown

  const currentWeekKey = useMemo(() => {
    if (!orders.length) return null;
    const sorted = [...orders].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return groupKeyFor(sorted[0], 'week');
  }, [orders]);

  useEffect(() => {
    loadJSON(WEEK_NOTES_KEY, {}).then(n => setWeekNotes(n || {}));
  }, []);

  const saveWeekNote = () => {
    const next = { ...weekNotes, [currentWeekKey]: weekNotesDraft.trim() };
    setWeekNotes(next);
    saveJSON(WEEK_NOTES_KEY, next);
    setEditingWeekNote(false);
  };

  const startWeekNote = () => {
    setWeekNotesDraft(weekNotes[currentWeekKey] || '');
    setEditingWeekNote(true);
  };

  useEffect(() => {
    let live = true;
    photoStorageBytes().then(s => { if (live) setStorage(s); });
    return () => { live = false; };
  }, [orders]);

  const filtered = useMemo(() => {
    // House orders (the wife) never appear in the Money tab at all. This is
    // the single choke point: `filtered` feeds totals, groups, profitSeries,
    // AND the order list below, so one filter here covers every number on the
    // tab. Do not "optimize" any of those to read `orders` directly.
    let arr = (orders || []).filter(o => !isHouseOrder(o));
    if (unpaidOnly) arr = arr.filter(o => !o.paid);
    const q = search.trim().toLowerCase();
    if (q) arr = arr.filter(o => (o.customer || '').toLowerCase().includes(q));
    return arr;
  }, [orders, unpaidOnly, search]);

  const totals = useMemo(() => {
    let booked = 0, collected = 0, cost = 0, costComplete = true;
    filtered.forEach(o => {
      booked += o.total;
      if (o.paid) collected += o.total;
      const info = orderCostInfo(o);
      cost += info.cost;
      if (!info.complete) costComplete = false;
    });
    return {
      booked: round2(booked),
      collected: round2(collected),
      outstanding: round2(booked - collected),
      profit: round2(booked - cost),
      costComplete,
      count: filtered.length,
    };
  }, [filtered]);

  // Unpaid summary for the quick-action chip. Reads the base (house-excluded,
  // search-respecting) set BEFORE the unpaidOnly filter, so the chip always
  // shows the real outstanding count even while the filter is on. Guard against
  // double-filtering: `filtered` already dropped unpaid when unpaidOnly is set,
  // so recompute from orders here.
  const unpaidSummary = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = (orders || []).filter(o => !isHouseOrder(o) && !o.paid);
    if (q) arr = arr.filter(o => (o.customer || '').toLowerCase().includes(q));
    const amt = arr.reduce((s, o) => s + o.total, 0);
    return { count: arr.length, amount: round2(amt) };
  }, [orders, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') cmp = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      if (sortField === 'total') cmp = a.total - b.total;
      if (sortField === 'name') cmp = (a.customer || '').localeCompare(b.customer || '');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortField, sortDir]);

  // Build grouped sections from a set of orders (used twice: active + past).
  const groupOrders = useCallback((arr) => {
    if (groupMode === 'none') return [{ label: null, stamp: 0, orders: arr }];
    const map = new Map();
    arr.forEach(o => {
      const { label, stamp } = groupKeyFor(o, groupMode);
      if (!map.has(label)) map.set(label, { label, stamp, orders: [] });
      map.get(label).orders.push(o);
    });
    return Array.from(map.values()).sort((a, b) => b.stamp - a.stamp);
  }, [groupMode]);

  // Split active (live) from archived (past). Archived orders were dimmed and
  // mixed into one list before; now they live behind a collapsed Past dropdown
  // so the tab opens on the ~handful of live orders, not a 30-row wall.
  const activeSorted = useMemo(() => sorted.filter(o => !o.archived), [sorted]);
  const pastSorted = useMemo(() => sorted.filter(o => o.archived), [sorted]);
  const groups = useMemo(() => groupOrders(activeSorted), [groupOrders, activeSorted]);
  const pastGroups = useMemo(() => groupOrders(pastSorted), [groupOrders, pastSorted]);
  const pastCount = pastSorted.length;

  const profitSeries = useMemo(() => {
    const mode = groupMode === 'none' ? 'week' : groupMode;
    const map = new Map();
    filtered.forEach(o => {
      const { label, stamp } = groupKeyFor(o, mode);
      if (!map.has(label)) map.set(label, { label, stamp, profit: 0, revenue: 0 });
      const e = map.get(label);
      e.revenue += o.total;
      e.profit += o.total - orderCostInfo(o).cost;
    });
    return Array.from(map.values())
      .sort((a, b) => a.stamp - b.stamp)
      .map(e => ({ ...e, profit: round2(e.profit), revenue: round2(e.revenue) }));
  }, [filtered, groupMode]);

  const setSort = (field) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'name' ? 'asc' : 'desc');
    }
  };

  if (orders.length === 0) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyTitle}>No history yet</div>
        <div style={styles.emptyBody}>Every order you save shows up here — including archived past weeks.</div>
      </div>
    );
  }

  const hasWeekNote = currentWeekKey && weekNotes[currentWeekKey];

  // One group section (header stats + order rows). Shared by the active list
  // and the Past-orders dropdown, so both render identically and the per-group
  // stat header (revenue/profit/outstanding) is available inside Past too.
  const renderGroups = (groupList) => groupList.map(group => {
    let gRev = 0, gCost = 0, gCollected = 0;
    group.orders.forEach(o => {
      gRev += o.total;
      gCost += orderCostInfo(o).cost;
      if (o.paid) gCollected += o.total;
    });
    const gProfit = round2(gRev - gCost);
    const gOutstanding = round2(gRev - gCollected);
    return (
      <div key={group.label || 'all'} style={styles.moneyGroup}>
        {group.label && (
          <div style={styles.groupHeaderRich}>
            <div style={styles.groupHeaderTop}>
              <span style={styles.groupTitle}>{group.label}</span>
              <span style={styles.groupOrderCount}>{group.orders.length} order{group.orders.length !== 1 ? 's' : ''}</span>
            </div>
            <div style={styles.groupStatsRow}>
              <div style={styles.groupStat}>
                <span style={styles.groupStatValue}>{currency(round2(gRev))}</span>
                <span style={styles.groupStatLabel}>revenue</span>
              </div>
              <div style={styles.groupStat}>
                <span style={{ ...styles.groupStatValue, color: '#1D9E75' }}>{currency(gProfit)}</span>
                <span style={styles.groupStatLabel}>profit</span>
              </div>
              <div style={styles.groupStat}>
                <span style={{ ...styles.groupStatValue, color: gOutstanding > 0 ? '#EF9F27' : '#9aa5a0' }}>{currency(gOutstanding)}</span>
                <span style={styles.groupStatLabel}>outstanding</span>
              </div>
            </div>
          </div>
        )}
        <div style={styles.moneyList}>
          {group.orders.map(o => {
            const info = orderCostInfo(o);
            const profit = round2(o.total - info.cost);
            const photoItems = (o.items || [])
              .map((it, i) => ({ it, i }))
              .filter(({ it }) => it.hasPhoto);
            return (
              <div key={o.id} style={{ ...styles.moneyRowWrap, ...(o.archived ? { opacity: 0.65 } : {}) }}>
                <div
                  style={{ ...styles.moneyRow, ...(photoItems.length ? { cursor: 'pointer' } : {}) }}
                  onClick={photoItems.length ? () => setOpenPhotos(openPhotos === o.id ? null : o.id) : undefined}
                >
                  <div style={styles.moneyRowLeft}>
                    <div style={styles.moneyName}>
                      {o.customer}
                      {photoItems.length > 0 && <Camera size={12} style={{ marginLeft: 6, verticalAlign: 'middle', opacity: 0.7 }} />}
                    </div>
                    <div style={styles.moneyMeta}>
                      {formatDate(o.createdAt)}{o.archived ? ' · archived' : ` · ${o.status}`}
                      {photoItems.length > 0 ? ` · ${photoItems.length} photo${photoItems.length !== 1 ? 's' : ''}` : ''}
                    </div>
                  </div>
                  <div style={styles.moneyRowRight}>
                    <div style={styles.moneyAmounts}>
                      <span style={styles.moneyAmount}>{currency(o.total)}</span>
                      <span style={styles.moneyProfit}>
                        {info.complete || info.cost > 0 ? `+${currency(profit)}${info.complete ? '' : '*'}` : '—'}
                      </span>
                    </div>
                    <button
                      style={{
                        ...styles.paidPill,
                        ...(o.paid
                          ? { background: '#1D9E7522', color: '#1D9E75' }
                          : { background: '#EF9F2722', color: '#EF9F27' }),
                      }}
                      onClick={(e) => { e.stopPropagation(); onUpdate(o.id, { paid: !o.paid }); }}
                    >
                      {o.paid ? 'Paid' : 'Unpaid'}
                    </button>
                  </div>
                </div>
                {openPhotos === o.id && photoItems.length > 0 && (
                  <OrderPhotos orderId={o.id} photoItems={photoItems} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  });

  return (
    <div>
      <div style={styles.moneyStatsBar}>
        <div style={styles.moneyStatTile}>
          <div style={styles.statValue}>{currency(totals.booked)}</div>
          <div style={styles.statLabel}>{unpaidOnly ? 'Unpaid total' : 'Revenue'}</div>
          {(() => {
            const oma = filtered.reduce((n, o) => n + (o.items || []).reduce((m, it) => m + (it.omakase ? (Number(it.price) || 0) * (it.qty || 1) : 0), 0), 0);
            return oma > 0 ? <div style={styles.moneyFootnote}>{currency(oma)} omakase</div> : null;
          })()}
        </div>
        <div style={styles.moneyStatTile}>
          <div style={{ ...styles.statValue, color: '#1D9E75' }}>
            {currency(totals.profit)}{totals.costComplete ? '' : '*'}
          </div>
          <div style={styles.statLabel}>Est. profit</div>
        </div>
        <div style={styles.moneyStatTile}>
          <div style={{ ...styles.statValue, color: '#1D9E75' }}>{currency(totals.collected)}</div>
          <div style={styles.statLabel}>Collected</div>
        </div>
        <div style={styles.moneyStatTile}>
          <div style={{ ...styles.statValue, ...(totals.outstanding > 0 ? { color: '#EF9F27' } : {}) }}>
            {currency(totals.outstanding)}
          </div>
          <div style={styles.statLabel}>Outstanding</div>
        </div>
      </div>

      {!totals.costComplete && (
        <div style={styles.moneyFootnote}>* some items predate cost tracking, so profit is partial</div>
      )}

      {/* Quick action: outstanding money is the actionable number. One tap
          toggles the same unpaidOnly filter. */}
      {unpaidSummary.count > 0 && (
        <button
          style={{ ...styles.unpaidChip, ...(unpaidOnly ? styles.unpaidChipActive : {}) }}
          onClick={() => setUnpaidOnly(v => !v)}
        >
          <Bell size={13} />
          Unpaid · {unpaidSummary.count} · {currency(unpaidSummary.amount)}
          {unpaidOnly ? ' · showing' : ''}
        </button>
      )}

      {/* Slim week notes — low-frequency, so collapsed to one line under the
          vitals instead of leading the tab. Expands on tap. */}
      {currentWeekKey && (
        editingWeekNote ? (
          <div style={styles.weekNotesBlock}>
            <div style={styles.weekNotesTitle}>Week notes</div>
            <textarea
              style={{ ...styles.refCardNotes, minHeight: '80px' }}
              value={weekNotesDraft}
              onChange={e => setWeekNotesDraft(e.target.value)}
              placeholder="Jot anything worth remembering about this week — what ran out, what to double, timing notes…"
              autoFocus
            />
            <div style={styles.notesEditActions}>
              <button style={styles.confirmYesGreen} onClick={saveWeekNote}>Save</button>
              <button style={styles.confirmNo} onClick={() => setEditingWeekNote(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button style={styles.weekNoteSlim} onClick={startWeekNote}>
            <Pencil size={12} />
            {hasWeekNote
              ? <span style={styles.weekNoteSlimText}>{weekNotes[currentWeekKey]}</span>
              : <span style={styles.weekNoteSlimEmpty}>Week note</span>}
          </button>
        )
      )}

      <div style={styles.sortRow}>
        {[
          ['date', 'Date'],
          ['total', 'Amount'],
          ['name', 'Customer'],
        ].map(([field, label]) => (
          <button
            key={field}
            style={{ ...styles.sortBtn, ...(sortField === field ? styles.sortBtnActive : {}) }}
            onClick={() => setSort(field)}
          >
            {label}
            {sortField === field && <span style={styles.sortDirText}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ))}
        <button
          style={{ ...styles.sortBtn, ...(unpaidOnly ? { color: '#EF9F27', borderColor: '#EF9F27' } : {}) }}
          onClick={() => setUnpaidOnly(v => !v)}
        >
          Unpaid only
        </button>
      </div>

      <div style={styles.sortRow}>
        <span style={styles.groupLabel}>Group:</span>
        {[
          ['none', 'None'],
          ['week', 'Week'],
          ['month', 'Month'],
          ['year', 'Year'],
        ].map(([mode, label]) => (
          <button
            key={mode}
            style={{ ...styles.sortBtn, ...(groupMode === mode ? styles.sortBtnActive : {}) }}
            onClick={() => setGroupMode(mode)}
          >
            {label}
          </button>
        ))}
        <div style={styles.moneyCount}>{totals.count} order{totals.count !== 1 ? 's' : ''}</div>
      </div>

      <div style={styles.moneySearchRow}>
        <input
          style={styles.moneySearchInput}
          placeholder="Search by customer name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button style={styles.moneySearchClear} onClick={() => setSearch('')} aria-label="Clear search">
            <X size={15} />
          </button>
        )}
      </div>

      {/* Reports: Graph, Recap, Books P&L (with margin trend), and the change
          log are all secondary — one expander instead of four always-on tools. */}
      <div style={styles.reportsPanel}>
        <button style={styles.reportsHead} onClick={() => setShowReports(v => !v)}>
          <span>Reports</span>
          <span>{showReports ? '▲' : '▼'}</span>
        </button>
        {showReports && (
          <div style={{ marginTop: 8 }}>
            <div style={styles.reportsBtnRow}>
              {profitSeries.length >= 2 && (
                <button
                  style={{ ...styles.chartToggleBtn, ...(showChart ? styles.chartToggleBtnActive : {}) }}
                  onClick={() => setShowChart(v => !v)}
                >
                  {showChart ? 'Hide graph' : 'Graph'}
                </button>
              )}
              <button
                style={styles.chartToggleBtn}
                onClick={() => setShowRecap(true)}
              >
                Recap
              </button>
            </div>
            {showChart && profitSeries.length >= 2 && <ProfitChart series={profitSeries} />}
            <BooksPanel
              orders={orders}
              costHistory={costHistory}
              baseCostMap={baseCostMap}
              ingredientName={ingredientName}
            />
            <AuditPanel log={auditLog} />
            {/* ── M1 + M2: Packaging & containers ──
                 Owned counts (editable — Kevin called his numbers
                 placeholders), the meal-pool outstanding count with his
                 manual override, and this week's packaging spend.
                 DISPLAY-ONLY costs (decision 3a): nothing here ever
                 touches the dish margin engine. */}
            {containerStatus && (
              <div style={{ marginTop: 10, padding: '10px 0', borderTop: '1px solid #2d3a36' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9aa5a0', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>Packaging &amp; containers</div>
                {CONTAINER_TYPE_ORDER.map(t => {
                  const row = containerStatus.rows.find(r => r.type === t);
                  return (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5, color: '#e8ede9' }}>
                      <span style={{ flex: 1 }}>{CONTAINER_TYPES[t].label} <span style={{ color: '#7a8480' }}>(${CONTAINER_TYPES[t].cost.toFixed(2)})</span></span>
                      <span style={{ color: row && row.short > 0 ? '#e0828a' : '#7a8480', fontSize: 11.5 }}>
                        need {row ? row.need : 0}{t === 'jar' && containerStatus.jarsHeld > 0 ? ` · ${containerStatus.jarsHeld} held` : ''}
                      </span>
                      <span style={{ color: '#7a8480', fontSize: 11.5 }}>own</span>
                      <input
                        type="number" min="0" inputMode="numeric"
                        value={containerStatus.owned[t]}
                        onChange={e => onSaveContainerConfig && onSaveContainerConfig(prev => ({ ...prev, owned: { ...prev.owned, [t]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } }))}
                        style={{ width: 56, minHeight: 36, background: '#1a1a1a', border: '1px solid #37403c', borderRadius: 7, color: '#e8ede9', fontSize: 13, padding: '4px 6px', textAlign: 'center' }}
                      />
                    </div>
                  );
                })}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 2px', fontSize: 12.5, color: '#e8ede9', borderTop: '1px solid #232d2a', marginTop: 6 }}>
                  <span style={{ flex: 1 }}>Meal containers still out <span style={{ color: '#7a8480' }}>(returns net out via invoices)</span></span>
                  <span style={{ fontWeight: 700, color: containerStatus.mealOut > 0 ? '#EF9F27' : '#7a8480' }}>{containerStatus.mealOut}</span>
                  <span style={{ color: '#7a8480', fontSize: 11.5 }}>adjust</span>
                  <input
                    type="number" inputMode="numeric"
                    value={containerStatus.mealAdjust}
                    onChange={e => onSaveContainerConfig && onSaveContainerConfig(prev => ({ ...prev, mealAdjust: Math.floor(Number(e.target.value) || 0) }))}
                    style={{ width: 56, minHeight: 36, background: '#1a1a1a', border: '1px solid #37403c', borderRadius: 7, color: '#e8ede9', fontSize: 13, padding: '4px 6px', textAlign: 'center' }}
                  />
                </div>
                {(() => {
                  const wk = packagingCost((orders || []).filter(o => {
                    const t = new Date(o.createdAt || 0).getTime();
                    return t >= Date.now() - 7 * 86400000;
                  }));
                  return (
                    <div style={{ fontSize: 12, color: '#9aa5a0', marginTop: 6 }}>
                      Packaging out, last 7 days: <b style={{ color: '#e8ede9' }}>${wk.total.toFixed(2)}</b>
                      {wk.bags > 0 ? ` · ${wk.bags} sous vide bag${wk.bags !== 1 ? 's' : ''} (uncosted)` : ''}
                      <span style={{ color: '#7a8480' }}> — display only, never in dish margins.</span>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
      {showRecap && <WeeklySummaryModal orders={orders} onClose={() => setShowRecap(false)} />}

      {/* Active (live) orders — the handful in play right now. */}
      {activeSorted.length === 0 && pastCount > 0 && (
        <div style={styles.moneyAllArchivedNote}>No live orders this week. Past orders are below.</div>
      )}
      {renderGroups(groups)}

      {/* Past orders — every archived/delivered order, collapsed by default and
          grouped inside. Turns a 30-row wall into ~6 live rows + one section. */}
      {pastCount > 0 && (
        <div style={styles.pastPanel}>
          <button style={styles.pastHead} onClick={() => setShowPast(v => !v)}>
            <span>Past orders ({pastCount})</span>
            <span>{showPast ? '▲' : '▼'}</span>
          </button>
          {showPast && (
            <div style={{ marginTop: 8 }}>
              {renderGroups(pastGroups)}
            </div>
          )}
        </div>
      )}

      {storage && storage.count > 0 && (
        <div style={styles.storageGauge}>
          <Camera size={13} />
          <span>{storage.count} scale photo{storage.count !== 1 ? 's' : ''} stored · {fmtBytes(storage.bytes)}</span>
          <span style={styles.storageGaugeNote}>auto-deleted after 1 month</span>
        </div>
      )}
    </div>
  );
}

export function OrderPhotos({ orderId, photoItems }) {
  const [photos, setPhotos] = useState({});

  useEffect(() => {
    let live = true;
    (async () => {
      for (const { i } of photoItems) {
        const d = await loadPhoto(orderId, i);
        if (!live) return;
        setPhotos(prev => ({ ...prev, [i]: d || 'none' }));
      }
    })();
    return () => { live = false; };
  }, [orderId]); // eslint-disable-line

  return (
    <div style={styles.orderPhotosWrap}>
      {photoItems.map(({ it, i }) => (
        <div key={i} style={styles.orderPhotoItem}>
          <div style={styles.orderPhotoLabel}>
            {it.name}{it.weight > 0 ? ` · ${it.weight} lb` : ''}
          </div>
          {photos[i] === undefined && <div style={styles.orderPhotoLoading}>loading…</div>}
          {photos[i] === 'none' && <div style={styles.orderPhotoLoading}>photo expired or missing</div>}
          {photos[i] && photos[i] !== 'none' && (
            <img src={`data:image/jpeg;base64,${photos[i]}`} alt={`${it.name} on scale`} style={styles.orderPhotoImg} />
          )}
        </div>
      ))}
    </div>
  );
}
