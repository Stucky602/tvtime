import { useState } from 'react';
import { posterUrl } from '../../lib/config.js';
import { resolvePlan, PLAN_STATUS } from '../../lib/plans.js';
import { setWatchStatus } from '../../lib/tabs.js';

// "This is what we're watching."
//
// The state the app never had. Everything before this recorded that you
// both wanted something, or that you had already watched it, with
// nothing in between -- which is precisely where a decision lives.
//
// Sits at the top of the swipe screen because that is the screen you
// open, and because a plan you have to go looking for is not a plan.

export default function TonightBanner({ plan, title, roomId, userId, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!plan || !title) return null;

  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tonight">
      <div className="tonight__art">
        {title.poster_path ? (
          <img src={posterUrl(title.poster_path, 'w185')} alt="" />
        ) : (
          <div className="row__noart">{title.media_type === 'tv' ? 'Series' : 'Film'}</div>
        )}
      </div>

      <div className="tonight__body">
        <p className="tonight__label shout">
          {plan.planned_for ? 'The plan' : 'Tonight'}
        </p>
        <p className="tonight__title shout">{title.title}</p>
        {plan.note && <p className="tonight__note">{plan.note}</p>}

        <div className="tonight__actions">
          <button
            className="tonight__btn tonight__btn--go"
            disabled={busy}
            onClick={() =>
              act(async () => {
                // Resolving a plan is also a lifecycle transition. Doing
                // both here means the plan cannot end up marked done
                // while the watch record still says untouched.
                await setWatchStatus({
                  roomId, tmdbId: title.tmdb_id, mediaType: title.media_type,
                  userId, status: 'watching',
                });
                await resolvePlan(plan.id, PLAN_STATUS.DONE);
              })
            }
          >
            Started it
          </button>
          <button
            className="tonight__btn"
            disabled={busy}
            onClick={() => act(() => resolvePlan(plan.id, PLAN_STATUS.CANCELLED))}
          >
            Not tonight
          </button>
        </div>
      </div>
    </div>
  );
}
