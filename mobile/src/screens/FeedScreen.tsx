import * as Location from "expo-location";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import {
  AlertTriangle,
  MapPin,
  Mic,
  Play,
  Plus,
  RefreshCw,
  ShoppingBag,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import * as SecureStore from "expo-secure-store";
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
  uploadCloudinaryMedia,
  type CloudinaryUploadSignature,
  type CloudinaryMediaType,
} from "../services/cloudinaryUpload";
import { MediaUploadError } from "../services/mediaUploadError";
import { compressVideoForUpload } from "../services/videoCompression";
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
  const { authStatus, isOffline, requestAuthentication, user } = useAuth();
  const { requestAssistant } = useVoiceAssistant();
  const { width: pageWidth } = useWindowDimensions();
  const pagerRef = useRef<ScrollView>(null);
  const [scope, setScope] = useState<FeedScope>("country");
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<FeedCoordinates | null>(null);
  const [scopeReady, setScopeReady] = useState(false);
  const [locationInvitation, setLocationInvitation] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
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
  const uploadControllerRef = useRef<AbortController | null>(null);

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
          if (!cancelled) setEntries(sortEntries(posts));
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
        if (!cancelled) setEntries(sortEntries([...posts, ...alerts]));
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
      Alert.alert(
        "Connexion nécessaire",
        "Reconnectez-vous à Internet pour publier votre média.",
      );
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
      <View style={styles.header}>
        <View>
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
      <View style={styles.scopeBar}>
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
              <ScrollView
                contentContainerStyle={styles.list}
                nestedScrollEnabled
                refreshControl={
                  <RefreshControl refreshing={isRefreshing} onRefresh={refresh} />
                }
                style={styles.feedPage}
              >
                {entries.map((entry) => (
                  <View key={`${entry.kind}:${entry.id}`} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <View style={[styles.icon, entry.kind === "alert" && styles.alertIcon]}>
                        {entry.kind === "alert" ? (
                          <AlertTriangle color="#dc2626" size={19} />
                        ) : (
                          <ShoppingBag color="#2563eb" size={19} />
                        )}
                      </View>
                      <View style={styles.cardHeading}>
                        <Text style={styles.category}>{entry.category}</Text>
                        <Text style={styles.date}>{formatDate(entry.createdAt)}</Text>
                      </View>
                      {entry.price ? <Text style={styles.price}>{entry.price}</Text> : null}
                    </View>
                    {entry.imageUrl && entry.mediaType === "video" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Ouvrir la vidéo publiée"
                        onPress={() => {
                          const mediaUrl = entry.imageUrl;
                          if (!mediaUrl) return;
                          void Linking.openURL(mediaUrl).catch((error: unknown) => {
                            console.error("Unable to open published video:", error);
                            Alert.alert(
                              "Vidéo indisponible",
                              "Impossible d’ouvrir cette vidéo sur cet appareil.",
                            );
                          });
                        }}
                        style={[styles.cardImage, styles.videoAction]}
                      >
                        <Play color="#2563eb" fill="#2563eb" size={25} />
                        <Text style={styles.videoActionText}>Ouvrir la vidéo</Text>
                      </Pressable>
                    ) : entry.imageUrl ? (
                      <Image
                        accessibilityLabel="Photo publiée"
                        resizeMode="cover"
                        source={{ uri: entry.imageUrl }}
                        style={styles.cardImage}
                      />
                    ) : null}
                    <Text style={styles.cardTitle}>{entry.title}</Text>
                    {entry.body ? <Text style={styles.body}>{entry.body}</Text> : null}
                    {entry.location ? (
                      <View style={styles.location}>
                        <MapPin color="#64748b" size={14} />
                        <Text style={styles.locationText}>{entry.location}</Text>
                      </View>
                    ) : null}
                  </View>
                ))}
                {!entries.length && !isLoading && (
                  <View style={styles.empty}>
                    <MapPin color="#94a3b8" size={30} />
                    <Text style={styles.emptyTitle}>Rien à signaler pour le moment</Text>
                    <Text style={styles.emptyText}>
                      Les publications correspondant à la portée sélectionnée apparaîtront ici.
                    </Text>
                  </View>
                )}
              </ScrollView>
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
  cardHeader: { alignItems: "center", flexDirection: "row" },
  icon: { alignItems: "center", backgroundColor: "#eff6ff", borderRadius: 12, height: 40, justifyContent: "center", width: 40 },
  alertIcon: { backgroundColor: "#fef2f2" },
  cardHeading: { flex: 1, marginLeft: 10 },
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
  location: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 11 },
  locationText: { color: "#64748b", fontSize: 12 },
  loading: { alignItems: "center", flex: 1, justifyContent: "center" },
  loadingText: { color: "#64748b", fontSize: 14, marginTop: 12 },
  skeletonList: { gap: 12, padding: 14 },
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
