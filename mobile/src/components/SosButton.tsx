import * as SMS from "expo-sms";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";
import { Camera, Mic, ShieldAlert, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import type { Socket } from "socket.io-client";
import { openProfileStore } from "../storage/profileStore";
import { uploadEmergencyMedia } from "../services/uploadEmergencyMedia";
import { callOfficialEmergencyService } from "../services/emergencyServices";
import { useTheme } from "../context/ThemeContext";

export type SosCoordinates = {
  latitude: number;
  longitude: number;
};

export type EmergencyType = "MEDICAL" | "SECURITY" | "FIRE";

type SosButtonProps = {
  location: SosCoordinates | null;
  socket: Socket | null;
  onAlert: (payload: unknown) => void;
  openRequestId?: string;
};

type TrackingAlert = {
  id: string;
  relaysNotified: number;
  createdAt: number;
  mediaWarning?: string;
};

type EmergencyPhoto = {
  uri: string;
  filename: string;
  mimeType: string;
};

const EMERGENCY_TYPES: { id: EmergencyType; label: string; emoji: string }[] = [
  { id: "MEDICAL", label: "Médical", emoji: "✚" },
  { id: "SECURITY", label: "Sécurité", emoji: "🛡" },
  { id: "FIRE", label: "Incendie", emoji: "🔥" },
];

const EMERGENCY_GUIDANCE: Record<EmergencyType, string> = {
  MEDICAL:
    "Appelez les urgences médicales. Donnez votre position et suivez les instructions du régulateur; n’intervenez que si vous pouvez le faire sans danger.",
  FIRE:
    "Éloignez-vous du feu, utilisez les sorties sans ascenseur et n’entrez pas dans le bâtiment. Appelez les pompiers depuis un lieu sûr.",
  SECURITY:
    "Mettez-vous à l’abri, évitez toute confrontation et appelez la police ou la gendarmerie depuis un lieu sûr.",
};

const ESCALATION_LEVELS = [
  { level: 1, label: "3 km" },
  { level: 2, label: "10 km" },
  { level: 3, label: "30 km" },
];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Une erreur inattendue est survenue.";

export default function SosButton({
  location,
  socket,
  onAlert,
  openRequestId,
}: SosButtonProps) {
  const { colors } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [emergencyType, setEmergencyType] = useState<EmergencyType | null>(null);
  const [escalationLevel, setEscalationLevel] = useState(1);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [hasSeenGuidance, setHasSeenGuidance] = useState(false);
  const [isTrainingMode, setIsTrainingMode] = useState(false);
  const [trackingAlert, setTrackingAlert] = useState<TrackingAlert | null>(null);
  const [cancelSeconds, setCancelSeconds] = useState(0);
  const [emergencyPhoto, setEmergencyPhoto] = useState<EmergencyPhoto | null>(null);
  const [pendingEmergencyPhoto, setPendingEmergencyPhoto] =
    useState<EmergencyPhoto | null>(null);
  const [emergencyAudioUri, setEmergencyAudioUri] = useState<string | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    if (openRequestId) setIsOpen(true);
  }, [openRequestId]);

  const sendOfflineSms = useCallback(async (coordinates: SosCoordinates) => {
    const store = await openProfileStore();
    const contacts = await store.getContacts();
    const recipients = [...new Set(
      contacts
        .map((contact) => contact.phone.trim())
        .filter((phone) => phone.length > 0),
    )];
    if (recipients.length === 0) {
      throw new Error(
        "Aucun contact de confiance n'est enregistré. Ajoutez-en un dans votre profil avant d'utiliser le relais SMS.",
      );
    }
    if (!(await SMS.isAvailableAsync())) {
      throw new Error("Le compositeur SMS n'est pas disponible sur cet appareil.");
    }

    const emergencyLabel = EMERGENCY_TYPES.find(
      (item) => item.id === emergencyType,
    )?.label;
    if (!emergencyLabel) {
      throw new Error("Choisissez le type d'urgence avant de lancer le SOS.");
    }
    const mapsLink = `https://www.google.com/maps?q=${coordinates.latitude},${coordinates.longitude}`;
    const message = [
      `SOS QuartierPlus — urgence ${emergencyLabel.toLowerCase()}.`,
      "J'ai besoin d'assistance. Ma position GPS :",
      `${coordinates.latitude}, ${coordinates.longitude}`,
      mapsLink,
      ...(emergencyPhoto || emergencyAudioUri
        ? ["Les photos et audios joints ne sont pas transmis par SMS."]
        : []),
    ].join("\n");
    const result = await SMS.sendSMSAsync(recipients, message);
    if (result.result === "cancelled") {
      Alert.alert("SMS annulé", "Le compositeur SMS a été fermé sans envoi.");
    } else if (result.result === "sent") {
      Alert.alert(
        "SMS envoyé",
        "L'application SMS indique que le message a été envoyé. La livraison dépend de votre opérateur.",
      );
    } else {
      Alert.alert(
        "Vérifiez le SMS de secours",
        "Le compositeur SMS s'est ouvert. Vérifiez les destinataires puis appuyez sur Envoyer pour transmettre votre alerte.",
      );
    }
  }, [emergencyAudioUri, emergencyPhoto, emergencyType]);

  const captureEmergencyPhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        const message =
          "L'accès à la caméra est refusé. Vous pouvez envoyer le SOS sans photo ou appeler directement les secours.";
        setMediaError(message);
        Alert.alert("Caméra indisponible", message, [
          { text: "Continuer sans photo", style: "cancel" },
          {
            text: "Appeler les secours",
            onPress: () => void openEmergencyCall(),
          },
        ]);
        return;
      }
      const selection = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 1,
      });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      if (!asset?.uri) throw new Error("La photo capturée est indisponible.");
      const resizeAction =
        asset.width > 1600 || asset.height > 1600
          ? [
              asset.width >= asset.height
                ? { resize: { width: 1600 } }
                : { resize: { height: 1600 } },
            ]
          : [];
      const compressed = await manipulateAsync(asset.uri, resizeAction, {
        compress: 0.72,
        format: SaveFormat.JPEG,
      });
      setPendingEmergencyPhoto({
        uri: compressed.uri,
        filename: `sos-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
      });
      setMediaError(null);
    } catch (error) {
      const message = errorMessage(error);
      setMediaError(message);
      Alert.alert(
        "Photo indisponible",
        `${message} Vous pouvez toujours envoyer le SOS sans photo ou appeler directement les secours.`,
        [
          { text: "Continuer sans photo", style: "cancel" },
          {
            text: "Appeler les secours",
            onPress: () => void openEmergencyCall(),
          },
        ],
      );
    }
  };

  const stopAudioRecording = async () => {
    if (!audioRecorder.isRecording) return;
    await audioRecorder.stop();
    setIsRecordingAudio(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    if (audioRecorder.uri) {
      setEmergencyAudioUri(audioRecorder.uri);
      setMediaError(null);
    } else {
      throw new Error("Aucun fichier audio n'a été enregistré.");
    }
  };

  const toggleAudioRecording = async () => {
    if (isRecordingAudio) {
      try {
        await stopAudioRecording();
      } catch (error) {
        const message = errorMessage(error);
        setMediaError(message);
        Alert.alert("Audio indisponible", message);
      }
      return;
    }
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("L'accès au microphone est nécessaire pour joindre un audio.");
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecordingAudio(true);
      setEmergencyAudioUri(null);
      setMediaError(null);
      setTimeout(() => {
        if (audioRecorder.isRecording) {
          void stopAudioRecording().catch((error: unknown) => {
            const message = errorMessage(error);
            setMediaError(message);
            Alert.alert("Audio indisponible", message);
          });
        }
      }, 10_000);
    } catch (error) {
      const message = errorMessage(error);
      setMediaError(message);
      Alert.alert("Audio indisponible", message);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    }
  };

  const triggerSos = useCallback(async () => {
    if (isTrainingMode) {
      setIsOpen(false);
      Alert.alert(
        "Mode entraînement",
        "Simulation terminée : aucun relais, voisin ou service de secours n'a été prévenu.",
      );
      return;
    }
    if (!location) {
      Alert.alert("Position indisponible", "Impossible de déterminer votre position GPS.");
      return;
    }
    if (!emergencyType) {
      Alert.alert(
        "Type d'urgence requis",
        "Choisissez une catégorie avant de lancer le SOS.",
      );
      return;
    }
    setIsSending(true);
    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      if (position.mocked === true) {
        throw new Error("La position GPS est signalée comme simulée.");
      }
      if (
        typeof position.coords.accuracy !== "number" ||
        !Number.isFinite(position.coords.accuracy) ||
        position.coords.accuracy > 200
      ) {
        throw new Error(
          "La précision GPS doit être de 200 m ou meilleure. Déplacez-vous à l'extérieur et réessayez.",
        );
      }
      const coordinates = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      if (isRecordingAudio) {
        await stopAudioRecording();
      }
      const networkState = await NetInfo.fetch();
      const hasDataConnection =
        networkState.isConnected === true &&
        networkState.isInternetReachable !== false;
      if (!hasDataConnection) {
        await sendOfflineSms(coordinates);
        setIsOpen(false);
        setEmergencyPhoto(null);
        setPendingEmergencyPhoto(null);
        setEmergencyAudioUri(null);
        return;
      }
      if (!socket?.connected) {
        throw new Error(
          "Le réseau de données est disponible, mais la connexion au service SOS est indisponible. Réessayez.",
        );
      }

      let emergencyImageUrl: string | undefined;
      let emergencyAudioUrl: string | undefined;
      const mediaWarnings: string[] = [];
      if (emergencyPhoto) {
        try {
          emergencyImageUrl = await uploadEmergencyMedia(
            emergencyPhoto.uri,
            emergencyPhoto.filename,
            emergencyPhoto.mimeType,
            "image",
            (progress) => setUploadProgress(progress),
          );
        } catch (error) {
          mediaWarnings.push(errorMessage(error));
        } finally {
          setUploadProgress(null);
        }
      }
      if (emergencyAudioUri) {
        try {
          emergencyAudioUrl = await uploadEmergencyMedia(
            emergencyAudioUri,
            `sos-${Date.now()}.m4a`,
            "audio/mp4",
            "video",
          );
        } catch (error) {
          mediaWarnings.push(errorMessage(error));
        }
      }
      const result = await new Promise<unknown>((resolve, reject) => {
        socket.timeout(8000).emit(
          "sos:trigger",
          {
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
            emergency_type: emergencyType,
            escalation_level: escalationLevel,
            accuracy_m: position.coords.accuracy,
            mocked: position.mocked === true,
            emergency_image_url: emergencyImageUrl,
            emergency_audio_url: emergencyAudioUrl,
          },
          (timeoutError: Error | null, acknowledgement: unknown) => {
            if (timeoutError) {
              reject(new Error("Le serveur SOS n'a pas répondu. Réessayez."));
              return;
            }
            resolve(acknowledgement);
          },
        );
      });
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        const message =
          result && typeof result === "object" && "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Le serveur n'a pas confirmé la réception de l'alerte.";
        throw new Error(message);
      }
      let alertId = "";
      if ("alert" in result) {
        onAlert(result.alert);
        if (
          result.alert &&
          typeof result.alert === "object" &&
          "id" in result.alert &&
          typeof result.alert.id === "string"
        ) {
          alertId = result.alert.id;
        }
      }
      setIsOpen(false);
      setEmergencyPhoto(null);
      setPendingEmergencyPhoto(null);
      setEmergencyAudioUri(null);
      if (alertId) {
        setTrackingAlert({
          id: alertId,
          relaysNotified:
            "relays_notified" in result && typeof result.relays_notified === "number"
              ? result.relays_notified
              : 0,
          createdAt: Date.now(),
          mediaWarning: mediaWarnings.length > 0
            ? `Alerte envoyée sans média : ${mediaWarnings.join(" ")}`
            : undefined,
        });
        setCancelSeconds(10);
      } else {
        Alert.alert(
          "Alerte SOS envoyée",
          "Votre alerte a été transmise aux voisins proches.",
        );
      }
    } catch (error) {
      Alert.alert("Envoi du SOS impossible", errorMessage(error));
    } finally {
      setIsSending(false);
    }
  }, [
    audioRecorder,
    emergencyAudioUri,
    emergencyPhoto,
    emergencyType,
    escalationLevel,
    isRecordingAudio,
    isTrainingMode,
    location,
    onAlert,
    sendOfflineSms,
    socket,
    setUploadProgress,
  ]);

  useEffect(() => {
    if (countdown === null) return undefined;
    if (countdown === 0) {
      setCountdown(null);
      void triggerSos();
      return undefined;
    }
    const timer = setTimeout(
      () => setCountdown((current) => current === null ? null : current - 1),
      1000,
    );
    return () => clearTimeout(timer);
  }, [countdown, triggerSos]);

  const resolveTrackingAlert = useCallback(async () => {
    const alert = trackingAlert;
    if (!alert || !socket?.connected) {
      Alert.alert(
        "Connexion indisponible",
        "L'alerte reste active. Rétablissez la connexion pour la clôturer.",
      );
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        socket.timeout(8000).emit(
          "sos:resolve",
          { id: alert.id },
          (timeoutError: Error | null, response: unknown) => {
            if (timeoutError) {
              reject(new Error("Le serveur n'a pas confirmé la clôture."));
              return;
            }
            if (
              !response ||
              typeof response !== "object" ||
              !("ok" in response) ||
              response.ok !== true
            ) {
              reject(
                new Error(
                  response &&
                    typeof response === "object" &&
                    "error" in response &&
                    typeof response.error === "string"
                    ? response.error
                    : "Le serveur a refusé la clôture.",
                ),
              );
              return;
            }
            resolve();
          },
        );
      });
      setTrackingAlert(null);
      setCancelSeconds(0);
      Alert.alert("Alerte clôturée", "Merci d'avoir confirmé que vous êtes en sécurité.");
    } catch (error) {
      Alert.alert("Impossible de clôturer l'alerte", errorMessage(error));
    }
  }, [socket, trackingAlert]);

  const cancelTrackingAlert = useCallback(async () => {
    const alert = trackingAlert;
    if (!alert || cancelSeconds === 0 || !socket?.connected) return;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.timeout(8000).emit(
          "sos:cancel",
          { id: alert.id },
          (timeoutError: Error | null, response: unknown) => {
            if (timeoutError) {
              reject(new Error("Le serveur n'a pas confirmé l'annulation."));
              return;
            }
            if (
              !response ||
              typeof response !== "object" ||
              !("ok" in response) ||
              response.ok !== true
            ) {
              reject(
                new Error(
                  response &&
                    typeof response === "object" &&
                    "error" in response &&
                    typeof response.error === "string"
                    ? response.error
                    : "Le serveur a refusé l'annulation.",
                ),
              );
              return;
            }
            resolve();
          },
        );
      });
      setTrackingAlert(null);
      setCancelSeconds(0);
    } catch (error) {
      Alert.alert("Impossible d'annuler le SOS", errorMessage(error));
    }
  }, [cancelSeconds, socket, trackingAlert]);

  const openEmergencyCall = async () => {
    if (!emergencyType) {
      Alert.alert("Type d’urgence requis", "Choisissez le service à contacter.");
      return;
    }
    try {
      await callOfficialEmergencyService(
        emergencyType === "MEDICAL"
          ? "medical"
          : emergencyType === "FIRE"
            ? "fire"
            : "police",
      );
    } catch (error) {
      Alert.alert(
        "Appel indisponible",
        `Impossible d'ouvrir l'appel d'urgence : ${errorMessage(error)}`,
      );
    }
  };

  useEffect(() => {
    if (!trackingAlert) return undefined;
    const interval = setInterval(() => {
      setCancelSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    const safetyTimer = setTimeout(() => {
      Alert.alert(
        "Êtes-vous en sécurité ?",
        "Votre alerte SOS est toujours active. Si vous êtes en danger, contactez directement les secours.",
        [
          { text: "Non, j'ai besoin d'aide", style: "destructive" },
          {
            text: "Oui, je suis en sécurité",
            onPress: () => void resolveTrackingAlert(),
          },
        ],
      );
    }, Math.max(0, trackingAlert.createdAt + 10 * 60_000 - Date.now()));
    return () => {
      clearInterval(interval);
      clearTimeout(safetyTimer);
    };
  }, [resolveTrackingAlert, trackingAlert]);

  const close = () => {
    if (isSending) return;
    if (audioRecorder.isRecording) {
      void stopAudioRecording().catch((error: unknown) => {
        console.error("Unable to stop cancelled SOS audio recording:", error);
      });
    }
    setCountdown(null);
    setIsOpen(false);
    setEmergencyPhoto(null);
    setPendingEmergencyPhoto(null);
    setEmergencyAudioUri(null);
    setMediaError(null);
  };

  return (
    <>
      <Pressable
        accessibilityLabel="Déclencher une alerte SOS"
        accessibilityRole="button"
        onPress={() => {
          if (hasSeenGuidance) {
            setIsOpen(true);
            return;
          }
          Alert.alert(
            "Quand utiliser le SOS",
            "Utilisez-le uniquement en cas de danger réel nécessitant une aide urgente. Votre position exacte sera transmise aux relais prévenus. Le niveau de confiance dépend du téléphone vérifié et des confirmations reçues.",
            [
              { text: "Annuler", style: "cancel" },
              {
                text: "Compris",
                onPress: () => {
                  setHasSeenGuidance(true);
                  setIsOpen(true);
                },
              },
            ],
          );
        }}
        style={styles.fab}
      >
        <ShieldAlert color="#ffffff" size={25} />
        <Text style={styles.fabText}>SOS</Text>
      </Pressable>
      <Modal
        animationType="fade"
        onRequestClose={close}
        transparent
        visible={isOpen}
      >
        <View style={styles.backdrop}>
          <View style={[styles.dialog, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.header}>
              <View>
                <Text style={[styles.title, { color: colors.text }]}>Alerte d'urgence</Text>
                <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
                  {countdown === null
                    ? "Choisissez le type d'aide nécessaire."
                    : "Envoi imminent — annulez si vous avez déclenché par erreur."}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Fermer"
                accessibilityRole="button"
                disabled={isSending}
                onPress={close}
                style={styles.close}
              >
                <X color="#64748b" size={20} />
              </Pressable>
            </View>

            {countdown === null && !isSending ? (
              <>
                <Text style={styles.sectionLabel}>Type d'urgence</Text>
                <View style={styles.options}>
                  {EMERGENCY_TYPES.map((type) => {
                    const selected = type.id === emergencyType;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        key={type.id}
                        onPress={() => setEmergencyType(type.id)}
                        style={[styles.option, selected && styles.optionSelected]}
                      >
                        <Text style={styles.optionEmoji}>{type.emoji}</Text>
                        <Text
                          style={[
                            styles.optionText,
                            selected && styles.optionTextSelected,
                          ]}
                        >
                          {type.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {emergencyType ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={styles.guidance}
                  >
                    {EMERGENCY_GUIDANCE[emergencyType]}
                  </Text>
                ) : null}
                <Text style={styles.sectionLabel}>Rayon d'alerte</Text>
                <View style={styles.radiusOptions}>
                  {ESCALATION_LEVELS.map((option) => {
                    const selected = option.level === escalationLevel;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        key={option.level}
                        onPress={() => setEscalationLevel(option.level)}
                        style={[styles.radiusOption, selected && styles.radiusOptionSelected]}
                      >
                        <Text
                          style={[
                            styles.radiusText,
                            selected && styles.radiusTextSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.sectionLabel}>Média facultatif</Text>
                {pendingEmergencyPhoto || emergencyPhoto ? (
                  <View style={styles.photoPreview}>
                    <Image
                      accessibilityLabel="Aperçu de la photo capturée pour le SOS"
                      source={{ uri: (pendingEmergencyPhoto ?? emergencyPhoto)?.uri }}
                      style={styles.photoPreviewImage}
                    />
                    {pendingEmergencyPhoto ? (
                      <View style={styles.photoActions}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => setPendingEmergencyPhoto(null)}
                          style={styles.photoSecondaryAction}
                        >
                          <Text style={styles.photoSecondaryActionText}>Reprendre</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            setEmergencyPhoto(pendingEmergencyPhoto);
                            setPendingEmergencyPhoto(null);
                            setMediaError(null);
                          }}
                          style={styles.photoConfirmAction}
                        >
                          <Text style={styles.photoConfirmActionText}>
                            Confirmer la photo
                          </Text>
                        </Pressable>
                      </View>
                    ) : (
                      <Text style={styles.mediaStatus}>
                        Photo confirmée et prête à être jointe
                      </Text>
                    )}
                  </View>
                ) : null}
                <View style={styles.mediaActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void captureEmergencyPhoto()}
                    style={styles.mediaButton}
                  >
                    <Camera color="#1d4ed8" size={17} />
                    <Text style={styles.mediaButtonText}>
                      {emergencyPhoto || pendingEmergencyPhoto
                        ? "Refaire la photo"
                        : "Prendre une photo"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void toggleAudioRecording()}
                    style={styles.mediaButton}
                  >
                    <Mic color={isRecordingAudio ? "#dc2626" : "#1d4ed8"} size={17} />
                    <Text style={styles.mediaButtonText}>
                      {isRecordingAudio
                        ? "Arrêter l'audio"
                        : emergencyAudioUri
                          ? "Refaire l'audio"
                          : "Enregistrer un audio"}
                    </Text>
                  </Pressable>
                </View>
                {emergencyPhoto ? (
                  <Text style={styles.mediaStatus}>Photo jointe à l'alerte</Text>
                ) : null}
                {emergencyAudioUri ? (
                  <Text style={styles.mediaStatus}>Audio joint à l'alerte · 10 s maximum</Text>
                ) : null}
                {mediaError ? (
                  <Text accessibilityRole="alert" style={styles.mediaError}>
                    {mediaError}
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isTrainingMode }}
                  onPress={() => setIsTrainingMode((enabled) => !enabled)}
                  style={styles.trainingOption}
                >
                  <View
                    style={[
                      styles.trainingCheckbox,
                      isTrainingMode && styles.trainingCheckboxSelected,
                    ]}
                  />
                  <Text style={styles.trainingText}>
                    MODE ENTRAÎNEMENT — aucun relais ne sera prévenu
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!location || !emergencyType || isRecordingAudio}
                  delayLongPress={2000}
                  onLongPress={() => {
                    if (!location || !emergencyType || isRecordingAudio) return;
                    Vibration.vibrate(100);
                    setCountdown(10);
                  }}
                  style={[
                    styles.trigger,
                    (!location || !emergencyType || isRecordingAudio) && styles.disabled,
                  ]}
                >
                  <ShieldAlert color="#ffffff" size={19} />
                  <Text style={styles.triggerText}>
                    Maintenir 2 s pour demander de l'aide
                  </Text>
                </Pressable>
                {(!location || !emergencyType || isRecordingAudio) && (
                  <Text style={styles.locationNotice}>
                    {isRecordingAudio
                      ? "Arrêtez l'enregistrement audio avant de lancer le SOS."
                      : !emergencyType
                      ? "Choisissez une catégorie avant de lancer le SOS."
                      : "En attente de la position GPS..."}
                  </Text>
                )}
              </>
            ) : (
              <View style={styles.countdownPanel}>
                {isSending ? (
                  <>
                    <ActivityIndicator color="#dc2626" size="large" />
                    <Text style={styles.countdownDescription}>
                      {uploadProgress === null
                        ? "Transmission de votre alerte..."
                        : `Envoi de la photo : ${uploadProgress} %`}
                    </Text>
                    {uploadProgress !== null ? (
                      <View
                        accessibilityLabel={`Envoi de la photo, ${uploadProgress} %`}
                        accessibilityRole="progressbar"
                        style={styles.progressTrack}
                      >
                        <View
                          style={[
                            styles.progressFill,
                            { width: `${uploadProgress}%` },
                          ]}
                        />
                      </View>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text style={styles.countdownValue}>{countdown ?? 0}</Text>
                    <Text style={styles.countdownDescription}>
                      {countdown === null
                        ? "Transmission de votre alerte..."
                        : `Votre SOS sera transmis dans ${countdown} s. Vous pouvez encore l'annuler sans pénalité.`}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setCountdown(null)}
                      style={styles.cancel}
                    >
                      <Text style={styles.cancelText}>Annuler le SOS</Text>
                    </Pressable>
                  </>
                )}
              </View>
            )}
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => undefined}
        transparent
        visible={trackingAlert !== null}
      >
        <View style={styles.backdrop}>
          <View style={[styles.dialog, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]}>Suivi de votre alerte SOS</Text>
            <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
              {trackingAlert?.relaysNotified
                ? `${trackingAlert.relaysNotified} relais prévenu(s). Les réponses arrivent au fur et à mesure.`
                : "Alerte transmise aux relais proches. Leurs réponses arrivent au fur et à mesure."}
            </Text>
            {trackingAlert?.mediaWarning ? (
              <Text accessibilityRole="alert" style={styles.mediaError}>
                {trackingAlert.mediaWarning}
              </Text>
            ) : null}
            <Text style={styles.trustExplanation}>
              Le niveau de confiance évolue selon les confirmations des relais et ne remplace pas l'évaluation des secours.
            </Text>
            {cancelSeconds > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void cancelTrackingAlert()}
                style={styles.cancel}
              >
                <Text style={styles.cancelText}>
                  Annuler sans pénalité · {cancelSeconds} s
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => void openEmergencyCall()}
              style={styles.callButton}
            >
              <Text style={styles.callButtonText}>Appeler le service concerné</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void resolveTrackingAlert()}
              style={styles.safeButton}
            >
              <Text style={styles.safeButtonText}>Je suis en sécurité · clôturer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    alignItems: "center",
    backgroundColor: "#dc2626",
    borderRadius: 30,
    bottom: 24,
    elevation: 7,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 15,
    position: "absolute",
    right: 20,
    shadowColor: "#7f1d1d",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  fabText: { color: "#ffffff", fontSize: 16, fontWeight: "800" },
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  dialog: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    maxWidth: 440,
    padding: 20,
    width: "100%",
  },
  header: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" },
  title: { color: "#0f172a", fontSize: 21, fontWeight: "800" },
  subtitle: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 310 },
  close: { alignItems: "center", backgroundColor: "#f1f5f9", borderRadius: 18, height: 36, justifyContent: "center", width: 36 },
  sectionLabel: { color: "#334155", fontSize: 13, fontWeight: "700", marginBottom: 9, marginTop: 20 },
  options: { flexDirection: "row", gap: 8 },
  option: { alignItems: "center", backgroundColor: "#f8fafc", borderColor: "#e2e8f0", borderRadius: 12, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 74, padding: 8 },
  optionSelected: { backgroundColor: "#fef2f2", borderColor: "#dc2626" },
  optionEmoji: { fontSize: 20, marginBottom: 5 },
  optionText: { color: "#475569", fontSize: 12, fontWeight: "600" },
  optionTextSelected: { color: "#b91c1c" },
  guidance: { backgroundColor: "#fff7ed", borderRadius: 10, color: "#7c2d12", fontSize: 12, lineHeight: 18, marginTop: 10, padding: 11 },
  radiusOptions: { flexDirection: "row", gap: 8 },
  radiusOption: { alignItems: "center", backgroundColor: "#f8fafc", borderColor: "#e2e8f0", borderRadius: 10, borderWidth: 1, flex: 1, padding: 11 },
  radiusOptionSelected: { backgroundColor: "#fff7ed", borderColor: "#f97316" },
  radiusText: { color: "#475569", fontSize: 14, fontWeight: "600" },
  radiusTextSelected: { color: "#c2410c" },
  mediaActions: { flexDirection: "row", gap: 8 },
  mediaButton: { alignItems: "center", backgroundColor: "#eff6ff", borderRadius: 10, flex: 1, flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 44, paddingHorizontal: 6 },
  mediaButtonText: { color: "#1e3a8a", fontSize: 11, fontWeight: "700", textAlign: "center" },
  photoPreview: { marginBottom: 10 },
  photoPreviewImage: { backgroundColor: "#0f172a", borderRadius: 12, height: 180, width: "100%" },
  photoActions: { flexDirection: "row", gap: 8, marginTop: 8 },
  photoSecondaryAction: { alignItems: "center", borderColor: "#94a3b8", borderRadius: 10, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 42 },
  photoSecondaryActionText: { color: "#334155", fontSize: 13, fontWeight: "700" },
  photoConfirmAction: { alignItems: "center", backgroundColor: "#15803d", borderRadius: 10, flex: 1, justifyContent: "center", minHeight: 42 },
  photoConfirmActionText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  mediaStatus: { color: "#15803d", fontSize: 12, marginTop: 6 },
  mediaError: { color: "#b91c1c", fontSize: 12, lineHeight: 17, marginTop: 8 },
  progressTrack: { backgroundColor: "#fee2e2", borderRadius: 5, height: 8, marginBottom: 20, overflow: "hidden", width: "100%" },
  progressFill: { backgroundColor: "#dc2626", height: "100%" },
  trigger: { alignItems: "center", backgroundColor: "#dc2626", borderRadius: 12, flexDirection: "row", gap: 8, justifyContent: "center", marginTop: 24, minHeight: 52, paddingHorizontal: 12 },
  triggerText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  disabled: { opacity: 0.5 },
  locationNotice: { color: "#b91c1c", fontSize: 12, marginTop: 10, textAlign: "center" },
  trainingOption: { alignItems: "center", flexDirection: "row", gap: 9, marginTop: 14 },
  trainingCheckbox: { borderColor: "#94a3b8", borderRadius: 4, borderWidth: 1, height: 18, width: 18 },
  trainingCheckboxSelected: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  trainingText: { color: "#1e3a8a", flex: 1, fontSize: 12, fontWeight: "700" },
  trustExplanation: { color: "#475569", fontSize: 13, lineHeight: 19, marginTop: 14 },
  callButton: { alignItems: "center", backgroundColor: "#dc2626", borderRadius: 12, marginTop: 14, padding: 15 },
  callButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  safeButton: { alignItems: "center", backgroundColor: "#15803d", borderRadius: 12, marginTop: 9, padding: 15 },
  safeButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  countdownPanel: { alignItems: "center", paddingBottom: 8, paddingTop: 22 },
  countdownValue: { color: "#dc2626", fontSize: 72, fontWeight: "800", lineHeight: 82 },
  countdownDescription: { color: "#475569", fontSize: 14, marginBottom: 24, marginTop: 6, textAlign: "center" },
  cancel: { alignItems: "center", borderColor: "#dc2626", borderRadius: 12, borderWidth: 1.5, minHeight: 48, justifyContent: "center", paddingHorizontal: 24, width: "100%" },
  cancelText: { color: "#b91c1c", fontSize: 15, fontWeight: "800" },
});
