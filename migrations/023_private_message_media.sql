ALTER TABLE private_messages
    ADD COLUMN IF NOT EXISTS media_url TEXT,
    ADD COLUMN IF NOT EXISTS media_type VARCHAR(20);