CREATE TABLE IF NOT EXISTS community_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    description VARCHAR(500) NOT NULL DEFAULT '',
    visibility VARCHAR(12) NOT NULL DEFAULT 'PRIVATE'
        CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
    status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_group_members (
    group_id UUID NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(12) NOT NULL DEFAULT 'MEMBER'
        CHECK (role IN ('OWNER', 'MEMBER')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_group_members_user_idx
    ON community_group_members (user_id, group_id);
CREATE INDEX IF NOT EXISTS community_groups_discovery_idx
    ON community_groups (created_at DESC)
    WHERE visibility = 'PUBLIC' AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS community_post_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    shared_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(12) NOT NULL
        CHECK (target_type IN ('ALLIANCE', 'GROUP')),
    alliance_id UUID REFERENCES community_alliances(id) ON DELETE CASCADE,
    group_id UUID REFERENCES community_groups(id) ON DELETE CASCADE,
    comment VARCHAR(1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (target_type = 'ALLIANCE' AND alliance_id IS NOT NULL AND group_id IS NULL)
        OR (target_type = 'GROUP' AND group_id IS NOT NULL AND alliance_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS community_post_shares_alliance_idx
    ON community_post_shares (alliance_id, created_at DESC)
    WHERE alliance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_post_shares_group_idx
    ON community_post_shares (group_id, created_at DESC)
    WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_post_shares_post_idx
    ON community_post_shares (post_id, created_at DESC);

INSERT INTO app_migrations (version)
VALUES ('044_community_groups_and_post_shares.sql')
ON CONFLICT (version) DO NOTHING;
