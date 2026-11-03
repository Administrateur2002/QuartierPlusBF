CREATE TABLE IF NOT EXISTS grin_moderation_events (
    id UUID PRIMARY KEY,
    room_name VARCHAR(100) NOT NULL,
    participant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_sid VARCHAR(100) NOT NULL,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('AUDIO', 'VIDEO')),
    category VARCHAR(100) NOT NULL,
    confidence NUMERIC(5, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    status VARCHAR(32) NOT NULL CHECK (
        status IN (
            'PENDING_REVIEW',
            'PAUSED_PENDING_REVIEW',
            'APPEALED',
            'CLEARED',
            'CONFIRMED'
        )
    ),
    appeal_reason VARCHAR(500),
    appealed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS grin_moderation_events_queue_idx
    ON grin_moderation_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS grin_moderation_events_participant_idx
    ON grin_moderation_events (participant_id, created_at DESC);

INSERT INTO app_migrations (version)
VALUES ('034_grin_live_moderation.sql')
ON CONFLICT (version) DO NOTHING;
