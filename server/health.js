export const API_CONTRACT_VERSION = 2;
export const SERVER_STARTED_AT = new Date().toISOString();

export const getHealthPayload = (lastMigration = null) => ({
  status: "ok",
  commit: process.env.RENDER_GIT_COMMIT ?? "unknown",
  contractVersion: API_CONTRACT_VERSION,
  startedAt: SERVER_STARTED_AT,
  lastMigration,
});

export const handleHealth = async (_request, response) => {
  let lastMigration = null;
  try {
    const { pool } = await import("./db/pool.js");
    const result = await pool.query(
      `SELECT version, applied_at FROM app_migrations
       ORDER BY applied_at DESC, version DESC LIMIT 1`,
    );
    lastMigration = result.rows[0] ?? null;
  } catch {
    // Older databases have no migration registry yet, or the database is unavailable.
  }
  return response.status(200).json(getHealthPayload(lastMigration));
};
