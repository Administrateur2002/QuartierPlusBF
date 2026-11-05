import { AudioSession, VideoTrack } from "@livekit/react-native";
import {
  Camera,
  CameraOff,
  Flag,
  Gauge,
  Headphones,
  Mic,
  MicOff,
  PictureInPicture2,
  Radio,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react-native";
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type TrackPublication,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import {
  API_BASE_URL,
  apiFetch,
  getStoredAuthToken,
  type ApiFetchResponse,
} from "../services/api";
import { enterGrinPictureInPicture } from "../services/grinPictureInPicture";

type CameraTrackReference = {
  participant: Participant;
  publication: TrackPublication;
  source: Track.Source.Camera;
};

type GrinChair = {
  identity: string;
  name: string;
  participant: Participant;
  trackRef?: CameraTrackReference;
  isLocal: boolean;
  isCameraEnabled: boolean;
  isMicrophoneEnabled: boolean;
};

type ModerationReviewEvent = {
  id: string;
  participant_id: string;
  media_type: "AUDIO" | "VIDEO";
  category: string;
  confidence: number;
  status: string;
  appeal_reason: string | null;
};

const MAX_CHAIRS = 6;
const RULES_ACCEPTED_KEY = "quartierplus.grin.rules.v1";
const REPORT_REASONS = [
  "Harcèlement",
  "Insultes",
  "Menaces",
  "Nudité explicite",
  "Contenu privé sans consentement",
  "Comportement abusif",
] as const;
const LIVEKIT_UNAVAILABLE_MESSAGE =
  "Connexion au Grin impossible.";

const formatLiveKitError = (error: unknown) => {
  if (!(error instanceof Error)) return LIVEKIT_UNAVAILABLE_MESSAGE;
  if (/\(code [A-Z0-9_-]+\)/i.test(error.message)) return error.message;
  const record = error as Error & { code?: string | number };
  const code =
    typeof record.code === "string" || typeof record.code === "number"
      ? String(record.code)
      : "LIVEKIT_CONNECTION_FAILED";
  return `${error.message} (code ${code}).`;
};

const readServerReason = async (response: ApiFetchResponse) => {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object") {
      const data = payload as Record<string, unknown>;
      if (typeof data.reason === "string") return data.reason;
      if (typeof data.error === "string") {
        const code = typeof data.code === "string" ? data.code : `HTTP_${response.status}`;
        return `${data.error} (code ${code}).`;
      }
    }
  } catch {
    return `Réponse LiveKit illisible (code HTTP_${response.status}).`;
  }
  return `Le serveur LiveKit a répondu HTTP ${response.status} (code HTTP_${response.status}).`;
};

const readChairs = (room: Room): GrinChair[] => {
  const participants = [
    room.localParticipant,
    ...room.remoteParticipants.values(),
  ];
  return participants.slice(0, MAX_CHAIRS).map((participant, index) => {
    const publication = participant.getTrackPublication(Track.Source.Camera);
    return {
      identity: participant.identity,
      name:
        participant.name ||
        (participant === room.localParticipant ? "Vous" : `Voisin ${index}`),
      participant,
      trackRef: publication
        ? {
            participant,
            publication,
            source: Track.Source.Camera,
          }
        : undefined,
      isLocal: participant === room.localParticipant,
      isCameraEnabled: participant.isCameraEnabled,
      isMicrophoneEnabled: participant.isMicrophoneEnabled,
    };
  });
};

const isModerationReviewEvent = (
  value: unknown,
): value is ModerationReviewEvent =>
  Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "participant_id" in value &&
      typeof value.participant_id === "string" &&
      "media_type" in value &&
      (value.media_type === "AUDIO" || value.media_type === "VIDEO") &&
      "category" in value &&
      typeof value.category === "string" &&
      "confidence" in value &&
      typeof value.confidence === "number" &&
      "status" in value &&
      typeof value.status === "string" &&
      "appeal_reason" in value &&
      (typeof value.appeal_reason === "string" ||
        value.appeal_reason === null),
  );

const requestAndroidAvPermissions = async () => {
  if (Platform.OS !== "android") return;
  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  ]);
  if (
    result[PermissionsAndroid.PERMISSIONS.CAMERA] !==
      PermissionsAndroid.RESULTS.GRANTED ||
    result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] !==
      PermissionsAndroid.RESULTS.GRANTED
  ) {
    throw new Error("Autorisez la caméra et le microphone pour prendre une chaise.");
  }
};

export default function GrinScreen() {
  const { isOffline } = useAuth();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const roomRef = useRef<Room | null>(null);
  const connectionRef = useRef<Promise<Room> | null>(null);
  const mountedRef = useRef(false);
  const pipVideoRef = useRef<ComponentRef<typeof VideoTrack> | null>(null);
  const lowDataModeRef = useRef(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isOnChair, setIsOnChair] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(false);
  const [chairs, setChairs] = useState<GrinChair[]>([]);
  const [pipIdentity, setPipIdentity] = useState<string | null>(null);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [automatedModerationAvailable, setAutomatedModerationAvailable] =
    useState<boolean | null>(null);
  const [moderationConsent, setModerationConsent] = useState<boolean | null>(null);
  const [lowDataMode, setLowDataMode] = useState(false);
  const [reportTarget, setReportTarget] = useState<GrinChair | null>(null);
  const [isReportPickerOpen, setIsReportPickerOpen] = useState(false);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [moderationNotice, setModerationNotice] = useState<{
    eventId: string;
    status: string;
    message: string;
  } | null>(null);
  const [isAppealing, setIsAppealing] = useState(false);
  const [moderationQueue, setModerationQueue] = useState<
    ModerationReviewEvent[] | null
  >(null);
  const [isReviewQueueOpen, setIsReviewQueueOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  lowDataModeRef.current = lowDataMode;

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(RULES_ACCEPTED_KEY)
      .then((value) => {
        if (active) setRulesAccepted(value === "accepted");
      })
      .catch((storageError: unknown) => {
        if (active) {
          setError(
            storageError instanceof Error
              ? storageError.message
              : "Impossible de vérifier l’acceptation des règles.",
          );
        }
      })
      .finally(() => {
        if (active) setRulesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadModerationConfig = async () => {
      if (!API_BASE_URL) {
        setAutomatedModerationAvailable(false);
        return;
      }
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/livekit/moderation/config`,
          { method: "GET", headers: { "Cache-Control": "no-cache" } },
        );
        if (!response.ok) {
          throw new Error(
            `La configuration de modération a répondu HTTP ${response.status}.`,
          );
        }
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("automatedModerationAvailable" in payload) ||
          typeof payload.automatedModerationAvailable !== "boolean"
        ) {
          throw new Error("La configuration de modération est invalide.");
        }
        if (active) {
          setAutomatedModerationAvailable(
            payload.automatedModerationAvailable,
          );
        }
      } catch (configError) {
        console.warn(
          "Unable to load automated moderation config; using manual reports:",
          configError,
        );
        if (active) setAutomatedModerationAvailable(false);
      }
    };
    void loadModerationConfig();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (automatedModerationAvailable === false) {
      setModerationConsent(false);
    }
  }, [automatedModerationAvailable]);

  useEffect(() => {
    if (!API_BASE_URL) return;
    let active = true;
    const loadQueue = async () => {
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/livekit/moderation/review-queue`,
          { method: "GET", headers: { "Cache-Control": "no-cache" } },
        );
        if (response.status === 403) {
          if (active) setModerationQueue(null);
          return;
        }
        if (!response.ok) {
          throw new Error(`La file de modération a répondu HTTP ${response.status}.`);
        }
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("events" in payload) ||
          !Array.isArray(payload.events)
        ) {
          throw new Error("La réponse de la file de modération est invalide.");
        }
        if (!payload.events.every(isModerationReviewEvent)) {
          throw new Error("Un élément de la file de modération est invalide.");
        }
        if (active) setModerationQueue(payload.events);
      } catch (queueError) {
        if (active) {
          console.error("Unable to load Grin moderation review queue:", queueError);
        }
      }
    };
    void loadQueue();
    const interval = setInterval(() => void loadQueue(), 20_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const applyLowDataMode = useCallback((room: Room, enabled: boolean) => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === Track.Source.Camera) {
          publication.setSubscribed(!enabled);
        }
      }
    }
  }, []);

  const connect = useCallback(async (): Promise<Room> => {
    if (roomRef.current?.state === "connected") return roomRef.current;
    if (connectionRef.current) return connectionRef.current;
    if (!rulesAccepted || moderationConsent === null) {
      throw new Error("Acceptez les règles du quartier avant de rejoindre le live.");
    }
    if (!API_BASE_URL) {
      throw new Error("EXPO_PUBLIC_API_URL manquant (code API_URL_MISSING).");
    }
    if (isOffline) {
      throw new Error("Le Grin nécessite une connexion Internet (code LIVEKIT_NETWORK_OFFLINE).");
    }

    const pending = (async () => {
      setIsConnecting(true);
      setError(null);
      try {
        const token = await getStoredAuthToken();
        if (!token) throw new Error("Connectez-vous pour rejoindre le Grin.");
        const response = await apiFetch(`${API_BASE_URL}/v1/livekit/token`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            roomName: "grin",
            moderationConsent,
          }),
        });
        if (!response.ok) {
          throw new Error(await readServerReason(response));
        }
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("token" in payload) ||
          typeof payload.token !== "string" ||
          !("url" in payload) ||
          typeof payload.url !== "string"
        ) {
          throw new Error("Réponse du serveur LiveKit invalide (code LIVEKIT_RESPONSE_INVALID).");
        }

        await AudioSession.startAudioSession();
        const room = new Room({ adaptiveStream: true, dynacast: true });
        const refreshChairs = () => {
          if (!mountedRef.current) return;
          const nextChairs = readChairs(room);
          setChairs(nextChairs);
          setIsCameraEnabled(room.localParticipant.isCameraEnabled);
          setIsMicrophoneEnabled(room.localParticipant.isMicrophoneEnabled);
        };
        for (const event of [
          RoomEvent.ParticipantConnected,
          RoomEvent.ParticipantDisconnected,
          RoomEvent.TrackPublished,
          RoomEvent.TrackUnpublished,
          RoomEvent.TrackSubscribed,
          RoomEvent.TrackUnsubscribed,
          RoomEvent.TrackMuted,
          RoomEvent.TrackUnmuted,
          RoomEvent.LocalTrackPublished,
          RoomEvent.LocalTrackUnpublished,
        ]) {
          room.on(event, () => {
            applyLowDataMode(room, lowDataModeRef.current);
            refreshChairs();
          });
        }
        room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (topic !== "grin-moderation") return;
          try {
            const notice: unknown = JSON.parse(String.fromCharCode(...payload));
            if (
              notice &&
              typeof notice === "object" &&
              "eventId" in notice &&
              typeof notice.eventId === "string" &&
              "status" in notice &&
              typeof notice.status === "string" &&
              "message" in notice &&
              typeof notice.message === "string"
            ) {
              setModerationNotice({
                eventId: notice.eventId,
                status: notice.status,
                message: notice.message,
              });
            }
          } catch (noticeError) {
            console.error("Unable to read Grin moderation notice:", noticeError);
          }
        });
        room.on(RoomEvent.Disconnected, () => {
          roomRef.current = null;
          if (!mountedRef.current) return;
          setIsConnected(false);
          setIsOnChair(false);
          setIsCameraEnabled(false);
          setIsMicrophoneEnabled(false);
          setChairs([]);
        });
        await room.connect(payload.url, payload.token);
        if (!mountedRef.current) {
          await room.disconnect();
          await AudioSession.stopAudioSession();
          throw new Error("La connexion au Grin a été interrompue.");
        }
        roomRef.current = room;
        setIsConnected(true);
        refreshChairs();
        return room;
      } catch (connectError) {
        await AudioSession.stopAudioSession().catch((audioError: unknown) => {
          console.error("Unable to stop failed Grin audio session:", audioError);
        });
        throw connectError;
      } finally {
        setIsConnecting(false);
      }
    })();

    connectionRef.current = pending;
    try {
      return await pending;
    } finally {
      connectionRef.current = null;
    }
  }, [applyLowDataMode, isOffline, moderationConsent, rulesAccepted]);

  useEffect(() => {
    mountedRef.current = true;
    if (!rulesLoaded || !rulesAccepted || moderationConsent === null) {
      return () => {
        mountedRef.current = false;
      };
    }
    if (isOffline) {
      setError("Connectez-vous à Internet pour rejoindre le Grin en direct.");
      return () => {
        mountedRef.current = false;
      };
    }
    void connect().catch((connectError: unknown) => {
      if (!mountedRef.current) return;
      setError(formatLiveKitError(connectError));
    });
    return () => {
      mountedRef.current = false;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) void room.disconnect();
      void AudioSession.stopAudioSession().catch((audioError: unknown) => {
        console.error("Unable to stop Grin audio session:", audioError);
      });
    };
  }, [connect, isOffline, moderationConsent, rulesAccepted, rulesLoaded]);

  useEffect(() => {
    if (roomRef.current) applyLowDataMode(roomRef.current, lowDataMode);
  }, [applyLowDataMode, lowDataMode]);

  const acceptRules = async () => {
    try {
      await SecureStore.setItemAsync(RULES_ACCEPTED_KEY, "accepted");
      setRulesAccepted(true);
      setError(null);
    } catch (storageError) {
      setError(
        storageError instanceof Error
          ? storageError.message
          : "Impossible d’enregistrer votre acceptation des règles.",
      );
    }
  };

  const submitReport = async (reason: (typeof REPORT_REASONS)[number]) => {
    if (!reportTarget || !API_BASE_URL || isSubmittingReport) return;
    setIsSubmittingReport(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "live_participant",
          target_id: reportTarget.identity,
          reason,
        }),
      });
      if (!response.ok) {
        throw new Error(`Le signalement a échoué (HTTP ${response.status}).`);
      }
      setReportTarget(null);
      Alert.alert(
        "Signalement transmis",
        "Les modérateurs pourront examiner ce signalement. Un signalement ne supprime pas automatiquement le contenu.",
      );
    } catch (reportError) {
      Alert.alert(
        "Signalement impossible",
        reportError instanceof Error
          ? reportError.message
          : "Une erreur est survenue pendant le signalement.",
      );
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const appealModerationEvent = async () => {
    if (!moderationNotice || isAppealing || !API_BASE_URL) return;
    setIsAppealing(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/livekit/moderation/events/${moderationNotice.eventId}/appeal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "Je conteste cette détection et demande une vérification humaine.",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Le recours a échoué (HTTP ${response.status}).`);
      }
      setModerationNotice({
        ...moderationNotice,
        status: "APPEALED",
        message: "Votre recours est transmis à un modérateur humain.",
      });
    } catch (appealError) {
      Alert.alert(
        "Recours impossible",
        appealError instanceof Error
          ? appealError.message
          : "Une erreur est survenue pendant le recours.",
      );
    } finally {
      setIsAppealing(false);
    }
  };

  const resolveModerationEvent = async (
    eventId: string,
    outcome: "clear" | "confirm",
  ) => {
    if (!API_BASE_URL) return;
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/livekit/moderation/events/${eventId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome }),
        },
      );
      if (!response.ok) {
        throw new Error(`La décision a échoué (HTTP ${response.status}).`);
      }
      setModerationQueue((events) =>
        events ? events.filter((event) => event.id !== eventId) : events,
      );
    } catch (reviewError) {
      Alert.alert(
        "Décision impossible",
        reviewError instanceof Error
          ? reviewError.message
          : "Une erreur est survenue pendant la revue.",
      );
    }
  };

  const joinChair = async () => {
    if (automatedModerationAvailable && moderationConsent !== true) {
      setModerationConsent(null);
      return;
    }
    try {
      const room = await connect();
      if (
        !room.localParticipant.isCameraEnabled &&
        readChairs(room).length >= MAX_CHAIRS
      ) {
        throw new Error("Les six chaises du Grin sont déjà occupées.");
      }
      await requestAndroidAvPermissions();
      await room.localParticipant.setCameraEnabled(true);
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (microphoneError) {
        await room.localParticipant.setCameraEnabled(false);
        throw microphoneError;
      }
      setIsOnChair(true);
      setIsCameraEnabled(true);
      setIsMicrophoneEnabled(true);
      setError(null);
    } catch (joinError) {
      setError(formatLiveKitError(joinError));
    }
  };

  const revokeModerationConsent = async () => {
    await leaveChair();
    setModerationConsent(false);
  };

  const leaveChair = async () => {
    const participant = roomRef.current?.localParticipant;
    if (!participant) return;
    try {
      await participant.setMicrophoneEnabled(false);
      await participant.setCameraEnabled(false);
      setIsOnChair(false);
      setIsMicrophoneEnabled(false);
      setIsCameraEnabled(false);
    } catch (leaveError) {
      setError(
        leaveError instanceof Error
          ? leaveError.message
          : "Impossible de quitter la chaise.",
      );
    }
  };

  const toggleCamera = async () => {
    const participant = roomRef.current?.localParticipant;
    if (!participant || !isOnChair) return;
    try {
      await participant.setCameraEnabled(!isCameraEnabled);
      setIsCameraEnabled(!isCameraEnabled);
    } catch (cameraError) {
      setError(
        cameraError instanceof Error
          ? cameraError.message
          : "Impossible de modifier la caméra.",
      );
    }
  };

  const toggleMicrophone = async () => {
    const participant = roomRef.current?.localParticipant;
    if (!participant || !isOnChair) return;
    try {
      await participant.setMicrophoneEnabled(!isMicrophoneEnabled);
      setIsMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (microphoneError) {
      setError(
        microphoneError instanceof Error
          ? microphoneError.message
          : "Impossible de modifier le microphone.",
      );
    }
  };

  const retryConnection = () => {
    void connect().catch((connectError: unknown) =>
      setError(formatLiveKitError(connectError)),
    );
  };

  const togglePictureInPicture = () => {
    try {
      const entered = enterGrinPictureInPicture(pipVideoRef);
      if (!entered) {
        Alert.alert(
          "PiP indisponible",
          Platform.OS === "android"
            ? "Le mode PiP nécessite Android 8 ou une version ultérieure."
            : "Le mode PiP n'est pas pris en charge sur cet appareil.",
        );
      }
    } catch (pipError) {
      Alert.alert(
        "PiP indisponible",
        pipError instanceof Error
          ? pipError.message
          : "Impossible d'ouvrir le Grin en mode miniature.",
      );
    }
  };

  const selectedPipIdentity =
    pipIdentity && chairs.some((chair) => chair.identity === pipIdentity)
      ? pipIdentity
      : chairs.find((chair) => chair.trackRef)?.identity ?? null;
  const isCompact = width < 360;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={styles.logo}>
          <Users color={colors.primary} size={23} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>Grin du quartier</Text>
          <Text style={[styles.subtitle, { color: colors.secondaryText }]}>Rencontre vidéo en direct</Text>
        </View>
        <View style={[styles.connectionBadge, isConnected && styles.connectedBadge]}>
          {isConnected ? (
            <Wifi color="#15803d" size={16} />
          ) : (
            <WifiOff color={colors.secondaryText} size={16} />
          )}
        </View>
      </View>

      {!isCompact && (
        <View style={[styles.roomCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Radio color={colors.primary} size={18} />
          <View style={styles.roomCopy}>
            <Text style={[styles.roomTitle, { color: colors.text }]}>Salon du quartier</Text>
            <Text style={[styles.roomSubtitle, { color: colors.secondaryText }]}>
              {isConnecting
                ? "Connexion au salon..."
                : `${chairs.length}/${MAX_CHAIRS} chaises occupées`}
            </Text>
          </View>
          {isConnecting ? (
            <ActivityIndicator color="#7c3aed" />
          ) : (
            <View style={styles.seatCount}>
              <Users color={colors.primary} size={15} />
              <Text style={styles.seatCountText}>
                {chairs.length}/{MAX_CHAIRS}
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={[styles.safetyBanner, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ShieldCheck color={colors.primary} size={19} />
        <Text style={[styles.safetyText, { color: colors.secondaryText }]}>
          {automatedModerationAvailable === false
            ? "La modération automatique AWS est désactivée. Signalez les comportements problématiques aux modérateurs."
            : "Caméra et micro restent coupés jusqu’à votre prise de parole."}
        </Text>
      </View>
      {moderationNotice && (
        <View style={[styles.moderationNotice, { backgroundColor: colors.card, borderColor: colors.danger }]}>
          <Text style={[styles.moderationNoticeText, { color: colors.text }]}>
            {moderationNotice.message}
          </Text>
          {moderationNotice.status !== "APPEALED" && (
            <Pressable
              accessibilityRole="button"
              disabled={isAppealing}
              onPress={() => void appealModerationEvent()}
              style={[styles.appealButton, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.acceptRulesText}>
                {isAppealing ? "Envoi du recours..." : "Contester et demander une revue"}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      <ScrollView
        contentContainerStyle={[
          styles.content,
          isCompact && styles.compactContent,
        ]}
      >
        <View style={styles.grid}>
          {chairs.map((chair) => {
            const isPipTarget = chair.identity === selectedPipIdentity;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${chair.name}${isPipTarget ? ", sélectionné pour PiP" : ""}`}
                key={chair.identity}
                onPress={() => setPipIdentity(chair.identity)}
                style={[
                  styles.chair,
                  isCompact && styles.compactChair,
                  isPipTarget && styles.selectedChair,
                ]}
              >
                {chair.trackRef ? (
                  <VideoTrack
                    ref={isPipTarget ? pipVideoRef : undefined}
                    iosPIP={{
                      enabled: Platform.OS === "ios",
                      startAutomatically: true,
                      preferredSize: { width: 16, height: 9 },
                    }}
                    mirror={chair.isLocal}
                    objectFit="cover"
                    style={StyleSheet.absoluteFill}
                    trackRef={chair.trackRef}
                  />
                ) : (
                  <View style={styles.cameraPlaceholder}>
                    {chair.isCameraEnabled ? (
                      <ActivityIndicator color="#c4b5fd" />
                    ) : (
                      <CameraOff color="#c4b5fd" size={30} />
                    )}
                  </View>
                )}
                <View style={styles.chairOverlay}>
                  <Text numberOfLines={1} style={styles.chairName}>
                    {chair.name}
                  </Text>
                  <View style={styles.chairStatus}>
                    {chair.isMicrophoneEnabled ? (
                      <Mic color="#ffffff" size={14} />
                    ) : (
                      <MicOff color="#fecaca" size={14} />
                    )}
                  </View>
                </View>
              </Pressable>
            );
          })}
          {chairs.length === 0 && (
            <View style={styles.emptyState}>
              <Headphones color="#94a3b8" size={34} />
              <Text style={styles.emptyTitle}>Le Grin est prêt</Text>
              <Text style={styles.emptyText}>
                Prenez une chaise pour rejoindre la conversation vidéo.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.controls}>
          {isOnChair ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isCameraEnabled ? "Désactiver la caméra" : "Activer la caméra"}
                onPress={() => void toggleCamera()}
                style={[
                  styles.controlButton,
                  { backgroundColor: colors.card },
                  isCameraEnabled && styles.controlActive,
                  isCameraEnabled && { backgroundColor: colors.primary },
                ]}
              >
                {isCameraEnabled ? (
                  <Camera color="#ffffff" size={21} />
                ) : (
                  <CameraOff color={colors.secondaryText} size={21} />
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isMicrophoneEnabled ? "Couper le microphone" : "Activer le microphone"}
                onPress={() => void toggleMicrophone()}
                style={[
                  styles.controlButton,
                  { backgroundColor: colors.card },
                  isMicrophoneEnabled && styles.controlActive,
                  isMicrophoneEnabled && { backgroundColor: colors.primary },
                ]}
              >
                {isMicrophoneEnabled ? (
                  <Mic color="#ffffff" size={21} />
                ) : (
                  <MicOff color={colors.secondaryText} size={21} />
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void leaveChair()}
                style={[styles.joinButton, styles.leaveButton, { backgroundColor: colors.danger }]}
              >
                <Text style={styles.joinButtonText}>Quitter le Grin</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={!isConnected || chairs.length >= MAX_CHAIRS}
              onPress={() => void joinChair()}
              style={[
                styles.joinButton,
                { backgroundColor: colors.primary },
                (!isConnected || chairs.length >= MAX_CHAIRS) &&
                  styles.disabledButton,
              ]}
            >
              <Camera color="#ffffff" size={18} />
              <Text style={styles.joinButtonText}>
                {automatedModerationAvailable &&
                moderationConsent !== true
                  ? "Accepter l’analyse pour prendre une chaise"
                  : chairs.length >= MAX_CHAIRS
                  ? "Toutes les chaises sont prises"
                  : "Prendre une chaise"}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Réduire le Grin en mode PiP"
            disabled={!isConnected || selectedPipIdentity === null}
            onPress={togglePictureInPicture}
            style={[
              styles.pipButton,
              (!isConnected || selectedPipIdentity === null) && styles.disabledPip,
            ]}
          >
            <PictureInPicture2 color={colors.secondaryText} size={21} />
          </Pressable>
        </View>

        <View style={styles.secondaryControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lowDataMode ? "Désactiver le mode faible connexion" : "Activer le mode faible connexion"}
            onPress={() => setLowDataMode((enabled) => !enabled)}
            style={[styles.secondaryButton, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Gauge color={lowDataMode ? colors.primary : colors.secondaryText} size={18} />
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
              {lowDataMode ? "Mode éco activé" : "Mode faible connexion"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setIsReportPickerOpen(true)}
            style={[styles.secondaryButton, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Flag color={colors.danger} size={18} />
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Signaler</Text>
          </Pressable>
          {moderationQueue !== null && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsReviewQueueOpen(true)}
              style={[styles.secondaryButton, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <ShieldCheck color={colors.primary} size={18} />
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
                Revue ({moderationQueue.length})
              </Text>
            </Pressable>
          )}
        </View>
        {moderationConsent === true && (
          <Pressable
            accessibilityRole="button"
            onPress={() => void revokeModerationConsent()}
            style={styles.revokeConsentButton}
          >
            <Text style={[styles.cancelReportText, { color: colors.secondaryText }]}>
              Révoquer le consentement et quitter ma chaise
            </Text>
          </Pressable>
        )}
      </ScrollView>

      {error && (
        <View style={[styles.errorCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text accessibilityRole="alert" style={[styles.errorText, { color: colors.danger }]}>
            {error}
          </Text>
          {!isOffline && !isConnected && (
            <Pressable accessibilityRole="button" onPress={retryConnection}>
              <Text style={styles.retryText}>Réessayer</Text>
            </Pressable>
          )}
        </View>
      )}

      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (moderationConsent === null) setModerationConsent(false);
        }}
        transparent
        visible={
          rulesLoaded &&
          rulesAccepted &&
          automatedModerationAvailable === true &&
          moderationConsent === null
        }
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <ShieldCheck color={colors.primary} size={30} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>Consentement à la modération du live</Text>
            <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
              Si vous acceptez, l’agent QuartierPlus analyse des échantillons de votre vidéo avec AWS Rekognition et transcrit temporairement votre audio en français avec AWS Transcribe pendant ce salon. Les médias et transcriptions ne sont pas enregistrés par QuartierPlus ni conservés par l’agent; AWS les traite selon les paramètres et politiques de votre compte AWS. Les correspondances incertaines sont transmises à une revue humaine; un contenu n’est jamais supprimé automatiquement.
            </Text>
            <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
              Sans consentement, vous pouvez regarder et écouter, mais votre caméra et votre micro ne pourront pas publier. Vous pouvez quitter votre chaise et révoquer votre consentement à tout moment.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setModerationConsent(true)}
              style={[styles.acceptRulesButton, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.acceptRulesText}>J’accepte l’analyse AWS pour ce salon</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setModerationConsent(false)}
              style={styles.cancelConsentButton}
            >
              <Text style={[styles.cancelReportText, { color: colors.secondaryText }]}>
                Continuer comme spectateur
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (!rulesAccepted) return;
        }}
        transparent
        visible={rulesLoaded && !rulesAccepted}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <ShieldCheck color={colors.primary} size={30} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>Les règles d’or du quartier</Text>
            <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
              Avant votre premier live, confirmez que vous respecterez chaque participant.
            </Text>
            {[
              "Respect mutuel : aucune injure, menace, intimidation ou forme de harcèlement.",
              "Aucune nudité ou image sexuelle explicite.",
              "Ne diffusez jamais de contenu privé sans le consentement des personnes concernées.",
              "Signalez les abus; les cas incertains doivent être examinés par une personne.",
            ].map((rule) => (
              <Text key={rule} style={[styles.ruleText, { color: colors.text }]}>• {rule}</Text>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => void acceptRules()}
              style={[styles.acceptRulesButton, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.acceptRulesText}>J’accepte et rejoindre le Grin</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setIsReviewQueueOpen(false)}
        transparent
        visible={isReviewQueueOpen}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <ShieldCheck color={colors.primary} size={26} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>Revue humaine</Text>
            <ScrollView style={styles.reviewList}>
              {moderationQueue?.length ? moderationQueue.map((event) => (
                <View key={event.id} style={[styles.reviewItem, { borderColor: colors.border }]}>
                  <Text style={[styles.reportReasonText, { color: colors.text }]}>
                    {event.media_type} · {event.category} · {event.confidence.toFixed(1)}%
                  </Text>
                  <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
                    Participant : {event.participant_id}
                    {event.status === "APPEALED" ? " · Recours reçu" : ""}
                  </Text>
                  {event.appeal_reason && (
                    <Text style={[styles.modalIntro, { color: colors.text }]}>
                      Recours : {event.appeal_reason}
                    </Text>
                  )}
                  <View style={styles.reviewActions}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void resolveModerationEvent(event.id, "clear")}
                      style={[styles.reviewAction, { backgroundColor: colors.primary }]}
                    >
                      <Text style={styles.acceptRulesText}>Faux positif</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void resolveModerationEvent(event.id, "confirm")}
                      style={[styles.reviewAction, { backgroundColor: colors.danger }]}
                    >
                      <Text style={styles.acceptRulesText}>Confirmer</Text>
                    </Pressable>
                  </View>
                </View>
              )) : (
                <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
                  Aucun signalement en attente.
                </Text>
              )}
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={() => setIsReviewQueueOpen(false)}>
              <Text style={[styles.cancelReportText, { color: colors.secondaryText }]}>Fermer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setIsReportPickerOpen(false)}
        transparent
        visible={isReportPickerOpen}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Flag color={colors.danger} size={26} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>Signaler un participant</Text>
            <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
              Choisissez la personne concernée. Votre signalement sera examiné par les modérateurs.
            </Text>
            {chairs.filter((chair) => !chair.isLocal).length === 0 ? (
              <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
                Aucun autre participant n’est présent dans le salon pour le moment.
              </Text>
            ) : chairs.filter((chair) => !chair.isLocal).map((chair) => (
              <Pressable
                accessibilityRole="button"
                key={chair.identity}
                onPress={() => {
                  setIsReportPickerOpen(false);
                  setReportTarget(chair);
                }}
                style={[styles.reportReasonButton, { borderColor: colors.border }]}
              >
                <Text style={[styles.reportReasonText, { color: colors.text }]}>{chair.name}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setIsReportPickerOpen(false)}>
              <Text style={[styles.cancelReportText, { color: colors.secondaryText }]}>Fermer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setReportTarget(null)}
        transparent
        visible={reportTarget !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Flag color={colors.danger} size={26} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              Signaler {reportTarget?.name ?? "un participant"}
            </Text>
            <Text style={[styles.modalIntro, { color: colors.secondaryText }]}>
              Le signalement est transmis aux modérateurs pour vérification.
            </Text>
            {REPORT_REASONS.map((reason) => (
              <Pressable
                accessibilityRole="button"
                disabled={isSubmittingReport}
                key={reason}
                onPress={() => void submitReport(reason)}
                style={[styles.reportReasonButton, { borderColor: colors.border }]}
              >
                <Text style={[styles.reportReasonText, { color: colors.text }]}>{reason}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setReportTarget(null)}>
              <Text style={[styles.cancelReportText, { color: colors.secondaryText }]}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#f8fafc", flex: 1, paddingHorizontal: 18, paddingTop: 56 },
  header: { alignItems: "center", flexDirection: "row", gap: 11 },
  logo: { alignItems: "center", backgroundColor: "#ede9fe", borderRadius: 15, height: 48, justifyContent: "center", width: 48 },
  headerText: { flex: 1 },
  title: { color: "#0f172a", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#64748b", fontSize: 13, marginTop: 3 },
  connectionBadge: { alignItems: "center", backgroundColor: "#e2e8f0", borderRadius: 17, height: 34, justifyContent: "center", width: 34 },
  connectedBadge: { backgroundColor: "#dcfce7" },
  roomCard: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#e2e8f0", borderRadius: 14, borderWidth: 1, flexDirection: "row", gap: 12, marginTop: 22, padding: 14 },
  roomCopy: { flex: 1 },
  roomTitle: { color: "#1e293b", fontSize: 14, fontWeight: "700" },
  roomSubtitle: { color: "#64748b", fontSize: 12, marginTop: 4 },
  seatCount: { alignItems: "center", backgroundColor: "#f3e8ff", borderRadius: 14, flexDirection: "row", gap: 5, paddingHorizontal: 9, paddingVertical: 6 },
  seatCountText: { color: "#6d28d9", fontSize: 12, fontWeight: "700" },
  safetyBanner: { alignItems: "center", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 9, marginTop: 12, paddingHorizontal: 12, paddingVertical: 10 },
  safetyText: { flex: 1, fontSize: 12, lineHeight: 17 },
  moderationNotice: { borderRadius: 12, borderWidth: 1, gap: 10, marginTop: 10, padding: 12 },
  moderationNoticeText: { fontSize: 13, lineHeight: 18 },
  appealButton: { alignItems: "center", borderRadius: 12, padding: 11 },
  content: { flexGrow: 1, paddingBottom: 112, paddingTop: 18 },
  compactContent: { paddingTop: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center" },
  chair: { backgroundColor: "#1e1b4b", borderColor: "#e2e8f0", borderRadius: 14, borderWidth: 2, height: 166, overflow: "hidden", width: "48%" },
  compactChair: { height: 125 },
  selectedChair: { borderColor: "#8b5cf6" },
  cameraPlaceholder: { alignItems: "center", backgroundColor: "#312e81", flex: 1, justifyContent: "center" },
  chairOverlay: { alignItems: "center", backgroundColor: "rgba(15, 23, 42, 0.70)", bottom: 0, flexDirection: "row", justifyContent: "space-between", left: 0, paddingHorizontal: 10, paddingVertical: 8, position: "absolute", right: 0 },
  chairName: { color: "#ffffff", flex: 1, fontSize: 12, fontWeight: "700", marginRight: 8 },
  chairStatus: { alignItems: "center", backgroundColor: "rgba(15,23,42,0.6)", borderRadius: 12, height: 24, justifyContent: "center", width: 24 },
  emptyState: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#e2e8f0", borderRadius: 16, borderWidth: 1, minHeight: 210, justifyContent: "center", padding: 24, width: "100%" },
  emptyTitle: { color: "#334155", fontSize: 16, fontWeight: "700", marginTop: 13 },
  emptyText: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: "center" },
  controls: { alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 20 },
  controlButton: { alignItems: "center", backgroundColor: "#e2e8f0", borderRadius: 25, height: 50, justifyContent: "center", width: 50 },
  controlActive: { backgroundColor: "#7c3aed" },
  joinButton: { alignItems: "center", backgroundColor: "#7c3aed", borderRadius: 25, flex: 1, flexDirection: "row", gap: 8, height: 50, justifyContent: "center", paddingHorizontal: 16 },
  leaveButton: { backgroundColor: "#dc2626" },
  disabledButton: { backgroundColor: "#94a3b8" },
  joinButtonText: { color: "#ffffff", fontSize: 13, fontWeight: "800" },
  pipButton: { alignItems: "center", backgroundColor: "#e2e8f0", borderRadius: 25, height: 50, justifyContent: "center", width: 50 },
  disabledPip: { opacity: 0.45 },
  secondaryControls: { flexDirection: "row", gap: 10, marginTop: 12 },
  secondaryButton: { alignItems: "center", borderRadius: 13, borderWidth: 1, flex: 1, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  secondaryButtonText: { fontSize: 12, fontWeight: "700" },
  disabledSecondaryButton: { opacity: 0.5 },
  errorCard: { backgroundColor: "#fef2f2", borderRadius: 12, marginBottom: 16, padding: 13 },
  errorText: { color: "#b91c1c", fontSize: 12, lineHeight: 18 },
  retryText: { color: "#1d4ed8", fontSize: 13, fontWeight: "700", marginTop: 8 },
  modalBackdrop: { backgroundColor: "rgba(15, 23, 42, 0.62)", flex: 1, justifyContent: "center", padding: 20 },
  modalCard: { borderRadius: 22, gap: 12, maxHeight: "90%", padding: 22 },
  modalTitle: { fontSize: 20, fontWeight: "800" },
  modalIntro: { fontSize: 13, lineHeight: 19 },
  ruleText: { fontSize: 14, lineHeight: 20 },
  acceptRulesButton: { alignItems: "center", borderRadius: 14, marginTop: 8, padding: 15 },
  acceptRulesText: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
  reportReasonButton: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  reportReasonText: { fontSize: 13, fontWeight: "600" },
  reviewList: { maxHeight: 420 },
  reviewItem: { borderRadius: 12, borderWidth: 1, gap: 8, marginBottom: 10, padding: 12 },
  reviewActions: { flexDirection: "row", gap: 8 },
  reviewAction: { alignItems: "center", borderRadius: 10, flex: 1, padding: 10 },
  cancelReportText: { fontSize: 14, fontWeight: "700", paddingTop: 4, textAlign: "center" },
  cancelConsentButton: { alignItems: "center", paddingVertical: 8 },
  revokeConsentButton: { alignItems: "center", paddingVertical: 10 },
});
