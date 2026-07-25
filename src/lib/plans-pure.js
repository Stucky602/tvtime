// Pure plan selection. Split from plans.js for the same reason
// notes-pure.js, secret-pure.js, and picks-pure.js exist: supabase.js
// reads import.meta.env at module load, so anything importing it cannot
// be loaded outside a Vite build, including by the test runner.
//
// This has now happened often enough to be a convention rather than a
// workaround: if a lib module holds logic worth testing, the logic goes
// in a `-pure` sibling and the I/O module re-exports it.

export const PLAN_STATUS = { PLANNED: 'planned', DONE: 'done', CANCELLED: 'cancelled' };

/**
 * The one plan that counts as "tonight".
 *
 * Today's dated plan wins; otherwise the most recently made undated
 * one. An overdue plan is deliberately NOT promoted -- a date you
 * missed is a thing to reschedule, not a thing to be nagged about every
 * evening afterwards.
 */
export function tonightPlan(plans, today = new Date()) {
  if (!plans?.length) return null;
  const iso = today.toISOString().slice(0, 10);
  const dated = plans.find((p) => p.planned_for === iso);
  if (dated) return dated;
  return plans.find((p) => !p.planned_for) || null;
}

/** Dated plans still ahead of us. */
export function upcomingPlans(plans, today = new Date()) {
  const iso = today.toISOString().slice(0, 10);
  return (plans || []).filter((p) => p.planned_for && p.planned_for > iso);
}

/** Dated plans whose day has passed without being resolved. */
export function overduePlans(plans, today = new Date()) {
  const iso = today.toISOString().slice(0, 10);
  return (plans || []).filter((p) => p.planned_for && p.planned_for < iso);
}
