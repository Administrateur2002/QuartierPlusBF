ALTER TABLE voy_tickets
    DROP CONSTRAINT IF EXISTS voy_tickets_status_check,
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(24) NOT NULL DEFAULT 'ONLINE',
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(16) NOT NULL DEFAULT 'PAID';

ALTER TABLE voy_tickets
    ADD CONSTRAINT voy_tickets_status_check
        CHECK (status IN ('VALID', 'RESERVED', 'USED', 'EXPIRED', 'CANCELLED')),
    ADD CONSTRAINT voy_tickets_payment_method_check
        CHECK (payment_method IN ('ONLINE', 'PAY_AT_STATION', 'FREE')),
    ADD CONSTRAINT voy_tickets_payment_status_check
        CHECK (payment_status IN ('PENDING', 'PAID'));

INSERT INTO app_migrations (version)
VALUES ('028_voyage_station_reservations.sql')
ON CONFLICT (version) DO NOTHING;
