ALTER TABLE pro_wholesalers
    ADD COLUMN IF NOT EXISTS rccm_number VARCHAR(80),
    ADD COLUMN IF NOT EXISTS ifu_number VARCHAR(80);

INSERT INTO app_migrations (version)
VALUES ('027_wholesaler_optional_registration_fields.sql')
ON CONFLICT (version) DO NOTHING;
