CREATE TABLE IF NOT EXISTS app_migrations (
    version VARCHAR(128) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_alliances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(32) NOT NULL CHECK (
        category IN ('ENTRAIDE', 'COMMERCIAL', 'EVENEMENT', 'SPORT', 'COMMUNAUTE', 'AUTRE')
    ),
    objective TEXT NOT NULL,
    due_date TIMESTAMPTZ,
    location VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED')),
    participants JSONB NOT NULL DEFAULT '[]'::jsonb,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    notifications JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_note TEXT,
    proof_url TEXT,
    completion_confirmations INTEGER NOT NULL DEFAULT 0 CHECK (completion_confirmations >= 0),
    participant_count INTEGER NOT NULL DEFAULT 1 CHECK (participant_count >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_alliance_members (
    alliance_id UUID NOT NULL REFERENCES community_alliances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'PARTICIPANT'
        CHECK (role IN ('CREATOR', 'PARTICIPANT')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (alliance_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_alliance_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alliance_id UUID NOT NULL REFERENCES community_alliances(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS community_alliances_creator_idx
    ON community_alliances (creator_id, status);

CREATE INDEX IF NOT EXISTS community_alliance_members_user_idx
    ON community_alliance_members (user_id);

INSERT INTO app_migrations (version)
VALUES ('024_community_alliances.sql')
ON CONFLICT (version) DO NOTHING;
