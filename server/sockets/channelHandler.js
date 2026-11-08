import { pool } from "../db/pool.js";
import { sendExpoPushNotifications } from "../services/pushNotifications.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL_ALIASES = new Map([
  ["EMERGENCY", "EMERGENCY"],
  ["URGENCES", "EMERGENCY"],
  ["ANNOUNCEMENTS", "ANNOUNCEMENTS"],
  ["ANNONCES", "ANNOUNCEMENTS"],
]);
const MAX_MESSAGE_LENGTH = 5000;

const emitChannelError = (socket, acknowledgement, message) => {
  const result = { error: message };
  if (typeof acknowledgement === "function") acknowledgement(result);
  socket.emit("channel:error", result);
};

const payloadChannelId = (payload) =>
  String(payload?.channel_id ?? payload?.channelId ?? "").trim();

const resolveChannel = async (channelId, userId) => {
  if (!channelId || channelId.length > 100) return null;
  const upper = channelId.toUpperCase();
  const kind = CHANNEL_ALIASES.get(upper);
  const result = kind
    ? await pool.query(
        `SELECT id, name, kind
         FROM channels
         WHERE UPPER(kind) = $1
           AND communication_area_id IS NULL
           AND (country_code IS NULL OR country_code = (
             SELECT country_code FROM users WHERE id = $3
           ))
         ORDER BY CASE WHEN country_code = (
           SELECT country_code FROM users WHERE id = $3
         ) THEN 0 ELSE 1 END
         LIMIT 1`,
        [kind, upper, userId],
      )
    : UUID_PATTERN.test(channelId)
      ? await pool.query(
          `SELECT channel.id, channel.name, channel.kind
           FROM channels AS channel
           WHERE channel.id = $1
             AND (
               channel.geography_scope = 'international'
               OR (channel.communication_area_id IS NULL
                 AND channel.country_code = (
                   SELECT country_code FROM users WHERE id = $2
                 ))
               OR EXISTS (
                 SELECT 1 FROM user_geographic_channel_follows AS follow
                 WHERE follow.user_id = $2 AND follow.channel_id = channel.id
               )
               OR EXISTS (
                 SELECT 1 FROM users AS account
                 JOIN communication_areas AS area
                   ON area.id = channel.communication_area_id
                 WHERE account.id = $2
                   AND (
                     (account.last_location IS NOT NULL
                       AND ST_Covers(area.boundary, account.last_location))
                     OR (area.scope = 'neighborhood'
                       AND LOWER(area.name) = LOWER(COALESCE(account.neighborhood, '')))
                   )
               )
               OR EXISTS (
                 SELECT 1 FROM users AS account
                 WHERE account.id = $2 AND account.last_location IS NOT NULL
                   AND channel.center_location IS NOT NULL
                   AND ST_DWithin(
                     channel.center_location::geography,
                     account.last_location::geography,
                     COALESCE((
                       SELECT default_radius_m FROM country_config
                       WHERE code = account.country_code
                     ), 5000)
                   )
               )
             )`,
          [channelId, userId],
        )
      : null;
  return result?.rows[0] ?? null;
};

const channelRoom = (id) => `channel:${id}`;

const eventErrorHandler = (socket, event, handler) => {
  socket.on(event, (payload, acknowledgement) => {
    const safePayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    void handler(safePayload, acknowledgement).catch((error) => {
      console.error(`Socket event ${event} failed:`, error);
      emitChannelError(socket, acknowledgement, "Impossible de traiter le message du canal.");
    });
  });
};

const getJoinedChannel = async (socket, payload, acknowledgement) => {
  const channelId = payloadChannelId(payload);
  const channel = await resolveChannel(channelId, socket.data.user.id);
  if (!channel) {
    emitChannelError(socket, acknowledgement, "Canal public introuvable.");
    return null;
  }
  if (!socket.data.channelAliases) socket.data.channelAliases = new Map();
  socket.data.channelAliases.set(channel.id, channelId);
  return channel;
};

export const registerChannelHandlers = (io, socket) => {
  const joinChannel = async (payload, acknowledgement) => {
    const channel = await getJoinedChannel(socket, payload, acknowledgement);
    if (!channel) return;
    await socket.join(channelRoom(channel.id));
    await pool.query(
      `INSERT INTO user_channel_subscriptions (user_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, channel_id) DO NOTHING`,
      [socket.data.user.id, channel.id],
    );
    if (typeof acknowledgement === "function") {
      acknowledgement({
        ok: true,
        channel_id: payloadChannelId(payload),
        name: channel.name,
      });
    }
  };
  const leaveChannel = async (payload, acknowledgement) => {
    const channelId = payloadChannelId(payload);
    const channel = await resolveChannel(channelId, socket.data.user.id);
    if (!channel) {
      emitChannelError(socket, acknowledgement, "Canal public introuvable.");
      return;
    }
    await socket.leave(channelRoom(channel.id));
    socket.data.channelAliases?.delete(channel.id);
    const remainingSockets = await io.in(channelRoom(channel.id)).fetchSockets();
    if (
      !remainingSockets.some(
        (remainingSocket) => remainingSocket.data.user.id === socket.data.user.id,
      )
    ) {
      await pool.query(
        "DELETE FROM user_channel_subscriptions WHERE user_id = $1 AND channel_id = $2",
        [socket.data.user.id, channel.id],
      );
    }
    if (typeof acknowledgement === "function") acknowledgement({ ok: true });
  };

  const sendMessage = async (payload, acknowledgement) => {
    const channelId = payloadChannelId(payload);
    const channel = await resolveChannel(channelId, socket.data.user.id);
    const room = channel ? channelRoom(channel.id) : "";
    if (!channel || !socket.rooms.has(room)) {
      emitChannelError(socket, acknowledgement, "Vous n'êtes pas membre de ce canal.");
      return;
    }
    if (channel.kind === "ANNOUNCEMENTS") {
      emitChannelError(
        socket,
        acknowledgement,
        "Les annonces officielles doivent être publiées via le parcours institutionnel vérifié.",
      );
      return;
    }

    const body =
      typeof payload.body === "string"
        ? payload.body.trim()
        : typeof payload.content === "string"
          ? payload.content.trim()
          : "";
    const mediaUrl =
      typeof payload.media_url === "string" ? payload.media_url.trim() : "";
    const mediaType =
      typeof payload.media_type === "string" ? payload.media_type.trim() : "";
    if (
      (body.length === 0 && mediaUrl.length === 0) ||
      body.length > MAX_MESSAGE_LENGTH ||
      (mediaUrl.length > 0 &&
        (!mediaUrl.startsWith("https://") ||
          mediaUrl.length > 2048 ||
          !["image/webp", "image/jpeg", "image/png", "audio/m4a"].includes(mediaType)))
    ) {
      emitChannelError(socket, acknowledgement, "Contenu du message invalide.");
      return;
    }

    const result = await pool.query(
      `INSERT INTO messages
           (channel_id, sender_id, body, media_url, media_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, channel_id, sender_id, body, media_url, media_type, created_at`,
      [
        channel.id,
        socket.data.user.id,
        body || null,
        mediaUrl || null,
        mediaUrl ? mediaType : null,
      ],
    );
    const saved = result.rows[0];
    const message = {
      id: saved.id,
      channel_id: saved.channel_id,
      channel_name: channel.name,
      sender_id: saved.sender_id,
      sender_name: socket.data.user.full_name ?? "Voisin",
      sender_photo_url: socket.data.user.profile_photo_url ?? null,
      sender_badge: socket.data.user.badge ?? null,
      sender_is_ally: false,
      body: saved.body,
      content: saved.body,
      media_url: saved.media_url,
      media_type: saved.media_type,
      information_type: "COMMUNITY",
      created_at: saved.created_at,
    };
    io.to(room).emit("channel:new_message", message);
    const recipients = await io.in(room).fetchSockets();
    for (const recipient of recipients) {
      const clientMessage = {
        ...message,
        channel_id:
          recipient.data.channelAliases?.get(channel.id) ?? channel.id,
        is_mine: recipient.data.user.id === saved.sender_id,
      };
      recipient.emit("new_message", clientMessage);
    }
    void (async () => {
      const pushTokens = await pool.query(
        `SELECT DISTINCT push_tokens.token
         FROM push_tokens
         WHERE push_tokens.user_id <> $2
           AND push_tokens.user_id IN (
             SELECT user_id FROM user_channel_subscriptions
             WHERE channel_id = $1
             UNION
             SELECT user_id FROM user_geographic_channel_follows
             WHERE channel_id = $1
           )`,
        [channel.id, saved.sender_id],
      );
      await sendExpoPushNotifications(
        pushTokens.rows.map((row) => row.token),
        {
          title: channel.name,
          body: `${message.sender_name}: ${body || "Photo"}`,
          priority: "high",
          channelId: "messages",
          data: {
            type: "message",
            channelId: channel.id,
            messageId: message.id,
          },
        },
      );
    })().catch((error) => {
      console.error("Unable to dispatch channel-message push notifications:", error);
    });
    if (typeof acknowledgement === "function") {
      acknowledgement({ ok: true, message });
    }
  };

  eventErrorHandler(socket, "channel:join", joinChannel);
  eventErrorHandler(socket, "channel:leave", leaveChannel);
  eventErrorHandler(socket, "channel:send_message", sendMessage);

  const handlers = new Map([
    ["channel:join", joinChannel],
    ["channel:leave", leaveChannel],
    ["channel:send_message", sendMessage],
  ]);
  for (const [legacyEvent, currentEvent] of [
    ["join_channel", "channel:join"],
    ["leave_channel", "channel:leave"],
    ["send_channel_message", "channel:send_message"],
  ]) {
    eventErrorHandler(socket, legacyEvent, handlers.get(currentEvent));
  }
};
