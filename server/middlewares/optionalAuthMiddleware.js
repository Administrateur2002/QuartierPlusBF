import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const optionalAuthMiddleware = (request, _response, next) => {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return next();
  try {
    const payload = jwt.verify(match[1], env.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (typeof payload !== "string" && typeof payload.sub === "string") {
      request.auth = { userId: payload.sub };
      request.user = { id: payload.sub };
    }
  } catch {
    // Public feed remains available when an optional session has expired.
  }
  return next();
};
