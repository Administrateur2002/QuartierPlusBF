import { env } from "../config/env.js";

const parseVersion = (value) => {
  if (typeof value !== "string") return null;
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1).map(Number) : null;
};

export const compareVersions = (left, right) => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
};

export const createRuntimeGate = ({
  maintenanceMode,
  minimumAppVersion,
}) => (request, response, next) => {
  if (maintenanceMode) {
    return response.status(503).json({
      error: "QuartierPlus est temporairement en maintenance.",
      code: "MAINTENANCE",
    });
  }
  const versionComparison = compareVersions(
    request.get("x-app-version"),
    minimumAppVersion,
  );
  if (
    minimumAppVersion !== "0.0.0" &&
    (versionComparison === null || versionComparison < 0)
  ) {
    return response.status(426).json({
      error: "Mettez QuartierPlus à jour pour continuer.",
      code: "APP_UPDATE_REQUIRED",
      minimum_app_version: minimumAppVersion,
    });
  }
  return next();
};

export const runtimeGate = createRuntimeGate(env);
