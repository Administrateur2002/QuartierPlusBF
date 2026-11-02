ALTER TABLE sos_alerts
    ADD COLUMN IF NOT EXISTS emergency_type VARCHAR(20) NOT NULL DEFAULT 'OTHER';

ALTER TABLE sos_alerts
    ADD COLUMN IF NOT EXISTS emergency_audio_url TEXT;

ALTER TABLE sos_alerts
    DROP CONSTRAINT IF EXISTS sos_alerts_emergency_type_check;

ALTER TABLE sos_alerts
    ADD CONSTRAINT sos_alerts_emergency_type_check
    CHECK (emergency_type IN ('MEDICAL', 'SECURITY', 'FIRE', 'OTHER'));
