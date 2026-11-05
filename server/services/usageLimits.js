import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export const reserveDailySms = async () => {
  const result = await pool.query(
    `INSERT INTO sms_daily_usage (usage_date, sent_count)
     VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (usage_date) DO UPDATE
       SET sent_count = sms_daily_usage.sent_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE sms_daily_usage.sent_count < $1
     RETURNING sent_count`,
    [env.smsDailyLimit],
  );
  return result.rowCount > 0;
};

export const reserveDailyMediaUpload = async (userId) => {
  const result = await pool.query(
    `INSERT INTO media_upload_daily_usage (user_id, usage_date, upload_count)
     VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (user_id, usage_date) DO UPDATE
       SET upload_count = media_upload_daily_usage.upload_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE media_upload_daily_usage.upload_count < $2
     RETURNING upload_count`,
    [userId, env.uploadsDailyLimit],
  );
  return result.rowCount > 0;
};
