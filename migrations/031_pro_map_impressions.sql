CREATE TABLE IF NOT EXISTS pro_map_impressions (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_type VARCHAR(50) NOT NULL,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_on DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (owner_id, plan_type, viewer_id, viewed_on)
);

CREATE INDEX IF NOT EXISTS pro_map_impressions_owner_date_idx
    ON pro_map_impressions (owner_id, viewed_on DESC);

INSERT INTO app_migrations (version)
VALUES ('031_pro_map_impressions.sql')
ON CONFLICT (version) DO NOTHING;
