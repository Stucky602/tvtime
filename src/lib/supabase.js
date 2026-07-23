// Architecture ref: ARCHITECTURE_v1.0.md §7, §8, §4.2
//
// The client only ever talks to Supabase and to TMDB's public image CDN
// (§4.2). There is no app server -- GitHub Pages serves static files.
//
// Anonymous sign-in (§7): every device gets a real auth.users row and a
// JWT, so RLS works properly and identity survives app restarts, with no
// signup friction. Note this still produces the `authenticated` role,
// not `anon` -- every policy in component 5 targets `authenticated`.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

if (!isConfigured) {
  // Both values are public by design (§8) -- RLS is the actual gate --
  // so they live in .env, not in repo secrets.
  console.error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env ' +
      'and fill both in. See README > Database.'
  );
}

// createClient throws on an empty URL, and because this module is
// imported at the top of the data layer, that throw happens during
// module evaluation -- before React renders anything. The result is a
// blank white screen with the real cause buried in the console.
//
// A placeholder URL keeps construction from throwing so the app can
// mount and show a readable "not configured" state instead. Every
// request against it fails, which is correct: the app genuinely cannot
// work without real credentials. It just fails legibly now.
export const supabase = createClient(
  url || 'http://localhost:54321',
  anonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

/**
 * Resolves to the current session, signing in anonymously if there
 * isn't one. Safe to call repeatedly -- an existing session short-
 * circuits.
 *
 * §7's known cost: this identity lives in device local storage, so
 * clearing browser data loses it. That is what the reclaim flow
 * (component 6's reclaim_membership) exists to recover from.
 */
export async function ensureSession() {
  const { data: existing } = await supabase.auth.getSession();
  if (existing?.session) return existing.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

/** Thin wrapper so callers get the jsonb `status` convention, not a raw envelope. */
export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
