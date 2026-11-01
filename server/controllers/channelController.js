import { pool } from "../db/pool.js";
import { verifyMessageMedia } from "../services/messageMedia.js";

const CHANNEL_ALIASES = new Map([
  ["EMERGENCY", "EMERGENCY"],
  ["URGENCES", "EMERGENCY"],
  ["ANNOUNCEMENTS", "ANNOUNCEMENTS"],
  ["ANNONCES", "ANNOUNCEMENTS"],
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const findChannel = async (channelId, userId) => {
  const alias = CHANNEL_ALIASES.get(channelId.toUpperCase());
  if (alias) {
    const result = await pool.query(
      `SELECT channel.id, channel.name FROM channels AS channel
      WHERE (UPPER(channel.kind) = $1 OR UPPER(channel.name) = $2)
        AND (channel.country_code IS NULL OR channel.country_code = (
          SELECT country_code FROM users WHERE id = $3
        ))
       ORDER BY
         CASE WHEN channel.country_code = (
           SELECT country_code FROM users WHERE id = $3
         ) THEN 0 ELSE 1 END,
         CASE WHEN UPPER(channel.kind) = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [alias, channelId.toUpperCase(), userId],
    );
    return result.rows[0] ?? null;
  }
  if (!UUID_PATTERN.test(channelId)) return null;
  const result = await pool.query(
    `SELECT channel.id, channel.name FROM channels AS channel
     WHERE channel.id = $1
       AND UPPER(channel.kind) IN ('EMERGENCY', 'ANNOUNCEMENTS')
       AND (channel.country_code IS NULL OR channel.country_code = (
         SELECT country_code FROM users WHERE id = $2
       ))`,
    [channelId, userId],
  );
  return result.rows[0] ?? null;
};

export const listChannelMessages = async (request, response, next) => {
  try {
    const channel = await findChannel(request.params.channelId, request.auth.userId);
    if (!channel) {
      return response.status(404).json({ error: "Canal public introuvable." });
    }
    const result = await pool.query(
      `SELECT message.id, message.channel_id, message.sender_id,
              profile.full_name AS sender_name,
              profile.profile_photo_url AS sender_photo_url,
              profile.badge AS sender_badge,
              FALSE AS sender_is_ally, message.body,
              message.media_url, message.media_type, message.created_at,
              message.sender_id = $2 AS is_mine
       FROM messages AS message
       LEFT JOIN users AS profile ON profile.id = message.sender_id
       WHERE message.channel_id = $1
       ORDER BY message.created_at DESC
       LIMIT 100`,
      [channel.id, request.auth.userId],
    );
    return response.status(200).json({
      messages: result.rows
        .reverse()
        .map((message) => ({ ...message, channel_id: request.params.channelId })),
    });
  } catch (error) {
    return next(error);
  }
};

export const createChannelMessage = async (request, response, next) => {
  const body =
    typeof request.body?.content === "string"
      ? request.body.content.trim()
      : typeof request.body?.body === "string"
        ? request.body.body.trim()
        : "";
  const mediaUrl = typeof request.body?.media_url === "string" ? request.body.media_url.trim() : "";
  const mediaType = request.body?.media_type;
  const mediaPublicId = typeof request.body?.media_public_id === "string" ? request.body.media_public_id.trim() : "";
  const hasMedia = Boolean(mediaUrl || mediaType || mediaPublicId);
  if (
    body.length > 5000 ||
    (!body && !hasMedia) ||
    (hasMedia && (!mediaUrl || !mediaPublicId || !["image", "video"].includes(mediaType)))
  ) {
    return response.status(400).json({ error: "Contenu du message invalide." });
  }
  try {
    const channel = await findChannel(request.params.channelId, request.auth.userId);
    if (!channel) {
      return response.status(404).json({ error: "Canal public introuvable." });
    }
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
      `INSERT INTO messages (channel_id, sender_id, body, media_url, media_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, channel_id, sender_id, body, media_url, media_type, created_at`,
      [channel.id, request.auth.userId, body, mediaUrl || null, mediaType || null],
    );
    const senderProfile = await pool.query(
      "SELECT profile_photo_url, badge FROM users WHERE id = $1",
      [request.auth.userId],
    );
    return response.status(201).json({
      message: {
        ...result.rows[0],
        channel_id: request.params.channelId,
        channel_name: channel.name,
        sender_name: request.user?.fullName ?? "Voisin",
        sender_photo_url: senderProfile.rows[0]?.profile_photo_url ?? null,
        sender_badge: senderProfile.rows[0]?.badge ?? null,
        sender_is_ally: false,
        content: body,
        is_mine: true,
      },
    });
  } catch (error) {
    return next(error);
  }
};