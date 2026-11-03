CREATE TABLE IF NOT EXISTS sponsored_pin_impressions (
    pin_id UUID NOT NULL REFERENCES sponsored_pins(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_on DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (pin_id, viewer_id, viewed_on)
);

CREATE INDEX IF NOT EXISTS sponsored_pin_impressions_pin_date_idx
    ON sponsored_pin_impressions (pin_id, viewed_on DESC);

INSERT INTO app_migrations (version)
VALUES ('033_sponsored_pin_impressions.sql')
ON CONFLICT (version) DO NOTHING;
