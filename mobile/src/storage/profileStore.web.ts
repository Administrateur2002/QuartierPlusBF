import type {
  ProfileStore,
  AppPreferences,
  StoredCountry,
  TrustedContact,
} from "./profileStore";

const COUNTRY_KEY = "quartierplus.profile.active-country";
const CONTACTS_KEY = "quartierplus.profile.trusted-contacts";
const PREFERENCES_KEY = "quartierplus.profile.preferences";
const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "system",
  language: "fr",
  sosNotificationsEnabled: true,
  sosNotificationsPriority: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  defaultRadiusKm: 3,
  voiceAssistantFloatingButton: false,
  rememberFeedLocation: true,
};

export const openProfileStore = async (): Promise<ProfileStore> => ({
  isMemoryFallback: false,
  async getCountry() {
    const saved = globalThis.localStorage.getItem(COUNTRY_KEY);
    if (!saved) return null;
    const country = JSON.parse(saved) as StoredCountry;
    return country &&
      typeof country.code === "string" &&
      typeof country.emergencyNumbers?.police === "string" &&
      typeof country.emergencyNumbers?.fire === "string" &&
      typeof country.emergencyNumbers?.medical === "string"
      ? country
      : null;
  },
  async setCountry(country: StoredCountry) {
    globalThis.localStorage.setItem(COUNTRY_KEY, JSON.stringify(country));
  },
  async getContacts() {
    const stored = globalThis.localStorage.getItem(CONTACTS_KEY);
    if (!stored) return [];
    const contacts = JSON.parse(stored) as TrustedContact[];
    if (!Array.isArray(contacts)) {
      throw new Error("Les contacts enregistrés localement sont invalides.");
    }
    return contacts;
  },
  async saveContact(contact: TrustedContact) {
    const stored = globalThis.localStorage.getItem(CONTACTS_KEY);
    const contacts = stored ? (JSON.parse(stored) as TrustedContact[]) : [];
    const updated = contacts.some((entry) => entry.id === contact.id)
      ? contacts.map((entry) => (entry.id === contact.id ? contact : entry))
      : [...contacts, contact];
    globalThis.localStorage.setItem(CONTACTS_KEY, JSON.stringify(updated));
  },
  async deleteContact(id: string, remainingContacts: TrustedContact[]) {
    globalThis.localStorage.setItem(
      CONTACTS_KEY,
      JSON.stringify(remainingContacts.filter((entry) => entry.id !== id)),
    );
  },
  async getPreferences() {
    const saved = globalThis.localStorage.getItem(PREFERENCES_KEY);
    if (!saved) return DEFAULT_PREFERENCES;
    const value = JSON.parse(saved) as Partial<AppPreferences>;
    return {
      theme:
        value.theme === "dark" || value.theme === "system"
          ? value.theme
          : "light",
      language: value.language === "en" ? "en" : "fr",
      sosNotificationsEnabled: value.sosNotificationsEnabled !== false,
      sosNotificationsPriority: value.sosNotificationsPriority !== false,
      quietHoursStart:
        typeof value.quietHoursStart === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value.quietHoursStart)
          ? value.quietHoursStart
          : "22:00",
      quietHoursEnd:
        typeof value.quietHoursEnd === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value.quietHoursEnd)
          ? value.quietHoursEnd
          : "07:00",
      defaultRadiusKm:
        value.defaultRadiusKm === 10 || value.defaultRadiusKm === 30
          ? value.defaultRadiusKm
          : 3,
      voiceAssistantFloatingButton:
        value.voiceAssistantFloatingButton === true,
      rememberFeedLocation: value.rememberFeedLocation !== false,
    };
  },
  async setPreferences(preferences: AppPreferences) {
    globalThis.localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify(preferences),
    );
  },
});
