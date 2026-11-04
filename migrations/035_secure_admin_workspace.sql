ALTER TABLE users
    ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS admin_note VARCHAR(500),
    ADD COLUMN IF NOT EXISTS appeal_reason VARCHAR(500),
    ADD COLUMN IF NOT EXISTS appealed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS appealed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS moderation_target_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reports_moderation_queue_idx
    ON reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    target_type VARCHAR(40) NOT NULL,
    target_id UUID,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
    ON admin_audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_flash_broadcasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(80) NOT NULL,
    body VARCHAR(280) NOT NULL,
    target_type VARCHAR(20) NOT NULL CHECK (
        target_type IN ('ALL', 'COUNTRY', 'NEIGHBORHOOD', 'REGION')
    ),
    target JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'SCHEDULED' CHECK (
        status IN ('SCHEDULED', 'SENDING', 'SENT', 'FAILED')
    ),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    error_message VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_flash_broadcasts_due_idx
    ON admin_flash_broadcasts (scheduled_at)
    WHERE status = 'SCHEDULED';

INSERT INTO app_migrations (version)
VALUES ('035_secure_admin_workspace.sql')
ON CONFLICT (version) DO NOTHING;
