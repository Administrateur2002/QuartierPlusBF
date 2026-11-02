import { pool } from "../db/pool.js";
import { notifyNearbySosResponders } from "../services/sosNotifications.js";

const ESCALATION_RADII_KM = new Map([
  [1, 3],
  [2, 10],
  [3, 30],
]);
const COORDINATE_KEYS = ["latitude", "longitude"];
const HTTPS_URL = /^https:\/\/\S+$/i;
const EMERGENCY_TYPES = new Set(["MEDICAL", "SECURITY", "FIRE"]);

const validCoordinates = (value) =>
  value &&
  COORDINATE_KEYS.every((key) => Number.isFinite(value[key])) &&
  Math.abs(value.latitude) <= 90 &&
  Math.abs(value.longitude) <= 180;

const parseLocation = (payload) => {
  const latitude = Number(payload?.latitude ?? payload?.location?.latitude);
  const longitude = Number(payload?.longitude ?? payload?.location?.longitude);
  const location = { latitude, longitude };
  return validCoordinates(location) ? location : null;
};

export const radiusForLevel = (level) => ESCALATION_RADII_KM.get(level) ?? null;

export const emergencyTypeForPayload = (value) => {
  if (value === undefined || value === null || value === "") return "OTHER";
  return typeof value === "string" && EMERGENCY_TYPES.has(value)
    ? value
    : null;
};

const recipientsInRadius = async (
  io,
  location,
  radiusKm,
  excludeUserId,
  maxRecipients = null,
) => {
  const onlineSockets = [
    ...io.sockets.sockets.values(),
  ].filter(
    (socket) =>
      socket.data.user?.id !== excludeUserId &&
      validCoordinates(socket.data.presenceLocation),
  );
  if (onlineSockets.length === 0) return [];

  const presence = onlineSockets.map((socket) => ({
    socket_id: socket.id,
    user_id: socket.data.user.id,
    latitude: socket.data.presenceLocation.latitude,
    longitude: socket.data.presenceLocation.longitude,
  }));
  const result = await pool.query(
    `SELECT presence.socket_id
     FROM jsonb_to_recordset($1::jsonb) AS presence(
       socket_id TEXT,
       user_id UUID,
       latitude DOUBLE PRECISION,
       longitude DOUBLE PRECISION
     )
     WHERE ST_DWithin(
       ST_SetSRID(ST_MakePoint(presence.longitude, presence.latitude), 4326)::geography,
       ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
       $4
     )
     ORDER BY ST_Distance(
       ST_SetSRID(ST_MakePoint(presence.longitude, presence.latitude), 4326)::geography,
       ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
     )
     LIMIT $5`,
    [
      JSON.stringify(presence),
      location.longitude,
      location.latitude,
      radiusKm * 1000,
      maxRecipients,
    ],
  );
  return result.rows
    .map(({ socket_id: socketId }) => io.sockets.sockets.get(socketId))
    .filter(Boolean);
};

const emitSosError = (socket, acknowledgement, message) => {
  const response = { error: message };
  if (typeof acknowledgement === "function") acknowledgement(response);
  socket.emit("sos:error", response);
};

const emitToSockets = (sockets, event, payload) => {
  for (const recipient of sockets) recipient.emit(event, payload);
};

const publicAlert = (alert) => ({
  id: alert.id,
  latitude: alert.latitude,
  longitude: alert.longitude,
  coordinates: { latitude: alert.latitude, longitude: alert.longitude },
  emergency_type: alert.emergency_type ?? "OTHER",
  status: alert.status,
  escalation_level: alert.escalation_level,
  escalation_radius_km: radiusForLevel(alert.escalation_level),
  emergency_image_url: alert.emergency_image_url,
  emergency_audio_url: alert.emergency_audio_url,
  created_at: alert.created_at,
});

const handleEvent = (socket, eventName, handler) => {
  socket.on(eventName, (payload, acknowledgement) => {
    const safePayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : typeof payload === "string"
          ? payload
          : {};
    void handler(safePayload, acknowledgement).catch((error) => {
      console.error(`Socket event ${eventName} failed:`, error);
      emitSosError(socket, acknowledgement, "Impossible de traiter l'alerte SOS.");
    });
  });
};

export const registerSosHandlers = (io, socket) => {
  socket.data.presenceLocation = null;

  handleEvent(socket, "sos:location_update", async (payload, acknowledgement) => {
    const location = parseLocation(payload);
    if (!location) {
      emitSosError(socket, acknowledgement, "Coordonnées GPS invalides.");
      return;
    }
    socket.data.presenceLocation = location;
    if (typeof acknowledgement === "function") {
      acknowledgement({ ok: true });
    }
  });

  handleEvent(socket, "sos:trigger", async (payload, acknowledgement) => {
    const userId = socket.data.user?.id;
    const location = parseLocation(payload);
    const accuracyMeters = Number(payload.accuracy_m);
    const escalationLevel = Number(
      typeof payload === "object" ? payload.escalation_level ?? 1 : 1,
    );
    const radiusKm = radiusForLevel(escalationLevel);
    const emergencyType = emergencyTypeForPayload(payload.emergency_type);
    if (
      !userId ||
      !location ||
      !radiusKm ||
      !emergencyType ||
      payload.mocked === true ||
      !Number.isFinite(accuracyMeters) ||
      accuracyMeters > 200
    ) {
      emitSosError(
        socket,
        acknowledgement,
        payload.mocked === true
          ? "Une position GPS simulée ne peut pas être utilisée pour un SOS."
          : accuracyMeters > 200
            ? "La précision GPS doit être de 200 m ou meilleure."
            : "Coordonnées GPS, type d'urgence ou niveau d'escalade invalides.",
      );
      return;
    }
    if (
      socket.data.lastSosTriggerAt &&
      Date.now() - socket.data.lastSosTriggerAt < 10_000
    ) {
      emitSosError(socket, acknowledgement, "Veuillez attendre avant de relancer un SOS.");
      return;
    }

    const imageUrl =
      typeof payload === "object" &&
      typeof payload.emergency_image_url === "string"
        ? payload.emergency_image_url.trim()
        : null;
    let parsedImageUrl;
    try {
      if (imageUrl) parsedImageUrl = new URL(imageUrl);
    } catch {
      emitSosError(socket, acknowledgement, "URL de photo d'urgence invalide.");
      return;
    }
    if (
      imageUrl &&
      (imageUrl.length > 2048 ||
        !HTTPS_URL.test(imageUrl) ||
        parsedImageUrl?.protocol !== "https:" ||
        !parsedImageUrl.hostname)
    ) {
      emitSosError(socket, acknowledgement, "URL de photo d'urgence invalide.");
      return;
    }
    const audioUrl =
      typeof payload === "object" &&
      typeof payload.emergency_audio_url === "string"
        ? payload.emergency_audio_url.trim()
        : null;
    let parsedAudioUrl;
    try {
      if (audioUrl) parsedAudioUrl = new URL(audioUrl);
    } catch {
      emitSosError(socket, acknowledgement, "URL audio d'urgence invalide.");
      return;
    }
    if (
      audioUrl &&
      (audioUrl.length > 2048 ||
        !HTTPS_URL.test(audioUrl) ||
        parsedAudioUrl?.protocol !== "https:" ||
        !parsedAudioUrl.hostname)
    ) {
      emitSosError(socket, acknowledgement, "URL audio d'urgence invalide.");
      return;
    }

    const client = await pool.connect();
    let transactionOpen = false;
    let isNewAccount = false;
    let result;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const userResult = await client.query(
        `SELECT phone_verified_at IS NOT NULL AS phone_verified,
                created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
                  AS is_new_account
         FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      const account = userResult.rows[0];
      if (!account?.phone_verified) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        emitSosError(
          socket,
          acknowledgement,
          account
            ? "Vérifiez votre numéro de téléphone avant d'utiliser le SOS."
            : "Compte utilisateur introuvable.",
        );
        return;
      }
      const recentAlerts = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM sos_alerts
         WHERE user_id = $1
           AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
        [userId],
      );
      if (recentAlerts.rows[0].count >= 3) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        emitSosError(
          socket,
          acknowledgement,
          "La limite de 3 alertes SOS par heure est atteinte.",
        );
        return;
      }
      isNewAccount = account.is_new_account === true;
      result = await client.query(
        `INSERT INTO sos_alerts (
           user_id, location, status, emergency_type, escalation_level,
           emergency_image_url, emergency_audio_url
         )
         VALUES (
           $1,
           ST_SetSRID(ST_MakePoint($2, $3), 4326),
           'ACTIVE',
           $4,
           $5,
           $6,
           $7
         )
         RETURNING id,
           ST_Y(location) AS latitude,
           ST_X(location) AS longitude,
           status,
           emergency_type,
           escalation_level,
           emergency_image_url,
           emergency_audio_url,
           created_at`,
        [
          userId,
          location.longitude,
          location.latitude,
          emergencyType,
          escalationLevel,
          imageUrl,
          audioUrl,
        ],
      );
      if (isNewAccount) {
        await client.query(
          "INSERT INTO sos_moderation_queue (sos_id) VALUES ($1)",
          [result.rows[0].id],
        );
      }
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const alert = result.rows[0];
    socket.data.lastSosTriggerAt = Date.now();
    socket.data.presenceLocation = location;
    const payloadForClients = publicAlert(alert);
    const recipients = await recipientsInRadius(
      io,
      location,
      radiusKm,
      userId,
      isNewAccount ? 5 : null,
    );
    emitToSockets(recipients, "sos:new_alert", payloadForClients);
    emitToSockets(recipients, "sos:new", payloadForClients);
    const recipientIds = [
      ...new Set(recipients.map((recipient) => recipient.data.user.id)),
    ];
    void notifyNearbySosResponders({
      alert,
      radiusKm,
      excludeUserId: userId,
      nearbyUserIds: recipientIds,
    }).catch((error) => {
      console.error("Unable to dispatch nearby SOS push notifications:", error);
    });
    if (typeof acknowledgement === "function") {
      acknowledgement({
        ok: true,
        alert: payloadForClients,
        relays_notified: recipients.length,
        moderation_pending: isNewAccount,
      });
    }
  });

  const resolveAlert = (status, legacyEvent) =>
    async (payload, acknowledgement) => {
      const alertId =
        typeof payload === "string"
          ? payload
          : String(payload.id ?? payload.sos_id ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(alertId)) {
        emitSosError(socket, acknowledgement, "Identifiant d'alerte invalide.");
        return;
      }
      const result = await pool.query(
        `UPDATE sos_alerts
         SET status = $1
         WHERE id = $2 AND user_id = $3 AND status = 'ACTIVE'
         RETURNING id,
           ST_Y(location) AS latitude,
           ST_X(location) AS longitude,
           status,
           escalation_level,
           emergency_image_url,
           emergency_audio_url`,
        [status, alertId, socket.data.user.id],
      );
      if (result.rowCount === 0) {
        emitSosError(
          socket,
          acknowledgement,
          "Alerte introuvable ou non autorisée.",
        );
        return;
      }
      const alert = publicAlert(result.rows[0]);
      const radiusKm = radiusForLevel(result.rows[0].escalation_level);
      const recipients = await recipientsInRadius(
        io,
        { latitude: result.rows[0].latitude, longitude: result.rows[0].longitude },
        radiusKm,
        socket.data.user.id,
      );
      emitToSockets(recipients, legacyEvent, alert);
      emitToSockets(recipients, "sos:update", alert);
      emitToSockets(recipients, "sos:closed", { id: alert.id });
      if (typeof acknowledgement === "function") {
        acknowledgement({ ok: true, alert });
      }
    };

  handleEvent(socket, "sos:resolve", resolveAlert("RESOLVED", "sos:resolved"));
  handleEvent(socket, "sos:cancel", resolveAlert("CANCELLED", "sos:cancelled"));
};
