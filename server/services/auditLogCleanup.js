import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export const cleanupExpiredAuditLogs = async () => {
  const result = await pool.query(
    `DELETE FROM admin_audit_log
     WHERE created_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 day')`,
    [env.auditLogRetentionDays],
  );
  if (result.rowCount > 0) {
    console.info("Expired admin audit entries removed:", result.rowCount);
  }
  return result.rowCount;
};

export const scheduleAuditLogCleanup = () => {
  const cleanup = () => {
    void cleanupExpiredAuditLogs().catch((error) => {
      console.error("Unable to clean expired admin audit entries:", error);
    });
  };
  cleanup();
  const interval = setInterval(cleanup, 24 * 60 * 60 * 1000);
  interval.unref();
};
