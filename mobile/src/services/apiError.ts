import axios from "axios";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getApiErrorMessage = (error: unknown, fallback: string) => {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  const responseData: unknown = error.response?.data;
  if (isRecord(responseData)) {
    for (const key of ["error", "message"]) {
      if (typeof responseData[key] === "string" && responseData[key].trim()) {
        return responseData[key].trim();
      }
    }
  }
  if (error.response) return `${fallback} (HTTP ${error.response.status}).`;
  if (error.code === "ERR_NETWORK") return `${fallback} Vérifiez la connexion réseau.`;
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return `${fallback} Le délai de réponse du serveur est dépassé.`;
  }
  return error.message || fallback;
};
