import { AudioSession } from "@livekit/react-native";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { Mic, Radio, Wifi, WifiOff } from "lucide-react-native";
import { Room, RoomEvent, type Participant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { API_BASE_URL, apiFetch } from "../services/api";

type ActiveSpeaker = {
  identity: string;
  name: string;
};

const TALKIE_WALKIE_UNAVAILABLE =
  "Connexion au talkie-walkie impossible.";

const formatLiveKitError = (error: unknown) => {
  if (!(error instanceof Error)) return TALKIE_WALKIE_UNAVAILABLE;
  if (/\(code [A-Z0-9_-]+\)/i.test(error.message)) return error.message;
  const record = error as Error & { code?: string | number };
  const code =
    typeof record.code === "string" || typeof record.code === "number"
      ? String(record.code)
      : "LIVEKIT_CONNECTION_FAILED";
  return `${error.message} (code ${code}).`;
};

const readServerReason = async (response: Awaited<ReturnType<typeof apiFetch>>) => {
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

const speakerLabel = (participant: Participant): ActiveSpeaker => ({
  identity: participant.identity,
  name: participant.name || participant.identity,
});

export default function WalkieTalkieScreen() {
  const { isOffline } = useAuth();
  const { colors } = useTheme();
  const roomRef = useRef<Room | null>(null);
  const connectPromiseRef = useRef<Promise<Room> | null>(null);
  const pressedRef = useRef(false);
  const mountedRef = useRef(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [speakers, setSpeakers] = useState<ActiveSpeaker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [permissionHint, setPermissionHint] = useState(false);

  const connect = useCallback(async (): Promise<Room> => {
    if (roomRef.current?.state === "connected") return roomRef.current;
    if (connectPromiseRef.current) return connectPromiseRef.current;
    if (!API_BASE_URL) {
      throw new Error("EXPO_PUBLIC_API_URL manquant (code API_URL_MISSING).");
    }
    if (isOffline) {
      throw new Error("Connexion Internet requise (code LIVEKIT_NETWORK_OFFLINE).");
    }

    const pending = (async () => {
      setIsConnecting(true);
      setError(null);
      try {
        const response = await apiFetch(`${API_BASE_URL}/v1/livekit/token`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ room: "emergency" }),
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
        const room = new Room();
        room.on(RoomEvent.ActiveSpeakersChanged, (activeParticipants) => {
          setSpeakers(activeParticipants.map(speakerLabel));
        });
        room.on(RoomEvent.Disconnected, () => {
          roomRef.current = null;
          setIsConnected(false);
          setIsTalking(false);
          setSpeakers([]);
        });
        await room.connect(payload.url, payload.token);
        await room.localParticipant.setMicrophoneEnabled(false);
        if (!mountedRef.current) {
          await room.disconnect();
          await AudioSession.stopAudioSession();
          throw new Error("La connexion audio a été interrompue.");
        }
        roomRef.current = room;
        setIsConnected(true);
        setSpeakers(room.activeSpeakers.map(speakerLabel));
        return room;
      } catch (connectError) {
        await AudioSession.stopAudioSession().catch((audioError: unknown) => {
          console.error("Unable to stop failed LiveKit audio session:", audioError);
        });
        throw connectError;
      } finally {
        setIsConnecting(false);
      }
    })();
    connectPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      connectPromiseRef.current = null;
    }
  }, [isOffline]);

  useEffect(() => {
    mountedRef.current = true;
    if (isOffline) {
      setError("Connectez-vous à Internet pour rejoindre le canal vocal.");
      return () => {
        mountedRef.current = false;
      };
    }
    void connect().catch((connectError: unknown) => {
      if (mountedRef.current) {
        setError(formatLiveKitError(connectError));
      }
    });
    return () => {
      mountedRef.current = false;
      pressedRef.current = false;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) void room.disconnect();
      void AudioSession.stopAudioSession().catch((audioError: unknown) => {
        console.error("Unable to stop LiveKit audio session:", audioError);
      });
    };
  }, [connect, isOffline]);

  const startTalking = async () => {
    pressedRef.current = true;
    setError(null);
    setPermissionHint(false);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("L’accès au microphone est nécessaire pour parler (code MICROPHONE_PERMISSION_DENIED).");
      }
      if (!pressedRef.current) {
        setPermissionHint(true);
        return;
      }
      const room = await connect();
      if (!pressedRef.current) return;
      await room.localParticipant.setMicrophoneEnabled(true);
      if (pressedRef.current) {
        setIsTalking(true);
        setPermissionHint(false);
        Vibration.vibrate(12);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
    } catch (talkError) {
      pressedRef.current = false;
      Vibration.vibrate(35);
      setError(formatLiveKitError(talkError));
    }
  };

  const stopTalking = () => {
    pressedRef.current = false;
    setIsTalking(false);
    const room = roomRef.current;
    if (room) {
      void room.localParticipant
        .setMicrophoneEnabled(false)
        .catch((error: unknown) =>
          setError(formatLiveKitError(error)),
        );
    }
  };

  const retryConnection = () => {
    void connect().catch((error: unknown) =>
      setError(formatLiveKitError(error)),
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={[styles.logo, { backgroundColor: colors.muted }]}>
          <Radio color={colors.danger} size={23} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>Talkie-walkie</Text>
          <Text style={[styles.subtitle, { color: colors.secondaryText }]}>Canal vocal URGENCES</Text>
        </View>
        <View style={[styles.connectionBadge, { backgroundColor: colors.muted }, isConnected ? styles.connectedBadge : null]}>
          {isConnected ? (
            <Wifi color="#15803d" size={16} />
          ) : (
            <WifiOff color={colors.secondaryText} size={16} />
          )}
        </View>
      </View>

      <View style={[styles.channelCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.liveDot} />
        <View style={styles.channelInfo}>
          <Text style={[styles.channelName, { color: colors.text }]}>URGENCES</Text>
          <Text style={[styles.channelDetails, { color: colors.secondaryText }]}>
            {isConnecting
              ? "Connexion au canal…"
              : isConnected
                ? isTalking
                  ? "Vous parlez · micro ouvert"
                  : "Audio en direct · micro fermé"
                : "Non connecté"}
          </Text>
        </View>
        {isConnecting && <ActivityIndicator color={colors.danger} />}
      </View>

      <View style={styles.talkArea}>
        <View style={[styles.ripple, { backgroundColor: colors.muted }, isTalking && styles.rippleActive]}>
          <Pressable
            accessibilityLabel={
              isTalking ? "Relâcher pour arrêter de parler" : "Maintenir pour parler"
            }
            accessibilityRole="button"
            onPressIn={() => void startTalking()}
            onPressOut={stopTalking}
            style={[
              styles.talkButton,
              { backgroundColor: colors.danger },
              isTalking && styles.talkButtonActive,
              !isConnected && styles.talkButtonDisabled,
            ]}
          >
            <Mic color={colors.onPrimary} size={38} />
            <Text style={styles.talkButtonText}>
              {isTalking ? "PARLEZ" : "MAINTENIR"}
            </Text>
          </Pressable>
        </View>
        <Text style={[styles.instruction, { color: colors.secondaryText }]}>
          {permissionHint
            ? "Micro autorisé. Maintenez de nouveau pour parler."
            : isTalking
              ? "Vous parlez. Relâchez pour écouter."
              : "Appuyez et maintenez pour parler. Relâchez pour écouter."}
        </Text>
      </View>

      <View style={[styles.speakersCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.speakersTitle, { color: colors.text }]}>Personnes qui parlent</Text>
        <ScrollView contentContainerStyle={styles.speakersList}>
          {isTalking && (
            <View style={styles.speakerRow}>
              <View style={[styles.speakerAvatar, styles.localAvatar]}>
                <Mic color="#ffffff" size={15} />
              </View>
              <Text style={[styles.speakerName, { color: colors.text }]}>Vous</Text>
              <View style={styles.speakingIndicator}>
                <View style={styles.speakingBar} />
                <View style={[styles.speakingBar, styles.speakingBarTall]} />
                <View style={styles.speakingBar} />
              </View>
            </View>
          )}
          {speakers
            .filter((speaker) => speaker.identity !== roomRef.current?.localParticipant.identity)
            .map((speaker) => (
              <View key={speaker.identity} style={styles.speakerRow}>
                <View style={styles.speakerAvatar}>
                  <Text style={[styles.speakerInitial, { color: colors.primary }]}>
                    {speaker.name.slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.speakerName, { color: colors.text }]}>{speaker.name}</Text>
                <View style={[styles.speakingIndicator, styles.remoteSpeakingIndicator]}>
                  <View style={styles.speakingBar} />
                  <View style={[styles.speakingBar, styles.speakingBarTall]} />
                  <View style={styles.speakingBar} />
                </View>
              </View>
            ))}
          {!isTalking && speakers.length === 0 && (
            <Text style={[styles.emptySpeakers, { color: colors.secondaryText }]}>Personne ne parle pour le moment.</Text>
          )}
        </ScrollView>
      </View>

      {error && (
        <View style={[styles.errorCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text accessibilityRole="alert" style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
          {!isOffline && (
            <Pressable accessibilityRole="button" onPress={retryConnection}>
              <Text style={[styles.retryText, { color: colors.primary }]}>Réessayer</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#f8fafc", flex: 1, paddingHorizontal: 20, paddingTop: 58 },
  header: { alignItems: "center", flexDirection: "row", gap: 11 },
  logo: { alignItems: "center", backgroundColor: "#fee2e2", borderRadius: 15, height: 48, justifyContent: "center", width: 48 },
  headerText: { flex: 1 },
  title: { color: "#0f172a", fontSize: 23, fontWeight: "800" },
  subtitle: { color: "#64748b", fontSize: 13, marginTop: 3 },
  connectionBadge: { alignItems: "center", backgroundColor: "#e2e8f0", borderRadius: 16, height: 34, justifyContent: "center", width: 34 },
  connectedBadge: { backgroundColor: "#dcfce7" },
  channelCard: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#e2e8f0", borderRadius: 15, borderWidth: 1, flexDirection: "row", marginTop: 26, padding: 15 },
  liveDot: { backgroundColor: "#16a34a", borderRadius: 5, height: 10, marginRight: 12, width: 10 },
  channelInfo: { flex: 1 },
  channelName: { color: "#0f172a", fontSize: 14, fontWeight: "800", letterSpacing: 0.6 },
  channelDetails: { color: "#64748b", fontSize: 12, marginTop: 4 },
  talkArea: { alignItems: "center", justifyContent: "center", minHeight: 350 },
  ripple: { alignItems: "center", backgroundColor: "#fee2e2", borderRadius: 125, height: 250, justifyContent: "center", width: 250 },
  rippleActive: { backgroundColor: "#fecaca" },
  talkButton: { alignItems: "center", backgroundColor: "#dc2626", borderRadius: 98, elevation: 5, height: 196, justifyContent: "center", width: 196 },
  talkButtonActive: { backgroundColor: "#991b1b", transform: [{ scale: 0.97 }] },
  talkButtonDisabled: { opacity: 0.5 },
  talkButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "900", letterSpacing: 1.2, marginTop: 12 },
  instruction: { color: "#64748b", fontSize: 13, marginTop: -20, textAlign: "center" },
  speakersCard: { backgroundColor: "#ffffff", borderColor: "#e2e8f0", borderRadius: 15, borderWidth: 1, minHeight: 120, padding: 15 },
  speakersTitle: { color: "#334155", fontSize: 14, fontWeight: "700" },
  speakersList: { gap: 12, paddingBottom: 112, paddingTop: 14 },
  speakerRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  speakerAvatar: { alignItems: "center", backgroundColor: "#dbeafe", borderRadius: 18, height: 36, justifyContent: "center", width: 36 },
  localAvatar: { backgroundColor: "#dc2626" },
  speakerInitial: { color: "#1d4ed8", fontSize: 14, fontWeight: "800" },
  speakerName: { color: "#334155", flex: 1, fontSize: 13, fontWeight: "600" },
  speakingIndicator: { alignItems: "center", flexDirection: "row", gap: 3, height: 20 },
  remoteSpeakingIndicator: { opacity: 0.85 },
  speakingBar: { backgroundColor: "#16a34a", borderRadius: 2, height: 8, width: 3 },
  speakingBarTall: { height: 16 },
  emptySpeakers: { color: "#94a3b8", fontSize: 12, paddingBottom: 2 },
  errorCard: { backgroundColor: "#fef2f2", borderRadius: 12, marginTop: 14, padding: 13 },
  errorText: { color: "#b91c1c", fontSize: 12, lineHeight: 18 },
  retryText: { color: "#1d4ed8", fontSize: 13, fontWeight: "700", marginTop: 8 },
});
