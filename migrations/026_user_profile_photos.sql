ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_photo_public_id TEXT,
    ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;

INSERT INTO app_migrations (version)
VALUES ('026_user_profile_photos.sql')
ON CONFLICT (version) DO NOTHING;
