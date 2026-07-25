import { SECRET, SECRET_LABEL, SECRET_BLURB } from '../../lib/secret.js';

// The chooser that appears after the gesture lands.
//
// One gesture, two meanings. The alternative was two separate gestures,
// which doubles what you have to remember for no gain: by the time the
// panel is open you are already past the secret part, and picking from
// two large buttons is faster and less error-prone than recalling which
// of two sequences meant which.
//
// Styled unlike anything else in the app on purpose. When it appears you
// should be in no doubt that you did something unusual.

export default function SecretPanel({ title, onPick, onCancel }) {
  return (
    <div className="secret-panel" role="dialog" aria-label="Secret vote">
      <p className="secret-panel__title shout">{title?.title}</p>

      <button
        className="secret-panel__opt secret-panel__opt--ours"
        onClick={() => onPick(SECRET.ONLY_WITH_YOU)}
      >
        <span className="shout">{SECRET_LABEL.only_with_you}</span>
        <span className="secret-panel__blurb">{SECRET_BLURB.only_with_you}</span>
      </button>

      <button
        className="secret-panel__opt secret-panel__opt--mine"
        onClick={() => onPick(SECRET.JUST_ME)}
      >
        <span className="shout">{SECRET_LABEL.just_me}</span>
        <span className="secret-panel__blurb">{SECRET_BLURB.just_me}</span>
      </button>

      <button className="secret-panel__cancel" onClick={onCancel}>
        Never mind
      </button>
    </div>
  );
}
