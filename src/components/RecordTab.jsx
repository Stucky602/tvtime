import React, { useState, useMemo } from 'react';
import {
  dossierCoverage, dossierComposition, entriesOnThisDay, orphanedDishNames,
  principleIndex, UNNAMED_PRINCIPLE, recentlyDeleted, restoreEntry,
  JOURNAL_TYPES, JOURNAL_TYPE_ORDER,
} from '../journal.js';
import { weeklyDossierPrompt } from '../dossierPrompts.js';
import { currentWeekInfo } from '../timeBanners.js';
import { sameMonthPreviousYears } from '../weekLedger.js';
import { buildArchiveHtml, buildRecordsHtml } from '../archiveExport.js';
import { DISH_RENAMES } from '../utils.js';

// The Record tab. NOT a new feature: a restructure.
//
// The app was architected as an order tracker with a knowledge base bolted on.
// The archive lived as a button inside the Money tab, the weekly question was
// one section out of eleven in the Monday briefing, and the coverage of the
// whole record was not visible anywhere. Meanwhile the stated purpose of the
// thing is the reverse: a structured body of how Kevin cooks, which currently
// earns its keep by running a meal-prep business.
//
// So the shape of the app now matches the purpose of the app. Everything that
// reads ACROSS the record lives here. Writing a single dish's entry stays in
// the Recipes tab, deliberately, because you write about a dish while looking
// at that dish.
//
// Three groups, in the order the work actually happens:
//   WRITE — what to add next
//   READ  — what the record already says
//   KEEP  — making sure it survives
const C = { panel: '#1c2422', border: '#2d3a36', text: '#e8ede9', dim: '#9aa5a0', faint: '#6b7570', good: '#5DCAA5', warn: '#EF9F27', gold: '#D4A050', bad: '#e0828a' };
const S = {
  wrap: { padding: '4px 0 40px' },
  group: { fontSize: 11, fontWeight: 800, color: C.gold, letterSpacing: 1, textTransform: 'uppercase', margin: '18px 0 6px' },
  card: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, margin: '8px 0' },
  h: { fontSize: 12, fontWeight: 700, color: C.good, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  p: { fontSize: 12.5, color: C.text, lineHeight: 1.5, margin: '3px 0' },
  dim: { color: C.dim },
  faint: { fontSize: 11, color: C.faint },
  btn: (accent) => ({ minHeight: 44, padding: '10px 16px', borderRadius: 8, border: `1px solid ${accent || C.border}`, background: '#232d2a', color: accent || C.text, fontWeight: 700, fontSize: 13, cursor: 'pointer' }),
  chipRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 },
};

const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString(); } catch { return ''; } };

export function RecordTab({
  journal, onSaveJournal, dishNames, weekDishes, orders, knownNames,
  weekLedger, askLog, onPullQuestions, copiesNote, onSaveCopiesNote,
}) {
  const [msg, setMsg] = useState(null);
  const [showAllCoverage, setShowAllCoverage] = useState(false);
  const [noteDraft, setNoteDraft] = useState(null);

  const wk = useMemo(() => currentWeekInfo(), []);
  const question = useMemo(() => weeklyDossierPrompt(journal, weekDishes || [], wk.stamp), [journal, weekDishes, wk]);
  const coverage = useMemo(() => dossierCoverage(journal, dishNames || [], DISH_RENAMES), [journal, dishNames]);
  const composition = useMemo(() => dossierComposition(journal), [journal]);
  const onThisDay = useMemo(() => entriesOnThisDay(journal, new Date(), DISH_RENAMES), [journal]);
  const orphans = useMemo(() => orphanedDishNames(orders || [], knownNames || new Set(), DISH_RENAMES), [orders, knownNames]);
  const principles = useMemo(() => principleIndex(journal, DISH_RENAMES), [journal]);
  const undoable = useMemo(() => recentlyDeleted(journal), [journal]);
  const season = useMemo(() => sameMonthPreviousYears(weekLedger, new Date()), [weekLedger]);

  const downloadDoc = (html, filename, label) => {
    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMsg(`${label} downloaded. It opens in any browser, with or without this app, and prints clean.`);
    } catch (e) {
      setMsg(`${label} failed to build. Nothing was changed.`);
    }
    setTimeout(() => setMsg(null), 6000);
  };

  const coverRows = showAllCoverage ? coverage.rows : coverage.rows.slice(0, 12);

  return (
    <div style={S.wrap}>
      {/* ══ WRITE ══════════════════════════════════════════════════════════ */}
      <div style={S.group}>Write</div>

      {question && (
        <div style={{ ...S.card, border: `1px solid ${C.good}` }}>
          <div style={S.h}>This week's question</div>
          <div style={S.p}>{question.question}</div>
          <div style={S.faint}>
            {question.kind === 'never' ? 'Nothing on record for it yet.'
              : question.kind === 'stale' ? 'Nothing written about it in months.'
              : `${question.entryCount} entr${question.entryCount === 1 ? 'y' : 'ies'} on record.`}
            {' '}Recipes tab &rarr; {question.dish} &rarr; Dossier.
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.h}>Coverage</div>
        <div style={S.faint}>
          {coverage.documented} of {coverage.total} written up{coverage.empty > 0 ? `, ${coverage.empty} with nothing at all` : ''}. Emptiest first.
        </div>
        <div style={{ marginTop: 8 }}>
          {coverRows.map(r => (
            <div key={r.dish} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
              <span style={{ flex: 1, fontSize: 12.5, color: r.entries === 0 ? C.faint : C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.dish}</span>
              <span style={{ width: 90, height: 6, borderRadius: 3, background: '#141a18', overflow: 'hidden', flexShrink: 0 }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.min(100, r.entries * 12)}%`, background: r.entries === 0 ? 'transparent' : C.good }} />
              </span>
              <span style={{ width: 22, textAlign: 'right', fontSize: 11.5, color: r.entries === 0 ? C.bad : C.dim }}>{r.entries}</span>
            </div>
          ))}
        </div>
        {coverage.rows.length > 12 && (
          <button style={{ ...S.btn(), width: '100%', marginTop: 8, minHeight: 36, fontSize: 12 }} onClick={() => setShowAllCoverage(v => !v)}>
            {showAllCoverage ? 'Show less' : `Show all ${coverage.rows.length}`}
          </button>
        )}
      </div>

      <div style={S.card}>
        <div style={S.h}>What kind of record this is</div>
        <div style={S.faint}>
          {composition.total} entr{composition.total === 1 ? 'y' : 'ies'}
          {composition.transferable > 0 ? `, ${composition.transferable} marked as holding beyond their dish` : ''}
          {composition.private > 0 ? `, ${composition.private} private` : ''}.
        </div>
        <div style={S.chipRow}>
          {JOURNAL_TYPE_ORDER.map(t => (
            <span key={t} style={{ padding: '3px 8px', borderRadius: 10, fontSize: 11, border: `1px solid ${composition.byType[t] ? C.border : C.bad}`, color: composition.byType[t] ? C.dim : C.bad }}>
              {JOURNAL_TYPES[t].label} {composition.byType[t]}
            </span>
          ))}
        </div>
        {composition.missing.length > 0 && composition.total > 0 && (
          <div style={{ ...S.p, color: C.warn, marginTop: 8 }}>
            Nothing recorded under: {composition.missing.map(t => JOURNAL_TYPES[t].label).join(', ')}.
            {composition.missing.includes('mistake') && ' A record with no failures in it says cooking is a thing that goes right.'}
          </div>
        )}
      </div>

      {/* ══ READ ═══════════════════════════════════════════════════════════ */}
      <div style={S.group}>Read</div>

      {onThisDay.length > 0 && (
        <div style={S.card}>
          <div style={S.h}>On this day</div>
          {onThisDay.slice(0, 4).map(e => (
            <div key={e.id} style={S.p}>
              <span style={S.dim}>{e.yearsAgo} year{e.yearsAgo === 1 ? '' : 's'} ago{e.dish ? `, on ${e.dish}` : ''}:</span> {e.text}
            </div>
          ))}
        </div>
      )}

      <div style={S.card}>
        <div style={S.h}>Principles</div>
        {principles.size === 0 ? (
          <div style={S.faint}>Nothing marked as holding beyond its dish yet. The toggle is on technique, adjustment, done-cue, and mistake entries.</div>
        ) : (
          [...principles.entries()].map(([name, list]) => (
            <div key={name} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.gold }}>
                {name === UNNAMED_PRINCIPLE ? 'Not yet grouped' : name}
              </div>
              {list.slice(0, 6).map(e => (
                <div key={e.id} style={{ ...S.p, borderLeft: `2px solid ${C.good}`, paddingLeft: 8, margin: '4px 0' }}>
                  {e.text}
                  <div style={S.faint}>{e.dish || 'general'} · {fmtDate(e.ts)}</div>
                </div>
              ))}
              {list.length > 6 && <div style={S.faint}>+{list.length - 6} more</div>}
            </div>
          ))
        )}
      </div>

      {season.length > 0 && (
        <div style={S.card}>
          <div style={S.h}>This month, previous years</div>
          {season.slice(0, 6).map(w => (
            <div key={w.stamp} style={S.p}>
              <span style={S.dim}>{w.label}:</span> {w.dishes.length ? w.dishes.join(', ') : 'nothing published'}
            </div>
          ))}
        </div>
      )}

      <div style={S.card}>
        <div style={S.h}>What customers asked</div>
        {(askLog || []).length === 0 ? (
          <div style={S.faint}>Nothing pulled yet. These are real confusions at the moment of cooking, which is the one kind of teaching data you cannot write from memory.</div>
        ) : (
          (askLog || []).slice(0, 8).map((q, i) => (
            <div key={i} style={S.p}><span style={S.dim}>{fmtDate(q.at)}:</span> "{q.question}"</div>
          ))
        )}
        {onPullQuestions && (
          <button
            style={{ ...S.btn(), width: '100%', marginTop: 8 }}
            onClick={async () => {
              setMsg('Pulling questions…');
              try {
                const n = await onPullQuestions();
                setMsg(n ? `${n} question${n === 1 ? '' : 's'} pulled.` : 'No questions yet.');
              } catch (e) { setMsg('Could not pull questions.'); }
              setTimeout(() => setMsg(null), 4000);
            }}
          >
            Pull customer questions
          </button>
        )}
      </div>

      {/* ══ KEEP ═══════════════════════════════════════════════════════════ */}
      <div style={S.group}>Keep</div>

      <div style={S.card}>
        <div style={S.h}>The durable record</div>
        <div style={S.faint}>
          Everything above lives in this one device's storage. These two files do not.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button style={S.btn(C.good)} onClick={() => downloadDoc(
            buildArchiveHtml({ journal, orders, copiesNote }),
            `LTB_ARCHIVE_${new Date().getFullYear()}_${new Date().toISOString().slice(5, 10)}.html`,
            'The archive')}>
            Download the yearly archive
          </button>
          <button style={S.btn()} onClick={() => downloadDoc(
            buildRecordsHtml({ orders }),
            `LTB_RECORDS_${new Date().toISOString().slice(0, 10)}.html`,
            'The delivery records')}>
            Download delivery records
          </button>
        </div>
        {msg && <div style={{ ...S.faint, marginTop: 6 }}>{msg}</div>}
      </div>

      <div style={S.card}>
        <div style={S.h}>Where the copies live</div>
        <div style={S.faint}>
          The archive is the highest-stakes thing here and it exists wherever you last saved it.
          Nobody else knows it exists or where to look. This note prints INTO the archive, so it
          is readable by someone who does not have you to ask.
        </div>
        <textarea
          style={{ width: '100%', minHeight: 70, marginTop: 8, background: '#14201d', border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, padding: 9, boxSizing: 'border-box', fontFamily: 'inherit' }}
          placeholder="e.g. Yearly archive is emailed to myself every birthday, and a printed copy is in the fire safe."
          value={noteDraft == null ? (copiesNote || '') : noteDraft}
          onChange={e => setNoteDraft(e.target.value)}
        />
        {noteDraft != null && noteDraft !== (copiesNote || '') && (
          <button style={{ ...S.btn(C.good), marginTop: 6 }} onClick={() => { onSaveCopiesNote(noteDraft); setNoteDraft(null); }}>
            Save
          </button>
        )}
      </div>

      {orphans.length > 0 && (
        <div style={{ ...S.card, border: `1px solid ${C.warn}` }}>
          <div style={S.h}>Names the app does not recognize</div>
          {orphans.map(o => (
            <div key={o.name} style={{ ...S.p, color: C.warn }}>
              "{o.name}" is on {o.orderCount} order{o.orderCount === 1 ? '' : 's'} but is not a dish or a known rename.
            </div>
          ))}
          <div style={S.faint}>Each one splits its dish's passport stamps and sales counts. Add it to DISH_RENAMES if it was renamed.</div>
        </div>
      )}

      {undoable.length > 0 && (
        <div style={S.card}>
          <div style={S.h}>Recently deleted</div>
          <div style={S.faint}>Removed entries stay recoverable for 30 days, then go for good.</div>
          {undoable.map(e => (
            <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
              <span style={{ flex: 1, fontSize: 12, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.text}
              </span>
              <span style={S.faint}>{fmtDate(e.deletedAt)}</span>
              <button
                onClick={() => onSaveJournal(prev => restoreEntry(prev, e.id))}
                style={{ minHeight: 32, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.good}`, background: 'transparent', color: C.good, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}
              >
                Undo
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
