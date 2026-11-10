import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

const client = await pool.connect();

try {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Rerun with --confirm to explicitly grant the admin role.");
  }
  if (!env.adminEmail) {
    throw new Error("Set ADMIN_EMAIL to the existing account's verified email first.");
  }

  await client.query("BEGIN");
  const account = await client.query(
    `SELECT id
     FROM users
     WHERE LOWER(email) = LOWER($1)
       AND email_verified_at IS NOT NULL
       AND phone_verified_at IS NOT NULL
       AND is_verified = TRUE
     FOR UPDATE`,
    [env.adminEmail],
  );
  if (account.rowCount !== 1) {
    throw new Error(
      "Exactly one account with verified email and phone is required; no role was changed.",
    );
  }

  const updated = await client.query(
    "UPDATE users SET role = 'admin' WHERE id = $1 RETURNING id",
    [account.rows[0].id],
  );
  if (updated.rowCount !== 1) {
    throw new Error("The verified account could not be updated.");
  }
  await client.query("COMMIT");
  console.info(
    "Admin role granted to the configured verified account. Sign in again to refresh the role in the app.",
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Admin role grant failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
