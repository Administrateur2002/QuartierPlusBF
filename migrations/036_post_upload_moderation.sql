ALTER TABLE posts
    DROP CONSTRAINT IF EXISTS posts_status_check;

ALTER TABLE posts
    ADD CONSTRAINT posts_status_check
    CHECK (status IN ('ACTIVE', 'HIDDEN', 'DELETED', 'PENDING_REVIEW'));

CREATE TABLE IF NOT EXISTS moderation_daily_usage (
    usage_date DATE PRIMARY KEY,
    analysis_count INTEGER NOT NULL CHECK (analysis_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_moderation_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    media_id VARCHAR(255) NOT NULL,
    score NUMERIC(5, 2) CHECK (score BETWEEN 0 AND 100),
    status VARCHAR(32) NOT NULL CHECK (
        status IN (
            'PENDING_REVIEW',
            'BLOCKED',
            'APPROVED',
            'CLEARED',
            'CHILD_SAFETY_ALERT',
            'APPEALED',
            'CONFIRMED'
        )
    ),
    appeal_reason VARCHAR(500),
    appealed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS post_moderation_events_queue_idx
    ON post_moderation_events (status, created_at DESC);

INSERT INTO app_migrations (version)
VALUES ('036_post_upload_moderation.sql')
ON CONFLICT (version) DO NOTHING;
