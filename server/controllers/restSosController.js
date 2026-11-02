import { pool } from "../db/pool.js";
import { notifyNearbySosResponders } from "../services/sosNotifications.js";

const EMERGENCY_TYPES = new Set(["MEDICAL", "SECURITY", "FIRE", "OTHER"]);
const ESCALATION_RADII_KM = new Map([
  [1, 3],
  [2, 10],
  [3, 30],
]);
const HTTPS_URL = /^https:\/\/\S+$/i;

const readMediaUrl = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || !HTTPS_URL.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) ? value : false;
  } catch {
    return false;
  }
};

export const createSosAlert = async (request, response, next) => {
  const { latitude, longitude, accuracy_m: accuracyMeters } = request.body ?? {};
  const emergencyType =
    typeof request.body?.emergency_type === "string"
      ? request.body.emergency_type.toUpperCase()
      : "OTHER";
  const escalationLevel = Number(request.body?.escalation_level ?? 1);
  const radiusKm = ESCALATION_RADII_KM.get(escalationLevel);
  const imageUrl = readMediaUrl(request.body?.emergency_image_url);
  const audioUrl = readMediaUrl(request.body?.emergency_audio_url);
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    typeof accuracyMeters !== "number" ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters < 0 ||
    accuracyMeters > 200 ||
    request.body?.mocked === true ||
    !EMERGENCY_TYPES.has(emergencyType) ||
    !radiusKm ||
    imageUrl === false ||
    audioUrl === false
  ) {
    return response.status(400).json({
      error: "Coordonnées, précision GPS, type d’urgence ou médias invalides.",
    });
  }

  let client;
  let transactionOpen = false;
  let alert;
  let isNewAccount = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    const userResult = await client.query(
      `SELECT phone_verified_at IS NOT NULL AS phone_verified,
              created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
                AS is_new_account
       FROM users WHERE id = $1 FOR UPDATE`,
      [request.auth.userId],
    );
    const account = userResult.rows[0];
    if (!account?.phone_verified) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return response.status(403).json({
        error: account
          ? "Vérifiez votre numéro de téléphone avant d'utiliser le SOS."
          : "Compte utilisateur introuvable.",
      });
    }

    const recentAlerts = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM sos_alerts
       WHERE user_id = $1
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
      [request.auth.userId],
    );
    if (recentAlerts.rows[0].count >= 3) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return response.status(429).json({
        error: "La limite de 3 alertes SOS par heure est atteinte.",
      });
    }

    isNewAccount = account.is_new_account === true;
    const result = await client.query(
      `INSERT INTO sos_alerts (
         user_id, location, status, emergency_type, escalation_level,
         emergency_image_url, emergency_audio_url
       )
       VALUES (
         $1, ST_SetSRID(ST_MakePoint($2, $3), 4326), 'ACTIVE', $4, $5, $6, $7
       )
       RETURNING id, ST_Y(location) AS latitude, ST_X(location) AS longitude,
                 status, emergency_type, escalation_level,
                 emergency_image_url, emergency_audio_url, created_at`,
      [
        request.auth.userId,
        longitude,
        latitude,
        emergencyType,
        escalationLevel,
        imageUrl,
        audioUrl,
      ],
    );
    alert = result.rows[0];
    if (isNewAccount) {
      await client.query(
        "INSERT INTO sos_moderation_queue (sos_id) VALUES ($1)",
        [alert.id],
      );
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    return next(error);
  } finally {
    client?.release();
  }

  const publicAlert = {
    ...alert,
    coordinates: { latitude: alert.latitude, longitude: alert.longitude },
    escalation_radius_km: radiusKm,
  };
  void notifyNearbySosResponders({
    alert: publicAlert,
    radiusKm,
    excludeUserId: request.auth.userId,
  }).catch((error) => {
    console.error("Unable to notify certified responders about a queued SOS:", error);
  });
  return response.status(201).json({
    alert: publicAlert,
    moderation_pending: isNewAccount,
  });
};
