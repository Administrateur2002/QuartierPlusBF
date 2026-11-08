import NetInfo from "@react-native-community/netinfo";
import { File } from "expo-file-system";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import api, {
  clearStoredAuthToken,
  getStoredAuthToken,
  storeAuthToken,
  subscribeToNetwork,
} from "../services/api";
import {
  clearApiCache,
  clearCachedMessages,
  clearPersistedQueryClient,
  enqueueOfflineAction,
  getPendingActions,
  removeSyncAction,
  updateSyncAction,
  type SyncActionType,
  type SyncAction,
} from "../services/db";
import { queryClient } from "../services/queryClient";
import {
  registerPushNotifications,
  unregisterPushNotifications,
} from "../services/notifications";
import { uploadMarketplaceImage } from "../services/uploadMarketplaceImage";
import { uploadEmergencyMedia } from "../services/uploadEmergencyMedia";

export type AuthUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  role?: string | null;
  country_code?: string | null;
  reputation_score?: number | null;
  is_verified?: boolean;
  profile_photo_url?: string | null;
  badge?: string | null;
  phone_verified_at?: string | null;
  [key: string]: unknown;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  authStatus: "loading" | "guest" | "connected";
  authPromptVisible: boolean;
  requestAuthentication: () => void;
  dismissAuthPrompt: () => void;
  isOffline: boolean;
  isSessionLoading: boolean;
  authError: string | null;
  setSession: (token: string, user: AuthUser) => Promise<void>;
  requestPushNotifications: () => Promise<boolean>;
  queueOfflineAction: (
    actionType: SyncActionType,
    payload: Record<string, unknown>,
  ) => Promise<number>;
  refreshUser: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const readUser = (value: unknown): AuthUser | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const candidate =
    envelope.user && typeof envelope.user === "object"
      ? envelope.user
      : envelope;
  const user = candidate as Record<string, unknown>;
  return typeof user.id === "string" ? (user as AuthUser) : null;
};

const actionEndpoint = (action: SyncAction) => {
  if (action.actionType === "create_post") return "/v1/marketplace/items";
  if (action.actionType === "trigger_sos") return "/v1/sos";
  if (action.actionType === "toggle_post_like") {
    return `/v1/social/posts/${encodeURIComponent(String(action.payload.post_id))}/like`;
  }
  if (action.actionType === "create_post_comment") {
    return `/v1/social/posts/${encodeURIComponent(String(action.payload.post_id))}/comments`;
  }
  if (action.actionType === "create_feed_post") return "/v1/posts";
  throw new Error(`Type d'action hors ligne non pris en charge: ${action.actionType}`);
};

const buildQueuedRequestBody = async (action: SyncAction) => {
  if (action.actionType === "toggle_post_like") return {};
  if (action.actionType === "create_post_comment") {
    return { content: String(action.payload.content ?? "") };
  }
  if (action.actionType === "create_feed_post") {
    return {
      caption: String(action.payload.caption ?? ""),
      scope: String(action.payload.scope ?? "country"),
      ...(typeof action.payload.latitude === "number" &&
      typeof action.payload.longitude === "number"
        ? {
            latitude: action.payload.latitude,
            longitude: action.payload.longitude,
          }
        : {}),
    };
  }
  if (action.actionType === "create_post") {
    const imageUri =
      typeof action.payload.image_uri === "string"
        ? action.payload.image_uri
        : null;
    const mediaPublicId = imageUri
      ? await uploadMarketplaceImage(
          imageUri,
          new File(imageUri).size,
          `marketplace-offline-${action.id}.webp`,
        )
      : undefined;
    const locationValue = action.payload.location;
    let location: unknown = locationValue;
    if (typeof locationValue === "string") {
      try {
        location = JSON.parse(locationValue) as unknown;
      } catch {
        throw new Error("La position de l'annonce hors ligne est invalide.");
      }
    }
    const isFree = action.payload.is_free === "true";
    return {
      title: String(action.payload.title ?? ""),
      description: String(action.payload.description ?? ""),
      category: String(action.payload.category ?? ""),
      item_type: String(action.payload.item_type ?? "listing"),
      is_free: isFree,
      price: isFree ? 0 : Number(action.payload.price),
      ...(typeof action.payload.country_code === "string"
        ? { country_code: action.payload.country_code }
        : {}),
      ...(typeof action.payload.currency_code === "string"
        ? { currency_code: action.payload.currency_code }
        : {}),
      ...(typeof action.payload.city === "string"
        ? { city: action.payload.city }
        : {}),
      ...(typeof action.payload.language_code === "string"
        ? { language_code: action.payload.language_code }
        : {}),
      ...(typeof action.payload.promo_price === "string"
        ? { promo_price: Number(action.payload.promo_price) }
        : {}),
      ...(typeof action.payload.country_of_origin === "string"
        ? { country_of_origin: action.payload.country_of_origin }
        : {}),
      location,
      ...(mediaPublicId ? { media_public_id: mediaPublicId } : {}),
    };
  }
  if (action.actionType === "trigger_sos") {
    const body: Record<string, unknown> = {
      latitude: Number(action.payload.latitude),
      longitude: Number(action.payload.longitude),
      emergency_type: String(action.payload.emergency_type ?? "OTHER"),
      escalation_level: Number(action.payload.escalation_level ?? 1),
      accuracy_m: Number(action.payload.accuracy_m),
      mocked: action.payload.mocked === true,
    };
    const imageUri =
      typeof action.payload.emergency_image_uri === "string"
        ? action.payload.emergency_image_uri
        : null;
    if (imageUri) {
      try {
        body.emergency_image_url = await uploadEmergencyMedia(
          imageUri,
          `sos-offline-${action.id}.jpg`,
          "image/jpeg",
          "image",
        );
      } catch (error) {
        console.error(`Offline SOS photo ${action.id} could not be uploaded:`, error);
      }
    }
    const audioUri =
      typeof action.payload.ambient_audio_uri === "string"
        ? action.payload.ambient_audio_uri
        : null;
    if (audioUri) {
      try {
        body.emergency_audio_url = await uploadEmergencyMedia(
          audioUri,
          `sos-offline-${action.id}.m4a`,
          "audio/mp4",
          "video",
        );
      } catch (error) {
        console.error(`Offline SOS audio ${action.id} could not be uploaded:`, error);
      }
    }
    return body;
  }
  return {
    latitude: Number(action.payload.latitude),
    longitude: Number(action.payload.longitude),
    emergency_type: String(action.payload.emergency_type ?? "OTHER"),
  };
};

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(true);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPromptVisible, setAuthPromptVisible] = useState(false);
  const networkWasOnline = useRef(false);
  const isSyncingQueue = useRef(false);
  const pushTokenRef = useRef<string | null>(null);

  const refreshUser = useCallback(async () => {
    const storedToken = await getStoredAuthToken();
    if (!storedToken) {
      setUser(null);
      return;
    }
    const response = await api.get("/v1/users/me");
    const currentUser = readUser(response.data);
    if (!currentUser) {
      throw new Error("La réponse utilisateur de l'API est invalide.");
    }
    setUser(currentUser);
    setToken(storedToken);
    setAuthError(null);
  }, []);

  const syncQueuedActions = useCallback(async () => {
    if (!user?.id || isOffline || isSyncingQueue.current) return;
    isSyncingQueue.current = true;
    try {
      const actions = await getPendingActions(user.id);
      for (const action of actions) {
        await updateSyncAction(action.id, "processing");
        try {
          await api.post(
            actionEndpoint(action),
            await buildQueuedRequestBody(action),
            { headers: { "Content-Type": "application/json" } },
          );
          await removeSyncAction(action.id);
        } catch (error) {
          await updateSyncAction(action.id, "failed");
          console.error(`Offline action ${action.id} could not be synchronized:`, error);
          break;
        }
      }
    } finally {
      isSyncingQueue.current = false;
    }
  }, [isOffline, user?.id]);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeToNetwork((online) => {
      if (!mounted) return;
      const reconnected = online && !networkWasOnline.current;
      networkWasOnline.current = online;
      setIsOffline(!online);
      if (reconnected) {
        void refreshUser().catch((error: unknown) => {
          if (!mounted) return;
          setAuthError(
            error instanceof Error
              ? error.message
              : "Impossible d'actualiser le profil utilisateur.",
          );
        });
        void syncQueuedActions();
      }
    });
    void NetInfo.fetch().then((state) => {
      if (!mounted) return;
      const online =
        state.isConnected === true && state.isInternetReachable !== false;
      networkWasOnline.current = online;
      setIsOffline(!online);
    });

    void (async () => {
      try {
        const storedToken = await getStoredAuthToken();
        if (!mounted) return;
        if (storedToken) {
          setToken(storedToken);
          await refreshUser();
        }
      } catch (error) {
        if (!mounted) return;
        setAuthError(
          error instanceof Error
            ? error.message
            : "Impossible de restaurer la session.",
        );
      } finally {
        if (mounted) setIsSessionLoading(false);
      }
    })();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [refreshUser, syncQueuedActions]);

  const setSession = useCallback(async (newToken: string, newUser: AuthUser) => {
    if (!newToken.trim() || !newUser.id) {
      throw new Error("Jeton ou profil de session invalide.");
    }
    await clearApiCache();
    await queryClient.cancelQueries();
    queryClient.clear();
    await clearPersistedQueryClient();
    await storeAuthToken(newToken);
    setToken(newToken);
    setUser(newUser);
    setAuthError(null);
    setIsSessionLoading(false);
  }, []);

  const requestPushNotifications = useCallback(async () => {
    if (!user?.id) {
      throw new Error("Connectez-vous pour activer les notifications.");
    }
    const pushToken = await registerPushNotifications(user.id);
    if (pushToken) pushTokenRef.current = pushToken;
    return Boolean(pushToken);
  }, [user?.id]);

  const requestAuthentication = useCallback(() => {
    setAuthPromptVisible(true);
  }, []);
  const dismissAuthPrompt = useCallback(() => {
    setAuthPromptVisible(false);
  }, []);

  const queueOfflineAction = useCallback(
    async (actionType: SyncActionType, payload: Record<string, unknown>) => {
      if (!user?.id) {
        throw new Error("Connectez-vous pour enregistrer une action hors ligne.");
      }
      return enqueueOfflineAction(actionType, user.id, payload);
    },
    [user?.id],
  );

  const signOut = useCallback(async () => {
    const currentUserId = user?.id;
    if (pushTokenRef.current) {
      try {
        await unregisterPushNotifications(pushTokenRef.current);
      } catch (error) {
        console.error("Unable to unregister push notifications on sign out:", error);
      }
      pushTokenRef.current = null;
    }
    await clearStoredAuthToken();
    await clearApiCache();
    if (currentUserId) await clearCachedMessages(currentUserId);
    await queryClient.cancelQueries();
    queryClient.clear();
    await clearPersistedQueryClient();
    setToken(null);
    setUser(null);
    setAuthError(null);
  }, [user?.id]);

  useEffect(() => {
    void syncQueuedActions();
  }, [syncQueuedActions]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      authStatus: isSessionLoading ? "loading" : user ? "connected" : "guest",
      authPromptVisible,
      requestAuthentication,
      dismissAuthPrompt,
      isOffline,
      isSessionLoading,
      authError,
      setSession,
      requestPushNotifications,
      queueOfflineAction,
      refreshUser,
      signOut,
    }),
    [
      user,
      token,
      isSessionLoading,
      authPromptVisible,
      requestAuthentication,
      dismissAuthPrompt,
      isOffline,
      isSessionLoading,
      authError,
      setSession,
      requestPushNotifications,
      queueOfflineAction,
      refreshUser,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth doit être utilisé dans AuthProvider.");
  }
  return context;
};
