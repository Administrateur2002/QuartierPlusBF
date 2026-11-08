CREATE TABLE IF NOT EXISTS series (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    poster_url TEXT,
    country_code VARCHAR(3) REFERENCES country_config(code),
    language_code VARCHAR(12) NOT NULL DEFAULT 'fr',
    culture_tags TEXT[] NOT NULL DEFAULT '{}',
    credits JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (length(trim(title)) > 0)
);

CREATE TABLE IF NOT EXISTS series_seasons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    series_id UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL CHECK (season_number > 0),
    title VARCHAR(160) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (series_id, season_number)
);

CREATE TABLE IF NOT EXISTS series_episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    season_id UUID NOT NULL REFERENCES series_seasons(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL CHECK (episode_number > 0),
    title VARCHAR(160) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    video_url TEXT,
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    subtitles JSONB NOT NULL DEFAULT '[]'::jsonb,
    release_at TIMESTAMPTZ,
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (season_id, episode_number),
    UNIQUE (id, season_id)
);

CREATE TABLE IF NOT EXISTS series_episode_progress (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id UUID NOT NULL REFERENCES series_episodes(id) ON DELETE CASCADE,
    position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, episode_id)
);

CREATE TABLE IF NOT EXISTS series_episode_polls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    episode_id UUID NOT NULL UNIQUE REFERENCES series_episodes(id) ON DELETE CASCADE,
    question VARCHAR(240) NOT NULL DEFAULT 'Que doit-il se passer dans le prochain épisode ?',
    closes_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS series_episode_poll_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    poll_id UUID NOT NULL REFERENCES series_episode_polls(id) ON DELETE CASCADE,
    label VARCHAR(240) NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order > 0),
    UNIQUE (poll_id, sort_order),
    UNIQUE (id, poll_id)
);

CREATE TABLE IF NOT EXISTS series_episode_votes (
    poll_id UUID NOT NULL REFERENCES series_episode_polls(id) ON DELETE CASCADE,
    option_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, user_id),
    FOREIGN KEY (option_id, poll_id)
        REFERENCES series_episode_poll_options(id, poll_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS series_published_created_idx
    ON series (created_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS series_episodes_season_idx
    ON series_episodes (season_id, episode_number);
CREATE INDEX IF NOT EXISTS series_progress_updated_idx
    ON series_episode_progress (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS series_votes_option_idx
    ON series_episode_votes (option_id);

INSERT INTO app_migrations (version)
VALUES ('041_series_core.sql')
ON CONFLICT (version) DO NOTHING;