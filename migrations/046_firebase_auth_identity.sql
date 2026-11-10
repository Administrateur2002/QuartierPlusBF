ALTER TABLE users
    ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_unique_idx
    ON users (firebase_uid)
    WHERE firebase_uid IS NOT NULL;

INSERT INTO app_migrations (version)
VALUES ('046_firebase_auth_identity.sql')
ON CONFLICT (version) DO NOTHING;