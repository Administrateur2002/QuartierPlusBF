CREATE TABLE IF NOT EXISTS community_alliance_invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alliance_id UUID NOT NULL REFERENCES community_alliances(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (inviter_id <> invitee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS community_alliance_invitations_pending_idx
    ON community_alliance_invitations (alliance_id, invitee_id)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS community_alliance_invitations_received_idx
    ON community_alliance_invitations (invitee_id, created_at DESC)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS community_alliance_invitations_sent_idx
    ON community_alliance_invitations (inviter_id, created_at DESC)
    WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS community_alliance_completion_confirmations (
    alliance_id UUID NOT NULL REFERENCES community_alliances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (alliance_id, user_id)
);

INSERT INTO community_alliance_members (alliance_id, user_id, role, joined_at)
SELECT alliance.id, alliance.creator_id, 'CREATOR', alliance.created_at
FROM community_alliances alliance
ON CONFLICT (alliance_id, user_id) DO NOTHING;

INSERT INTO community_alliance_members (alliance_id, user_id, role, joined_at)
SELECT alliance.id, member.id,
       CASE WHEN member.id = alliance.creator_id THEN 'CREATOR' ELSE 'PARTICIPANT' END,
       alliance.created_at
FROM community_alliances alliance
CROSS JOIN LATERAL jsonb_array_elements_text(alliance.participants) participant(user_id)
JOIN users member ON member.id::text = participant.user_id
ON CONFLICT (alliance_id, user_id) DO NOTHING;

UPDATE community_alliances alliance
SET participant_count = GREATEST(
    1,
    (SELECT COUNT(*)::int
     FROM community_alliance_members membership
     WHERE membership.alliance_id = alliance.id)
);

INSERT INTO app_migrations (version)
VALUES ('045_community_alliance_projects.sql')
ON CONFLICT (version) DO NOTHING;
