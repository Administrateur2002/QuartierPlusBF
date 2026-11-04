CREATE TABLE IF NOT EXISTS moderation_lexicon (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    term VARCHAR(100) NOT NULL,
    language VARCHAR(12) NOT NULL DEFAULT 'fr',
    category VARCHAR(16) NOT NULL CHECK (category IN ('INSULT', 'THREAT')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS moderation_lexicon_term_language_idx
    ON moderation_lexicon (LOWER(term), language);

INSERT INTO moderation_lexicon (term, language, category)
VALUES
    ('connard', 'fr', 'INSULT'),
    ('connasse', 'fr', 'INSULT'),
    ('salaud', 'fr', 'INSULT'),
    ('salope', 'fr', 'INSULT'),
    ('imbécile', 'fr', 'INSULT'),
    ('idiot', 'fr', 'INSULT'),
    ('je vais te tuer', 'fr', 'THREAT'),
    ('je vais vous tuer', 'fr', 'THREAT'),
    ('je vais te frapper', 'fr', 'THREAT'),
    ('je vais vous frapper', 'fr', 'THREAT'),
    ('je vais te faire du mal', 'fr', 'THREAT'),
    ('je vais vous faire du mal', 'fr', 'THREAT')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS moderation_conflicts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_type VARCHAR(24) NOT NULL CHECK (
        target_type IN ('POST', 'COMMENT', 'CHANNEL_MESSAGE', 'LIVE_TEXT', 'REPORT')
    ),
    target_id UUID,
    category VARCHAR(16) NOT NULL CHECK (category IN ('INSULT', 'THREAT', 'REPEATED_REPORTS')),
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'WARNED', 'SUSPENDED', 'RESOLVED', 'DISMISSED')
    ),
    appeal_reason VARCHAR(500),
    appealed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS moderation_conflicts_queue_idx
    ON moderation_conflicts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_conflicts_pair_idx
    ON moderation_conflicts (actor_id, target_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS moderation_conflicts_repeated_reports_idx
    ON moderation_conflicts (target_type, target_id)
    WHERE category = 'REPEATED_REPORTS'
      AND status IN ('PENDING', 'WARNED', 'SUSPENDED');

CREATE TABLE IF NOT EXISTS user_moderation_pauses (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    paused_until TIMESTAMPTZ NOT NULL,
    reason VARCHAR(24) NOT NULL DEFAULT 'REPEATED_HOSTILITY',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_mutes (
    muter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (muter_id, muted_id),
    CHECK (muter_id <> muted_id)
);

CREATE INDEX IF NOT EXISTS user_mutes_muted_idx
    ON user_mutes (muted_id, muter_id);

INSERT INTO app_migrations (version)
VALUES ('037_public_text_conflicts.sql')
ON CONFLICT (version) DO NOTHING;
