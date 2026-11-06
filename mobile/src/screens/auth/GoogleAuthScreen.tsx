import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth, type AuthUser } from "../../context/AuthContext";
import api from "../../services/api";

const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() ?? "";
const googleIosClientId =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? "";
const validGoogleClientId = (clientId: string) =>
  /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId);

const initialConfigurationError = (() => {
  if (!googleWebClientId) {
    return "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID manquant (code GOOGLE_WEB_CLIENT_ID_MISSING).";
  }
  if (!validGoogleClientId(googleWebClientId)) {
    return "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID invalide (code GOOGLE_WEB_CLIENT_ID_INVALID).";
  }
  if (Platform.OS === "ios" && !validGoogleClientId(googleIosClientId)) {
    if (googleIosClientId) {
      return "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID invalide (code GOOGLE_IOS_CLIENT_ID_INVALID).";
    }
  }
  return null;
})();

const googleErrorMessage = (error: unknown) => {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const codeValue = record?.code;
  const code =
    typeof codeValue === "string" || typeof codeValue === "number"
      ? String(codeValue)
      : "GOOGLE_SIGN_IN_FAILED";
  const response = record?.response;
  const responseData =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).data
      : null;
  if (typeof responseData === "object" && responseData !== null) {
    const data = responseData as Record<string, unknown>;
    for (const key of ["reason", "error", "message", "detail"]) {
      if (typeof data[key] === "string" && data[key].trim()) {
        const status =
          typeof record?.status === "number" ? ` (HTTP ${record.status})` : "";
        return `${data[key]}${status}`;
      }
    }
  }
  const rawMessage =
    error instanceof Error
      ? error.message
      : record && typeof record.message === "string"
        ? record.message
        : "Erreur Google inconnue.";
  if (code === "10" || /DEVELOPER_ERROR/i.test(rawMessage)) {
    return `Google OAuth refuse cette application : ${rawMessage} (code 10 / DEVELOPER_ERROR). Vérifiez le package Android et les SHA-1/SHA-256 du certificat EAS dans Firebase, ainsi que le client OAuth Android correspondant dans Google Cloud Console.`;
  }
  return `Google : ${rawMessage} (code ${code}).`;
};

export default function GoogleAuthScreen() {
  const { setSession } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialConfigurationError,
  );
  const unavailable = initialConfigurationError !== null;
  const disabled = isLoading || unavailable;

  const signIn = async () => {
    if (
      !validGoogleClientId(googleWebClientId) ||
      initialConfigurationError ||
      isLoading
    ) {
      setErrorMessage(
        initialConfigurationError ??
          "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID invalide (code GOOGLE_WEB_CLIENT_ID_INVALID).",
      );
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
      GoogleSignin.configure({
        webClientId: googleWebClientId,
        ...(Platform.OS === "ios" && googleIosClientId
          ? { iosClientId: googleIosClientId }
          : {}),
      });
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const result = await GoogleSignin.signIn();
      if (result.type === "cancelled") return;
      const idToken = result.data.idToken;
      if (!idToken) {
        setErrorMessage(
          "Google n'a pas fourni de jeton d'identité. Vérifiez le client OAuth Web (code GOOGLE_ID_TOKEN_MISSING).",
        );
        return;
      }

      const { data } = await api.post("/api/v1/auth/google", {
        id_token: idToken,
      });
      const response = data as { token?: unknown; user?: unknown };
      const user = response.user as AuthUser | undefined;
      if (typeof response.token !== "string" || !user || typeof user.id !== "string") {
        throw new Error("La réponse de connexion Google est invalide.");
      }
      await setSession(response.token, user);
    } catch (error) {
      const reason = googleErrorMessage(error);
      console.warn("La connexion Google a échoué:", reason);
      setErrorMessage(reason);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => void signIn()}
      style={[styles.button, disabled && styles.disabled]}
    >
      <View style={styles.googleMark}>
        <Text style={styles.googleMarkText}>G</Text>
      </View>
      <Text style={styles.buttonText}>
        {isLoading
          ? "Connexion en cours..."
          : unavailable
            ? "Connexion Google indisponible"
            : errorMessage
              ? "Réessayer avec Google"
            : "Continuer avec Google"}
      </Text>
      {errorMessage && (
        <Text accessibilityRole="alert" selectable style={styles.errorText}>
          {errorMessage}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 14,
  },
  errorText: {
    color: "#b91c1c",
    flexBasis: "100%",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
  },
  disabled: { opacity: 0.55 },
  googleMark: {
    alignItems: "center",
    borderColor: "#e2e8f0",
    borderRadius: 12,
    borderWidth: 1,
    height: 28,
    justifyContent: "center",
    marginRight: 10,
    width: 28,
  },
  googleMarkText: { color: "#4285f4", fontSize: 17, fontWeight: "800" },
  buttonText: { color: "#1e293b", fontSize: 15, fontWeight: "600" },
});
