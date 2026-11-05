CREATE TABLE IF NOT EXISTS sms_daily_usage (
    usage_date DATE PRIMARY KEY,
    sent_count INTEGER NOT NULL CHECK (sent_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media_upload_daily_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL,
    upload_count INTEGER NOT NULL CHECK (upload_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, usage_date)
);

INSERT INTO app_migrations (version)
VALUES ('039_usage_limits.sql')
ON CONFLICT (version) DO NOTHING;
