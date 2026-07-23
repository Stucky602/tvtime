-- Architecture ref: ARCHITECTURE_v1.0.md §3.1, §2.4, §4.3, §4.4, §5.2
--
-- `titles` is a single GLOBAL cache (§5.1) -- there is deliberately no
-- per-room pool table. A room's pool is just this table filtered by
-- `providers && room.platforms` at query time (component 9). Don't add a
-- room_id here later without re-reading §5.1's reasoning first.

create table titles (
  tmdb_id              int not null,
  media_type           text not null check (media_type in ('movie','tv')),
  title                text not null,
  year                 int,
  runtime              int,                    -- minutes; see §4.3 for the movie/tv split
  synopsis             text,
  poster_path          text,                   -- nullable; client shows a placeholder card, §9
  backdrop_path        text,
  rating               numeric,                -- TMDB vote_average
  vote_count           int,                    -- needed to floor out low-sample ratings, §5.2
  popularity           numeric,
  original_language    text,
  genres               int[] not null default '{}',  -- CANONICAL ids, not raw TMDB -- see genre_map (component 4)
  providers             text[] not null default '{}', -- flatrate providers this title is actually on, US
  providers_updated_at  timestamptz,
  detail_updated_at     timestamptz,
  excluded              boolean not null default false,  -- §4.4 TV quality exclusions; flag, never delete
  primary key (tmdb_id, media_type)
);
create index titles_genres_gin_idx on titles using gin (genres);
create index titles_providers_gin_idx on titles using gin (providers);
create index titles_popularity_idx on titles (popularity desc) where not excluded;
alter table titles enable row level security;

create table swipes (
  user_id          uuid not null references users(id) on delete cascade,
  tmdb_id          int not null,
  media_type       text not null,
  direction        text not null check (direction in ('left','right')),
  voted_at         timestamptz not null default now(),
  resurface_after  timestamptz,   -- null = never resurface, the v1 default (nothing writes this yet)
  score_debug      jsonb,         -- component 9's score breakdown for this swipe; §5.2, "log the score"
  primary key (user_id, tmdb_id, media_type),
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);
create index swipes_title_idx on swipes (tmdb_id, media_type);
create index swipes_user_recent_idx on swipes (user_id, voted_at desc);
alter table swipes enable row level security;

-- Room-scoped, not user-scoped -- watching is a joint act (§2.4). Either
-- partner can mark or unmark; no per-user watched state and no
-- confirmation step, which is the correct amount of ceremony for two
-- people who live together.
create table watched (
  room_id     uuid not null references rooms(id) on delete cascade,
  tmdb_id     int not null,
  media_type  text not null,
  marked_by   uuid not null references users(id),
  marked_at   timestamptz not null default now(),
  verdict     text check (verdict in ('up','down')),  -- null = no rating given; §2.4 v0.4 addition,
                                                        -- nothing reads this in v1, it just accumulates
  primary key (room_id, tmdb_id, media_type),
  foreign key (tmdb_id, media_type) references titles(tmdb_id, media_type)
);
alter table watched enable row level security;
