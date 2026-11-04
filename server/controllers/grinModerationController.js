import { timingSafeEqual } from "node:crypto";
import { DataPacket_Kind, LiveKitAPI } from "livekit-server-sdk";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { sendSupportNotification } from "../services/email.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEVERE_LABELS = new Set([
  "Explicit Nudity",
  "Sexual Activity",
  "Graphic Violence",
  "Physical Threat",
  "Violent Threat",
]);
const statusMessage = (status) =>
  status === "PAUSED_PENDING_REVIEW"
    ? "Votre publication audio/vidéo a été temporairement suspendue pendant une vérification humaine. Vous pouvez faire appel."
    : "Un signalement automatique a été transmis aux modérateurs pour vérification.";

const createLiveKitApi = () => {
  const host = new URL(env.livekitUrl);
  host.protocol = "https:";
  return new LiveKitAPI({
    host: host.toString(),
    apiKey: env.livekitApiKey,
    secret: env.livekitApiSecret,
  });
};

const authenticateAgent = (request) => {
  const provided = request.get("x-grin-moderation-token") ?? "";
  const expected = env.grinModerationWebhookSecret;
  if (!expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};

export const receiveModerationEvent = async (request, response, next) => {
  if (!env.grinModerationEnabled) {
    return response.status(503).json({
      error: "La modération en direct n'est pas activée.",
    });
  }
  if (!authenticateAgent(request)) {
    return response.status(401).json({ error: "Agent de modération non autorisé." });
  }
  const {
    id,
    roomName,
    participantId,
    trackSid,
    mediaType,
    category,
    confidence,
  } = request.body ?? {};
  if (
    !UUID_PATTERN.test(String(id ?? "")) ||
    roomName !== "grin" ||
    !UUID_PATTERN.test(String(participantId ?? "")) ||
    typeof trackSid !== "string" ||
    trackSid.length < 3 ||
    trackSid.length > 100 ||
    !["AUDIO", "VIDEO"].includes(mediaType) ||
    typeof category !== "string" ||
    category.trim().length < 1 ||
    category.length > 100 ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    return response.status(400).json({ error: "Événement de modération invalide." });
  }

  const shouldPause =
    confidence >= 95 &&
    mediaType === "VIDEO" &&
    SEVERE_LABELS.has(category);
  const status = shouldPause ? "PAUSED_PENDING_REVIEW" : "PENDING_REVIEW";
  try {
    const livekit = createLiveKitApi();
    const participants = await livekit.room.listParticipants(roomName);
    const participant = participants.find(
      (entry) => entry.identity === participantId,
    );
    if (
      !participant ||
      participant.attributes?.grin_moderation_consent !== "true"
    ) {
      return response.status(403).json({
        error: "Le participant n'a pas consenti à la modération du live.",
      });
    }
    if (!participant.tracks.some((track) => track.sid === trackSid)) {
      return response.status(400).json({
        error: "La piste signalée n'appartient pas à ce participant.",
      });
    }

    const saved = await pool.query(
      `INSERT INTO grin_moderation_events (
         id, room_name, participant_id, track_sid, media_type,
         category, confidence, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, status`,
      [
        id,
        roomName,
        participantId,
        trackSid,
        mediaType,
        category.trim(),
        confidence,
        status,
      ],
    );
    const event =
      saved.rows[0] ??
      (
        await pool.query(
          `SELECT id, status FROM grin_moderation_events WHERE id = $1`,
          [id],
        )
      ).rows[0];
    if (!event) {
      throw new Error("The moderation event was not persisted.");
    }

    if (
      saved.rowCount &&
      env.textModerationEnabled &&
      mediaType === "AUDIO" &&
      category.trim().toLowerCase() === "threat" &&
      env.supportNotifyEmail
    ) {
      try {
        await sendSupportNotification(
          "Alerte prioritaire — menace détectée dans le Grin",
          `Une menace potentielle a été détectée dans un live consenti. Identifiant de revue : ${event.id}. Aucun audio ni texte transcrit n'a été conservé.`,
        );
      } catch (error) {
        console.error("Unable to deliver severe live-text notification:", error);
      }
    }

    if (event.status === "PAUSED_PENDING_REVIEW") {
      await livekit.room.mutePublishedTrack(
        roomName,
        participantId,
        trackSid,
        true,
      );
    }
    await livekit.room.sendData(
      roomName,
      Buffer.from(
        JSON.stringify({
          eventId: event.id,
          status: event.status,
          message: statusMessage(event.status),
        }),
      ),
      DataPacket_Kind.RELIABLE,
      { destinationIdentities: [participantId], topic: "grin-moderation" },
    );
    return response.status(202).json({
      accepted: true,
      eventId: event.id,
      status: event.status,
    });
  } catch (error) {
    return next(error);
  }
};

export const listMyModerationEvents = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, media_type, category, confidence, status,
              appeal_reason, created_at, appealed_at
       FROM grin_moderation_events
       WHERE participant_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [request.auth.userId],
    );
    return response.status(200).json({ events: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const appealModerationEvent = async (request, response, next) => {
  const eventId = request.params.eventId;
  const reason =
    typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
  if (!UUID_PATTERN.test(eventId) || reason.length < 10 || reason.length > 500) {
    return response.status(400).json({
      error: "Un recours doit contenir entre 10 et 500 caractères.",
    });
  }
  try {
    const result = await pool.query(
      `UPDATE grin_moderation_events
       SET status = 'APPEALED', appeal_reason = $3, appealed_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND participant_id = $2
         AND status IN ('PENDING_REVIEW', 'PAUSED_PENDING_REVIEW')
       RETURNING id, status`,
      [eventId, request.auth.userId, reason],
    );
    if (!result.rowCount) {
      return response.status(404).json({
        error: "Ce signalement ne peut pas être contesté ou est introuvable.",
      });
    }
    return response.status(200).json({ appealed: true, event: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

const isModerator = (request) =>
  request.adminAuthorized === true ||
  env.grinModeratorIds.includes(request.auth?.userId);

export const listModerationQueue = async (request, response, next) => {
  if (!isModerator(request)) {
    return response.status(403).json({ error: "Accès modérateur requis." });
  }
  try {
    const result = await pool.query(
      `SELECT id, participant_id, media_type, category,
              confidence::float8 AS confidence, status,
              appeal_reason, created_at, appealed_at
       FROM grin_moderation_events
       WHERE status IN ('PENDING_REVIEW', 'PAUSED_PENDING_REVIEW', 'APPEALED')
       ORDER BY CASE WHEN status = 'APPEALED' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 100`,
    );
    return response.status(200).json({ events: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const resolveModerationEvent = async (request, response, next) => {
  if (!isModerator(request)) {
    return response.status(403).json({ error: "Accès modérateur requis." });
  }
  const eventId = request.params.eventId;
  const outcome = request.body?.outcome;
  if (!UUID_PATTERN.test(eventId) || !["clear", "confirm"].includes(outcome)) {
    return response.status(400).json({ error: "Décision de modération invalide." });
  }
  try {
    const previous = await pool.query(
      `SELECT status FROM grin_moderation_events
       WHERE id = $1
         AND status IN ('PENDING_REVIEW', 'PAUSED_PENDING_REVIEW', 'APPEALED')`,
      [eventId],
    );
    if (!previous.rowCount) {
      return response.status(404).json({
        error: "Ce dossier n'est plus en attente ou est introuvable.",
      });
    }
    const result = await pool.query(
      `UPDATE grin_moderation_events
       SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND status IN ('PENDING_REVIEW', 'PAUSED_PENDING_REVIEW', 'APPEALED')
       RETURNING id, room_name, participant_id, track_sid, status`,
      [
        eventId,
        outcome === "clear" ? "CLEARED" : "CONFIRMED",
        request.auth.userId,
      ],
    );
    if (!result.rowCount) {
      return response.status(404).json({
        error: "Ce dossier n'est plus en attente ou est introuvable.",
      });
    }
    const event = result.rows[0];
    if (outcome === "clear" && event.status === "CLEARED") {
      try {
        const room = createLiveKitApi().room;
        const participants = await room.listParticipants(event.room_name);
        const participant = participants.find(
          (entry) => entry.identity === event.participant_id,
        );
        if (participant?.tracks?.some((track) => track.sid === event.track_sid)) {
          await room.mutePublishedTrack(
            event.room_name,
            event.participant_id,
            event.track_sid,
            false,
          );
        }
      } catch (error) {
        await pool.query(
          `UPDATE grin_moderation_events
           SET status = $2,
               reviewed_by = NULL,
               reviewed_at = NULL
           WHERE id = $1 AND status = 'CLEARED'`,
          [event.id, previous.rows[0].status],
        );
        throw error;
      }
    }
    if (request.adminAuthorized === true) {
      await pool.query(
        `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details)
         VALUES ($1, $2, 'GRIN_EVENT', $3, $4::jsonb)`,
        [
          request.auth.userId,
          outcome,
          event.id,
          JSON.stringify({ status: event.status }),
        ],
      );
    }
    return response.status(200).json({ resolved: true, event });
  } catch (error) {
    return next(error);
  }
};
