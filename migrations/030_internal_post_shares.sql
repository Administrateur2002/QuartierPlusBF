CREATE TABLE IF NOT EXISTS post_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    destination_type VARCHAR(12) NOT NULL
        CHECK (destination_type IN ('ALLY', 'GROUP', 'CHANNEL')),
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    community_alliance_id UUID REFERENCES community_alliances(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (destination_type = 'ALLY'
            AND recipient_id IS NOT NULL
            AND community_alliance_id IS NULL
            AND channel_id IS NULL)
        OR
        (destination_type = 'GROUP'
            AND recipient_id IS NULL
            AND community_alliance_id IS NOT NULL
            AND channel_id IS NULL)
        OR
        (destination_type = 'CHANNEL'
            AND recipient_id IS NULL
            AND community_alliance_id IS NULL
            AND channel_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS post_shares_ally_unique_idx
    ON post_shares (post_id, sender_id, recipient_id)
    WHERE destination_type = 'ALLY';
CREATE UNIQUE INDEX IF NOT EXISTS post_shares_group_unique_idx
    ON post_shares (post_id, sender_id, community_alliance_id)
    WHERE destination_type = 'GROUP';
CREATE UNIQUE INDEX IF NOT EXISTS post_shares_channel_unique_idx
    ON post_shares (post_id, sender_id, channel_id)
    WHERE destination_type = 'CHANNEL';
CREATE INDEX IF NOT EXISTS post_shares_recipient_idx
    ON post_shares (recipient_id, created_at DESC)
    WHERE destination_type = 'ALLY';
CREATE INDEX IF NOT EXISTS post_shares_group_idx
    ON post_shares (community_alliance_id, created_at DESC)
    WHERE destination_type = 'GROUP';
CREATE INDEX IF NOT EXISTS post_shares_channel_idx
    ON post_shares (channel_id, created_at DESC)
    WHERE destination_type = 'CHANNEL';

INSERT INTO app_migrations (version)
VALUES ('030_internal_post_shares.sql')
ON CONFLICT (version) DO NOTHING;
