import { pool } from "../db/pool.js";
import { verifyMessageMedia } from "../services/messageMedia.js";
import { sendExpoPushNotifications } from "../services/pushNotifications.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getSocketServer = (request) => request.app?.get?.("io");

const notifyUser = async (userId, notification) => {
  const result = await pool.query(
    "SELECT token FROM push_tokens WHERE user_id = $1",
    [userId],
  );
  return sendExpoPushNotifications(
    result.rows.map((row) => row.token),
    notification,
  );
};

const userHandleSql = "('qp-' || replace(person.id::text, '-', ''))";

export const getPrivateContactProfile = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name AS name,
              'qp-' || replace(id::text, '-', '') AS public_handle
       FROM users WHERE id = $1`,
      [request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Profil introuvable." });
    }
    return response.status(200).json({ profile: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const searchPrivateContacts = async (request, response, next) => {
  const query =
    typeof request.query.query === "string" ? request.query.query.trim() : "";
  if (query.length < 2 || query.length > 80) {
    return response.status(400).json({
      error: "Saisissez au moins 2 caractères (80 maximum) pour rechercher.",
    });
  }
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  try {
    const result = await pool.query(
      `SELECT person.id, COALESCE(NULLIF(person.full_name, ''), 'Voisin') AS name,
              person.profile_photo_url, person.badge,
              'qp-' || replace(person.id::text, '-', '') AS public_handle,
              CASE
                WHEN connection.conversation_id IS NOT NULL THEN 'CONNECTED'
                WHEN outgoing.status = 'PENDING' THEN 'OUTGOING'
                WHEN incoming.status = 'PENDING' THEN 'INCOMING'
                ELSE NULL
              END AS connection_status
       FROM users AS person
       LEFT JOIN private_connections AS connection
         ON connection.user_low_id = LEAST($1::uuid, person.id)
        AND connection.user_high_id = GREATEST($1::uuid, person.id)
       LEFT JOIN private_connection_requests AS outgoing
         ON outgoing.sender_id = $1 AND outgoing.recipient_id = person.id
       LEFT JOIN private_connection_requests AS incoming
         ON incoming.sender_id = person.id AND incoming.recipient_id = $1
       WHERE person.id <> $1
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE (blocked.blocker_id = $1 AND blocked.blocked_id = person.id)
              OR (blocked.blocker_id = person.id AND blocked.blocked_id = $1)
         )
         AND (
           person.full_name ILIKE $2 ESCAPE E'\\\\'
           OR lower(${userHandleSql}) LIKE lower($3) ESCAPE E'\\\\'
         )
       ORDER BY CASE
         WHEN connection.conversation_id IS NOT NULL THEN 0
         WHEN outgoing.status = 'PENDING' OR incoming.status = 'PENDING' THEN 1
         ELSE 2
       END, person.full_name NULLS LAST
       LIMIT 30`,
      [request.auth.userId, `%${escapedQuery}%`, `${escapedQuery}%`],
    );
    return response.status(200).json({ contacts: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listPrivateConnectionRequests = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT connection_request.id, connection_request.status,
              CASE
                WHEN connection_request.recipient_id = $1 THEN 'INCOMING'
                ELSE 'OUTGOING'
              END AS direction,
              other_user.id AS user_id,
              COALESCE(NULLIF(other_user.full_name, ''), 'Voisin') AS name,
              other_user.profile_photo_url, other_user.badge,
              'qp-' || replace(other_user.id::text, '-', '') AS public_handle,
              connection_request.created_at
       FROM private_connection_requests AS connection_request
       JOIN users AS other_user
         ON other_user.id = CASE
           WHEN connection_request.sender_id = $1
             THEN connection_request.recipient_id
           ELSE connection_request.sender_id
         END
       WHERE (connection_request.sender_id = $1 OR connection_request.recipient_id = $1)
         AND connection_request.status = 'PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE (blocked.blocker_id = $1 AND blocked.blocked_id = other_user.id)
              OR (blocked.blocker_id = other_user.id AND blocked.blocked_id = $1)
         )
       ORDER BY connection_request.created_at DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ requests: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createPrivateConnectionRequest = async (request, response, next) => {
  const senderId = request.auth.userId;
  const recipientId =
    typeof request.body?.recipient_id === "string"
      ? request.body.recipient_id
      : "";
  if (!UUID_PATTERN.test(recipientId) || recipientId === senderId) {
    return response.status(400).json({ error: "Profil de contact invalide." });
  }
  try {
    const recipient = await pool.query(
      `SELECT id FROM users
       WHERE id = $1
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE (blocked.blocker_id = $2 AND blocked.blocked_id = $1)
              OR (blocked.blocker_id = $1 AND blocked.blocked_id = $2)
         )`,
      [recipientId, senderId],
    );
    if (!recipient.rowCount) {
      return response.status(404).json({ error: "Profil introuvable." });
    }
    const connection = await pool.query(
      `SELECT conversation_id FROM private_connections
       WHERE user_low_id = LEAST($1::uuid, $2::uuid)
         AND user_high_id = GREATEST($1::uuid, $2::uuid)`,
      [senderId, recipientId],
    );
    if (connection.rowCount) {
      return response.status(200).json({
        status: "CONNECTED",
        conversation_id: connection.rows[0].conversation_id,
      });
    }
    const inserted = await pool.query(
      `INSERT INTO private_connection_requests (sender_id, recipient_id)
       VALUES ($1, $2)
       ON CONFLICT (sender_id, recipient_id) DO UPDATE
         SET status = 'PENDING', created_at = CURRENT_TIMESTAMP,
             responded_at = CURRENT_TIMESTAMP
       WHERE private_connection_requests.status IN ('DECLINED', 'CANCELLED')
       RETURNING id, status`,
      [senderId, recipientId],
    );
    if (!inserted.rowCount) {
      const existing = await pool.query(
        `SELECT id, status FROM private_connection_requests
         WHERE sender_id = $1 AND recipient_id = $2`,
        [senderId, recipientId],
      );
      if (existing.rows[0]?.status === "PENDING") {
        return response.status(200).json({
          request_id: existing.rows[0].id,
          status: "PENDING",
        });
      }
      if (existing.rows[0]?.status === "ACCEPTED") {
        const accepted = await pool.query(
          `SELECT conversation_id FROM private_connections
           WHERE user_low_id = LEAST($1::uuid, $2::uuid)
             AND user_high_id = GREATEST($1::uuid, $2::uuid)`,
          [senderId, recipientId],
        );
        if (accepted.rowCount) {
          return response.status(200).json({
            status: "CONNECTED",
            conversation_id: accepted.rows[0].conversation_id,
          });
        }
      }
      const reciprocal = await pool.query(
        `SELECT id FROM private_connection_requests
         WHERE sender_id = $1 AND recipient_id = $2 AND status = 'PENDING'`,
        [recipientId, senderId],
      );
      if (reciprocal.rowCount) {
        return response.status(409).json({
          error: "Cette personne vous a déjà envoyé une demande. Répondez à sa demande.",
          status: "INCOMING",
        });
      }
      return response.status(409).json({
        error: "Impossible de créer cette demande de connexion.",
      });
    }
    void notifyUser(recipientId, {
      title: "Demande QuartierPlus Connexion",
      body: "Une personne souhaite se connecter avec vous.",
      data: { type: "private_connection_request", requestId: inserted.rows[0].id },
    }).catch((error) => {
      console.error("Unable to send private connection request notification:", error);
    });
    return response.status(201).json({
      request_id: inserted.rows[0].id,
      status: "PENDING",
    });
  } catch (error) {
    return next(error);
  }
};

export const respondToPrivateConnectionRequest = async (request, response, next) => {
  const requestId = request.params.requestId;
  const recipientId = request.auth.userId;
  const decision =
    typeof request.body?.decision === "string"
      ? request.body.decision.toUpperCase()
      : "";
  if (!UUID_PATTERN.test(requestId) || !["ACCEPT", "DECLINE"].includes(decision)) {
    return response.status(400).json({ error: "Réponse à la demande invalide." });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, sender_id, recipient_id, status, conversation_id
       FROM private_connection_requests
       WHERE id = $1 AND recipient_id = $2
       FOR UPDATE`,
      [requestId, recipientId],
    );
    if (!selected.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Demande de connexion introuvable." });
    }
    const connectionRequest = selected.rows[0];
    if (connectionRequest.status !== "PENDING") {
      await client.query("ROLLBACK");
      if (connectionRequest.status === "ACCEPTED") {
        return response.status(200).json({
          status: "ACCEPTED",
          conversation_id: connectionRequest.conversation_id,
        });
      }
      return response.status(409).json({ error: "Cette demande a déjà été traitée." });
    }
    if (decision === "DECLINE") {
      await client.query(
        `UPDATE private_connection_requests
         SET status = 'DECLINED', responded_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [requestId],
      );
      await client.query("COMMIT");
      return response.status(200).json({ status: "DECLINED" });
    }

    const blocked = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [recipientId, connectionRequest.sender_id],
    );
    if (blocked.rowCount) {
      await client.query("ROLLBACK");
      return response.status(403).json({
        error: "La connexion est impossible tant qu’un blocage est actif.",
      });
    }
    const [userLowId, userHighId] = [recipientId, connectionRequest.sender_id]
      .sort((left, right) => left.localeCompare(right));
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [userLowId, userHighId],
    );
    const existing = await client.query(
      `SELECT conversation_id FROM private_connections
       WHERE user_low_id = $1 AND user_high_id = $2`,
      [userLowId, userHighId],
    );
    let conversationId = existing.rows[0]?.conversation_id;
    if (!conversationId) {
      const conversation = await client.query(
        "INSERT INTO conversations DEFAULT VALUES RETURNING id",
      );
      conversationId = conversation.rows[0].id;
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conversationId, userLowId, userHighId],
      );
      await client.query(
        `INSERT INTO private_connections
           (user_low_id, user_high_id, conversation_id)
         VALUES ($1, $2, $3)`,
        [userLowId, userHighId, conversationId],
      );
    }
    await client.query(
      `UPDATE private_connection_requests
       SET status = 'ACCEPTED', conversation_id = $2,
           responded_at = CURRENT_TIMESTAMP
       WHERE id = $1 OR (
         sender_id = $4 AND recipient_id = $3 AND status = 'PENDING'
       )`,
      [requestId, conversationId, recipientId, connectionRequest.sender_id],
    );
    await client.query("COMMIT");
    void notifyUser(connectionRequest.sender_id, {
      title: "Connexion acceptée",
      body: "Votre demande QuartierPlus Connexion a été acceptée.",
      data: { type: "private_connection_accepted", conversationId },
    }).catch((error) => {
      console.error("Unable to send private connection acceptance notification:", error);
    });
    return response.status(200).json({
      status: "ACCEPTED",
      conversation_id: conversationId,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    return next(error);
  } finally {
    client?.release();
  }
};

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
        message.created_at, message.sender_id = $2 AS is_mine,
        EXISTS (
          SELECT 1 FROM conversation_participants reader
          WHERE reader.conversation_id = message.conversation_id
            AND reader.user_id <> message.sender_id
            AND message.created_at <= reader.last_read_at
        ) AS is_read
       FROM private_messages AS message
       JOIN conversation_participants AS participant
         ON participant.conversation_id = message.conversation_id
        AND participant.user_id = $2
       LEFT JOIN users AS profile ON profile.id = message.sender_id
       WHERE message.conversation_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM conversation_participants other_participant
           JOIN user_blocks blocked
             ON (blocked.blocker_id = $2 AND blocked.blocked_id = other_participant.user_id)
             OR (blocked.blocker_id = other_participant.user_id AND blocked.blocked_id = $2)
           WHERE other_participant.conversation_id = message.conversation_id
             AND other_participant.user_id <> $2
         )
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
    const readAt = new Date().toISOString();
    await pool.query(
      `UPDATE conversation_participants
       SET last_read_at = GREATEST(last_read_at, CURRENT_TIMESTAMP)
       WHERE conversation_id = $1 AND user_id = $2`,
      [request.params.conversationId, request.auth.userId],
    );
    getSocketServer(request)
      ?.to(`private-conversation:${request.params.conversationId}`)
      .emit("private:read", {
        conversation_id: request.params.conversationId,
        user_id: request.auth.userId,
        read_at: readAt,
      });
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
    const profile = await pool.query(
      `SELECT full_name AS sender_name, profile_photo_url AS sender_photo_url,
              badge AS sender_badge
       FROM users WHERE id = $1`,
      [request.auth.userId],
    );
    const message = {
      ...result.rows[0],
      ...profile.rows[0],
      is_mine: true,
      is_read: false,
    };
    getSocketServer(request)
      ?.to(`private-conversation:${request.params.conversationId}`)
      .emit("private:new_message", message);
    const recipients = await pool.query(
      `SELECT DISTINCT push_tokens.token
       FROM push_tokens
       JOIN conversation_participants participant
         ON participant.user_id = push_tokens.user_id
       WHERE participant.conversation_id = $1
         AND participant.user_id <> $2`,
      [request.params.conversationId, request.auth.userId],
    );
    void sendExpoPushNotifications(
      recipients.rows.map((row) => row.token),
      {
        title: profile.rows[0]?.sender_name ?? "Nouveau message",
        body: content || (mediaType === "audio" ? "Message vocal" : "Média reçu"),
        channelId: "messages",
        data: {
          type: "private_message",
          conversationId: request.params.conversationId,
          messageId: message.id,
        },
      },
    ).catch((error) => {
      console.error("Unable to send private message notification:", error);
    });
    return response.status(201).json({ message });
  } catch (error) {
    return next(error);
  }
};
