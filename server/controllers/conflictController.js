import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { sendExpoPushNotifications } from "../services/pushNotifications.js";
import { sendSupportNotification } from "../services/email.js";
import {
  evaluatePublicText,
  inspectPublicText,
} from "../services/publicTextModeration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const checkPublicText = async (request, response, next) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  const targetType = request.body?.target_type;
  const targetUserId = request.body?.target_user_id ?? null;
  if (
    !text ||
    text.length > 1000 ||
    !["POST", "COMMENT", "CHANNEL_MESSAGE", "LIVE_TEXT"].includes(targetType) ||
    (targetUserId !== null &&
      (typeof targetUserId !== "string" || !UUID_PATTERN.test(targetUserId)))
  ) {
    return response.status(400).json({ error: "Texte public invalide." });
  }
  try {
    const inspection = await inspectPublicText({
      userId: request.auth.userId,
      text,
    });
    if (inspection.pausedUntil) {
      return response.status(429).json({
        code: "MODERATION_PAUSE",
        pause_until: inspection.pausedUntil,
        error: "Vous ne pouvez pas envoyer de message pendant la pause de 15 minutes.",
      });
    }
    return response.status(200).json({
      enabled: inspection.enabled,
      warning_required: inspection.hostile,
      ...(inspection.hostile ? { warning: inspection.warning } : {}),
    });
  } catch (error) {
    return next(error);
  }
};

export const listAdminConflicts = async (request, response, next) => {
  const status =
    typeof request.query.status === "string" &&
    ["PENDING", "WARNED", "SUSPENDED", "RESOLVED", "DISMISSED", "APPEALED", "ALL"].includes(
      request.query.status,
    )
      ? request.query.status
      : "PENDING";
  try {
    const [conflicts, counts] = await Promise.all([
      pool.query(
        `SELECT conflict.id, conflict.actor_id, conflict.target_user_id,
                conflict.target_type, conflict.target_id, conflict.category,
                conflict.status, conflict.appeal_reason, conflict.appealed_at,
                conflict.created_at, actor.full_name AS actor_name,
                target.full_name AS target_name,
                CASE WHEN conflict.target_type = 'POST' THEN post.caption
                     WHEN conflict.target_type = 'COMMENT' THEN comment.content
                     WHEN conflict.target_type = 'REPORT' THEN COALESCE(post.caption, comment.content)
                     ELSE NULL END AS public_text
         FROM moderation_conflicts AS conflict
         JOIN users AS actor ON actor.id = conflict.actor_id
         LEFT JOIN users AS target ON target.id = conflict.target_user_id
         LEFT JOIN posts AS post
           ON (conflict.target_type = 'POST' AND post.id = conflict.target_id)
           OR (conflict.target_type = 'REPORT' AND post.id = conflict.target_id)
         LEFT JOIN post_comments AS comment
           ON (conflict.target_type = 'COMMENT' AND comment.id = conflict.target_id)
           OR (conflict.target_type = 'REPORT' AND comment.id = conflict.target_id)
         WHERE ($1 = 'ALL'
           OR ($1 = 'APPEALED' AND conflict.appealed_at IS NOT NULL)
           OR conflict.status = $1)
         ORDER BY CASE WHEN conflict.appealed_at IS NOT NULL THEN 0 ELSE 1 END,
                  conflict.created_at DESC
         LIMIT 100`,
        [status],
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM moderation_conflicts
         GROUP BY status`,
      ),
    ]);
    return response.status(200).json({
      conflicts: conflicts.rows,
      counts: Object.fromEntries(counts.rows.map(({ status: key, count }) => [key, count])),
    });
  } catch (error) {
    return next(error);
  }
};

export const actOnConflict = async (request, response, next) => {
  const { conflictId } = request.params;
  const action = request.body?.action;
  const days = Number(request.body?.days ?? 7);
  if (
    !UUID_PATTERN.test(conflictId) ||
    !["approve", "remove", "warn", "suspend", "dismiss"].includes(action) ||
    (action === "suspend" && (!Number.isInteger(days) || days < 1 || days > 365))
  ) {
    return response.status(400).json({ error: "Action de modération invalide." });
  }
  const client = await pool.connect();
  let actorId;
  let conflict;
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, actor_id, target_type, target_id, status
       FROM moderation_conflicts WHERE id = $1 FOR UPDATE`,
      [conflictId],
    );
    conflict = selected.rows[0];
    if (!conflict || !["PENDING", "WARNED", "SUSPENDED"].includes(conflict.status)) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Conflit introuvable ou déjà traité." });
    }
    actorId = conflict.actor_id;
    if (action === "remove") {
      if (conflict.target_type === "POST") {
        await client.query("UPDATE posts SET status = 'HIDDEN' WHERE id = $1", [
          conflict.target_id,
        ]);
      } else if (conflict.target_type === "COMMENT") {
        await client.query("DELETE FROM post_comments WHERE id = $1", [
          conflict.target_id,
        ]);
      } else {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "Ce contenu ne peut pas être retiré depuis cette file.",
        });
      }
    } else if (action === "approve" && conflict.target_type === "POST") {
      await client.query("UPDATE posts SET status = 'ACTIVE' WHERE id = $1", [
        conflict.target_id,
      ]);
    } else if (action === "suspend") {
      await client.query(
        `UPDATE users SET suspended_until = NOW() + ($2 * INTERVAL '1 day')
         WHERE id = $1`,
        [actorId, days],
      );
    }
    const nextStatus =
      action === "warn" ? "WARNED" :
        action === "suspend" ? "SUSPENDED" :
          action === "dismiss" ? "DISMISSED" : "RESOLVED";
    await client.query(
      `UPDATE moderation_conflicts
       SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [conflictId, nextStatus, request.auth.userId],
    );
    await client.query(
      `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'CONFLICT', $3, $4::jsonb)`,
      [request.auth.userId, `conflict_${action}`, conflictId, JSON.stringify({ days })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }

  if (action === "warn") {
    try {
      const tokens = await pool.query(
        "SELECT token FROM push_tokens WHERE user_id = $1",
        [actorId],
      );
      await sendExpoPushNotifications(tokens.rows.map((row) => row.token), {
        title: "Rappel de la charte",
        body: "Un administrateur vous demande de respecter les autres membres.",
        data: { type: "moderation_warning", conflict_id: conflictId },
      });
    } catch (error) {
      console.error("Unable to deliver moderation warning:", error);
    }
  }
  return response.status(200).json({ updated: true });
};

export const appealConflict = async (request, response, next) => {
  const reason =
    typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
  if (!UUID_PATTERN.test(request.params.conflictId) || reason.length < 10 || reason.length > 500) {
    return response.status(400).json({
      error: "Un recours doit contenir entre 10 et 500 caractères.",
    });
  }
  try {
    const result = await pool.query(
      `UPDATE moderation_conflicts
       SET appeal_reason = $3, appealed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND actor_id = $2
         AND status IN ('PENDING', 'WARNED', 'SUSPENDED')
       RETURNING id, appealed_at`,
      [request.params.conflictId, request.auth.userId, reason],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Ce conflit ne peut pas faire l'objet d'un recours." });
    }
    return response.status(200).json({ appealed: true, conflict: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const listModerationLexicon = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, term, language, category, enabled, created_at
       FROM moderation_lexicon ORDER BY language, category, term`,
    );
    return response.status(200).json({ entries: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createModerationLexiconEntry = async (request, response, next) => {
  const term = typeof request.body?.term === "string" ? request.body.term.trim() : "";
  const language =
    typeof request.body?.language === "string"
      ? request.body.language.trim().toLowerCase()
      : "";
  const category = request.body?.category;
  if (
    !term ||
    term.length > 100 ||
    !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language) ||
    !["INSULT", "THREAT"].includes(category)
  ) {
    return response.status(400).json({ error: "Entrée du lexique invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO moderation_lexicon (term, language, category, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, term, language, category, enabled, created_at`,
      [term, language, category, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(409).json({ error: "Ce mot existe déjà dans le lexique." });
    }
    return response.status(201).json({ entry: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const deleteModerationLexiconEntry = async (request, response, next) => {
  if (!UUID_PATTERN.test(request.params.entryId)) {
    return response.status(400).json({ error: "Entrée du lexique invalide." });
  }
  try {
    const result = await pool.query(
      "DELETE FROM moderation_lexicon WHERE id = $1 RETURNING id",
      [request.params.entryId],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Entrée introuvable." });
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
};

export const getAgentModerationLexicon = async (request, response, next) => {
  if (!env.textModerationEnabled) {
    return response.status(503).json({ error: "La modération des textes est désactivée." });
  }
  const provided = request.get("x-grin-moderation-token") ?? "";
  const expected = env.grinModerationWebhookSecret;
  if (!expected || provided.length !== expected.length) {
    return response.status(401).json({ error: "Agent de modération non autorisé." });
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return response.status(401).json({ error: "Agent de modération non autorisé." });
  }
  try {
    const result = await pool.query(
      `SELECT term, category, language FROM moderation_lexicon
       WHERE enabled = TRUE ORDER BY category, term`,
    );
    return response.status(200).json({ entries: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const notifySupportOfSevereConflict = async (conflictId) => {
  if (!env.supportNotifyEmail) return;
  try {
    await sendSupportNotification(
      "Alerte prioritaire — menace signalée sur QuartierPlus",
      `Un texte public potentiellement menaçant a été signalé automatiquement. Identifiant de revue : ${conflictId}. Aucun texte ni transcription n'a été conservé par cette alerte.`,
    );
  } catch (error) {
    console.error("Unable to deliver severe conflict notification:", error);
  }
};

export const evaluateConfirmedPublicText = async (options) => {
  const result = await evaluatePublicText(options);
  if (result.category === "THREAT" && result.conflictId) {
    await notifySupportOfSevereConflict(result.conflictId);
  }
  return result;
};
