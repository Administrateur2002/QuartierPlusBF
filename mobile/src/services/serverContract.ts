import { API_BASE_URL } from "./api";

export const EXPECTED_API_CONTRACT_VERSION = 2;

export type ServerHealth = {
  status: string;
  commit: string;
  contractVersion: number;
  startedAt: string | null;
  lastMigration: { version: string; applied_at: string } | null;
};

let healthPromise: Promise<ServerHealth | null> | null = null;
let serverHealth: ServerHealth | null = null;
let lastHealthCheckAt = 0;
let isUpdating = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export const getServerHealth = () => serverHealth;
export const isServerUpdating = () => isUpdating;

export const subscribeToServerHealth = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const checkServerContract = async (): Promise<ServerHealth | null> => {
  if (!API_BASE_URL) return null;
  if (Date.now() - lastHealthCheckAt < 60_000) return serverHealth;
  if (healthPromise) return healthPromise;

  healthPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("status" in payload)) {
        return null;
      }
      if (typeof payload.status !== "string") return null;
      const contractVersion =
        "contractVersion" in payload &&
        typeof payload.contractVersion === "number"
          ? payload.contractVersion
          : 0;
      const migration = "lastMigration" in payload ? payload.lastMigration : null;
      const lastMigration =
        typeof migration === "object" &&
        migration !== null &&
        "version" in migration &&
        typeof migration.version === "string" &&
        "applied_at" in migration &&
        typeof migration.applied_at === "string"
          ? { version: migration.version, applied_at: migration.applied_at }
          : null;
      serverHealth = {
        status: payload.status,
        commit:
          "commit" in payload && typeof payload.commit === "string"
            ? payload.commit
            : "unknown",
        contractVersion,
        startedAt:
          "startedAt" in payload && typeof payload.startedAt === "string"
            ? payload.startedAt
            : null,
        lastMigration,
      };
      isUpdating =
        serverHealth.status === "ok" &&
        serverHealth.contractVersion < EXPECTED_API_CONTRACT_VERSION;
      notify();
      return serverHealth;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      lastHealthCheckAt = Date.now();
    }
  })().finally(() => {
    healthPromise = null;
  });
  return healthPromise;
};

export const ensureServerContract = async () => {
  const health = await checkServerContract();
  if (
    health &&
    health.contractVersion < EXPECTED_API_CONTRACT_VERSION
  ) {
    throw new Error("Le serveur est en cours de mise à jour.");
  }
};
