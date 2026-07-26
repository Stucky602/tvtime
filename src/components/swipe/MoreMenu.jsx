// Everything that isn't swiping.
//
// The top bar had six buttons: Filters, Search, Stats, Year, Rate,
// Settings. On a 393px phone that overflowed, so Settings was simply
// gone -- unreachable, with no indication it existed. Six buttons
// competing for the top of the screen, five of which lead to places you
// visit occasionally.
//
// Filters stays on the deck because it changes what you are looking at
// right now. Everything else lives here, behind one control.

const ITEMS = [
  { id: 'search', label: 'Search', blurb: 'Find a specific title' },
  { id: 'rate', label: 'Rate', blurb: "What you've watched but not rated" },
  { id: 'stats', label: 'Stats', blurb: 'How you two compare' },
  { id: 'recap', label: 'Your year', blurb: 'Everything you watched' },
  { id: 'settings', label: 'Settings', blurb: 'Room, services, PIN' },
];

export default function MoreMenu({ open, onPick, onClose }) {
  if (!open) return null;
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="More">
        <div className="filter-sheet__head">
          <h2>More</h2>
          <button onClick={onClose}>Done</button>
        </div>
        <ul className="sheet-list">
          {ITEMS.map((i) => (
            <li key={i.id}>
              <button
                className="sheet-item"
                onClick={() => {
                  onClose();
                  onPick(i.id);
                }}
              >
                <span className="sheet-item__label shout">{i.label}</span>
                <span className="sheet-item__blurb">{i.blurb}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
