import { supabase } from './supabase.js';
import { PLAN_STATUS } from './plans-pure.js';

// The decision layer.
//
// The app could record that you both wanted something and that you had
// watched it, with nothing in between. That gap is where the actual
// decision lives, and it is the reason Tonight's Pick felt like a toy:
// it produced a winner and then dropped it.
//
// A plan is an intention. It can be abandoned without ever becoming a
// watch, which is exactly why it is not a status on `watched`.

export async function fetchPlans(roomId) {
  const { data, error } = await supabase
    .from('plans')
    .select('id,tmdb_id,media_type,created_by,created_at,planned_for,note,status,resolved_at')
    .eq('room_id', roomId)
    .eq('status', PLAN_STATUS.PLANNED)
    // Undated plans sort last: a plan with a date is an appointment,
    // one without is "sometime", and the appointment is the one you
    // need to see first.
    .order('planned_for', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addPlan({ roomId, tmdbId, mediaType, userId, plannedFor, note }) {
  const { data, error } = await supabase
    .from('plans')
    .insert({
      room_id: roomId,
      tmdb_id: tmdbId,
      media_type: mediaType,
      created_by: userId,
      planned_for: plannedFor || null,
      note: note?.trim() ? note.trim().slice(0, 200) : null,
    })
    .select()
    .single();
  // A duplicate is not an error worth surfacing: it means the plan
  // already exists, which is the state the user was trying to reach.
  if (error && error.code === '23505') return null;
  if (error) throw error;
  return data;
}

export async function resolvePlan(planId, status) {
  const { error } = await supabase
    .from('plans')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', planId);
  if (error) throw error;
}

export { PLAN_STATUS, tonightPlan, upcomingPlans, overduePlans } from './plans-pure.js';
