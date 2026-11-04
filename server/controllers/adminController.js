import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  deleteCloudinaryAsset,
} from "../services/cloudinary.js";
import {
  sendAdminFlashNotifications,
  sendExpoPushNotifications,
} from "../services/pushNotifications.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_DELETE_SQL = {
  POST: "UPDATE posts SET status = 'DELETED' WHERE id = $1",
  COMMENT: "DELETE FROM post_comments WHERE id = $1",
  MARKETPLACE_ITEM: "DELETE FROM marketplace_items WHERE id = $1",
  SOS: "UPDATE sos_alerts SET status = 'CLOSED' WHERE id = $1",
  MESSAGE: `DELETE FROM private_messages WHERE id = $1;
            DELETE FROM messages WHERE id = $1`,
};

const reportSelect = `
  SELECT report.id, report.target_type, report.target_id, report.reason,
         report.status, report.created_at, report.reviewed_at,
         report.appeal_reason, report.appealed_at,
         reporter.id AS reporter_id, reporter.full_name AS reporter_name,
         target_owner.id AS target_user_id, target_owner.full_name AS target_user_name,
         COALESCE(post.caption, post.media_url, comment.content,
                  item.title, item.description,
                  CASE WHEN private_message.id IS NOT NULL THEN (
                    SELECT string_agg(context.body, E'\n' ORDER BY context.created_at)
                    FROM (
                      SELECT message.body, message.created_at
                      FROM private_messages AS message
                      WHERE message.conversation_id = private_message.conversation_id
                      ORDER BY message.created_at DESC
                      LIMIT 10
                    ) AS context
                  ) END,
                  channel_message.body,
                  CASE WHEN sos.id IS NOT NULL
                    THEN 'Alerte SOS · ' || sos.emergency_type END,
                  target_owner.full_name,
                  'Contenu indisponible') AS content,
         COALESCE(post.media_url, item.image_urls[1],
                  private_message.media_url, channel_message.media_url,
                  sos.emergency_image_url, sos.emergency_audio_url) AS media_url,
         CASE
           WHEN report.reason IN ('Nudité explicite', 'Contenu privé sans consentement', 'Menaces')
             THEN 'CRITIQUE'
           WHEN report.reason IN ('Harcèlement', 'Insultes', 'Arnaque', 'Contenu dangereux')
             THEN 'ÉLEVÉ'
           ELSE 'MODÉRÉ'
         END AS severity
  FROM reports AS report
  LEFT JOIN users AS reporter ON reporter.id = report.reporter_id
  LEFT JOIN posts AS post
    ON report.target_type = 'POST' AND post.id = report.target_id
  LEFT JOIN post_comments AS comment
    ON report.target_type = 'COMMENT' AND comment.id = report.target_id
  LEFT JOIN marketplace_items AS item
    ON report.target_type = 'MARKETPLACE_ITEM' AND item.id = report.target_id
  LEFT JOIN private_messages AS private_message
    ON report.target_type = 'MESSAGE' AND private_message.id = report.target_id
  LEFT JOIN messages AS channel_message
    ON report.target_type = 'MESSAGE' AND channel_message.id = report.target_id
  LEFT JOIN sos_alerts AS sos
    ON report.target_type = 'SOS' AND sos.id = report.target_id
  LEFT JOIN users AS target_owner
    ON target_owner.id = COALESCE(report.moderation_target_user_id, CASE
      WHEN report.target_type IN ('PROFILE', 'LIVE_PARTICIPANT') THEN report.target_id
      WHEN report.target_type = 'POST' THEN post.author_id
      WHEN report.target_type = 'COMMENT' THEN comment.user_id
      WHEN report.target_type = 'MARKETPLACE_ITEM' THEN item.seller_id
      WHEN report.target_type = 'SOS' THEN sos.user_id
      WHEN private_message.id IS NOT NULL THEN private_message.sender_id
      ELSE channel_message.sender_id
    END)`;

const audit = (client, actorId, action, targetType, targetId, details = {}) =>
  client.query(
    `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, targetType, targetId, JSON.stringify(details)],
  );

export const getAdminDashboard = async (request, response, next) => {
  const status =
    typeof request.query.status === "string" &&
    ["PENDING", "APPEALED", "RESOLVED", "DISMISSED", "ALL"].includes(request.query.status)
      ? request.query.status
      : "PENDING";
  try {
    const [reports, events, counts, uploadEvents, uploadCounts] = await Promise.all([
      pool.query(
        `${reportSelect}
         WHERE ($1 = 'ALL' OR report.status = $1)
         ORDER BY CASE WHEN report.status = 'APPEALED' THEN 0 ELSE 1 END,
                  report.created_at DESC
         LIMIT 100`,
        [status],
      ),
      pool.query(
        `SELECT event.id, event.participant_id, event.media_type, event.category,
                event.confidence::float8 AS confidence, event.status,
                event.appeal_reason, event.created_at, event.appealed_at,
                account.full_name AS participant_name
         FROM grin_moderation_events AS event
         JOIN users AS account ON account.id = event.participant_id
         WHERE event.status IN ('PENDING_REVIEW', 'PAUSED_PENDING_REVIEW', 'APPEALED')
         ORDER BY event.created_at DESC
         LIMIT 100`,
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM reports
         GROUP BY status`,
      ),
      pool.query(
        `SELECT event.id, event.post_id, event.author_id, event.media_type,
                event.media_id, event.score::float8 AS score, event.status,
                event.appeal_reason, event.appealed_at, event.created_at,
                account.full_name AS author_name,
                CASE WHEN event.status = 'CHILD_SAFETY_ALERT'
                     THEN NULL ELSE post.media_url END AS media_url
         FROM post_moderation_events AS event
         LEFT JOIN posts AS post ON post.id = event.post_id
         JOIN users AS account ON account.id = event.author_id
         WHERE event.status IN (
           'PENDING_REVIEW', 'BLOCKED', 'CHILD_SAFETY_ALERT', 'APPEALED'
         )
         ORDER BY CASE WHEN event.status = 'CHILD_SAFETY_ALERT' THEN 0
                       WHEN event.status = 'APPEALED' THEN 1 ELSE 2 END,
                  event.created_at ASC
         LIMIT 100`,
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM post_moderation_events
         GROUP BY status`,
      ),
    ]);
    return response.status(200).json({
      reports: reports.rows,
      live_events: events.rows,
      counts: Object.fromEntries(counts.rows.map(({ status: key, count }) => [key, count])),
      upload_moderation_events: uploadEvents.rows,
      upload_moderation_counts: Object.fromEntries(
        uploadCounts.rows.map(({ status: key, count }) => [key, count]),
      ),
    });
  } catch (error) {
    return next(error);
  }
};

export const getAdminHistory = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT log.id, log.action, log.target_type, log.target_id,
              log.details, log.created_at, actor.full_name AS actor_name
       FROM admin_audit_log AS log
       LEFT JOIN users AS actor ON actor.id = log.actor_id
       ORDER BY log.created_at DESC
       LIMIT 100`,
    );
    return response.status(200).json({ history: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const actOnReport = async (request, response, next) => {
  const { reportId } = request.params;
  const action = request.body?.action;
  const note =
    typeof request.body?.note === "string" ? request.body.note.trim().slice(0, 500) : "";
  const suspensionDays = Number(request.body?.days ?? 7);
  if (
    !UUID_PATTERN.test(reportId) ||
    !["review", "dismiss", "hide", "delete", "suspend"].includes(action) ||
    (action === "suspend" &&
      (!Number.isInteger(suspensionDays) || suspensionDays < 1 || suspensionDays > 365))
  ) {
    return response.status(400).json({ error: "Action de modération invalide." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT report.id, report.target_type, report.target_id, report.status,
              target_owner.id AS target_user_id
       FROM reports AS report
       LEFT JOIN posts AS post
         ON report.target_type = 'POST' AND post.id = report.target_id
       LEFT JOIN post_comments AS comment
         ON report.target_type = 'COMMENT' AND comment.id = report.target_id
       LEFT JOIN marketplace_items AS item
         ON report.target_type = 'MARKETPLACE_ITEM' AND item.id = report.target_id
       LEFT JOIN private_messages AS private_message
         ON report.target_type = 'MESSAGE' AND private_message.id = report.target_id
       LEFT JOIN messages AS channel_message
         ON report.target_type = 'MESSAGE' AND channel_message.id = report.target_id
       LEFT JOIN sos_alerts AS sos
         ON report.target_type = 'SOS' AND sos.id = report.target_id
       LEFT JOIN users AS target_owner
         ON target_owner.id = CASE
           WHEN report.target_type IN ('PROFILE', 'LIVE_PARTICIPANT') THEN report.target_id
           WHEN report.target_type = 'POST' THEN post.author_id
           WHEN report.target_type = 'COMMENT' THEN comment.user_id
           WHEN report.target_type = 'MARKETPLACE_ITEM' THEN item.seller_id
           WHEN report.target_type = 'SOS' THEN sos.user_id
           WHEN private_message.id IS NOT NULL THEN private_message.sender_id
           ELSE channel_message.sender_id
         END
       WHERE report.id = $1
       FOR UPDATE OF report`,
      [reportId],
    );
    if (!report.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Signalement introuvable." });
    }
    const entry = report.rows[0];
    if (!["PENDING", "APPEALED"].includes(entry.status)) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Ce signalement a déjà été traité." });
    }
    if (action === "hide") {
      if (!["POST", "SOS"].includes(entry.target_type)) {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "Le masquage est disponible pour les publications et les alertes SOS.",
        });
      }
      await client.query(
        entry.target_type === "POST"
          ? "UPDATE posts SET status = 'HIDDEN' WHERE id = $1"
          : "UPDATE sos_alerts SET status = 'CLOSED' WHERE id = $1",
        [entry.target_id],
      );
    } else if (action === "delete") {
      const deleteSql = CONTENT_DELETE_SQL[entry.target_type];
      if (!deleteSql || entry.target_type === "PROFILE" || entry.target_type === "LIVE_PARTICIPANT") {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "Un compte ne peut pas être supprimé depuis un signalement; suspendez-le.",
        });
      }
      if (entry.target_type === "MESSAGE") {
        await client.query("DELETE FROM private_messages WHERE id = $1", [entry.target_id]);
        await client.query("DELETE FROM messages WHERE id = $1", [entry.target_id]);
      } else {
        await client.query(deleteSql, [entry.target_id]);
      }
    } else if (action === "suspend") {
      if (!entry.target_user_id || entry.target_user_id === request.auth.userId) {
        await client.query("ROLLBACK");
        return response.status(400).json({ error: "Ce compte ne peut pas être suspendu." });
      }
      await client.query(
        `UPDATE users SET suspended_until = NOW() + ($2 * INTERVAL '1 day')
         WHERE id = $1`,
        [entry.target_user_id, suspensionDays],
      );
    }

    const status = action === "dismiss" ? "DISMISSED" : "RESOLVED";
    await client.query(
      `UPDATE reports
       SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP,
           admin_note = NULLIF($4, ''), moderation_target_user_id = $5
       WHERE id = $1`,
      [reportId, status, request.auth.userId, note, entry.target_user_id],
    );
    await audit(
      client,
      request.auth.userId,
      action,
      entry.target_type,
      entry.target_id,
      { report_id: reportId, note, ...(action === "suspend" ? { days: suspensionDays } : {}) },
    );
    await client.query("COMMIT");
    return response.status(200).json({ updated: true, status });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
};

export const appealPostModerationEvent = async (request, response, next) => {
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
      `UPDATE post_moderation_events
       SET status = 'APPEALED', appeal_reason = $3, appealed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND author_id = $2
         AND status IN ('PENDING_REVIEW', 'BLOCKED')
       RETURNING id, status, appealed_at`,
      [eventId, request.auth.userId, reason],
    );
    if (!result.rowCount) {
      return response.status(404).json({
        error: "Ce contenu ne peut pas faire l'objet d'un recours ou est introuvable.",
      });
    }
    return response.status(200).json({ appealed: true, event: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const resolvePostModerationEvent = async (request, response, next) => {
  const eventId = request.params.eventId;
  const action = request.body?.action;
  const suspensionDays = Number(request.body?.days ?? 7);
  if (
    !UUID_PATTERN.test(eventId) ||
    !["approve", "remove", "warn", "suspend"].includes(action) ||
    (action === "suspend" &&
      (!Number.isInteger(suspensionDays) ||
        suspensionDays < 1 ||
        suspensionDays > 365))
  ) {
    return response.status(400).json({ error: "Action de modération invalide." });
  }

  const client = await pool.connect();
  let notificationUserId = null;
  let transactionCommitted = false;
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT event.id, event.post_id, event.author_id, event.media_type,
              event.media_id, event.score, event.status,
              post.id AS available_post_id
       FROM post_moderation_events AS event
       LEFT JOIN posts AS post ON post.id = event.post_id
       WHERE event.id = $1
         AND event.status IN ('PENDING_REVIEW', 'BLOCKED', 'CHILD_SAFETY_ALERT', 'APPEALED')
       FOR UPDATE OF event`,
      [eventId],
    );
    const event = selected.rows[0];
    if (!event) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Contenu introuvable ou déjà traité." });
    }
    if (action === "approve" && event.status === "CHILD_SAFETY_ALERT") {
      await client.query("ROLLBACK");
      return response.status(409).json({
        error: "Une alerte de protection de l’enfance ne peut pas être publiée.",
      });
    }
    if (action === "approve") {
      await client.query(
        `UPDATE post_moderation_events
         SET status = 'CLEARED', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [eventId, request.auth.userId],
      );
      const outstanding = await client.query(
        `SELECT 1 FROM post_moderation_events
         WHERE post_id = $1 AND id <> $2
           AND status IN ('PENDING_REVIEW', 'BLOCKED', 'CHILD_SAFETY_ALERT', 'APPEALED')
         LIMIT 1`,
        [event.post_id, eventId],
      );
      if (!outstanding.rowCount && event.available_post_id) {
        await client.query(
          "UPDATE posts SET status = 'ACTIVE' WHERE id = $1",
          [event.post_id],
        );
      }
    } else if (action === "remove") {
      const assets = await client.query(
        `SELECT media_type, media_id
         FROM post_moderation_events
         WHERE post_id = $1
         UNION
         SELECT 'image', media_public_id
         FROM post_media_items
         WHERE post_id = $1`,
        [event.post_id],
      );
      for (const asset of assets.rows) {
        await deleteCloudinaryAsset(asset.media_type, asset.media_id);
      }
      await client.query("DELETE FROM posts WHERE id = $1", [event.post_id]);
      await client.query(
        `UPDATE post_moderation_events
         SET status = 'CONFIRMED', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
         WHERE post_id = $1
           AND status IN ('PENDING_REVIEW', 'BLOCKED', 'CHILD_SAFETY_ALERT', 'APPEALED')`,
        [event.post_id, request.auth.userId],
      );
    } else {
      if (event.author_id === request.auth.userId) {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "Cette action ne peut pas viser votre propre compte.",
        });
      }
      if (action === "suspend") {
        await client.query(
          `UPDATE users SET suspended_until = NOW() + ($2 * INTERVAL '1 day')
           WHERE id = $1`,
          [event.author_id, suspensionDays],
        );
        if (event.available_post_id) {
          await client.query(
            "UPDATE posts SET status = 'HIDDEN' WHERE id = $1",
            [event.post_id],
          );
        }
      }
      await client.query(
        `UPDATE post_moderation_events
         SET status = 'CONFIRMED', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [eventId, request.auth.userId],
      );
      notificationUserId = event.author_id;
    }
    await audit(
      client,
      request.auth.userId,
      action,
      "POST_MODERATION",
      event.post_id,
      { event_id: eventId, media_type: event.media_type, score: event.score },
    );
    await client.query("COMMIT");
    transactionCommitted = true;

    if (notificationUserId) {
      const tokenRows = await pool.query(
        "SELECT token FROM push_tokens WHERE user_id = $1",
        [notificationUserId],
      );
      const result = await sendExpoPushNotifications(
        tokenRows.rows.map(({ token }) => token),
        {
          title: action === "warn" ? "Avertissement de modération" : "Compte suspendu",
          body:
            action === "warn"
              ? "Une publication doit respecter les règles de QuartierPlus. Vous pouvez contester cette décision depuis votre activité."
              : `Votre compte est suspendu pour ${suspensionDays} jour(s). Vous pouvez contester cette décision.`,
          data: { screen: "MyActivity", activity: "alerts" },
        },
      );
      if (result.failedCount) {
        console.error("Unable to deliver moderation warning notification:", {
          userId: notificationUserId,
          failedCount: result.failedCount,
        });
      }
    }
    return response.status(200).json({ updated: true, action });
  } catch (error) {
    if (!transactionCommitted) await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
};

export const appealReport = async (request, response, next) => {
  const reportId = request.params.reportId;
  const reason =
    typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
  if (!UUID_PATTERN.test(reportId) || reason.length < 10 || reason.length > 500) {
    return response.status(400).json({
      error: "Un recours doit contenir entre 10 et 500 caractères.",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(
      `${reportSelect}
       WHERE report.id = $1 AND report.status = 'RESOLVED'
       FOR UPDATE OF report`,
      [reportId],
    );
    const entry = report.rows[0];
    if (!entry || entry.target_user_id !== request.auth.userId) {
      await client.query("ROLLBACK");
      return response.status(404).json({
        error: "Ce contenu ne peut pas faire l'objet d'un recours ou est introuvable.",
      });
    }
    const result = await client.query(
      `UPDATE reports
       SET status = 'APPEALED', appeal_reason = $3, appealed_by = $2,
           appealed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'RESOLVED'
       RETURNING id, status, appealed_at`,
      [reportId, request.auth.userId, reason],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Ce signalement a déjà été contesté." });
    }
    await audit(
      client,
      request.auth.userId,
      "appeal",
      "REPORT",
      reportId,
      { reason },
    );
    await client.query("COMMIT");
    return response.status(200).json({ appealed: true, report: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
};

export const listAppealableReports = async (request, response, next) => {
  try {
    const [reports, moderationEvents, conflicts] = await Promise.all([
      pool.query(
        `${reportSelect}
         WHERE report.moderation_target_user_id = $1
           AND report.status = 'RESOLVED'
         ORDER BY report.reviewed_at DESC
         LIMIT 50`,
        [request.auth.userId],
      ),
      pool.query(
        `SELECT id, media_type, score::float8 AS score, status, created_at
         FROM post_moderation_events
         WHERE author_id = $1 AND status IN ('PENDING_REVIEW', 'BLOCKED')
         ORDER BY created_at DESC
         LIMIT 50`,
        [request.auth.userId],
      ),
      pool.query(
        `SELECT id, category, target_type, created_at
         FROM moderation_conflicts
         WHERE actor_id = $1 AND status IN ('PENDING', 'WARNED', 'SUSPENDED')
           AND appeal_reason IS NULL
         ORDER BY created_at DESC
         LIMIT 50`,
        [request.auth.userId],
      ),
    ]);
    return response.status(200).json({
      reports: reports.rows,
      moderation_events: moderationEvents.rows,
      conflicts: conflicts.rows,
    });
  } catch (error) {
    return next(error);
  }
};

const validateFlash = (body) => {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  const targetType = typeof body?.target_type === "string" ? body.target_type : "";
  const target = body?.target && typeof body.target === "object" ? body.target : {};
  const scheduledAt = body?.scheduled_at ? new Date(body.scheduled_at) : new Date();
  if (!title || title.length > 80 || !message || message.length > 280) {
    return { error: "Le titre (80 caractères) et le message (280 caractères) sont obligatoires." };
  }
  if (!["ALL", "COUNTRY", "NEIGHBORHOOD", "REGION"].includes(targetType)) {
    return { error: "Portée de diffusion invalide." };
  }
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60_000) {
    return { error: "La date d'envoi est invalide." };
  }
  if (targetType === "COUNTRY" && !/^[A-Z]{2,3}$/.test(target.country_code ?? "")) {
    return { error: "Sélectionnez un code pays valide." };
  }
  if (
    targetType === "NEIGHBORHOOD" &&
    (typeof target.neighborhood !== "string" ||
      !target.neighborhood.trim() ||
      target.neighborhood.length > 100)
  ) {
    return { error: "Saisissez un quartier valide." };
  }
  if (targetType === "REGION") {
    const { latitude, longitude, radius_km } = target;
    if (
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 ||
      typeof radius_km !== "number" ||
      !Number.isFinite(radius_km) ||
      radius_km < 1 ||
      radius_km > 300
    ) {
      return { error: "Le centre et le rayon de la région (1 à 300 km) sont requis." };
    }
  }
  return { title, message, targetType, target, scheduledAt };
};

export const createFlash = async (request, response, next) => {
  const flash = validateFlash(request.body);
  if (flash.error) return response.status(400).json({ error: flash.error });
  const client = await pool.connect();
  let broadcast;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO admin_flash_broadcasts
         (id, actor_id, title, body, target_type, target, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, title, body, target_type, target, status,
                 scheduled_at, created_at`,
      [
        randomUUID(),
        request.auth.userId,
        flash.title,
        flash.message,
        flash.targetType,
        JSON.stringify(flash.target),
        flash.scheduledAt,
      ],
    );
    broadcast = result.rows[0];
    await audit(
      client,
      request.auth.userId,
      "flash_scheduled",
      "FLASH",
      broadcast.id,
      { target_type: flash.targetType, scheduled_at: flash.scheduledAt },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
  if (flash.scheduledAt.getTime() <= Date.now()) {
    const sent = await deliverFlashBroadcast(broadcast.id);
    if (sent) return response.status(200).json({ broadcast: sent });
    const current = await pool.query(
      `SELECT id, status, scheduled_at, sent_at, recipient_count,
              accepted_count, failed_count, error_message
       FROM admin_flash_broadcasts
       WHERE id = $1`,
      [broadcast.id],
    );
    if (!current.rowCount) throw new Error("The flash broadcast disappeared after scheduling.");
    return response.status(current.rows[0].status === "SENDING" ? 202 : 200).json({
      broadcast: current.rows[0],
    });
  }
  return response.status(201).json({ broadcast });
};

const recipientQuery = (broadcast) => {
  let where;
  switch (broadcast.target_type) {
    case "ALL":
      where = { sql: "", values: [] };
      break;
    case "COUNTRY":
      where = {
        sql: "AND account.country_code = $1",
        values: [broadcast.target.country_code],
      };
      break;
    case "NEIGHBORHOOD":
      where = {
        sql: "AND LOWER(account.neighborhood) = LOWER($1)",
        values: [broadcast.target.neighborhood.trim()],
      };
      break;
    case "REGION":
      where = {
        sql: `AND account.last_location IS NOT NULL
            AND ST_DWithin(
              account.last_location::geography,
              ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
              $3
            )`,
        values: [
          broadcast.target.longitude,
          broadcast.target.latitude,
          broadcast.target.radius_km * 1000,
        ],
      };
      break;
    default:
      throw new Error("Unsupported admin flash target type.");
  }
  return pool.query(
    `SELECT DISTINCT token
     FROM push_tokens AS push
     JOIN users AS account ON account.id = push.user_id
     WHERE (account.suspended_until IS NULL OR account.suspended_until <= NOW())
     ${where.sql}`,
    where.values,
  );
};

export const deliverFlashBroadcast = async (broadcastId) => {
  const claimed = await pool.query(
    `UPDATE admin_flash_broadcasts
     SET status = 'SENDING'
     WHERE id = $1 AND status = 'SCHEDULED'
     RETURNING *`,
    [broadcastId],
  );
  if (!claimed.rowCount) return null;
  const broadcast = claimed.rows[0];
  let recipientCount = 0;
  try {
    const recipients = await recipientQuery(broadcast);
    recipientCount = recipients.rowCount;
    const delivery = await sendAdminFlashNotifications(
      recipients.rows.map((row) => row.token),
      { title: broadcast.title, body: broadcast.body, data: { broadcast_id: broadcast.id } },
    );
    const status = delivery.acceptedCount > 0 ? "SENT" : "FAILED";
    const failureMessage =
      delivery.acceptedCount > 0
        ? null
        : recipients.rowCount === 0
          ? "Aucun appareil inscrit pour cette cible."
          : "Expo n'a accepté aucune notification.";
    const updated = await pool.query(
      `UPDATE admin_flash_broadcasts
       SET status = $5,
           sent_at = CASE WHEN $5 = 'SENT' THEN CURRENT_TIMESTAMP ELSE NULL END,
           recipient_count = $2, accepted_count = $3, failed_count = $4,
           error_message = $6
       WHERE id = $1
       RETURNING id, status, scheduled_at, sent_at, recipient_count,
                 accepted_count, failed_count`,
      [
        broadcast.id,
        recipients.rowCount,
        delivery.acceptedCount,
        delivery.failedCount,
        status,
        failureMessage,
      ],
    );
    await pool.query(
      `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details)
       VALUES ($1, 'flash_sent', 'FLASH', $2, $3::jsonb)`,
      [
        broadcast.actor_id,
        broadcast.id,
        JSON.stringify({
          recipient_count: recipients.rowCount,
          accepted_count: delivery.acceptedCount,
          failed_count: delivery.failedCount,
        }),
      ],
    );
    return updated.rows[0];
  } catch (error) {
    await pool.query(
      `UPDATE admin_flash_broadcasts
       SET status = 'FAILED', error_message = $2,
           recipient_count = $3, accepted_count = $4, failed_count = $5
       WHERE id = $1`,
      [
        broadcast.id,
        String(error?.message ?? error).slice(0, 500),
        recipientCount,
        Number.isSafeInteger(error?.acceptedCount) ? error.acceptedCount : 0,
        Number.isSafeInteger(error?.failedCount) ? error.failedCount : recipientCount,
      ],
    );
    throw error;
  }
};

export const processScheduledFlashes = async () => {
  await pool.query(
    `UPDATE admin_flash_broadcasts
     SET status = 'FAILED',
         error_message = 'Worker arrêté pendant l’envoi; statut vérifié manuellement.'
     WHERE status = 'SENDING'
       AND created_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`,
  );
  const due = await pool.query(
    `SELECT id
     FROM admin_flash_broadcasts
     WHERE status = 'SCHEDULED' AND scheduled_at <= CURRENT_TIMESTAMP
     ORDER BY scheduled_at
     LIMIT 10`,
  );
  for (const { id } of due.rows) {
    try {
      await deliverFlashBroadcast(id);
    } catch (error) {
      console.error("Scheduled admin flash delivery failed:", {
        broadcastId: id,
        message: error.message,
      });
    }
  }
};

export const listFlashes = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, body, target_type, target, status, scheduled_at,
              sent_at, recipient_count, accepted_count, failed_count,
              error_message, created_at
       FROM admin_flash_broadcasts
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    return response.status(200).json({ broadcasts: result.rows });
  } catch (error) {
    return next(error);
  }
};
