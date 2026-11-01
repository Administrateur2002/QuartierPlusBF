import * as Location from "expo-location";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import {
  AlertTriangle,
  Bookmark,
  MapPin,
  Mic,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  RefreshControl,
  Share,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
  useWindowDimensions,
} from "react-native";
import * as MediaLibrary from "expo-media-library";
import * as SecureStore from "expo-secure-store";
import NetInfo from "@react-native-community/netinfo";
import { FlashList } from "@shopify/flash-list";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useVoiceAssistant } from "../context/VoiceAssistantContext";
import {
  cacheAlerts,
  cachePosts,
  getCachedAlerts,
  getCachedPosts,
} from "../services/db";
import { openProfileStore } from "../storage/profileStore";
import { API_BASE_URL, apiFetch } from "../services/api";
import {
  FEED_FILTERS,
  matchesFeedFilter,
  type FeedFilter,
} from "../services/feedFilters";
import {
  uploadCloudinaryMedia,
  type CloudinaryUploadSignature,
  type CloudinaryMediaType,
} from "../services/cloudinaryUpload";
import { MediaUploadError } from "../services/mediaUploadError";
import { compressVideoForUpload } from "../services/videoCompression";
import FeedMedia from "./FeedMedia";
import ProfileAvatar from "../components/ProfileAvatar";
import {
  FEED_SCOPES,
  isFeedCoordinates,
  resolveFeedCountryCode,
  type FeedCoordinates,
  type FeedScope,
} from "../services/feedScopes";

type FeedEntry = {
  id: string;
  kind: "post" | "alert";
  title: string;
  body: string;
  location: string;
  createdAt: string;
  category: string;
  price?: string;
  imageUrl?: string;
  mediaType?: CloudinaryMediaType;
  authorId?: string;
  authorName?: string;
  authorPhotoUrl?: string;
  authorBadge?: string | null;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  authorIsAlly: boolean;
  allianceStatus?: "PENDING" | "ALLIED" | null;
};

type FeedComment = {
  id: string;
  user_id?: string;
  user_name?: string;
  user_photo_url?: string | null;
  user_badge?: string | null;
  user_is_ally?: boolean;
  content: string;
  created_at?: string;
  edited_at?: string | null;
  parent_comment_id?: string | null;
  likes_count?: number;
  liked_by_me?: boolean;
};

type FeedError = {
  message: string;
  details: string;
};

type DraftMedia = {
  uri: string;
  filename: string;
  mimeType: string;
  resourceType: CloudinaryMediaType;
  size: number;
  duration?: number;
};

type MediaSignature = CloudinaryUploadSignature & {
  max_bytes: number;
  max_duration_seconds: number | null;
};

class PublicationApiError extends Error {}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_DIMENSION = 1600;

class FeedHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(
      status === 401
        ? "Votre session a expiré. Reconnectez-vous puis réessayez."
        : status === 404
          ? "La ressource du fil est introuvable. Réessayez dans un instant."
          : status >= 500
            ? "Le serveur rencontre une erreur. Réessayez dans un instant."
            : `Le chargement a échoué (HTTP ${status}). Réessayez.`,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordsFrom = (payload: unknown, key: string) => {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload[key])) return payload[key];
  throw new Error(`La réponse ${key} du fil est invalide.`);
};

const normalizePost = (value: unknown): FeedEntry | null => {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? "");
  const mediaType =
    value.media_type === "video" ? "video" : "image";
  const title = String(
    value.title ??
      value.name ??
      value.caption ??
      (value.media_url ? "Photo du quartier" : "Publication du quartier"),
  );
  if (!id || !title) return null;
  const free = value.is_free === true || value.isFree === true;
  const price = value.price;
  return {
    id,
    kind: "post",
    title,
    body: String(value.description ?? value.caption ?? ""),
    location: String(value.neighborhood ?? value.location_name ?? ""),
    createdAt: String(value.created_at ?? value.createdAt ?? ""),
    category: String(value.category ?? "Annonce"),
    imageUrl:
      typeof (value.media_url ?? value.image_url) === "string"
        ? String(value.media_url ?? value.image_url)
        : undefined,
    mediaType,
    authorId: typeof value.author_id === "string" ? value.author_id : undefined,
    authorName:
      typeof value.author_name === "string" ? value.author_name : undefined,
    authorPhotoUrl:
      typeof value.author_photo_url === "string" ? value.author_photo_url : undefined,
    authorBadge:
      typeof value.author_badge === "string" ? value.author_badge : null,
    likesCount: Number(value.likes_count ?? 0),
    commentsCount: Number(value.comments_count ?? 0),
    likedByMe: value.liked_by_me === true,
    authorIsAlly: value.author_is_ally === true,
    price:
      free
        ? "Gratuit / Don"
        : price === undefined || price === null
          ? undefined
          : `${new Intl.NumberFormat("fr-FR").format(Number(price))} FCFA`,
  };
};

const normalizeAlert = (value: unknown): FeedEntry | null => {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? value.sos_id ?? "");
  const title = String(
    value.title ?? value.emergency_type ?? value.category ?? "Alerte communautaire",
  );
  if (!id) return null;
  const distance = Number(value.distance_m ?? value.distanceMeters);
  const distanceLabel =
    Number.isFinite(distance) && distance >= 0
      ? `À environ ${Math.max(1, Math.round(distance / 1000))} km`
      : "À proximité";
  return {
    id,
    kind: "alert",
    title,
    body: String(value.description ?? value.message ?? "Signalement actif dans le quartier."),
    location: distanceLabel,
    createdAt: String(value.created_at ?? value.createdAt ?? ""),
    category: String(value.category ?? value.emergency_type ?? "Urgence"),
    likesCount: 0,
    commentsCount: 0,
    likedByMe: false,
    authorIsAlly: false,
  };
};

const sortEntries = (entries: FeedEntry[]) =>
  [...entries].sort((left, right) => {
    const leftDate = Date.parse(left.createdAt);
    const rightDate = Date.parse(right.createdAt);
    if (!Number.isFinite(leftDate)) return 1;
    if (!Number.isFinite(rightDate)) return -1;
    return rightDate - leftDate;
  });

const formatDate = (date: string) => {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return "Publication récente";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "À l’instant";
  if (elapsedMinutes < 60) return `Il y a ${elapsedMinutes} min`;
  if (elapsedMinutes < 24 * 60) {
    return `Il y a ${Math.floor(elapsedMinutes / 60)} h`;
  }
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
};

export default function FeedScreen() {
  const { colors } = useTheme();
  const { authStatus, isOffline, requestAuthentication, queueOfflineAction, user } = useAuth();
  const { requestAssistant } = useVoiceAssistant();
  const { width: pageWidth } = useWindowDimensions();
  const { height: windowHeight } = useWindowDimensions();
  const pagerRef = useRef<ScrollView>(null);
  const [scope, setScope] = useState<FeedScope>("country");
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<FeedCoordinates | null>(null);
  const [scopeReady, setScopeReady] = useState(false);
  const [locationInvitation, setLocationInvitation] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [savedPostIds, setSavedPostIds] = useState<string[]>([]);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("Tout");
  const visibleEntries = entries.filter((entry) =>
    (!showSavedOnly || savedPostIds.includes(entry.id)) &&
    matchesFeedFilter(entry, feedFilter),
  );
  const [dataSaverEnabled, setDataSaverEnabled] = useState(false);
  const [autoDataSaver, setAutoDataSaver] = useState(false);
  const [wifiOnlyVideoAutoplay, setWifiOnlyVideoAutoplay] = useState(false);
  const [isWifiConnected, setIsWifiConnected] = useState(false);
  const [feedPreferencesReady, setFeedPreferencesReady] = useState(false);
  const [feedSettingsOpen, setFeedSettingsOpen] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [blockedUsersError, setBlockedUsersError] = useState<string | null>(null);
  const lowDataMode = dataSaverEnabled || autoDataSaver;
  const [pageOffsets, setPageOffsets] = useState({ marketplace: 0, feed: 0 });
  const [hasMoreMarketplace, setHasMoreMarketplace] = useState(true);
  const [hasMoreFeed, setHasMoreFeed] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const cardLayoutsRef = useRef<Array<{ top: number; height: number }>>([]);

  useEffect(() => {
    cardLayoutsRef.current = [];
    setActiveMediaIndex(0);
  }, [feedFilter, showSavedOnly]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<FeedError | null>(null);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [isServerRequestPending, setIsServerRequestPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [composerStage, setComposerStage] = useState<
    "closed" | "menu" | "preview"
  >("closed");
  const [draftMedia, setDraftMedia] = useState<DraftMedia | null>(null);
  const [draftCaption, setDraftCaption] = useState("");
  const [draftScope, setDraftScope] = useState<FeedScope>("country");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCompressingVideo, setIsCompressingVideo] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedPost, setSelectedPost] = useState<FeedEntry | null>(null);
  const [actionPost, setActionPost] = useState<FeedEntry | null>(null);
  const [reportTarget, setReportTarget] = useState<{
    type: "post" | "comment" | "profile";
    id: string;
    label: string;
  } | null>(null);
  const [repostPost, setRepostPost] = useState<FeedEntry | null>(null);
  const [repostCaption, setRepostCaption] = useState("");
  const [isReposting, setIsReposting] = useState(false);
  const [comments, setComments] = useState<FeedComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [commentsOffset, setCommentsOffset] = useState(0);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [replyingToComment, setReplyingToComment] = useState<FeedComment | null>(null);
  const [editingComment, setEditingComment] = useState<FeedComment | null>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync("quartierplus.feed.saved-posts")
      .then((saved) => {
        const parsed: unknown = saved ? JSON.parse(saved) : [];
        if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
          throw new Error("La liste des publications enregistrées est invalide.");
        }
        if (active) setSavedPostIds(parsed);
      })
      .catch((favoriteError: unknown) => {
        console.warn("Unable to load saved feed posts:", favoriteError);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      SecureStore.getItemAsync("quartierplus.feed.data-saver"),
      SecureStore.getItemAsync("quartierplus.feed.wifi-autoplay"),
    ]).then(([dataSaver, wifiAutoplay]) => {
      if (!active) return;
      setDataSaverEnabled(dataSaver === "true");
      setWifiOnlyVideoAutoplay(wifiAutoplay === "true");
      setFeedPreferencesReady(true);
    }).catch((preferenceError: unknown) => {
      console.warn("Unable to load feed preferences:", preferenceError);
      if (active) setFeedPreferencesReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!feedPreferencesReady) return;
    void Promise.all([
      SecureStore.setItemAsync("quartierplus.feed.data-saver", String(dataSaverEnabled)),
      SecureStore.setItemAsync("quartierplus.feed.wifi-autoplay", String(wifiOnlyVideoAutoplay)),
    ]).catch((preferenceError: unknown) => {
      console.warn("Unable to save feed preferences:", preferenceError);
    });
  }, [dataSaverEnabled, feedPreferencesReady, wifiOnlyVideoAutoplay]);

  useEffect(
    () =>
      NetInfo.addEventListener((state) => {
        setIsWifiConnected(state.type === "wifi" && state.isConnected === true);
        const expensive =
          state.details !== null &&
          "isConnectionExpensive" in state.details &&
          state.details.isConnectionExpensive === true;
        const lowGeneration =
          state.type === "cellular" &&
          (state.details.cellularGeneration === "2g" ||
            state.details.cellularGeneration === "3g");
        setAutoDataSaver(expensive || lowGeneration);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let configuredCountryCode: string | null = null;
      try {
        configuredCountryCode = (await (await openProfileStore()).getCountry())
          ?.code ?? null;
      } catch (loadError) {
        console.warn("Unable to read the configured feed country:", loadError);
      }
      const inferredCountryCode = resolveFeedCountryCode({
        userCountryCode: user?.country_code,
        phoneNumber: user?.phone_number,
        deviceLocale: Intl.DateTimeFormat().resolvedOptions().locale,
        configuredCountryCode,
      });
      let knownPosition: FeedCoordinates | null = null;
      if (authStatus !== "guest") {
        try {
          const savedPosition = await SecureStore.getItemAsync(
            "quartierplus.feed.last-position",
          );
          if (savedPosition) {
            const parsed: unknown = JSON.parse(savedPosition);
            if (isFeedCoordinates(parsed)) knownPosition = parsed;
          }
          const permission = await Location.getForegroundPermissionsAsync();
          if (permission.granted) {
            const lastKnown = await Location.getLastKnownPositionAsync();
            if (lastKnown) {
              knownPosition = {
                latitude: lastKnown.coords.latitude,
                longitude: lastKnown.coords.longitude,
              };
            } else if (!knownPosition) {
              const current = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
              });
              knownPosition = {
                latitude: current.coords.latitude,
                longitude: current.coords.longitude,
              };
            }
          }
        } catch (locationError) {
          console.warn("Unable to read the last known feed location:", locationError);
        }
      }
      if (cancelled) return;
      setCountryCode(inferredCountryCode);
      setCoordinates(knownPosition);
      setScope(knownPosition && authStatus !== "guest" ? "neighborhood" : "country");
      setLocationInvitation(!knownPosition);
      setScopeReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authStatus, user?.country_code, user?.phone_number]);

  const loadCachedFeed = useCallback(async () => {
    const [posts, alerts] = await Promise.all([
      getCachedPosts<unknown[]>(),
      getCachedAlerts<unknown[]>(),
    ]);
    const cachedPosts = posts.map(normalizePost).filter(
      (entry): entry is FeedEntry => entry !== null,
    );
    const cachedAlerts = alerts.map(normalizeAlert).filter(
      (entry): entry is FeedEntry => entry !== null,
    );
    setEntries(sortEntries([...cachedPosts, ...cachedAlerts]));
    return cachedPosts.length + cachedAlerts.length;
  }, []);

  const movePagerTo = useCallback(
    (nextScope: FeedScope) => {
      const index = FEED_SCOPES.findIndex((option) => option.id === nextScope);
      pagerRef.current?.scrollTo({ x: index * pageWidth, animated: true });
    },
    [pageWidth],
  );

  const chooseScope = useCallback(
    async (nextScope: FeedScope) => {
      if (nextScope === "neighborhood" || nextScope === "region") {
        if (authStatus === "guest") {
          requestAuthentication();
          movePagerTo(scope);
          return;
        }
        let nextCoordinates = coordinates;
        if (!nextCoordinates) {
          try {
            const permission =
              await Location.requestForegroundPermissionsAsync();
            if (!permission.granted) {
              setScope("country");
              setLocationInvitation(true);
              movePagerTo("country");
              return;
            }
            const position = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            nextCoordinates = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            };
            await SecureStore.setItemAsync(
              "quartierplus.feed.last-position",
              JSON.stringify(nextCoordinates),
            );
            setCoordinates(nextCoordinates);
          } catch (locationError) {
            console.warn("Unable to activate location-based feed scope:", locationError);
            setScope("country");
            setLocationInvitation(true);
            movePagerTo("country");
            return;
          }
        }
        if (!nextCoordinates) {
          setScope("country");
          setLocationInvitation(true);
          movePagerTo("country");
          return;
        }
      }
      setScope(nextScope);
      setLocationInvitation(false);
      movePagerTo(nextScope);
    },
    [
      authStatus,
      coordinates,
      movePagerTo,
      requestAuthentication,
      scope,
    ],
  );

  useEffect(() => {
    if (!scopeReady) return;
    const index = FEED_SCOPES.findIndex((option) => option.id === scope);
    pagerRef.current?.scrollTo({ x: index * pageWidth, animated: false });
  }, [pageWidth, scope, scopeReady]);

  useEffect(() => {
    setActiveMediaIndex(0);
    cardLayoutsRef.current = [];
  }, [scope, refreshKey]);

  useEffect(() => {
    if (!scopeReady || !countryCode) return;
    let cancelled = false;
    const controller = new AbortController();
    const loadFeed = async () => {
      setError(null);
      setShowTechnicalDetails(false);
      setIsServerRequestPending(false);
      try {
        if (authStatus === "guest") {
          if (!API_BASE_URL || isOffline) {
            setEntries([]);
            setError({
              message: "Les publications publiques sont temporairement indisponibles.",
              details: !API_BASE_URL
                ? "EXPO_PUBLIC_API_URL n'est pas configurée."
                : "Le mode invité est hors ligne.",
            });
            return;
          }
          setIsServerRequestPending(true);
          const query = new URLSearchParams({
            scope,
            country_code: countryCode,
          });
          const [response, feedResponse] = await Promise.all([
            apiFetch(
            `${API_BASE_URL}/v1/public/marketplace?${query.toString()}`,
            {
              signal: controller.signal,
              timeoutMs: 60_000,
            },
            ),
            apiFetch(`${API_BASE_URL}/v1/feed?${query.toString()}`, {
              signal: controller.signal,
              timeoutMs: 60_000,
            }),
          ]);
          if (!cancelled) setIsServerRequestPending(false);
          if (!response.ok) {
            throw new FeedHttpError("/v1/public/marketplace", response.status);
          }
          if (!feedResponse.ok) {
            throw new FeedHttpError("/v1/feed", feedResponse.status);
          }
          const [payload, feedPayload] = await Promise.all([
            response.json(),
            feedResponse.json(),
          ]);
          const rawPosts = recordsFrom(payload, "items");
          const rawFeedPosts = recordsFrom(feedPayload, "posts");
          const posts = [...rawPosts, ...rawFeedPosts].map(normalizePost).filter(
            (entry): entry is FeedEntry => entry !== null,
          );
          if (!cancelled) {
            setEntries(sortEntries(posts));
            setPageOffsets({
              marketplace: rawPosts.length,
              feed: rawFeedPosts.length,
            });
            setHasMoreMarketplace(rawPosts.length === 100);
            setHasMoreFeed(rawFeedPosts.length === 100);
          }
          return;
        }
        if (!API_BASE_URL) {
          throw new Error("L'adresse du serveur n'est pas configurée.");
        }
        const cachedCount = await loadCachedFeed();
        if (isOffline) {
          if (!cancelled) {
            setError({
              message: cachedCount > 0
                ? "Mode hors ligne : affichage des données enregistrées sur cet appareil."
                : "Mode hors ligne : aucune publication ou alerte n'a encore été mise en cache.",
              details: "NetInfo signale une absence de connexion Internet.",
            });
          }
          return;
        }
        if (!cancelled && cachedCount > 0) setIsLoading(false);
        if (
          (scope === "neighborhood" || scope === "region") &&
          !coordinates
        ) {
          if (!cancelled) {
            setScope("country");
            setLocationInvitation(true);
          }
          return;
        }
        const query = new URLSearchParams({ scope, country_code: countryCode });
        if (coordinates && (scope === "neighborhood" || scope === "region")) {
          query.set("latitude", String(coordinates.latitude));
          query.set("longitude", String(coordinates.longitude));
        }

        setIsServerRequestPending(true);
        const [postsResponse, alertsResponse, feedResponse] = await Promise.all([
          apiFetch(
            `${API_BASE_URL}/v1/public/marketplace?${query.toString()}`,
            { signal: controller.signal, timeoutMs: 60_000 },
          ),
          apiFetch(
            `${API_BASE_URL}/v1/sos/alerts?${query.toString()}`,
            { signal: controller.signal, timeoutMs: 60_000 },
          ),
          apiFetch(`${API_BASE_URL}/v1/feed?${query.toString()}`, {
            signal: controller.signal,
            timeoutMs: 60_000,
          }),
        ]);
        if (!cancelled) setIsServerRequestPending(false);
        if (!postsResponse.ok) {
          throw new FeedHttpError(
            "/v1/public/marketplace",
            postsResponse.status,
          );
        }
        if (!alertsResponse.ok) {
          throw new FeedHttpError(
            "/v1/sos/alerts",
            alertsResponse.status,
          );
        }
        if (!feedResponse.ok) {
          throw new FeedHttpError("/v1/feed", feedResponse.status);
        }

        const [postsPayload, alertsPayload, feedPayload] = await Promise.all([
          postsResponse.json(),
          alertsResponse.json(),
          feedResponse.json(),
        ]);
        const rawPosts = recordsFrom(postsPayload, "items");
        const rawAlerts = recordsFrom(alertsPayload, "alerts");
        const rawFeedPosts = recordsFrom(feedPayload, "posts");
        const posts = [...rawPosts, ...rawFeedPosts].map(normalizePost).filter(
          (entry): entry is FeedEntry => entry !== null,
        );
        const alerts = rawAlerts.map(normalizeAlert).filter(
          (entry): entry is FeedEntry => entry !== null,
        );
        await Promise.all([
          cachePosts([...rawPosts, ...rawFeedPosts]),
          cacheAlerts(rawAlerts),
        ]);
        if (!cancelled) {
          setEntries(sortEntries([...posts, ...alerts]));
          setPageOffsets({
            marketplace: rawPosts.length,
            feed: rawFeedPosts.length,
          });
          setHasMoreMarketplace(rawPosts.length === 100);
          setHasMoreFeed(rawFeedPosts.length === 100);
        }
      } catch (loadError) {
        if (cancelled || controller.signal.aborted) return;
        if (authStatus === "guest") {
          setEntries([]);
          setError({
            message: "Les publications publiques sont temporairement indisponibles.",
            details:
              loadError instanceof FeedHttpError
                ? `${loadError.path} — HTTP ${loadError.status}`
                : loadError instanceof Error
                  ? loadError.message
                  : "Erreur réseau inconnue.",
          });
          return;
        }
        let cachedCount = 0;
        try {
          cachedCount = await loadCachedFeed();
        } catch (cacheError) {
          console.error("Unable to read the local neighborhood feed:", cacheError);
        }
        setError({
          message:
            cachedCount > 0
              ? "Connexion indisponible : affichage du fil enregistré sur cet appareil."
              : "Impossible de charger le fil pour le moment. Vérifiez votre connexion puis réessayez.",
          details:
            loadError instanceof FeedHttpError
              ? `${loadError.path} — HTTP ${loadError.status}`
              : loadError instanceof Error
                ? loadError.message
                : "Erreur réseau inconnue.",
        });
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsRefreshing(false);
          setIsServerRequestPending(false);
        }
      }
    };
    void loadFeed();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    authStatus,
    countryCode,
    coordinates,
    isOffline,
    loadCachedFeed,
    refreshKey,
    scope,
    scopeReady,
  ]);

  const refresh = () => {
    setIsRefreshing(true);
    setRefreshKey((current) => current + 1);
  };

  const loadMore = async () => {
    if (
      !API_BASE_URL ||
      isOffline ||
      isRefreshing ||
      loadingMoreRef.current ||
      (!hasMoreMarketplace && !hasMoreFeed)
    ) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const query = new URLSearchParams({ scope, country_code: countryCode ?? "" });
    if (coordinates && (scope === "neighborhood" || scope === "region")) {
      query.set("latitude", String(coordinates.latitude));
      query.set("longitude", String(coordinates.longitude));
    }
    const marketplaceQuery = new URLSearchParams(query);
    marketplaceQuery.set("offset", String(pageOffsets.marketplace));
    const feedQuery = new URLSearchParams(query);
    feedQuery.set("offset", String(pageOffsets.feed));
    try {
      const [marketplaceResponse, feedResponse] = await Promise.all([
        hasMoreMarketplace
          ? apiFetch(`${API_BASE_URL}/v1/public/marketplace?${marketplaceQuery}`)
          : Promise.resolve(null),
        hasMoreFeed
          ? apiFetch(`${API_BASE_URL}/v1/feed?${feedQuery}`)
          : Promise.resolve(null),
      ]);
      if (marketplaceResponse && !marketplaceResponse.ok) {
        throw new FeedHttpError("/v1/public/marketplace", marketplaceResponse.status);
      }
      if (feedResponse && !feedResponse.ok) {
        throw new FeedHttpError("/v1/feed", feedResponse.status);
      }
      const [marketplacePayload, feedPayload] = await Promise.all([
        marketplaceResponse?.json() ?? Promise.resolve({ items: [] }),
        feedResponse?.json() ?? Promise.resolve({ posts: [] }),
      ]);
      const rawMarketplace = recordsFrom(marketplacePayload, "items");
      const rawFeed = recordsFrom(feedPayload, "posts");
      const nextEntries = [...rawMarketplace, ...rawFeed]
        .map(normalizePost)
        .filter((entry): entry is FeedEntry => entry !== null);
      setEntries((current) => {
        const existingIds = new Set(current.map((entry) => `${entry.kind}:${entry.id}`));
        return sortEntries([
          ...current,
          ...nextEntries.filter((entry) => !existingIds.has(`${entry.kind}:${entry.id}`)),
        ]);
      });
      setPageOffsets((current) => ({
        marketplace: current.marketplace + rawMarketplace.length,
        feed: current.feed + rawFeed.length,
      }));
      if (hasMoreMarketplace && rawMarketplace.length < 100) setHasMoreMarketplace(false);
      if (hasMoreFeed && rawFeed.length < 100) setHasMoreFeed(false);
    } catch (loadError) {
      const details =
        loadError instanceof FeedHttpError
          ? `${loadError.path} — HTTP ${loadError.status}`
          : loadError instanceof Error
            ? loadError.message
            : "Erreur réseau inconnue.";
      setError({ message: "Impossible de charger la suite du fil.", details });
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  };

  const likePost = async (entry: FeedEntry) => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    const likedByMe = !entry.likedByMe;
    const nextCount = Math.max(0, entry.likesCount + (likedByMe ? 1 : -1));
    const update = (postId: string, liked: boolean, count: number) => {
      setEntries((current) =>
        current.map((item) =>
          item.id === postId
            ? { ...item, likedByMe: liked, likesCount: count }
            : item,
        ),
      );
    };
    update(entry.id, likedByMe, nextCount);
    Vibration.vibrate(10);
    if (isOffline) {
      try {
        await queueOfflineAction("toggle_post_like", { post_id: entry.id });
      } catch (queueError) {
        update(entry.id, entry.likedByMe, entry.likesCount);
        Alert.alert(
          "J’adore non enregistré",
          queueError instanceof Error ? queueError.message : "Réessayez.",
        );
      }
      return;
    }
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/posts/${encodeURIComponent(entry.id)}/like`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`J’adore indisponible (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.liked !== "boolean" || typeof payload.count !== "number") {
        throw new Error("La réponse du serveur pour J’adore est invalide.");
      }
      update(entry.id, payload.liked, payload.count);
    } catch (actionError) {
      update(entry.id, entry.likedByMe, entry.likesCount);
      Alert.alert(
        "J’adore non envoyé",
        actionError instanceof Error ? actionError.message : "Réessayez.",
      );
    }
  };

  const openComments = async (entry: FeedEntry) => {
    setSelectedPost(entry);
    setComments([]);
    setCommentsError(null);
    setCommentsHasMore(false);
    setCommentsOffset(0);
    if (!API_BASE_URL) {
      setCommentsError("Le service de commentaires est indisponible.");
      return;
    }
    setCommentsLoading(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/posts/${encodeURIComponent(entry.id)}/comments?limit=30&offset=0`,
      );
      if (!response.ok) throw new Error(`Commentaires indisponibles (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.comments)) {
        throw new Error("La liste des commentaires est invalide.");
      }
      setComments(payload.comments.filter(
        (item): item is FeedComment =>
          isRecord(item) && typeof item.id === "string" && typeof item.content === "string",
      ));
      setCommentsHasMore(payload.has_more === true);
      setCommentsOffset(typeof payload.next_offset === "number" ? payload.next_offset : 0);
    } catch (commentError) {
      setCommentsError(commentError instanceof Error ? commentError.message : "Réessayez.");
    } finally {
      setCommentsLoading(false);
    }
  };

  const loadMoreComments = async () => {
    const post = selectedPost;
    if (!post || !API_BASE_URL || !commentsHasMore || loadingMoreComments) return;
    setLoadingMoreComments(true);
    setCommentsError(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/posts/${encodeURIComponent(post.id)}/comments?limit=30&offset=${commentsOffset}`,
      );
      if (!response.ok) throw new Error(`Commentaires indisponibles (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.comments)) {
        throw new Error("La liste des commentaires est invalide.");
      }
      const nextComments = payload.comments.filter(
        (item): item is FeedComment =>
          isRecord(item) && typeof item.id === "string" && typeof item.content === "string",
      );
      setComments((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...nextComments.filter((item) => !existingIds.has(item.id))];
      });
      setCommentsHasMore(payload.has_more === true);
      setCommentsOffset(typeof payload.next_offset === "number" ? payload.next_offset : commentsOffset);
    } catch (commentError) {
      setCommentsError(commentError instanceof Error ? commentError.message : "Réessayez.");
    } finally {
      setLoadingMoreComments(false);
    }
  };

  const sendComment = async () => {
    const post = selectedPost;
    const content = commentDraft.trim();
    if (!post || !content || sendingComment) return;
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;

    if (editingComment) {
      setSendingComment(true);
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/social/comments/${encodeURIComponent(editingComment.id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          },
        );
        if (!response.ok) throw new Error(`Modification refusée (HTTP ${response.status}).`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.comment)) {
          throw new Error("La réponse de modification est invalide.");
        }
        const updatedComment = payload.comment as Record<string, unknown>;
        setComments((current) => current.map((item) => item.id === editingComment.id
          ? { ...item, content, edited_at: typeof updatedComment.edited_at === "string" ? updatedComment.edited_at : new Date().toISOString() }
          : item));
        setCommentDraft("");
        setEditingComment(null);
      } catch (commentError) {
        Alert.alert("Modification impossible", commentError instanceof Error ? commentError.message : "Réessayez.");
      } finally {
        setSendingComment(false);
      }
      return;
    }

    if (isOffline && replyingToComment) {
      Alert.alert("Connexion requise", "Reconnectez-vous pour répondre à ce commentaire.");
      return;
    }

    const optimisticId = `local-${Date.now()}`;
    const optimisticComment: FeedComment = {
      id: optimisticId,
      user_id: user?.id,
      user_name: typeof user?.name === "string" ? user.name : "Vous",
      user_photo_url:
        typeof user?.profile_photo_url === "string" ? user.profile_photo_url : null,
      user_badge: typeof user?.badge === "string" ? user.badge : null,
      user_is_ally: false,
      content,
      created_at: new Date().toISOString(),
      parent_comment_id: replyingToComment?.id ?? null,
      likes_count: 0,
      liked_by_me: false,
    };
    setComments((current) => [optimisticComment, ...current]);
    setCommentDraft("");
    setSendingComment(true);
    setEntries((current) => current.map((entry) =>
      entry.id === post.id
        ? { ...entry, commentsCount: entry.commentsCount + 1 }
        : entry,
    ));
    Vibration.vibrate(10);
    if (isOffline) {
      try {
        await queueOfflineAction("create_post_comment", {
          post_id: post.id,
          content,
        });
      } catch (queueError) {
        setComments((current) => current.filter((item) => item.id !== optimisticId));
        setEntries((current) => current.map((entry) =>
          entry.id === post.id
            ? { ...entry, commentsCount: Math.max(0, entry.commentsCount - 1) }
            : entry,
        ));
        setCommentDraft(content);
        Alert.alert(
          "Commentaire non enregistré",
          queueError instanceof Error ? queueError.message : "Réessayez.",
        );
      } finally {
        setSendingComment(false);
      }
      return;
    }
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/posts/${encodeURIComponent(post.id)}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            parent_comment_id: replyingToComment?.id ?? null,
          }),
        },
      );
      if (!response.ok) throw new Error(`Commentaire refusé (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.comment) || typeof payload.comment.id !== "string") {
        throw new Error("La réponse du commentaire est invalide.");
      }
      const createdComment = payload.comment as Record<string, unknown>;
      setComments((current) => current.map((item) =>
        item.id === optimisticId
          ? {
              ...optimisticComment,
              ...createdComment,
              user_id: user?.id,
              user_name: optimisticComment.user_name,
              content,
            }
          : item,
      ));
      setReplyingToComment(null);
    } catch (commentError) {
      setComments((current) => current.filter((item) => item.id !== optimisticId));
      setEntries((current) => current.map((entry) =>
        entry.id === post.id
          ? { ...entry, commentsCount: Math.max(0, entry.commentsCount - 1) }
          : entry,
      ));
      setCommentDraft(content);
      Alert.alert(
        "Commentaire non envoyé",
        commentError instanceof Error ? commentError.message : "Réessayez.",
      );
    } finally {
      setSendingComment(false);
    }
  };

  const toggleCommentLike = async (comment: FeedComment) => {
    if (!API_BASE_URL || comment.id.startsWith("local-")) return;
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    const wasLiked = comment.liked_by_me === true;
    const previousCount = comment.likes_count ?? 0;
    setComments((current) => current.map((item) => item.id === comment.id
      ? { ...item, liked_by_me: !wasLiked, likes_count: Math.max(0, previousCount + (wasLiked ? -1 : 1)) }
      : item));
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/comments/${encodeURIComponent(comment.id)}/like`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`Réaction refusée (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.liked !== "boolean" || typeof payload.count !== "number") {
        throw new Error("La réponse de réaction est invalide.");
      }
      setComments((current) => current.map((item) => item.id === comment.id
        ? { ...item, liked_by_me: payload.liked as boolean, likes_count: payload.count as number }
        : item));
    } catch (reactionError) {
      setComments((current) => current.map((item) => item.id === comment.id
        ? { ...item, liked_by_me: wasLiked, likes_count: previousCount }
        : item));
      Alert.alert("Réaction non envoyée", reactionError instanceof Error ? reactionError.message : "Réessayez.");
    }
  };

  const deleteComment = (comment: FeedComment) => {
    if (!API_BASE_URL || comment.id.startsWith("local-")) return;
    Alert.alert("Supprimer ce commentaire ?", "Cette action est définitive.", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Supprimer",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              const response = await apiFetch(
                `${API_BASE_URL}/v1/social/comments/${encodeURIComponent(comment.id)}`,
                { method: "DELETE" },
              );
              if (!response.ok) throw new Error(`Suppression refusée (HTTP ${response.status}).`);
              setComments((current) => current.filter((item) => item.id !== comment.id));
              setEntries((current) => current.map((entry) => entry.id === selectedPost?.id
                ? { ...entry, commentsCount: Math.max(0, entry.commentsCount - 1) }
                : entry));
            } catch (deleteError) {
              Alert.alert("Suppression impossible", deleteError instanceof Error ? deleteError.message : "Réessayez.");
            }
          })();
        },
      },
    ]);
  };

  const requestAlliance = async (entry: FeedEntry) => {
    if (!entry.authorId || entry.authorId === user?.id) return;
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliance/${encodeURIComponent(entry.authorId)}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`Demande impossible (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !["PENDING", "ALLIED"].includes(String(payload.status))) {
        throw new Error("La réponse d’alliance est invalide.");
      }
      const status = payload.status as "PENDING" | "ALLIED";
      setEntries((current) => current.map((item) =>
        item.authorId === entry.authorId
          ? { ...item, allianceStatus: status, authorIsAlly: status === "ALLIED" }
          : item,
      ));
    } catch (allianceError) {
      Alert.alert(
        "Alliance indisponible",
        allianceError instanceof Error ? allianceError.message : "Réessayez.",
      );
    }
  };

  const sharePost = async (entry: FeedEntry) => {
    try {
      await Share.share({
        message: `${entry.title}${entry.imageUrl ? `\n${entry.imageUrl}` : ""}`,
        url: entry.imageUrl,
      });
    } catch (shareError) {
      Alert.alert(
        "Partage impossible",
        shareError instanceof Error ? shareError.message : "Réessayez.",
      );
    }
  };

  const copyPostLink = async (entry: FeedEntry) => {
    if (!entry.imageUrl) {
      Alert.alert("Lien indisponible", "Cette publication ne contient pas de lien média public.");
      return;
    }
    try {
      await Clipboard.setStringAsync(entry.imageUrl);
      setActionPost(null);
      Alert.alert("Lien copié", "Le lien du média est dans le presse-papiers.");
    } catch (clipboardError) {
      Alert.alert(
        "Copie impossible",
        clipboardError instanceof Error ? clipboardError.message : "Réessayez.",
      );
    }
  };

  const savePostFavorite = async (entry: FeedEntry) => {
    try {
      const saved = await SecureStore.getItemAsync("quartierplus.feed.saved-posts");
      const savedIds: unknown = saved ? JSON.parse(saved) : [];
      if (!Array.isArray(savedIds) || savedIds.some((id) => typeof id !== "string")) {
        throw new Error("La liste des favoris est invalide.");
      }
      const alreadySaved = savedIds.includes(entry.id);
      const nextSavedIds = alreadySaved
        ? savedIds.filter((id) => id !== entry.id)
        : [...savedIds, entry.id];
      await SecureStore.setItemAsync("quartierplus.feed.saved-posts", JSON.stringify(nextSavedIds));
      setSavedPostIds(nextSavedIds);
      setActionPost(null);
      Alert.alert(
        alreadySaved ? "Retirée des favoris" : "Ajoutée aux favoris",
        alreadySaved
          ? "Cette publication n’est plus enregistrée sur cet appareil."
          : "Cette publication est enregistrée sur cet appareil.",
      );
    } catch (favoriteError) {
      Alert.alert(
        "Favori non enregistré",
        favoriteError instanceof Error ? favoriteError.message : "Réessayez.",
      );
    }
  };

  const hidePost = (entry: FeedEntry) => {
    setEntries((current) => current.filter((item) => item.id !== entry.id));
    setActionPost(null);
  };

  const loadBlockedUsers = async () => {
    if (!API_BASE_URL || authStatus !== "connected") {
      setBlockedUsers([]);
      setBlockedUsersError("Connectez-vous pour gérer les comptes bloqués.");
      return;
    }
    setBlockedUsersError(null);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/social/blocked-users`);
      if (!response.ok) throw new Error(`Chargement refusé (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.blocked_users)) {
        throw new Error("La liste des comptes bloqués est invalide.");
      }
      setBlockedUsers(payload.blocked_users.filter(
        (item): item is { id: string; name: string } =>
          isRecord(item) && typeof item.id === "string" && typeof item.name === "string",
      ));
    } catch (blockedError) {
      setBlockedUsersError(blockedError instanceof Error ? blockedError.message : "Réessayez.");
    }
  };

  const unblockAuthor = async (blockedId: string) => {
    if (!API_BASE_URL) return;
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/users/${encodeURIComponent(blockedId)}/block`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(`Déblocage refusé (HTTP ${response.status}).`);
      setBlockedUsers((current) => current.filter((blocked) => blocked.id !== blockedId));
      refresh();
    } catch (unblockError) {
      Alert.alert("Déblocage impossible", unblockError instanceof Error ? unblockError.message : "Réessayez.");
    }
  };

  const blockAuthor = (entry: FeedEntry) => {
    if (!entry.authorId || entry.authorId === user?.id) return;
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    const authorId = entry.authorId;
    setActionPost(null);
    Alert.alert(
      "Bloquer cet utilisateur ?",
      "Ses publications seront masquées et il ne pourra plus vous envoyer de message privé.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Bloquer",
          style: "destructive",
          onPress: () => {
            void apiFetch(`${API_BASE_URL}/v1/social/users/${encodeURIComponent(authorId)}/block`, {
              method: "POST",
            }).then(async (response) => {
              if (!response.ok) throw new Error(`Blocage refusé (HTTP ${response.status}).`);
              const payload: unknown = await response.json();
              if (!isRecord(payload) || payload.blocked !== true) {
                throw new Error("La confirmation du blocage est invalide.");
              }
              setEntries((current) => current.filter((item) => item.authorId !== authorId));
              Alert.alert("Utilisateur bloqué", "Ses publications sont masquées et les messages privés sont bloqués.");
            }).catch((blockError: unknown) => {
              Alert.alert("Blocage impossible", blockError instanceof Error ? blockError.message : "Réessayez.");
            });
          },
        },
      ],
    );
  };

  const openReportReasons = (
    type: "post" | "comment" | "profile",
    id: string,
    label: string,
  ) => {
    if (!API_BASE_URL || authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    setActionPost(null);
    setReportTarget({ type, id, label });
  };

  const confirmReport = (reason: string) => {
    const target = reportTarget;
    if (!target || !API_BASE_URL) return;
    setReportTarget(null);
    Alert.alert(
      "Motif du signalement",
      `${target.label} ne sera pas supprimé automatiquement. Confirmer l’envoi ?`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Confirmer",
          style: "destructive",
          onPress: () => {
            void apiFetch(`${API_BASE_URL}/v1/reports`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                target_type: target.type,
                target_id: target.id,
                reason,
              }),
            }).then(async (response) => {
              if (!response.ok) throw new Error(`Signalement refusé (HTTP ${response.status}).`);
              const payload: unknown = await response.json();
              if (!isRecord(payload) || payload.reported !== true) {
                throw new Error("La confirmation du signalement est invalide.");
              }
              Alert.alert("Signalement reçu", "Statut : en attente de vérification.");
            }).catch((reportError: unknown) => {
              Alert.alert(
                "Signalement impossible",
                reportError instanceof Error ? reportError.message : "Réessayez.",
              );
            });
          },
        },
      ],
    );
  };

  const confirmRepost = (entry: FeedEntry) => {
    const caption = [
      repostCaption.trim(),
      `${entry.title}${entry.imageUrl ? `\n${entry.imageUrl}` : ""}`,
    ].filter(Boolean).join("\n\n").slice(0, 1000);
    if (!caption || isReposting) return;
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    Alert.alert(
      "Publier dans votre fil ?",
      "Cette action créera une nouvelle publication texte. Rien ne sera publié sans votre confirmation.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Confirmer et publier",
          onPress: () => {
            setIsReposting(true);
            void apiFetch(`${API_BASE_URL}/v1/posts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ caption, scope: draftScope, media_type: null }),
            }).then((response) => {
              if (!response.ok) throw new Error(`Publication refusée (HTTP ${response.status}).`);
              setRepostPost(null);
              setRepostCaption("");
              refresh();
              Alert.alert("Publication créée", "Le repartage est visible dans votre fil.");
            }).catch((repostError: unknown) => {
              Alert.alert(
                "Repartage impossible",
                repostError instanceof Error ? repostError.message : "Réessayez.",
              );
            }).finally(() => setIsReposting(false));
          },
        },
      ],
    );
  };

  const downloadMedia = async (entry: FeedEntry) => {
    if (!entry.imageUrl) return;
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Autorisez l’accès à la galerie pour enregistrer ce média.");
      }
      const localFile = await File.downloadFileAsync(
        entry.imageUrl,
        new File(Paths.cache, `quartierplus-${entry.id}.${entry.mediaType === "video" ? "mp4" : "jpg"}`),
      );
      await MediaLibrary.saveToLibraryAsync(localFile.uri);
      Alert.alert("Enregistré", "Le média est dans votre galerie.");
    } catch (downloadError) {
      Alert.alert(
        "Téléchargement impossible",
        downloadError instanceof Error ? downloadError.message : "Réessayez.",
      );
    }
  };

  const createPublication = () => {
    if (authStatus === "guest" || !user) {
      requestAuthentication();
      return;
    }
    if (!user.phone_verified_at) {
      Alert.alert(
        "Téléphone à vérifier",
        "Vérifiez votre numéro dans Profil avant de publier une photo ou une vidéo.",
      );
      return;
    }
    setDraftMedia(null);
    setDraftCaption("");
    setDraftScope(scope);
    setComposerStage("menu");
  };

  const selectMedia = async (
    source: "camera" | "gallery",
    resourceType: CloudinaryMediaType,
  ) => {
    setComposerStage("closed");
    try {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Accès nécessaire",
          source === "camera"
            ? "Autorisez l’accès à l’appareil photo dans les réglages."
            : "Autorisez l’accès à vos photos et vidéos dans les réglages.",
        );
        return;
      }
      const selection =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: resourceType === "image" ? ["images"] : ["videos"],
              quality: 1,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: resourceType === "image" ? ["images"] : ["videos"],
              allowsMultipleSelection: false,
              quality: 1,
            });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      if (!asset?.uri) {
        throw new Error("Le média sélectionné est indisponible.");
      }
      let mediaUri = asset.uri;
      let mimeType = asset.mimeType ?? "video/mp4";
      let filename =
        asset.fileName ??
        `quartierplus-${Date.now()}.${resourceType === "image" ? "jpg" : "mp4"}`;
      if (resourceType === "image") {
        const sourceSize = new File(asset.uri).size;
        if (sourceSize > MAX_PHOTO_BYTES) {
          throw new Error("La photo doit peser 10 Mo maximum.");
        }
        const resizeActions =
          Math.max(asset.width, asset.height) > MAX_PHOTO_DIMENSION
            ? [
                {
                  resize:
                    asset.width >= asset.height
                      ? { width: MAX_PHOTO_DIMENSION }
                      : { height: MAX_PHOTO_DIMENSION },
                },
              ]
            : [];
        const optimized = await ImageManipulator.manipulateAsync(
          asset.uri,
          resizeActions,
          {
            compress: 0.82,
            format: ImageManipulator.SaveFormat.JPEG,
          },
        );
        mediaUri = optimized.uri;
        mimeType = "image/jpeg";
        filename = `quartierplus-${Date.now()}.jpg`;
      }
      const size = new File(mediaUri).size;
      if (resourceType === "image" && size > MAX_PHOTO_BYTES) {
        throw new Error("La photo optimisée dépasse la limite de 10 Mo.");
      }
      setDraftMedia({
        uri: mediaUri,
        filename,
        mimeType,
        resourceType,
        size,
        duration:
          typeof asset.duration === "number" ? asset.duration / 1000 : undefined,
      });
      setComposerStage("preview");
    } catch (selectionError) {
      Alert.alert(
        resourceType === "image" ? "Photo indisponible" : "Vidéo indisponible",
        selectionError instanceof Error
          ? selectionError.message
          : "Impossible de préparer ce média. Réessayez.",
      );
    }
  };

  const cancelPublication = () => {
    uploadControllerRef.current?.abort();
    uploadControllerRef.current = null;
    setIsPublishing(false);
    setUploadProgress(0);
    setComposerStage("closed");
    setDraftMedia(null);
  };

  const publishMedia = async () => {
    if (!draftMedia || !API_BASE_URL || !countryCode) {
      Alert.alert(
        "Publication indisponible",
        !API_BASE_URL
          ? "Le service de publication n’est pas configuré."
          : "Le pays du compte n’est pas disponible.",
      );
      return;
    }
    if (isOffline) {
      const caption = draftCaption.trim();
      if (!caption) {
        Alert.alert(
          "Publication hors ligne",
          "Ajoutez une légende pour mettre en file une publication texte. Le média sera ignoré.",
        );
        return;
      }
      if (
        (draftScope === "neighborhood" || draftScope === "region") &&
        !coordinates
      ) {
        Alert.alert(
          "Position nécessaire",
          "La position de cette publication locale n’est pas disponible hors ligne.",
        );
        return;
      }
      try {
        await queueOfflineAction("create_feed_post", {
          caption,
          scope: draftScope,
          ...(coordinates
            ? {
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
              }
            : {}),
        });
        setComposerStage("closed");
        setDraftMedia(null);
        setDraftCaption("");
        Alert.alert(
          "Publication mise en attente",
          "La version texte sera publiée au retour du réseau; le média n’a pas été mis en file.",
        );
      } catch (queueError) {
        Alert.alert(
          "Mise en file impossible",
          queueError instanceof Error ? queueError.message : "Réessayez.",
        );
      }
      return;
    }
    let position: FeedCoordinates | null = null;
    if (draftScope === "neighborhood" || draftScope === "region") {
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted) {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (!permission.granted) {
          Alert.alert(
            "Localisation nécessaire",
            "Autorisez la localisation pour publier dans le quartier ou la région.",
          );
          return;
        }
        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        position = {
          latitude: current.coords.latitude,
          longitude: current.coords.longitude,
        };
      } catch (locationError) {
        console.error("Unable to read position for a neighborhood post:", locationError);
        Alert.alert(
          "Localisation indisponible",
          "Impossible de déterminer votre position. Réessayez ou choisissez une autre portée.",
        );
        return;
      }
    }

    const controller = new AbortController();
    uploadControllerRef.current = controller;
    setIsPublishing(true);
    setUploadProgress(0);
    let postRequestStarted = false;
    try {
      const signatureResponse = await apiFetch(
        `${API_BASE_URL}/v1/media/sign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ media_type: draftMedia.resourceType }),
          signal: controller.signal,
        },
      );
      if (!signatureResponse.ok) {
        const payload: unknown = await signatureResponse.json();
        throw new PublicationApiError(
          isRecord(payload) && typeof payload.reason === "string"
            ? payload.reason
            : isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : `Impossible de préparer le téléversement (HTTP ${signatureResponse.status}).`,
        );
      }
      const signaturePayload: unknown = await signatureResponse.json();
      if (
        !isRecord(signaturePayload) ||
        typeof signaturePayload.apiKey !== "string" ||
        typeof signaturePayload.cloudName !== "string" ||
        typeof signaturePayload.folder !== "string" ||
        typeof signaturePayload.public_id !== "string" ||
        typeof signaturePayload.signature !== "string" ||
        typeof signaturePayload.timestamp !== "number" ||
        typeof signaturePayload.max_bytes !== "number" ||
        signaturePayload.resource_type !== draftMedia.resourceType ||
        !(
          signaturePayload.max_duration_seconds === null ||
          typeof signaturePayload.max_duration_seconds === "number"
        )
      ) {
        throw new Error("La signature reçue est invalide.");
      }
      const signature = signaturePayload as MediaSignature;
      if (
        draftMedia.resourceType === "video" &&
        (typeof signature.max_duration_seconds !== "number" ||
          (draftMedia.duration !== undefined &&
            draftMedia.duration > signature.max_duration_seconds))
      ) {
        throw new PublicationApiError(
          `La vidéo doit durer au maximum ${signature.max_duration_seconds ?? 180} secondes.`,
        );
      }
      let uploadMedia = draftMedia;
      if (draftMedia.resourceType === "video") {
        setIsCompressingVideo(true);
        try {
          const compressedUri = await compressVideoForUpload(
            draftMedia.uri,
            (progress) => {
              setUploadProgress(
                Math.min(20, Math.max(0, Math.round(progress * 20))),
              );
            },
          );
          uploadMedia = {
            ...draftMedia,
            uri: compressedUri,
            filename: `quartierplus-${Date.now()}.mp4`,
            mimeType: "video/mp4",
            size: new File(compressedUri).size,
          };
        } finally {
          setIsCompressingVideo(false);
        }
        setUploadProgress(20);
      }
      const maxAllowedBytes =
        uploadMedia.resourceType === "image"
          ? Math.min(MAX_PHOTO_BYTES, signature.max_bytes)
          : signature.max_bytes;
      if (uploadMedia.size > maxAllowedBytes) {
        throw new PublicationApiError(
          "Le média optimisé dépasse la limite de taille autorisée.",
        );
      }
      const uploaded = await uploadCloudinaryMedia(
        signature,
        {
          uri: uploadMedia.uri,
          name: uploadMedia.filename,
          type: uploadMedia.mimeType,
          size: uploadMedia.size,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            const start = uploadMedia.resourceType === "video" ? 20 : 0;
            setUploadProgress(
              start + Math.round((progress / 90) * (90 - start)),
            );
          },
        },
      );
      setUploadProgress(94);
      postRequestStarted = true;
      const postResponse = await apiFetch(`${API_BASE_URL}/v1/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: draftCaption.trim(),
          scope: draftScope,
          media_type: draftMedia.resourceType,
          media_public_id: uploaded.publicId,
          ...(position
            ? {
                latitude: position.latitude,
                longitude: position.longitude,
              }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!postResponse.ok) {
        const payload: unknown = await postResponse.json();
        throw new PublicationApiError(
          isRecord(payload) && typeof payload.reason === "string"
            ? payload.reason
            : isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : `La publication a été refusée par le serveur (HTTP ${postResponse.status}).`,
        );
      }
      setUploadProgress(100);
      setComposerStage("closed");
      setDraftMedia(null);
      setDraftCaption("");
      refresh();
    } catch (publishError) {
      if (controller.signal.aborted) return;
      console.error("Unable to publish media:", publishError);
      if (postRequestStarted || !draftCaption.trim()) {
        Alert.alert(
          "Publication impossible",
          publishError instanceof PublicationApiError ||
          publishError instanceof MediaUploadError
            ? publishError.message
            : "Impossible de publier ce média. Réessayez dans un instant.",
        );
        return;
      }
      try {
        const fallbackResponse = await apiFetch(`${API_BASE_URL}/v1/posts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caption: draftCaption.trim(),
            scope: draftScope,
            media_type: null,
            ...(position
              ? {
                  latitude: position.latitude,
                  longitude: position.longitude,
                }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!fallbackResponse.ok) {
          const payload: unknown = await fallbackResponse.json();
          throw new PublicationApiError(
            isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : "La publication texte a été refusée par le serveur.",
          );
        }
        setComposerStage("closed");
        setDraftMedia(null);
        setDraftCaption("");
        refresh();
        const uploadReason =
          publishError instanceof PublicationApiError ||
          publishError instanceof MediaUploadError
            ? publishError.message
            : "Erreur de téléversement inconnue (code CLOUDINARY_UPLOAD_FAILED).";
        Alert.alert(
          "Publication texte seule",
          `Le média n'a pas pu être téléversé : ${uploadReason}\nVotre publication texte a été enregistrée.`,
        );
      } catch (fallbackError) {
        if (controller.signal.aborted) return;
        Alert.alert(
          "Publication impossible",
          fallbackError instanceof PublicationApiError
            ? fallbackError.message
            : publishError instanceof PublicationApiError ||
              publishError instanceof MediaUploadError
              ? publishError.message
              : "Le téléversement et la publication texte ont échoué. Vérifiez la connexion puis réessayez.",
        );
      }
    } finally {
      if (uploadControllerRef.current === controller) {
        uploadControllerRef.current = null;
      }
      setIsPublishing(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>QUARTIERPLUS</Text>
          <Text style={styles.title}>Fil du quartier</Text>
          <Text style={styles.subtitle}>
            {authStatus === "guest"
              ? "Publications publiques"
              : "Publications et alertes à proximité"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="Préférences du fil"
            accessibilityRole="button"
            onPress={() => {
              setFeedSettingsOpen(true);
              void loadBlockedUsers();
            }}
            style={styles.microphoneButton}
          >
            <Settings2 color={colors.secondaryText} size={18} />
          </Pressable>
          <Pressable
            accessibilityLabel="Assistant vocal"
            accessibilityRole="button"
            onPress={requestAssistant}
            style={styles.microphoneButton}
          >
            <Mic color="#475569" size={18} />
          </Pressable>
          <Pressable
            accessibilityLabel="Actualiser le fil"
            accessibilityRole="button"
            onPress={refresh}
            style={styles.refreshButton}
          >
            <RefreshCw color="#2563eb" size={20} />
          </Pressable>
        </View>
      </View>
      <View style={[styles.scopeBar, { backgroundColor: colors.card }]}>
        {FEED_SCOPES.map((option) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: scope === option.id }}
            key={option.id}
            onPress={() => void chooseScope(option.id)}
            style={[styles.scopeChip, scope === option.id && styles.scopeChipSelected]}
          >
            <Text
              style={[
                styles.scopeLabel,
                scope === option.id && styles.scopeLabelSelected,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.feedFiltersRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: showSavedOnly }}
          onPress={() => setShowSavedOnly((current) => !current)}
          style={[styles.savedFilter, showSavedOnly && styles.savedFilterSelected]}
        >
          <Bookmark color={showSavedOnly ? "#ffffff" : "#166534"} fill={showSavedOnly ? "#166534" : "transparent"} size={16} />
          <Text style={[styles.savedFilterText, showSavedOnly && styles.savedFilterTextSelected]}>Enregistrées</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryFilters}>
          {FEED_FILTERS.map((filter) => (
            <Pressable
              key={filter}
              accessibilityRole="button"
              accessibilityState={{ selected: feedFilter === filter }}
              onPress={() => setFeedFilter(filter)}
              style={[styles.categoryFilter, feedFilter === filter && styles.categoryFilterSelected]}
            >
              <Text style={[styles.categoryFilterText, feedFilter === filter && styles.categoryFilterTextSelected]}>{filter}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {locationInvitation && (
        <View style={styles.locationInvitation}>
          <MapPin color="#2563eb" size={18} />
          <View style={styles.invitationCopy}>
            <Text style={styles.invitationText}>
              Activez la localisation pour voir votre quartier
            </Text>
            {authStatus === "guest" ? (
              <Pressable
                accessibilityRole="button"
                onPress={requestAuthentication}
              >
                <Text style={styles.invitationAction}>Se connecter</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => void Linking.openSettings()}
              >
                <Text style={styles.invitationAction}>Ouvrir les réglages</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
      {error && (
        <View style={[styles.notice, entries.length ? styles.cachedNotice : styles.errorNotice]}>
          <Text style={styles.noticeText}>{error.message}</Text>
          <Pressable accessibilityRole="button" onPress={refresh}>
            <Text style={styles.retryText}>Réessayer</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showTechnicalDetails }}
            onPress={() => setShowTechnicalDetails((shown) => !shown)}
          >
            <Text style={styles.detailsToggle}>
              {showTechnicalDetails ? "Masquer les détails" : "Détails techniques"}
            </Text>
          </Pressable>
          {showTechnicalDetails && (
            <Text selectable style={styles.technicalDetails}>
              {error.details}
            </Text>
          )}
        </View>
      )}
      <ScrollView
        horizontal
        onMomentumScrollEnd={(event) => {
          const index = Math.round(
            event.nativeEvent.contentOffset.x / pageWidth,
          );
          const nextScope = FEED_SCOPES[index]?.id;
          if (nextScope && nextScope !== scope) void chooseScope(nextScope);
        }}
        pagingEnabled
        ref={pagerRef}
        showsHorizontalScrollIndicator={false}
        style={styles.pager}
      >
        {FEED_SCOPES.map((option) => (
          <View key={option.id} style={[styles.pagerPage, { width: pageWidth }]}>
            {isLoading && entries.length === 0 ? (
              <View style={styles.skeletonList}>
                <Text style={styles.loadingText}>
                  {isServerRequestPending
                    ? "Le serveur se réveille…"
                    : "Chargement du fil local…"}
                </Text>
                {[0, 1, 2].map((item) => (
                  <View key={item} style={styles.skeletonCard}>
                    <View style={styles.skeletonHeader}>
                      <View style={styles.skeletonAvatar} />
                      <View style={styles.skeletonHeading}>
                        <View style={[styles.skeletonLine, styles.skeletonShort]} />
                        <View style={[styles.skeletonLine, styles.skeletonDate]} />
                      </View>
                    </View>
                    <View style={[styles.skeletonLine, styles.skeletonTitle]} />
                    <View style={[styles.skeletonLine, styles.skeletonBody]} />
                    {item === 0 ? <View style={styles.skeletonImage} /> : null}
                  </View>
                ))}
              </View>
            ) : (
              <FlashList
                data={visibleEntries}
                drawDistance={Math.min(800, windowHeight * 1.5)}
                contentContainerStyle={styles.list}
                decelerationRate="fast"
                extraData={`${activeMediaIndex}:${savedPostIds.join(",")}:${feedFilter}:${showSavedOnly}`}
                keyExtractor={(entry) => `${entry.kind}:${entry.id}`}
                nestedScrollEnabled
                onEndReached={() => void loadMore()}
                onEndReachedThreshold={0.6}
                onScroll={(event) => {
                  const { contentOffset, layoutMeasurement } = event.nativeEvent;
                  const viewportTop = contentOffset.y;
                  const viewportBottom = viewportTop + layoutMeasurement.height;
                  let nextActiveMedia = -1;
                  let greatestVisibility = 0;
                  visibleEntries.forEach((entry, entryIndex) => {
                    const layout = cardLayoutsRef.current[entryIndex];
                    if (!entry.imageUrl || !layout) return;
                    const visibleHeight = Math.max(
                      0,
                      Math.min(layout.top + layout.height, viewportBottom) -
                        Math.max(layout.top, viewportTop),
                    );
                    if (visibleHeight > greatestVisibility) {
                      greatestVisibility = visibleHeight;
                      nextActiveMedia = entryIndex;
                    }
                  });
                  if (nextActiveMedia >= 0) setActiveMediaIndex(nextActiveMedia);
                }}
                scrollEventThrottle={150}
                refreshControl={
                  <RefreshControl refreshing={isRefreshing} onRefresh={refresh} />
                }
                renderItem={({ item: entry, index }) => (
                  <View
                    onLayout={(event) => {
                      cardLayoutsRef.current[index] = {
                        top: event.nativeEvent.layout.y,
                        height: event.nativeEvent.layout.height,
                      };
                    }}
                    style={[
                      styles.card,
                      { backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                  >
                    <View style={styles.cardHeader}>
                      {entry.kind === "post" ? (
                        <ProfileAvatar
                          name={entry.authorName}
                          photoUrl={entry.authorPhotoUrl}
                          size={40}
                          isAlly={entry.authorIsAlly}
                          isProVerified={entry.authorBadge === "Commerçant Certifié"}
                        />
                      ) : (
                        <View style={[styles.icon, styles.alertIcon]}>
                          <AlertTriangle color="#dc2626" size={19} />
                        </View>
                      )}
                      <View style={styles.cardHeading}>
                        {entry.authorName ? (
                          <Text style={[styles.authorName, { color: colors.text }]}>{entry.authorName}</Text>
                        ) : null}
                        <Text style={[styles.category, { color: colors.secondaryText }]}>{entry.category}</Text>
                        <Text style={[styles.date, { color: colors.secondaryText }]}>{formatDate(entry.createdAt)}</Text>
                      </View>
                      {entry.price ? <Text style={styles.price}>{entry.price}</Text> : null}
                    </View>
                    {entry.imageUrl ? (
                      <FeedMedia
                        height={Math.min(420, Math.max(220, windowHeight * 0.46))}
                        active={option.id === scope && index === activeMediaIndex}
                        autoPlay={!wifiOnlyVideoAutoplay || isWifiConnected}
                        creatorName={entry.authorName}
                        onDoubleTap={() => {
                          if (!entry.likedByMe) void likePost(entry);
                        }}
                        onTripleTap={() => setActionPost(entry)}
                        onLongPress={() => setActionPost(entry)}
                        preloadUri={
                          option.id === scope &&
                          index === activeMediaIndex &&
                          (visibleEntries[index + 1]?.mediaType === "image" ||
                            (visibleEntries[index + 1]?.mediaType === "video" &&
                              isWifiConnected &&
                              !lowDataMode))
                            ? visibleEntries[index + 1]?.imageUrl
                            : undefined
                        }
                          preloadType={visibleEntries[index + 1]?.mediaType}
                        lowDataMode={lowDataMode}
                        type={entry.mediaType ?? "image"}
                        uri={entry.imageUrl}
                      />
                    ) : null}
                    {entry.body ? (
                      <Text style={[styles.body, { color: colors.secondaryText }]}>{entry.body}</Text>
                    ) : null}
                    {entry.kind === "post" ? (
                      <View style={styles.postActions}>
                        <Pressable
                          accessibilityLabel={`Adorer, ${entry.likesCount} mentions J’adore`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: entry.likedByMe }}
                          onPress={() => void likePost(entry)}
                          style={[styles.postAction, { backgroundColor: colors.background }]}
                        >
                          <Text style={[styles.actionText, { color: colors.text }, entry.likedByMe && styles.actionSelected]}>
                            {entry.likedByMe ? "♥ Adoré" : "♡ Adorer"} · {entry.likesCount}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityLabel={`Commenter, ${entry.commentsCount} commentaires`}
                          accessibilityRole="button"
                          onPress={() => void openComments(entry)}
                          style={[styles.postAction, { backgroundColor: colors.background }]}
                        >
                          <Text style={[styles.actionText, { color: colors.text }]}>Commenter · {entry.commentsCount}</Text>
                        </Pressable>
                        <Pressable accessibilityLabel="Propager cette publication" accessibilityRole="button" onPress={() => setActionPost(entry)} style={[styles.postAction, { backgroundColor: colors.background }]}>
                          <Text style={[styles.actionText, { color: colors.text }]}>Propager</Text>
                        </Pressable>
                        {entry.imageUrl ? (
                          <Pressable accessibilityRole="button" onPress={() => void downloadMedia(entry)} style={[styles.postAction, { backgroundColor: colors.background }]}>
                            <Text style={[styles.actionText, { color: colors.text }]}>Télécharger</Text>
                          </Pressable>
                        ) : null}
                        {entry.authorId && entry.authorId !== user?.id ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: entry.authorIsAlly }}
                            onPress={() => void requestAlliance(entry)}
                            style={[styles.postAction, { backgroundColor: colors.background }]}
                          >
                            <Text style={[styles.actionText, { color: colors.text }]}>
                              {entry.authorIsAlly
                                ? "Allié ✓"
                                : entry.allianceStatus === "PENDING"
                                  ? "Demande envoyée"
                                  : "Se rallier"}
                            </Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          accessibilityLabel="Signaler cette publication"
                          accessibilityRole="button"
                          onPress={() => openReportReasons("post", entry.id, "Cette publication")}
                          style={[styles.postAction, { backgroundColor: colors.background }]}
                        >
                          <Text style={[styles.actionText, { color: colors.text }]}>Signaler</Text>
                        </Pressable>
                      </View>
                    ) : (
                      <Text style={styles.cardTitle}>{entry.title}</Text>
                    )}
                    {entry.location ? (
                      <View style={styles.location}>
                        <MapPin color="#64748b" size={14} />
                        <Text style={styles.locationText}>{entry.location}</Text>
                      </View>
                    ) : null}
                  </View>
                )}
                ListEmptyComponent={
                  !visibleEntries.length && !isLoading ? (
                    <View style={styles.empty}>
                      <MapPin color="#94a3b8" size={30} />
                      <Text style={styles.emptyTitle}>{showSavedOnly ? "Aucune publication enregistrée visible" : "Aucun résultat dans cette catégorie"}</Text>
                      <Text style={styles.emptyText}>
                        {showSavedOnly
                          ? "Les favoris sont conservés sur cet appareil et apparaissent lorsqu’ils sont présents dans le fil chargé."
                          : "Essayez une autre catégorie ou une autre portée du fil."}
                      </Text>
                    </View>
                  ) : null
                }
                ListFooterComponent={isLoadingMore ? (
                  <ActivityIndicator
                    accessibilityLabel="Chargement des publications suivantes"
                    color={colors.primary}
                    style={styles.loadMoreIndicator}
                  />
                ) : null}
                style={styles.feedPage}
              />
            )}
          </View>
        ))}
      </ScrollView>
      <Pressable
        accessibilityLabel="Créer une publication"
        accessibilityRole="button"
        onPress={createPublication}
        style={styles.createButton}
      >
        <Plus color="#ffffff" size={28} strokeWidth={2.5} />
      </Pressable>
      <Modal
        animationType="slide"
        onRequestClose={cancelPublication}
        transparent
        visible={composerStage !== "closed"}
      >
        <View style={styles.composerBackdrop}>
          <View style={styles.composerSheet}>
            <Text style={styles.composerTitle}>
              {composerStage === "menu" ? "Nouvelle publication" : "Prévisualisation"}
            </Text>
            {composerStage === "menu" ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void selectMedia("camera", "image")}
                  style={styles.composerOption}
                >
                  <Text style={styles.composerOptionText}>Photo</Text>
                  <Text style={styles.composerHelp}>Prendre une photo</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void selectMedia("gallery", "image")}
                  style={styles.composerOption}
                >
                  <Text style={styles.composerOptionText}>Galerie</Text>
                  <Text style={styles.composerHelp}>Choisir une photo existante</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void selectMedia("gallery", "video")}
                  style={styles.composerOption}
                >
                  <Text style={styles.composerOptionText}>Vidéo</Text>
                  <Text style={styles.composerHelp}>Choisir une vidéo existante</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void selectMedia("camera", "video")}
                  style={styles.composerOption}
                >
                  <Text style={styles.composerOptionText}>Filmer</Text>
                  <Text style={styles.composerHelp}>Enregistrer une vidéo</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={cancelPublication}
                  style={styles.composerCancel}
                >
                  <Text style={styles.composerCancelText}>Annuler</Text>
                </Pressable>
              </>
            ) : (
              <>
                {draftMedia?.resourceType === "image" ? (
                  <Image
                    accessibilityLabel="Aperçu de votre photo"
                    resizeMode="contain"
                    source={{ uri: draftMedia.uri }}
                    style={styles.photoPreview}
                  />
                ) : null}
                {draftMedia?.resourceType === "video" ? (
                  <View style={styles.photoPreview}>
                    <Text style={styles.composerOptionText}>Vidéo prête à publier</Text>
                    <Text style={styles.composerHelp}>
                      {draftMedia.filename} ·{" "}
                      {(draftMedia.size / (1024 * 1024)).toFixed(1)} Mo
                    </Text>
                  </View>
                ) : null}
                <TextInput
                  accessibilityLabel="Légende de la publication"
                  editable={!isPublishing}
                  maxLength={1000}
                  multiline
                  onChangeText={setDraftCaption}
                  placeholder="Ajouter une légende (facultatif)"
                  style={styles.captionInput}
                  value={draftCaption}
                />
                <Text style={styles.scopeHeading}>Portée de la publication</Text>
                <View style={styles.composerScopes}>
                  {FEED_SCOPES.map((option) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: draftScope === option.id }}
                      disabled={isPublishing}
                      key={option.id}
                      onPress={() => setDraftScope(option.id)}
                      style={[
                        styles.composerScope,
                        draftScope === option.id && styles.composerScopeSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.scopeLabel,
                          draftScope === option.id && styles.scopeLabelSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {isPublishing ? (
                  <View style={styles.progressGroup}>
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: `${uploadProgress}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.composerHelp}>
                      {isCompressingVideo
                        ? `Compression 720p : ${uploadProgress * 5} %`
                        : `Téléversement : ${uploadProgress} %`}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.composerActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={cancelPublication}
                    style={styles.composerCancel}
                  >
                    <Text style={styles.composerCancelText}>
                      {isPublishing ? "Annuler l’envoi" : "Annuler"}
                    </Text>
                  </Pressable>
                  {!isPublishing ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void publishMedia()}
                      style={styles.publishButton}
                    >
                      <Text style={styles.publishButtonText}>Publier</Text>
                    </Pressable>
                  ) : null}
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setFeedSettingsOpen(false)}
        transparent
        visible={feedSettingsOpen}
      >
        <View style={styles.commentBackdrop}>
          <View style={[styles.preferenceSheet, { backgroundColor: colors.card }]}>
            <View style={styles.commentHeader}>
              <Text style={[styles.preferenceTitle, { color: colors.text }]}>Préférences du fil</Text>
              <Pressable
                accessibilityLabel="Fermer les préférences"
                accessibilityRole="button"
                onPress={() => setFeedSettingsOpen(false)}
                style={styles.preferenceClose}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>Fermer</Text>
              </Pressable>
            </View>
            <View style={[styles.preferenceRow, { borderBottomColor: colors.border }]}>
              <View style={styles.preferenceCopy}>
                <Text style={[styles.preferenceLabel, { color: colors.text }]}>Économie de données</Text>
                <Text style={[styles.preferenceDescription, { color: colors.secondaryText }]}>Réduit la qualité des médias chargés.</Text>
              </View>
              <Switch
                accessibilityLabel="Économie de données"
                accessibilityRole="switch"
                onValueChange={setDataSaverEnabled}
                trackColor={{ false: colors.border, true: colors.primary }}
                value={dataSaverEnabled}
              />
            </View>
            <View style={styles.preferenceRow}>
              <View style={styles.preferenceCopy}>
                <Text style={[styles.preferenceLabel, { color: colors.text }]}>Lecture vidéo sur Wi-Fi</Text>
                <Text style={[styles.preferenceDescription, { color: colors.secondaryText }]}>Les vidéos ne démarrent pas automatiquement sur le réseau mobile.</Text>
              </View>
              <Switch
                accessibilityLabel="Lecture vidéo automatique uniquement sur Wi-Fi"
                accessibilityRole="switch"
                onValueChange={setWifiOnlyVideoAutoplay}
                trackColor={{ false: colors.border, true: colors.primary }}
                value={wifiOnlyVideoAutoplay}
              />
            </View>
            <View style={styles.blockedUsersSection}>
              <Text style={[styles.preferenceLabel, { color: colors.text }]}>Comptes bloqués</Text>
              {blockedUsersError ? (
                <Text accessibilityRole="alert" style={[styles.preferenceDescription, { color: colors.secondaryText }]}>
                  {blockedUsersError}
                </Text>
              ) : blockedUsers.length === 0 ? (
                <Text style={[styles.preferenceDescription, { color: colors.secondaryText }]}>Aucun compte bloqué.</Text>
              ) : (
                <ScrollView keyboardShouldPersistTaps="handled" style={styles.blockedUsersList}>
                  {blockedUsers.map((blocked) => (
                    <View key={blocked.id} style={styles.blockedUserRow}>
                      <Text numberOfLines={1} style={[styles.preferenceDescription, { color: colors.text }]}>{blocked.name}</Text>
                      <Pressable
                        accessibilityLabel={`Débloquer ${blocked.name}`}
                        accessibilityRole="button"
                        onPress={() => void unblockAuthor(blocked.id)}
                        style={styles.preferenceClose}
                      >
                        <Text style={[styles.actionText, { color: colors.primary }]}>Débloquer</Text>
                      </Pressable>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setReportTarget(null)}
        transparent
        visible={reportTarget !== null}
      >
        <View style={styles.commentBackdrop}>
          <View style={[styles.actionSheet, { backgroundColor: colors.card }]}>
            <View style={styles.commentHeader}>
              <Text style={[styles.composerTitle, { color: colors.text }]}>Signaler</Text>
              <Pressable
                accessibilityLabel="Fermer le signalement"
                accessibilityRole="button"
                onPress={() => setReportTarget(null)}
                style={styles.preferenceClose}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>Fermer</Text>
              </Pressable>
            </View>
            <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>
              {reportTarget?.label}: choisissez un motif. Le contenu restera visible pendant la vérification.
            </Text>
            <ScrollView style={styles.actionOptions}>
              {[
                "Harcèlement",
                "Insultes",
                "Arnaque",
                "Faux profil",
                "Spam",
                "Usurpation d’identité",
                "Contenu dangereux",
                "Autre motif",
              ].map((reason) => (
                <Pressable
                  accessibilityRole="button"
                  key={reason}
                  onPress={() => confirmReport(reason)}
                  style={styles.actionOption}
                >
                  <Text style={[styles.actionOptionText, { color: colors.text }]}>{reason}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setActionPost(null)}
        transparent
        visible={actionPost !== null}
      >
        <View style={styles.commentBackdrop}>
          <View style={[styles.actionSheet, { backgroundColor: colors.card }]}>
            <View style={styles.commentHeader}>
              <Text style={[styles.composerTitle, { color: colors.text }]}>Actions de publication</Text>
              <Pressable
                accessibilityLabel="Fermer les actions"
                accessibilityRole="button"
                onPress={() => setActionPost(null)}
                style={styles.preferenceClose}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>Fermer</Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.actionOptions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (!actionPost) return;
                  setRepostPost(actionPost);
                  setRepostCaption("");
                  setActionPost(null);
                }}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, { color: colors.text }]}>Repartager dans mon fil</Text>
                <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>Ajouter un commentaire puis confirmer la publication</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (!actionPost) return;
                  const post = actionPost;
                  setActionPost(null);
                  void sharePost(post);
                }}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, { color: colors.text }]}>Envoyer à un ami</Text>
                <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>Ouvrir les options de partage de l’appareil</Text>
              </Pressable>
              {(["une alliance", "un groupe"] as const).map((destination) => (
                <Pressable
                  accessibilityRole="button"
                  key={destination}
                  onPress={() => {
                    setActionPost(null);
                    Alert.alert(
                      `Partager dans ${destination}`,
                      "Cette destination n’est pas encore reliée à une route de partage sur le serveur.",
                    );
                  }}
                  style={styles.actionOption}
                >
                  <Text style={[styles.actionOptionText, { color: colors.text }]}>Partager dans {destination}</Text>
                  <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>Destination interne indisponible</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => actionPost && void copyPostLink(actionPost)}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, { color: colors.text }]}>Copier le lien du média</Text>
              </Pressable>
              {actionPost?.imageUrl ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    if (!actionPost) return;
                    const post = actionPost;
                    setActionPost(null);
                    void downloadMedia(post);
                  }}
                  style={styles.actionOption}
                >
                  <Text style={[styles.actionOptionText, { color: colors.text }]}>
                    Télécharger {actionPost.mediaType === "video" ? "la vidéo" : "la photo"}
                  </Text>
                  <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>Demande d’autorisation avant l’enregistrement</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => actionPost && void savePostFavorite(actionPost)}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, { color: colors.text }]}>
                  {actionPost && savedPostIds.includes(actionPost.id)
                    ? "Retirer des favoris"
                    : "Enregistrer dans les favoris"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => actionPost && openReportReasons("post", actionPost.id, "Cette publication")}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, styles.destructiveAction]}>Signaler</Text>
              </Pressable>
              {actionPost?.authorId && actionPost.authorId !== user?.id ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => actionPost && openReportReasons("profile", actionPost.authorId!, "Ce profil")}
                  style={styles.actionOption}
                >
                  <Text style={[styles.actionOptionText, styles.destructiveAction]}>Signaler le profil</Text>
                </Pressable>
              ) : null}
              {actionPost?.authorId && actionPost.authorId !== user?.id ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => actionPost && blockAuthor(actionPost)}
                  style={styles.actionOption}
                >
                  <Text style={[styles.actionOptionText, styles.destructiveAction]}>Bloquer cet utilisateur</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => actionPost && hidePost(actionPost)}
                style={styles.actionOption}
              >
                <Text style={[styles.actionOptionText, { color: colors.text }]}>Masquer la publication</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setRepostPost(null)}
        transparent
        visible={repostPost !== null}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.commentBackdrop}>
          <View style={[styles.repostSheet, { backgroundColor: colors.card }]}>
            <View style={styles.commentHeader}>
              <Text style={[styles.composerTitle, { color: colors.text }]}>Repartager</Text>
              <Pressable
                accessibilityLabel="Fermer le repartage"
                accessibilityRole="button"
                disabled={isReposting}
                onPress={() => setRepostPost(null)}
                style={styles.preferenceClose}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>Fermer</Text>
              </Pressable>
            </View>
            {repostPost ? (
              <Text style={[styles.actionOptionDescription, { color: colors.secondaryText }]}>
                {repostPost.title}{repostPost.imageUrl ? ` · ${repostPost.imageUrl}` : ""}
              </Text>
            ) : null}
            <TextInput
              accessibilityLabel="Commentaire avant repartage"
              editable={!isReposting}
              maxLength={850}
              multiline
              onChangeText={setRepostCaption}
              placeholder="Ajouter un commentaire (facultatif)"
              style={[styles.commentInput, styles.repostInput]}
              value={repostCaption}
            />
            <Pressable
              accessibilityRole="button"
              disabled={isReposting}
              onPress={() => repostPost && confirmRepost(repostPost)}
              style={[styles.publishButton, isReposting && styles.disabledButton]}
            >
              <Text style={styles.publishButtonText}>
                {isReposting ? "Publication…" : "Continuer vers la confirmation"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedPost(null)}
        transparent
        visible={selectedPost !== null}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.commentBackdrop}>
          <View style={[styles.commentSheet, { backgroundColor: colors.card }]}>
            <View style={styles.commentHeader}>
              <Text style={[styles.composerTitle, { color: colors.text }]}>Commentaires</Text>
              <Pressable
                accessibilityLabel="Fermer les commentaires"
                accessibilityRole="button"
                onPress={() => setSelectedPost(null)}
              >
                <Text style={[styles.actionText, { color: colors.text }]}>Fermer</Text>
              </Pressable>
            </View>
            {commentsLoading ? (
              <View style={styles.commentStatus}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[styles.commentStatusText, { color: colors.secondaryText }]}>Chargement des commentaires…</Text>
              </View>
            ) : null}
            {commentsError ? (
              <View style={styles.commentStatus}>
                <Text accessibilityRole="alert" style={[styles.commentStatusText, { color: colors.secondaryText }]}>{commentsError}</Text>
                <Pressable accessibilityRole="button" onPress={() => selectedPost && void openComments(selectedPost)}>
                  <Text style={[styles.actionText, { color: colors.primary }]}>Réessayer</Text>
                </Pressable>
              </View>
            ) : null}
            <FlashList
              contentContainerStyle={styles.commentList}
              data={comments}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              onEndReached={() => void loadMoreComments()}
              onEndReachedThreshold={0.4}
              ListFooterComponent={loadingMoreComments ? <ActivityIndicator color={colors.primary} /> : null}
              ListEmptyComponent={
                !commentsLoading && !commentsError
                  ? <Text style={styles.emptyText}>Soyez le premier à commenter.</Text>
                  : null
              }
              renderItem={({ item }) => (
                <View style={[styles.commentItem, item.parent_comment_id ? styles.commentReplyItem : null]}>
                  <View style={styles.commentMeta}>
                    <View style={styles.commentAuthorWrap}>
                      <ProfileAvatar
                        name={item.user_name}
                        photoUrl={
                          item.user_id === user?.id &&
                          typeof user?.profile_photo_url === "string"
                            ? user.profile_photo_url
                            : item.user_photo_url
                        }
                        size={32}
                        isAlly={item.user_is_ally}
                        isProVerified={
                          item.user_badge === "Commerçant Certifié" ||
                          (item.user_id === user?.id &&
                            user?.badge === "Commerçant Certifié")
                        }
                      />
                      <Text style={[styles.commentAuthor, { color: colors.text }]}>{item.user_name ?? "Voisin"}</Text>
                    </View>
                    {item.created_at ? (
                      <Text style={[styles.commentDate, { color: colors.secondaryText }]}>
                        {new Date(item.created_at).toLocaleString()} {item.edited_at ? "· modifié" : ""}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.commentText, { color: colors.secondaryText }]}>{item.content}</Text>
                  <View style={styles.commentActions}>
                    <Pressable
                      accessibilityLabel={item.liked_by_me ? "Retirer la réaction" : "Aimer ce commentaire"}
                      accessibilityRole="button"
                      onPress={() => void toggleCommentLike(item)}
                      style={styles.commentActionButton}
                    >
                      <Text style={[styles.commentActionText, { color: item.liked_by_me ? colors.primary : colors.secondaryText }]}>
                        {item.liked_by_me ? "Aimé" : "J’aime"} {item.likes_count ? `· ${item.likes_count}` : ""}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Répondre à ${item.user_name ?? "ce commentaire"}`}
                      accessibilityRole="button"
                      onPress={() => {
                        setEditingComment(null);
                        setCommentDraft("");
                        setReplyingToComment(item);
                      }}
                      style={styles.commentActionButton}
                    >
                      <Text style={[styles.commentActionText, { color: colors.secondaryText }]}>Répondre</Text>
                    </Pressable>
                    {item.user_id !== user?.id ? (
                      <Pressable
                        accessibilityLabel="Signaler ce commentaire"
                        accessibilityRole="button"
                        onPress={() => openReportReasons("comment", item.id, "Ce commentaire")}
                        style={styles.commentActionButton}
                      >
                        <Text style={[styles.commentActionText, { color: colors.secondaryText }]}>Signaler</Text>
                      </Pressable>
                    ) : null}
                    {item.user_id === user?.id ? (
                      <>
                        <Pressable
                          accessibilityLabel="Modifier mon commentaire"
                          accessibilityRole="button"
                          onPress={() => {
                            setReplyingToComment(null);
                            setEditingComment(item);
                            setCommentDraft(item.content);
                          }}
                          style={styles.commentActionButton}
                        >
                          <Text style={[styles.commentActionText, { color: colors.secondaryText }]}>Modifier</Text>
                        </Pressable>
                        <Pressable
                          accessibilityLabel="Supprimer mon commentaire"
                          accessibilityRole="button"
                          onPress={() => deleteComment(item)}
                          style={styles.commentActionButton}
                        >
                          <Text style={[styles.commentActionText, { color: colors.secondaryText }]}>Supprimer</Text>
                        </Pressable>
                      </>
                    ) : null}
                  </View>
                </View>
              )}
            />
            {replyingToComment || editingComment ? (
              <View style={styles.commentContext}>
                <Text style={[styles.commentContextText, { color: colors.secondaryText }]}>
                  {editingComment ? "Modification du commentaire" : `Réponse à ${replyingToComment?.user_name ?? "un voisin"}`}
                </Text>
                <Pressable
                  accessibilityLabel="Annuler cette action"
                  accessibilityRole="button"
                  onPress={() => {
                    setReplyingToComment(null);
                    setEditingComment(null);
                    setCommentDraft("");
                  }}
                  style={styles.commentActionButton}
                >
                  <Text style={[styles.commentActionText, { color: colors.primary }]}>Annuler</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.commentComposer}>
              <TextInput
                accessibilityLabel="Votre commentaire"
                editable={!sendingComment}
                maxLength={1000}
                onChangeText={setCommentDraft}
                placeholder="Écrire un commentaire…"
                style={styles.commentInput}
                value={commentDraft}
              />
              <Pressable
                accessibilityLabel="Ajouter un emoji"
                accessibilityRole="button"
                disabled={sendingComment}
                onPress={() => setCommentDraft((current) => `${current}${current ? " " : ""}😊`)}
                style={styles.commentAccessoryButton}
              >
                <Text style={[styles.commentActionText, { color: colors.text }]}>😊</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Insérer une mention"
                accessibilityRole="button"
                disabled={sendingComment}
                onPress={() => setCommentDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@`)}
                style={styles.commentAccessoryButton}
              >
                <Text style={[styles.commentActionText, { color: colors.text }]}>@</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!commentDraft.trim() || sendingComment}
                onPress={() => void sendComment()}
                style={styles.publishButton}
              >
                <Text style={styles.publishButtonText}>
                  {sendingComment ? "…" : editingComment ? "Enregistrer" : "Envoyer"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#f1f5f9", flex: 1, paddingTop: 54 },
  pager: { flex: 1 },
  pagerPage: { flex: 1 },
  feedPage: { flex: 1 },
  header: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: "#2563eb", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#0f172a", fontSize: 24, fontWeight: "800", marginTop: 3 },
  subtitle: { color: "#64748b", fontSize: 13, marginTop: 3 },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 8 },
  microphoneButton: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 20,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  scopeBar: {
    backgroundColor: "#ffffff",
    flexDirection: "row",
    gap: 5,
    justifyContent: "space-around",
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  feedFiltersRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 10,
  },
  savedFilter: {
    alignItems: "center",
    backgroundColor: "#f0fdf4",
    borderRadius: 16,
    flexDirection: "row",
    gap: 5,
    minHeight: 34,
    paddingHorizontal: 10,
  },
  savedFilterSelected: { backgroundColor: "#166534" },
  savedFilterText: { color: "#166534", fontSize: 11, fontWeight: "700" },
  savedFilterTextSelected: { color: "#ffffff" },
  categoryFilters: { alignItems: "center", flexDirection: "row", gap: 5, paddingRight: 10 },
  categoryFilter: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 16,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 10,
  },
  categoryFilterSelected: { backgroundColor: "#dbeafe" },
  categoryFilterText: { color: "#64748b", fontSize: 11, fontWeight: "600" },
  categoryFilterTextSelected: { color: "#1d4ed8" },
  scopeChip: {
    alignItems: "center",
    borderRadius: 16,
    flex: 1,
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  scopeChipSelected: { backgroundColor: "#dbeafe" },
  scopeLabel: { color: "#64748b", fontSize: 11, fontWeight: "600" },
  scopeLabelSelected: { color: "#1d4ed8" },
  locationInvitation: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 14,
    marginTop: 10,
    padding: 12,
  },
  invitationCopy: { flex: 1, gap: 4 },
  invitationText: { color: "#334155", fontSize: 12, lineHeight: 18 },
  invitationAction: { color: "#1d4ed8", fontSize: 12, fontWeight: "700" },
  refreshButton: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  notice: { marginHorizontal: 14, marginTop: 10, padding: 11, borderRadius: 10, gap: 8 },
  cachedNotice: { backgroundColor: "#eff6ff" },
  errorNotice: { backgroundColor: "#fef2f2" },
  noticeText: { color: "#334155", fontSize: 12, lineHeight: 18 },
  retryText: { color: "#1d4ed8", fontSize: 13, fontWeight: "700" },
  detailsToggle: { color: "#475569", fontSize: 12, textDecorationLine: "underline" },
  technicalDetails: { color: "#64748b", fontSize: 11, lineHeight: 16 },
  list: { gap: 12, padding: 14, paddingBottom: 112 },
  card: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 16,
    borderWidth: 1,
    padding: 15,
  },
  immersiveCard: { justifyContent: "space-between" },
  cardHeader: { alignItems: "center", flexDirection: "row" },
  icon: { alignItems: "center", backgroundColor: "#eff6ff", borderRadius: 12, height: 40, justifyContent: "center", width: 40 },
  alertIcon: { backgroundColor: "#fef2f2" },
  cardHeading: { flex: 1, marginLeft: 10 },
  authorName: { color: "#0f172a", fontSize: 13, fontWeight: "800" },
  category: { color: "#475569", fontSize: 12, fontWeight: "700" },
  date: { color: "#94a3b8", fontSize: 11, marginTop: 3 },
  price: { color: "#15803d", fontSize: 12, fontWeight: "700", marginLeft: 8 },
  cardImage: {
    backgroundColor: "#f1f5f9",
    borderRadius: 12,
    height: 220,
    marginTop: 12,
    width: "100%",
  },
  videoAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
  },
  videoActionText: { color: "#1d4ed8", fontSize: 14, fontWeight: "700" },
  cardTitle: { color: "#0f172a", fontSize: 17, fontWeight: "700", marginTop: 13 },
  body: { color: "#475569", fontSize: 14, lineHeight: 21, marginTop: 6 },
  postActions: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 8,
  },
  postAction: {
    backgroundColor: "#f1f5f9",
    borderRadius: 16,
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  actionText: { color: "#334155", fontSize: 11, fontWeight: "700" },
  actionSelected: { color: "#dc2626" },
  location: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 11 },
  locationText: { color: "#64748b", fontSize: 12 },
  loading: { alignItems: "center", flex: 1, justifyContent: "center" },
  loadingText: { color: "#64748b", fontSize: 14, marginTop: 12 },
  skeletonList: { gap: 12, padding: 14 },
  loadMoreIndicator: { paddingVertical: 18 },
  skeletonCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 15,
  },
  skeletonHeader: { alignItems: "center", flexDirection: "row", gap: 10 },
  skeletonAvatar: { backgroundColor: "#e2e8f0", borderRadius: 12, height: 40, width: 40 },
  skeletonHeading: { flex: 1, gap: 7 },
  skeletonLine: { backgroundColor: "#e2e8f0", borderRadius: 5, height: 10 },
  skeletonShort: { width: "38%" },
  skeletonDate: { height: 7, width: "24%" },
  skeletonTitle: { height: 14, marginTop: 5, width: "66%" },
  skeletonBody: { height: 9, width: "88%" },
  skeletonImage: { backgroundColor: "#f1f5f9", borderRadius: 12, height: 150, marginTop: 5 },
  empty: { alignItems: "center", paddingHorizontal: 25, paddingTop: 65 },
  emptyTitle: { color: "#334155", fontSize: 17, fontWeight: "700", marginTop: 14 },
  emptyText: { color: "#64748b", fontSize: 13, lineHeight: 20, marginTop: 7, textAlign: "center" },
  createButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#0f766e",
    borderColor: "#ffffff",
    borderRadius: 30,
    borderWidth: 2,
    bottom: 16,
    elevation: 8,
    height: 58,
    justifyContent: "center",
    position: "absolute",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    width: 58,
    zIndex: 5,
  },
  composerBackdrop: {
    backgroundColor: "rgba(15, 23, 42, 0.48)",
    flex: 1,
    justifyContent: "flex-end",
  },
  composerSheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    gap: 12,
    maxHeight: "90%",
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  commentBackdrop: {
    backgroundColor: "rgba(15,23,42,0.5)",
    flex: 1,
    justifyContent: "flex-end",
  },
  commentSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    height: "70%",
    padding: 18,
    paddingBottom: 28,
  },
  actionSheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    maxHeight: "85%",
    paddingBottom: 28,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  actionOptions: { maxHeight: 520 },
  actionOption: {
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 48,
    paddingVertical: 10,
  },
  actionOptionText: { fontSize: 14, fontWeight: "700" },
  actionOptionDescription: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  destructiveAction: { color: "#b91c1c" },
  repostSheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    gap: 12,
    paddingBottom: 28,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  repostInput: { minHeight: 100, textAlignVertical: "top" },
  disabledButton: { opacity: 0.55 },
  preferenceSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    minHeight: 250,
    paddingBottom: 32,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  preferenceTitle: { fontSize: 18, fontWeight: "800" },
  preferenceClose: { minHeight: 40, justifyContent: "center", paddingHorizontal: 8 },
  preferenceRow: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 78,
    paddingVertical: 12,
  },
  preferenceCopy: { flex: 1, gap: 4, minWidth: 0 },
  preferenceLabel: { fontSize: 14, fontWeight: "700" },
  preferenceDescription: { fontSize: 12, lineHeight: 17 },
  blockedUsersSection: { gap: 8, paddingTop: 16 },
  blockedUsersList: { maxHeight: 150 },
  blockedUserRow: { alignItems: "center", borderBottomColor: "#e2e8f0", borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between" },
  commentHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
  },
  commentList: { gap: 12, paddingBottom: 12 },
  commentStatus: { alignItems: "center", flexDirection: "row", gap: 10, paddingVertical: 12 },
  commentStatusText: { flex: 1, fontSize: 13 },
  commentItem: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    gap: 4,
    padding: 11,
  },
  commentReplyItem: { marginLeft: 16 },
  commentActions: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 4 },
  commentActionButton: { justifyContent: "center", minHeight: 32 },
  commentActionText: { fontSize: 11, fontWeight: "700" },
  commentContext: { alignItems: "center", borderTopColor: "#e2e8f0", borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  commentContextText: { flex: 1, fontSize: 12 },
  commentAccessoryButton: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 36 },
  commentMeta: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", gap: 8 },
  commentAuthorWrap: { alignItems: "center", flex: 1, flexDirection: "row", gap: 8 },
  commentAuthor: { color: "#334155", fontSize: 12, fontWeight: "800" },
  commentDate: { fontSize: 10 },
  commentText: { color: "#475569", fontSize: 13, lineHeight: 19 },
  commentComposer: { alignItems: "center", flexDirection: "row", gap: 8 },
  commentInput: {
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#0f172a",
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  composerTitle: { color: "#0f172a", fontSize: 20, fontWeight: "800" },
  composerOption: {
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: 1,
    gap: 4,
    paddingVertical: 12,
  },
  composerOptionText: { color: "#0f172a", fontSize: 16, fontWeight: "700" },
  composerHelp: { color: "#64748b", fontSize: 12 },
  composerCancel: {
    alignItems: "center",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  composerCancelText: { color: "#334155", fontSize: 14, fontWeight: "700" },
  photoPreview: {
    alignSelf: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 12,
    height: 210,
    width: "100%",
  },
  captionInput: {
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#0f172a",
    fontSize: 14,
    minHeight: 72,
    padding: 12,
    textAlignVertical: "top",
  },
  scopeHeading: { color: "#334155", fontSize: 13, fontWeight: "700" },
  composerScopes: { flexDirection: "row", gap: 4 },
  composerScope: {
    alignItems: "center",
    borderRadius: 16,
    flex: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 2,
  },
  composerScopeSelected: { backgroundColor: "#dbeafe" },
  progressGroup: { gap: 5 },
  progressTrack: {
    backgroundColor: "#e2e8f0",
    borderRadius: 5,
    height: 8,
    overflow: "hidden",
  },
  progressFill: { backgroundColor: "#2563eb", height: "100%" },
  composerActions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 4,
  },
  publishButton: {
    alignItems: "center",
    backgroundColor: "#0f766e",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 22,
  },
  publishButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
});
