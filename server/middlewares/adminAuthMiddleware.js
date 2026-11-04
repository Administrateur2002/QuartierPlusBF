import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export const adminAuthMiddleware = async (request, response, next) => {
  if (!env.adminUserIds.includes(request.auth?.userId)) {
    return response.status(403).json({ error: "Accès administrateur refusé." });
  }
  if (request.auth.authMethod !== "sms_otp") {
    return response.status(403).json({
      error: "Reconnectez-vous avec le code SMS vérifié du compte administrateur.",
    });
  }
  try {
    const result = await pool.query(
      `SELECT 1
       FROM users
       WHERE id = $1
         AND LOWER(email) = $2
         AND email_verified_at IS NOT NULL
         AND is_verified = TRUE
         AND phone_verified_at IS NOT NULL`,
      [request.auth.userId, env.adminEmail],
    );
    if (!result.rowCount) {
      return response.status(403).json({
        error: "Le compte administrateur doit être autorisé et vérifier son e-mail et son téléphone.",
      });
    }
    request.adminAuthorized = true;
    return next();
  } catch (error) {
    return next(error);
  }
};
