import { pool } from "../db/pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_TYPES = new Map([
  ["post", { type: "POST", table: "posts" }],
  ["message", { type: "MESSAGE", table: null }],
  ["marketplace_item", { type: "MARKETPLACE_ITEM", table: "marketplace_items" }],
  ["comment", { type: "COMMENT", table: "post_comments" }],
  ["profile", { type: "PROFILE", table: "users" }],
]);
const REPORT_REASONS = new Set([
  "Harcèlement",
  "Insultes",
  "Arnaque",
  "Faux profil",
  "Spam",
  "Usurpation d’identité",
  "Contenu dangereux",
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
  try {
    const targetResult = target.table
      ? await pool.query(`SELECT id FROM ${target.table} WHERE id = $1`, [targetId])
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
             AND (channel.country_code IS NULL OR channel.country_code = (
               SELECT country_code FROM users WHERE id = $2
             ))
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
    return response.status(201).json({
      reported: true,
      report_id: result.rows[0].id,
    });
  } catch (error) {
    return next(error);
  }
};
