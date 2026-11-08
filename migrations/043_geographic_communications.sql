CREATE TABLE IF NOT EXISTS communication_areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scope VARCHAR(16) NOT NULL CHECK (
        scope IN ('neighborhood', 'commune', 'region')
    ),
    name VARCHAR(150) NOT NULL,
    country_code VARCHAR(3) NOT NULL REFERENCES country_config(code),
    parent_area_id UUID REFERENCES communication_areas(id) ON DELETE SET NULL,
    boundary GEOMETRY(MultiPolygon, 4326) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT ST_IsEmpty(boundary))
);

CREATE UNIQUE INDEX IF NOT EXISTS communication_areas_name_scope_country_idx
    ON communication_areas (country_code, scope, lower(name), COALESCE(parent_area_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS communication_areas_boundary_gist_idx
    ON communication_areas USING GIST (boundary);

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS geography_scope VARCHAR(16) NOT NULL DEFAULT 'country'
        CHECK (geography_scope IN (
            'neighborhood', 'commune', 'region', 'country', 'international'
        )),
    ADD COLUMN IF NOT EXISTS communication_area_id UUID
        REFERENCES communication_areas(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS channels_communication_area_kind_idx
    ON channels (communication_area_id, kind)
    WHERE communication_area_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_geographic_channel_follows (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS information_type VARCHAR(16) NOT NULL DEFAULT 'COMMUNITY'
        CHECK (information_type IN ('COMMUNITY', 'OFFICIAL')),
    ADD COLUMN IF NOT EXISTS institution_id UUID,
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS institutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    institution_type VARCHAR(24) NOT NULL CHECK (
        institution_type IN (
            'MUNICIPALITY', 'PREFECTURE', 'MINISTRY',
            'ADMINISTRATION', 'PUBLIC_SERVICE'
        )
    ),
    country_code VARCHAR(3) NOT NULL REFERENCES country_config(code),
    communication_area_id UUID REFERENCES communication_areas(id) ON DELETE SET NULL,
    municipality_id UUID REFERENCES municipalities(id) ON DELETE SET NULL,
    legal_identifier VARCHAR(100) NOT NULL,
    proof_url TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED')
    ),
    submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_note VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (country_code, legal_identifier)
);

CREATE TABLE IF NOT EXISTS institution_memberships (
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'PUBLISHER' CHECK (
        role IN ('OWNER', 'PUBLISHER')
    ),
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'ACTIVE', 'REVOKED')
    ),
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (institution_id, user_id)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_institution_id_fkey'
          AND conrelid = 'messages'::regclass
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT messages_institution_id_fkey
            FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE SET NULL;
    END IF;
END
$$;

ALTER TABLE official_news
    ADD COLUMN IF NOT EXISTS institution_id UUID
        REFERENCES institutions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS official_news_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    official_news_id UUID NOT NULL REFERENCES official_news(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(16) NOT NULL CHECK (action IN ('PUBLISHED', 'EDITED', 'WITHDRAWN')),
    previous_body TEXT,
    new_body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS official_message_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(16) NOT NULL CHECK (action IN ('PUBLISHED', 'EDITED', 'WITHDRAWN')),
    previous_body TEXT,
    new_body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS official_message_history_message_idx
    ON official_message_history (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_channel_created_idx
    ON messages (channel_id, created_at DESC)
    WHERE removed_at IS NULL;

INSERT INTO channels (name, kind, country_code, geography_scope)
SELECT country.name || ' · Communauté', 'COMMUNITY', country.code, 'country'
FROM country_config AS country
WHERE NOT EXISTS (
    SELECT 1 FROM channels AS channel
    WHERE channel.kind = 'COMMUNITY'
      AND channel.country_code = country.code
      AND channel.communication_area_id IS NULL
);

INSERT INTO channels (name, kind, geography_scope)
SELECT 'International · Communauté', 'COMMUNITY', 'international'
WHERE NOT EXISTS (
    SELECT 1 FROM channels
    WHERE kind = 'COMMUNITY'
      AND geography_scope = 'international'
      AND country_code IS NULL
      AND communication_area_id IS NULL
);

INSERT INTO app_migrations (version)
VALUES ('043_geographic_communications.sql')
ON CONFLICT (version) DO NOTHING;
