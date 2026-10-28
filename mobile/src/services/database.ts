import * as SQLite from "expo-sqlite";

const DATABASE_NAME = "quartierplus-offline.db";
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let database: SQLite.SQLiteDatabase | null = null;
let operationQueue: Promise<void> = Promise.resolve();
let lockErrors = 0;

const schema = `
  CREATE TABLE IF NOT EXISTS cached_posts (
    id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cached_alerts (
    id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cached_messages (
    thread_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_key, message_id)
  );
  CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    action_type TEXT NOT NULL
      CHECK (action_type IN ('create_post', 'trigger_sos')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS query_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_preferences (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

const profileSchema = `
  CREATE TABLE IF NOT EXISTS profile_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trusted_contacts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    position INTEGER NOT NULL
  );
`;

export const ensureProfileStorageSchema = (
  database: SQLite.SQLiteDatabase,
) => database.execAsync(profileSchema);

const openAndInitialize = async () => {
  const opened = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    await opened.execAsync(
      `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`,
    );
    await opened.execAsync(schema);
    await ensureProfileStorageSchema(opened);
    await opened.runAsync(
      "UPDATE sync_queue SET status = 'pending' WHERE status = 'processing'",
    );
    database = opened;
  } catch (error) {
    await opened.closeAsync();
    throw error;
  }
};

const isLockError = (error: unknown) =>
  /locked|no transaction/i.test(
    error instanceof Error ? error.message : String(error),
  );

const resetDatabase = async () => {
  try {
    await database?.closeAsync();
    database = null;
    await SQLite.deleteDatabaseAsync(DATABASE_NAME);
    await openAndInitialize();
  } catch (error) {
    databasePromise = null;
    throw error;
  }
};

const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = operationQueue.then(async () => {
    try {
      const value = await operation();
      lockErrors = 0;
      return value;
    } catch (error) {
      if (isLockError(error)) {
        lockErrors += 1;
        if (lockErrors >= 3) {
          lockErrors = 0;
          await resetDatabase();
        }
      }
      throw error;
    }
  });
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const sharedDatabase = new Proxy({} as SQLite.SQLiteDatabase, {
  get(_target, property) {
    if (property === "withExclusiveTransactionAsync") {
      return (task: Parameters<SQLite.SQLiteDatabase["withExclusiveTransactionAsync"]>[0]) =>
        enqueue(async () => {
          const current = database;
          if (!current) throw new Error("La base SQLite partagée n'est pas initialisée.");
          return current.withExclusiveTransactionAsync((transaction) =>
            task(transaction),
          );
        });
    }
    if (
      property === "runAsync" ||
      property === "execAsync" ||
      property === "getFirstAsync" ||
      property === "getAllAsync"
    ) {
      return (...args: unknown[]) =>
        enqueue(async () => {
          const current = database;
          if (!current) throw new Error("La base SQLite partagée n'est pas initialisée.");
          const method = Reflect.get(current, property, current) as (
            ...parameters: unknown[]
          ) => Promise<unknown>;
          return method.apply(current, args);
        });
    }
    const current = database;
    if (!current) {
      throw new Error("La base SQLite partagée n'est pas initialisée.");
    }
    const value = Reflect.get(current, property, current) as unknown;
    return typeof value === "function" ? value.bind(current) : value;
  },
});

export const getSharedDatabase = () => {
  if (!databasePromise) {
    databasePromise = openAndInitialize()
      .then(() => sharedDatabase)
      .catch((error: unknown) => {
        databasePromise = null;
        throw error;
      });
  }
  return databasePromise;
};

export const initializeSharedDatabase = async (): Promise<void> => {
  await getSharedDatabase();
};
