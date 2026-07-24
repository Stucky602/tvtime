import React, { useState, useMemo } from 'react';
import { buildWeeklyDigest } from '../digest.js';
import { currency, jarsOutForRegular, regularDisplayName } from '../utils.js';
import { undecidedOmakases, omakasePriceUnsettled } from '../omakase.js';
import { entriesOnThisDay, orphanedDishNames } from '../journal.js';
import { DISH_RENAMES } from '../utils.js';
import { currentWeekInfo } from '../timeBanners.js';
const C = { panel: '#1c2422', border: '#2d3a36', text: '#e8ede9', dim: '#9aa5a0', faint: '#6b7570', good: '#5DCAA5', warn: '#EF9F27', bad: '#e0828a' };
const S = {
  section: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, margin: '10px 0' },
  head: { display: 'flex', justifyContent: 'space-between', width: '100%', background: 'transparent', border: 'none', color: C.dim, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer', padding: 0 },
  h: { fontSize: 12, fontWeight: 700, color: C.good, margin: '10px 0 3px', textTransform: 'uppercase', letterSpacing: 0.4 },
  p: { fontSize: 12.5, color: C.text, margin: '2px 0', lineHeight: 1.5 },
  dim: { color: C.dim },
};

// #6 The Monday briefing — everything the app knows, in one read.
export function DigestPanel({ orders, regulars, liveCostMap, baseCostMap, onPullFeedback, onCloseOut }) {
  const [fbMsg, setFbMsg] = useState(null);
  const [open, setOpen] = useState(false);
  const d = useMemo(() => open ? buildWeeklyDigest(orders || [], regulars || [], { liveCostMap, baseCostMap }) : null,
    [open, orders, regulars, liveCostMap, baseCostMap]);

  // What needs a decision from Kevin, computed from the props already here.
  // Deliberately NOT including paused state: the digest has no config access,
  // so it cannot tell a paused week from a quiet one and should not guess.
  const needs = useMemo(() => {
    if (!open) return null;
    const list = orders || [];
    const active = list.filter(o => !o.archived);
    const undecided = undecidedOmakases(list);
    const unsettled = active.filter(omakasePriceUnsettled).length;
    const jars = (regulars || []).map(r => ({ name: regularDisplayName(r), n: jarsOutForRegular(r.id, list) })).filter(x => x.n > 0);
    const jarTotal = jars.reduce((s2, x) => s2 + x.n, 0);
    const topJar = jars.sort((a, b) => b.n - a.n)[0] || null;
    const unpaidOrders = active.filter(o => !o.house && !o.paid);
    const unpaidTotal = unpaidOrders.reduce((s2, o) => s2 + (Number(o.total) || 0), 0);
    return { undecided, unsettled, jarTotal, topJar, unpaidCount: unpaidOrders.length, unpaidTotal };
  }, [open, orders, regulars]);


  return (
    <div style={S.section}>
      <button style={S.head} onClick={() => setOpen(o => !o)}>
        <span>Monday briefing · the week at a glance</span><span>{open ? '▲' : '▼'}</span>
      </button>
      {d && (
        <div>
          {needs && (needs.undecided.length > 0 || needs.unsettled > 0 || needs.jarTotal > 0 || needs.unpaidCount > 0) && (
            <>
              <div style={{ ...S.h, color: C.warn, fontSize: 13 }}>Needs a decision</div>
              {needs.undecided.length > 0 && (
                <div style={S.p}>
                  Omakase still undecided: {needs.undecided.map(u => `${u.customer} (${new Date(u.createdAt).toLocaleDateString()})`).join(', ')}.
                </div>
              )}
              {needs.unsettled > 0 && (
                <div style={S.p}>
                  {needs.unsettled} omakase price{needs.unsettled === 1 ? '' : 's'} still sitting at the customer's max.
                </div>
              )}
              {needs.jarTotal > 0 && (
                <div style={S.p}>
                  {needs.jarTotal} container{needs.jarTotal === 1 ? '' : 's'} out in the wild
                  {needs.topJar ? `, most with ${needs.topJar.name} (${needs.topJar.n})` : ''}.
                </div>
              )}
              {needs.unpaidCount > 0 && (
                <div style={S.p}>
                  {needs.unpaidCount} unpaid order{needs.unpaidCount === 1 ? '' : 's'}, {currency(needs.unpaidTotal)} outstanding.
                </div>
              )}
            </>
          )}


          <div style={S.h}>Money</div>
          <div style={S.p}>
            {d.week.count} order{d.week.count !== 1 ? 's' : ''} this week, {currency(d.week.revenue)} revenue, {currency(d.week.profit)} profit
            {d.revenueDeltaPct != null && <span style={{ color: d.revenueDeltaPct >= 0 ? C.good : C.warn }}> ({d.revenueDeltaPct >= 0 ? '+' : ''}{d.revenueDeltaPct}% vs last week)</span>}.
          </div>
          {d.week.top.length > 0 && <div style={{ ...S.p, ...S.dim }}>Top sellers: {d.week.top.map(([n, u]) => `${n} (${u})`).join(' · ')}</div>}

          {d.quiet.length > 0 && (<>
            <div style={S.h}>Gone quiet</div>
            {d.quiet.map(q => <div key={q.display} style={S.p}>{q.display}: no order in {q.weeks} weeks ({q.orders} lifetime). Maybe a nudge?</div>)}
          </>)}

          {(d.marginWatch.underFloor.length > 0 || d.marginWatch.watch.length > 0) && (<>
            <div style={S.h}>Margin watch</div>
            {d.marginWatch.underFloor.length > 0 && (<>
              <div style={{ ...S.p, color: C.bad, fontWeight: 700 }}>Under the floor</div>
              {d.marginWatch.underFloor.slice(0, 4).map(m => (
                <div key={m.name} style={{ ...S.p, color: C.bad }}>{m.name}: worst variant {m.pct}%</div>
              ))}
              {d.marginWatch.underFloor.length > 4 && (
                <div style={{ ...S.p, ...S.dim }}>+{d.marginWatch.underFloor.length - 4} more under the floor</div>
              )}
            </>)}
            {d.marginWatch.watch.length > 0 && (<>
              <div style={{ ...S.p, color: C.warn, fontWeight: 700, marginTop: d.marginWatch.underFloor.length > 0 ? 6 : 0 }}>Worth a look</div>
              {d.marginWatch.watch.slice(0, 4).map(m => (
                <div key={m.name} style={{ ...S.p, color: C.warn }}>{m.name}: worst variant {m.pct}%</div>
              ))}
              {d.marginWatch.watch.length > 4 && (
                <div style={{ ...S.p, ...S.dim }}>+{d.marginWatch.watch.length - 4} more to watch</div>
              )}
            </>)}
          </>)}

          {d.drifters.length > 0 && (<>
            <div style={S.h}>Cost movers</div>
            {d.drifters.map(m => <div key={m.name} style={S.p}>{m.name}: costs {m.driftPct > 0 ? 'up' : 'down'} {Math.abs(m.driftPct)}% vs anchor.</div>)}
          </>)}

          {d.reheatReport && d.reheatReport.length > 0 && (<>
            <div style={S.h}>Reheat report (from kitchen pages)</div>
            {d.reheatReport.map(r => (
              <div key={r.dish} style={{ ...S.p, color: r.bad > 0 ? C.bad : r.meh > 0 ? C.warn : C.text }}>
                {r.dish}: {r.good > 0 ? `${r.good} perfect` : ''}{r.meh > 0 ? `${r.good > 0 ? ', ' : ''}${r.meh} a little off` : ''}{r.bad > 0 ? `${(r.good > 0 || r.meh > 0) ? ', ' : ''}${r.bad} had trouble` : ''}
                {r.bad >= 2 ? ' — same dish, multiple kitchens. That is a technique signal, not a customer one.' : ''}
                {(r.notes || []).slice(-3).map((n, i) => (
                  <div key={i} style={{ fontSize: 12, color: C.dim, marginLeft: 10, marginTop: 2, fontStyle: 'italic' }}>
                    "{n.note}"
                  </div>
                ))}
              </div>
            ))}
          </>)}

          {onCloseOut && (
            <button
              style={{ width: '100%', marginTop: 12, padding: '10px', borderRadius: 8, border: '1px solid #3d4a2e', background: '#232d2a', color: '#EF9F27', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}
              onClick={async () => {
                setFbMsg('Closing out…');
                try {
                  const r = await onCloseOut();
                  setFbMsg(`Week closed: ${r.archived} order${r.archived !== 1 ? 's' : ''} archived${r.feedback ? `, ${r.feedback} kitchen tap${r.feedback !== 1 ? 's' : ''} pulled` : ''}.`);
                } catch (e) { setFbMsg('Close-out hit a snag. Orders are untouched.'); }
                setTimeout(() => setFbMsg(null), 5000);
              }}
            >
              Close out the week
            </button>
          )}
          {onPullFeedback && (
            <button
              style={{ width: '100%', marginTop: 12, padding: '9px', borderRadius: 8, border: `1px solid ${C.border}`, background: '#232d2a', color: C.good, fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}
              onClick={async () => {
                setFbMsg('Pulling…');
                try {
                  const r = await onPullFeedback();
                  setFbMsg(r.attached ? `Attached ${r.attached} tap${r.attached !== 1 ? 's' : ''} to orders.` : 'No new feedback yet.');
                } catch (e) { setFbMsg('Pull failed. Is the v8 worker deployed?'); }
                setTimeout(() => setFbMsg(null), 4000);
              }}
            >
              Pull kitchen feedback
            </button>
          )}
          {fbMsg && <div style={{ fontSize: 12, color: C.dim, marginTop: 6, textAlign: 'center' }}>{fbMsg}</div>}

          <div style={S.h}>A week that would balance</div>
          {d.proposal.picks.slice(0, 6).map(p => (
            <div key={p.name} style={S.p}><b>{p.name}</b> <span style={S.dim}>· {p.why.join(' · ')}</span></div>
          ))}
          {d.proposal.notes.map((n, i) => <div key={i} style={{ ...S.p, color: C.warn }}>{n}</div>)}
        </div>
      )}
    </div>
  );
}
