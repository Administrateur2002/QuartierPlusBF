import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export class ModerationCapacityError extends Error {}

const reserveDailyAnalysis = async () => {
  const result = await pool.query(
    `INSERT INTO moderation_daily_usage (usage_date, analysis_count)
     VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (usage_date) DO UPDATE
       SET analysis_count = moderation_daily_usage.analysis_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE moderation_daily_usage.analysis_count < $1
     RETURNING analysis_count`,
    [env.moderationDailyAnalysisLimit],
  );
  if (!result.rowCount) throw new ModerationCapacityError();
};

export const analyzeUploadedMedia = async ({ url, mediaType, duration }) => {
  if (!env.moderationUploadsEnabled) {
    return { enabled: false };
  }
  await reserveDailyAnalysis();
  const response = await fetch(
    `${env.moderationServiceUrl.replace(/\/+$/, "")}/v1/analyze-upload`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grin-Moderation-Token": env.grinModerationWebhookSecret,
      },
      body: JSON.stringify({
        url,
        media_type: mediaType,
        ...(mediaType === "video" ? { duration } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Le service de modération a répondu HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.score !== "number" ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 100 ||
    typeof result.minorDetected !== "boolean"
  ) {
    throw new Error("La réponse du service de modération est invalide.");
  }
  return {
    enabled: true,
    score: result.score,
    minorDetected: result.minorDetected,
  };
};
