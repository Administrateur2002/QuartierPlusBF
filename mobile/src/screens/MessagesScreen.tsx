import { AudioSession } from "@livekit/react-native";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { File } from "expo-file-system";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { VideoView, useVideoPlayer } from "expo-video";
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  HeartHandshake,
  ImagePlus,
  MapPin,
  Megaphone,
  MessageSquare,
  Mic,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Siren,
  X,
} from "lucide-react-native";
import { Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoute, type RouteProp } from "@react-navigation/native";
import VoiceTextInput from "../components/VoiceTextInput";
import ProfileAvatar from "../components/ProfileAvatar";
import type { MainTabParamList } from "../navigation/types";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { io } from "socket.io-client";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { cacheMessages, getCachedMessages } from "../services/db";
import {
  API_BASE_URL,
  apiFetch,
  getStoredAuthToken,
} from "../services/api";
import {
  uploadCloudinaryMedia,
  type CloudinaryMediaType,
  type CloudinaryUploadSignature,
} from "../services/cloudinaryUpload";
import { compressVideoForUpload } from "../services/videoCompression";
import { exceedsVideoDurationLimit } from "../services/videoDuration";

type ChannelId = string;
type GeographicScope =
  | "nearby"
  | "neighborhood"
  | "commune"
  | "region"
  | "country"
  | "international";
type InformationCategory = "COMMUNITY" | "OFFICIAL" | "SOS" | "EMERGENCY_CHAT";
type MessageMediaType = CloudinaryMediaType | "audio";
type Channel = {
  id: ChannelId;
  label: string;
  description: string;
  color: string;
  background: string;
  icon: typeof Siren;
  kind: string;
  scope?: GeographicScope;
  areaId?: string | null;
  countryCode?: string | null;
  isFollowing?: boolean;
  canPublishOfficial?: boolean;
};
type ChatMessage = {
  id: string;
  channelId?: ChannelId;
  conversationId?: string;
  text: string;
  senderName: string;
  senderPhotoUrl?: string | null;
  senderBadge?: string | null;
  senderIsAlly: boolean;
  createdAt: string;
  isOwnMessage: boolean;
  imageUrl?: string;
  mediaType?: MessageMediaType;
  informationType: "COMMUNITY" | "OFFICIAL";
  institutionName?: string | null;
  institutionId?: string | null;
};
type Institution = {
  id: string;
  name: string;
  institution_type: string;
  country_code: string;
  communication_area_id: string | null;
  status: string;
  membership_status: string;
};
type SosAlert = {
  id: string;
  emergency_type: string;
  status: string;
  created_at: string;
  distance_m: number | null;
  is_mine: boolean;
};
type UploadedMessageMedia = {
  publicId: string;
  secureUrl: string;
  mediaType: MessageMediaType;
};
type PrivateConversation = {
  id: string;
  participantId: string;
  participantName: string;
  participantPhotoUrl: string | null;
  participantBadge: string | null;
  participantIsAlly: boolean;
  participantType: "neighbor" | "seller";
  lastMessage: string;
  updatedAt: string;
  unreadCount: number;
};

const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL;
const CHANNELS: Channel[] = [
  {
    id: "emergency",
    label: "URGENCES",
    description: "Canal prioritaire · Talkie-walkie",
    color: "#dc2626",
    background: "#fef2f2",
    icon: Siren,
    kind: "EMERGENCY",
  },
  {
    id: "announcements",
    label: "ANNONCES",
    description: "Informations officielles du quartier",
    color: "#ca8a04",
    background: "#fefce8",
    icon: Megaphone,
    kind: "ANNOUNCEMENTS",
  },
];
const GEOGRAPHIC_SCOPES: { id: GeographicScope; label: string }[] = [
  { id: "nearby", label: "Autour de moi" },
  { id: "neighborhood", label: "Mon quartier" },
  { id: "commune", label: "Ma commune" },
  { id: "region", label: "Ma région" },
  { id: "country", label: "Mon pays" },
  { id: "international", label: "International" },
];
const REPORT_REASONS = [
  "Harcèlement",
  "Insultes",
  "Arnaque",
  "Faux profil",
  "Spam",
  "Fausse information",
  "Fausse alerte",
  "Usurpation d’identité",
  "Contenu dangereux",
  "Autre motif",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const formatAudioTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
};

const normalizeChannel = (value: unknown): Channel | null => {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? "");
  const kind = String(value.kind ?? "").toUpperCase();
  const scope =
    typeof value.scope === "string" &&
    GEOGRAPHIC_SCOPES.some((item) => item.id === value.scope)
      ? (value.scope as GeographicScope)
      : undefined;
  if (!id || !["COMMUNITY", "ANNOUNCEMENTS", "EMERGENCY"].includes(kind)) {
    return null;
  }
  const icon =
    kind === "EMERGENCY"
      ? Siren
      : kind === "ANNOUNCEMENTS"
        ? Megaphone
        : MessageSquare;
  const color =
    kind === "EMERGENCY"
      ? "#dc2626"
      : kind === "ANNOUNCEMENTS"
        ? "#ca8a04"
        : "#2563eb";
  return {
    id,
    label: String(value.name ?? "Canal public"),
    description:
      scope === "international"
        ? "Canal communautaire international"
        : scope
          ? `Canal ${scope}`
          : "Canal communautaire",
    color,
    background:
      kind === "EMERGENCY"
        ? "#fef2f2"
        : kind === "ANNOUNCEMENTS"
          ? "#fefce8"
          : "#eff6ff",
    icon,
    kind,
    scope,
    areaId: typeof value.area_id === "string" ? value.area_id : null,
    countryCode:
      typeof value.country_code === "string" ? value.country_code : null,
    isFollowing: value.is_following === true,
    canPublishOfficial: value.can_publish_official === true,
  };
};

const normalizeMessage = (
  value: unknown,
  channelId?: ChannelId,
  conversationId?: string,
): ChatMessage | null => {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? value.message_id ?? "");
  const rawChannel = value.channel_id ?? value.channelId;
  const messageChannel = rawChannel == null ? channelId : String(rawChannel);
  const rawConversation = value.conversation_id ?? value.conversationId;
  const messageConversation =
    rawConversation == null ? conversationId : String(rawConversation);
  if (
    !id ||
    (channelId && messageChannel !== channelId) ||
    (conversationId && messageConversation !== conversationId) ||
    (!channelId && !conversationId)
  ) {
    return null;
  }
  const sender = isRecord(value.sender) ? value.sender : null;
  return {
    id,
    channelId,
    conversationId,
    text: String(value.content ?? value.text ?? ""),
    senderName: String(
      sender?.name ?? value.sender_name ?? value.username ?? "Voisin",
    ),
    senderPhotoUrl:
      typeof value.sender_photo_url === "string"
        ? value.sender_photo_url
        : typeof sender?.photo_url === "string"
          ? sender.photo_url
          : null,
    senderBadge:
      typeof value.sender_badge === "string" ? value.sender_badge : null,
    senderIsAlly: value.sender_is_ally === true,
    createdAt: String(
      value.created_at ?? value.createdAt ?? new Date().toISOString(),
    ),
    isOwnMessage: value.is_mine === true || value.isOwnMessage === true,
    imageUrl:
      typeof value.media_url === "string"
        ? value.media_url
        : typeof value.image_url === "string"
        ? value.image_url
        : typeof value.imageUrl === "string"
          ? value.imageUrl
          : undefined,
    mediaType:
      value.media_type === "audio"
        ? "audio"
        : value.media_type === "video"
          ? "video"
          : value.media_url || value.image_url
            ? "image"
            : undefined,
    informationType:
      value.information_type === "OFFICIAL" ? "OFFICIAL" : "COMMUNITY",
    institutionName:
      typeof value.institution_name === "string" ? value.institution_name : null,
    institutionId:
      typeof value.institution_id === "string" ? value.institution_id : null,
  };
};

function PrivateMessageVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });
  return <VideoView contentFit="contain" nativeControls player={player} style={styles.messagePhoto} />;
}

function AudioMessagePlayer({ uri }: { uri: string }) {
  const player = useAudioPlayer(uri, { updateInterval: 150 });
  const status = useAudioPlayerStatus(player);
  const duration = status.duration || 0;
  const progress = duration > 0 ? status.currentTime / duration : 0;
  return (
    <View style={styles.audioMessagePlayer}>
      <Pressable
        accessibilityLabel={status.playing ? "Mettre le vocal en pause" : "Lire le message vocal"}
        accessibilityRole="button"
        onPress={() => {
          if (status.playing) player.pause();
          else {
            if (status.didJustFinish) void player.seekTo(0);
            player.play();
          }
        }}
        style={styles.audioPlayButton}
      >
        {status.playing ? <Pause color="#ffffff" size={17} /> : <Play color="#ffffff" size={17} />}
      </Pressable>
      <View style={styles.audioWaveform}>
        {Array.from({ length: 28 }, (_, index) => {
          const height = 6 + ((index * 13) % 17);
          return (
            <View
              key={index}
              style={[
                styles.audioWaveformBar,
                { height, backgroundColor: index / 28 <= progress ? "#16856b" : "#a9c5bb" },
              ]}
            />
          );
        })}
      </View>
      <Text style={styles.audioDuration}>{formatAudioTime(status.currentTime || duration)}</Text>
    </View>
  );
}

function VoiceRecorderModal({
  visible,
  uploadProgress,
  onClose,
  onSend,
}: {
  visible: boolean;
  uploadProgress: number | null;
  onClose: () => void;
  onSend: (uri: string, durationSeconds: number) => Promise<boolean>;
}) {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    extension: ".m4a",
    numberOfChannels: 1,
    bitRate: 64_000,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<"idle" | "recording" | "paused" | "preview" | "uploading">("idle");
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const isFinalizingRef = useRef(false);
  const player = useAudioPlayer(recordingUri, { updateInterval: 150 });
  const playerStatus = useAudioPlayerStatus(player);
  const isRecording = phase === "recording" || phase === "paused";
  const elapsedSeconds = isRecording
    ? recorderState.durationMillis / 1000
    : durationSeconds;
  const meter = typeof recorderState.metering === "number"
    ? Math.max(0, Math.min(1, (recorderState.metering + 60) / 60))
    : 0.12;

  const stopRecording = async () => {
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("Le fichier enregistré est introuvable.");
      const duration = Math.max(1, Math.ceil(recorder.currentTime || recorderState.durationMillis / 1000));
      setRecordingUri(uri);
      setDurationSeconds(duration);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      setPhase("preview");
    } catch (error) {
      Alert.alert("Enregistrement interrompu", error instanceof Error ? error.message : "Le vocal n’a pas pu être finalisé.");
      setPhase("idle");
    } finally {
      isFinalizingRef.current = false;
    }
  };

  useEffect(() => {
    if (phase === "recording" && recorderState.durationMillis >= 420_000) {
      void stopRecording();
    }
  }, [phase, recorderState.durationMillis]);

  const clearRecording = async () => {
    player.pause();
    const fileUri = recordingUri ?? recorder.uri;
    if (fileUri) {
      try {
        new File(fileUri).delete();
      } catch {
        setRecordingUri(null);
      }
    }
    setRecordingUri(null);
    setDurationSeconds(0);
    setPhase("idle");
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
  };

  const closeRecorder = async () => {
    if (phase === "uploading") return;
    if (phase === "recording" || phase === "paused") {
      await recorder.stop().catch(() => undefined);
    }
    await clearRecording();
    onClose();
  };

  const startRecording = async () => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Autorisez l’accès au microphone dans les réglages pour enregistrer un vocal.");
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase("recording");
    } catch (error) {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      Alert.alert("Microphone indisponible", error instanceof Error ? error.message : "Impossible de démarrer l’enregistrement.");
    }
  };

  const sendRecording = async () => {
    if (!recordingUri) return;
    setPhase("uploading");
    const sent = await onSend(recordingUri, durationSeconds);
    if (!sent) {
      setPhase("preview");
      return;
    }
    await clearRecording();
    onClose();
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => void closeRecorder()}
      transparent
      visible={visible}
    >
      <View style={styles.voiceBackdrop}>
        <View style={styles.voicePanel}>
          <View style={styles.voiceHeader}>
            <View>
              <Text style={styles.voiceEyebrow}>VOIX DU QUARTIER</Text>
              <Text style={styles.voiceTitle}>Message vocal</Text>
            </View>
            <Pressable
              accessibilityLabel="Fermer l’enregistreur"
              accessibilityRole="button"
              disabled={phase === "uploading"}
              onPress={() => void closeRecorder()}
              style={styles.closeButton}
            >
              <X color="#64748b" size={20} />
            </Pressable>
          </View>
          <View style={styles.voiceWaveformBox}>
            <View style={styles.audioWaveform} accessibilityLabel="Niveau audio en temps réel">
              {Array.from({ length: 32 }, (_, index) => {
                const variation = 0.35 + ((index * 7) % 13) / 20;
                const height = 5 + meter * variation * 34;
                const played = phase === "recording" || phase === "paused" || (playerStatus.duration > 0 && index / 32 <= playerStatus.currentTime / playerStatus.duration);
                return (
                  <View
                    key={index}
                    style={[
                      styles.audioWaveformBar,
                      styles.voiceWaveBar,
                      { height, backgroundColor: played ? "#16856b" : "#c8d8d1" },
                    ]}
                  />
                );
              })}
            </View>
            <Text style={styles.voiceTimer}>{formatAudioTime(elapsedSeconds)}</Text>
            <Text style={styles.voiceStatus}>
              {phase === "recording" ? "Enregistrement en cours" : phase === "paused" ? "Enregistrement en pause" : phase === "preview" ? "Écoute avant envoi" : phase === "uploading" ? "Envoi du vocal…" : "Votre voix, à votre rythme"}
            </Text>
          </View>
          {phase === "idle" && (
            <Pressable accessibilityRole="button" onPress={() => void startRecording()} style={styles.voicePrimaryButton}>
              <Mic color="#ffffff" size={18} />
              <Text style={styles.voicePrimaryText}>Commencer l’enregistrement</Text>
            </Pressable>
          )}
          {phase === "recording" && (
            <View style={styles.voiceActions}>
              <Pressable accessibilityRole="button" onPress={() => { recorder.pause(); setPhase("paused"); }} style={styles.voiceSecondaryButton}>
                <Pause color="#35564a" size={17} />
                <Text style={styles.voiceSecondaryText}>Pause</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void stopRecording()} style={styles.voicePrimaryButton}>
                <Text style={styles.voicePrimaryText}>Terminer</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void closeRecorder()} style={styles.voiceCancelButton}>
                <Text style={styles.voiceCancelText}>Annuler</Text>
              </Pressable>
            </View>
          )}
          {phase === "paused" && (
            <View style={styles.voiceActions}>
              <Pressable accessibilityRole="button" onPress={() => { recorder.record(); setPhase("recording"); }} style={styles.voicePrimaryButton}>
                <Play color="#ffffff" size={17} />
                <Text style={styles.voicePrimaryText}>Reprendre</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void stopRecording()} style={styles.voiceSecondaryButton}>
                <Text style={styles.voiceSecondaryText}>Écouter</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void closeRecorder()} style={styles.voiceCancelButton}>
                <Text style={styles.voiceCancelText}>Annuler</Text>
              </Pressable>
            </View>
          )}
          {phase === "preview" && (
            <View style={styles.voiceActions}>
              <Pressable accessibilityRole="button" onPress={() => statusPlayPause(player, playerStatus)} style={styles.voiceSecondaryButton}>
                {playerStatus.playing ? <Pause color="#35564a" size={17} /> : <Play color="#35564a" size={17} />}
                <Text style={styles.voiceSecondaryText}>{playerStatus.playing ? "Pause" : "Écouter"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void clearRecording()} style={styles.voiceCancelButton}>
                <Text style={styles.voiceCancelText}>Recommencer</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void sendRecording()} style={styles.voicePrimaryButton}>
                <Send color="#ffffff" size={16} />
                <Text style={styles.voicePrimaryText}>Envoyer</Text>
              </Pressable>
            </View>
          )}
          {phase === "uploading" && (
            <View style={styles.voiceUploading}>
              <ActivityIndicator color="#16856b" />
              <View style={styles.voiceUploadTrack}>
                <View style={[styles.voiceUploadBar, { width: `${uploadProgress ?? 0}%` }]} />
              </View>
              <Text style={styles.voiceStatus}>{uploadProgress ?? 0}% · Original conservé</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const statusPlayPause = (
  player: ReturnType<typeof useAudioPlayer>,
  status: ReturnType<typeof useAudioPlayerStatus>,
) => {
  if (status.playing) player.pause();
  else {
    if (status.didJustFinish) void player.seekTo(0);
    player.play();
  }
};

const normalizeConversation = (value: unknown): PrivateConversation | null => {
  if (!isRecord(value)) return null;
  const participant = isRecord(value.participant)
    ? value.participant
    : isRecord(value.other_user)
      ? value.other_user
      : isRecord(value.counterpart)
        ? value.counterpart
        : null;
  const id = String(value.id ?? value.conversation_id ?? "");
  const participantId = String(
    participant?.id ??
      value.participant_id ??
      value.other_user_id ??
      value.counterpart_id ??
      "",
  );
  const participantName = String(
    participant?.name ??
      value.participant_name ??
      value.other_user_name ??
      value.counterpart_name ??
      "",
  );
  const rawType = String(
    participant?.type ??
    participant?.role ??
    value.participant_type ??
    value.counterpart_type ??
    value.user_type ??
    (participant?.is_seller === true || value.is_seller === true
      ? "seller"
      : "neighbor"),
  ).toLowerCase();
  const lastMessage = isRecord(value.last_message)
    ? value.last_message.content ?? value.last_message.text ?? ""
    : value.last_message ?? value.lastMessage ?? "";
  if (!id || !participantId || !participantName) return null;
  return {
    id,
    participantId,
    participantName,
    participantPhotoUrl:
      typeof value.participant_photo_url === "string"
        ? value.participant_photo_url
        : typeof participant?.photo_url === "string"
          ? participant.photo_url
          : null,
    participantBadge:
      typeof value.participant_badge === "string" ? value.participant_badge : null,
    participantIsAlly: value.participant_is_ally === true,
    participantType: ["seller", "merchant", "vendor", "commercant"].includes(
      rawType,
    )
      ? "seller"
      : "neighbor",
    lastMessage: String(lastMessage),
    updatedAt: String(
      value.updated_at ?? value.updatedAt ?? new Date().toISOString(),
    ),
    unreadCount: Math.max(
      0,
      Number(value.unread_count ?? value.unreadCount ?? 0) || 0,
    ),
  };
};

export default function MessagesScreen() {
  const { colors, t } = useTheme();
  const route = useRoute<RouteProp<MainTabParamList, "Messages">>();
  const { isOffline, requestAuthentication, token, user } = useAuth();
  const [activeTab, setActiveTab] = useState<"Privés" | "Canaux">("Privés");
  const [selectedChannelId, setSelectedChannelId] =
    useState<ChannelId>("emergency");
  const [channels, setChannels] = useState<Channel[]>(CHANNELS);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [geographicScope, setGeographicScope] =
    useState<GeographicScope>("nearby");
  const [informationCategory, setInformationCategory] =
    useState<InformationCategory>("COMMUNITY");
  const [channelSearch, setChannelSearch] = useState("");
  const [targetCountryCode, setTargetCountryCode] = useState("");
  const [searchedChannels, setSearchedChannels] = useState<Channel[]>([]);
  const [isSearchingChannels, setIsSearchingChannels] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const [isInstitutionFormVisible, setIsInstitutionFormVisible] =
    useState(false);
  const [institutionName, setInstitutionName] = useState("");
  const [institutionType, setInstitutionType] = useState("MUNICIPALITY");
  const [institutionLegalId, setInstitutionLegalId] = useState("");
  const [institutionProofUrl, setInstitutionProofUrl] = useState("");
  const [isSubmittingInstitution, setIsSubmittingInstitution] = useState(false);
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);
  const [isLoadingSosAlerts, setIsLoadingSosAlerts] = useState(false);
  const [sosAlertsError, setSosAlertsError] = useState<string | null>(null);
  const [isSubmittingSosAction, setIsSubmittingSosAction] = useState(false);
  const [conversations, setConversations] = useState<PrivateConversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(
    null,
  );
  const [conversationSearch, setConversationSearch] = useState("");
  const [selectedConversation, setSelectedConversation] =
    useState<PrivateConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isVoiceRecorderVisible, setIsVoiceRecorderVisible] = useState(false);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [isCompressingMedia, setIsCompressingMedia] = useState(false);
  const [mediaUploadProgress, setMediaUploadProgress] = useState<number | null>(null);
  const [selectedReport, setSelectedReport] = useState<ChatMessage | null>(null);
  const [selectedOfficialMessage, setSelectedOfficialMessage] =
    useState<ChatMessage | null>(null);
  const [officialEditDraft, setOfficialEditDraft] = useState("");
  const [officialHistory, setOfficialHistory] = useState<Record<string, unknown>[]>([]);
  const [isLoadingOfficialHistory, setIsLoadingOfficialHistory] = useState(false);
  const [isUpdatingOfficialMessage, setIsUpdatingOfficialMessage] =
    useState(false);
  const [reportReason, setReportReason] = useState("");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [isPttVisible, setIsPttVisible] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [isConnectingToLiveKit, setIsConnectingToLiveKit] = useState(false);
  const [liveKitConnected, setLiveKitConnected] = useState(false);
  const [pttError, setPttError] = useState<string | null>(null);

  const liveKitRoomRef = useRef<Room | null>(null);
  const liveKitConnectPromiseRef = useRef<Promise<Room> | null>(null);
  const liveKitTokenControllerRef = useRef<AbortController | null>(null);
  const pttPressedRef = useRef(false);
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ??
    CHANNELS.find((channel) => channel.id === selectedChannelId) ??
    CHANNELS[0];
  const visibleChannels = channels.filter((channel) =>
    informationCategory === "COMMUNITY"
      ? channel.kind === "COMMUNITY"
      : informationCategory === "OFFICIAL"
        ? channel.kind === "ANNOUNCEMENTS"
        : informationCategory === "EMERGENCY_CHAT"
          ? channel.kind === "EMERGENCY"
          : false,
  );
  const hasSelectedChannel = visibleChannels.some(
    (channel) => channel.id === selectedChannelId,
  );
  const publishableInstitutions = institutions.filter(
    (institution) =>
      institution.status === "VERIFIED" &&
      institution.membership_status === "ACTIVE" &&
      ((institution.communication_area_id &&
        institution.communication_area_id === selectedChannel.areaId) ||
        (!institution.communication_area_id &&
          !selectedChannel.areaId &&
          institution.country_code === selectedChannel.countryCode)),
  );
  const filteredConversations = useMemo(() => {
    const normalize = (text: string) =>
      text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase();
    const query = normalize(conversationSearch.trim());
    if (!query) return conversations;
    return conversations.filter((conversation) =>
      normalize(
        `${conversation.participantName} ${conversation.lastMessage}`,
      ).includes(query),
    );
  }, [conversationSearch, conversations]);

  useEffect(() => {
    const params = route.params;
    if (!params?.voiceRequestId) return;
    if (params.voiceChannelId) {
      setActiveTab("Canaux");
      setInformationCategory(
        params.voiceChannelId === "emergency" ? "EMERGENCY_CHAT" : "OFFICIAL",
      );
      setSelectedChannelId(params.voiceChannelId);
      setSelectedConversation(null);
      setConversationSearch("");
      return;
    }
    setActiveTab("Privés");
    setSelectedConversation(null);
    setConversationSearch(params.voiceContactQuery ?? "");
  }, [route.params]);

  useEffect(() => {
    if (activeTab !== "Canaux") return;
    if (!API_BASE_URL) {
      setChannelsError(
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    const controller = new AbortController();
    const loadChannels = async () => {
      setChannelsError(null);
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/channels?scope=${encodeURIComponent(geographicScope)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Chargement refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const records =
          isRecord(payload) && Array.isArray(payload.channels)
            ? payload.channels
            : null;
        if (!records) {
          throw new Error("Le serveur a renvoyé un annuaire de canaux invalide.");
        }
        const normalized = records.map(normalizeChannel);
        if (normalized.some((channel) => channel === null)) {
          throw new Error("L'annuaire contient un canal invalide.");
        }
        const validChannels = normalized.filter(
          (channel): channel is Channel => channel !== null,
        );
        setChannels(validChannels);
        const categoryKind =
          informationCategory === "COMMUNITY"
            ? "COMMUNITY"
            : informationCategory === "OFFICIAL"
              ? "ANNOUNCEMENTS"
              : informationCategory === "EMERGENCY_CHAT"
                ? "EMERGENCY"
                : null;
        const categoryChannels = categoryKind
          ? validChannels.filter((channel) => channel.kind === categoryKind)
          : [];
        if (
          categoryChannels.length > 0 &&
          !categoryChannels.some((channel) => channel.id === selectedChannelId)
        ) {
          setSelectedChannelId(categoryChannels[0].id);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setChannelsError(
          error instanceof Error
            ? error.message
            : "Impossible de charger les canaux géographiques.",
        );
      }
    };
    void loadChannels();
    return () => controller.abort();
  }, [activeTab, geographicScope, informationCategory, isOffline]);

  useEffect(() => {
    if (activeTab !== "Canaux" || !API_BASE_URL) return;
    const controller = new AbortController();
    const loadInstitutions = async () => {
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/channels/institutions/mine`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Chargement des institutions refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const records =
          isRecord(payload) && Array.isArray(payload.institutions)
            ? payload.institutions
            : null;
        if (!records) {
          throw new Error("Le serveur a renvoyé une liste institutionnelle invalide.");
        }
        setInstitutions(
          records.filter(
            (institution): institution is Institution =>
              isRecord(institution) &&
              typeof institution.id === "string" &&
              typeof institution.name === "string" &&
              typeof institution.institution_type === "string" &&
              typeof institution.country_code === "string" &&
              typeof institution.status === "string" &&
              typeof institution.membership_status === "string",
          ),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Unable to load current institutions:", error);
        }
      }
    };
    void loadInstitutions();
    return () => controller.abort();
  }, [activeTab, isOffline]);

  const loadSosAlerts = useCallback(async () => {
    if (!API_BASE_URL) {
      setSosAlertsError(
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    if (isOffline) {
      setSosAlertsError("Les alertes SOS nécessitent une connexion réseau.");
      return;
    }
    setIsLoadingSosAlerts(true);
    setSosAlertsError(null);
    let coordinates: { latitude: number; longitude: number } | null = null;
    let locationError: string | null = null;
    try {
      let permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== "granted" && permission.canAskAgain) {
        permission = await Location.requestForegroundPermissionsAsync();
      }
      if (permission.status === "granted") {
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
      } else {
        locationError =
          "Localisation refusée : les alertes sont affichées à l'échelle du pays.";
      }
    } catch (error) {
      locationError =
        error instanceof Error
          ? `Position indisponible : ${error.message}`
          : "Position indisponible : affichage des alertes du pays.";
    }
    try {
      const countryCode =
        typeof user?.country_code === "string" ? user.country_code : "";
      const query = new URLSearchParams();
      if (coordinates && /^[A-Z]{2,3}$/i.test(countryCode)) {
        query.set("scope", "neighborhood");
        query.set("latitude", String(coordinates.latitude));
        query.set("longitude", String(coordinates.longitude));
        query.set("country_code", countryCode);
      } else if (/^[A-Z]{2,3}$/i.test(countryCode)) {
        query.set("scope", "country");
        query.set("country_code", countryCode);
      } else {
        query.set("scope", "international");
      }
      const response = await apiFetch(
        `${API_BASE_URL}/v1/sos/alerts?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`Chargement refusé (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const records =
        isRecord(payload) && Array.isArray(payload.alerts) ? payload.alerts : null;
      if (!records) {
        throw new Error("Le serveur a renvoyé une liste d'alertes invalide.");
      }
      setSosAlerts(
        records.filter(
          (alert): alert is SosAlert =>
            isRecord(alert) &&
            typeof alert.id === "string" &&
            typeof alert.emergency_type === "string" &&
            typeof alert.status === "string" &&
            typeof alert.created_at === "string" &&
            typeof alert.is_mine === "boolean",
        ),
      );
      setSosAlertsError(locationError);
    } catch (error) {
      setSosAlertsError(
        error instanceof Error
          ? error.message
          : "Impossible de charger les alertes SOS.",
      );
    } finally {
      setIsLoadingSosAlerts(false);
    }
  }, [isOffline, user?.country_code]);

  useEffect(() => {
    if (activeTab !== "Canaux" || informationCategory !== "SOS") return;
    void loadSosAlerts();
    const interval = setInterval(() => void loadSosAlerts(), 60_000);
    return () => clearInterval(interval);
  }, [activeTab, informationCategory, loadSosAlerts]);

  useEffect(() => {
    if (activeTab !== "Privés") return;
    if (!API_BASE_URL) {
      setConversationsError(
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      setIsLoadingConversations(false);
      return;
    }
    const controller = new AbortController();
    const loadConversations = async () => {
      setIsLoadingConversations(true);
      setConversationsError(null);
      try {
        const response = await apiFetch(`${API_BASE_URL}/v1/conversations`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Chargement refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const rawConversations = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.conversations)
            ? payload.conversations
            : null;
        if (!rawConversations) {
          throw new Error("Le serveur a renvoyé une liste de conversations invalide.");
        }
        const normalized = rawConversations.map(normalizeConversation);
        if (normalized.some((conversation) => conversation === null)) {
          throw new Error("La liste contient une conversation invalide.");
        }
        setConversations(
          normalized.filter(
            (conversation): conversation is PrivateConversation =>
              conversation !== null,
          ),
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setConversationsError(
          error instanceof Error
            ? error.message
            : "Impossible de charger les conversations privées.",
        );
      } finally {
        if (!controller.signal.aborted) setIsLoadingConversations(false);
      }
    };
    void loadConversations();
    return () => controller.abort();
  }, [activeTab, isOffline]);

  useEffect(() => {
    if (activeTab === "Privés") {
      if (!selectedConversation) {
        setMessages([]);
        setIsLoadingMessages(false);
        setMessagesError(null);
        return;
      }
      if (!API_BASE_URL) {
        setMessagesError(
          "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
        );
        setIsLoadingMessages(false);
        return;
      }
      const controller = new AbortController();
      const loadPrivateMessages = async () => {
        setIsLoadingMessages(true);
        setMessages([]);
        setMessagesError(null);
        try {
          const response = await apiFetch(
            `${API_BASE_URL}/v1/conversations/${encodeURIComponent(selectedConversation.id)}/messages`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            throw new Error(`Chargement refusé (HTTP ${response.status}).`);
          }
          const payload: unknown = await response.json();
          const rawMessages = Array.isArray(payload)
            ? payload
            : isRecord(payload) && Array.isArray(payload.messages)
              ? payload.messages
              : null;
          if (!rawMessages) {
            throw new Error("Le serveur a renvoyé une liste de messages invalide.");
          }
          const normalized = rawMessages.map((message) =>
            normalizeMessage(message, undefined, selectedConversation.id),
          );
          if (normalized.some((message) => message === null)) {
            throw new Error("La liste contient un message invalide.");
          }
          const validMessages = normalized.filter(
            (message): message is ChatMessage => message !== null,
          );
          setMessages(validMessages);
          await cacheMessages(
            `user:${encodeURIComponent(user?.id ?? "anonymous")}:conversation:${selectedConversation.id}`,
            validMessages,
          ).catch((cacheError: unknown) => {
            console.error("Unable to persist loaded private messages:", cacheError);
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          try {
            const cachedMessages = await getCachedMessages<ChatMessage>(
              `user:${encodeURIComponent(user?.id ?? "anonymous")}:conversation:${selectedConversation.id}`,
            );
            setMessages(cachedMessages);
            setMessagesError(
              cachedMessages.length
                ? "Affichage des derniers messages enregistrés hors ligne."
                : error instanceof Error
                  ? error.message
                  : "Impossible de charger cette discussion privée.",
            );
          } catch (cacheError) {
            console.error("Unable to load private-message cache:", cacheError);
            setMessagesError(
              error instanceof Error
                ? error.message
                : "Impossible de charger cette discussion privée.",
            );
          }
        } finally {
          if (!controller.signal.aborted) setIsLoadingMessages(false);
        }
      };
      void loadPrivateMessages();
      return () => controller.abort();
    }

    if (informationCategory === "SOS") {
      setMessages([]);
      setIsLoadingMessages(false);
      setMessagesError(null);
      return;
    }

    if (!API_BASE_URL) {
      setMessagesError(
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      setIsLoadingMessages(false);
      return;
    }

    const controller = new AbortController();
    const loadMessages = async () => {
      setIsLoadingMessages(true);
      setMessagesError(null);
      setMessages([]);
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/channels/${encodeURIComponent(selectedChannelId)}/messages`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Chargement refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const rawMessages = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.messages)
            ? payload.messages
            : null;
        if (!rawMessages) {
          throw new Error("Le serveur a renvoyé une liste de messages invalide.");
        }
        const normalizedMessages = rawMessages.map((message) =>
          normalizeMessage(message, selectedChannelId),
        );
        if (normalizedMessages.some((message) => message === null)) {
          throw new Error("La liste contient un message invalide.");
        }
        const validMessages = normalizedMessages.filter(
          (message): message is ChatMessage => message !== null,
        );
        setMessages((current) => {
          const byId = new Map(validMessages.map((message) => [message.id, message]));
          current.forEach((message) => byId.set(message.id, message));
          return [...byId.values()];
        });
        await cacheMessages(
          `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`,
          validMessages,
        ).catch((cacheError: unknown) => {
          console.error("Unable to persist loaded channel messages:", cacheError);
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        try {
          const cachedMessages = await getCachedMessages<ChatMessage>(
            `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`,
          );
          setMessages(cachedMessages);
          setMessagesError(
            cachedMessages.length
              ? "Affichage des derniers messages enregistrés hors ligne."
              : error instanceof Error
                ? error.message
                : "Impossible de charger les messages du canal.",
          );
        } catch (cacheError) {
          console.error("Unable to load channel-message cache:", cacheError);
          setMessagesError(
            error instanceof Error
              ? error.message
              : "Impossible de charger les messages du canal.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setIsLoadingMessages(false);
      }
    };

    void loadMessages();
    return () => controller.abort();
  }, [
    activeTab,
    informationCategory,
    isOffline,
    selectedChannelId,
    selectedConversation,
    user?.id,
  ]);

  useEffect(() => {
    if (!API_BASE_URL) return;
    if (activeTab === "Canaux" && informationCategory === "SOS") return;
    const isPrivateConversation =
      activeTab === "Privés" && selectedConversation !== null;
    if (activeTab === "Privés" && !selectedConversation) return;
    let socket: ReturnType<typeof io> | null = null;
    let cancelled = false;
    void (async () => {
      const storedToken = await getStoredAuthToken();
      if (cancelled) return;
      const authToken = token ?? storedToken;
      if (!authToken) return;
      socket = io(API_BASE_URL, {
        auth: { token: authToken },
        transports: ["websocket"],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10_000,
      });
      const activeSocket = socket;
      activeSocket.on("connect", () => {
        if (isPrivateConversation && selectedConversation) {
          activeSocket.emit("join_conversation", {
            conversation_id: selectedConversation.id,
          });
        } else {
          activeSocket.emit("join_channel", { channel_id: selectedChannelId });
        }
      });
      activeSocket.on("new_message", (payload: unknown) => {
        if (!isRecord(payload)) return;
        const message =
          isPrivateConversation && selectedConversation
            ? normalizeMessage(payload, undefined, selectedConversation.id)
            : String(payload.channel_id ?? payload.channelId ?? "") ===
                selectedChannelId
              ? normalizeMessage(payload, selectedChannelId)
              : null;
        if (!message) return;
        const threadKey =
          isPrivateConversation && selectedConversation
            ? `user:${encodeURIComponent(user?.id ?? "anonymous")}:conversation:${selectedConversation.id}`
            : `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`;
        setMessages((current) => [
          ...current.filter((item) => item.id !== message.id),
          message,
        ]);
        void cacheMessages(threadKey, [message]).catch((error: unknown) => {
          console.error("Unable to cache a received chat message:", error);
        });
      });
      activeSocket.on("channel:new_message", (payload: unknown) => {
        if (isPrivateConversation || !isRecord(payload)) return;
        if (
          String(payload.channel_name ?? "").toUpperCase() !==
          selectedChannel.label
        ) {
          return;
        }
        const message = normalizeMessage(
          { ...payload, channel_id: selectedChannelId },
          selectedChannelId,
        );
        if (!message) return;
        setMessages((current) => [
          ...current.filter((item) => item.id !== message.id),
          message,
        ]);
        void cacheMessages(
          `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`,
          [message],
        ).catch(
          (error: unknown) => {
            console.error("Unable to cache a channel:new_message event:", error);
          },
        );
      });
      activeSocket.on("chat:message", (payload: unknown) => {
        if (!isRecord(payload)) return;
        const message =
          isPrivateConversation && selectedConversation
            ? normalizeMessage(payload, undefined, selectedConversation.id)
            : isRecord(payload) &&
                String(payload.channel_name ?? "").toUpperCase() === selectedChannel.label
              ? normalizeMessage(
                  { ...payload, channel_id: selectedChannelId },
                  selectedChannelId,
                )
              : normalizeMessage(payload, selectedChannelId);
        if (!message) return;
        const threadKey =
          isPrivateConversation && selectedConversation
            ? `user:${encodeURIComponent(user?.id ?? "anonymous")}:conversation:${selectedConversation.id}`
            : `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`;
        setMessages((current) => [
          ...current.filter((item) => item.id !== message.id),
          message,
        ]);
        void cacheMessages(threadKey, [message]).catch((error: unknown) => {
          console.error("Unable to cache a chat:message event:", error);
        });
      });
    })().catch((error: unknown) => {
      console.error("Unable to initialize the authenticated messages socket:", error);
    });

    return () => {
      cancelled = true;
      if (socket) {
        if (isPrivateConversation && selectedConversation) {
          socket.emit("leave_conversation", {
            conversation_id: selectedConversation.id,
          });
        } else {
          socket.emit("leave_channel", { channel_id: selectedChannelId });
        }
        socket.removeAllListeners("connect");
        socket.removeAllListeners("new_message");
        socket.removeAllListeners("channel:new_message");
        socket.removeAllListeners("chat:message");
        socket.disconnect();
      }
    };
  }, [
    activeTab,
    informationCategory,
    selectedChannelId,
    selectedConversation,
    token,
    user?.id,
  ]);

  useEffect(
    () => () => {
      const room = liveKitRoomRef.current;
      if (room) void room.disconnect();
      liveKitRoomRef.current = null;
      void AudioSession.stopAudioSession().catch(() => undefined);
    },
    [],
  );

  const toggleChannelFollow = async (channel: Channel) => {
    if (!user?.id || !token) {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    try {
      const following = !channel.isFollowing;
      const response = await apiFetch(
        `${API_BASE_URL}/v1/channels/${encodeURIComponent(channel.id)}/follow`,
        { method: following ? "POST" : "DELETE" },
      );
      if (!response.ok) {
        throw new Error(`Modification refusée (HTTP ${response.status}).`);
      }
      setChannels((current) =>
        current.map((item) =>
          item.id === channel.id ? { ...item, isFollowing: following } : item,
        ),
      );
      setSearchedChannels((current) =>
        current.map((item) =>
          item.id === channel.id ? { ...item, isFollowing: following } : item,
        ),
      );
    } catch (error) {
      Alert.alert(
        "Abonnement impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const searchGeographicChannels = async () => {
    if (!API_BASE_URL) return;
    const countryCode = targetCountryCode.trim().toUpperCase();
    const query = new URLSearchParams({
      scope: geographicScope,
      q: channelSearch.trim(),
    });
    if (countryCode) query.set("country_code", countryCode);
    setIsSearchingChannels(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/channels/catalog?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`Recherche refusée (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const records =
        isRecord(payload) && Array.isArray(payload.channels)
          ? payload.channels
          : null;
      if (!records) {
        throw new Error("Le serveur a renvoyé un annuaire invalide.");
      }
      const normalized = records.map(normalizeChannel);
      if (normalized.some((channel) => channel === null)) {
        throw new Error("L'annuaire contient un canal invalide.");
      }
      setSearchedChannels(
        normalized.filter((channel): channel is Channel => channel !== null),
      );
    } catch (error) {
      Alert.alert(
        "Recherche impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsSearchingChannels(false);
    }
  };

  const submitInstitutionVerification = async () => {
    if (!user?.id || !token) {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    if (institutionType === "MUNICIPALITY" && !selectedChannel.areaId) {
      Alert.alert(
        "Zone de mairie requise",
        "Sélectionnez d'abord le canal géographique de la commune concernée.",
      );
      return;
    }
    const countryCode =
      selectedChannel.countryCode ??
      (typeof user.country_code === "string" ? user.country_code : "");
    setIsSubmittingInstitution(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/channels/institutions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: institutionName.trim(),
          institution_type: institutionType,
          country_code: countryCode,
          ...(selectedChannel.areaId
            ? { communication_area_id: selectedChannel.areaId }
            : {}),
          legal_identifier: institutionLegalId.trim(),
          proof_url: institutionProofUrl.trim(),
        }),
      });
      if (!response.ok) {
        let message = `Demande refusée (HTTP ${response.status}).`;
        try {
          const payload: unknown = await response.json();
          if (isRecord(payload) && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // Keep the HTTP error visible when the response is not JSON.
        }
        throw new Error(message);
      }
      const payload: unknown = await response.json();
      const created =
        isRecord(payload) && isRecord(payload.institution)
          ? payload.institution
          : null;
      if (!created || typeof created.id !== "string") {
        throw new Error("Le serveur n'a pas confirmé la demande institutionnelle.");
      }
      const createdInstitutionId = created.id;
      setIsInstitutionFormVisible(false);
      setInstitutionName("");
      setInstitutionLegalId("");
      setInstitutionProofUrl("");
      Alert.alert(
        "Demande envoyée",
        "L'institution restera sans badge officiel et sans droit de publication jusqu'à vérification par l'administration.",
      );
      setInstitutions((current) => [
        ...current,
        {
          id: createdInstitutionId,
          name: institutionName.trim(),
          institution_type: institutionType,
          country_code: countryCode,
          communication_area_id: selectedChannel.areaId ?? null,
          status: "PENDING",
          membership_status: "PENDING",
        },
      ]);
    } catch (error) {
      Alert.alert(
        "Demande impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsSubmittingInstitution(false);
    }
  };

  const submitSosAction = async (
    alert: SosAlert,
    action: "assist" | "report-fake" | "resolve",
  ) => {
    if (!user?.id || !token) {
      requestAuthentication();
      return;
    }
    if (!API_BASE_URL) return;
    setIsSubmittingSosAction(true);
    try {
      const actionPath =
        action === "assist"
          ? `/v1/sos/${encodeURIComponent(alert.id)}/assist`
          : action === "report-fake"
            ? `/v1/sos/${encodeURIComponent(alert.id)}/report-fake`
            : `/v1/sos/${encodeURIComponent(alert.id)}/resolve`;
      const response = await apiFetch(
        `${API_BASE_URL}${actionPath}`,
        { method: "POST" },
      );
      if (!response.ok) {
        let message = `Action refusée (HTTP ${response.status}).`;
        try {
          const payload: unknown = await response.json();
          if (isRecord(payload) && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // Keep the HTTP error visible when the response is not JSON.
        }
        throw new Error(message);
      }
      Alert.alert(
        action === "assist"
          ? "Proposition d'aide enregistrée"
          : action === "resolve"
            ? "Alerte clôturée"
            : "Signalement transmis",
        action === "assist"
          ? "Votre proposition est associée à cette alerte."
          : action === "resolve"
            ? "Le suivi de cette alerte est terminé."
            : "La modération examinera cette alerte.",
      );
      await loadSosAlerts();
    } catch (error) {
      Alert.alert(
        "Action impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsSubmittingSosAction(false);
    }
  };

  const loadOfficialMessageHistory = async (messageId: string) => {
    if (!API_BASE_URL) return;
    setIsLoadingOfficialHistory(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/channels/official-messages/${encodeURIComponent(messageId)}/history`,
      );
      if (!response.ok) {
        throw new Error(`Historique indisponible (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const records =
        isRecord(payload) && Array.isArray(payload.history) ? payload.history : null;
      if (!records || records.some((item) => !isRecord(item))) {
        throw new Error("Le serveur a renvoyé un historique invalide.");
      }
      setOfficialHistory(records as Record<string, unknown>[]);
    } catch (error) {
      Alert.alert(
        "Historique indisponible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsLoadingOfficialHistory(false);
    }
  };

  const openOfficialMessage = (message: ChatMessage) => {
    setSelectedOfficialMessage(message);
    setOfficialEditDraft(message.text);
    setOfficialHistory([]);
    void loadOfficialMessageHistory(message.id);
  };

  const correctSelectedOfficialMessage = async () => {
    if (!selectedOfficialMessage || !API_BASE_URL) return;
    if (!selectedOfficialMessage.institutionId || !officialEditDraft.trim()) {
      Alert.alert("Correction invalide", "Saisissez le texte corrigé.");
      return;
    }
    setIsUpdatingOfficialMessage(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/channels/official-messages/${encodeURIComponent(selectedOfficialMessage.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: officialEditDraft.trim() }),
        },
      );
      if (!response.ok) {
        throw new Error(`Correction refusée (HTTP ${response.status}).`);
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === selectedOfficialMessage.id
            ? { ...message, text: officialEditDraft.trim() }
            : message,
        ),
      );
      setSelectedOfficialMessage((current) =>
        current ? { ...current, text: officialEditDraft.trim() } : current,
      );
      await loadOfficialMessageHistory(selectedOfficialMessage.id);
    } catch (error) {
      Alert.alert(
        "Correction impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsUpdatingOfficialMessage(false);
    }
  };

  const withdrawSelectedOfficialMessage = () => {
    if (!selectedOfficialMessage || !API_BASE_URL) return;
    Alert.alert(
      "Retirer l'annonce officielle",
      "L'annonce sera retirée du canal et cette action sera conservée dans son historique.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Retirer",
          style: "destructive",
          onPress: () => {
            setIsUpdatingOfficialMessage(true);
            void apiFetch(
              `${API_BASE_URL}/v1/channels/official-messages/${encodeURIComponent(selectedOfficialMessage.id)}`,
              { method: "DELETE" },
            )
              .then((response) => {
                if (!response.ok) {
                  throw new Error(`Retrait refusé (HTTP ${response.status}).`);
                }
                setMessages((current) =>
                  current.filter(
                    (message) => message.id !== selectedOfficialMessage.id,
                  ),
                );
                setSelectedOfficialMessage(null);
                Alert.alert(
                  "Annonce retirée",
                  "Le retrait a été enregistré dans l'historique officiel.",
                );
              })
              .catch((error: unknown) => {
                Alert.alert(
                  "Retrait impossible",
                  error instanceof Error
                    ? error.message
                    : "Une erreur est survenue.",
                );
              })
              .finally(() => setIsUpdatingOfficialMessage(false));
          },
        },
      ],
    );
  };

  const upsertMessage = (message: ChatMessage) => {
    setMessages((current) => [
      ...current.filter((item) => item.id !== message.id),
      message,
    ]);
    const threadKey =
      activeTab === "Privés" && selectedConversation
        ? `user:${encodeURIComponent(user?.id ?? "anonymous")}:conversation:${selectedConversation.id}`
        : `user:${encodeURIComponent(user?.id ?? "anonymous")}:channel:${selectedChannelId}`;
    void cacheMessages(threadKey, [message]).catch((error: unknown) => {
      console.error("Unable to cache a sent chat message:", error);
    });
  };

  const sendMessage = async (media?: UploadedMessageMedia): Promise<boolean> => {
    const text = draftMessage.trim();
    const isOfficialPublication =
      activeTab === "Canaux" && informationCategory === "OFFICIAL";
    if (!text && !media) {
      Alert.alert("Message vide", "Saisissez un message ou joignez une photo.");
      return false;
    }
    if (
      isOfficialPublication &&
      !publishableInstitutions.some(
        (institution) => institution.id === selectedInstitutionId,
      )
    ) {
      Alert.alert(
        "Publication officielle indisponible",
        "Sélectionnez une institution vérifiée et autorisée pour ce canal.",
      );
      return false;
    }
    if (!user?.id || !token) {
      requestAuthentication();
      return false;
    }
    if (!API_BASE_URL) {
      Alert.alert(
        "Envoi indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return false;
    }
    setIsSending(true);
    try {
      if (activeTab === "Privés" && !selectedConversation) {
        throw new Error("Ouvrez une conversation avant d'envoyer un message.");
      }
      const url =
        activeTab === "Privés" && selectedConversation
          ? `${API_BASE_URL}/v1/conversations/${encodeURIComponent(selectedConversation.id)}/messages`
          : `${API_BASE_URL}/v1/channels/${encodeURIComponent(selectedChannelId)}/messages`;
      const response = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          ...(isOfficialPublication
            ? {
                information_type: "OFFICIAL",
                institution_id: selectedInstitutionId,
              }
            : activeTab === "Canaux"
              ? { information_type: "COMMUNITY" }
              : {}),
          ...(media
            ? {
                media_url: media.secureUrl,
                media_type: media.mediaType,
                media_public_id: media.publicId,
              }
            : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`L'envoi a échoué (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      const rawMessage =
        isRecord(payload) && "message" in payload ? payload.message : payload;
      const message =
        activeTab === "Privés" && selectedConversation
          ? normalizeMessage(rawMessage, undefined, selectedConversation.id)
          : normalizeMessage(rawMessage, selectedChannelId);
      if (!message) {
        throw new Error("Le serveur n'a pas renvoyé le message créé.");
      }
      upsertMessage(message);
      if (activeTab === "Privés" && selectedConversation) {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === selectedConversation.id
              ? {
                  ...conversation,
                  lastMessage: text || (media?.mediaType === "audio" ? "Message vocal" : media?.mediaType === "video" ? "Vidéo" : "Photo"),
                  updatedAt: message.createdAt,
                }
              : conversation,
          ),
        );
      }
      setDraftMessage("");
      return true;
    } catch (error) {
      Alert.alert(
        "Envoi impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
      return false;
    } finally {
      setIsSending(false);
    }
  };

  const sendVoiceMessage = async (uri: string, durationSeconds: number) => {
    if (!API_BASE_URL) {
      Alert.alert("Envoi indisponible", "L'adresse du serveur n'est pas configurée.");
      return false;
    }
    setIsUploadingMedia(true);
    setMediaUploadProgress(0);
    try {
      const size = new File(uri).size;
      const signatureResponse = await apiFetch(`${API_BASE_URL}/v1/posts/media/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "video" }),
      });
      if (!signatureResponse.ok) {
        throw new Error(`Préparation du vocal refusée (HTTP ${signatureResponse.status}).`);
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
        typeof signaturePayload.max_duration_seconds !== "number" ||
        signaturePayload.resource_type !== "video"
      ) {
        throw new Error("La signature de téléversement audio est invalide.");
      }
      if (size > signaturePayload.max_bytes) {
        throw new Error("Le message vocal dépasse la taille maximale autorisée.");
      }
      if (exceedsVideoDurationLimit(durationSeconds, signaturePayload.max_duration_seconds)) {
        throw new Error(`Le message vocal doit durer au maximum ${signaturePayload.max_duration_seconds} secondes.`);
      }
      const upload = await uploadCloudinaryMedia(
        signaturePayload as unknown as CloudinaryUploadSignature,
        { uri, name: `vocal-${Date.now()}.m4a`, type: "audio/mp4", size },
        { onProgress: setMediaUploadProgress },
      );
      if (!upload.secureUrl) throw new Error("Le stockage n’a pas confirmé le message vocal.");
      return await sendMessage({
        publicId: upload.publicId,
        secureUrl: upload.secureUrl,
        mediaType: "audio",
      });
    } catch (error) {
      Alert.alert("Envoi du vocal impossible", error instanceof Error ? error.message : "Une erreur est survenue.");
      return false;
    } finally {
      setIsUploadingMedia(false);
      setMediaUploadProgress(null);
    }
  };

  const pickAndSendMedia = async () => {
    setIsUploadingMedia(true);
    setMediaUploadProgress(0);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error(
          "L'accès à la photothèque est nécessaire pour joindre un média.",
        );
      }
      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsEditing: false,
        quality: 1,
      });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      if (!asset?.uri) throw new Error("Le média sélectionné est indisponible.");
      const mediaType: CloudinaryMediaType = asset.type === "video" ? "video" : "image";
      let uri = asset.uri;
      let filename = asset.fileName ?? `message-${Date.now()}.${mediaType === "video" ? "mp4" : "webp"}`;
      let mimeType = asset.mimeType ?? (mediaType === "video" ? "video/mp4" : "image/webp");
      if (mediaType === "image") {
        const compressed = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1600 } }],
          { compress: 0.72, format: ImageManipulator.SaveFormat.WEBP },
        );
        if (!compressed.uri) throw new Error("La compression WebP a échoué.");
        uri = compressed.uri;
        filename = `message-${Date.now()}.webp`;
        mimeType = "image/webp";
      } else {
        setIsCompressingMedia(true);
        try {
          const compressedUri = await compressVideoForUpload(
            asset.uri,
            (progress) =>
              setMediaUploadProgress(
                Math.min(20, Math.max(0, Math.round(progress * 20))),
              ),
          );
          if (!compressedUri) throw new Error("La compression vidéo a échoué.");
          uri = compressedUri;
          filename = `message-${Date.now()}.mp4`;
          mimeType = "video/mp4";
        } finally {
          setIsCompressingMedia(false);
        }
        setMediaUploadProgress(20);
      }
      const size = new File(uri).size;
      const signatureResponse = await apiFetch(`${API_BASE_URL}/v1/posts/media/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: mediaType }),
      });
      if (!signatureResponse.ok) {
        throw new Error(`Préparation du téléversement refusée (HTTP ${signatureResponse.status}).`);
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
        signaturePayload.resource_type !== mediaType
      ) {
        throw new Error("La signature de téléversement est invalide.");
      }
      if (size > signaturePayload.max_bytes) {
        throw new Error(
          mediaType === "video"
            ? `La vidéo compressée pèse ${(size / (1024 * 1024)).toFixed(1)} Mo et dépasse la limite serveur de ${(signaturePayload.max_bytes / (1024 * 1024)).toFixed(1)} Mo. Elle ne peut pas être envoyée.`
            : "Le média dépasse la taille maximale autorisée.",
        );
      }
      if (
        mediaType === "video" &&
        typeof signaturePayload.max_duration_seconds === "number" &&
        typeof asset.duration === "number" &&
        exceedsVideoDurationLimit(
          asset.duration / 1000,
          signaturePayload.max_duration_seconds,
        )
      ) {
        throw new Error(`La vidéo doit durer au maximum ${signaturePayload.max_duration_seconds} secondes.`);
      }
      const upload = await uploadCloudinaryMedia(
        signaturePayload as unknown as CloudinaryUploadSignature,
        { uri, name: filename, type: mimeType, size },
        {
          onProgress: (progress) =>
            setMediaUploadProgress(
              mediaType === "video"
                ? 20 + Math.round((progress / 90) * 80)
                : progress,
            ),
        },
      );
      if (!upload.secureUrl) throw new Error("Cloudinary n’a pas confirmé l’adresse du média.");
      setMediaUploadProgress(100);
      await sendMessage({
        publicId: upload.publicId,
        secureUrl: upload.secureUrl,
        mediaType,
      });
    } catch (error) {
      Alert.alert(
        "Impossible de joindre le média",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsUploadingMedia(false);
      setMediaUploadProgress(null);
    }
  };

  const submitReport = async () => {
    if (!selectedReport) return;
    if (!API_BASE_URL) {
      Alert.alert(
        "Signalement indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    if (!REPORT_REASONS.includes(reportReason.trim())) {
      Alert.alert("Motif requis", "Précisez le motif du signalement.");
      return;
    }
    setIsSubmittingReport(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "message",
          target_id: selectedReport.id,
          reason: reportReason.trim(),
        }),
      });
      if (!response.ok) {
        throw new Error(`Le signalement a échoué (HTTP ${response.status}).`);
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.reported !== true) {
        throw new Error("Le serveur n’a pas confirmé le signalement.");
      }
      setSelectedReport(null);
      setReportReason("");
      Alert.alert(
        "Signalement transmis",
        "Statut : en attente de vérification. Le message n’a pas été supprimé.",
      );
    } catch (error) {
      Alert.alert(
        "Signalement impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const ensureLiveKitRoom = async (): Promise<Room> => {
    if (liveKitRoomRef.current) return liveKitRoomRef.current;
    if (liveKitConnectPromiseRef.current) return liveKitConnectPromiseRef.current;
    if (!API_BASE_URL) {
      throw new Error("L'adresse du serveur n'est pas configurée.");
    }

    const connectRoom = async () => {
      setIsConnectingToLiveKit(true);
      setPttError(null);
      const controller = new AbortController();
      liveKitTokenControllerRef.current = controller;
      try {
        const response = await apiFetch(`${API_BASE_URL}/v1/livekit/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: selectedChannel.kind === "EMERGENCY" ? "emergency" : selectedChannelId,
          }),
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new Error(
            isRecord(payload) && typeof payload.reason === "string"
              ? payload.reason
              : isRecord(payload) && typeof payload.error === "string"
                ? payload.error
                : `Impossible d'obtenir un jeton LiveKit (HTTP ${response.status}, code LIVEKIT_TOKEN_HTTP_${response.status}).`,
          );
        }
        const token =
          isRecord(payload) && typeof payload.token === "string"
            ? payload.token
            : "";
        const serverUrl =
          isRecord(payload) && typeof payload.url === "string"
            ? payload.url
            : LIVEKIT_URL;
        if (!token || !serverUrl) {
          throw new Error(
            "La réponse doit contenir un jeton et une URL LiveKit.",
          );
        }
        await AudioSession.startAudioSession();
        if (controller.signal.aborted) {
          await AudioSession.stopAudioSession();
          throw new Error("Connexion au talkie-walkie annulée.");
        }
        const room = new Room();
        await room.connect(serverUrl, token);
        if (controller.signal.aborted) {
          await room.disconnect();
          await AudioSession.stopAudioSession();
          throw new Error("Connexion au talkie-walkie annulée.");
        }
        await room.localParticipant.setMicrophoneEnabled(false);
        liveKitRoomRef.current = room;
        setLiveKitConnected(true);
        return room;
      } finally {
        if (liveKitTokenControllerRef.current === controller) {
          liveKitTokenControllerRef.current = null;
        }
        setIsConnectingToLiveKit(false);
      }
    };

    const pending = connectRoom();
    liveKitConnectPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      liveKitConnectPromiseRef.current = null;
    }
  };

  const openPtt = () => {
    if (selectedChannel.kind !== "EMERGENCY") return;
    setIsPttVisible(true);
    void ensureLiveKitRoom().catch((error: unknown) => {
      setPttError(
        error instanceof Error
          ? error.message
          : "Connexion LiveKit échouée (code LIVEKIT_CONNECTION_FAILED).",
      );
    });
  };

  const startTalking = async () => {
    pttPressedRef.current = true;
    try {
      const room = await ensureLiveKitRoom();
      if (!pttPressedRef.current) return;
      await room.localParticipant.setMicrophoneEnabled(true);
      if (pttPressedRef.current) setIsTalking(true);
    } catch (error) {
      pttPressedRef.current = false;
      setPttError(
        error instanceof Error
          ? error.message
          : "Connexion LiveKit échouée (code LIVEKIT_CONNECTION_FAILED).",
      );
    }
  };

  const stopTalking = () => {
    pttPressedRef.current = false;
    setIsTalking(false);
    const room = liveKitRoomRef.current;
    if (room) {
      void room.localParticipant.setMicrophoneEnabled(false).catch((error) => {
        setPttError(
          error instanceof Error
            ? error.message
            : "Impossible de couper le microphone.",
        );
      });
    }
  };

  const closePtt = () => {
    stopTalking();
    setIsPttVisible(false);
    liveKitTokenControllerRef.current?.abort();
    const room = liveKitRoomRef.current;
    liveKitRoomRef.current = null;
    setLiveKitConnected(false);
    if (room) void room.disconnect();
    void AudioSession.stopAudioSession().catch((error: unknown) => {
      setPttError(
        error instanceof Error
          ? error.message
          : "Impossible de fermer la session audio.",
      );
    });
  };

  const formatMessageTime = (date: string) => {
    const timestamp = new Date(date);
    return Number.isNaN(timestamp.getTime())
      ? ""
      : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const ChannelIcon = selectedChannel.icon;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <MessageSquare color={colors.primary} size={22} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>{t("tabMessages")}</Text>
      </View>

      <View style={styles.tabs}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === "Privés" }}
          onPress={() => {
            setActiveTab("Privés");
            setSelectedConversation(null);
          }}
          style={[styles.tab, activeTab === "Privés" && styles.tabSelected]}
        >
          <MessageSquare
            color={activeTab === "Privés" ? colors.primary : colors.secondaryText}
            size={17}
          />
          <Text
            style={[
              styles.tabText,
              activeTab === "Privés" && styles.tabTextSelected,
            ]}
          >
            {t("messagesPrivate")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === "Canaux" }}
          onPress={() => {
            setActiveTab("Canaux");
            setSelectedConversation(null);
          }}
          style={[styles.tab, activeTab === "Canaux" && styles.tabSelected]}
        >
          <Radio
            color={activeTab === "Canaux" ? colors.primary : colors.secondaryText}
            size={17}
          />
          <Text
            style={[
              styles.tabText,
              activeTab === "Canaux" && styles.tabTextSelected,
            ]}
          >
            {t("messagesChannels")}
          </Text>
        </Pressable>
      </View>

      {activeTab === "Canaux" ? (
        <>
          <View style={styles.proximityBanner}>
            <MapPin color="#2563eb" size={17} />
            <Text style={styles.proximityText}>
              Canaux et informations selon votre position et vos abonnements
            </Text>
          </View>
          <View style={styles.scopeList}>
            {GEOGRAPHIC_SCOPES.map((scope) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: geographicScope === scope.id }}
                key={scope.id}
                onPress={() => {
                  setGeographicScope(scope.id);
                  setSearchedChannels([]);
                }}
                style={[
                  styles.scopeButton,
                  geographicScope === scope.id && styles.scopeButtonSelected,
                ]}
              >
                <Text
                  style={[
                    styles.scopeButtonText,
                    geographicScope === scope.id && styles.scopeButtonTextSelected,
                  ]}
                >
                  {scope.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.categoryList}>
            {[
              { id: "COMMUNITY" as const, label: "Communautaire", icon: MessageSquare, color: "#16856b" },
              { id: "OFFICIAL" as const, label: "Institutionnel officiel", icon: Building2, color: "#a16207" },
              { id: "SOS" as const, label: "Alertes SOS", icon: ShieldAlert, color: "#dc2626" },
              { id: "EMERGENCY_CHAT" as const, label: "Talkie-walkie", icon: Radio, color: "#2563eb" },
            ].map((category) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{
                  selected: informationCategory === category.id,
                }}
                key={category.id}
                onPress={() => {
                  setInformationCategory(category.id);
                  if (category.id === "EMERGENCY_CHAT") {
                    setGeographicScope("country");
                  } else {
                    const kind =
                      category.id === "COMMUNITY"
                        ? "COMMUNITY"
                        : category.id === "OFFICIAL"
                          ? "ANNOUNCEMENTS"
                          : null;
                    const channel = kind
                      ? channels.find((item) => item.kind === kind)
                      : null;
                    if (channel) setSelectedChannelId(channel.id);
                  }
                }}
                style={[
                  styles.categoryButton,
                  informationCategory === category.id &&
                    styles.categoryButtonSelected,
                ]}
              >
                <category.icon color={category.color} size={15} />
                <Text
                  style={[
                    styles.categoryButtonText,
                    informationCategory === category.id &&
                      styles.categoryButtonTextSelected,
                  ]}
                >
                  {category.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {informationCategory !== "SOS" && (
            <>
              {channelsError && (
                <Text accessibilityRole="alert" style={styles.errorText}>
                  {channelsError}
                </Text>
              )}
              {visibleChannels.length > 0 ? (
                <View style={styles.channelList}>
                  {visibleChannels.map((channel) => {
                    const Icon = channel.icon;
                    const isSelected = selectedChannelId === channel.id;
                    return (
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected: isSelected }}
                        key={channel.id}
                        onPress={() => setSelectedChannelId(channel.id)}
                        style={[
                          styles.channelButton,
                          isSelected && styles.channelButtonSelected,
                        ]}
                      >
                        <Icon
                          color={isSelected ? colors.primary : colors.secondaryText}
                          size={17}
                        />
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.channelButtonText,
                            isSelected && styles.channelButtonTextSelected,
                          ]}
                        >
                          {channel.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.emptyText}>
                  Aucun canal configuré dans cette portée. Recherchez une autre zone ci-dessous.
                </Text>
              )}

              {selectedChannel.kind !== "EMERGENCY" && (
                <View style={styles.channelSearch}>
                  <VoiceTextInput
                    accessibilityLabel="Rechercher une commune, une région ou un canal"
                    onChangeText={setChannelSearch}
                    placeholder="Rechercher une commune ou région"
                    placeholderTextColor="#94a3b8"
                    style={styles.channelSearchInput}
                    value={channelSearch}
                  />
                  <VoiceTextInput
                    accessibilityLabel="Code pays de la zone à suivre"
                    autoCapitalize="characters"
                    maxLength={3}
                    onChangeText={setTargetCountryCode}
                    placeholder="Pays"
                    placeholderTextColor="#94a3b8"
                    style={styles.countryCodeInput}
                    value={
                      targetCountryCode ||
                      (typeof user?.country_code === "string"
                        ? user.country_code
                        : "")
                    }
                  />
                  <Pressable
                    accessibilityLabel="Rechercher des canaux géographiques"
                    accessibilityRole="button"
                    disabled={isSearchingChannels}
                    onPress={() => void searchGeographicChannels()}
                    style={styles.searchButton}
                  >
                    {isSearchingChannels ? (
                      <ActivityIndicator color="#ffffff" size="small" />
                    ) : (
                      <MapPin color="#ffffff" size={17} />
                    )}
                  </Pressable>
                </View>
              )}
              {searchedChannels.map((channel) => (
                <View key={channel.id} style={styles.followResult}>
                  <Text numberOfLines={1} style={styles.followResultName}>
                    {channel.label}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void toggleChannelFollow(channel)}
                    style={styles.followButton}
                  >
                    <Text style={styles.followButtonText}>
                      {channel.isFollowing ? "Suivi" : "Suivre"}
                    </Text>
                  </Pressable>
                </View>
              ))}

              {hasSelectedChannel && <View style={styles.channelHeading}>
                <View
                  style={[
                    styles.channelIcon,
                    { backgroundColor: selectedChannel.background },
                  ]}
                >
                  <ChannelIcon color={selectedChannel.color} size={20} />
                </View>
                <View style={styles.channelCopy}>
                  <Text style={[styles.channelName, { color: colors.text }]}>
                    {selectedChannel.label}
                  </Text>
                  <Text style={styles.channelDescription}>
                    {selectedChannel.description}
                  </Text>
                </View>
                {informationCategory === "OFFICIAL" ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setIsInstitutionFormVisible(true)}
                    style={styles.institutionRequestButton}
                  >
                    <Building2 color="#ffffff" size={15} />
                    <Text style={styles.liveButtonText}>Vérifier</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void toggleChannelFollow(selectedChannel)}
                    style={styles.followButton}
                  >
                    <Text style={styles.followButtonText}>
                      {selectedChannel.isFollowing ? "Suivi" : "Suivre"}
                    </Text>
                  </Pressable>
                )}
                {selectedChannel.kind === "EMERGENCY" && (
                  <Pressable
                    accessibilityLabel="Rejoindre le talkie-walkie URGENCES"
                    accessibilityRole="button"
                    onPress={openPtt}
                    style={styles.liveButton}
                  >
                    <Radio color="#ffffff" size={15} />
                    <Text style={styles.liveButtonText}>LIVE</Text>
                  </Pressable>
                )}
              </View>}
              {hasSelectedChannel && informationCategory === "OFFICIAL" && (
                <View style={styles.officialPicker}>
                  <BadgeCheck color="#a16207" size={17} />
                  {publishableInstitutions.length ? (
                    publishableInstitutions.map((institution) => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{
                          selected: selectedInstitutionId === institution.id,
                        }}
                        key={institution.id}
                        onPress={() => setSelectedInstitutionId(institution.id)}
                        style={[
                          styles.institutionChip,
                          selectedInstitutionId === institution.id &&
                            styles.institutionChipSelected,
                        ]}
                      >
                        <Text style={styles.institutionChipText}>
                          {institution.name}
                        </Text>
                      </Pressable>
                    ))
                  ) : (
                    <Text style={styles.officialInfoText}>
                      Aucune institution vérifiée n'est autorisée sur ce canal.
                    </Text>
                  )}
                </View>
              )}
            </>
          )}
        {informationCategory === "SOS" && (
          <View style={styles.sosPanel}>
            <View style={styles.sosPanelHeading}>
              <View style={styles.sosTitleGroup}>
                <ShieldAlert color="#dc2626" size={19} />
                <Text style={styles.sosPanelTitle}>Alertes SOS actives</Text>
              </View>
              <Pressable
                accessibilityLabel="Actualiser les alertes SOS"
                accessibilityRole="button"
                disabled={isLoadingSosAlerts}
                onPress={() => void loadSosAlerts()}
                style={styles.refreshButton}
              >
                {isLoadingSosAlerts ? (
                  <ActivityIndicator color="#2563eb" size="small" />
                ) : (
                  <RefreshCw color="#2563eb" size={17} />
                )}
              </Pressable>
            </View>
            {sosAlertsError && (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {sosAlertsError}
              </Text>
            )}
            {isLoadingSosAlerts && sosAlerts.length === 0 ? (
              <ActivityIndicator color="#2563eb" style={styles.loading} />
            ) : (
              <ScrollView
                contentContainerStyle={styles.sosAlertList}
                showsVerticalScrollIndicator={false}
              >
                {sosAlerts.map((alert) => (
                  <View key={alert.id} style={styles.sosAlertCard}>
                    <View style={styles.sosAlertHeader}>
                      <Siren color="#dc2626" size={18} />
                      <View style={styles.sosAlertCopy}>
                        <Text style={styles.sosAlertType}>
                          {alert.emergency_type === "MEDICAL"
                            ? "Urgence médicale"
                            : alert.emergency_type === "SECURITY"
                              ? "Sécurité"
                              : alert.emergency_type === "FIRE"
                                ? "Incendie"
                                : "Autre urgence"}
                        </Text>
                        <Text style={styles.sosAlertMeta}>
                          {typeof alert.distance_m === "number"
                            ? `${(alert.distance_m / 1000).toFixed(1)} km · `
                            : ""}
                          {formatMessageTime(alert.created_at)}
                          {alert.is_mine ? " · Votre alerte" : ""}
                        </Text>
                      </View>
                      <Text style={styles.activeAlertBadge}>ACTIVE</Text>
                    </View>
                    <View style={styles.sosActions}>
                      {alert.is_mine ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={isSubmittingSosAction}
                          onPress={() => void submitSosAction(alert, "resolve")}
                          style={styles.resolveSosButton}
                        >
                          <Text style={styles.resolveSosText}>
                            Clôturer l'alerte
                          </Text>
                        </Pressable>
                      ) : (
                        <>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isSubmittingSosAction}
                            onPress={() => void submitSosAction(alert, "assist")}
                            style={styles.assistSosButton}
                          >
                            <HeartHandshake color="#ffffff" size={15} />
                            <Text style={styles.sosActionText}>Je peux aider</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isSubmittingSosAction}
                            onPress={() =>
                              void submitSosAction(alert, "report-fake")
                            }
                            style={styles.reportSosButton}
                          >
                            <Text style={styles.reportSosText}>
                              Signaler une fausse alerte
                            </Text>
                          </Pressable>
                        </>
                      )}
                    </View>
                  </View>
                ))}
                {sosAlerts.length === 0 && !sosAlertsError && (
                  <Text style={styles.emptyText}>
                    Aucune alerte SOS active dans cette portée.
                  </Text>
                )}
              </ScrollView>
            )}
          </View>
        )}
        </>
      ) : selectedConversation ? (
        <View style={styles.privateHeader}>
          <Pressable
            accessibilityLabel="Retour à la liste des conversations"
            accessibilityRole="button"
            onPress={() => setSelectedConversation(null)}
            style={styles.backButton}
          >
            <X color="#475569" size={20} />
          </Pressable>
          <ProfileAvatar
            name={selectedConversation.participantName}
            photoUrl={selectedConversation.participantPhotoUrl}
            size={48}
            isAlly={selectedConversation.participantIsAlly}
            isProVerified={
              selectedConversation.participantBadge === "Commerçant Certifié"
            }
          />
          <View style={styles.channelCopy}>
            <Text style={styles.channelName}>
              {selectedConversation.participantName}
            </Text>
            <Text style={styles.channelDescription}>
              {selectedConversation.participantType === "seller"
                ? "Vendeur"
                : "Voisin"}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.privateListContainer}>
          <Text style={styles.privateListTitle}>Conversations privées</Text>
          <VoiceTextInput
            accessibilityLabel="Rechercher un contact ou une conversation"
            onChangeText={setConversationSearch}
            placeholder="Rechercher un contact..."
            placeholderTextColor="#94a3b8"
            style={styles.searchInput}
            value={conversationSearch}
          />
          {conversationsError && (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {conversationsError}
            </Text>
          )}
          {isLoadingConversations ? (
            <ActivityIndicator color="#2563eb" style={styles.loading} />
          ) : (
            <ScrollView
              contentContainerStyle={styles.conversationList}
              showsVerticalScrollIndicator={false}
            >
              {filteredConversations.map((conversation) => (
                <Pressable
                  accessibilityRole="button"
                  key={conversation.id}
                  onPress={() => {
                    setDraftMessage("");
                    setSelectedConversation(conversation);
                  }}
                  style={[styles.conversationCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <ProfileAvatar
                    name={conversation.participantName}
                    photoUrl={conversation.participantPhotoUrl}
                    size={48}
                    isAlly={conversation.participantIsAlly}
                    isProVerified={
                      conversation.participantBadge === "Commerçant Certifié"
                    }
                  />
                  <View style={styles.conversationCopy}>
                    <View style={styles.conversationTopLine}>
                      <Text style={[styles.conversationName, { color: colors.text }]}>
                        {conversation.participantName}
                      </Text>
                      <Text style={[styles.timestamp, { color: colors.secondaryText }]}>
                        {formatMessageTime(conversation.updatedAt)}
                      </Text>
                    </View>
                    <View style={styles.conversationBottomLine}>
                      <Text numberOfLines={1} style={[styles.lastMessage, { color: colors.secondaryText }]}>
                        {conversation.lastMessage ||
                          (conversation.participantType === "seller"
                            ? "Discussion avec le vendeur"
                            : "Discussion avec votre voisin")}
                      </Text>
                      <Text style={[styles.participantType, { color: colors.secondaryText }]}>
                        {conversation.participantType === "seller"
                          ? "VENDEUR"
                          : "VOISIN"}
                      </Text>
                      {conversation.unreadCount > 0 && (
                        <View style={styles.unreadBadge}>
                          <Text style={styles.unreadText}>
                            {conversation.unreadCount}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </Pressable>
              ))}
              {!conversationsError && filteredConversations.length === 0 && (
                <Text style={styles.emptyText}>
                  {conversationSearch
                    ? "Aucun contact ou message ne correspond à cette recherche."
                    : "Aucune conversation privée pour le moment."}
                </Text>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {messagesError &&
        ((activeTab === "Canaux" &&
          informationCategory !== "SOS" &&
          hasSelectedChannel) ||
          selectedConversation) && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {messagesError}
        </Text>
      )}

      {((activeTab === "Canaux" &&
        informationCategory !== "SOS" &&
        hasSelectedChannel) ||
        selectedConversation) && <ScrollView
        contentContainerStyle={styles.messageThread}
        showsVerticalScrollIndicator={false}
      >
        {isLoadingMessages ? (
          <ActivityIndicator color="#2563eb" style={styles.loading} />
        ) : messages.length === 0 && !messagesError ? (
          <Text style={styles.emptyText}>Aucun message dans ce canal.</Text>
        ) : (
          messages.map((message) => (
            <Pressable
              accessibilityHint="Appui long pour signaler ce message"
              accessibilityRole="button"
              key={message.id}
              onLongPress={() => {
                if (
                  message.informationType === "OFFICIAL" &&
                  message.institutionId &&
                  publishableInstitutions.some(
                    (institution) =>
                      institution.id === message.institutionId,
                  )
                ) {
                  openOfficialMessage(message);
                } else {
                  setSelectedReport(message);
                  setReportReason("");
                }
              }}
              style={[
                styles.messageBubble,
                message.isOwnMessage && styles.ownMessageBubble,
              ]}
            >
              <ProfileAvatar
                name={message.senderName}
                photoUrl={
                  message.isOwnMessage &&
                  typeof user?.profile_photo_url === "string"
                    ? user.profile_photo_url
                    : message.senderPhotoUrl
                }
                size={28}
                isAlly={message.senderIsAlly}
                isProVerified={
                  message.senderBadge === "Commerçant Certifié" ||
                  (message.isOwnMessage &&
                    user?.badge === "Commerçant Certifié")
                }
              />
              {!message.isOwnMessage && (
                <Text style={styles.messageSender}>
                  {message.informationType === "OFFICIAL"
                    ? `${message.institutionName ?? "Institution vérifiée"} · Officiel`
                    : message.senderName}
                </Text>
              )}
              {message.isOwnMessage &&
                message.informationType === "OFFICIAL" && (
                  <View style={styles.officialMessageBadge}>
                    <BadgeCheck color="#a16207" size={12} />
                    <Text style={styles.officialMessageBadgeText}>
                      {message.institutionName ?? "Publication officielle"}
                    </Text>
                  </View>
                )}
              {message.imageUrl && message.mediaType === "audio" ? (
                <AudioMessagePlayer uri={message.imageUrl} />
              ) : message.imageUrl && message.mediaType === "video" ? (
                <PrivateMessageVideo uri={message.imageUrl} />
              ) : message.imageUrl ? (
                <Image
                  accessibilityLabel="Photo jointe au message"
                  source={{ uri: message.imageUrl }}
                  style={styles.messagePhoto}
                />
              ) : null}
              {message.text.length > 0 && (
                <Text
                  style={[
                    styles.messageText,
                    message.isOwnMessage && styles.ownMessageText,
                  ]}
                >
                  {message.text}
                </Text>
              )}
              <Text
                style={[
                  styles.messageTime,
                  message.isOwnMessage && styles.ownMessageTime,
                ]}
              >
                {formatMessageTime(message.createdAt)}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>}

      {((activeTab === "Canaux" &&
        informationCategory !== "SOS" &&
        hasSelectedChannel) ||
        selectedConversation) && <View style={styles.composer}>
        <Pressable
          accessibilityLabel="Joindre une photo ou une vidéo"
          accessibilityRole="button"
          disabled={isSending || isUploadingMedia}
          onPress={() => void pickAndSendMedia()}
          style={styles.attachButton}
        >
          <ImagePlus color="#475569" size={20} />
        </Pressable>
        {selectedConversation && (
          <Pressable
            accessibilityLabel="Enregistrer un message vocal"
            accessibilityRole="button"
            disabled={isSending || isUploadingMedia}
            onPress={() => setIsVoiceRecorderVisible(true)}
            style={styles.attachButton}
          >
            <Mic color="#16856b" size={19} />
          </Pressable>
        )}
        {mediaUploadProgress !== null ? (
          <Text accessibilityRole="text" style={styles.mediaUploadProgress}>
            {isCompressingMedia
              ? `Compression 720p : ${mediaUploadProgress * 5} %`
              : `Téléversement ${mediaUploadProgress} %`}
          </Text>
        ) : null}
        {activeTab === "Canaux" && selectedChannel.kind === "EMERGENCY" && (
          <Pressable
            accessibilityLabel="Ouvrir le talkie-walkie URGENCES"
            accessibilityRole="button"
            onPress={openPtt}
            style={styles.micButton}
          >
            <Radio color="#ffffff" size={17} />
            <Mic color="#ffffff" size={13} />
          </Pressable>
        )}
        <VoiceTextInput
          accessibilityLabel="Saisir un message"
          onChangeText={setDraftMessage}
          onSubmitEditing={() => void sendMessage()}
          placeholder="Écrire un message…"
          placeholderTextColor="#94a3b8"
          returnKeyType="send"
          style={styles.composerInput}
          value={draftMessage}
        />
        <Pressable
          accessibilityLabel="Envoyer le message"
          accessibilityRole="button"
          disabled={isSending || isUploadingMedia}
          onPress={() => void sendMessage()}
          style={[styles.sendButton, (isSending || isUploadingMedia) && styles.disabledButton]}
        >
          <Send color="#ffffff" size={18} />
        </Pressable>
      </View>}

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedReport(null)}
        transparent
        visible={selectedReport !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <View style={styles.reportIcon}>
                <AlertTriangle color="#b91c1c" size={20} />
              </View>
              <Text style={styles.dialogTitle}>Signaler le message</Text>
              <Pressable
                accessibilityLabel="Fermer"
                accessibilityRole="button"
                onPress={() => setSelectedReport(null)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>
            <Text style={styles.dialogDescription}>
              Indiquez pourquoi ce message doit être examiné par la modération.
            </Text>
            <ScrollView style={styles.reportReasons}>
              {REPORT_REASONS.map((reason) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: reportReason === reason }}
                  key={reason}
                  onPress={() => setReportReason(reason)}
                  style={[
                    styles.reportReasonButton,
                    reportReason === reason && styles.reportReasonButtonSelected,
                  ]}
                >
                  <Text style={styles.reportReasonText}>{reason}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              disabled={isSubmittingReport || !reportReason}
              onPress={() => void submitReport()}
              style={[
                styles.reportButton,
                isSubmittingReport && styles.disabledButton,
              ]}
            >
              {isSubmittingReport ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.reportButtonText}>Envoyer le signalement</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedOfficialMessage(null)}
        transparent
        visible={selectedOfficialMessage !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <View style={styles.reportIcon}>
                <BadgeCheck color="#a16207" size={20} />
              </View>
              <Text style={styles.dialogTitle}>Annonce officielle</Text>
              <Pressable
                accessibilityLabel="Fermer l'annonce officielle"
                accessibilityRole="button"
                onPress={() => setSelectedOfficialMessage(null)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>
            <Text style={styles.dialogDescription}>
              Les corrections et retraits sont conservés dans l'historique public.
            </Text>
            <VoiceTextInput
              accessibilityLabel="Texte corrigé de l'annonce"
              multiline
              onChangeText={setOfficialEditDraft}
              placeholder="Texte officiel"
              placeholderTextColor="#94a3b8"
              style={styles.officialEditInput}
              value={officialEditDraft}
            />
            <View style={styles.officialActions}>
              <Pressable
                accessibilityRole="button"
                disabled={isUpdatingOfficialMessage}
                onPress={() => void correctSelectedOfficialMessage()}
                style={styles.correctOfficialButton}
              >
                <Text style={styles.reportButtonText}>Enregistrer la correction</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isUpdatingOfficialMessage}
                onPress={withdrawSelectedOfficialMessage}
                style={styles.withdrawOfficialButton}
              >
                <Text style={styles.withdrawOfficialText}>Retirer</Text>
              </Pressable>
            </View>
            <Text style={styles.officialHistoryTitle}>Historique des publications</Text>
            {isLoadingOfficialHistory ? (
              <ActivityIndicator color="#2563eb" style={styles.loading} />
            ) : (
              <ScrollView style={styles.officialHistoryList}>
                {officialHistory.map((entry, index) => (
                  <View
                    key={`${String(entry.created_at ?? index)}-${index}`}
                    style={styles.officialHistoryEntry}
                  >
                    <Text style={styles.officialHistoryAction}>
                      {entry.action === "PUBLISHED"
                        ? "Publication"
                        : entry.action === "EDITED"
                          ? "Correction"
                          : "Retrait"}
                      {typeof entry.actor_name === "string"
                        ? ` · ${entry.actor_name}`
                        : ""}
                    </Text>
                    <Text style={styles.officialHistoryDate}>
                      {typeof entry.created_at === "string"
                        ? formatMessageTime(entry.created_at)
                        : ""}
                    </Text>
                    {typeof entry.previous_body === "string" && (
                      <Text style={styles.officialHistoryBody}>
                        Avant : {entry.previous_body}
                      </Text>
                    )}
                    {typeof entry.new_body === "string" && (
                      <Text style={styles.officialHistoryBody}>
                        Après : {entry.new_body}
                      </Text>
                    )}
                  </View>
                ))}
                {officialHistory.length === 0 && (
                  <Text style={styles.emptyText}>
                    Aucun historique disponible.
                  </Text>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setIsInstitutionFormVisible(false)}
        transparent
        visible={isInstitutionFormVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <View style={styles.institutionModalIcon}>
                <Building2 color="#1d4ed8" size={20} />
              </View>
              <Text style={styles.dialogTitle}>Vérifier une institution</Text>
              <Pressable
                accessibilityLabel="Fermer la demande institutionnelle"
                accessibilityRole="button"
                onPress={() => setIsInstitutionFormVisible(false)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>
            <Text style={styles.dialogDescription}>
              Un administrateur vérifiera le justificatif avant d'accorder un badge et les droits de publication. Zone sélectionnée : {selectedChannel.label}.
            </Text>
            <VoiceTextInput
              accessibilityLabel="Nom officiel de l'institution"
              onChangeText={setInstitutionName}
              placeholder="Nom officiel"
              placeholderTextColor="#94a3b8"
              style={styles.institutionInput}
              value={institutionName}
            />
            <View style={styles.institutionTypes}>
              {[
                ["MUNICIPALITY", "Mairie"],
                ["PREFECTURE", "Préfecture"],
                ["MINISTRY", "Ministère"],
                ["ADMINISTRATION", "Administration"],
                ["PUBLIC_SERVICE", "Service public"],
              ].map(([value, label]) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: institutionType === value }}
                  key={value}
                  onPress={() => setInstitutionType(value)}
                  style={[
                    styles.institutionTypeButton,
                    institutionType === value &&
                      styles.institutionTypeButtonSelected,
                  ]}
                >
                  <Text style={styles.institutionTypeText}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <VoiceTextInput
              accessibilityLabel="Identifiant légal de l'institution"
              onChangeText={setInstitutionLegalId}
              placeholder="Identifiant légal"
              placeholderTextColor="#94a3b8"
              style={styles.institutionInput}
              value={institutionLegalId}
            />
            <VoiceTextInput
              accessibilityLabel="Lien HTTPS vers un justificatif officiel"
              autoCapitalize="none"
              keyboardType="url"
              onChangeText={setInstitutionProofUrl}
              placeholder="Lien HTTPS vers un justificatif officiel"
              placeholderTextColor="#94a3b8"
              style={styles.institutionInput}
              value={institutionProofUrl}
            />
            <Pressable
              accessibilityRole="button"
              disabled={
                isSubmittingInstitution ||
                !institutionName.trim() ||
                !institutionLegalId.trim() ||
                !institutionProofUrl.trim()
              }
              onPress={() => void submitInstitutionVerification()}
              style={[
                styles.submitInstitutionButton,
                isSubmittingInstitution && styles.disabledButton,
              ]}
            >
              {isSubmittingInstitution ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.reportButtonText}>
                  Envoyer pour vérification
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <VoiceRecorderModal
        visible={isVoiceRecorderVisible}
        uploadProgress={mediaUploadProgress}
        onClose={() => setIsVoiceRecorderVisible(false)}
        onSend={sendVoiceMessage}
      />

      <Modal
        animationType="fade"
        onRequestClose={closePtt}
        transparent
        visible={isPttVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <View style={styles.reportIcon}>
                <Radio color="#dc2626" size={20} />
              </View>
              <Text style={styles.dialogTitle}>Talkie-walkie URGENCES</Text>
              <Pressable
                accessibilityLabel="Fermer le talkie-walkie"
                accessibilityRole="button"
                onPress={closePtt}
                style={styles.closeButton}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>
            <View style={styles.connectionStatus}>
              <View
                style={[
                  styles.statusDot,
                  liveKitConnected && styles.statusDotConnected,
                ]}
              />
              <Text style={styles.connectionText}>
                {isConnectingToLiveKit
                  ? "Connexion à la room audio…"
                  : liveKitConnected
                    ? "Connecté au canal audio"
                    : "Déconnecté"}
              </Text>
            </View>
            {pttError && (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {pttError}
              </Text>
            )}
            <Pressable
              accessibilityLabel={
                isTalking
                  ? "Relâcher pour couper le microphone"
                  : "Maintenir pour parler"
              }
              accessibilityRole="button"
              disabled={!liveKitConnected}
              onPressIn={() => void startTalking()}
              onPressOut={stopTalking}
              style={[
                styles.pttButton,
                isTalking && styles.pttButtonActive,
                !liveKitConnected && styles.disabledButton,
              ]}
            >
              <Mic color="#ffffff" size={30} />
              <Text style={styles.pttButtonText}>
                {isTalking ? "PARLEZ" : "MAINTENIR"}
              </Text>
            </Pressable>
            <Text style={styles.pttHint}>
              Maintenez le bouton pour transmettre, relâchez pour couper le micro.
            </Text>
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
    paddingTop: 54,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 11,
    paddingBottom: 17,
    paddingHorizontal: 20,
  },
  headerIcon: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderRadius: 12,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  title: {
    color: "#172b4d",
    fontSize: 26,
    fontWeight: "700",
  },
  tabs: {
    backgroundColor: "#e8edf5",
    borderRadius: 12,
    flexDirection: "row",
    marginHorizontal: 20,
    padding: 4,
  },
  tab: {
    alignItems: "center",
    borderRadius: 9,
    flex: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 40,
  },
  tabSelected: {
    backgroundColor: "#ffffff",
    elevation: 1,
  },
  tabText: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
  },
  tabTextSelected: {
    color: "#2563eb",
  },
  proximityBanner: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderColor: "#dbeafe",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 20,
    marginTop: 13,
    padding: 12,
  },
  proximityText: {
    color: "#1e3a8a",
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
  },
  scopeList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  scopeButton: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ee",
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 12,
    width: "31%",
  },
  scopeButtonSelected: {
    backgroundColor: "#dbeafe",
    borderColor: "#93c5fd",
  },
  scopeButtonText: {
    color: "#475569",
    fontSize: 10,
    fontWeight: "700",
  },
  scopeButtonTextSelected: {
    color: "#1d4ed8",
  },
  categoryList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  categoryButton: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 9,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 11,
    width: "48%",
  },
  categoryButtonSelected: {
    backgroundColor: "#eff6ff",
    borderColor: "#93c5fd",
  },
  categoryButtonText: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "700",
  },
  categoryButtonTextSelected: {
    color: "#172b4d",
  },
  channelList: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  channelButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 42,
    maxWidth: 220,
    minWidth: 125,
    paddingHorizontal: 10,
    flexGrow: 1,
  },
  channelButtonSelected: {
    backgroundColor: "#eff6ff",
    borderColor: "#93c5fd",
  },
  channelButtonText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "800",
    flexShrink: 1,
  },
  channelButtonTextSelected: {
    color: "#1d4ed8",
  },
  channelHeading: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 13,
    flexDirection: "row",
    gap: 11,
    marginHorizontal: 20,
    marginTop: 11,
    padding: 11,
  },
  channelSearch: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginHorizontal: 20,
    marginTop: 8,
  },
  channelSearchInput: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 9,
    borderWidth: 1,
    color: "#172b4d",
    flex: 1,
    fontSize: 11,
    minHeight: 38,
    minWidth: 0,
    paddingHorizontal: 9,
  },
  countryCodeInput: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 9,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 11,
    minHeight: 38,
    paddingHorizontal: 9,
    textAlign: "center",
    width: 58,
  },
  searchButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 9,
    height: 38,
    justifyContent: "center",
    width: 40,
  },
  followResult: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    marginHorizontal: 20,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  followResultName: {
    color: "#334155",
    flex: 1,
    fontSize: 11,
    fontWeight: "600",
  },
  followButton: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 30,
    paddingHorizontal: 10,
  },
  followButtonText: {
    color: "#1d4ed8",
    fontSize: 10,
    fontWeight: "800",
  },
  institutionRequestButton: {
    alignItems: "center",
    backgroundColor: "#a16207",
    borderRadius: 9,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  officialPicker: {
    alignItems: "center",
    backgroundColor: "#fefce8",
    borderColor: "#fde68a",
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    marginHorizontal: 20,
    marginTop: 8,
    padding: 9,
  },
  institutionChip: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  institutionChipSelected: {
    backgroundColor: "#fef3c7",
    borderColor: "#d97706",
  },
  institutionChipText: {
    color: "#713f12",
    fontSize: 10,
    fontWeight: "700",
  },
  officialInfoText: {
    color: "#854d0e",
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  sosPanel: {
    flex: 1,
    paddingTop: 12,
  },
  sosPanelHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  sosTitleGroup: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  sosPanelTitle: {
    color: "#991b1b",
    fontSize: 14,
    fontWeight: "800",
  },
  refreshButton: {
    alignItems: "center",
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  sosAlertList: {
    gap: 9,
    paddingBottom: 120,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  sosAlertCard: {
    backgroundColor: "#ffffff",
    borderColor: "#fecaca",
    borderRadius: 13,
    borderWidth: 1,
    padding: 11,
  },
  sosAlertHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
  },
  sosAlertCopy: {
    flex: 1,
  },
  sosAlertType: {
    color: "#7f1d1d",
    fontSize: 12,
    fontWeight: "800",
  },
  sosAlertMeta: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 3,
  },
  activeAlertBadge: {
    backgroundColor: "#fee2e2",
    borderRadius: 6,
    color: "#b91c1c",
    fontSize: 8,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  sosActions: {
    flexDirection: "row",
    gap: 7,
    marginTop: 10,
  },
  assistSosButton: {
    alignItems: "center",
    backgroundColor: "#b91c1c",
    borderRadius: 8,
    flex: 1,
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    minHeight: 34,
  },
  sosActionText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
  reportSosButton: {
    alignItems: "center",
    borderColor: "#fecaca",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 6,
  },
  reportSosText: {
    color: "#991b1b",
    fontSize: 9,
    fontWeight: "700",
    textAlign: "center",
  },
  resolveSosButton: {
    alignItems: "center",
    backgroundColor: "#166534",
    borderRadius: 8,
    flex: 1,
    justifyContent: "center",
    minHeight: 34,
  },
  resolveSosText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
  privateListContainer: {
    flex: 1,
    paddingTop: 18,
  },
  privateListTitle: {
    color: "#172b4d",
    fontSize: 16,
    fontWeight: "800",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  searchInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 11,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 14,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  conversationList: {
    paddingBottom: 112,
    paddingHorizontal: 20,
    paddingTop: 5,
  },
  conversationCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 14,
    flexDirection: "row",
    marginBottom: 9,
    padding: 12,
  },
  conversationCopy: {
    flex: 1,
  },
  conversationTopLine: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  conversationName: {
    color: "#172b4d",
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
  },
  timestamp: {
    color: "#94a3b8",
    fontSize: 10,
    marginLeft: 8,
  },
  conversationBottomLine: {
    alignItems: "center",
    flexDirection: "row",
    marginTop: 5,
  },
  lastMessage: {
    color: "#64748b",
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    paddingRight: 8,
  },
  participantType: {
    backgroundColor: "#f1f5f9",
    borderRadius: 7,
    color: "#475569",
    fontSize: 8,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  unreadBadge: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 4,
  },
  unreadText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
  },
  participantAvatar: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderRadius: 25,
    height: 48,
    justifyContent: "center",
    marginRight: 12,
    width: 48,
  },
  sellerAvatar: {
    backgroundColor: "#fef3c7",
  },
  participantInitial: {
    color: "#1e3a8a",
    fontSize: 14,
    fontWeight: "800",
  },
  privateHeader: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 13,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 20,
    marginTop: 12,
    padding: 10,
  },
  backButton: {
    alignItems: "center",
    height: 38,
    justifyContent: "center",
    width: 32,
  },
  channelIcon: {
    alignItems: "center",
    borderRadius: 11,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  channelCopy: {
    flex: 1,
  },
  channelName: {
    color: "#172b4d",
    fontSize: 13,
    fontWeight: "800",
  },
  channelDescription: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 3,
  },
  liveButton: {
    alignItems: "center",
    backgroundColor: "#dc2626",
    borderRadius: 9,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  liveButtonText: {
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "900",
  },
  errorText: {
    color: "#b91c1c",
    fontSize: 11,
    lineHeight: 16,
    marginHorizontal: 20,
    marginTop: 8,
  },
  messageThread: {
    flexGrow: 1,
    gap: 9,
    justifyContent: "flex-end",
    paddingBottom: 112,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  loading: {
    marginVertical: 20,
  },
  emptyText: {
    color: "#64748b",
    fontSize: 13,
    paddingVertical: 18,
    textAlign: "center",
  },
  messageBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#ffffff",
    borderRadius: 15,
    borderBottomLeftRadius: 4,
    maxWidth: "84%",
    padding: 11,
  },
  ownMessageBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#2563eb",
    borderBottomLeftRadius: 15,
    borderBottomRightRadius: 4,
  },
  messageSender: {
    color: "#1d4ed8",
    fontSize: 10,
    fontWeight: "800",
    marginBottom: 4,
  },
  officialMessageBadge: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    marginBottom: 5,
  },
  officialMessageBadgeText: {
    color: "#a16207",
    fontSize: 10,
    fontWeight: "800",
  },
  messageText: {
    color: "#1e293b",
    fontSize: 13,
    lineHeight: 19,
  },
  ownMessageText: {
    color: "#ffffff",
  },
  messagePhoto: {
    borderRadius: 10,
    height: 180,
    marginBottom: 5,
    width: 220,
  },
  audioMessagePlayer: {
    alignItems: "center",
    backgroundColor: "#edf5f1",
    borderRadius: 11,
    flexDirection: "row",
    gap: 8,
    marginBottom: 4,
    minWidth: 230,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  audioPlayButton: {
    alignItems: "center",
    backgroundColor: "#16856b",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  audioWaveform: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 2,
    height: 30,
    justifyContent: "center",
  },
  audioWaveformBar: {
    borderRadius: 2,
    width: 3,
  },
  audioDuration: {
    color: "#35564a",
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  voiceBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.48)",
    flex: 1,
    justifyContent: "flex-end",
  },
  voicePanel: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    gap: 18,
    maxWidth: 480,
    paddingBottom: 30,
    paddingHorizontal: 20,
    paddingTop: 22,
    width: "100%",
  },
  voiceHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  voiceEyebrow: {
    color: "#16856b",
    fontSize: 10,
    fontWeight: "800",
  },
  voiceTitle: {
    color: "#173f36",
    fontSize: 22,
    fontWeight: "800",
    marginTop: 3,
  },
  voiceWaveformBox: {
    alignItems: "center",
    backgroundColor: "#f1f7f4",
    borderRadius: 14,
    gap: 10,
    minHeight: 140,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 18,
  },
  voiceWaveBar: {
    width: 4,
  },
  voiceTimer: {
    color: "#173f36",
    fontSize: 30,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
  },
  voiceStatus: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  voiceActions: {
    flexDirection: "row",
    gap: 8,
  },
  voicePrimaryButton: {
    alignItems: "center",
    backgroundColor: "#16856b",
    borderRadius: 10,
    flex: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 10,
  },
  voicePrimaryText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  voiceSecondaryButton: {
    alignItems: "center",
    backgroundColor: "#edf5f1",
    borderRadius: 10,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 9,
  },
  voiceSecondaryText: {
    color: "#35564a",
    fontSize: 11,
    fontWeight: "700",
  },
  voiceCancelButton: {
    alignItems: "center",
    borderColor: "#dbe3ee",
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 8,
  },
  voiceCancelText: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "700",
  },
  voiceUploading: {
    alignItems: "center",
    gap: 10,
  },
  voiceUploadTrack: {
    backgroundColor: "#dce9e3",
    borderRadius: 4,
    height: 7,
    overflow: "hidden",
    width: "100%",
  },
  voiceUploadBar: {
    backgroundColor: "#16856b",
    height: "100%",
  },
  messageTime: {
    alignSelf: "flex-end",
    color: "#94a3b8",
    fontSize: 9,
    marginTop: 5,
  },
  ownMessageTime: {
    color: "#dbeafe",
  },
  composer: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 15,
    borderWidth: 1,
    bottom: 18,
    flexDirection: "row",
    gap: 7,
    left: 16,
    padding: 7,
    position: "absolute",
    right: 16,
  },
  attachButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 34,
  },
  micButton: {
    alignItems: "center",
    backgroundColor: "#16a34a",
    borderRadius: 19,
    flexDirection: "row",
    gap: 2,
    height: 38,
    justifyContent: "center",
    width: 44,
  },
  composerInput: {
    color: "#172b4d",
    flex: 1,
    fontSize: 13,
    maxHeight: 80,
    minHeight: 44,
    minWidth: 0,
    paddingHorizontal: 3,
    paddingVertical: 8,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 19,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  mediaUploadProgress: { color: "#475569", fontSize: 11, maxWidth: 75 },
  disabledButton: {
    opacity: 0.55,
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.62)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  dialog: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    maxHeight: "92%",
    maxWidth: 420,
    padding: 18,
    width: "100%",
  },
  dialogHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
  },
  reportIcon: {
    alignItems: "center",
    backgroundColor: "#fef2f2",
    borderRadius: 11,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  institutionModalIcon: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderRadius: 11,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  dialogTitle: {
    color: "#172b4d",
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  closeButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  dialogDescription: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 13,
  },
  institutionInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 12,
    marginTop: 9,
    minHeight: 40,
    paddingHorizontal: 10,
  },
  institutionTypes: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  institutionTypeButton: {
    backgroundColor: "#f1f5f9",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  institutionTypeButtonSelected: {
    backgroundColor: "#dbeafe",
    borderColor: "#60a5fa",
  },
  institutionTypeText: {
    color: "#334155",
    fontSize: 9,
    fontWeight: "700",
  },
  submitInstitutionButton: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 10,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 44,
  },
  officialEditInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#d6d3d1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 12,
    marginTop: 10,
    minHeight: 90,
    padding: 10,
    textAlignVertical: "top",
  },
  officialActions: {
    flexDirection: "row",
    gap: 7,
    marginTop: 9,
  },
  correctOfficialButton: {
    alignItems: "center",
    backgroundColor: "#a16207",
    borderRadius: 9,
    flex: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 8,
  },
  withdrawOfficialButton: {
    alignItems: "center",
    borderColor: "#fecaca",
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 10,
  },
  withdrawOfficialText: {
    color: "#b91c1c",
    fontSize: 10,
    fontWeight: "800",
  },
  officialHistoryTitle: {
    color: "#334155",
    fontSize: 11,
    fontWeight: "800",
    marginTop: 14,
  },
  officialHistoryList: {
    flexGrow: 0,
    marginTop: 6,
    maxHeight: 170,
  },
  officialHistoryEntry: {
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: 1,
    paddingVertical: 7,
  },
  officialHistoryAction: {
    color: "#713f12",
    fontSize: 10,
    fontWeight: "800",
  },
  officialHistoryDate: {
    color: "#94a3b8",
    fontSize: 9,
    marginTop: 2,
  },
  officialHistoryBody: {
    color: "#475569",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 3,
  },
  reportInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 11,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 13,
    minHeight: 88,
    marginTop: 12,
    padding: 11,
    textAlignVertical: "top",
  },
  reportReasons: { maxHeight: 240 },
  reportReasonButton: { borderBottomColor: "#e2e8f0", borderBottomWidth: 1, minHeight: 42, justifyContent: "center", paddingHorizontal: 8 },
  reportReasonButtonSelected: { backgroundColor: "#fee2e2" },
  reportReasonText: { color: "#172b4d", fontSize: 14 },
  reportButton: {
    alignItems: "center",
    backgroundColor: "#b91c1c",
    borderRadius: 11,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 44,
  },
  reportButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  connectionStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  statusDot: {
    backgroundColor: "#94a3b8",
    borderRadius: 5,
    height: 9,
    width: 9,
  },
  statusDotConnected: {
    backgroundColor: "#16a34a",
  },
  connectionText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "600",
  },
  pttButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#dc2626",
    borderColor: "#fee2e2",
    borderRadius: 45,
    borderWidth: 5,
    height: 90,
    justifyContent: "center",
    marginTop: 24,
    width: 90,
  },
  pttButtonActive: {
    backgroundColor: "#991b1b",
    transform: [{ scale: 0.96 }],
  },
  pttButtonText: {
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "900",
    marginTop: 4,
  },
  pttHint: {
    color: "#64748b",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 12,
    textAlign: "center",
  },
});
