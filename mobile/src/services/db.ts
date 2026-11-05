import * as SQLite from "expo-sqlite";
import { getSharedDatabase, initializeSharedDatabase } from "./database";

export type QueueStatus = "pending" | "processing" | "failed";
export type SyncActionType =
  | "create_post"
  | "trigger_sos"
  | "toggle_post_like"
  | "create_post_comment"
  | "create_feed_post";
export type SyncAction = {
  id: number;
  ownerId?: string;
  actionType: SyncActionType;
  payload: Record<string, unknown>;
  status: QueueStatus;
  createdAt: string;
  attempts: number;
};

const getDatabase = getSharedDatabase;
const memoryCollections = new Map<string, unknown[]>();
const memoryMessages = new Map<string, unknown[]>();
const memoryApiCache = new Map<string, unknown>();
const memoryQueue: SyncAction[] = [];
let nextMemoryQueueId = -1;
let memoryQueryClient: unknown;

const logCacheFailure = (error: unknown) => {
  console.warn("Cache SQLite indisponible.", error);
};

const logMemoryFallback = (operation: string, error: unknown) => {
  console.warn(`Stockage en mémoire utilisé pour ${operation}.`, error);
};

const saveCollection = async (
  table: "cached_posts" | "cached_alerts",
  entries: unknown[],
) => {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Entrée invalide pour ${table}.`);
      }
      const id = (entry as Record<string, unknown>).id;
      if (typeof id !== "string" && typeof id !== "number") {
        throw new Error(`Chaque entrée ${table} doit avoir un identifiant.`);
      }
      await transaction.runAsync(
        `INSERT INTO ${table} (id, payload, cached_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           cached_at = CURRENT_TIMESTAMP`,
        String(id),
        JSON.stringify(entry),
      );
    }
    await transaction.execAsync(
      `DELETE FROM ${table}
       WHERE id NOT IN (
         SELECT id FROM ${table}
         ORDER BY cached_at DESC
         LIMIT 500
       )`,
    );
  });
};

const loadCollection = async <T>(
  table: "cached_posts" | "cached_alerts",
): Promise<T[]> => {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ payload: string }>(
    `SELECT payload FROM ${table} ORDER BY cached_at DESC`,
  );
  return rows.map((row) => JSON.parse(row.payload) as T);
};

export const initializeDatabase = async (): Promise<void> => {
  try {
    await initializeSharedDatabase();
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("le stockage local", error);
  }
};

export const cachePosts = (posts: unknown[]) =>
  saveCollection("cached_posts", posts).catch((error: unknown) => {
    logCacheFailure(error);
    logMemoryFallback("les publications en cache", error);
    memoryCollections.set("cached_posts", [...posts]);
  });

export const getCachedPosts = <T = unknown>() =>
  loadCollection<T>("cached_posts").catch((error: unknown) => {
    logCacheFailure(error);
    logMemoryFallback("la lecture des publications en cache", error);
    return (memoryCollections.get("cached_posts") ?? []) as T[];
  });

export const cacheAlerts = (alerts: unknown[]) =>
  saveCollection("cached_alerts", alerts).catch((error: unknown) => {
    logCacheFailure(error);
    logMemoryFallback("les alertes en cache", error);
    memoryCollections.set("cached_alerts", [...alerts]);
  });

export const getCachedAlerts = <T = unknown>() =>
  loadCollection<T>("cached_alerts").catch((error: unknown) => {
    logCacheFailure(error);
    logMemoryFallback("la lecture des alertes en cache", error);
    return (memoryCollections.get("cached_alerts") ?? []) as T[];
  });

export const cacheMessages = async (
  threadKey: string,
  messages: unknown[],
): Promise<void> => {
  if (!threadKey.trim()) throw new Error("La conversation à mettre en cache est invalide.");
  try {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("Un message à mettre en cache est invalide.");
        }
        const id = (message as Record<string, unknown>).id;
        if (typeof id !== "string" && typeof id !== "number") {
          throw new Error("Chaque message mis en cache doit avoir un identifiant.");
        }
        await transaction.runAsync(
          `INSERT INTO cached_messages (thread_key, message_id, payload, cached_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(thread_key, message_id) DO UPDATE SET
             payload = excluded.payload,
             cached_at = CURRENT_TIMESTAMP`,
          threadKey,
          String(id),
          JSON.stringify(message),
        );
      }
      await transaction.runAsync(
        `DELETE FROM cached_messages
         WHERE thread_key = ? AND message_id NOT IN (
           SELECT message_id FROM cached_messages
           WHERE thread_key = ?
           ORDER BY cached_at DESC
           LIMIT 100
         )`,
        threadKey,
        threadKey,
      );
    });
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("les messages en cache", error);
    memoryMessages.set(threadKey, [...messages]);
  }
};

export const getCachedMessages = async <T>(
  threadKey: string,
): Promise<T[]> => {
  try {
    const database = await getDatabase();
    const rows = await database.getAllAsync<{ payload: string }>(
      `SELECT payload FROM cached_messages
       WHERE thread_key = ? ORDER BY cached_at ASC`,
      threadKey,
    );
    return rows.map((row) => JSON.parse(row.payload) as T);
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la lecture des messages en cache", error);
    return (memoryMessages.get(threadKey) ?? []) as T[];
  }
};

export const clearCachedMessages = async (ownerId: string): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.runAsync(
      "DELETE FROM cached_messages WHERE thread_key LIKE ?",
      `user:${encodeURIComponent(ownerId)}:%`,
    );
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la suppression des messages en cache", error);
    for (const key of memoryMessages.keys()) {
      if (key.startsWith(`user:${encodeURIComponent(ownerId)}:`)) {
        memoryMessages.delete(key);
      }
    }
  }
};

export const getApiCache = async <T>(cacheKey: string): Promise<T | null> => {
  try {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ payload: string }>(
      "SELECT payload FROM api_cache WHERE cache_key = ?",
      cacheKey,
    );
    return row ? (JSON.parse(row.payload) as T) : null;
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la lecture du cache API", error);
    return (memoryApiCache.get(cacheKey) as T | undefined) ?? null;
  }
};

export const setApiCache = async (
  cacheKey: string,
  payload: unknown,
): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO api_cache (cache_key, payload, cached_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload = excluded.payload,
           cached_at = CURRENT_TIMESTAMP`,
        cacheKey,
        JSON.stringify(payload),
      );
      await transaction.execAsync(`
        DELETE FROM api_cache
        WHERE cache_key NOT IN (
          SELECT cache_key FROM api_cache
          ORDER BY cached_at DESC
          LIMIT 200
        )
      `);
    });
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("le cache API", error);
    memoryApiCache.set(cacheKey, payload);
  }
};

export const clearApiCache = async (): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.execAsync("DELETE FROM api_cache");
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la suppression du cache API", error);
    memoryApiCache.clear();
  }
};

export const enqueueOfflineAction = async (
  actionType: SyncActionType,
  ownerId: string,
  payload: Record<string, unknown>,
): Promise<number> => {
  try {
    const database = await getDatabase();
    const result = await database.runAsync(
      "INSERT INTO sync_queue (owner_id, action_type, payload, status) VALUES (?, ?, ?, 'pending')",
      ownerId,
      actionType,
      JSON.stringify(payload),
    );
    return result.lastInsertRowId;
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la file d'actions hors ligne", error);
    const id = nextMemoryQueueId++;
    memoryQueue.push({
      id,
      ownerId,
      actionType,
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      attempts: 0,
    });
    return id;
  }
};

export const getPendingActions = async (ownerId: string): Promise<SyncAction[]> => {
  try {
    const database = await getDatabase();
    const rows = await database.getAllAsync<{
      id: number;
      action_type: SyncActionType;
      payload: string;
      status: QueueStatus;
      created_at: string;
      attempts: number;
    }>(
      `SELECT id, action_type, payload, status, created_at, attempts
       FROM sync_queue
       WHERE owner_id = ? AND status IN ('pending', 'failed')
       ORDER BY id`,
      ownerId,
    );
    return [
      ...rows.map((row) => ({
        id: row.id,
        actionType: row.action_type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        status: row.status,
        createdAt: row.created_at,
        attempts: row.attempts,
      })),
      ...memoryQueue.filter((action) =>
        action.ownerId === ownerId &&
        ["pending", "failed"].includes(action.status),
      ),
    ];
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la lecture de la file hors ligne", error);
    return memoryQueue.filter((action) =>
      action.ownerId === ownerId &&
      ["pending", "failed"].includes(action.status),
    );
  }
};

export const updateSyncAction = async (
  id: number,
  status: QueueStatus,
): Promise<void> => {
  try {
    const database = await getDatabase();
    const result = await database.runAsync(
      `UPDATE sync_queue
     SET status = ?,
         attempts = attempts + CASE WHEN ? = 'processing' THEN 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      status,
      status,
      id,
    );
    if (result.changes === 1) return;
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la mise à jour de la file hors ligne", error);
  }
  const action = memoryQueue.find((entry) => entry.id === id);
  if (!action) throw new Error(`L'action hors ligne ${id} n'existe pas.`);
  action.status = status;
  if (status === "processing") action.attempts += 1;
};

export const removeSyncAction = async (id: number): Promise<void> => {
  try {
    const database = await getDatabase();
    const result = await database.runAsync("DELETE FROM sync_queue WHERE id = ?", id);
    if (result.changes === 1) return;
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la suppression de la file hors ligne", error);
  }
  const index = memoryQueue.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`L'action hors ligne ${id} n'existe pas.`);
  memoryQueue.splice(index, 1);
};

export const getPersistedQueryClient = async <T>(): Promise<T | undefined> => {
  try {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ payload: string }>(
      "SELECT payload FROM query_cache WHERE id = 1",
    );
    return row ? (JSON.parse(row.payload) as T) : undefined;
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la lecture du cache React Query", error);
    return memoryQueryClient as T | undefined;
  }
};

export const setPersistedQueryClient = async (payload: unknown): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.runAsync(
      `INSERT INTO query_cache (id, payload, updated_at)
       VALUES (1, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = CURRENT_TIMESTAMP`,
      JSON.stringify(payload),
    );
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("le cache React Query", error);
    memoryQueryClient = payload;
  }
};

export const clearPersistedQueryClient = async (): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.runAsync("DELETE FROM query_cache WHERE id = 1");
  } catch (error) {
    logCacheFailure(error);
    logMemoryFallback("la suppression du cache React Query", error);
    memoryQueryClient = undefined;
  }
};

export const clearCachedContent = async (): Promise<void> => {
  try {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(
        `DELETE FROM cached_posts;
         DELETE FROM cached_alerts;
         DELETE FROM cached_messages;
         DELETE FROM api_cache;
         DELETE FROM query_cache;`,
      );
    });
  } catch (error) {
    logCacheFailure(error);
    throw error;
  } finally {
    memoryCollections.clear();
    memoryMessages.clear();
    memoryApiCache.clear();
    memoryQueryClient = undefined;
  }
};

export const clearAccountLocalData = async (ownerId: string): Promise<void> => {
  if (!ownerId.trim()) throw new Error("Le compte local à supprimer est invalide.");
  const failures: unknown[] = [];
  try {
    await clearCachedContent();
  } catch (error) {
    failures.push(error);
  }
  try {
    const database = await getDatabase();
    await database.runAsync(
      "DELETE FROM sync_queue WHERE owner_id = ?",
      ownerId,
    );
  } catch (error) {
    logCacheFailure(error);
    failures.push(error);
  }
  for (let index = memoryQueue.length - 1; index >= 0; index -= 1) {
    if (memoryQueue[index].ownerId === ownerId) memoryQueue.splice(index, 1);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Les données locales du compte n'ont pas toutes été supprimées.");
  }
}
