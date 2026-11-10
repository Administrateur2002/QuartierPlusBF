import { pool } from "../db/pool.js";
import { verifyMessageMedia } from "../services/messageMedia.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listConversations = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT conversation.id, other_user.id AS participant_id,
              other_user.full_name AS participant_name,
              other_user.profile_photo_url AS participant_photo_url,
              other_user.badge AS participant_badge,
              EXISTS (
                SELECT 1 FROM user_alliances alliance
                WHERE alliance.status = 'ALLIED'
                  AND ((alliance.requester_id = $1 AND alliance.recipient_id = other_user.id)
                    OR (alliance.recipient_id = $1 AND alliance.requester_id = other_user.id))
              ) AS participant_is_ally,
              latest.body AS last_message,
              COALESCE(latest.created_at, conversation.created_at) AS updated_at,
              (SELECT COUNT(*)::int
               FROM private_messages AS unread
               WHERE unread.conversation_id = conversation.id
                 AND unread.sender_id <> $1
                 AND unread.created_at > own.last_read_at) AS unread_count
       FROM conversation_participants AS own
       JOIN conversations AS conversation
         ON conversation.id = own.conversation_id
       JOIN conversation_participants AS other
         ON other.conversation_id = conversation.id AND other.user_id <> $1
       JOIN users AS other_user ON other_user.id = other.user_id
       LEFT JOIN LATERAL (
         SELECT body, created_at
         FROM private_messages
         WHERE conversation_id = conversation.id
         ORDER BY created_at DESC
         LIMIT 1
       ) AS latest ON TRUE
       WHERE own.user_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM conversation_participants blocked_participant
           JOIN user_blocks blocked
             ON (blocked.blocker_id = $1 AND blocked.blocked_id = blocked_participant.user_id)
             OR (blocked.blocker_id = blocked_participant.user_id AND blocked.blocked_id = $1)
           WHERE blocked_participant.conversation_id = conversation.id
             AND blocked_participant.user_id <> $1
         )
       ORDER BY COALESCE(latest.created_at, conversation.created_at) DESC`,
      [request.auth.userId],
    );
    return response.status(200).json({ conversations: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listPrivateMessages = async (request, response, next) => {
  if (!UUID_PATTERN.test(request.params.conversationId)) {
    return response.status(400).json({ error: "Identifiant de conversation invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT message.id, message.conversation_id, message.sender_id,
              profile.full_name AS sender_name,
              profile.profile_photo_url AS sender_photo_url,
              profile.badge AS sender_badge,
              EXISTS (
                SELECT 1 FROM user_alliances alliance
                WHERE alliance.status = 'ALLIED'
                  AND ((alliance.requester_id = $2 AND alliance.recipient_id = profile.id)
                    OR (alliance.recipient_id = $2 AND alliance.requester_id = profile.id))
              ) AS sender_is_ally,
              message.body AS content,
        message.media_url, message.media_type,
        message.created_at, message.sender_id = $2 AS is_mine
       FROM private_messages AS message
       JOIN conversation_participants AS participant
         ON participant.conversation_id = message.conversation_id
        AND participant.user_id = $2
       LEFT JOIN users AS profile ON profile.id = message.sender_id
       WHERE message.conversation_id = $1
       ORDER BY message.created_at DESC
       LIMIT 100`,
      [request.params.conversationId, request.auth.userId],
    );
    if (!result.rows.length) {
      const participant = await pool.query(
        `SELECT 1 FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2`,
        [request.params.conversationId, request.auth.userId],
      );
      if (!participant.rowCount) {
        return response.status(404).json({ error: "Conversation introuvable." });
      }
    }
    await pool.query(
      `UPDATE conversation_participants
       SET last_read_at = CURRENT_TIMESTAMP
       WHERE conversation_id = $1 AND user_id = $2`,
      [request.params.conversationId, request.auth.userId],
    );
    return response.status(200).json({ messages: result.rows.reverse() });
  } catch (error) {
    return next(error);
  }
};

export const createPrivateMessage = async (request, response, next) => {
  if (!UUID_PATTERN.test(request.params.conversationId)) {
    return response.status(400).json({ error: "Identifiant de conversation invalide." });
  }
  const content =
    typeof request.body?.content === "string"
      ? request.body.content.trim()
      : "";
  const mediaUrl = typeof request.body?.media_url === "string"
    ? request.body.media_url.trim()
    : "";
  const mediaType = request.body?.media_type;
  const mediaPublicId = typeof request.body?.media_public_id === "string"
    ? request.body.media_public_id.trim()
    : "";
  const hasMedia = Boolean(mediaUrl || mediaType || mediaPublicId);
  if (
    content.length > 5000 ||
    (!content && !hasMedia) ||
    (hasMedia && (!mediaUrl || !mediaPublicId || !["image", "video", "audio"].includes(mediaType)))
  ) {
    return response.status(400).json({ error: "Contenu du message invalide." });
  }
  try {
    if (hasMedia) {
      const verifiedMedia = await verifyMessageMedia({
        userId: request.auth.userId,
        mediaUrl,
        mediaType,
        mediaPublicId,
      });
      if (verifiedMedia.error) return response.status(400).json({ error: verifiedMedia.error });
    }
    const result = await pool.query(
      `INSERT INTO private_messages
         (conversation_id, sender_id, body, media_url, media_type)
       SELECT participant.conversation_id, participant.user_id, $3, $4, $5
       FROM conversation_participants AS participant
       WHERE participant.conversation_id = $1 AND participant.user_id = $2
         AND NOT EXISTS (
           SELECT 1
           FROM conversation_participants other_participant
           JOIN user_blocks blocked
             ON (blocked.blocker_id = $2 AND blocked.blocked_id = other_participant.user_id)
             OR (blocked.blocker_id = other_participant.user_id AND blocked.blocked_id = $2)
           WHERE other_participant.conversation_id = participant.conversation_id
             AND other_participant.user_id <> $2
         )
      RETURNING id, conversation_id, sender_id, body AS content,
            media_url, media_type, created_at`,
      [request.params.conversationId, request.auth.userId, content, mediaUrl || null, mediaType || null],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Conversation introuvable." });
    }
    return response.status(201).json({
      message: { ...result.rows[0], is_mine: true },
    });
  } catch (error) {
    return next(error);
  }
};
