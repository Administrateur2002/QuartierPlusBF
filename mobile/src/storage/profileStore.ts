import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import {
  ensureProfileStorageSchema,
  getSharedDatabase,
} from "../services/database";

export type EmergencyNumbers = {
  police: string;
  fire: string;
  medical: string;
};

export type TrustedContact = {
  id: string;
  name: string;
  phone: string;
  position: number;
};

export type StoredCountry = {
  code: string;
  emergencyNumbers: EmergencyNumbers;
};

export type AppPreferences = {
  theme: "light" | "dark" | "system";
  language: "fr" | "en";
  sosNotificationsEnabled: boolean;
  sosNotificationsPriority: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultRadiusKm: 3 | 10 | 30;
  voiceAssistantFloatingButton: boolean;
  rememberFeedLocation: boolean;
};

export type ProfileStore = {
  readonly isMemoryFallback: boolean;
  getCountry: () => Promise<StoredCountry | null>;
  setCountry: (country: StoredCountry) => Promise<void>;
  getContacts: () => Promise<TrustedContact[]>;
  saveContact: (contact: TrustedContact) => Promise<void>;
  deleteContact: (
    id: string,
    remainingContacts: TrustedContact[],
  ) => Promise<void>;
  getPreferences: () => Promise<AppPreferences>;
  setPreferences: (preferences: AppPreferences) => Promise<void>;
};

const LEGACY_DATABASE_NAME = "quartierplus-profile.db";
const PREVIOUS_DATABASE_NAME = "quartierplus.db";
const PREFERENCES_FALLBACK_KEY = "quartierplus.profile.preferences";
const defaultPreferences = (): AppPreferences => ({
  theme: "system",
  language: "fr",
  sosNotificationsEnabled: true,
  sosNotificationsPriority: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  defaultRadiusKm: 3,
  voiceAssistantFloatingButton: false,
  rememberFeedLocation: true,
});
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let memoryCountry: StoredCountry | null = null;
let memoryContacts: TrustedContact[] = [];
let memoryPreferences = defaultPreferences();
let usingMemoryFallback = false;
let memoryFallbackDiagnostic: string | null = null;

const describeStorageFailure = (error: unknown) => {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const code =
    typeof record?.code === "string" || typeof record?.code === "number"
      ? String(record.code)
      : "SQLITE_INITIALIZATION_FAILED";
  const message =
    error instanceof Error
      ? error.message
      : record && typeof record.message === "string"
        ? record.message
        : String(error);
  return `Module : expo-sqlite\nCode : ${code}\nMessage : ${message.slice(0, 300)}`;
};

export const getProfileStorageDiagnostic = () =>
  memoryFallbackDiagnostic ??
  "Module : expo-sqlite\nCode : SQLITE_INITIALIZATION_FAILED\nMessage : détail indisponible.";

const hasTable = async (database: SQLite.SQLiteDatabase, name: string) => {
  const table = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = ?",
    name,
  );
  return Boolean(table);
};

const openProfileDatabase = () => {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    const database = await getSharedDatabase();
    await ensureProfileStorageSchema(database);
    const migrated = await database.getFirstAsync<{ value: string }>(
      "SELECT value FROM profile_settings WHERE key = 'legacy_store_migrated'",
    );
    if (migrated) return database;

    let activeCountry: { value: string } | null = null;
    const contacts = new Map<string, TrustedContact>();
    for (const name of [PREVIOUS_DATABASE_NAME, LEGACY_DATABASE_NAME]) {
      const legacyPath = `${SQLite.defaultDatabaseDirectory}/${name}`;
      await database.execAsync(
        `ATTACH DATABASE '${legacyPath.replaceAll("'", "''")}' AS legacy`,
      );
      try {
        const legacySettingsExist = await hasTable(database, "profile_settings");
        const legacyContactsExist = await hasTable(database, "trusted_contacts");
        if (!activeCountry && legacySettingsExist) {
          activeCountry = await database.getFirstAsync<{ value: string }>(
            "SELECT value FROM legacy.profile_settings WHERE key = 'active_country'",
          );
        }
        if (legacyContactsExist) {
          const legacyContacts = await database.getAllAsync<TrustedContact>(
            "SELECT id, name, phone, position FROM legacy.trusted_contacts ORDER BY position",
          );
          for (const contact of legacyContacts) {
            contacts.set(contact.id, contact);
          }
        }
      } finally {
        await database.execAsync("DETACH DATABASE legacy");
      }
    }

    await database.withExclusiveTransactionAsync(async (transaction) => {
      if (activeCountry) {
        await transaction.runAsync(
          `INSERT INTO profile_settings (key, value)
           VALUES ('active_country', ?)
           ON CONFLICT(key) DO NOTHING`,
          activeCountry.value,
        );
      }
      for (const contact of contacts.values()) {
        await transaction.runAsync(
          `INSERT INTO trusted_contacts (id, name, phone, position)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          contact.id,
          contact.name,
          contact.phone,
          contact.position,
        );
      }
      await transaction.runAsync(
        `INSERT INTO profile_settings (key, value)
         VALUES ('legacy_store_migrated', 'true')
         ON CONFLICT(key) DO NOTHING`,
      );
    });
    return database;
  })().catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
};

const createMemoryProfileStore = (): ProfileStore => ({
  isMemoryFallback: true,
  async getCountry() {
    return memoryCountry;
  },
  async setCountry(country) {
    memoryCountry = country;
  },
  async getContacts() {
    return [...memoryContacts];
  },
  async saveContact(contact) {
    memoryContacts = memoryContacts.some((entry) => entry.id === contact.id)
      ? memoryContacts.map((entry) => (entry.id === contact.id ? contact : entry))
      : [...memoryContacts, contact];
  },
  async deleteContact(id, remainingContacts) {
    memoryContacts = remainingContacts.filter((entry) => entry.id !== id);
  },
  async getPreferences() {
    return memoryPreferences;
  },
  async setPreferences(preferences) {
    memoryPreferences = normalizePreferences(preferences);
  },
});

const reportProfileStorageFailure = (operation: string, error: unknown) => {
  usingMemoryFallback = true;
  memoryFallbackDiagnostic = describeStorageFailure(error);
  console.error(`Profile storage ${operation} failed; using memory fallback:`, error);
};

const retryProfileOperation = async <T>(
  operationName: string,
  operation: () => Promise<T>,
) => {
  try {
    return await operation();
  } catch (error) {
    console.warn(`Retrying local profile storage ${operationName}:`, error);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return operation();
  }
};

export const openProfileStore = async (): Promise<ProfileStore> => {
  let database: SQLite.SQLiteDatabase | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      database = await openProfileDatabase();
      break;
    } catch (error) {
      memoryFallbackDiagnostic = describeStorageFailure(error);
      console.error(
        `Unable to initialize the local profile store (attempt ${attempt}/3):`,
        error,
      );
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }
  }
  if (!database) {
    usingMemoryFallback = true;
    console.error(
      "Local profile storage is unavailable after three attempts; using in-memory data.",
    );
    return createMemoryProfileStore();
  }
  const initializedDatabase = database;
  usingMemoryFallback = false;
  memoryFallbackDiagnostic = null;
  return {
    get isMemoryFallback() {
      return usingMemoryFallback;
    },
    async getCountry() {
      try {
        const saved = await retryProfileOperation("country read", () =>
          initializedDatabase.getFirstAsync<{ value: string }>(
            "SELECT value FROM profile_settings WHERE key = 'active_country'",
          ),
        );
        memoryCountry = saved ? (JSON.parse(saved.value) as StoredCountry) : null;
        return memoryCountry;
      } catch (error) {
        reportProfileStorageFailure("country read", error);
        return memoryCountry;
      }
    },
    async setCountry(country) {
      memoryCountry = country;
      try {
        await retryProfileOperation("country write", () =>
          initializedDatabase.runAsync(
            `INSERT INTO profile_settings (key, value)
         VALUES ('active_country', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            JSON.stringify(country),
          ),
        );
      } catch (error) {
        reportProfileStorageFailure("country write", error);
      }
    },
    async getContacts() {
      try {
        memoryContacts = await retryProfileOperation("trusted contacts read", () =>
          initializedDatabase.getAllAsync<TrustedContact>(
            "SELECT id, name, phone, position FROM trusted_contacts ORDER BY position",
          ),
        );
        return [...memoryContacts];
      } catch (error) {
        reportProfileStorageFailure("trusted contacts read", error);
        return [...memoryContacts];
      }
    },
    async saveContact(contact) {
      memoryContacts = memoryContacts.some((entry) => entry.id === contact.id)
        ? memoryContacts.map((entry) => (entry.id === contact.id ? contact : entry))
        : [...memoryContacts, contact];
      try {
        await retryProfileOperation("trusted contact write", () =>
          initializedDatabase.runAsync(
            `INSERT INTO trusted_contacts (id, name, phone, position)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           phone = excluded.phone,
           position = excluded.position`,
            contact.id,
            contact.name,
            contact.phone,
            contact.position,
          ),
        );
      } catch (error) {
        reportProfileStorageFailure("trusted contact write", error);
      }
    },
    async deleteContact(id, remainingContacts) {
      memoryContacts = remainingContacts.filter((entry) => entry.id !== id);
      try {
        await retryProfileOperation("trusted contact deletion", () =>
          initializedDatabase.withExclusiveTransactionAsync(async (transaction) => {
            await transaction.runAsync("DELETE FROM trusted_contacts WHERE id = ?", id);
            for (const contact of remainingContacts) {
              await transaction.runAsync(
                "UPDATE trusted_contacts SET position = ? WHERE id = ?",
                contact.position,
                contact.id,
              );
            }
          }),
        );
      } catch (error) {
        reportProfileStorageFailure("trusted contact deletion", error);
      }
    },
    async getPreferences() {
      let rows: { key: string; value: string }[];
      try {
        rows = await retryProfileOperation("preference read", () =>
          initializedDatabase.getAllAsync<{ key: string; value: string }>(
            "SELECT key, value FROM app_preferences",
          ),
        );
      } catch (error) {
        reportProfileStorageFailure("preference read", error);
        let fallback: string | null;
        try {
          const { default: AsyncStorage } = await import(
            "@react-native-async-storage/async-storage"
          );
          fallback = await AsyncStorage.getItem(PREFERENCES_FALLBACK_KEY);
        } catch (asyncStorageError) {
          try {
            fallback = await SecureStore.getItemAsync(PREFERENCES_FALLBACK_KEY);
          } catch (secureStoreError) {
            reportProfileStorageFailure("preference fallback read", {
              sqliteError: error,
              asyncStorageError,
              secureStoreError,
            });
            return memoryPreferences;
          }
        }
        if (!fallback) return memoryPreferences;
        try {
          memoryPreferences = normalizePreferences(JSON.parse(fallback));
          return memoryPreferences;
        } catch (fallbackError) {
          reportProfileStorageFailure("preference fallback read", fallbackError);
          return memoryPreferences;
        }
      }
      const values = new Map(rows.map((row) => [row.key, row.value]));
      memoryPreferences = normalizePreferences({
        theme: values.get("theme"),
        language: values.get("language"),
        sosNotificationsEnabled: values.get("sos_notifications") !== "false",
        sosNotificationsPriority: values.get("sos_notifications_priority") !== "false",
        quietHoursStart: values.get("quiet_hours_start") ?? "22:00",
        quietHoursEnd: values.get("quiet_hours_end") ?? "07:00",
        defaultRadiusKm: Number(values.get("default_radius_km")),
        voiceAssistantFloatingButton:
          values.get("voice_assistant_floating_button") === "true",
        rememberFeedLocation:
          values.get("remember_feed_location") !== "false",
      });
      return memoryPreferences;
    },
    async setPreferences(preferences) {
      memoryPreferences = normalizePreferences(preferences);
      const entries: [string, string][] = [
        ["theme", preferences.theme],
        ["language", preferences.language],
        ["sos_notifications", String(preferences.sosNotificationsEnabled)],
        ["sos_notifications_priority", String(preferences.sosNotificationsPriority)],
        ["quiet_hours_start", preferences.quietHoursStart],
        ["quiet_hours_end", preferences.quietHoursEnd],
        ["default_radius_km", String(preferences.defaultRadiusKm)],
        [
          "voice_assistant_floating_button",
          String(preferences.voiceAssistantFloatingButton),
        ],
        ["remember_feed_location", String(preferences.rememberFeedLocation)],
      ];
      try {
        await retryProfileOperation("preference write", () =>
          initializedDatabase.withExclusiveTransactionAsync(async (transaction) => {
            for (const [key, value] of entries) {
              await transaction.runAsync(
                `INSERT INTO app_preferences (key, value)
               VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                key,
                value,
              );
            }
          }),
        );
      } catch (error) {
        reportProfileStorageFailure("preference write", error);
        try {
          const { default: AsyncStorage } = await import(
            "@react-native-async-storage/async-storage"
          );
          await AsyncStorage.setItem(
            PREFERENCES_FALLBACK_KEY,
            JSON.stringify(preferences),
          );
        } catch (fallbackError) {
          try {
            await SecureStore.setItemAsync(
              PREFERENCES_FALLBACK_KEY,
              JSON.stringify(preferences),
            );
          } catch (secureStoreError) {
            reportProfileStorageFailure("preference write", {
              sqliteError: error,
              asyncStorageError: fallbackError,
              secureStoreError,
            });
          }
        }
      }
    },
  };
};

const normalizePreferences = (value: unknown): AppPreferences => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultPreferences();
  }
  const preferences = value as Partial<AppPreferences>;
  const radius = Number(preferences.defaultRadiusKm);
  return {
    theme:
      preferences.theme === "dark" || preferences.theme === "system"
        ? preferences.theme
        : preferences.theme === "light"
          ? "light"
          : defaultPreferences().theme,
    language: preferences.language === "en" ? "en" : "fr",
    sosNotificationsEnabled: preferences.sosNotificationsEnabled !== false,
    sosNotificationsPriority: preferences.sosNotificationsPriority !== false,
    quietHoursStart:
      typeof preferences.quietHoursStart === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursStart)
        ? preferences.quietHoursStart
        : "22:00",
    quietHoursEnd:
      typeof preferences.quietHoursEnd === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursEnd)
        ? preferences.quietHoursEnd
        : "07:00",
    defaultRadiusKm: radius === 10 || radius === 30 ? radius : 3,
    voiceAssistantFloatingButton:
      preferences.voiceAssistantFloatingButton === true,
    rememberFeedLocation: preferences.rememberFeedLocation !== false,
  };
};
