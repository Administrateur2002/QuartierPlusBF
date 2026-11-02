import {
  Bell,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Edit3,
  Globe,
  ImagePlus,
  Info,
  Lock,
  LogOut,
  Mic,
  MapPin,
  PhoneCall,
  Settings,
  Shield,
  ShieldCheck,
  Siren,
  Star,
  Trash2,
  User,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import * as Updates from "expo-updates";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import {
  openProfileStore,
  getProfileStorageDiagnostic,
  type AppPreferences,
  type ProfileStore,
  type TrustedContact,
} from "../storage/profileStore";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import VoiceTextInput from "../components/VoiceTextInput";
import ProfileAvatar from "../components/ProfileAvatar";
import { useVoiceAssistant } from "../context/VoiceAssistantContext";
import {
  EMERGENCY_COUNTRIES,
  type EmergencyCountry,
} from "../services/emergencyServices";
import { API_BASE_URL, apiFetch } from "../services/api";
import { uploadProfilePhoto } from "../services/uploadProfilePhoto";
import { clearCachedContent } from "../services/db";
import {
  checkServerContract,
  getServerHealth,
  subscribeToServerHealth,
  type ServerHealth,
} from "../services/serverContract";
import type { RootStackParamList } from "../navigation/types";
import {
  getTechnicalAvailability,
  subscribeToTechnicalAvailability,
} from "../startup/technicalStatus";

type Country = EmergencyCountry;

const COUNTRIES = EMERGENCY_COUNTRIES;
const storageFallbackMessage = () =>
  `Stockage local temporaire en mémoire.\n${getProfileStorageDiagnostic()}`;

const EMERGENCY_SERVICES = [
  { id: "police", name: "Police / Gendarmerie", icon: Shield },
  { id: "fire", name: "Pompiers", icon: Siren },
  { id: "medical", name: "SAMU / Urgences médicales", icon: PhoneCall },
] as const;

type UserProfile = {
  name: string;
  neighborhood: string;
  phoneNumber: string;
  role: "resident" | "relay";
  reputationScore: number | null;
  isVerified: boolean;
  badge: string | null;
  photoUrl: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeProfile = (value: unknown): UserProfile | null => {
  if (!isRecord(value)) return null;
  const user = isRecord(value.user) ? value.user : value;
  const rawRole = String(user.role ?? user.user_type ?? "").toLowerCase();
  const rawScore =
    user.reputation_score ?? user.reputationScore ?? user.score ?? null;
  const score = rawScore === null ? null : Number(rawScore);

  return {
    name: String(user.name ?? user.full_name ?? user.username ?? ""),
    neighborhood: String(
      user.neighborhood ?? user.neighborhood_name ?? user.location ?? "",
    ),
    phoneNumber: String(user.phone_number ?? user.phone ?? ""),
    role:
      rawRole.includes("relay") || rawRole.includes("relais")
        ? "relay"
        : "resident",
    reputationScore:
      score !== null && Number.isFinite(score) ? score : null,
    isVerified: user.is_verified === true || user.isVerified === true,
    badge:
      typeof user.badge === "string" && user.badge.length > 0
        ? user.badge
        : null,
    photoUrl:
      typeof user.profile_photo_url === "string"
        ? user.profile_photo_url
        : null,
  };
};

const ACTIVITIES = [
  { id: "listings", label: "Mes Annonces & Produits", icon: User },
  { id: "services", label: "Mes Services proposés", icon: Settings },
  { id: "alerts", label: "Mes Alertes & Signalements émis", icon: Siren },
] as const;

const PLUS_DESTINATIONS = [
  { screen: "Talkie", label: "Talkie-Walkie" },
  { screen: "Grin", label: "Grin" },
  { screen: "EspacePro", label: "Pro" },
  { screen: "Événements", label: "Événements" },
] as const;

export default function ProfileScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { isOffline, refreshUser, requestAuthentication, signOut, user } = useAuth();
  const { colors, language, setLanguage, setTheme, t, theme } = useTheme();
  const { setFloatingButtonEnabled } = useVoiceAssistant();
  const [selectedCountry, setSelectedCountry] = useState<Country>(COUNTRIES[3]);
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [databaseReady, setDatabaseReady] = useState(false);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const databaseRef = useRef<ProfileStore | null>(null);
  const preferencesChangedRef = useRef(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>({
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
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftNeighborhood, setDraftNeighborhood] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isUploadingProfilePhoto, setIsUploadingProfilePhoto] = useState(false);
  const [editingContact, setEditingContact] =
    useState<TrustedContact | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [isContactModalVisible, setIsContactModalVisible] = useState(false);
  const [isSavingContact, setIsSavingContact] = useState(false);
  const [sosNotificationsEnabled, setSosNotificationsEnabled] = useState(true);
  const [defaultRadius, setDefaultRadius] = useState("5 km");
  const [isPhoneModalVisible, setIsPhoneModalVisible] = useState(false);
  const [draftPhoneNumber, setDraftPhoneNumber] = useState("");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [phoneOtpRequested, setPhoneOtpRequested] = useState(false);
  const [isUpdatingPhone, setIsUpdatingPhone] = useState(false);
  const [aboutVisible, setAboutVisible] = useState(false);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [profilePhotoVisible, setProfilePhotoVisible] = useState(false);
  const [isClearingLocalData, setIsClearingLocalData] = useState(false);
  const [termsVisible, setTermsVisible] = useState(false);
  const [technicalStatus, setTechnicalStatus] = useState(getTechnicalAvailability);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(
    getServerHealth,
  );
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [allies, setAllies] = useState<{
    id: string;
    name: string | null;
    profile_photo_url: string | null;
    badge: string | null;
  }[]>([]);
  const [allyCounters, setAllyCounters] = useState<{
    allies: number;
    received_invitations: number;
    pending_invitations: number;
  } | null>(null);

  useEffect(
    () => subscribeToTechnicalAvailability(() => setTechnicalStatus(getTechnicalAvailability())),
    [],
  );
  useEffect(() => {
    void checkServerContract();
    return subscribeToServerHealth(() => setServerHealth(getServerHealth()));
  }, []);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const database = await openProfileStore();
        const savedCountry = await database.getCountry();
        const savedContacts = await database.getContacts();
        const savedPreferences = await database.getPreferences();
        if (!isMounted) return;
        databaseRef.current = database;
        setContacts(savedContacts);
        if (!preferencesChangedRef.current) {
          setPreferences(savedPreferences);
          setTheme(savedPreferences.theme);
          setLanguage(savedPreferences.language);
        }
        setSosNotificationsEnabled(savedPreferences.sosNotificationsEnabled);
        setDefaultRadius(`${savedPreferences.defaultRadiusKm} km`);
        if (database.isMemoryFallback) {
          const message = storageFallbackMessage();
          setDatabaseError(message);
          Alert.alert(
            "Stockage hors ligne — fallback mémoire",
            message,
          );
        } else {
          setDatabaseError(null);
        }
        if (savedCountry) {
          const country = COUNTRIES.find(
            (entry) => entry.code === savedCountry.code,
          );
          if (country) {
            setSelectedCountry({
              ...country,
              emergencyNumbers: savedCountry.emergencyNumbers,
            });
          }
        }
        setDatabaseReady(true);
      } catch (error) {
        if (!isMounted) return;
        console.error("Local profile storage could not be initialized:", error);
        const message = storageFallbackMessage();
        setDatabaseError(message);
        Alert.alert(
          "Stockage hors ligne — fallback mémoire",
          `${message}\n\nLes publications en ligne restent disponibles.`,
        );
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [isOffline, setLanguage, setTheme]);

  useEffect(() => {
    let active = true;
    if (!user || !API_BASE_URL || isOffline) {
      setAllies([]);
      setAllyCounters(null);
      return () => {
        active = false;
      };
    }
    void apiFetch(`${API_BASE_URL}/v1/social/allies`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Impossible de charger les alliés (HTTP ${response.status}).`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.allies)) {
          throw new Error("La liste des alliés est invalide.");
        }
        if (active) {
          setAllies(payload.allies.filter(
          (ally): ally is {
            id: string;
            name: string | null;
            profile_photo_url: string | null;
            badge: string | null;
          } =>
            isRecord(ally) &&
            typeof ally.id === "string" &&
            (ally.name === null || typeof ally.name === "string") &&
            (ally.profile_photo_url === null || typeof ally.profile_photo_url === "string") &&
            (ally.badge === null || typeof ally.badge === "string"),
          ));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          console.error("Unable to load profile allies:", error);
          setDatabaseError(error instanceof Error ? error.message : "Impossible de charger les alliés.");
        }
      });
    return () => {
      active = false;
    };
  }, [isOffline, user]);

  useEffect(() => {
    let active = true;
    if (!user || !API_BASE_URL || isOffline) {
      setAllyCounters(null);
      return () => {
        active = false;
      };
    }
    void apiFetch(`${API_BASE_URL}/v1/social/allies/counter`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Impossible de charger le Compteur Allié (HTTP ${response.status}).`);
        const payload: unknown = await response.json();
        const counters = isRecord(payload) && isRecord(payload.counters)
          ? payload.counters
          : null;
        if (
          !counters ||
          typeof counters.allies !== "number" ||
          !Number.isSafeInteger(counters.allies) || counters.allies < 0 ||
          typeof counters.received_invitations !== "number" ||
          !Number.isSafeInteger(counters.received_invitations) || counters.received_invitations < 0 ||
          typeof counters.pending_invitations !== "number" ||
          !Number.isSafeInteger(counters.pending_invitations) || counters.pending_invitations < 0
        ) {
          throw new Error("Les compteurs d’alliance sont invalides.");
        }
        if (active) {
          setAllyCounters({
            allies: counters.allies,
            received_invitations: counters.received_invitations,
            pending_invitations: counters.pending_invitations,
          });
        }
      })
      .catch((error: unknown) => {
        if (active) console.error("Unable to load ally counters:", error);
      });
    return () => {
      active = false;
    };
  }, [isOffline, user]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      if (!user) {
        setProfile(null);
        setProfileError(null);
        return;
      }
      if (!API_BASE_URL) {
        setProfileError(
          "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
        );
        return;
      }
      try {
        const response = await apiFetch(`${API_BASE_URL}/v1/users/me`);
        if (!response.ok) {
          throw new Error(`Erreur de chargement du profil (${response.status}).`);
        }
        const normalized = normalizeProfile(await response.json());
        if (!normalized) {
          throw new Error("La réponse du profil est invalide.");
        }
        if (isMounted) {
          setProfile(normalized);
          setDraftName(normalized.name);
          setDraftNeighborhood(normalized.neighborhood);
          setProfileError(null);
        }
      } catch (error) {
        if (!isMounted) return;
        setProfileError(
          error instanceof Error
            ? error.message
            : "Impossible de charger le profil.",
        );
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [user?.badge, user?.id]);

  const selectCountry = async (country: Country) => {
    const database = databaseRef.current;
    if (!database) {
      Alert.alert(
      "Stockage hors ligne — fallback mémoire",
        databaseError ?? "Le stockage local n'est pas prêt.",
      );
      return;
    }
    try {
      await database.setCountry({
        code: country.code,
        emergencyNumbers: country.emergencyNumbers,
      });
      if (database.isMemoryFallback) {
        const message = storageFallbackMessage();
        setDatabaseError(message);
        Alert.alert("Stockage hors ligne — fallback mémoire", message);
      }
      setSelectedCountry(country);
      setCountryMenuOpen(false);
    } catch (error) {
      Alert.alert(
        "Enregistrement impossible",
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer le pays et les numéros hors ligne.",
      );
    }
  };

  const saveProfile = async () => {
    if (!API_BASE_URL) {
      Alert.alert(
        "Enregistrement impossible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    const name = draftName.trim();
    const neighborhood = draftNeighborhood.trim();
    if (!name) {
      Alert.alert("Profil incomplet", "Saisissez votre nom.");
      return;
    }
    setIsSavingProfile(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/users/me`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          neighborhood,
          country_code: selectedCountry.code,
        }),
      });
      if (!response.ok) {
        throw new Error(`Erreur d'enregistrement du profil (${response.status}).`);
      }
      const responseText = await response.text();
      let result: unknown = null;
      if (responseText) {
        try {
          result = JSON.parse(responseText) as unknown;
        } catch {
          throw new Error("La réponse d'enregistrement du profil est invalide.");
        }
      }
      const updatedProfile = normalizeProfile(result) ?? {
        ...(profile ?? {
          role: "resident" as const,
          reputationScore: null,
          isVerified: false,
          phoneNumber: "",
          badge: null,
          photoUrl: null,
        }),
        name,
        neighborhood,
      };
      setProfile(updatedProfile);
      setDraftName(updatedProfile.name);
      setDraftNeighborhood(updatedProfile.neighborhood);
      setIsEditingProfile(false);
      setProfileError(null);
      Alert.alert("Profil enregistré", "Vos informations ont été mises à jour.");
    } catch (error) {
      Alert.alert(
        "Enregistrement impossible",
        error instanceof Error ? error.message : "Impossible d'enregistrer le profil.",
      );
    } finally {
      setIsSavingProfile(false);
    }
  };

  const uploadSelectedProfilePhoto = async (source: "camera" | "gallery") => {
    try {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error(
          source === "camera"
            ? "Autorisez l’accès à la caméra."
            : "Autorisez l’accès à vos photos.",
        );
      }
      const picked =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ["images"],
              allowsEditing: true,
              aspect: [1, 1],
              quality: 1,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              allowsEditing: true,
              aspect: [1, 1],
              quality: 1,
            });
      if (picked.canceled) return;
      const selected = picked.assets[0];
      if (!selected?.uri) {
        throw new Error("La photo sélectionnée est indisponible.");
      }
      setIsUploadingProfilePhoto(true);
      const resized = await ImageManipulator.manipulateAsync(
        selected.uri,
        [{ resize: { width: 720 } }],
        { compress: 0.78, format: ImageManipulator.SaveFormat.WEBP },
      );
      const photoUrl = await uploadProfilePhoto(resized.uri);
      setProfile((current) => current ? { ...current, photoUrl } : current);
      await refreshUser();
    } catch (error) {
      Alert.alert(
        "Photo de profil indisponible",
        error instanceof Error ? error.message : "Impossible d’enregistrer la photo.",
      );
    } finally {
      setIsUploadingProfilePhoto(false);
    }
  };

  const showProfilePhotoOptions = () => {
    if (isUploadingProfilePhoto) return;
    Alert.alert("Photo de profil", "Choisissez une source pour votre photo.", [
      { text: "Caméra", onPress: () => void uploadSelectedProfilePhoto("camera") },
      { text: "Galerie", onPress: () => void uploadSelectedProfilePhoto("gallery") },
      { text: "Annuler", style: "cancel" },
    ]);
  };

  const openContactEditor = (contact?: TrustedContact) => {
    setEditingContact(contact ?? null);
    setContactName(contact?.name ?? "");
    setContactPhone(contact?.phone ?? "");
    setIsContactModalVisible(true);
  };

  const saveContact = async () => {
    const database = databaseRef.current;
    const name = contactName.trim();
    const phone = contactPhone.trim();
    if (!database) {
      Alert.alert(
        "Stockage hors ligne — fallback mémoire",
        databaseError ?? "Le stockage local n'est pas prêt.",
      );
      return;
    }
    if (!name || !/^\+?[0-9\s()-]{7,20}$/.test(phone)) {
      Alert.alert(
        "Coordonnées invalides",
        "Saisissez un nom et un numéro de téléphone valide.",
      );
      return;
    }
    if (!editingContact && contacts.length >= 3) {
      Alert.alert(
        "Limite atteinte",
        "Vous pouvez enregistrer jusqu'à 3 contacts de confiance.",
      );
      return;
    }
    setIsSavingContact(true);
    try {
      const saved = editingContact
        ? {
            ...editingContact,
            name,
            phone,
          }
        : {
            id: `${Date.now()}`,
            name,
            phone,
            position: contacts.length + 1,
          };
      await database.saveContact(saved);
      if (database.isMemoryFallback) {
        const message = storageFallbackMessage();
        setDatabaseError(message);
        Alert.alert("Stockage hors ligne — fallback mémoire", message);
      }
      setContacts((current) =>
        editingContact
          ? current.map((contact) =>
              contact.id === saved.id ? saved : contact,
            )
          : [...current, saved],
      );
      setIsContactModalVisible(false);
    } catch (error) {
      Alert.alert(
        "Enregistrement impossible",
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer le contact hors ligne.",
      );
    } finally {
      setIsSavingContact(false);
    }
  };

  const deleteContact = async () => {
    const database = databaseRef.current;
    if (!database || !editingContact) return;
    try {
      const remaining = contacts
        .filter((contact) => contact.id !== editingContact.id)
        .map((contact, index) => ({ ...contact, position: index + 1 }));
      await database.deleteContact(editingContact.id, remaining);
      if (database.isMemoryFallback) {
        const message = storageFallbackMessage();
        setDatabaseError(message);
        Alert.alert("Stockage hors ligne — fallback mémoire", message);
      }
      setContacts(remaining);
      setIsContactModalVisible(false);
    } catch (error) {
      Alert.alert(
        "Suppression impossible",
        error instanceof Error
          ? error.message
          : "Impossible de supprimer le contact.",
      );
    }
  };

  const callNumber = async (number: string) => {
    const phoneUrl = `tel:${number}`;
    try {
      const canOpen = await Linking.canOpenURL(phoneUrl);
      if (!canOpen) {
        Alert.alert(
          "Appel indisponible",
          "Le téléphone ne peut pas ouvrir le composeur d'appel.",
        );
        return;
      }
      await Linking.openURL(phoneUrl);
    } catch {
      Alert.alert(
        "Appel indisponible",
        "Impossible d'ouvrir le composeur téléphonique.",
      );
    }
  };

  const showActivity = (activity: "listings" | "services" | "alerts") => {
    navigation.navigate("MyActivity", { activity });
  };

  const showLogoutConfirmation = () => {
    Alert.alert("Déconnexion", "Voulez-vous fermer votre session ?", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Déconnexion",
        style: "destructive",
        onPress: () => {
          void signOut().catch((error: unknown) => {
            Alert.alert(
              "Déconnexion impossible",
              error instanceof Error
                ? error.message
                : "Impossible de fermer la session.",
            );
          });
        },
      },
    ]);
  };

  const updatePreferences = async (next: AppPreferences) => {
    preferencesChangedRef.current = true;
    setTheme(next.theme);
    setLanguage(next.language);
    setPreferences(next);
    const database = databaseRef.current;
    if (!database) {
      Alert.alert(
        "Paramètres indisponibles",
        databaseError ?? "Le stockage local n'est pas prêt.",
      );
      return;
    }
    try {
      await database.setPreferences(next);
      if (database.isMemoryFallback) {
        const message = storageFallbackMessage();
        setDatabaseError(message);
        Alert.alert("Stockage hors ligne — fallback mémoire", message);
      }
      setSosNotificationsEnabled(next.sosNotificationsEnabled);
      setDefaultRadius(`${next.defaultRadiusKm} km`);
      setFloatingButtonEnabled(next.voiceAssistantFloatingButton);
    } catch (error) {
      Alert.alert(
        "Enregistrement impossible",
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer vos préférences (code PREFERENCES_SAVE_FAILED).",
      );
    }
  };

  const updateLocationRetention = async (enabled: boolean) => {
    await updatePreferences({
      ...preferences,
      rememberFeedLocation: enabled,
    });
    if (!enabled) {
      try {
        await SecureStore.deleteItemAsync("quartierplus.feed.last-position");
      } catch (error) {
        Alert.alert(
          "Position non supprimée",
          error instanceof Error
            ? error.message
            : "Impossible d’effacer la dernière position enregistrée.",
        );
      }
    }
  };

  const openDeviceNotificationSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      Alert.alert(
        "Réglages indisponibles",
        error instanceof Error
          ? error.message
          : "Impossible d’ouvrir les réglages de l’appareil.",
      );
    }
  };

  const confirmClearCachedContent = () => {
    Alert.alert(
      "Effacer le contenu local",
      "Les publications, alertes, messages et réponses API mis en cache sur cet appareil seront supprimés. Les contacts SOS et la file d’actions hors ligne seront conservés.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Effacer",
          style: "destructive",
          onPress: () => {
            setIsClearingLocalData(true);
            void clearCachedContent()
              .then(() =>
                Alert.alert(
                  "Contenu effacé",
                  "Le contenu mis en cache sur cet appareil a été supprimé.",
                ),
              )
              .catch((error: unknown) =>
                Alert.alert(
                  "Suppression impossible",
                  error instanceof Error
                    ? error.message
                    : "Impossible d’effacer le contenu local.",
                ),
              )
              .finally(() => setIsClearingLocalData(false));
          },
        },
      ],
    );
  };

  const requestPhoneOtp = async () => {
    const phoneNumber = draftPhoneNumber.trim().replace(/[\s()-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      Alert.alert(
        "Numéro invalide",
        "Saisissez le numéro au format international, par exemple +221770000000.",
      );
      return;
    }
    if (!API_BASE_URL) {
      Alert.alert("Service indisponible", "L'adresse API n'est pas configurée.");
      return;
    }
    setIsUpdatingPhone(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/api/v1/auth/change-phone/request-otp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone_number: phoneNumber }),
        },
      );
      if (!response.ok) {
        const payload = await response.json();
        const message = isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Envoi du code refusé (HTTP ${response.status}).`;
        throw new Error(message);
      }
      setDraftPhoneNumber(phoneNumber);
      setPhoneOtp("");
      setPhoneOtpRequested(true);
      Alert.alert(
        "Code envoyé",
        "Saisissez le code reçu sur ce numéro pour confirmer le changement.",
      );
    } catch (error) {
      Alert.alert(
        "Envoi impossible",
        error instanceof Error ? error.message : "Impossible d'envoyer le code SMS.",
      );
    } finally {
      setIsUpdatingPhone(false);
    }
  };

  const verifyPhoneOtp = async () => {
    if (!/^\d{6}$/.test(phoneOtp)) {
      Alert.alert("Code invalide", "Saisissez les six chiffres reçus par SMS.");
      return;
    }
    if (!API_BASE_URL) {
      Alert.alert("Service indisponible", "L'adresse API n'est pas configurée.");
      return;
    }
    setIsUpdatingPhone(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/api/v1/auth/change-phone/verify-otp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone_number: draftPhoneNumber,
            code: phoneOtp,
          }),
        },
      );
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        !isRecord(payload) ||
        typeof payload.phone_number !== "string"
      ) {
        const message =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `Vérification refusée (HTTP ${response.status}).`;
        throw new Error(message);
      }
      setProfile((current) =>
        current ? { ...current, phoneNumber: payload.phone_number as string } : current,
      );
      setPhoneOtpRequested(false);
      setPhoneOtp("");
      setIsPhoneModalVisible(false);
      Alert.alert("Téléphone mis à jour", "Votre nouveau numéro a été vérifié.");
    } catch (error) {
      Alert.alert(
        "Vérification impossible",
        error instanceof Error ? error.message : "Impossible de vérifier le code.",
      );
    } finally {
      setIsUpdatingPhone(false);
    }
  };

  const updateRadius = () => {
    const nextRadius =
      preferences.defaultRadiusKm === 3
        ? 10
        : preferences.defaultRadiusKm === 10
          ? 30
          : 3;
    void updatePreferences({ ...preferences, defaultRadiusKm: nextRadius });
  };

  const checkForAppUpdate = async () => {
    if (isCheckingUpdates) return;
    setIsCheckingUpdates(true);
    setUpdateMessage(null);
    try {
      if (!Updates.isEnabled) {
        setUpdateMessage("Les mises à jour OTA ne sont pas activées pour cette installation. Un nouvel APK est nécessaire.");
        return;
      }
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setUpdateMessage("Aucune mise à jour compatible n’est disponible pour cette version.");
        return;
      }
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew) {
        setUpdateMessage("Aucune nouvelle mise à jour compatible n’a pu être installée.");
        return;
      }
      setUpdateMessage("Mise à jour téléchargée. Redémarrage de l’application…");
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateMessage(
        error instanceof Error
          ? `Recherche impossible : ${error.message}`
          : "Recherche de mise à jour impossible. Vérifiez votre connexion.",
      );
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const openPlusDestination = (
    screen: "Talkie" | "Grin" | "EspacePro" | "Événements",
  ) => {
    navigation.navigate("Main", { screen });
  };

  if (!user) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView contentContainerStyle={styles.guestContent}>
          <Text style={styles.guestEyebrow}>VOTRE ESPACE</Text>
          <Text accessibilityRole="header" style={styles.guestTitle}>Profil</Text>
          <View style={styles.guestSignIn}>
            <Text style={styles.guestSignInTitle}>Bienvenue dans le quartier</Text>
            <Text style={styles.guestSignInCopy}>Connectez-vous pour accéder à votre profil et à vos services personnels.</Text>
            <Pressable accessibilityRole="button" onPress={requestAuthentication} style={styles.guestPrimary}>
              <Text style={styles.guestPrimaryText}>Se connecter</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={requestAuthentication} style={styles.guestSecondary}>
              <Text style={styles.guestSecondaryText}>Créer un compte</Text>
            </Pressable>
          </View>
          <View style={styles.guestSection}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: plusMenuOpen }}
              onPress={() => setPlusMenuOpen((open) => !open)}
              style={styles.guestLinkRow}
            >
              <Text style={styles.guestSectionTitle}>Plus</Text>
              <ChevronRight color="#8a8b82" size={18} />
            </Pressable>
            {plusMenuOpen &&
              PLUS_DESTINATIONS.map(({ screen, label }) => (
                <Pressable
                  accessibilityRole="button"
                  key={screen}
                  onPress={() => openPlusDestination(screen)}
                  style={styles.guestLinkRow}
                >
                  <Text style={styles.guestLinkText}>{label}</Text>
                  <ChevronRight color="#8a8b82" size={18} />
                </Pressable>
              ))}
          </View>

          <View style={styles.guestSection}>
            <Text style={styles.guestSectionTitle}>Langue</Text>
            <View style={styles.guestLanguageRow}>
              {[{ id: "fr", label: "Français" }, { id: "en", label: "English" }].map((language) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: preferences.language === language.id }}
                  key={language.id}
                  onPress={() => void updatePreferences({ ...preferences, language: language.id as AppPreferences["language"] })}
                  style={[styles.guestLanguage, preferences.language === language.id && styles.guestLanguageSelected]}
                >
                  <Text style={[styles.guestLanguageText, preferences.language === language.id && styles.guestLanguageTextSelected]}>{language.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.guestSection}>
            <Text style={styles.guestSectionTitle}>Urgences, sans compte</Text>
            <Text style={styles.guestSectionCopy}>Numéros disponibles même sans connexion internet.</Text>
            <ScrollView horizontal contentContainerStyle={styles.guestCountryRow} showsHorizontalScrollIndicator={false}>
              {COUNTRIES.map((country) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: country.code === selectedCountry.code }}
                  key={country.code}
                  onPress={() => setSelectedCountry(country)}
                  style={[styles.guestCountry, country.code === selectedCountry.code && styles.guestCountrySelected]}
                >
                  <Text style={[styles.guestCountryText, country.code === selectedCountry.code && styles.guestCountryTextSelected]}>{country.code}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={() => void callNumber(selectedCountry.emergencyNumbers.medical)} style={styles.guestEmergencyCall}>
              <PhoneCall color="#fff" size={19} />
              <Text style={styles.guestEmergencyCallText}>Appeler les secours · {selectedCountry.emergencyNumbers.medical}</Text>
            </Pressable>
            {EMERGENCY_SERVICES.map((service) => {
              const Icon = service.icon;
              return (
                <Pressable accessibilityRole="button" key={service.id} onPress={() => void callNumber(selectedCountry.emergencyNumbers[service.id])} style={styles.guestEmergencyRow}>
                  <Icon color="#b9382f" size={18} />
                  <Text style={styles.guestEmergencyName}>{service.name}</Text>
                  <Text style={styles.guestEmergencyNumber}>{selectedCountry.emergencyNumbers[service.id]}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.guestSection}>
            <Pressable accessibilityRole="button" onPress={() => setAboutVisible(true)} style={styles.guestLinkRow}>
              <Info color="#53605a" size={18} />
              <Text style={styles.guestLinkText}>À propos</Text>
              <ChevronRight color="#8a8b82" size={18} />
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setTermsVisible(true)} style={styles.guestLinkRow}>
              <Shield color="#53605a" size={18} />
              <Text style={styles.guestLinkText}>Conditions d’utilisation</Text>
              <ChevronRight color="#8a8b82" size={18} />
            </Pressable>
          </View>
        </ScrollView>
        <Modal animationType="slide" onRequestClose={() => setAboutVisible(false)} transparent visible={aboutVisible}>
          <View style={styles.guestModalBackdrop}>
            <View style={styles.guestModal}>
              <Text accessibilityRole="header" style={styles.guestModalTitle}>À propos et mises à jour</Text>
              <Text style={styles.guestMetadata}>Version : {require("../../app.json").expo.version}</Text>
              <Text style={styles.guestMetadata}>Runtime : {Updates.runtimeVersion ?? "—"}</Text>
              <Text style={styles.guestMetadata}>Canal : {Updates.channel ?? "—"}</Text>
              <Text style={styles.guestMetadata}>Update ID : {Updates.updateId ?? "Version intégrée à l’APK"}</Text>
              <Text style={styles.guestMetadata}>Canal : {Updates.channel ?? "—"}</Text>
              <Text style={styles.guestMetadata}>Runtime : {Updates.runtimeVersion ?? "—"}</Text>
              <Text style={styles.guestMetadata}>
                Commit du serveur : {serverHealth?.commit ?? "indisponible"}
              </Text>
              <Text style={styles.guestMetadata}>
                Démarrage serveur : {serverHealth?.startedAt ?? "indisponible"}
              </Text>
              <Text style={styles.guestMetadata}>
                Dernière migration : {serverHealth?.lastMigration?.version ?? "inconnue"}
              </Text>
              <Text style={styles.guestMetadata}>
                Hôte API : {API_BASE_URL ? new URL(API_BASE_URL).host : "non configuré"}
              </Text>
              <Text style={styles.guestMetadata}>
                SHA du commit : {process.env.EXPO_PUBLIC_GIT_SHA ?? "non fourni"}
              </Text>
              <Pressable accessibilityRole="button" disabled={isCheckingUpdates} onPress={() => void checkForAppUpdate()} style={styles.guestModalClose}>
                {isCheckingUpdates ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.guestModalCloseText}>Rechercher une mise à jour</Text>}
              </Pressable>
              {updateMessage && <Text accessibilityLiveRegion="polite" style={styles.guestModalCopy}>{updateMessage}</Text>}
              <Text style={styles.guestTechnicalTitle}>Détails techniques</Text>
              <Text style={styles.guestMetadata}>Firebase : {technicalStatus.firebase}</Text>
              <Text style={styles.guestMetadata}>Crashlytics : {technicalStatus.crashlytics}</Text>
              <Pressable accessibilityRole="button" onPress={() => setAboutVisible(false)} style={styles.guestModalClose}>
                <Text style={styles.guestModalCloseText}>Fermer</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <Modal animationType="slide" onRequestClose={() => setTermsVisible(false)} transparent visible={termsVisible}>
          <View style={styles.guestModalBackdrop}>
            <View style={styles.guestModal}>
              <Text accessibilityRole="header" style={styles.guestModalTitle}>Conditions d’utilisation</Text>
              <Text style={styles.guestModalCopy}>Utilisez les services de quartier avec respect. Les fonctions de publication et de mise en relation nécessitent un compte. En cas d’urgence, appelez directement les services de secours de votre pays.</Text>
              <Pressable accessibilityRole="button" onPress={() => setTermsVisible(false)} style={styles.guestModalClose}>
                <Text style={styles.guestModalCloseText}>Fermer</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profileHeader}>
          <View style={styles.avatarWrapper}>
            <Pressable
              accessibilityLabel={`Agrandir la photo de ${profile?.name || "profil"}`}
              accessibilityRole="button"
              disabled={!profile?.photoUrl}
              onPress={() => setProfilePhotoVisible(true)}
            >
              <ProfileAvatar
                name={profile?.name}
                photoUrl={profile?.photoUrl}
                size={72}
                isProVerified={profile?.badge === "Commerçant Certifié"}
              />
            </Pressable>
            {profile?.isVerified && (
              <View style={styles.verifiedBadge}>
                <CheckCircle2 color="#ffffff" size={15} />
              </View>
            )}
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name}>
              {profile?.name || (profileError ? "Profil indisponible" : "Chargement…")}
            </Text>
            <View style={styles.locationLine}>
              <MapPin color="#64748b" size={14} />
              <Text style={styles.locationText}>
                {profile?.neighborhood || "Quartier non renseigné"}
              </Text>
            </View>
            {profile && (
              <View
                style={[
                  styles.verifiedLabel,
                  profile.role === "relay" && styles.relayRoleBadge,
                ]}
              >
                {profile.isVerified && (
                  <CheckCircle2 color="#15803d" size={13} />
                )}
                <Text style={styles.verifiedText}>
                  {profile.role === "relay" ? "Voisin Relais" : "Habitant"}
                </Text>
                {profile.isVerified && (
                  <Text style={styles.verifiedText}>Vérifié</Text>
                )}
              </View>
            )}
            {profile?.badge && (
              <Text style={styles.proBadge}>{profile.badge}</Text>
            )}
            <Pressable
              accessibilityLabel="Changer la photo de profil"
              accessibilityRole="button"
              disabled={isUploadingProfilePhoto}
              onPress={showProfilePhotoOptions}
              style={styles.editProfileButton}
            >
              {isUploadingProfilePhoto ? (
                <ActivityIndicator color="#2563eb" size="small" />
              ) : (
                <ImagePlus color="#2563eb" size={14} />
              )}
              <Text style={styles.editProfileText}>
                {isUploadingProfilePhoto ? "Enregistrement de la photo…" : "Changer la photo"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setDraftName(profile?.name ?? "");
                setDraftNeighborhood(profile?.neighborhood ?? "");
                setIsEditingProfile(true);
              }}
              style={styles.editProfileButton}
            >
              <Edit3 color="#2563eb" size={14} />
              <Text style={styles.editProfileText}>Modifier le profil</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setDraftPhoneNumber(profile?.phoneNumber ?? "");
                setPhoneOtpRequested(false);
                setPhoneOtp("");
                setIsPhoneModalVisible(true);
              }}
              style={styles.editProfileButton}
            >
              <PhoneCall color="#2563eb" size={14} />
              <Text style={styles.editProfileText}>
                {profile?.phoneNumber || "Ajouter un téléphone"}
              </Text>
            </Pressable>
          </View>
        </View>
        {profileError && (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {profileError}
          </Text>
        )}

        <View style={styles.countryCard}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: plusMenuOpen }}
            onPress={() => setPlusMenuOpen((open) => !open)}
            style={styles.guestLinkRow}
          >
            <Text style={styles.cardHeading}>Plus</Text>
            <ChevronRight
              color="#64748b"
              size={19}
              style={plusMenuOpen ? styles.chevronOpen : undefined}
            />
          </Pressable>
          {plusMenuOpen &&
            PLUS_DESTINATIONS.map(({ screen, label }) => (
              <Pressable
                accessibilityRole="button"
                key={screen}
                onPress={() => openPlusDestination(screen)}
                style={styles.guestLinkRow}
              >
                <Text style={[styles.menuLabel, { color: colors.text }]}>{label}</Text>
                <ChevronRight color="#64748b" size={18} />
              </Pressable>
            ))}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Checkout")}
          style={styles.paymentCard}
        >
          <CreditCard color="#ffffff" size={20} />
          <View style={styles.paymentCopy}>
            <Text style={styles.paymentTitle}>Développez votre commerce</Text>
            <Text style={styles.paymentDescription}>
              Alliance Pro ou épingle sponsorisée · paiement sécurisé
            </Text>
          </View>
          <ChevronRight color="#ffffff" size={19} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("AlliancePeople")}
          style={[styles.menuRow, { marginTop: 12, padding: 14, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
        >
          <User color="#16834f" size={19} />
          <Text style={[styles.menuLabel, { color: colors.text }]}>Personnes à rallier</Text>
          <ChevronRight color="#94a3b8" size={18} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("AlliancePlus")}
          style={[styles.menuRow, { marginTop: 12, padding: 14, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}
        >
          <User color="#2563eb" size={19} />
          <Text style={[styles.menuLabel, { color: colors.text }]}>Alliance+</Text>
          <ChevronRight color="#94a3b8" size={18} />
        </Pressable>

        <View style={styles.countryCard}>
          <View style={styles.countryHeading}>
            <Globe color="#2563eb" size={19} />
            <Text style={styles.cardHeading}>Pays actif</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: countryMenuOpen }}
            disabled={!databaseReady}
            onPress={() => setCountryMenuOpen(!countryMenuOpen)}
            style={styles.countrySelector}
          >
            <View style={styles.countryFlag}>
              <Text style={styles.countryCode}>{selectedCountry.code}</Text>
            </View>
            <Text style={styles.countryName}>{selectedCountry.name}</Text>
            <ChevronRight
              color="#64748b"
              size={19}
              style={countryMenuOpen ? styles.chevronOpen : undefined}
            />
          </Pressable>
          {countryMenuOpen && (
            <View style={styles.countryOptions}>
              {COUNTRIES.map((country) => (
                <Pressable
                  accessibilityRole="button"
                  key={country.code}
                  onPress={() => void selectCountry(country)}
                  style={styles.countryOption}
                >
                  <View style={styles.countryFlagSmall}>
                    <Text style={styles.countryCodeSmall}>{country.code}</Text>
                  </View>
                  <Text
                    style={[
                      styles.countryOptionText,
                      country.code === selectedCountry.code &&
                        styles.countryOptionTextSelected,
                    ]}
                  >
                    {country.name}
                  </Text>
                  {country.code === selectedCountry.code && (
                    <CheckCircle2 color="#16a34a" size={17} />
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <View style={styles.reputationCard}>
          <View style={styles.reputationTop}>
            <View style={styles.reputationIcon}>
              <Shield color="#2563eb" size={22} />
            </View>
            <View style={styles.reputationCopy}>
              <Text style={styles.cardHeading}>
                Score de Réputation Communautaire
              </Text>
              <Text style={styles.trustLabel}>Indice de confiance</Text>
            </View>
          </View>
          <View style={styles.ratingRow}>
            <Text style={styles.rating}>
              {profile?.reputationScore === null ||
              profile?.reputationScore === undefined
                ? "—"
                : profile.reputationScore.toFixed(1)}
            </Text>
            <Text style={styles.ratingMax}>/ 5</Text>
            <Star color="#f59e0b" fill="#f59e0b" size={19} />
            <View style={styles.reliableBadge}>
              <Text style={styles.reliableText}>
                {profile?.isVerified ? "Voisin vérifié" : "Réputation"}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Compteur Allié</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.menuRow}>
              <User color="#2563eb" size={19} />
              <Text style={[styles.menuLabel, { color: colors.text }]}>Alliés distincts</Text>
              <Text style={[styles.menuLabel, { color: colors.text }]}>{allyCounters?.allies ?? "—"}</Text>
            </View>
            <View style={styles.menuRow}>
              <Bell color="#2563eb" size={19} />
              <Text style={[styles.menuLabel, { color: colors.text }]}>Invitations reçues en attente</Text>
              <Text style={[styles.menuLabel, { color: colors.text }]}>{allyCounters?.received_invitations ?? "—"}</Text>
            </View>
            <View style={styles.menuRow}>
              <Bell color="#2563eb" size={19} />
              <Text style={[styles.menuLabel, { color: colors.text }]}>Invitations envoyées en attente</Text>
              <Text style={[styles.menuLabel, { color: colors.text }]}>{allyCounters?.pending_invitations ?? "—"}</Text>
            </View>
          </View>
          <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 16 }]}>Mes alliés</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {allies.length ? allies.map((ally) => (
              <View key={ally.id} style={styles.menuRow}>
                <ProfileAvatar
                  name={ally.name}
                  photoUrl={ally.profile_photo_url}
                  size={34}
                  isAlly
                  isProVerified={ally.badge === "Commerçant Certifié"}
                />
                <Text style={[styles.menuLabel, { color: colors.text }]}>{ally.name || "Voisin allié"}</Text>
                <CheckCircle2 color="#15803d" size={18} />
              </View>
            )) : (
              <Text style={[styles.settingDescription, { color: colors.secondaryText, padding: 14 }]}>
                Vos alliances confirmées apparaîtront ici.
              </Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            Numéros d'Urgence Officiels du Pays
          </Text>
          <Text style={[styles.countryContext, { color: colors.secondaryText }]}>
            Numéros pour {selectedCountry.name}
          </Text>
          {EMERGENCY_SERVICES.map((service) => {
            const ServiceIcon = service.icon;
            const number = selectedCountry.emergencyNumbers[service.id];
            return (
              <View key={service.id} style={styles.emergencyCard}>
                <View style={styles.emergencyIcon}>
                  <ServiceIcon color="#dc2626" size={20} />
                </View>
                <View style={styles.emergencyCopy}>
                  <Text style={styles.emergencyName}>{service.name}</Text>
                  <Text style={styles.emergencyNumber}>{number}</Text>
                </View>
                <Pressable
                  accessibilityLabel={`Appeler ${service.name}, ${number}`}
                  accessibilityRole="button"
                  onPress={() => void callNumber(number)}
                  style={styles.callButton}
                >
                  <PhoneCall color="#ffffff" size={14} />
                  <Text style={styles.callButtonText}>Appeler</Text>
                </Pressable>
              </View>
            );
          })}
          <Text style={styles.disclaimer}>
            Vérifiez la disponibilité des numéros auprès des autorités locales.
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeadingRow}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t("profileEmergencyContacts")}</Text>
            <Text style={styles.priorityCaption}>Prioritaires</Text>
          </View>
          <Text style={[styles.sectionDescription, { color: colors.secondaryText }]}>
            Ces proches reçoivent un signalement lorsque vous déclenchez SOS.
          </Text>
          {contacts.length === 0 && (
            <Text style={[styles.emptyContacts, { color: colors.secondaryText }]}>
              Aucun contact de confiance enregistré.
            </Text>
          )}
          {contacts.map((contact, index) => (
            <Pressable
              accessibilityLabel={`Modifier le contact ${contact.name}`}
              accessibilityRole="button"
              key={contact.id}
              onPress={() => openContactEditor(contact)}
              style={styles.contactCard}
            >
              <View
                style={[
                  styles.contactAvatar,
                  index === 0 && styles.contactAvatarPrimary,
                ]}
              >
                <Text style={styles.contactInitials}>
                  {contact.name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase() ?? "")
                    .join("")}
                </Text>
              </View>
              <View style={styles.contactCopy}>
                <Text style={styles.contactName}>{contact.name}</Text>
                <Text style={styles.contactRelationship}>
                  {index + 1} · {contact.phone}
                </Text>
              </View>
              <Edit3 color="#64748b" size={17} />
            </Pressable>
          ))}
          {contacts.length < 3 && (
            <Pressable
              accessibilityRole="button"
              disabled={!databaseReady}
              onPress={() => openContactEditor()}
              style={styles.addContactButton}
            >
              <Text style={styles.addContactText}>
                + Ajouter un contact de confiance ({contacts.length}/3)
              </Text>
            </Pressable>
          )}
          {databaseError && (
            <Text accessibilityRole="alert" style={styles.errorText}>
              Les contacts hors ligne sont indisponibles : {databaseError}
            </Text>
          )}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t("profileActivities")}</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {ACTIVITIES.map((activity, index) => {
              const ActivityIcon = activity.icon;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={activity.id}
                  onPress={() => showActivity(activity.id)}
                  style={[
                    styles.menuRow,
                    index < ACTIVITIES.length - 1 && styles.menuRowBorder,
                  ]}
                >
                  <ActivityIcon color="#2563eb" size={19} />
                  <Text style={[styles.menuLabel, { color: colors.text }]}>{activity.label}</Text>
                  <ChevronRight color="#94a3b8" size={18} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t("profileVoiceAssistant")}</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.menuRow}>
              <Mic color="#2563eb" size={19} />
              <View style={styles.notificationCopy}>
                <Text style={[styles.menuLabel, { color: colors.text }]}>Afficher le bouton flottant</Text>
                <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                  Ajouter un raccourci à l’écran
                </Text>
              </View>
              <Switch
                accessibilityLabel="Assistant vocal : afficher le bouton flottant"
                onValueChange={(enabled) =>
                  void updatePreferences({
                    ...preferences,
                    voiceAssistantFloatingButton: enabled,
                  })
                }
                trackColor={{ false: "#cbd5e1", true: "#86efac" }}
                thumbColor={
                  preferences.voiceAssistantFloatingButton
                    ? "#16a34a"
                    : "#f8fafc"
                }
                value={preferences.voiceAssistantFloatingButton}
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t("profileSettings")}</Text>
          <View style={[styles.settingsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Pressable
              accessibilityRole="button"
              onPress={updateRadius}
              style={[styles.menuRow, styles.menuRowBorder]}
            >
              <MapPin color="#2563eb" size={19} />
              <Text style={[styles.menuLabel, { color: colors.text }]}>Rayon GPS par défaut</Text>
              <Text style={styles.settingValue}>{defaultRadius}</Text>
              <ChevronRight color="#94a3b8" size={18} />
            </Pressable>
            <View style={[styles.menuRow, styles.menuRowBorder]}>
              <Bell color="#2563eb" size={19} />
              <View style={styles.notificationCopy}>
                <Text style={[styles.menuLabel, { color: colors.text }]}>Notifications SOS</Text>
                <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                  Alertes de sécurité prioritaires
                </Text>
              </View>
              <Switch
                accessibilityLabel="Gestion des notifications SOS"
                onValueChange={(enabled) =>
                  void updatePreferences({
                    ...preferences,
                    sosNotificationsEnabled: enabled,
                  })
                }
                trackColor={{ false: "#cbd5e1", true: "#86efac" }}
                thumbColor={sosNotificationsEnabled ? "#16a34a" : "#f8fafc"}
                value={sosNotificationsEnabled}
              />
            </View>
            <View style={[styles.menuRow, styles.menuRowBorder]}>
              <ShieldCheck color="#dc2626" size={19} />
              <View style={styles.notificationCopy}>
                <Text style={[styles.menuLabel, { color: colors.text }]}>Priorité aux alertes SOS</Text>
                <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                  Les alertes SOS passent outre les heures calmes
                </Text>
              </View>
              <Switch
                accessibilityLabel="Donner la priorité aux alertes SOS"
                onValueChange={(enabled) =>
                  void updatePreferences({
                    ...preferences,
                    sosNotificationsPriority: enabled,
                  })
                }
                value={preferences.sosNotificationsPriority}
              />
            </View>
            <View style={[styles.quietHoursGroup, styles.menuRowBorder]}>
              <Text style={[styles.menuLabel, { color: colors.text }]}>Heures calmes</Text>
              <View style={styles.quietHoursInputs}>
                <TextInput
                  accessibilityLabel="Début des heures calmes"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  onBlur={() => {
                    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursStart)) {
                      Alert.alert("Heure invalide", "Saisissez une heure au format 22:00.");
                      return;
                    }
                    void updatePreferences(preferences);
                  }}
                  onChangeText={(quietHoursStart) =>
                    setPreferences((current) => ({ ...current, quietHoursStart }))
                  }
                  placeholder="22:00"
                  style={[styles.quietHoursInput, { color: colors.text, borderColor: colors.border }]}
                  value={preferences.quietHoursStart}
                />
                <Text style={{ color: colors.secondaryText }}>à</Text>
                <TextInput
                  accessibilityLabel="Fin des heures calmes"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  onBlur={() => {
                    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.quietHoursEnd)) {
                      Alert.alert("Heure invalide", "Saisissez une heure au format 07:00.");
                      return;
                    }
                    void updatePreferences(preferences);
                  }}
                  onChangeText={(quietHoursEnd) =>
                    setPreferences((current) => ({ ...current, quietHoursEnd }))
                  }
                  placeholder="07:00"
                  style={[styles.quietHoursInput, { color: colors.text, borderColor: colors.border }]}
                  value={preferences.quietHoursEnd}
                />
              </View>
            </View>
            <View style={[styles.preferenceGroup, styles.menuRowBorder]}>
              <View style={styles.preferenceHeading}>
                <Settings color={colors.primary} size={19} />
                <Text style={[styles.menuLabel, { color: colors.text }]}>{t("themeTitle")}</Text>
              </View>
              <View style={styles.preferenceChoices}>
                {(["light", "dark", "system"] as const).map((choice) => (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: theme === choice }}
                    key={choice}
                    onPress={() =>
                      void updatePreferences({ ...preferences, theme: choice })
                    }
                    style={[
                      styles.preferenceChoice,
                      theme === choice && styles.preferenceChoiceSelected,
                      theme === choice && { backgroundColor: colors.primary },
                    ]}
                  >
                    <Text
                      style={[
                        styles.preferenceChoiceText,
                        theme === choice && styles.preferenceChoiceTextSelected,
                        theme === choice && { color: colors.onPrimary },
                      ]}
                    >
                      {choice === "light"
                        ? t("themeLight")
                        : choice === "dark"
                          ? t("themeDark")
                          : t("themeSystem")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.preferenceGroup}>
              <View style={styles.preferenceHeading}>
                <Globe color={colors.primary} size={19} />
                <Text style={[styles.menuLabel, { color: colors.text }]}>{t("languageTitle")}</Text>
              </View>
              <View style={styles.preferenceChoices}>
                {(["fr", "en"] as const).map((choice) => (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: language === choice }}
                    key={choice}
                    onPress={() =>
                      void updatePreferences({ ...preferences, language: choice })
                    }
                    style={[
                      styles.preferenceChoice,
                      language === choice && styles.preferenceChoiceSelected,
                      language === choice && { backgroundColor: colors.primary },
                    ]}
                  >
                    <Text
                      style={[
                        styles.preferenceChoiceText,
                        language === choice && styles.preferenceChoiceTextSelected,
                        language === choice && { color: colors.onPrimary },
                      ]}
                    >
                      {choice === "fr" ? t("languageFrench") : t("languageEnglish")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPrivacyVisible(true)}
              style={styles.menuRow}
            >
              <Lock color="#2563eb" size={19} />
              <Text style={[styles.menuLabel, { color: colors.text }]}>Confidentialité du compte</Text>
              <ChevronRight color="#94a3b8" size={18} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={showLogoutConfirmation}
            style={styles.logoutButton}
          >
            <LogOut color="#dc2626" size={19} />
            <Text style={styles.logoutText}>{t("profileLogout")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setAboutVisible(true)}
            style={styles.menuRow}
          >
            <Info color="#2563eb" size={19} />
            <Text style={[styles.menuLabel, { color: colors.text }]}>À propos et mises à jour</Text>
            <ChevronRight color="#94a3b8" size={18} />
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Settings color="#94a3b8" size={14} />
          <Text style={styles.footerText}>QuartierPlus · Profil communautaire</Text>
        </View>
      </ScrollView>
      <Modal
        animationType="slide"
        onRequestClose={() => setPrivacyVisible(false)}
        transparent
        visible={privacyVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.privacyModalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text accessibilityRole="header" style={[styles.modalTitle, { color: colors.text }]}>
              Confidentialité
            </Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                Contrôlez les données conservées sur cet appareil et les alertes
                d’urgence. Le partage de position reste privé tant que vous ne
                l’activez pas explicitement sur la carte.
              </Text>
              <View style={styles.privacySetting}>
                <View style={styles.privacyCopy}>
                  <Text style={[styles.menuLabel, { color: colors.text }]}>
                    Mémoriser ma dernière position
                  </Text>
                  <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                    Stockée localement pour accélérer le fil de quartier. Le SOS
                    demande toujours une position actuelle.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Mémoriser la dernière position sur cet appareil"
                  onValueChange={(enabled) => void updateLocationRetention(enabled)}
                  value={preferences.rememberFeedLocation}
                />
              </View>
              <View style={styles.privacySetting}>
                <View style={styles.privacyCopy}>
                  <Text style={[styles.menuLabel, { color: colors.text }]}>Notifications SOS</Text>
                  <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                    Autoriser les alertes d’urgence reçues sur cet appareil.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Notifications SOS"
                  onValueChange={(enabled) =>
                    void updatePreferences({
                      ...preferences,
                      sosNotificationsEnabled: enabled,
                    })
                  }
                  value={preferences.sosNotificationsEnabled}
                />
              </View>
              <View style={styles.privacySetting}>
                <View style={styles.privacyCopy}>
                  <Text style={[styles.menuLabel, { color: colors.text }]}>
                    Priorité SOS pendant les heures calmes
                  </Text>
                  <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
                    Les alertes SOS peuvent contourner les heures calmes.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Priorité des notifications SOS pendant les heures calmes"
                  onValueChange={(enabled) =>
                    void updatePreferences({
                      ...preferences,
                      sosNotificationsPriority: enabled,
                    })
                  }
                  value={preferences.sosNotificationsPriority}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => void openDeviceNotificationSettings()}
                style={styles.privacyAction}
              >
                <Bell color={colors.primary} size={18} />
                <Text style={[styles.privacyActionText, { color: colors.text }]}>
                  Réglages des notifications et autorisations
                </Text>
                <ChevronRight color={colors.secondaryText} size={18} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isClearingLocalData}
                onPress={confirmClearCachedContent}
                style={styles.privacyAction}
              >
                {isClearingLocalData ? (
                  <ActivityIndicator color={colors.danger} size="small" />
                ) : (
                  <Trash2 color={colors.danger} size={18} />
                )}
                <Text style={[styles.privacyActionText, { color: colors.text }]}>
                  {isClearingLocalData ? "Suppression en cours…" : "Effacer le contenu local en cache"}
                </Text>
              </Pressable>
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPrivacyVisible(false)}
              style={styles.primaryAction}
            >
              <Text style={styles.primaryActionText}>Fermer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="fade"
        onRequestClose={() => setProfilePhotoVisible(false)}
        statusBarTranslucent
        transparent
        visible={profilePhotoVisible && Boolean(profile?.photoUrl)}
      >
        <Pressable
          accessibilityLabel="Fermer la photo de profil agrandie"
          accessibilityRole="button"
          onPress={() => setProfilePhotoVisible(false)}
          style={styles.profilePhotoBackdrop}
        >
          <Image
            accessibilityLabel={`Photo de profil de ${profile?.name || "l’utilisateur"}`}
            resizeMode="contain"
            source={{ uri: profile?.photoUrl ?? undefined }}
            style={styles.profilePhotoPreview}
          />
          <Text style={styles.profilePhotoHint}>Toucher pour fermer</Text>
        </Pressable>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setAboutVisible(false)}
        transparent
        visible={aboutVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>À propos et mises à jour</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>Version : {require("../../app.json").expo.version}</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>Runtime : {Updates.runtimeVersion ?? "—"}</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>Canal : {Updates.channel ?? "—"}</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
              Update ID : {Updates.updateId ?? "Version intégrée à l’APK"}
            </Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
              Commit du serveur : {serverHealth?.commit ?? "indisponible"}
            </Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>Démarrage serveur : {serverHealth?.startedAt ?? "indisponible"}</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>Dernière migration : {serverHealth?.lastMigration?.version ?? "inconnue"}</Text>
            <Text style={[styles.settingDescription, { color: colors.secondaryText }]}>
              Hôte API : {API_BASE_URL ? new URL(API_BASE_URL).host : "non configuré"}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={isCheckingUpdates}
              onPress={() => void checkForAppUpdate()}
              style={styles.primaryAction}
            >
              {isCheckingUpdates ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryActionText}>Rechercher une mise à jour</Text>}
            </Pressable>
            {updateMessage && (
              <Text accessibilityLiveRegion="polite" style={[styles.settingDescription, { color: colors.secondaryText }]}>
                {updateMessage}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => setAboutVisible(false)}
              style={styles.guestModalClose}
            >
              <Text style={styles.guestModalCloseText}>Fermer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setIsEditingProfile(false)}
        transparent
        visible={isEditingProfile}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Modifier mon profil</Text>
            <Text style={styles.inputLabel}>Nom</Text>
            <VoiceTextInput
              autoCapitalize="words"
              onChangeText={setDraftName}
              placeholder="Votre nom"
              style={styles.modalInput}
              value={draftName}
            />
            <Text style={styles.inputLabel}>Quartier</Text>
            <VoiceTextInput
              autoCapitalize="words"
              onChangeText={setDraftNeighborhood}
              placeholder="Votre quartier"
              style={styles.modalInput}
              value={draftNeighborhood}
            />
            <Text style={styles.countryContext}>
              Pays actif : {selectedCountry.name}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={isSavingProfile}
              onPress={() => void saveProfile()}
              style={styles.primaryAction}
            >
              {isSavingProfile ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryActionText}>Enregistrer le profil</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsEditingProfile(false)}
              style={styles.secondaryAction}
            >
              <Text style={styles.secondaryActionText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setIsPhoneModalVisible(false)}
        transparent
        visible={isPhoneModalVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Modifier mon téléphone</Text>
            <Text style={styles.countryContext}>
              Le numéro sera changé uniquement après vérification par SMS.
            </Text>
            <Text style={styles.inputLabel}>Numéro international</Text>
            <TextInput
              autoComplete="tel"
              keyboardType="phone-pad"
              onChangeText={setDraftPhoneNumber}
              placeholder="+221770000000"
              style={styles.modalInput}
              value={draftPhoneNumber}
            />
            {phoneOtpRequested && (
              <>
                <Text style={styles.inputLabel}>Code de vérification</Text>
                <TextInput
                  autoComplete="one-time-code"
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={(value) => setPhoneOtp(value.replace(/\D/g, ""))}
                  placeholder="123456"
                  style={styles.modalInput}
                  value={phoneOtp}
                />
              </>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={isUpdatingPhone}
              onPress={() =>
                void (phoneOtpRequested ? verifyPhoneOtp() : requestPhoneOtp())
              }
              style={styles.primaryAction}
            >
              {isUpdatingPhone ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryActionText}>
                  {phoneOtpRequested ? "Vérifier le code" : "Recevoir un code SMS"}
                </Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsPhoneModalVisible(false)}
              style={styles.secondaryAction}
            >
              <Text style={styles.secondaryActionText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setIsContactModalVisible(false)}
        transparent
        visible={isContactModalVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editingContact ? "Modifier le contact SOS" : "Ajouter un contact SOS"}
            </Text>
            <Text style={styles.inputLabel}>Nom</Text>
            <VoiceTextInput
              autoCapitalize="words"
              onChangeText={setContactName}
              placeholder="Nom du contact"
              style={styles.modalInput}
              value={contactName}
            />
            <Text style={styles.inputLabel}>Téléphone</Text>
            <TextInput
              keyboardType="phone-pad"
              onChangeText={setContactPhone}
              placeholder="+221 77 000 00 00"
              style={styles.modalInput}
              value={contactPhone}
            />
            <Pressable
              accessibilityRole="button"
              disabled={isSavingContact}
              onPress={() => void saveContact()}
              style={styles.primaryAction}
            >
              {isSavingContact ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryActionText}>Enregistrer hors ligne</Text>
              )}
            </Pressable>
            {editingContact && (
              <Pressable
                accessibilityRole="button"
                onPress={() => void deleteContact()}
                style={styles.deleteAction}
              >
                <Trash2 color="#dc2626" size={16} />
                <Text style={styles.deleteActionText}>Supprimer le contact</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsContactModalVisible(false)}
              style={styles.secondaryAction}
            >
              <Text style={styles.secondaryActionText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#f5f7fa",
    flex: 1,
  },
  content: {
    paddingBottom: 118,
    paddingHorizontal: 20,
    paddingTop: 55,
  },
  profileHeader: {
    alignItems: "center",
    flexDirection: "row",
    marginBottom: 17,
  },
  avatarWrapper: {
    marginRight: 14,
    position: "relative",
  },
  avatar: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderColor: "#ffffff",
    borderRadius: 36,
    borderWidth: 3,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  verifiedBadge: {
    alignItems: "center",
    backgroundColor: "#16a34a",
    borderColor: "#ffffff",
    borderRadius: 11,
    borderWidth: 2,
    bottom: 0,
    height: 23,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    width: 23,
  },
  profileInfo: {
    flex: 1,
  },
  name: {
    color: "#172b4d",
    fontSize: 21,
    fontWeight: "700",
  },
  locationLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    marginTop: 5,
  },
  locationText: {
    color: "#64748b",
    fontSize: 13,
  },
  verifiedLabel: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#dcfce7",
    borderRadius: 7,
    flexDirection: "row",
    gap: 4,
    marginTop: 7,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  verifiedText: {
    color: "#15803d",
    fontSize: 10,
    fontWeight: "700",
  },
  proBadge: {
    alignSelf: "flex-start",
    color: "#92400e",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 6,
  },
  paymentCard: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 13,
    flexDirection: "row",
    gap: 11,
    marginBottom: 17,
    padding: 14,
  },
  paymentCopy: {
    flex: 1,
  },
  paymentTitle: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  paymentDescription: {
    color: "#dbeafe",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 3,
  },
  relayRoleBadge: {
    backgroundColor: "#dbeafe",
  },
  editProfileButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 5,
    marginTop: 7,
    minHeight: 28,
  },
  editProfileText: {
    color: "#2563eb",
    fontSize: 11,
    fontWeight: "700",
  },
  errorText: {
    color: "#b91c1c",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  countryCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 13,
    padding: 13,
  },
  countryHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  cardHeading: {
    color: "#172b4d",
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
  },
  countrySelector: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    flexDirection: "row",
    gap: 10,
    minHeight: 46,
    paddingHorizontal: 10,
  },
  countryFlag: {
    alignItems: "center",
    backgroundColor: "#e2e8f0",
    borderRadius: 7,
    height: 29,
    justifyContent: "center",
    width: 39,
  },
  countryCode: {
    color: "#334155",
    fontSize: 10,
    fontWeight: "800",
  },
  countryName: {
    color: "#172b4d",
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  countryOptions: {
    borderTopColor: "#e2e8f0",
    borderTopWidth: 1,
    marginTop: 9,
    paddingTop: 4,
  },
  countryOption: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 42,
  },
  countryFlagSmall: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 5,
    height: 24,
    justifyContent: "center",
    width: 32,
  },
  countryCodeSmall: {
    color: "#475569",
    fontSize: 9,
    fontWeight: "700",
  },
  countryOptionText: {
    color: "#475569",
    flex: 1,
    fontSize: 13,
  },
  countryOptionTextSelected: {
    color: "#15803d",
    fontWeight: "700",
  },
  reputationCard: {
    backgroundColor: "#ffffff",
    borderColor: "#dbeafe",
    borderRadius: 15,
    borderWidth: 1,
    marginBottom: 25,
    padding: 15,
  },
  reputationTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  reputationIcon: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 11,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  reputationCopy: {
    flex: 1,
  },
  trustLabel: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 3,
  },
  ratingRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 14,
  },
  rating: {
    color: "#172b4d",
    fontSize: 26,
    fontWeight: "800",
  },
  ratingMax: {
    color: "#64748b",
    fontSize: 13,
    marginRight: 1,
  },
  reliableBadge: {
    backgroundColor: "#ecfdf5",
    borderRadius: 7,
    marginLeft: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  reliableText: {
    color: "#15803d",
    fontSize: 10,
    fontWeight: "700",
  },
  section: {
    marginBottom: 25,
  },
  sectionTitle: {
    color: "#172b4d",
    fontSize: 17,
    fontWeight: "700",
  },
  countryContext: {
    color: "#64748b",
    fontSize: 12,
    marginBottom: 10,
    marginTop: 4,
  },
  emergencyCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 13,
    flexDirection: "row",
    marginBottom: 8,
    padding: 11,
  },
  emergencyIcon: {
    alignItems: "center",
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    height: 39,
    justifyContent: "center",
    marginRight: 10,
    width: 39,
  },
  emergencyCopy: {
    flex: 1,
  },
  emergencyName: {
    color: "#172b4d",
    fontSize: 12,
    fontWeight: "600",
  },
  emergencyNumber: {
    color: "#dc2626",
    fontSize: 16,
    fontWeight: "800",
    marginTop: 3,
  },
  callButton: {
    alignItems: "center",
    backgroundColor: "#dc2626",
    borderRadius: 8,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  callButtonText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
  disclaimer: {
    color: "#94a3b8",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 2,
  },
  sectionHeadingRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  priorityCaption: {
    color: "#64748b",
    fontSize: 10,
  },
  sectionDescription: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
    marginTop: 5,
  },
  contactCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    flexDirection: "row",
    marginBottom: 7,
    padding: 10,
  },
  contactAvatar: {
    alignItems: "center",
    backgroundColor: "#64748b",
    borderRadius: 19,
    height: 38,
    justifyContent: "center",
    marginRight: 10,
    width: 38,
  },
  contactAvatarPrimary: {
    backgroundColor: "#2563eb",
  },
  contactInitials: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "700",
  },
  contactCopy: {
    flex: 1,
  },
  contactName: {
    color: "#172b4d",
    fontSize: 13,
    fontWeight: "600",
  },
  contactRelationship: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 3,
  },
  emptyContacts: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    color: "#64748b",
    fontSize: 12,
    marginBottom: 8,
    padding: 12,
  },
  addContactButton: {
    alignItems: "center",
    borderColor: "#bfdbfe",
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 3,
    minHeight: 42,
    justifyContent: "center",
  },
  addContactText: {
    color: "#2563eb",
    fontSize: 12,
    fontWeight: "700",
  },
  modalBackdrop: {
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  profilePhotoBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.92)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  profilePhotoPreview: { height: "82%", width: "100%" },
  profilePhotoHint: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 16,
  },
  modalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 20,
  },
  privacyModalCard: { maxHeight: "90%" },
  modalTitle: {
    color: "#172b4d",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 15,
  },
  inputLabel: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 9,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 14,
    marginBottom: 12,
    minHeight: 45,
    paddingHorizontal: 12,
  },
  primaryAction: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 9,
    justifyContent: "center",
    marginTop: 5,
    minHeight: 46,
  },
  primaryActionText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  secondaryAction: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
    minHeight: 40,
  },
  secondaryActionText: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "600",
  },
  deleteAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 40,
  },
  deleteActionText: {
    color: "#dc2626",
    fontSize: 12,
    fontWeight: "700",
  },
  settingsCard: {
    backgroundColor: "#ffffff",
    borderRadius: 13,
    marginTop: 11,
    overflow: "hidden",
    paddingHorizontal: 12,
  },
  preferenceGroup: {
    paddingVertical: 10,
  },
  preferenceHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 34,
  },
  preferenceChoices: {
    flexDirection: "row",
    gap: 8,
    marginTop: 7,
  },
  preferenceChoice: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 7,
    flex: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 6,
  },
  preferenceChoiceSelected: {
    backgroundColor: "#2563eb",
  },
  preferenceChoiceText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "600",
  },
  preferenceChoiceTextSelected: {
    color: "#ffffff",
  },
  menuRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 50,
    paddingVertical: 8,
  },
  privacySetting: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  privacyCopy: { flex: 1, paddingRight: 10 },
  privacyAction: {
    alignItems: "center",
    borderTopColor: "#e2e8f0",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    minHeight: 48,
    paddingVertical: 8,
  },
  privacyActionText: { flex: 1, fontSize: 12, fontWeight: "600" },
  menuRowBorder: {
    borderBottomColor: "#f1f5f9",
    borderBottomWidth: 1,
  },
  menuLabel: {
    color: "#334155",
    flex: 1,
    fontSize: 12,
    fontWeight: "500",
  },
  settingValue: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "600",
  },
  notificationCopy: {
    flex: 1,
  },
  quietHoursGroup: {
    gap: 8,
    paddingVertical: 11,
  },
  quietHoursInputs: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
  },
  quietHoursInput: {
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 13,
    minWidth: 72,
    paddingHorizontal: 10,
    paddingVertical: 7,
    textAlign: "center",
  },
  settingDescription: {
    color: "#94a3b8",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 2,
  },
  logoutButton: {
    alignItems: "center",
    backgroundColor: "#fef2f2",
    borderRadius: 11,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 13,
    minHeight: 47,
  },
  logoutText: {
    color: "#dc2626",
    fontSize: 13,
    fontWeight: "700",
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingBottom: 8,
  },
  footerText: {
    color: "#94a3b8",
    fontSize: 10,
  },
  guestContent: { gap: 14, padding: 20, paddingBottom: 118, paddingTop: 58 },
  guestEyebrow: { color: "#28765c", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  guestTitle: { color: "#252823", fontSize: 27, fontWeight: "800", marginTop: -10 },
  guestSignIn: { backgroundColor: "#fffdf8", borderColor: "#e5e2d8", borderRadius: 8, borderWidth: 1, padding: 16 },
  guestSignInTitle: { color: "#252823", fontSize: 17, fontWeight: "700" },
  guestSignInCopy: { color: "#65675e", fontSize: 13, lineHeight: 19, marginTop: 6 },
  guestPrimary: { alignItems: "center", backgroundColor: "#252823", borderRadius: 7, justifyContent: "center", marginTop: 14, minHeight: 46 },
  guestPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  guestSecondary: { alignItems: "center", justifyContent: "center", minHeight: 42 },
  guestSecondaryText: { color: "#252823", fontSize: 13, fontWeight: "700" },
  guestSection: { backgroundColor: "#fffdf8", borderColor: "#e5e2d8", borderRadius: 8, borderWidth: 1, padding: 14 },
  guestSectionTitle: { color: "#252823", fontSize: 15, fontWeight: "700" },
  guestSectionCopy: { color: "#65675e", fontSize: 12, marginTop: 5 },
  guestLanguageRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  guestLanguage: { alignItems: "center", borderColor: "#d8d7cf", borderRadius: 7, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 40 },
  guestLanguageSelected: { backgroundColor: "#e9f4ed", borderColor: "#28765c" },
  guestLanguageText: { color: "#65675e", fontSize: 13, fontWeight: "600" },
  guestLanguageTextSelected: { color: "#28765c" },
  guestCountryRow: { gap: 8, paddingVertical: 12 },
  guestCountry: { alignItems: "center", borderColor: "#d8d7cf", borderRadius: 7, borderWidth: 1, height: 38, justifyContent: "center", width: 54 },
  guestCountrySelected: { backgroundColor: "#e9f4ed", borderColor: "#28765c" },
  guestCountryText: { color: "#65675e", fontSize: 12, fontWeight: "700" },
  guestCountryTextSelected: { color: "#28765c" },
  guestEmergencyCall: { alignItems: "center", backgroundColor: "#b9382f", borderRadius: 7, flexDirection: "row", gap: 9, justifyContent: "center", minHeight: 48 },
  guestEmergencyCallText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  guestEmergencyRow: { alignItems: "center", borderBottomColor: "#efede6", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: 44 },
  guestEmergencyName: { color: "#444840", flex: 1, fontSize: 12 },
  guestEmergencyNumber: { color: "#252823", fontSize: 13, fontWeight: "800" },
  guestLinkRow: { alignItems: "center", borderBottomColor: "#efede6", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: 48 },
  guestLinkText: { color: "#444840", flex: 1, fontSize: 13, fontWeight: "600" },
  guestModalBackdrop: { backgroundColor: "rgba(20, 25, 21, 0.42)", flex: 1, justifyContent: "flex-end" },
  guestModal: { backgroundColor: "#fffdf8", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 22, paddingBottom: 32 },
  guestModalTitle: { color: "#252823", fontSize: 19, fontWeight: "800", marginBottom: 16 },
  guestMetadata: { color: "#444840", fontSize: 13, lineHeight: 22 },
  guestTechnicalTitle: { color: "#252823", fontSize: 14, fontWeight: "800", marginBottom: 3, marginTop: 14 },
  guestModalCopy: { color: "#444840", fontSize: 14, lineHeight: 22 },
  guestModalClose: { alignItems: "center", backgroundColor: "#252823", borderRadius: 7, justifyContent: "center", marginTop: 20, minHeight: 46 },
  guestModalCloseText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
