import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { sendSupportNotification } from "../services/email.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_TYPES = new Map([
  ["post", { type: "POST", table: "posts" }],
  ["message", { type: "MESSAGE", table: null }],
  ["marketplace_item", { type: "MARKETPLACE_ITEM", table: "marketplace_items" }],
  ["comment", { type: "COMMENT", table: "post_comments" }],
  ["profile", { type: "PROFILE", table: "users" }],
  ["live_participant", { type: "LIVE_PARTICIPANT", table: "users" }],
]);
const REPORT_REASONS = new Set([
  "Harcèlement",
  "Insultes",
  "Arnaque",
  "Faux profil",
  "Spam",
  "Usurpation d’identité",
  "Contenu dangereux",
  "Menaces",
  "Nudité explicite",
  "Contenu privé sans consentement",
  "Fausse information",
  "Fausse alerte",
  "Comportement abusif",
  "Autre motif",
]);

export const createReport = async (request, response, next) => {
  const target =
    typeof request.body?.target_type === "string"
      ? TARGET_TYPES.get(request.body.target_type.toLowerCase())
      : undefined;
  const targetId =
    typeof request.body?.target_id === "string"
      ? request.body.target_id
      : "";
  const reason =
    typeof request.body?.reason === "string"
      ? request.body.reason.trim()
      : "";
  if (!target || !UUID_PATTERN.test(targetId) || !REPORT_REASONS.has(reason)) {
    return response.status(400).json({ error: "Les informations du signalement sont invalides." });
  }
  if (
    target.type === "LIVE_PARTICIPANT" &&
    targetId === request.auth.userId
  ) {
    return response.status(400).json({
      error: "Vous ne pouvez pas vous signaler vous-même.",
    });
  }
  try {
    const targetResult = target.table
      ? await pool.query(
          target.type === "POST"
            ? "SELECT id, author_id AS owner_id FROM posts WHERE id = $1"
            : target.type === "COMMENT"
              ? "SELECT id, user_id AS owner_id FROM post_comments WHERE id = $1"
              : `SELECT id, id AS owner_id FROM ${target.table} WHERE id = $1`,
          [targetId],
        )
      : await pool.query(
          `SELECT private_message.id
           FROM private_messages private_message
           WHERE private_message.id = $1
             AND EXISTS (
               SELECT 1 FROM conversation_participants participant
               WHERE participant.conversation_id = private_message.conversation_id
                 AND participant.user_id = $2
             )
           UNION ALL
           SELECT channel_message.id
           FROM messages channel_message
           JOIN channels channel ON channel.id = channel_message.channel_id
           WHERE channel_message.id = $1
             AND channel_message.removed_at IS NULL
             AND (
               channel.geography_scope = 'international'
               OR channel.country_code = (
                 SELECT country_code FROM users WHERE id = $2
               )
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
             )
           LIMIT 1`,
          [targetId, request.auth.userId],
        );
    if (!targetResult.rowCount) {
      return response.status(404).json({ error: "Le contenu à signaler est introuvable." });
    }
    const result = await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [request.auth.userId, target.type, targetId, reason],
    );
    if (
      env.supportNotifyEmail &&
      ["Menaces", "Nudité explicite", "Contenu privé sans consentement"].includes(reason)
    ) {
      try {
        await sendSupportNotification(
          "Alerte prioritaire — signalement grave QuartierPlus",
          `Un signalement grave a été créé. Identifiant de revue : ${result.rows[0].id}. Aucun contenu du signalement n'est inclus dans cette alerte.`,
        );
      } catch (error) {
        console.error("Unable to deliver severe report notification:", error);
      }
    }
    if (
      env.conflictProtectionEnabled &&
      ["POST", "COMMENT"].includes(target.type) &&
      targetResult.rows[0].owner_id !== request.auth.userId
    ) {
      const reportCount = await pool.query(
        `SELECT COUNT(DISTINCT reporter_id)::int AS count
         FROM reports
         WHERE target_type = $1 AND target_id = $2
           AND reporter_id <> $3
           AND created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'`,
        [target.type, targetId, targetResult.rows[0].owner_id],
      );
      if (reportCount.rows[0].count >= 3) {
        const conflict = await pool.query(
          `INSERT INTO moderation_conflicts
             (actor_id, target_type, target_id, category)
           VALUES ($1, 'REPORT', $2, 'REPEATED_REPORTS')
           ON CONFLICT DO NOTHING`,
          [targetResult.rows[0].owner_id, targetId],
        );
        if (conflict.rowCount && env.supportNotifyEmail) {
          try {
            await sendSupportNotification(
              "Alerte — signalements multiples sur QuartierPlus",
              `Plusieurs comptes ont signalé le même contenu public dans les dernières 24 heures. Identifiant du contenu : ${targetId}. Aucun texte de signalement n'est inclus dans cette alerte.`,
            );
          } catch (error) {
            console.error("Unable to deliver repeated-report notification:", error);
          }
        }
      }
    }
    return response.status(201).json({
      reported: true,
      report_id: result.rows[0].id,
    });
  } catch (error) {
    return next(error);
  }
};
