import { CameraView, useCameraPermissions } from "expo-camera";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Location from "expo-location";
import {
  AlertTriangle,
  Camera,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Layers,
  MapPin,
  Mic,
  Plus,
  Radio,
  Search,
  ShoppingBag,
  ShieldAlert,
  X,
} from "lucide-react-native";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useFocusEffect,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import {
  Animated,
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, {
  Circle,
  Marker,
  Polygon,
  PROVIDER_GOOGLE,
  type Region,
} from "react-native-maps";
import { io, type Socket } from "socket.io-client";
import SosButton from "../components/SosButton";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import ProfileAvatar from "../components/ProfileAvatar";
import { API_BASE_URL, apiFetch, getStoredAuthToken } from "../services/api";
import type { MainTabParamList } from "../navigation/types";

type Coordinates = {
  latitude: number;
  longitude: number;
};

type SosStatus = "ACTIVE" | "CLOSED";

type SosAlert = {
  id: string;
  title: string;
  status: SosStatus;
  createdAt?: string;
  coordinates: Coordinates;
  escalationRadiusKm: 3 | 10 | 30;
  emergencyImageUrl?: string;
  emergencyAudioUrl?: string;
};

type MarkerCategory =
  | "POWER_OUTAGE"
  | "WATER_OUTAGE"
  | "ROAD_HAZARD"
  | "LOST_ITEM"
  | "MERCHANT_PRO"
  | "PUBLIC_POI"
  | "MUTUAL_AID"
  | "COMMUNITY_EVENT";

type MarkerLayer = "network" | "services" | "businesses" | "community";
type MapMarker = {
  id: string;
  category: MarkerCategory;
  title: string;
  description?: string;
  catalogUrl?: string;
  coordinates: Coordinates;
  radiusImpactMeters: number;
  isSponsored: boolean;
  confirmationsCount: number;
  status: "CONFIRMING" | "ACTIVE" | "RESOLVED" | "EXPIRED";
  expiresAt?: string;
};
type AllyProfile = {
  id: string;
  name: string | null;
  photoUrl: string | null;
  badge: string | null;
};
type SharedLocation = AllyProfile & {
  isAlly: boolean;
  latitude: number;
  longitude: number;
  updated_at: string;
};

type ScopeMeters = 3000 | 10000 | 30000;
type SosPhase = "closed" | "camera" | "preview" | "sending";

const SCOPE_OPTIONS: { label: string; meters: ScopeMeters }[] = [
  { label: "3 km", meters: 3000 },
  { label: "10 km", meters: 10000 },
  { label: "30 km", meters: 30000 },
];

const MARKER_CATEGORIES: MarkerCategory[] = [
  "POWER_OUTAGE",
  "WATER_OUTAGE",
  "ROAD_HAZARD",
  "LOST_ITEM",
  "MERCHANT_PRO",
  "PUBLIC_POI",
  "MUTUAL_AID",
  "COMMUNITY_EVENT",
];

const isMarkerCategory = (value: string): value is MarkerCategory =>
  MARKER_CATEGORIES.includes(value as MarkerCategory);

const isMapMarkerStatus = (value: string): value is MapMarker["status"] =>
  value === "CONFIRMING" ||
  value === "ACTIVE" ||
  value === "RESOLVED" ||
  value === "EXPIRED";

const MARKER_LAYERS: {
  id: MarkerLayer;
  label: string;
  categories: MarkerCategory[];
}[] = [
  {
    id: "network",
    label: "Réseaux & voirie",
    categories: ["POWER_OUTAGE", "WATER_OUTAGE", "ROAD_HAZARD"],
  },
  { id: "services", label: "Santé & services", categories: ["PUBLIC_POI"] },
  {
    id: "businesses",
    label: "Commerces & sponsors",
    categories: ["MERCHANT_PRO"],
  },
  {
    id: "community",
    label: "Événements & entraide",
    categories: ["MUTUAL_AID", "COMMUNITY_EVENT", "LOST_ITEM"],
  },
];

const MARKER_LABELS: Record<MarkerCategory, string> = {
  POWER_OUTAGE: "Coupure d'électricité",
  WATER_OUTAGE: "Coupure d'eau",
  ROAD_HAZARD: "Incident de voirie",
  LOST_ITEM: "Objet perdu",
  MERCHANT_PRO: "Commerce de proximité",
  PUBLIC_POI: "Service public",
  MUTUAL_AID: "Entraide",
  COMMUNITY_EVENT: "Événement local",
};

const MARKER_EMOJI: Record<MarkerCategory, string> = {
  POWER_OUTAGE: "⚡",
  WATER_OUTAGE: "💧",
  ROAD_HAZARD: "🚧",
  LOST_ITEM: "🔎",
  MERCHANT_PRO: "🛍️",
  PUBLIC_POI: "📍",
  MUTUAL_AID: "🤝",
  COMMUNITY_EVENT: "📅",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readCoordinates = (value: unknown): Coordinates | null => {
  if (Array.isArray(value) && value.length >= 2) {
    const longitude = Number(value[0]);
    const latitude = Number(value[1]);
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    ) {
      return { latitude, longitude };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { latitude, longitude };
};

const normalizeSos = (
  value: unknown,
  existing?: SosAlert,
): SosAlert | null => {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? value.sos_id ?? existing?.id ?? "");
  const coordinates =
    readCoordinates(value.coordinates) ??
    readCoordinates(value.location) ??
    readCoordinates(value) ??
    existing?.coordinates;
  if (!id || !coordinates) return null;

  const rawRadius = Number(
    value.escalation_radius_km ??
      value.broadcast_radius_km ??
      value.radius_km ??
      existing?.escalationRadiusKm ??
      3,
  );
  const escalationRadiusKm: SosAlert["escalationRadiusKm"] =
    rawRadius >= 30 ? 30 : rawRadius >= 10 ? 10 : 3;
  const status = String(value.status ?? existing?.status ?? "ACTIVE").toUpperCase();

  return {
    id,
    title: String(value.title ?? value.emergency_type ?? existing?.title ?? "Alerte SOS"),
    status: status === "CLOSED" ? "CLOSED" : "ACTIVE",
    createdAt:
      typeof value.created_at === "string"
        ? value.created_at
        : existing?.createdAt,
    coordinates,
    escalationRadiusKm,
    emergencyImageUrl:
      typeof value.emergency_image_url === "string"
        ? value.emergency_image_url
        : existing?.emergencyImageUrl,
    emergencyAudioUrl:
      typeof value.emergency_audio_url === "string"
        ? value.emergency_audio_url
        : existing?.emergencyAudioUrl,
  };
};

const distanceMeters = (from: Coordinates, to: Coordinates): number => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const formatSosTime = (createdAt?: string) => {
  if (!createdAt) return "Heure indisponible";
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(createdAt)) / 60_000),
  );
  if (elapsedMinutes < 1) return "À l’instant";
  if (elapsedMinutes < 60) return `Il y a ${elapsedMinutes} min`;
  return `Il y a ${Math.floor(elapsedMinutes / 60)} h`;
};

const normalizeMapMarker = (value: unknown): MapMarker | null => {
  if (!isRecord(value)) return null;
  const rawCategory = String(value.category ?? "").toUpperCase();
  const coordinates =
    readCoordinates(value.coordinates) ??
    readCoordinates(value.location) ??
    (isRecord(value.location) ? readCoordinates(value.location.coordinates) : null);
  const id = String(value.id ?? "");
  if (!id || !coordinates || !isMarkerCategory(rawCategory)) return null;
  const category = rawCategory;
  const rawStatus = String(value.status ?? "ACTIVE").toUpperCase();
  if (!isMapMarkerStatus(rawStatus)) return null;
  const status: MapMarker["status"] =
    rawStatus === "CONFIRMING"
      ? "CONFIRMING"
      : rawStatus === "ACTIVE"
        ? "ACTIVE"
        : rawStatus === "RESOLVED"
          ? "RESOLVED"
          : "EXPIRED";
  const radiusImpactMeters = Number(
    value.radius_impact_m ?? value.radiusImpactMeters ?? 500,
  );
  const confirmationsCount = Number(
    value.confirmations_count ?? value.confirmationsCount ?? 0,
  );
  if (
    !Number.isFinite(radiusImpactMeters) ||
    radiusImpactMeters < 0 ||
    !Number.isInteger(confirmationsCount) ||
    confirmationsCount < 0
  ) {
    return null;
  }
  return {
    id,
    category,
    title: String(value.title ?? MARKER_LABELS[category]),
    description:
      typeof value.description === "string" ? value.description : undefined,
    catalogUrl:
      typeof value.catalog_url === "string"
        ? value.catalog_url
        : typeof value.catalogUrl === "string"
          ? value.catalogUrl
          : undefined,
    coordinates,
    radiusImpactMeters,
    isSponsored: value.is_sponsored === true || value.isSponsored === true,
    confirmationsCount,
    status,
    expiresAt:
      typeof value.expires_at === "string"
        ? value.expires_at
        : typeof value.expiresAt === "string"
          ? value.expiresAt
          : undefined,
  };
};

const createRegion = (center: Coordinates, radiusMeters: ScopeMeters): Region => {
  const radiusKm = radiusMeters / 1000;
  return {
    ...center,
    latitudeDelta: Math.max((radiusKm * 2) / 111.32, 0.008),
    longitudeDelta: Math.max(
      (radiusKm * 2) /
        (111.32 * Math.max(Math.cos((center.latitude * Math.PI) / 180), 0.01)),
      0.008,
    ),
  };
};

const bearingPoint = (
  from: Coordinates,
  bearingDegrees: number,
  distanceMeters: number,
): Coordinates => {
  const bearing = (bearingDegrees * Math.PI) / 180;
  const angularDistance = distanceMeters / 6_371_000;
  const latitude = (from.latitude * Math.PI) / 180;
  const longitude = (from.longitude * Math.PI) / 180;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude),
    );
  return {
    latitude: (destinationLatitude * 180) / Math.PI,
    longitude: (destinationLongitude * 180) / Math.PI,
  };
};

export default function MapScreen() {
  const { colors } = useTheme();
  const route = useRoute<RouteProp<MainTabParamList, "CarteSOS">>();
  const { authStatus, requestAuthentication, token, isOffline, queueOfflineAction, user } = useAuth();

  const requireConnectedUser = useCallback(() => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return false;
    }
    return true;
  }, [authStatus, requestAuthentication]);
  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const userLocationRef = useRef<Coordinates | null>(null);
  const [locationAccuracy, setLocationAccuracy] = useState<number | null>(null);
  const [heading, setHeading] = useState(0);
  const [shareMode, setShareMode] = useState<"PRIVATE" | "ALLIES" | "SELECTED">("PRIVATE");
  const [shareDuration, setShareDuration] = useState<number | null>(1);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [selectedAllyIds, setSelectedAllyIds] = useState<string[]>([]);
  const [allies, setAllies] = useState<AllyProfile[]>([]);
  const [sharedLocations, setSharedLocations] = useState<SharedLocation[]>([]);
  const [initialRegion, setInitialRegion] = useState<Region | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState<ScopeMeters>(10000);
  const [isRadarExpanded, setIsRadarExpanded] = useState(true);
  const [isActiveAlertsExpanded, setIsActiveAlertsExpanded] = useState(false);
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);
  const [selectedSosId, setSelectedSosId] = useState<string | null>(null);
  const [mapMarkers, setMapMarkers] = useState<MapMarker[]>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [markerLoadError, setMarkerLoadError] = useState<string | null>(null);
  const [radarSearch, setRadarSearch] = useState("");
  const [visibleLayers, setVisibleLayers] = useState<Record<MarkerLayer, boolean>>({
    network: true,
    services: true,
    businesses: true,
    community: true,
  });
  const [isLayersVisible, setIsLayersVisible] = useState(false);
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [sosPhase, setSosPhase] = useState<SosPhase>("closed");
  const [cameraReady, setCameraReady] = useState(false);
  const [emergencyImageUri, setEmergencyImageUri] = useState<string | null>(null);
  const [captureCountdown, setCaptureCountdown] = useState(3);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [isCaptureAudioReady, setIsCaptureAudioReady] = useState(false);
  const [isReporting, setIsReporting] = useState(false);

  const mapRef = useRef<MapView>(null);
  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const recordingRef = useRef<typeof audioRecorder | null>(null);
  const audioStartPromiseRef = useRef<Promise<void> | null>(null);
  const locationPromiseRef = useRef<Promise<Location.LocationObject> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const captureSubmittedRef = useRef(false);
  const markerPulse = useRef(new Animated.Value(1)).current;

  useFocusEffect(
    useCallback(() => {
      if (!API_BASE_URL) return undefined;
      const controller = new AbortController();
      const loadSponsoredPins = async () => {
        if (authStatus !== "connected") return;
        try {
          const query = new URLSearchParams({
            radius_m: String(selectedScope),
            ...(userLocation
              ? {
                  latitude: String(userLocation.latitude),
                  longitude: String(userLocation.longitude),
                }
              : {}),
          });
          const response = await apiFetch(
            `${API_BASE_URL}/v1/payments/sponsored-pins?${query.toString()}`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            throw new Error(`Impossible de charger les épingles (HTTP ${response.status}).`);
          }
          const payload: unknown = await response.json();
          const pins =
            isRecord(payload) && Array.isArray(payload.pins)
              ? payload.pins
              : null;
          if (!pins) {
            throw new Error("La réponse des épingles sponsorisées est invalide.");
          }
          const normalized = pins.map(normalizeMapMarker);
          if (normalized.some((pin) => !pin)) {
            throw new Error("La liste contient une épingle sponsorisée invalide.");
          }
          const sponsoredPins = normalized.filter(
            (pin): pin is MapMarker => pin !== null,
          );
          setMapMarkers((current) => [
            ...current.filter((marker) => !marker.isSponsored),
            ...sponsoredPins,
          ]);
        } catch (error) {
          if (controller.signal.aborted) return;
          setMarkerLoadError(
            error instanceof Error
              ? error.message
              : "Impossible de charger les épingles sponsorisées.",
          );
        }
      };
      void loadSponsoredPins();
      return () => controller.abort();
    }, [authStatus, selectedScope, userLocation]),
  );

  const normalizedSearch = radarSearch.trim().toLocaleLowerCase("fr-FR");
  const matchesRadarSearch = (...values: Array<string | undefined>) =>
    !normalizedSearch || values.some((value) => value?.toLocaleLowerCase("fr-FR").includes(normalizedSearch));
  const activeAlerts = sosAlerts.filter((alert) => alert.status === "ACTIVE");
  const visibleAlerts = authStatus === "connected" && userLocation
    ? activeAlerts.filter(
        (alert) =>
          distanceMeters(userLocation, alert.coordinates) <= selectedScope &&
          matchesRadarSearch(alert.title),
      )
    : [];
  const visibleMarkers =
    userLocation
      ? mapMarkers.filter((marker) => {
          if (
            marker.status === "RESOLVED" ||
            marker.status === "EXPIRED" ||
            (marker.expiresAt && Date.parse(marker.expiresAt) <= Date.now())
          ) {
            return false;
          }
          const layer = MARKER_LAYERS.find((item) =>
            item.categories.includes(marker.category),
          );
          return (
            Boolean(layer && visibleLayers[layer.id]) &&
            distanceMeters(userLocation, marker.coordinates) <= selectedScope &&
            matchesRadarSearch(marker.title, marker.description, MARKER_LABELS[marker.category])
          );
        })
      : [];
  const selectedSos =
    activeAlerts.find((alert) => alert.id === selectedSosId) ?? null;
  const selectedMarker =
    visibleMarkers.find((marker) => marker.id === selectedMarkerId) ?? null;

  useEffect(() => {
    let isMounted = true;
    let locationSubscription: Location.LocationSubscription | null = null;
    let headingSubscription: Location.LocationSubscription | null = null;

    const startLocationTracking = async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") {
          if (isMounted) {
            setLocationError(
              "L'accès à la position est nécessaire pour afficher le radar.",
            );
          }
          return;
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        const coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        if (isMounted) {
          setUserLocation(coordinates);
          setLocationAccuracy(position.coords.accuracy);
          setInitialRegion(createRegion(coordinates, selectedScope));
          setLocationError(null);
        }

        locationSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: 50,
            timeInterval: 15_000,
          },
          (updatedPosition) => {
            if (!isMounted) return;
            setUserLocation({
              latitude: updatedPosition.coords.latitude,
              longitude: updatedPosition.coords.longitude,
            });
            setLocationAccuracy(updatedPosition.coords.accuracy);
          },
        );
        headingSubscription = await Location.watchHeadingAsync((value) => {
          if (isMounted) {
            setHeading(value.trueHeading >= 0 ? value.trueHeading : value.magHeading);
          }
        });
        if (!isMounted) locationSubscription.remove();
        if (!isMounted) headingSubscription.remove();
      } catch (error) {
        if (isMounted) {
          setLocationError(
            error instanceof Error
              ? `Impossible d'obtenir votre position : ${error.message}`
              : "Impossible d'obtenir votre position. Vérifiez le GPS et réessayez.",
          );
        }
      }
    };

    void startLocationTracking();
    return () => {
      isMounted = false;
      locationSubscription?.remove();
      headingSubscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "connected" || !API_BASE_URL) {
      setSharedLocations([]);
      return;
    }
    let active = true;
    const loadSharedLocations = async () => {
      const [locationResponse, alliesResponse, sharingResponse] = await Promise.all([
        apiFetch(`${API_BASE_URL}/v1/social/shared-locations`),
        apiFetch(`${API_BASE_URL}/v1/social/allies`),
        apiFetch(`${API_BASE_URL}/v1/social/location-sharing`),
      ]);
      if (!locationResponse.ok || !alliesResponse.ok || !sharingResponse.ok) {
        throw new Error("Impossible de charger les partages de position ou les alliés.");
      }
      const [locationPayload, alliesPayload, sharingPayload]: unknown[] = await Promise.all([
        locationResponse.json(),
        alliesResponse.json(),
        sharingResponse.json(),
      ]);
      const locationShareMode = isRecord(sharingPayload)
        ? sharingPayload.mode
        : null;
      if (
        !isRecord(locationPayload) ||
        !Array.isArray(locationPayload.locations) ||
        !isRecord(alliesPayload) ||
        !Array.isArray(alliesPayload.allies) ||
        !isRecord(sharingPayload) ||
        (locationShareMode !== "PRIVATE" &&
          locationShareMode !== "ALLIES" &&
          locationShareMode !== "SELECTED") ||
        !Array.isArray(sharingPayload.user_ids)
      ) {
        throw new Error("La réponse de partage de position est invalide.");
      }
      if (!active) return;
      setSharedLocations(
        locationPayload.locations.flatMap((item): SharedLocation[] => {
          if (
            !isRecord(item) ||
            typeof item.id !== "string" ||
            typeof item.latitude !== "number" ||
            typeof item.longitude !== "number" ||
            typeof item.updated_at !== "string"
          ) return [];
          return [{
            id: item.id,
            name: typeof item.name === "string" ? item.name : null,
            photoUrl:
              typeof item.profile_photo_url === "string"
                ? item.profile_photo_url
                : null,
            badge: typeof item.badge === "string" ? item.badge : null,
            isAlly: item.is_ally === true,
            latitude: item.latitude,
            longitude: item.longitude,
            updated_at: item.updated_at,
          }];
        }),
      );
      setAllies(
        alliesPayload.allies.flatMap((item): AllyProfile[] => {
          if (!isRecord(item) || typeof item.id !== "string") return [];
          return [{
            id: item.id,
            name: typeof item.name === "string" ? item.name : null,
            photoUrl:
              typeof item.profile_photo_url === "string"
                ? item.profile_photo_url
                : null,
            badge: typeof item.badge === "string" ? item.badge : null,
          }];
        }),
      );
      setShareMode(locationShareMode);
      setSelectedAllyIds(
        sharingPayload.user_ids.filter((id): id is string => typeof id === "string"),
      );
      if (sharingPayload.expires_at === null || sharingPayload.expires_at === undefined) {
        setShareDuration(null);
      } else if (typeof sharingPayload.expires_at === "string") {
        const remainingHours = Math.max(
          1,
          (new Date(sharingPayload.expires_at).getTime() - Date.now()) / 3_600_000,
        );
        setShareDuration(remainingHours <= 1 ? 1 : remainingHours <= 8 ? 8 : 24);
      }
    };
    void loadSharedLocations().catch((error: unknown) => {
      if (active) {
        console.error("Unable to load consented shared locations:", error);
        setMarkerLoadError(error instanceof Error ? error.message : "Partages indisponibles.");
      }
    });
    const interval = setInterval(() => {
      void loadSharedLocations().catch((error: unknown) => {
        if (active) console.error("Unable to refresh shared locations:", error);
      });
    }, 60_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [authStatus]);

  useEffect(() => {
    userLocationRef.current = userLocation;
  }, [userLocation]);

  useEffect(() => {
    if (shareMode === "PRIVATE" || authStatus !== "connected" || !API_BASE_URL) return;
    const interval = setInterval(() => {
      const current = userLocationRef.current;
      if (!current) return;
      void apiFetch(`${API_BASE_URL}/v1/social/location-sharing/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload: unknown = await response.json();
            throw new Error(
              isRecord(payload) && typeof payload.error === "string"
                ? payload.error
                : `Le partage a expiré (HTTP ${response.status}).`,
            );
          }
        })
        .catch((error: unknown) => {
          console.error("Unable to refresh consented location share:", error);
          setShareMode("PRIVATE");
        });
    }, 30_000);
    return () => clearInterval(interval);
  }, [authStatus, shareMode]);

  useEffect(() => {
    if (!API_BASE_URL || (!userLocation && authStatus !== "guest")) return;
    const controller = new AbortController();
    const loadMarkers = async () => {
      try {
        const query = new URLSearchParams({ radius_m: String(selectedScope) });
        if (authStatus === "connected" && userLocation) {
          query.set("latitude", String(userLocation.latitude));
          query.set("longitude", String(userLocation.longitude));
        }
        const endpoint = authStatus === "guest"
          ? `${API_BASE_URL}/v1/public/map/markers?${query.toString()}`
          : `${API_BASE_URL}/v1/map/markers?${query.toString()}`;
        const response = await apiFetch(
          endpoint,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Chargement des marqueurs refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const rawMarkers = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.markers)
            ? payload.markers
            : null;
        if (!rawMarkers) {
          throw new Error("Le serveur a renvoyé une liste de marqueurs invalide.");
        }
        const normalizedMarkers = rawMarkers.map(normalizeMapMarker);
        if (normalizedMarkers.some((marker) => marker === null)) {
          throw new Error("La liste contient un marqueur invalide.");
        }
        setMapMarkers((current) => [
          ...normalizedMarkers.filter(
            (marker): marker is MapMarker => marker !== null,
          ),
          ...current.filter((marker) => marker.isSponsored),
        ]);
        setMarkerLoadError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMarkerLoadError(
          error instanceof Error
            ? error.message
            : "Impossible de charger les marqueurs de la carte.",
        );
      }
    };
    void loadMarkers();
    return () => controller.abort();
  }, [authStatus, isOffline, selectedScope, userLocation]);

  useEffect(() => {
    if (activeAlerts.length === 0) {
      markerPulse.stopAnimation();
      markerPulse.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(markerPulse, {
          duration: 600,
          toValue: 1.1,
          useNativeDriver: true,
        }),
        Animated.timing(markerPulse, {
          duration: 600,
          toValue: 0.9,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [activeAlerts.length, markerPulse]);

  useEffect(() => {
    if (!API_BASE_URL) {
      setSocketState("offline");
      return;
    }

    let socket: Socket | null = null;
    let cancelled = false;
    setSocketState("connecting");
    void (async () => {
      const token = await getStoredAuthToken();
      if (cancelled) return;
      if (!token) {
        setSocketState("offline");
        return;
      }
      socket = io(API_BASE_URL, {
        auth: { token },
        transports: ["websocket"],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10_000,
      });
      const activeSocket = socket;
      socketRef.current = activeSocket;
      activeSocket.on("connect", () => {
        setSocketState("connected");
      });
      activeSocket.on("disconnect", () => setSocketState("offline"));
      activeSocket.on("connect_error", () => setSocketState("offline"));
      activeSocket.on("sos:new_alert", (payload: unknown) => {
        const alert = normalizeSos(payload);
        if (!alert) return;
        setSosAlerts((current) => [
          alert,
          ...current.filter((item) => item.id !== alert.id),
        ]);
      });
      activeSocket.on("sos:new", (payload: unknown) => {
        const alert = normalizeSos(payload);
        if (!alert) return;
        setSosAlerts((current) => [
          alert,
          ...current.filter((item) => item.id !== alert.id),
        ]);
      });
      activeSocket.on("sos:update", (payload: unknown) => {
        if (!isRecord(payload)) return;
        const id = String(payload.id ?? payload.sos_id ?? "");
        if (!id) return;
        setSosAlerts((current) => {
          const existing = current.find((alert) => alert.id === id);
          const updated = normalizeSos(payload, existing);
          if (!updated) return current;
          return current.map((alert) => (alert.id === id ? updated : alert));
        });
      });
      activeSocket.on("sos:closed", (payload: unknown) => {
        const id =
          typeof payload === "string"
            ? payload
            : isRecord(payload)
              ? String(payload.id ?? payload.sos_id ?? "")
              : "";
        if (!id) return;
        setSosAlerts((current) => current.filter((alert) => alert.id !== id));
        setSelectedSosId((current) => (current === id ? null : current));
      });
      activeSocket.on("map:marker:new", (payload: unknown) => {
        const marker = normalizeMapMarker(payload);
        if (!marker) return;
        setMapMarkers((current) => [
          marker,
          ...current.filter((item) => item.id !== marker.id),
        ]);
      });
      activeSocket.on("map:marker:update", (payload: unknown) => {
        const marker = normalizeMapMarker(payload);
        if (!marker) return;
        setMapMarkers((current) =>
          current.map((item) => (item.id === marker.id ? marker : item)),
        );
      });
    })().catch((error: unknown) => {
      console.error("Unable to initialize the authenticated map socket:", error);
      if (!cancelled) setSocketState("offline");
    });

    return () => {
      cancelled = true;
      if (socketRef.current === socket) socketRef.current = null;
      socket?.removeAllListeners();
      socket?.disconnect();
    };
  }, [token]);

  useEffect(() => {
    const activeSocket = socketRef.current;
    if (authStatus !== "connected" || socketState !== "connected" || !activeSocket?.connected || !userLocation) {
      return;
    }
    activeSocket.emit("sos:location_update", {
      latitude: userLocation.latitude,
      longitude: userLocation.longitude,
    });
  }, [authStatus, socketState, userLocation]);

  const handleSosAlert = useCallback((payload: unknown) => {
    const alert = normalizeSos(payload);
    if (!alert) {
      console.error("The SOS socket acknowledgement contained an invalid alert.");
      return;
    }
    setSosAlerts((current) => [
      alert,
      ...current.filter((item) => item.id !== alert.id),
    ]);
  }, []);

  useEffect(() => {
    if (sosPhase !== "preview") return;
    if (!isCaptureAudioReady) return;
    if (captureCountdown === 0) {
      void submitSos();
      return;
    }
    countdownTimerRef.current = setTimeout(
      () => setCaptureCountdown((current) => Math.max(0, current - 1)),
      1000,
    );
    return () => {
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    };
  }, [captureCountdown, isCaptureAudioReady, sosPhase]);

  useEffect(
    () => () => {
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      abortControllerRef.current?.abort();
      const recording = recordingRef.current;
      if (recording?.isRecording) void recording.stop().catch(() => undefined);
    },
    [],
  );

  const chooseScope = (meters: ScopeMeters) => {
    setSelectedScope(meters);
    if (userLocation) {
      const region = createRegion(userLocation, meters);
      setInitialRegion(region);
      mapRef.current?.animateToRegion(region, 350);
    }
  };

  const saveLocationSharing = async (mode = shareMode) => {
    if (!requireConnectedUser()) return;
    if (!userLocation || !API_BASE_URL) {
      Alert.alert("Position indisponible", "Attendez la localisation GPS avant de partager.");
      return;
    }
    if (mode === "SELECTED" && selectedAllyIds.length === 0) {
      Alert.alert("Choisissez des alliés", "Sélectionnez au moins une personne.");
      return;
    }
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/social/location-sharing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          latitude: userLocation.latitude,
          longitude: userLocation.longitude,
          duration_hours: shareDuration,
          user_ids: mode === "SELECTED" ? selectedAllyIds : [],
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `Le partage a échoué (HTTP ${response.status}).`,
        );
      }
      setShareMode(mode);
      setShareModalVisible(false);
    } catch (error) {
      Alert.alert(
        "Partage impossible",
        error instanceof Error ? error.message : "Réessayez.",
      );
    }
  };

  const openSosCamera = async () => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    setCaptureError(null);
    setEmergencyImageUri(null);
    setIsCaptureAudioReady(false);
    setIsRecordingAudio(false);
    setCameraReady(false);
    setCaptureCountdown(3);
    setSosPhase("camera");

    try {
      const permission = cameraPermission?.granted
        ? cameraPermission
        : await requestCameraPermission();
      if (!permission.granted) {
        setCaptureError("L'accès à la caméra est nécessaire pour l'alerte SOS.");
        return;
      }

      const audioPermission = await requestRecordingPermissionsAsync();
      if (!audioPermission.granted) {
        setCaptureError(
          "L'accès au microphone est requis pour joindre les 3 secondes d'audio ambiant.",
        );
      }
    } catch (error) {
      setCaptureError(
        error instanceof Error
          ? `Impossible d'ouvrir la caméra ou le microphone : ${error.message}`
          : "Impossible d'ouvrir la caméra ou le microphone.",
      );
    }
  };

  const recordAmbientAudio = async () => {
    const recording = audioRecorder;
    const captureController = abortControllerRef.current;
    recordingRef.current = recording;
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recording.prepareToRecordAsync();
      if (captureController?.signal.aborted) {
        if (recordingRef.current === recording) recordingRef.current = null;
        return;
      }
      recording.record();
      if (captureController?.signal.aborted) {
        await recording.stop();
        if (recordingRef.current === recording) recordingRef.current = null;
        return;
      }
      setIsRecordingAudio(true);
      setIsCaptureAudioReady(true);
    } catch (error) {
      if (recordingRef.current === recording) recordingRef.current = null;
      setIsRecordingAudio(false);
      throw error;
    }
  };

  const captureEmergency = async () => {
    if (!cameraReady || !cameraRef.current || captureError) return;
    setCaptureError(null);
    captureSubmittedRef.current = false;
    abortControllerRef.current = new AbortController();

    try {
      const currentLocation = Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      const picture = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        skipProcessing: false,
      });
      if (!picture.uri) {
        throw new Error("La caméra n'a fourni aucune image.");
      }

      setEmergencyImageUri(picture.uri);
      setCaptureCountdown(3);
      setSosPhase("preview");
      locationPromiseRef.current = currentLocation;
      audioStartPromiseRef.current = recordAmbientAudio();
      void audioStartPromiseRef.current.catch((error: unknown) => {
        if (abortControllerRef.current?.signal.aborted) return;
        setCaptureError(
          error instanceof Error
            ? `Échec de l'enregistrement audio : ${error.message}`
            : "Échec de l'enregistrement audio. L'alerte ne sera pas envoyée.",
        );
      });
    } catch (error) {
      setCaptureError(
        error instanceof Error
          ? `La capture a échoué : ${error.message}`
          : "La capture de la photo d'urgence a échoué.",
      );
    }
  };

  const stopRecording = async (): Promise<string | null> => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecordingAudio(false);
    if (!recording) return null;
    if (recording.isRecording) await recording.stop();
    const uri = recording.uri;
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    });
    return uri;
  };

  const dismissSosFlow = () => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    void stopRecording().catch(() => undefined);
    locationPromiseRef.current = null;
    audioStartPromiseRef.current = null;
    setIsRecordingAudio(false);
    setIsCaptureAudioReady(false);
    setCaptureError(null);
    setEmergencyImageUri(null);
    setSosPhase("closed");
  };

  const retakeEmergencyPhoto = () => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    void stopRecording().catch(() => undefined);
    locationPromiseRef.current = null;
    audioStartPromiseRef.current = null;
    captureSubmittedRef.current = false;
    setCaptureError(null);
    setEmergencyImageUri(null);
    setCaptureCountdown(3);
    setIsCaptureAudioReady(false);
    setCameraReady(false);
    setSosPhase("camera");
  };

  const submitSos = async () => {
    if (captureSubmittedRef.current || !emergencyImageUri) return;
    captureSubmittedRef.current = true;
    setSosPhase("sending");

    try {
      if (!API_BASE_URL) {
        throw new Error(
          "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
        );
      }
      const [position] = await Promise.all([
        locationPromiseRef.current,
        audioStartPromiseRef.current,
      ]);
      if (!position) {
        throw new Error("La position GPS actuelle est indisponible.");
      }

      // expo-location exposes Android's isFromMockProvider flag as `mocked`.
      const isFromMockProvider = position.mocked === true;
      if (isFromMockProvider) {
        throw new Error("Position GPS non sécurisée");
      }

      const audioUri = await stopRecording();
      if (!audioUri) {
        throw new Error("Aucun audio ambiant n'a pu être enregistré.");
      }
      const controller = abortControllerRef.current;
      if (!controller || controller.signal.aborted) return;

      if (isOffline) {
        const persistentImage = new File(
          Paths.document,
          `sos-offline-${Date.now()}.jpg`,
        );
        const persistentAudio = new File(
          Paths.document,
          `sos-offline-${Date.now()}.m4a`,
        );
        await new File(emergencyImageUri).copy(persistentImage);
        await new File(audioUri).copy(persistentAudio);
        await queueOfflineAction("trigger_sos", {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          emergency_type: "OTHER",
          accuracy_m: position.coords.accuracy,
          mocked: position.mocked === true,
          emergency_image_uri: persistentImage.uri,
          ambient_audio_uri: persistentAudio.uri,
        });
        dismissSosFlow();
        Alert.alert(
          "SOS en attente de connexion",
          "Aucune alerte n'a encore été transmise. Votre signalement sera envoyé dès le retour du réseau. Si vous êtes en danger immédiat, appelez un numéro d'urgence officiel.",
        );
        return;
      }

      const activeSocket = socketRef.current;
      if (!activeSocket?.connected) {
        throw new Error("La connexion SOS est indisponible. Réessayez dans un instant.");
      }
      const result = await new Promise<unknown>((resolve, reject) => {
        activeSocket.timeout(10_000).emit(
          "sos:trigger",
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            emergency_type: "OTHER",
          },
          (timeoutError: Error | null, payload: unknown) => {
            if (timeoutError) {
              reject(new Error("Le serveur n’a pas confirmé l’alerte SOS."));
              return;
            }
            if (!isRecord(payload) || payload.ok !== true) {
              reject(
                new Error(
                  isRecord(payload) && typeof payload.error === "string"
                    ? payload.error
                    : "Le serveur a refusé l’alerte SOS.",
                ),
              );
              return;
            }
            resolve(payload);
          },
        );
      });
      if (controller.signal.aborted) return;
      if (isRecord(result) && result.alert) handleSosAlert(result.alert);

      dismissSosFlow();
      Alert.alert("Alerte SOS envoyée", "Votre alerte a été transmise au réseau.");
    } catch (error) {
      if (abortControllerRef.current?.signal.aborted) return;
      let errorMessage =
        error instanceof Error
          ? error.message
          : "L'alerte n'a pas pu être envoyée. Réessayez.";
      try {
        await stopRecording();
      } catch (recordingError) {
        const recordingMessage =
          recordingError instanceof Error
            ? recordingError.message
            : "erreur inconnue";
        errorMessage += ` Impossible d'arrêter l'enregistrement audio : ${recordingMessage}`;
      }
      setIsCaptureAudioReady(false);
      setSosPhase("preview");
      setCaptureError(errorMessage);
    }
  };

  const helpOnSos = async (alert: SosAlert) => {
    if (!requireConnectedUser()) return;
    if (!API_BASE_URL) {
      Alert.alert(
        "Connexion indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/sos/${encodeURIComponent(alert.id)}/assist`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(`La confirmation a échoué (HTTP ${response.status}).`);
      }
      Alert.alert("Merci pour votre aide", "Votre arrivée a été signalée.");
    } catch (error) {
      Alert.alert(
        "Impossible de confirmer",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const reportFakeSos = async (alert: SosAlert) => {
    if (!requireConnectedUser()) return;
    if (!API_BASE_URL || isReporting) {
      if (!API_BASE_URL) {
        Alert.alert(
          "Connexion indisponible",
          "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
        );
      }
      return;
    }
    setIsReporting(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/sos/${encodeURIComponent(alert.id)}/report-fake`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Le signalement a échoué (HTTP ${response.status}).`,
        );
      }
      Alert.alert(
        "Signalement transmis",
        "L'équipe de modération va vérifier cette alerte.",
      );
    } catch (error) {
      Alert.alert(
        "Impossible de signaler",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsReporting(false);
    }
  };

  const createMapReport = async (
    category: "POWER_OUTAGE" | "WATER_OUTAGE" | "ROAD_HAZARD" | "LOST_ITEM",
  ) => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) {
      Alert.alert(
        "Connexion indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      const response = await apiFetch(`${API_BASE_URL}/v1/map/markers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          title: MARKER_LABELS[category],
          location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
          radius_impact_m: 500,
        }),
      });
      if (!response.ok) {
        throw new Error(`Le signalement a échoué (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const marker = normalizeMapMarker(payload);
      if (!marker) {
        throw new Error("Le serveur a accepté le signalement sans renvoyer le marqueur.");
      }
      setMapMarkers((current) => [
        marker,
        ...current.filter((item) => item.id !== marker.id),
      ]);
      Alert.alert(
        "Signalement envoyé",
        category === "POWER_OUTAGE" || category === "WATER_OUTAGE"
          ? "La coupure apparaît en cours de confirmation. Trois validations de voisins à moins de 500 m sont nécessaires."
          : "Le signalement apparaît maintenant sur la carte.",
      );
    } catch (error) {
      Alert.alert(
        "Impossible d'ajouter ce signalement",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const confirmOutage = async (marker: MapMarker) => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL || !userLocation) {
      Alert.alert(
        "Connexion indisponible",
        !API_BASE_URL
          ? "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL)."
          : "Votre position est nécessaire pour confirmer une coupure.",
      );
      return;
    }
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/map/markers/${encodeURIComponent(marker.id)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            latitude: userLocation.latitude,
            longitude: userLocation.longitude,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`La confirmation a échoué (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const updatedMarker = normalizeMapMarker(payload);
      if (!updatedMarker) {
        throw new Error("Le serveur n'a pas renvoyé l'état actualisé du marqueur.");
      }
      setMapMarkers((current) =>
        current.map((item) => (item.id === updatedMarker.id ? updatedMarker : item)),
      );
      Alert.alert(
        updatedMarker.status === "ACTIVE" ? "Coupure confirmée" : "Confirmation enregistrée",
        updatedMarker.status === "ACTIVE"
          ? "Le signalement a reçu trois validations de proximité."
          : `${updatedMarker.confirmationsCount} validation(s) sur 3.`,
      );
    } catch (error) {
      Alert.alert(
        "Impossible de confirmer",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const promptOutageReport = () => {
    Alert.alert("Ajouter sur la carte", "Choisissez le type de signalement.", [
      { text: "Électricité", onPress: () => void createMapReport("POWER_OUTAGE") },
      { text: "Eau potable", onPress: () => void createMapReport("WATER_OUTAGE") },
      { text: "Travaux ou danger routier", onPress: () => void createMapReport("ROAD_HAZARD") },
      { text: "Objet perdu", onPress: () => void createMapReport("LOST_ITEM") },
      { text: "SOS avec photo ou audio", onPress: () => void openSosCamera() },
      { text: "Annuler", style: "cancel" },
    ]);
  };

  const openMerchantCatalog = async (marker: MapMarker) => {
    if (!marker.catalogUrl) {
      Alert.alert(
        "Catalogue indisponible",
        "La fiche catalogue de ce commerce n'est pas encore renseignée.",
      );
      return;
    }
    try {
      const catalogUrl = new URL(marker.catalogUrl);
      if (catalogUrl.protocol !== "https:") {
        throw new Error("La fiche catalogue doit utiliser une adresse HTTPS sécurisée.");
      }
      await Linking.openURL(catalogUrl.toString());
    } catch (error) {
      Alert.alert(
        "Impossible d'ouvrir le catalogue",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const alertDistanceLabel = (alert: SosAlert) => {
    if (!userLocation) return "Distance indisponible";
    const meters = distanceMeters(userLocation, alert.coordinates);
    return meters < 1000
      ? `À environ ${Math.max(100, Math.round(meters / 100) * 100)} m`
      : `À environ ${Math.round(meters / 1000)} km`;
  };

  const openEmergencyAudio = async (audioUrl: string) => {
    try {
      const parsedUrl = new URL(audioUrl);
      if (parsedUrl.protocol !== "https:") {
        throw new Error("Le média d'urgence doit utiliser une adresse HTTPS.");
      }
      await Linking.openURL(parsedUrl.toString());
    } catch (error) {
      Alert.alert(
        "Audio indisponible",
        error instanceof Error ? error.message : "Impossible d'ouvrir l'audio d'urgence.",
      );
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {userLocation && initialRegion ? (
        <MapView
          initialRegion={initialRegion}
          provider={PROVIDER_GOOGLE}
          ref={mapRef}
          showsMyLocationButton
          showsUserLocation
          style={styles.map}
        >
          <Circle
            center={userLocation}
            fillColor="rgba(37, 99, 235, 0.10)"
            radius={selectedScope}
            strokeColor="rgba(37, 99, 235, 0.65)"
            strokeWidth={2}
          />
          {locationAccuracy !== null ? (
            <Circle
              center={userLocation}
              fillColor="rgba(14, 165, 233, 0.10)"
              radius={Math.max(3, locationAccuracy)}
              strokeColor="rgba(14, 165, 233, 0.55)"
              strokeWidth={1}
            />
          ) : null}
          <Polygon
            coordinates={[
              userLocation,
              bearingPoint(userLocation, heading - 18, 90),
              bearingPoint(userLocation, heading + 18, 90),
            ]}
            fillColor="rgba(37,99,235,0.22)"
            strokeColor="rgba(37,99,235,0.45)"
            strokeWidth={1}
          />
          <Marker coordinate={userLocation} title="Vous" anchor={{ x: 0.5, y: 0.5 }}>
            <ProfileAvatar
              name={user?.name}
              photoUrl={
                typeof user?.profile_photo_url === "string"
                  ? user.profile_photo_url
                  : null
              }
              size={42}
              isProVerified={user?.badge === "Commerçant Certifié"}
            />
          </Marker>
          {sharedLocations.map((location) => (
            <Marker
              key={`shared:${location.id}`}
              coordinate={{ latitude: location.latitude, longitude: location.longitude }}
              title={location.name || "Allié"}
              description={`Position actualisée ${new Date(location.updated_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`}
            >
              <ProfileAvatar
                name={location.name}
                photoUrl={location.photoUrl}
                size={42}
                isAlly={location.isAlly}
                isProVerified={location.badge === "Commerçant Certifié"}
              />
            </Marker>
          ))}
          {visibleMarkers.map((marker) => (
            <Fragment key={marker.id}>
              {marker.radiusImpactMeters > 0 && (
                <Circle
                  center={marker.coordinates}
                  fillColor={
                    marker.isSponsored
                      ? "rgba(217, 119, 6, 0.10)"
                      : "rgba(71, 85, 105, 0.08)"
                  }
                  radius={marker.radiusImpactMeters}
                  strokeColor={
                    marker.isSponsored
                      ? "rgba(217, 119, 6, 0.55)"
                      : "rgba(71, 85, 105, 0.40)"
                  }
                  strokeWidth={1}
                />
              )}
              <Marker
                coordinate={marker.coordinates}
                onPress={() => {
                  setSelectedSosId(null);
                  setSelectedMarkerId(marker.id);
                }}
                title={marker.title}
                description={
                  marker.status === "CONFIRMING"
                    ? `En cours de confirmation · ${marker.confirmationsCount}/3`
                    : MARKER_LABELS[marker.category]
                }
              >
                <View
                  style={[
                    styles.publicMarker,
                    marker.isSponsored && styles.sponsoredMarker,
                    marker.status === "CONFIRMING" && styles.confirmingMarker,
                  ]}
                >
                  <Text style={styles.publicMarkerEmoji}>
                    {MARKER_EMOJI[marker.category]}
                  </Text>
                </View>
              </Marker>
            </Fragment>
          ))}
          {visibleAlerts.map((alert) => (
            <Fragment key={alert.id}>
              <Circle
                center={alert.coordinates}
                fillColor="rgba(220, 38, 38, 0.10)"
                radius={alert.escalationRadiusKm * 1000}
                strokeColor="rgba(220, 38, 38, 0.55)"
                strokeWidth={2}
              />
              <Marker
                coordinate={alert.coordinates}
                onPress={() => setSelectedSosId(alert.id)}
                title={alert.title}
                description="Zone approximative d'une alerte SOS active"
              >
                <Animated.View
                  style={[
                    styles.sosMarker,
                    {
                      opacity: markerPulse,
                      transform: [{ scale: markerPulse }],
                    },
                  ]}
                >
                  <ShieldAlert color="#ffffff" size={19} />
                </Animated.View>
              </Marker>
            </Fragment>
          ))}
        </MapView>
      ) : (
        <View style={styles.mapLoading}>
          {locationError ? (
            <>
              <MapPin color="#dc2626" size={30} />
              <Text style={styles.locationError}>{locationError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setLocationError(null);
                  void Location.requestForegroundPermissionsAsync().then(
                    async (permission) => {
                      if (permission.status !== "granted") {
                        setLocationError(
                          "L'accès à la position est nécessaire pour afficher le radar.",
                        );
                        return;
                      }
                      try {
                        const position = await Location.getCurrentPositionAsync({
                          accuracy: Location.Accuracy.High,
                        });
                        const coordinates = {
                          latitude: position.coords.latitude,
                          longitude: position.coords.longitude,
                        };
                        setUserLocation(coordinates);
                        setInitialRegion(createRegion(coordinates, selectedScope));
                      } catch (error) {
                        setLocationError(
                          error instanceof Error
                            ? `Impossible d'obtenir votre position : ${error.message}`
                            : "Impossible d'obtenir votre position.",
                        );
                      }
                    },
                  ).catch((error: unknown) => {
                    setLocationError(
                      error instanceof Error
                        ? `Impossible de demander l'accès GPS : ${error.message}`
                        : "Impossible de demander l'accès GPS.",
                    );
                  });
                }}
                style={styles.retryButton}
              >
                <Text style={styles.retryText}>Réessayer</Text>
              </Pressable>
            </>
          ) : (
            <>
              <ActivityIndicator color="#2563eb" size="large" />
              <Text style={styles.loadingText}>Localisation du radar…</Text>
            </>
          )}
        </View>
      )}

      <View style={styles.mapQuickActions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShareModalVisible(true)}
          style={styles.shareLocationButton}
        >
          <Text style={styles.shareLocationText}>
            {shareMode === "PRIVATE"
              ? "Mode fantôme · Moi seul"
              : shareMode === "ALLIES"
                ? "Position partagée · Alliés"
                : "Position partagée · Choisis"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Recentrer la carte sur ma position"
          accessibilityRole="button"
          onPress={() => {
            if (!userLocation) return;
            const region = createRegion(userLocation, selectedScope);
            setInitialRegion(region);
            mapRef.current?.animateToRegion(region, 350);
          }}
          style={styles.recenterButton}
        >
          <MapPin color="#1d4ed8" size={19} />
        </Pressable>
      </View>

      <View style={styles.scopeBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: isRadarExpanded }}
          onPress={() => setIsRadarExpanded((expanded) => !expanded)}
          style={styles.radarHeading}
        >
          <Text style={styles.scopeHeading}>CARTE DU RADAR</Text>
          {isRadarExpanded ? (
            <ChevronUp color="#64748b" size={18} />
          ) : (
            <ChevronDown color="#64748b" size={18} />
          )}
        </Pressable>
        {isRadarExpanded ? (
          <>
            <View style={styles.radarSearchBox}>
              <Search color="#64748b" size={17} />
              <TextInput
                accessibilityLabel="Rechercher sur le radar"
                onChangeText={setRadarSearch}
                placeholder="Commerce, service, événement…"
                placeholderTextColor="#94a3b8"
                returnKeyType="search"
                style={styles.radarSearchInput}
                value={radarSearch}
              />
              {radarSearch.length > 0 && (
                <Pressable accessibilityLabel="Effacer la recherche" accessibilityRole="button" onPress={() => setRadarSearch("")}>
                  <X color="#64748b" size={17} />
                </Pressable>
              )}
            </View>
            <ScrollView
              contentContainerStyle={styles.scopeOptions}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {SCOPE_OPTIONS.map((option) => {
                const isSelected = selectedScope === option.meters;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={option.meters}
                    onPress={() => chooseScope(option.meters)}
                    style={[styles.scopeChip, isSelected && styles.scopeChipSelected]}
                  >
                    <Text
                      style={[
                        styles.scopeChipText,
                        isSelected && styles.scopeChipTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsLayersVisible(true)}
              style={styles.layersButton}
            >
              <Layers color="#1d4ed8" size={17} />
              <Text style={styles.layersButtonText}>Couches de la carte</Text>
              <Text style={styles.layersCount}>
                {Object.values(visibleLayers).filter(Boolean).length}/4
              </Text>
            </Pressable>
            <View style={styles.connectionBadge}>
              <Radio
                color={socketState === "connected" ? "#15803d" : "#64748b"}
                size={14}
              />
              <View
                style={[
                  styles.connectionDot,
                  socketState === "connected" && styles.connectionDotConnected,
                  socketState === "offline" && styles.connectionDotOffline,
                ]}
              />
              <Text style={styles.connectionText}>
                {socketState === "connected"
                  ? "Radar connecté"
                  : socketState === "connecting"
                    ? "Connexion au radar…"
                    : API_BASE_URL
                      ? "Radar hors ligne"
                      : "Serveur non configuré"}
              </Text>
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.radarLegend}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: isActiveAlertsExpanded }}
          onPress={() => setIsActiveAlertsExpanded((expanded) => !expanded)}
          style={styles.alertsHeading}
        >
          <View style={styles.legendSos} />
          <Text style={styles.legendText}>SOS actifs · {visibleAlerts.length}</Text>
          {isActiveAlertsExpanded ? (
            <ChevronDown color="#64748b" size={16} />
          ) : (
            <ChevronUp color="#64748b" size={16} />
          )}
        </Pressable>
        {isActiveAlertsExpanded
          ? visibleAlerts.slice(0, 5).map((alert) => (
              <Pressable
                accessibilityRole="button"
                key={alert.id}
                onPress={() => setSelectedSosId(alert.id)}
                style={styles.activeAlertRow}
              >
                <Text numberOfLines={1} style={styles.activeAlertCategory}>
                  {alert.title} · ACTIVE
                </Text>
                <Text style={styles.activeAlertDetails}>
                  {alertDistanceLabel(alert)} · {formatSosTime(alert.createdAt)}
                </Text>
              </Pressable>
            ))
          : null}
        {markerLoadError && (
          <Text accessibilityRole="alert" style={styles.markerLoadError}>
            {markerLoadError}
          </Text>
        )}
      </View>

      {selectedSos && (
        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.alertHeader}>
            <View style={styles.alertIcon}>
              <AlertTriangle color="#dc2626" size={21} />
            </View>
            <View style={styles.alertCopy}>
              <Text style={styles.alertEyebrow}>URGENCE · ACTIVE</Text>
              <Text numberOfLines={2} style={styles.alertTitle}>
                {selectedSos.title}
              </Text>
              <Text style={styles.alertDistance}>
                {alertDistanceLabel(selectedSos)}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Fermer les détails de l'alerte"
              accessibilityRole="button"
              onPress={() => setSelectedSosId(null)}
              style={styles.closeSheetButton}
            >
              <X color="#64748b" size={20} />
            </Pressable>
          </View>
          {selectedSos.emergencyImageUrl ? (
            <Image
              accessibilityLabel="Photo d'urgence capturée en direct"
              source={{ uri: selectedSos.emergencyImageUrl }}
              style={styles.emergencyPhoto}
            />
          ) : (
            <View style={styles.photoUnavailable}>
              <Camera color="#64748b" size={20} />
              <Text style={styles.photoUnavailableText}>
                Photo d'urgence non disponible
              </Text>
            </View>
          )}
          {selectedSos.emergencyAudioUrl ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const audioUrl = selectedSos.emergencyAudioUrl;
                if (audioUrl) void openEmergencyAudio(audioUrl);
              }}
              style={styles.assistButton}
            >
              <Mic color="#ffffff" size={17} />
              <Text style={styles.actionButtonText}>Écouter l'audio d'urgence</Text>
            </Pressable>
          ) : null}
          <View style={styles.alertActions}>
            <Pressable
              accessibilityRole="button"
              disabled={authStatus !== "connected"}
              onPress={() => void helpOnSos(selectedSos)}
              style={styles.assistButton}
            >
              <CheckCircle color="#ffffff" size={18} />
              <Text style={styles.actionButtonText}>J'arrive 🏃‍♂️</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={authStatus !== "connected" || isReporting}
              onPress={() => void reportFakeSos(selectedSos)}
              style={styles.fakeReportButton}
            >
              {isReporting ? (
                <ActivityIndicator color="#b91c1c" size="small" />
              ) : (
                <AlertTriangle color="#b91c1c" size={17} />
              )}
              <Text style={styles.fakeReportText}>Signaler Fausse Alerte ⚠️</Text>
            </Pressable>
          </View>
        </View>
      )}

      {selectedMarker && (
        <View style={styles.markerSheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.markerSheetHeader}>
            <View
              style={[
                styles.markerSheetIcon,
                selectedMarker.isSponsored && styles.sponsoredSheetIcon,
              ]}
            >
              <Text style={styles.markerSheetEmoji}>
                {MARKER_EMOJI[selectedMarker.category]}
              </Text>
            </View>
            <View style={styles.alertCopy}>
              <Text style={styles.markerCategory}>
                {MARKER_LABELS[selectedMarker.category]}
                {selectedMarker.isSponsored
                  ? " · ÉPINGLE SPONSORISÉE · 2 000 FCFA/SEMAINE"
                  : ""}
              </Text>
              <Text numberOfLines={2} style={styles.alertTitle}>
                {selectedMarker.title}
              </Text>
              <Text style={styles.markerStatus}>
                {selectedMarker.status === "CONFIRMING"
                  ? `En cours de confirmation · ${selectedMarker.confirmationsCount}/3`
                  : selectedMarker.status === "ACTIVE"
                    ? "Confirmé · actif"
                    : selectedMarker.status}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Fermer les détails du marqueur"
              accessibilityRole="button"
              onPress={() => setSelectedMarkerId(null)}
              style={styles.closeSheetButton}
            >
              <X color="#64748b" size={20} />
            </Pressable>
          </View>
          {selectedMarker.description ? (
            <Text style={styles.markerDescription}>
              {selectedMarker.description}
            </Text>
          ) : null}
          {selectedMarker.category === "MERCHANT_PRO" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => void openMerchantCatalog(selectedMarker)}
              style={styles.merchantCatalogButton}
            >
              <ShoppingBag color="#1d4ed8" size={17} />
              <Text style={styles.merchantCatalogText}>Voir la fiche catalogue</Text>
            </Pressable>
          )}
          {selectedMarker.status === "CONFIRMING" &&
            (selectedMarker.category === "POWER_OUTAGE" ||
              selectedMarker.category === "WATER_OUTAGE") && (
              <Pressable
                accessibilityRole="button"
                onPress={() => void confirmOutage(selectedMarker)}
                style={styles.confirmOutageButton}
              >
                <CheckCircle color="#ffffff" size={18} />
                <Text style={styles.actionButtonText}>
                  Confirmer cette coupure
                </Text>
              </Pressable>
            )}
        </View>
      )}

      <Pressable
        accessibilityLabel="Ajouter un signalement ou une alerte sur la carte"
        accessibilityRole="button"
        onPress={promptOutageReport}
        style={styles.addMarkerFab}
      >
        <Plus color="#ffffff" size={26} />
      </Pressable>
      {authStatus === "connected" ? (
        <SosButton
          location={userLocation}
          onAlert={handleSosAlert}
          openRequestId={route.params?.voiceSosRequestId}
          socket={socketRef.current}
        />
      ) : (
        <Pressable accessibilityRole="button" onPress={requestAuthentication} style={styles.guestSosButton}>
          <ShieldAlert color="#fff" size={19} />
          <Text style={styles.guestSosText}>SOS · Se connecter</Text>
        </Pressable>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => setShareModalVisible(false)}
        transparent
        visible={shareModalVisible}
      >
        <View style={styles.shareBackdrop}>
          <View style={styles.shareDialog}>
            <Text style={styles.shareTitle}>Partager ma position</Text>
            <Text style={styles.shareSubtitle}>
              Vous gardez le contrôle. Seules les personnes autorisées voient votre position.
            </Text>
            {([
              ["PRIVATE", "Mode fantôme · Moi seul"],
              ["ALLIES", "Mes alliés"],
              ["SELECTED", "Personnes choisies"],
            ] as const).map(([mode, label]) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: shareMode === mode }}
                key={mode}
                onPress={() => setShareMode(mode)}
                style={[styles.shareOption, shareMode === mode && styles.shareOptionSelected]}
              >
                <Text style={[styles.shareOptionText, shareMode === mode && styles.shareOptionTextSelected]}>
                  {label}
                </Text>
              </Pressable>
            ))}
            {shareMode === "SELECTED" ? (
              <ScrollView style={styles.allyPicker}>
                {allies.length ? allies.map((ally) => {
                  const selected = selectedAllyIds.includes(ally.id);
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      key={ally.id}
                      onPress={() => setSelectedAllyIds((current) =>
                        selected
                          ? current.filter((id) => id !== ally.id)
                          : [...current, ally.id],
                      )}
                      style={styles.allyOption}
                    >
                      <ProfileAvatar
                        name={ally.name}
                        photoUrl={ally.photoUrl}
                        size={34}
                        isAlly
                        isProVerified={ally.badge === "Commerçant Certifié"}
                      />
                      <Text style={styles.allyOptionText}>{ally.name || "Allié"}</Text>
                      <Text style={styles.allyOptionCheck}>{selected ? "✓" : "○"}</Text>
                    </Pressable>
                  );
                }) : <Text style={styles.shareSubtitle}>Vous n’avez pas encore d’alliés.</Text>}
              </ScrollView>
            ) : null}
            <Text style={styles.durationLabel}>DURÉE DU PARTAGE</Text>
            <View style={styles.durationOptions}>
              {([
                [1, "1 h"],
                [8, "8 h"],
                [24, "24 h"],
                [null, "Jusqu’à arrêt"],
              ] as const).map(([duration, label]) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: shareDuration === duration }}
                  key={label}
                  onPress={() => setShareDuration(duration)}
                  style={[styles.durationOption, shareDuration === duration && styles.shareOptionSelected]}
                >
                  <Text style={[styles.durationText, shareDuration === duration && styles.shareOptionTextSelected]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => void saveLocationSharing()}
              style={styles.confirmShareButton}
            >
              <Text style={styles.confirmShareText}>
                {shareMode === "PRIVATE" ? "Activer le mode fantôme" : "Partager ma position"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setShareModalVisible(false)}
              style={styles.cancelShareButton}
            >
              <Text style={styles.cancelShareText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setIsLayersVisible(false)}
        transparent
        visible={isLayersVisible}
      >
        <View style={styles.layersBackdrop}>
          <View style={styles.layersDialog}>
            <View style={styles.layersHeader}>
              <View>
                <Text style={styles.layersTitle}>Couches de la carte</Text>
                <Text style={styles.layersSubtitle}>
                  Choisissez les marqueurs à afficher
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Fermer les couches"
                accessibilityRole="button"
                onPress={() => setIsLayersVisible(false)}
                style={styles.closeSheetButton}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>
            <View style={styles.layerOption}>
              <View style={[styles.layerIcon, styles.sosLayerIcon]}>
                <ShieldAlert color="#dc2626" size={18} />
              </View>
              <View style={styles.layerCopy}>
                <Text style={styles.layerLabel}>Urgences SOS</Text>
                <Text style={styles.layerDescription}>
                  Prioritaires · toujours affichées
                </Text>
              </View>
              <Text style={styles.layerLocked}>ACTIF</Text>
            </View>
            {MARKER_LAYERS.map((layer) => (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: visibleLayers[layer.id] }}
                key={layer.id}
                onPress={() =>
                  setVisibleLayers((current) => ({
                    ...current,
                    [layer.id]: !current[layer.id],
                  }))
                }
                style={styles.layerOption}
              >
                <View style={styles.layerIcon}>
                  <Text style={styles.layerEmoji}>
                    {MARKER_EMOJI[layer.categories[0]]}
                  </Text>
                </View>
                <Text style={styles.layerLabel}>{layer.label}</Text>
                <View
                  style={[
                    styles.layerCheckbox,
                    visibleLayers[layer.id] && styles.layerCheckboxActive,
                  ]}
                >
                  {visibleLayers[layer.id] ? (
                    <CheckCircle color="#ffffff" size={17} />
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={dismissSosFlow}
        statusBarTranslucent
        transparent
        visible={sosPhase !== "closed"}
      >
        <View style={styles.cameraModal}>
          {sosPhase === "camera" && !captureError && cameraPermission?.granted ? (
            <>
              <CameraView
                facing="back"
                onCameraReady={() => setCameraReady(true)}
                ref={cameraRef}
                style={styles.cameraPreview}
              />
              <View style={styles.cameraTopBar}>
                <Pressable
                  accessibilityLabel="Fermer la caméra SOS"
                  accessibilityRole="button"
                  onPress={dismissSosFlow}
                  style={styles.cameraClose}
                >
                  <X color="#ffffff" size={22} />
                </Pressable>
                <View style={styles.liveCaptureTag}>
                  <View style={styles.liveCaptureDot} />
                  <Text style={styles.liveCaptureText}>CAPTURE EN DIRECT</Text>
                </View>
              </View>
              <View style={styles.cameraInstructions}>
                <Camera color="#ffffff" size={20} />
                <Text style={styles.cameraInstructionText}>
                  Prenez une photo de la situation d'urgence
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Prendre une photo d'urgence"
                accessibilityRole="button"
                disabled={!cameraReady}
                onPress={() => void captureEmergency()}
                style={[
                  styles.captureButton,
                  !cameraReady && styles.captureButtonDisabled,
                ]}
              >
                <View style={styles.captureButtonInner} />
              </Pressable>
            </>
          ) : (
            <View style={styles.previewScreen}>
              <View style={styles.previewTopBar}>
                <Pressable
                  accessibilityLabel="Fermer l'alerte"
                  accessibilityRole="button"
                  onPress={dismissSosFlow}
                  style={styles.cameraClose}
                >
                  <X color="#ffffff" size={21} />
                </Pressable>
                <Text style={styles.previewHeader}>
                  {sosPhase === "sending" ? "ENVOI DE L'ALERTE" : "APERÇU DE L'ALERTE"}
                </Text>
                <View style={styles.previewHeaderSpacer} />
              </View>
              {emergencyImageUri ? (
                <Image
                  accessibilityLabel="Photo prise en direct pour l'alerte SOS"
                  resizeMode="contain"
                  source={{ uri: emergencyImageUri }}
                  style={styles.previewImage}
                />
              ) : (
                <View style={styles.previewError}>
                  <AlertTriangle color="#fca5a5" size={28} />
                  <Text style={styles.previewErrorText}>
                    {captureError ?? "La caméra n'est pas disponible."}
                  </Text>
                  {sosPhase === "camera" && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={dismissSosFlow}
                      style={styles.retryCameraButton}
                    >
                      <Text style={styles.retryCameraText}>Fermer</Text>
                    </Pressable>
                  )}
                </View>
              )}
              {emergencyImageUri && (
                <>
                  {captureError ? (
                    <>
                      <View style={styles.captureErrorBanner}>
                        <AlertTriangle color="#fecaca" size={17} />
                        <Text style={styles.captureErrorText}>{captureError}</Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        onPress={retakeEmergencyPhoto}
                        style={styles.retakeButton}
                      >
                        <Camera color="#e2e8f0" size={16} />
                        <Text style={styles.retakeButtonText}>
                          Reprendre la photo
                        </Text>
                      </Pressable>
                    </>
                  ) : (
                    <View style={styles.recordingStatus}>
                      <View
                        style={[
                          styles.liveCaptureDot,
                          !isRecordingAudio && styles.recordingDotPending,
                        ]}
                      />
                      <Mic color="#ffffff" size={16} />
                      <Text style={styles.recordingStatusText}>
                        {isRecordingAudio
                          ? "Audio ambiant · 3 secondes"
                          : "Préparation de l'enregistrement audio…"}
                      </Text>
                    </View>
                  )}
                  <View style={styles.countdownPanel}>
                    <Text style={styles.countdownLabel}>ENVOI DANS</Text>
                    <Text style={styles.countdownNumber}>
                      {sosPhase === "sending" ? "…" : captureCountdown}
                    </Text>
                    <Text style={styles.countdownUnit}>
                      {sosPhase === "sending" ? "transmission" : "secondes"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="ANNULER L'ALERTE (Erreur)"
                    accessibilityRole="button"
                    onPress={dismissSosFlow}
                    style={styles.cancelAlertButton}
                  >
                    <X color="#ffffff" size={21} strokeWidth={3} />
                    <Text style={styles.cancelAlertButtonText}>
                      ANNULER L'ALERTE (Erreur)
                    </Text>
                  </Pressable>
                </>
              )}
              <View style={styles.legalNotice}>
                <ShieldAlert color="#fca5a5" size={17} />
                <Text style={styles.legalNoticeText}>
                  Attention : Toute fausse alerte volontaire entraîne la suspension
                  immédiate du compte et des poursuites.
                </Text>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#dbeafe",
    flex: 1,
  },
  map: {
    ...StyleSheet.absoluteFill,
  },
  mapQuickActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    position: "absolute",
    right: 14,
    top: 360,
  },
  shareLocationButton: {
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 18,
    elevation: 4,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  shareLocationText: { color: "#1e3a8a", fontSize: 11, fontWeight: "800" },
  recenterButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 21,
    elevation: 4,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  myLocationAvatar: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 3,
    elevation: 5,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  myLocationInitial: { color: "#ffffff", fontSize: 14, fontWeight: "900" },
  allyLocationAvatar: {
    alignItems: "center",
    backgroundColor: "#059669",
    borderColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 2,
    elevation: 4,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  allyLocationInitial: { color: "#ffffff", fontSize: 13, fontWeight: "900" },
  shareBackdrop: {
    backgroundColor: "rgba(15,23,42,0.48)",
    flex: 1,
    justifyContent: "flex-end",
  },
  shareDialog: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: 9,
    paddingBottom: 32,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  shareTitle: { color: "#0f172a", fontSize: 21, fontWeight: "900" },
  shareSubtitle: { color: "#64748b", fontSize: 12, lineHeight: 18 },
  shareOption: {
    backgroundColor: "#f8fafc",
    borderColor: "#e2e8f0",
    borderRadius: 11,
    borderWidth: 1,
    padding: 12,
  },
  shareOptionSelected: { backgroundColor: "#eff6ff", borderColor: "#2563eb" },
  shareOptionText: { color: "#334155", fontSize: 13, fontWeight: "700" },
  shareOptionTextSelected: { color: "#1d4ed8" },
  allyPicker: { maxHeight: 120 },
  allyOption: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingVertical: 9 },
  allyOptionText: { color: "#334155", fontSize: 13 },
  allyOptionCheck: { color: "#2563eb", fontSize: 18, fontWeight: "800" },
  durationLabel: { color: "#64748b", fontSize: 10, fontWeight: "800", marginTop: 5 },
  durationOptions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  durationOption: { backgroundColor: "#f8fafc", borderColor: "#e2e8f0", borderRadius: 9, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  durationText: { color: "#334155", fontSize: 11, fontWeight: "700" },
  confirmShareButton: { alignItems: "center", backgroundColor: "#1d4ed8", borderRadius: 11, marginTop: 6, padding: 13 },
  confirmShareText: { color: "#ffffff", fontSize: 13, fontWeight: "800" },
  cancelShareButton: { alignItems: "center", padding: 8 },
  cancelShareText: { color: "#475569", fontSize: 12, fontWeight: "700" },
  mapLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: "#e8eef5",
    justifyContent: "center",
    padding: 32,
  },
  locationError: {
    color: "#334155",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 12,
    textAlign: "center",
  },
  retryButton: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  retryText: {
    color: "#1d4ed8",
    fontSize: 14,
    fontWeight: "700",
  },
  loadingText: {
    color: "#334155",
    fontSize: 14,
    marginTop: 12,
  },
  scopeBar: {
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 17,
    elevation: 5,
    left: 14,
    paddingHorizontal: 12,
    paddingTop: 11,
    position: "absolute",
    right: 14,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 8,
    top: 54,
  },
  radarSearchBox: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
    paddingHorizontal: 10,
  },
  radarSearchInput: { color: "#0f172a", flex: 1, fontSize: 13, minHeight: 40, paddingVertical: 8 },
  scopeHeading: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  radarHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 30,
  },
  scopeOptions: {
    alignItems: "center",
    gap: 8,
  },
  scopeChip: {
    alignItems: "center",
    backgroundColor: "#eef2f7",
    borderColor: "#dbe3ed",
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 35,
    paddingHorizontal: 14,
  },
  scopeChipSelected: {
    backgroundColor: "#1d4ed8",
    borderColor: "#1d4ed8",
  },
  scopeChipText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "700",
  },
  scopeChipTextSelected: {
    color: "#ffffff",
  },
  layersButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 8,
    paddingVertical: 10,
  },
  layersButtonText: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "700",
  },
  layersCount: {
    backgroundColor: "#dbeafe",
    borderRadius: 9,
    color: "#1d4ed8",
    fontSize: 10,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  connectionBadge: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingBottom: 10,
    paddingTop: 9,
  },
  connectionDot: {
    backgroundColor: "#f59e0b",
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  connectionDotConnected: {
    backgroundColor: "#16a34a",
  },
  connectionDotOffline: {
    backgroundColor: "#dc2626",
  },
  connectionText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "600",
  },
  publicMarker: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 3,
    elevation: 4,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  publicMarkerEmoji: {
    fontSize: 19,
  },
  sponsoredMarker: {
    backgroundColor: "#fef3c7",
    borderColor: "#d97706",
    borderWidth: 3,
    height: 48,
    width: 48,
  },
  confirmingMarker: {
    borderColor: "#f59e0b",
  },
  sosMarker: {
    alignItems: "center",
    backgroundColor: "#dc2626",
    borderColor: "#ffffff",
    borderRadius: 22,
    borderWidth: 3,
    elevation: 5,
    height: 44,
    justifyContent: "center",
    shadowColor: "#7f1d1d",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.65,
    shadowRadius: 7,
    width: 44,
  },
  radarLegend: {
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 12,
    bottom: 102,
    elevation: 3,
    gap: 7,
    left: 14,
    paddingHorizontal: 11,
    paddingVertical: 10,
    position: "absolute",
  },
  alertsHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
    justifyContent: "space-between",
    minHeight: 28,
  },
  activeAlertRow: {
    borderTopColor: "#e2e8f0",
    borderTopWidth: 1,
    gap: 3,
    maxWidth: 245,
    paddingTop: 7,
  },
  activeAlertCategory: { color: "#334155", fontSize: 11, fontWeight: "700" },
  activeAlertDetails: { color: "#64748b", fontSize: 10 },
  legendRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  legendSos: {
    backgroundColor: "#dc2626",
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  legendText: {
    color: "#334155",
    fontSize: 10,
    fontWeight: "600",
  },
  markerLoadError: {
    color: "#b91c1c",
    fontSize: 10,
    lineHeight: 14,
    maxWidth: 190,
  },
  bottomSheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    bottom: 0,
    elevation: 9,
    left: 0,
    paddingBottom: 24,
    paddingHorizontal: 18,
    paddingTop: 9,
    position: "absolute",
    right: 0,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.17,
    shadowRadius: 10,
  },
  markerSheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    bottom: 0,
    elevation: 9,
    left: 0,
    paddingBottom: 24,
    paddingHorizontal: 18,
    paddingTop: 9,
    position: "absolute",
    right: 0,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.17,
    shadowRadius: 10,
  },
  markerSheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 11,
  },
  markerSheetIcon: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 24,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  sponsoredSheetIcon: {
    backgroundColor: "#fef3c7",
  },
  markerSheetEmoji: {
    fontSize: 24,
  },
  markerCategory: {
    color: "#475569",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  markerStatus: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 4,
  },
  markerDescription: {
    color: "#475569",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  merchantCatalogButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#eff6ff",
    borderRadius: 11,
    flexDirection: "row",
    gap: 7,
    marginTop: 12,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  merchantCatalogText: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "800",
  },
  confirmOutageButton: {
    alignItems: "center",
    backgroundColor: "#15803d",
    borderRadius: 12,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 46,
  },
  sheetHandle: {
    alignSelf: "center",
    backgroundColor: "#cbd5e1",
    borderRadius: 3,
    height: 4,
    marginBottom: 14,
    width: 40,
  },
  alertHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 11,
    marginBottom: 12,
  },
  alertIcon: {
    alignItems: "center",
    backgroundColor: "#fee2e2",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  alertCopy: {
    flex: 1,
  },
  alertEyebrow: {
    color: "#b91c1c",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.9,
  },
  alertTitle: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 3,
  },
  alertDistance: {
    color: "#475569",
    fontSize: 12,
    marginTop: 3,
  },
  closeSheetButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  emergencyPhoto: {
    backgroundColor: "#e2e8f0",
    borderRadius: 13,
    height: 142,
    width: "100%",
  },
  photoUnavailable: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 13,
    flexDirection: "row",
    gap: 8,
    height: 72,
    justifyContent: "center",
  },
  photoUnavailableText: {
    color: "#64748b",
    fontSize: 12,
  },
  alertActions: {
    flexDirection: "row",
    gap: 9,
    marginTop: 12,
  },
  assistButton: {
    alignItems: "center",
    backgroundColor: "#15803d",
    borderRadius: 12,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 46,
  },
  fakeReportButton: {
    alignItems: "center",
    backgroundColor: "#fff7ed",
    borderColor: "#fed7aa",
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 4,
  },
  actionButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  fakeReportText: {
    color: "#b91c1c",
    fontSize: 10,
    fontWeight: "800",
  },
  layersBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.48)",
    flex: 1,
    justifyContent: "center",
    padding: 22,
  },
  layersDialog: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    elevation: 12,
    maxWidth: 440,
    padding: 18,
    width: "100%",
  },
  layersHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  layersTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900",
  },
  layersSubtitle: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 3,
  },
  layerOption: {
    alignItems: "center",
    borderTopColor: "#e2e8f0",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 11,
    minHeight: 58,
    paddingVertical: 7,
  },
  layerIcon: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  sosLayerIcon: {
    backgroundColor: "#fee2e2",
  },
  layerEmoji: {
    fontSize: 18,
  },
  layerCopy: {
    flex: 1,
  },
  layerLabel: {
    color: "#1e293b",
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  layerDescription: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 2,
  },
  layerLocked: {
    color: "#b91c1c",
    fontSize: 9,
    fontWeight: "900",
  },
  layerCheckbox: {
    alignItems: "center",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  layerCheckboxActive: {
    backgroundColor: "#1d4ed8",
    borderColor: "#1d4ed8",
  },
  addMarkerFab: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 30,
    bottom: 24,
    elevation: 5,
    height: 58,
    justifyContent: "center",
    left: 20,
    position: "absolute",
    width: 58,
  },
  cameraModal: {
    backgroundColor: "#020617",
    flex: 1,
  },
  cameraPreview: {
    ...StyleSheet.absoluteFill,
  },
  cameraTopBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    left: 18,
    position: "absolute",
    right: 18,
    top: 56,
  },
  cameraClose: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.7)",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  liveCaptureTag: {
    alignItems: "center",
    backgroundColor: "rgba(127,29,29,0.82)",
    borderRadius: 14,
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  liveCaptureDot: {
    backgroundColor: "#ef4444",
    borderRadius: 5,
    height: 9,
    width: 9,
  },
  liveCaptureText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  cameraInstructions: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(15,23,42,0.62)",
    borderRadius: 15,
    flexDirection: "row",
    gap: 9,
    paddingHorizontal: 15,
    paddingVertical: 11,
    position: "absolute",
    top: "21%",
  },
  cameraInstructionText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  captureButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(255,255,255,0.32)",
    borderColor: "#ffffff",
    borderRadius: 38,
    borderWidth: 4,
    bottom: 58,
    height: 76,
    justifyContent: "center",
    position: "absolute",
    width: 76,
  },
  captureButtonDisabled: {
    opacity: 0.45,
  },
  captureButtonInner: {
    backgroundColor: "#ffffff",
    borderRadius: 28,
    height: 54,
    width: 54,
  },
  previewScreen: {
    backgroundColor: "#020617",
    flex: 1,
    paddingBottom: 22,
    paddingHorizontal: 18,
    paddingTop: 54,
  },
  previewTopBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 13,
  },
  previewHeader: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
  },
  previewHeaderSpacer: {
    width: 40,
  },
  previewImage: {
    backgroundColor: "#111827",
    borderRadius: 14,
    flex: 1,
    maxHeight: "43%",
    width: "100%",
  },
  previewError: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  previewErrorText: {
    color: "#fecaca",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 13,
    textAlign: "center",
  },
  retryCameraButton: {
    backgroundColor: "#334155",
    borderRadius: 12,
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  retryCameraText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  captureErrorBanner: {
    alignItems: "center",
    backgroundColor: "#7f1d1d",
    borderRadius: 12,
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    padding: 11,
  },
  captureErrorText: {
    color: "#ffffff",
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  retakeButton: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 7,
    marginTop: 9,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  retakeButtonText: {
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: "700",
  },
  recordingStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  recordingDotPending: {
    backgroundColor: "#f59e0b",
  },
  recordingStatusText: {
    color: "#e2e8f0",
    fontSize: 11,
    fontWeight: "600",
  },
  countdownPanel: {
    alignItems: "center",
    alignSelf: "center",
    marginTop: 12,
  },
  countdownLabel: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  countdownNumber: {
    color: "#ffffff",
    fontSize: 43,
    fontWeight: "900",
    lineHeight: 48,
  },
  countdownUnit: {
    color: "#cbd5e1",
    fontSize: 11,
  },
  cancelAlertButton: {
    alignItems: "center",
    backgroundColor: "#b91c1c",
    borderColor: "#fecaca",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 14,
    minHeight: 54,
  },
  cancelAlertButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  legalNotice: {
    alignItems: "center",
    backgroundColor: "rgba(127,29,29,0.28)",
    borderColor: "rgba(248,113,113,0.28)",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    marginTop: 13,
    padding: 10,
  },
  legalNoticeText: {
    color: "#fecaca",
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  guestSosButton: {
    alignItems: "center",
    backgroundColor: "#b9382f",
    borderRadius: 28,
    bottom: 28,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 18,
    position: "absolute",
    right: 16,
  },
  guestSosText: { color: "#fff", fontSize: 13, fontWeight: "800" },
});
