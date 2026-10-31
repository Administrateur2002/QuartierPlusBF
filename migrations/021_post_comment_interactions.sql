ALTER TABLE post_comments
    ADD COLUMN IF NOT EXISTS parent_comment_id UUID
        REFERENCES post_comments(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS post_comments_parent_idx
    ON post_comments (parent_comment_id, created_at ASC)
    WHERE parent_comment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS post_comment_likes (
    comment_id UUID NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (comment_id, user_id)
);