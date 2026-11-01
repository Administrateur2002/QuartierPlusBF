ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_photo_public_id TEXT,
    ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
