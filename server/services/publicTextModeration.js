import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

const warning =
  "Votre texte peut être blessant ou menaçant. Relisez-le et confirmez si vous souhaitez vraiment l’envoyer.";

const normalize = (value) =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matchesTerm = (text, term) => {
  const phrase = normalize(term)
    .trim()
    .split(/\s+/)
    .map(escapeRegex)
    .join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}($|[^\\p{L}\\p{N}])`, "u").test(
    normalize(text),
  );
};

const findMatch = async (text) => {
  if (!text || !env.textModerationEnabled) return null;
  const result = await pool.query(
    `SELECT term, category
     FROM moderation_lexicon
     WHERE enabled = TRUE`,
  );
  return result.rows.find((entry) => matchesTerm(text, entry.term)) ?? null;
};

const activePause = async (userId) => {
  if (!env.conflictProtectionEnabled) return null;
  const result = await pool.query(
    `SELECT paused_until FROM user_moderation_pauses
     WHERE user_id = $1 AND paused_until > CURRENT_TIMESTAMP`,
    [userId],
  );
  return result.rows[0]?.paused_until ?? null;
};

export const inspectPublicText = async ({ userId, text }) => {
  if (!env.textModerationEnabled) return { enabled: false, hostile: false };
  const pausedUntil = text ? await activePause(userId) : null;
  if (pausedUntil) {
    return {
      enabled: true,
      hostile: false,
      pausedUntil,
    };
  }
  const match = await findMatch(text);
  return {
    enabled: true,
    hostile: Boolean(match),
    category: match?.category ?? null,
    warning: match ? warning : null,
  };
};

export const evaluatePublicText = async ({
  userId,
  targetUserId = null,
  targetType,
  targetId = null,
  text,
  confirmed = false,
}) => {
  const inspection = await inspectPublicText({ userId, text });
  if (inspection.pausedUntil) {
    return {
      allowed: false,
      status: 429,
      code: "MODERATION_PAUSE",
      pause_until: inspection.pausedUntil,
      error: "Vous ne pouvez pas envoyer de message pendant la pause de 15 minutes.",
    };
  }
  if (!inspection.hostile) return { allowed: true, conflictId: null };
  if (!confirmed) {
    return {
      allowed: false,
      status: 409,
      code: "HOSTILE_TEXT_WARNING",
      warning: inspection.warning,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (env.conflictProtectionEnabled) {
      const currentPause = await client.query(
        `SELECT paused_until FROM user_moderation_pauses
         WHERE user_id = $1 AND paused_until > CURRENT_TIMESTAMP`,
        [userId],
      );
      if (currentPause.rows[0]?.paused_until) {
        await client.query("ROLLBACK");
        return {
          allowed: false,
          status: 429,
          code: "MODERATION_PAUSE",
          pause_until: currentPause.rows[0].paused_until,
          error: "Vous ne pouvez pas envoyer de message pendant la pause de 15 minutes.",
        };
      }
    }
    const pair = targetUserId
      ? await client.query(
          `SELECT COUNT(*)::int AS count
           FROM moderation_conflicts
           WHERE actor_id = $1 AND target_user_id = $2
             AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
             AND category IN ('INSULT', 'THREAT')`,
          [userId, targetUserId],
        )
      : { rows: [{ count: 0 }] };
    const conflict = await client.query(
      `INSERT INTO moderation_conflicts
         (actor_id, target_user_id, target_type, target_id, category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, targetUserId, targetType, targetId, inspection.category],
    );
    const shouldPause =
      env.conflictProtectionEnabled &&
      targetUserId &&
      pair.rows[0].count + 1 >= 3;
    let pauseUntil = null;
    if (shouldPause) {
      const paused = await client.query(
        `INSERT INTO user_moderation_pauses (user_id, paused_until)
         VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '15 minutes')
         ON CONFLICT (user_id) DO UPDATE
           SET paused_until = GREATEST(
                 user_moderation_pauses.paused_until,
                 EXCLUDED.paused_until
               ),
               updated_at = CURRENT_TIMESTAMP
         RETURNING paused_until`,
        [userId],
      );
      pauseUntil = paused.rows[0].paused_until;
    }
    await client.query("COMMIT");
    if (pauseUntil) {
      return {
        allowed: false,
        status: 429,
        code: "MODERATION_PAUSE",
        pause_until: pauseUntil,
        category: inspection.category,
        conflictId: conflict.rows[0].id,
        error: "Vous ne pouvez pas envoyer de message pendant la pause de 15 minutes.",
      };
    }
    return {
      allowed: true,
      conflictId: conflict.rows[0].id,
      category: inspection.category,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const textModerationWarning = warning;
