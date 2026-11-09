import { pool } from "../db/pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (value) => typeof value === "string" && UUID_PATTERN.test(value);

export const listCommunityAlliances = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT alliance.id, alliance.creator_id, alliance.title,
              alliance.description, alliance.category, alliance.objective,
              alliance.due_date, alliance.location, alliance.status,
              alliance.created_at, alliance.updated_at,
              COUNT(membership.user_id)::int AS participant_count,
              COALESCE(BOOL_OR(membership.user_id = $1::uuid), FALSE) AS is_member
       FROM community_alliances alliance
       LEFT JOIN community_alliance_members membership
         ON membership.alliance_id = alliance.id
       WHERE alliance.status NOT IN ('CANCELLED', 'DISPUTED')
       GROUP BY alliance.id
       ORDER BY alliance.updated_at DESC, alliance.created_at DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ alliances: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listMyCommunityAlliances = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT alliance.id, alliance.creator_id, alliance.title,
              alliance.description, alliance.category, alliance.objective,
              alliance.due_date, alliance.location, alliance.status,
              alliance.created_at, alliance.updated_at,
              COUNT(members.user_id)::int AS participant_count,
              TRUE AS is_member
       FROM community_alliance_members current_membership
       JOIN community_alliances alliance
         ON alliance.id = current_membership.alliance_id
       LEFT JOIN community_alliance_members members
         ON members.alliance_id = alliance.id
       WHERE current_membership.user_id = $1
       GROUP BY alliance.id
       ORDER BY alliance.updated_at DESC, alliance.created_at DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ alliances: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getCommunityAlliance = async (request, response, next) => {
  const allianceId = request.params.allianceId;
  if (!validId(allianceId)) {
    return response.status(400).json({ error: "Identifiant de projet invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT alliance.id, alliance.creator_id, alliance.title,
              alliance.description, alliance.category, alliance.objective,
              alliance.due_date, alliance.location, alliance.status,
              alliance.validation_note, alliance.proof_url,
              alliance.completion_confirmations, alliance.created_at,
              alliance.updated_at,
              COUNT(membership.user_id)::int AS participant_count,
              COALESCE(BOOL_OR(membership.user_id = $2::uuid), FALSE) AS is_member,
              EXISTS (
                SELECT 1 FROM community_alliance_completion_confirmations confirmation
                WHERE confirmation.alliance_id = alliance.id
                  AND confirmation.user_id = $2
              ) AS has_confirmed_completion
       FROM community_alliances alliance
       LEFT JOIN community_alliance_members membership
         ON membership.alliance_id = alliance.id
       WHERE alliance.id = $1
       GROUP BY alliance.id
       HAVING alliance.status NOT IN ('CANCELLED', 'DISPUTED')
          OR BOOL_OR(membership.user_id = $2::uuid)`,
      [allianceId, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Projet introuvable." });
    }
    return response.status(200).json({ alliance: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const listCommunityAllianceParticipants = async (request, response, next) => {
  const allianceId = request.params.allianceId;
  if (!validId(allianceId)) {
    return response.status(400).json({ error: "Identifiant de projet invalide." });
  }
  try {
    const access = await pool.query(
      `SELECT 1 FROM community_alliance_members
       WHERE alliance_id = $1 AND user_id = $2`,
      [allianceId, request.auth.userId],
    );
    if (!access.rowCount) {
      return response.status(404).json({ error: "Projet introuvable ou accès non autorisé." });
    }
    const result = await pool.query(
      `SELECT users.id, users.full_name AS name, users.profile_photo_url,
              users.badge, membership.role, membership.joined_at
       FROM community_alliance_members membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.alliance_id = $1
       ORDER BY CASE WHEN membership.role = 'CREATOR' THEN 0 ELSE 1 END,
                users.full_name NULLS LAST`,
      [allianceId],
    );
    return response.status(200).json({ participants: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const joinCommunityAlliance = async (request, response, next) => {
  const allianceId = request.params.allianceId;
  const userId = request.auth.userId;
  if (!validId(allianceId)) {
    return response.status(400).json({ error: "Identifiant de projet invalide." });
  }
  try {
    const joined = await pool.query(
      `WITH eligible AS (
         SELECT alliance.id
         FROM community_alliances alliance
         WHERE alliance.id = $1
           AND alliance.status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS')
           AND NOT EXISTS (
             SELECT 1
             FROM community_alliance_members other_membership
             JOIN user_blocks blocked
               ON (blocked.blocker_id = $2 AND blocked.blocked_id = other_membership.user_id)
               OR (blocked.blocker_id = other_membership.user_id AND blocked.blocked_id = $2)
             WHERE other_membership.alliance_id = alliance.id
           )
       ), joined AS (
         INSERT INTO community_alliance_members (alliance_id, user_id, role)
         SELECT eligible.id, $2, 'PARTICIPANT'
         FROM eligible
         ON CONFLICT (alliance_id, user_id) DO NOTHING
         RETURNING alliance_id, user_id
       ), updated AS (
         UPDATE community_alliances alliance
         SET participants = CASE
               WHEN alliance.participants @> jsonb_build_array($2::text)
                 THEN alliance.participants
               ELSE alliance.participants || jsonb_build_array($2::text)
             END,
             participant_count = alliance.participant_count + 1,
             updated_at = NOW()
         FROM joined
         WHERE alliance.id = joined.alliance_id
         RETURNING alliance.id, alliance.title, alliance.status,
                   alliance.participant_count
       ), accepted_invitation AS (
         UPDATE community_alliance_invitations invitation
         SET status = 'ACCEPTED', updated_at = NOW()
         FROM joined
         WHERE invitation.alliance_id = joined.alliance_id
           AND invitation.invitee_id = joined.user_id
           AND invitation.status = 'PENDING'
         RETURNING invitation.id
       )
       SELECT * FROM updated`,
      [allianceId, userId],
    );
    if (!joined.rowCount) {
      const membership = await pool.query(
        `SELECT alliance.id, alliance.title, alliance.status,
                alliance.participant_count
         FROM community_alliance_members member
         JOIN community_alliances alliance ON alliance.id = member.alliance_id
         WHERE member.alliance_id = $1 AND member.user_id = $2
           AND alliance.status NOT IN ('CANCELLED', 'DISPUTED')`,
        [allianceId, userId],
      );
      if (membership.rowCount) {
        return response.status(200).json({
          joined: true,
          already_member: true,
          alliance: membership.rows[0],
        });
      }
      return response.status(404).json({
        error: "Projet indisponible pour la participation ou accès bloqué.",
      });
    }
    return response.status(200).json({ joined: true, alliance: joined.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const inviteCommunityAllianceMember = async (request, response, next) => {
  const allianceId = request.params.allianceId;
  const inviteeId = request.body?.user_id;
  if (!validId(allianceId) || !validId(inviteeId) || inviteeId === request.auth.userId) {
    return response.status(400).json({ error: "Projet ou allié invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO community_alliance_invitations (
         alliance_id, inviter_id, invitee_id
       )
       SELECT alliance.id, $2, $3
       FROM community_alliances alliance
       WHERE alliance.id = $1
         AND alliance.status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS')
         AND EXISTS (
           SELECT 1 FROM community_alliance_members membership
           WHERE membership.alliance_id = alliance.id AND membership.user_id = $2
         )
         AND EXISTS (
           SELECT 1 FROM user_alliances relationship
           WHERE relationship.status = 'ALLIED'
             AND ((relationship.requester_id = $2 AND relationship.recipient_id = $3)
               OR (relationship.recipient_id = $2 AND relationship.requester_id = $3))
         )
         AND NOT EXISTS (
           SELECT 1 FROM community_alliance_members membership
           WHERE membership.alliance_id = alliance.id AND membership.user_id = $3
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE (blocked.blocker_id = $2 AND blocked.blocked_id = $3)
              OR (blocked.blocker_id = $3 AND blocked.blocked_id = $2)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM community_alliance_members membership
           JOIN user_blocks blocked
             ON (blocked.blocker_id = $3 AND blocked.blocked_id = membership.user_id)
             OR (blocked.blocker_id = membership.user_id AND blocked.blocked_id = $3)
           WHERE membership.alliance_id = alliance.id
         )
       ON CONFLICT (alliance_id, invitee_id) WHERE status = 'PENDING'
       DO NOTHING
       RETURNING id, alliance_id, inviter_id, invitee_id, status, created_at`,
      [allianceId, request.auth.userId, inviteeId],
    );
    if (!result.rowCount) {
      return response.status(409).json({
        error: "Invitation impossible : vérifiez que le projet est ouvert et que cet allié peut y participer.",
      });
    }
    return response.status(201).json({ invitation: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const listCommunityAllianceInvitations = async (request, response, next) => {
  const direction = request.params.direction;
  if (direction !== "received" && direction !== "sent") {
    return response.status(400).json({ error: "Sens d’invitation invalide." });
  }
  const column = direction === "received" ? "invitee_id" : "inviter_id";
  const counterpart = direction === "received" ? "inviter" : "invitee";
  try {
    const result = await pool.query(
      `SELECT invitation.id, invitation.alliance_id, invitation.status,
              invitation.created_at, alliance.title AS project_title,
              alliance.status AS project_status,
              ${counterpart}.id AS user_id,
              ${counterpart}.full_name AS user_name,
              ${counterpart}.profile_photo_url AS user_photo_url
       FROM community_alliance_invitations invitation
       JOIN community_alliances alliance ON alliance.id = invitation.alliance_id
       JOIN users ${counterpart}
         ON ${counterpart}.id = invitation.${direction === "received" ? "inviter_id" : "invitee_id"}
       WHERE invitation.${column} = $1
         ${direction === "received" ? "AND invitation.status = 'PENDING'" : ""}
       ORDER BY invitation.created_at DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ invitations: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const respondToCommunityAllianceInvitation = async (request, response, next) => {
  const invitationId = request.params.invitationId;
  const decision =
    typeof request.body?.decision === "string"
      ? request.body.decision.trim().toUpperCase()
      : "";
  if (!validId(invitationId) || !["ACCEPTED", "DECLINED"].includes(decision)) {
    return response.status(400).json({ error: "Réponse à l’invitation invalide." });
  }

  try {
    const result = await pool.query(
      `WITH changed AS (
         UPDATE community_alliance_invitations invitation
         SET status = $3, updated_at = NOW()
         FROM community_alliances alliance
         WHERE invitation.id = $1
           AND invitation.alliance_id = alliance.id
           AND invitation.invitee_id = $2
           AND invitation.status = 'PENDING'
           AND (
             $3 = 'DECLINED'
             OR (
               alliance.status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS')
               AND NOT EXISTS (
                 SELECT 1
                 FROM community_alliance_members other_membership
                 JOIN user_blocks blocked
                   ON (blocked.blocker_id = $2 AND blocked.blocked_id = other_membership.user_id)
                   OR (blocked.blocker_id = other_membership.user_id AND blocked.blocked_id = $2)
                 WHERE other_membership.alliance_id = alliance.id
               )
             )
           )
         RETURNING invitation.id, invitation.alliance_id, invitation.invitee_id,
                   invitation.status, alliance.title AS project_title
       ), joined AS (
         INSERT INTO community_alliance_members (alliance_id, user_id, role)
         SELECT alliance_id, invitee_id, 'PARTICIPANT'
         FROM changed
         WHERE status = 'ACCEPTED'
         ON CONFLICT (alliance_id, user_id) DO NOTHING
         RETURNING alliance_id, user_id
       ), updated AS (
         UPDATE community_alliances alliance
         SET participants = CASE
               WHEN alliance.participants @> jsonb_build_array(joined.user_id::text)
                 THEN alliance.participants
               ELSE alliance.participants || jsonb_build_array(joined.user_id::text)
             END,
             participant_count = alliance.participant_count + 1,
             updated_at = NOW()
         FROM joined
         WHERE alliance.id = joined.alliance_id
         RETURNING alliance.id
       )
       SELECT * FROM changed`,
      [invitationId, request.auth.userId, decision],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Invitation introuvable ou expirée." });
    }
    return response.status(200).json({ invitation: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const getCommunityAllianceInvitationCounter = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE invitee_id = $1 AND status = 'PENDING'
         )::int AS received_invitations,
         COUNT(*) FILTER (
           WHERE inviter_id = $1 AND status = 'PENDING'
         )::int AS pending_invitations
       FROM community_alliance_invitations
       WHERE invitee_id = $1 OR inviter_id = $1`,
      [request.auth.userId],
    );
    return response.status(200).json({ counters: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const confirmCommunityAllianceCompletion = async (request, response, next) => {
  const allianceId = request.params.allianceId;
  if (!validId(allianceId)) {
    return response.status(400).json({ error: "Identifiant de projet invalide." });
  }
  try {
    const result = await pool.query(
      `WITH confirmation AS (
         INSERT INTO community_alliance_completion_confirmations (alliance_id, user_id)
         SELECT alliance.id, $2
         FROM community_alliances alliance
         JOIN community_alliance_members membership
           ON membership.alliance_id = alliance.id AND membership.user_id = $2
         WHERE alliance.id = $1
           AND alliance.status = 'IN_PROGRESS'
           AND alliance.creator_id <> $2
           AND alliance.validation_note IS NOT NULL
           AND alliance.proof_url IS NOT NULL
         ON CONFLICT (alliance_id, user_id) DO NOTHING
         RETURNING alliance_id
       ), updated AS (
         UPDATE community_alliances alliance
         SET completion_confirmations = alliance.completion_confirmations + 1,
             updated_at = NOW()
         FROM confirmation
         WHERE alliance.id = confirmation.alliance_id
         RETURNING alliance.id, alliance.completion_confirmations
       )
       SELECT * FROM updated`,
      [allianceId, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(409).json({
        error: "Projet indisponible, preuve manquante ou confirmation déjà envoyée.",
      });
    }
    return response.status(200).json({ confirmation: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};
