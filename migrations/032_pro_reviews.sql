CREATE TABLE IF NOT EXISTS pro_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, reviewer_id),
    CHECK (owner_id <> reviewer_id)
);

CREATE INDEX IF NOT EXISTS pro_reviews_owner_recent_idx
    ON pro_reviews (owner_id, created_at DESC);

INSERT INTO app_migrations (version)
VALUES ('032_pro_reviews.sql')
ON CONFLICT (version) DO NOTHING;
