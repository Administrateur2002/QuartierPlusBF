import axios from "axios";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getApiErrorMessage = (error: unknown, fallback: string) => {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback;
  }

  const responseData: unknown = error.response?.data;
  if (isRecord(responseData)) {
    for (const key of ["reason", "message", "error"]) {
      if (typeof responseData[key] === "string" && responseData[key].trim()) {
        return responseData[key].trim();
      }
    }
    if (Array.isArray(responseData.errors)) {
      const messages = responseData.errors.flatMap((entry) =>
        isRecord(entry) && typeof entry.message === "string" && entry.message.trim()
          ? [entry.message.trim()]
          : [],
      );
      if (messages.length) return [...new Set(messages)].join(" ");
    }
  }
  if (error.response) return `${fallback} (HTTP ${error.response.status}).`;
  if (error.code === "ERR_NETWORK") return `${fallback} Vérifiez la connexion réseau.`;
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return `${fallback} Le délai de réponse du serveur est dépassé.`;
  }
  return error.message || fallback;
};
