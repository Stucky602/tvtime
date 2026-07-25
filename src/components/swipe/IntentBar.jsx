import { useState } from 'react';
import { INTENTS, suggestedIntent, intentFilters, makePreset } from '../../lib/intent.js';

// Session intent picker.
//
// One row of chips answering "what kind of night is this", which then
// drives the filters. The point of the portfolio pass was that
// time-awareness, saved presets, and mood clusters were three input
// mechanisms for one question; this is the question.
//
// The time-of-day suggestion is PRE-SELECTED but never auto-applied.
// Silently narrowing someone's deck because of the clock reads as a bug
// rather than as cleverness: you would have no way to tell whether the
// app was being helpful or broken.

export default function IntentBar({ activeIntent, onPick, savedPresets = [], onSavePreset, currentFilters }) {
  const [expanded, setExpanded] = useState(false);
  const suggestion = suggestedIntent();

  const all = [...INTENTS, ...savedPresets];
  const shown = expanded ? all : all.slice(0, 4);

  return (
    <div className="intent">
      <div className="intent__row">
        <button
          className={`intent__chip ${!activeIntent ? 'intent__chip--on' : ''}`}
          onClick={() => onPick(null)}
        >
          Anything
        </button>

        {shown.map((i) => (
          <button
            key={i.id}
            className={`intent__chip ${activeIntent === i.id ? 'intent__chip--on' : ''} ${
              !activeIntent && suggestion === i.id ? 'intent__chip--suggested' : ''
            }`}
            onClick={() => onPick(i.id, intentFilters(i))}
            title={i.blurb}
          >
            {i.label}
            {!activeIntent && suggestion === i.id && <span className="intent__hint"> ·</span>}
          </button>
        ))}

        {all.length > 4 && (
          <button className="intent__chip intent__chip--more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Less' : 'More'}
          </button>
        )}
      </div>

      {!activeIntent && suggestion && (
        <p className="intent__suggest">
          Going by the time, {INTENTS.find((i) => i.id === suggestion)?.label.toLowerCase()} probably
          fits. Tap it or ignore me.
        </p>
      )}

      {onSavePreset && currentFilters && (
        <button
          className="intent__save"
          onClick={() => {
            const label = window.prompt('Name this preset');
            if (label) onSavePreset(makePreset(label, currentFilters));
          }}
        >
          Save current filters as a preset
        </button>
      )}
    </div>
  );
}
