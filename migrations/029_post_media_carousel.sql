CREATE TABLE IF NOT EXISTS post_media_items (
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position BETWEEN 2 AND 10),
    media_public_id VARCHAR(255) NOT NULL UNIQUE,
    media_url TEXT NOT NULL,
    media_format VARCHAR(10) NOT NULL CHECK (
        media_format IN ('jpg', 'jpeg', 'png', 'webp')
    ),
    media_bytes BIGINT NOT NULL CHECK (media_bytes > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, position)
);
