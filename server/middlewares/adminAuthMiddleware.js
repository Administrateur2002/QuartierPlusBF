import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export const adminAuthMiddleware = async (request, response, next) => {
  if (!env.adminEmail) {
    return response.status(503).json({
      error: "L'accès administrateur n'est pas configuré sur ce serveur.",
    });
  }
  try {
    const result = await pool.query(
      `SELECT 1
       FROM users
       WHERE id = $1
         AND LOWER(role) = 'admin'
         AND LOWER(email) = LOWER($2)
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
