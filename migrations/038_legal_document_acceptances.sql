CREATE TABLE IF NOT EXISTS legal_document_acceptances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id VARCHAR(40) NOT NULL CHECK (
        document_id IN (
            'terms',
            'privacy',
            'golden_rules',
            'pro_terms',
            'sos_safety',
            'automated_moderation'
        )
    ),
    version VARCHAR(40) NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    app_version VARCHAR(40) NOT NULL,
    age_16_or_older BOOLEAN NOT NULL CHECK (age_16_or_older = TRUE),
    UNIQUE (user_id, document_id, version)
);

CREATE INDEX IF NOT EXISTS legal_document_acceptances_user_idx
    ON legal_document_acceptances (user_id, document_id, accepted_at DESC);

INSERT INTO app_migrations (version)
VALUES ('038_legal_document_acceptances.sql')
ON CONFLICT (version) DO NOTHING;
