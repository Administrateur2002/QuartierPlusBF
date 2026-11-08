import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

const createAuthMiddleware = ({ allowSuspended = false } = {}) => async (
  request,
  response,
  next,
) => {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return response.status(401).json({ error: "Authentification requise." });
  }

  let userId;
  try {
    const payload = jwt.verify(match[1], env.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string"
    ) {
      return response.status(401).json({ error: "Jeton invalide." });
    }
    userId = payload.sub;
    request.authMethod =
      typeof payload.auth_method === "string" ? payload.auth_method : null;
  } catch {
    return response.status(401).json({ error: "Jeton invalide ou expiré." });
  }

  try {
    const account = await pool.query(
      `SELECT suspended_until FROM users WHERE id = $1`,
      [userId],
    );
    if (!account.rowCount) {
      return response.status(401).json({ error: "Compte introuvable." });
    }
    if (
      !allowSuspended &&
      account.rows[0].suspended_until &&
      new Date(account.rows[0].suspended_until).getTime() > Date.now()
    ) {
      return response.status(403).json({
        error: "Ce compte est suspendu. Contactez l'assistance si vous souhaitez contester cette décision.",
      });
    }
    request.auth = {
      userId,
      ...(request.authMethod ? { authMethod: request.authMethod } : {}),
    };
    request.user = { id: userId };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const authMiddleware = createAuthMiddleware();
export const authMiddlewareAllowSuspended = createAuthMiddleware({
  allowSuspended: true,
});
