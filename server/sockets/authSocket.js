import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export const readSocketToken = (socket) => {
  const auth = socket.handshake.auth ?? {};
  const authorization =
    typeof auth.authorization === "string"
      ? auth.authorization
      : socket.handshake.headers.authorization;
  const token =
    typeof auth.token === "string"
      ? auth.token
      : typeof auth.accessToken === "string"
        ? auth.accessToken
        : typeof authorization === "string"
          ? authorization.replace(/^Bearer\s+/i, "")
          : "";
  return token.trim();
};

export const authenticateSocket = async (socket, next) => {
  const token = readSocketToken(socket);
  if (!token) {
    return next(new Error("Authentification requise."));
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string"
    ) {
      return next(new Error("Jeton invalide."));
    }
    const result = await pool.query(
      `SELECT id, full_name, role, profile_photo_url, badge, suspended_until
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );
    if (result.rowCount === 0) {
      return next(new Error("Compte utilisateur introuvable."));
    }
    if (
      result.rows[0].suspended_until &&
      new Date(result.rows[0].suspended_until).getTime() > Date.now()
    ) {
      return next(new Error("Ce compte est suspendu."));
    }
    socket.data.user = result.rows[0];
    return next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return next(new Error("Jeton invalide ou expiré."));
    }
    return next(error);
  }
};
