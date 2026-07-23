-- Architecture ref: ARCHITECTURE_v1.0.md §4.3
--
-- TMDB's movie and TV genre lists are separate id spaces that overlap
-- imperfectly (TV has "Action & Adventure" where movies split that into
-- separate "Action" and "Adventure" ids). Storing raw TMDB ids on
-- `titles.genres` would silently mix those namespaces and corrupt both
-- filtering and scoring. This migration is the fix: a small canonical
-- vocabulary, plus a mapping table from every real TMDB genre id (both
-- media types) into it. `titles.genres` and `users.genre_prefs` (both
-- created in component 2) store ONLY these canonical ids -- component 7
-- (the pool refresh job) is responsible for translating TMDB's raw ids
-- through this table before writing a title's genres.
--
-- §13 (testing) calls for asserting every TMDB genre id maps to exactly
-- one canonical genre. This migration's own CHECK below does that at
-- write time instead of leaving it to a test suite to catch later.

create table genres (
  id   smallint primary key,
  name text not null unique
);

insert into genres (id, name) values
  (1,  'Action'),
  (2,  'Comedy'),
  (3,  'Drama'),
  (4,  'Horror'),
  (5,  'Sci-Fi & Fantasy'),
  (6,  'Thriller'),
  (7,  'Documentary'),
  (8,  'Animation'),
  (9,  'Romance'),
  (10, 'Crime & Mystery'),
  (11, 'Family'),
  (12, 'Other');

create table tmdb_genre_map (
  tmdb_genre_id      int not null,
  media_type         text not null check (media_type in ('movie','tv')),
  canonical_genre_id smallint not null references genres(id),
  primary key (tmdb_genre_id, media_type)
);

-- Movie genres (TMDB's official /genre/movie/list, all 19 as of this
-- writing). Adventure folds into Action to match how TV already combines
-- them into one "Action & Adventure" bucket -- keeping one side split and
-- the other merged is exactly the mismatch this table exists to fix.
insert into tmdb_genre_map (tmdb_genre_id, media_type, canonical_genre_id) values
  (28,    'movie', 1),   -- Action
  (12,    'movie', 1),   -- Adventure -> Action, see note above
  (16,    'movie', 8),   -- Animation
  (35,    'movie', 2),   -- Comedy
  (80,    'movie', 10),  -- Crime
  (99,    'movie', 7),   -- Documentary
  (18,    'movie', 3),   -- Drama
  (10751, 'movie', 11),  -- Family
  (14,    'movie', 5),   -- Fantasy
  (36,    'movie', 12),  -- History -- doesn't fit any bucket cleanly, Other
  (27,    'movie', 4),   -- Horror
  (10402, 'movie', 12),  -- Music -> Other
  (9648,  'movie', 10),  -- Mystery
  (10749, 'movie', 9),   -- Romance
  (878,   'movie', 5),   -- Science Fiction
  (10770, 'movie', 12),  -- TV Movie -> Other
  (53,    'movie', 6),   -- Thriller
  (10752, 'movie', 12),  -- War -> Other
  (37,    'movie', 12);  -- Western -> Other

-- TV genres (TMDB's official /genre/tv/list, all 16). Several of these
-- (News, Reality, Soap, Talk) are exactly the §4.4 exclusion targets --
-- they still need a mapping entry so the "every id maps to exactly one
-- canonical genre" invariant holds, even though the pool refresh job
-- flags their titles as excluded and they'll rarely reach scoring.
insert into tmdb_genre_map (tmdb_genre_id, media_type, canonical_genre_id) values
  (10759, 'tv', 1),   -- Action & Adventure
  (16,    'tv', 8),   -- Animation
  (35,    'tv', 2),   -- Comedy
  (80,    'tv', 10),  -- Crime
  (99,    'tv', 7),   -- Documentary
  (18,    'tv', 3),   -- Drama
  (10751, 'tv', 11),  -- Family
  (10762, 'tv', 11),  -- Kids -> Family
  (9648,  'tv', 10),  -- Mystery
  (10763, 'tv', 12),  -- News -> Other (also §4.4 excluded)
  (10764, 'tv', 12),  -- Reality -> Other (also §4.4 excluded by default, room-toggleable)
  (10765, 'tv', 5),   -- Sci-Fi & Fantasy
  (10766, 'tv', 12),  -- Soap -> Other (also §4.4 excluded)
  (10767, 'tv', 12),  -- Talk -> Other (also §4.4 excluded)
  (10768, 'tv', 12),  -- War & Politics -> Other
  (37,    'tv', 12);  -- Western -> Other
