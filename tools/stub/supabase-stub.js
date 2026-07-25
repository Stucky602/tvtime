// Stub standing in for src/lib/supabase.js so the REAL App tree can be
// mounted and exercised without a backend.
const TITLES = Array.from({ length: 12 }, (_, i) => ({
  tmdb_id: 100 + i, media_type: 'movie', title: `Stub Title ${i + 1}`,
  year: 2020, runtime: 100, synopsis: 'x', poster_path: null, backdrop_path: null,
  rating: 7, vote_count: 500, popularity: 50, genres: [3], providers: ['netflix'],
  is_reality: false, original_language: 'en', keyword_ids: [], cast_ids: [],
  cast_names: [], director_ids: [], director_names: [],
  episode_count: null, season_count: null, excluded: false,
}));
const ok = (data = []) => Promise.resolve({ data, error: null });
const chain = (table) => {
  const rows = table === 'titles' ? TITLES : [];
  const c = {};
  const self = () => c;
  for (const m of ['select','eq','in','is','not','gt','gte','lt','order','limit','ilike','filter','overlaps','contains','or','neq','range']) c[m] = self;
  c.single = () => ok(null);
  c.maybeSingle = () => ok(null);
  c.then = (res) => ok(rows).then(res);
  c.insert = () => ({ select: () => ({ single: () => ok({ id: 'x' }) }), then: (r) => ok([]).then(r) });
  c.upsert = () => ok([]);
  c.update = () => c;
  c.delete = () => c;
  return c;
};
export const supabase = {
  from: (t) => chain(t),
  auth: {
    getUser: () => Promise.resolve({ data: { user: { id: 'me' } } }),
    signInAnonymously: () => Promise.resolve({ data: { session: { user: { id: 'me' } } }, error: null }),
    getSession: () => Promise.resolve({ data: { session: { user: { id: 'me' } } } }),
  },
  channel: () => ({ on: function () { return this; }, subscribe: () => {}, presenceState: () => ({}), track: () => {} }),
  removeChannel: () => {},
};
export const isConfigured = true;
export async function ensureSession() { return { user: { id: 'me' } }; }
export async function rpc() { return { status: 'OK' }; }
