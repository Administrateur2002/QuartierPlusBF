import axios from "axios";
import { useEffect, useMemo, useState } from "react";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth, type AuthUser } from "../../context/AuthContext";
import api from "../../services/api";
import GoogleAuthScreen from "./GoogleAuthScreen";
import LegalDocumentsModal from "../../components/LegalDocumentsModal";
import {
  EMBEDDED_PHONE_COUNTRIES,
  formatPhoneNumberE164,
  parseInternationalPhone,
  type PhoneCountry,
} from "./phoneNumber";
import type { RootStackParamList } from "../../navigation/types";

type AuthMode = "login" | "register";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const AUTH_WAKE_TIMEOUT_MS = 60_000;
const AUTH_RETRY_TIMEOUT_MS = 15_000;
const AUTH_RETRY_DELAY_MS = 2_000;

const requestWhileServerWakes = async <T,>(path: string, data: unknown) => {
  const deadline = Date.now() + AUTH_WAKE_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      return await api.post<T>(path, data, {
        timeout: Math.min(AUTH_RETRY_TIMEOUT_MS, remaining),
      });
    } catch (error) {
      lastError = error;
      const apiError =
        axios.isAxiosError(error) &&
        isRecord(error.response?.data) &&
        typeof error.response.data.error === "string";
      const retryable =
        axios.isAxiosError(error) &&
        (!error.response ||
          (!apiError && [502, 503, 504].includes(error.response.status)));
      if (!retryable) throw error;
      const wait = Math.min(AUTH_RETRY_DELAY_MS, deadline - Date.now());
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  if (lastError && !axios.isAxiosError(lastError)) throw lastError;
  throw new Error(
    "Le serveur met plus de temps que prévu à se réveiller. Réessayez dans un instant.",
  );
};

const responseError = (error: unknown, fallback: string) => {
  if (axios.isAxiosError(error)) {
    const responseData: unknown = error.response?.data;
    if (
      isRecord(responseData) &&
      typeof responseData.error === "string" &&
      responseData.error.trim()
    ) {
      return responseData.error;
    }
    if (!error.response || error.code === "ECONNABORTED") {
      return "Le serveur met plus de temps que prévu à se réveiller. Réessayez dans un instant.";
    }
  }
  return error instanceof Error ? error.message : fallback;
};

const isValidEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export default function PhoneAuthScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "PhoneAuth">>();
  const { setSession, user } = useAuth();
  const [mode, setMode] = useState<AuthMode>(route.params?.mode ?? "login");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [manualCountryCode, setManualCountryCode] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [legalDocumentsVisible, setLegalDocumentsVisible] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpChannel, setOtpChannel] = useState<"sms" | "email">("sms");
  const [otpIdentifier, setOtpIdentifier] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerRegistration, setOfferRegistration] = useState(false);

  const detectedPhone = useMemo(
    () => parseInternationalPhone(phone, manualCountryCode),
    [manualCountryCode, phone],
  );
  const ambiguousCountries = detectedPhone?.possibleCountries ?? [];
  const manuallySelectedCountry = EMBEDDED_PHONE_COUNTRIES.find(
    (country) => country.code === manualCountryCode,
  );

  useEffect(() => {
    if (!user) return;
    const hasCompletedProfile =
      typeof user.name === "string" && user.name.trim().length > 0;
    if (!hasCompletedProfile) {
      navigation.replace("CompleteProfile");
    } else if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.replace("Main", { screen: "Accueil" });
    }
  }, [navigation, user]);

  useEffect(() => {
    if (secondsRemaining <= 0) return undefined;
    const timer = setTimeout(() => {
      setSecondsRemaining((remaining) => Math.max(remaining - 1, 0));
    }, 1000);
    return () => clearTimeout(timer);
  }, [secondsRemaining]);

  const fullPhoneNumber = () => {
    return formatPhoneNumberE164(phone, manualCountryCode);
  };

  const normalizedIdentifier = () => {
    const value = identifier.trim();
    if (value.includes("@")) return value.toLowerCase();
    return formatPhoneNumberE164(value, manualCountryCode);
  };

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setOfferRegistration(false);
    setOtpRequested(false);
    setOtp("");
  };

  const requestOtp = async () => {
    setError(null);
    setOfferRegistration(false);

    let payload: Record<string, unknown>;
    try {
      if (mode === "register") {
        if (!firstName.trim() || !lastName.trim()) {
          throw new Error("Saisissez votre prénom et votre nom.");
        }
        if (firstName.trim().length > 100 || lastName.trim().length > 100) {
          throw new Error("Le prénom et le nom ne doivent pas dépasser 100 caractères.");
        }
        if (`${firstName.trim()} ${lastName.trim()}`.length > 100) {
          throw new Error("Le prénom et le nom réunis ne doivent pas dépasser 100 caractères.");
        }
        if (!isValidEmail(email)) {
          throw new Error("Saisissez une adresse e-mail valide.");
        }
        if (!termsAccepted) {
          throw new Error("Vous devez accepter les conditions et la politique de confidentialité.");
        }
        if (!ageConfirmed) {
          throw new Error("La création d’un compte est réservée aux personnes âgées d’au moins 16 ans.");
        }
        const phoneNumber = fullPhoneNumber();
        const countryCode =
          parseInternationalPhone(phoneNumber, manualCountryCode)?.country?.code ??
          manualCountryCode;
        if (!countryCode) {
          throw new Error("Choisissez le pays correspondant à cet indicatif partagé.");
        }
        payload = {
          flow: "register",
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          country_code: countryCode,
          phone_number: phoneNumber,
          email: email.trim().toLowerCase(),
          terms_accepted: true,
          age_16_or_older: true,
          channel: otpChannel,
        };
      } else {
        const normalized = normalizedIdentifier();
        if (!normalized.startsWith("+") && !isValidEmail(normalized)) {
          throw new Error("Saisissez un téléphone avec indicatif (+226…) ou une adresse e-mail valide.");
        }
        payload = { flow: "login", identifier: normalized, channel: otpChannel };
      }
    } catch (validationError) {
      setError(responseError(validationError, "Vérifiez les informations saisies."));
      return;
    }

    setIsLoading(true);
    try {
      const response = await requestWhileServerWakes<{
        challenge_identifier?: string;
      }>(
        `/api/v1/auth/request-otp?channel=${otpChannel}`,
        payload,
      );
      setOtpRequested(true);
      setOtp("");
      const inputIdentifier =
        mode === "register" ? fullPhoneNumber() : normalizedIdentifier();
      setOtpIdentifier(response.data.challenge_identifier ?? inputIdentifier);
      setSecondsRemaining(60);
    } catch (requestError) {
      const message = responseError(requestError, "Impossible d'envoyer le code de vérification.");
      setError(message);
      if (axios.isAxiosError(requestError) && requestError.response?.status === 404) {
        setOfferRegistration(true);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const verifyOtp = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const response = await requestWhileServerWakes<{
        token?: unknown;
        user?: unknown;
      }>("/api/v1/auth/verify-otp", {
        identifier: otpIdentifier,
        code: otp,
        channel: otpChannel,
      });
      const data = response.data;
      const user = data.user as AuthUser | undefined;
      if (typeof data.token !== "string" || !user || typeof user.id !== "string") {
        throw new Error("La réponse d'authentification est invalide.");
      }
      await setSession(data.token, user);
    } catch (verificationError) {
      setError(responseError(verificationError, "La vérification a échoué."));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandMark}>
          <Text style={styles.brandMarkText}>Q+</Text>
        </View>
        <Text style={styles.title}>
          {mode === "register" ? "Créer votre compte" : "Bienvenue sur QuartierPlus"}
        </Text>
        <Text style={styles.subtitle}>
          {mode === "register"
            ? "Rejoignez votre communauté en quelques étapes."
            : "Connectez-vous avec votre téléphone ou votre adresse e-mail."}
        </Text>

        <View style={styles.modeSwitch}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: mode === "login" }}
            onPress={() => switchMode("login")}
            style={[styles.modeButton, mode === "login" && styles.modeButtonSelected]}
          >
            <Text style={[styles.modeText, mode === "login" && styles.modeTextSelected]}>
              Connexion
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: mode === "register" }}
            onPress={() => switchMode("register")}
            style={[styles.modeButton, mode === "register" && styles.modeButtonSelected]}
          >
            <Text style={[styles.modeText, mode === "register" && styles.modeTextSelected]}>
              Inscription
            </Text>
          </Pressable>
        </View>

        {mode === "register" ? (
          <>
            <Text style={styles.label}>Prénom(s)</Text>
            <TextInput
              accessibilityLabel="Prénom(s)"
              autoCapitalize="words"
              autoComplete="given-name"
              onChangeText={setFirstName}
              placeholder="Votre prénom"
              placeholderTextColor="#94a3b8"
              style={styles.textInput}
              value={firstName}
            />
            <Text style={styles.label}>Nom</Text>
            <TextInput
              accessibilityLabel="Nom"
              autoCapitalize="words"
              autoComplete="family-name"
              onChangeText={setLastName}
              placeholder="Votre nom"
              placeholderTextColor="#94a3b8"
              style={styles.textInput}
              value={lastName}
            />

            <Text style={styles.label}>Téléphone avec indicatif</Text>
            <TextInput
              accessibilityLabel="Téléphone avec indicatif"
              autoComplete="tel"
              keyboardType="phone-pad"
              onChangeText={(value) => {
                setPhone(value);
                setManualCountryCode(undefined);
              }}
              placeholder="+226 56 11 95 67 ou 0022656119567"
              placeholderTextColor="#94a3b8"
              style={styles.textInput}
              value={phone}
            />
            <Text style={styles.helper}>
              {phone.trim() && !phone.trim().startsWith("+") && !phone.trim().startsWith("00")
                ? "Saisissez l’indicatif, par exemple +226…"
                : detectedPhone?.country || manuallySelectedCountry
                  ? `${detectedPhone?.country?.name ?? manuallySelectedCountry?.name} détecté · ${detectedPhone?.e164 ?? fullPhoneNumber()}`
                  : "Saisissez le numéro complet, avec son indicatif international."}
            </Text>
            {!detectedPhone?.country && ambiguousCountries.length > 1 && (
              <View style={styles.countryList}>
                {ambiguousCountries.map((country: PhoneCountry) => {
                  const selected = manualCountryCode === country.code;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={country.code}
                      onPress={() => setManualCountryCode(country.code)}
                      style={[styles.countryOption, selected && styles.countryOptionSelected]}
                    >
                      <Text
                        style={[
                          styles.countryOptionText,
                          selected && styles.countryOptionTextSelected,
                        ]}
                        numberOfLines={1}
                      >
                        {country.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>E-mail</Text>
            <TextInput
              accessibilityLabel="Adresse e-mail"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="vous@exemple.com"
              placeholderTextColor="#94a3b8"
              style={styles.textInput}
              value={email}
            />
            <Text style={styles.label}>Recevoir le code par</Text>
            <View style={styles.modeSwitch}>
              {(["sms", "email"] as const).map((channel) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: otpChannel === channel }}
                  key={channel}
                  onPress={() => setOtpChannel(channel)}
                  style={[styles.modeButton, otpChannel === channel && styles.modeButtonSelected]}
                >
                  <Text
                    style={[styles.modeText, otpChannel === channel && styles.modeTextSelected]}
                    numberOfLines={1}
                  >
                    {channel === "sms" ? "SMS" : "E-mail"}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: termsAccepted }}
              onPress={() => setTermsAccepted((accepted) => !accepted)}
              style={styles.consentRow}
            >
              <View style={[styles.checkbox, termsAccepted && styles.checkboxChecked]}>
                {termsAccepted && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={styles.consentText}>
                J’accepte les conditions d’utilisation et la politique de confidentialité.
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setLegalDocumentsVisible(true)}
              style={styles.consentLink}
            >
              <Text style={styles.consentLinkText}>Lire les documents légaux</Text>
            </Pressable>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ageConfirmed }}
              onPress={() => setAgeConfirmed((confirmed) => !confirmed)}
              style={styles.consentRow}
            >
              <View style={[styles.checkbox, ageConfirmed && styles.checkboxChecked]}>
                {ageConfirmed && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={styles.consentText}>
                Je confirme avoir au moins 16 ans.
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.label}>Téléphone avec indicatif ou e-mail</Text>
            <TextInput
              accessibilityLabel="Téléphone avec indicatif ou adresse e-mail"
              autoCapitalize="none"
              autoComplete="username"
              keyboardType="email-address"
              onChangeText={(value) => {
                setIdentifier(value);
                setPhone(value);
                setManualCountryCode(undefined);
                setOfferRegistration(false);
              }}
              placeholder="+226 70 00 00 00 ou vous@exemple.com"
              placeholderTextColor="#94a3b8"
              style={styles.textInput}
              value={identifier}
            />
            {identifier.trim() && !identifier.includes("@") && (
              <Text style={styles.helper}>
                {detectedPhone?.country || manuallySelectedCountry
                  ? `${detectedPhone?.country?.name ?? manuallySelectedCountry?.name} détecté · ${detectedPhone?.e164 ?? fullPhoneNumber()}`
                  : !identifier.trim().startsWith("+") && !identifier.trim().startsWith("00")
                    ? "Saisissez l’indicatif, par exemple +226…"
                    : "Saisissez un numéro international valide."}
              </Text>
            )}
            {!identifier.includes("@") && !detectedPhone?.country && ambiguousCountries.length > 1 && (
              <View style={styles.countryList}>
                {ambiguousCountries.map((country) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: manualCountryCode === country.code }}
                    key={country.code}
                    onPress={() => setManualCountryCode(country.code)}
                    style={[
                      styles.countryOption,
                      manualCountryCode === country.code && styles.countryOptionSelected,
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.countryOptionText,
                        manualCountryCode === country.code && styles.countryOptionTextSelected,
                      ]}
                    >
                      {country.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {mode === "login" && !otpRequested && (
          <>
            <Text style={styles.label}>Recevoir le code par</Text>
            <View style={styles.modeSwitch}>
              {(["sms", "email"] as const).map((channel) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: otpChannel === channel }}
                  key={channel}
                  onPress={() => setOtpChannel(channel)}
                  style={[styles.modeButton, otpChannel === channel && styles.modeButtonSelected]}
                >
                  <Text
                    style={[styles.modeText, otpChannel === channel && styles.modeTextSelected]}
                    numberOfLines={1}
                  >
                    {channel === "sms" ? "SMS" : "E-mail"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {otpRequested && (
          <>
            <Text style={styles.label}>Code de vérification</Text>
            <Text style={styles.helper}>
              Un code à six chiffres a été envoyé par {otpChannel === "sms" ? "SMS" : "e-mail"}.
            </Text>
            <TextInput
              accessibilityLabel="Code OTP à six chiffres"
              autoComplete="one-time-code"
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={(value) => setOtp(value.replace(/\D/g, ""))}
              placeholder="••••••"
              placeholderTextColor="#94a3b8"
              style={[styles.textInput, styles.otpInput]}
              value={otp}
            />
            <Pressable
              accessibilityRole="button"
              disabled={secondsRemaining > 0 || isLoading}
              onPress={() => void requestOtp()}
            >
              <Text
                style={[
                  styles.resend,
                  (secondsRemaining > 0 || isLoading) && styles.disabledText,
                ]}
              >
                {secondsRemaining > 0
                  ? `Renvoyer le code dans ${secondsRemaining}s`
                  : "Renvoyer le code"}
              </Text>
            </Pressable>
          </>
        )}

        {isLoading && (
          <Text style={styles.wakingMessage}>
            Le serveur se réveille… Cela peut prendre jusqu’à une minute.
          </Text>
        )}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

        <Pressable
          accessibilityRole="button"
          disabled={isLoading || (otpRequested && otp.length !== 6)}
          onPress={() => void (otpRequested ? verifyOtp() : requestOtp())}
          style={[
            styles.primaryButton,
            (isLoading || (otpRequested && otp.length !== 6)) && styles.buttonDisabled,
          ]}
        >
          {isLoading ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {otpRequested
                ? "Vérifier et continuer"
                : mode === "register"
                  ? "Créer mon compte et recevoir un code"
                  : "Recevoir un code"}
            </Text>
          )}
        </Pressable>

        {offerRegistration && mode === "login" && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
                if (identifier.includes("@")) setEmail(identifier.trim());
              else setPhone(identifier.trim());
                switchMode("register");
              }}
            style={styles.registerOffer}
          >
            <Text style={styles.registerOfferText}>Créer un compte</Text>
          </Pressable>
        )}

        {mode === "login" && (
          <>
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>ou</Text>
              <View style={styles.dividerLine} />
            </View>
            <GoogleAuthScreen />
          </>
        )}
      </ScrollView>
      <LegalDocumentsModal
        onClose={() => setLegalDocumentsVisible(false)}
        visible={legalDocumentsVisible}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#f8fafc" },
  container: { flexGrow: 1, justifyContent: "center", padding: 24, paddingVertical: 40 },
  brandMark: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#2563eb",
    borderRadius: 18,
    height: 64,
    justifyContent: "center",
    marginBottom: 20,
    width: 64,
  },
  brandMarkText: { color: "#ffffff", fontSize: 22, fontWeight: "800" },
  title: { color: "#0f172a", fontSize: 26, fontWeight: "700", textAlign: "center" },
  subtitle: { color: "#64748b", fontSize: 15, lineHeight: 22, marginBottom: 22, marginTop: 10, textAlign: "center" },
  modeSwitch: { backgroundColor: "#e2e8f0", borderRadius: 12, flexDirection: "row", marginBottom: 12, padding: 4 },
  modeButton: { alignItems: "center", borderRadius: 9, flex: 1, justifyContent: "center", minHeight: 42 },
  modeButtonSelected: { backgroundColor: "#ffffff" },
  modeText: { color: "#64748b", fontSize: 14, fontWeight: "600" },
  modeTextSelected: { color: "#1d4ed8" },
  label: { color: "#334155", fontSize: 14, fontWeight: "600", marginBottom: 8, marginTop: 14 },
  textInput: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderRadius: 12, borderWidth: 1, color: "#0f172a", fontSize: 16, minHeight: 52, paddingHorizontal: 14 },
  countryList: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  countryOption: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderRadius: 18, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  countryOptionSelected: { backgroundColor: "#eff6ff", borderColor: "#2563eb" },
  countryOptionText: { color: "#475569", fontSize: 12 },
  countryOptionTextSelected: { color: "#1d4ed8", fontWeight: "600" },
  phoneInput: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderRadius: 12, borderWidth: 1, flexDirection: "row", paddingHorizontal: 14 },
  prefix: { color: "#0f172a", fontSize: 16, fontWeight: "600", marginRight: 10 },
  phoneTextInput: { color: "#0f172a", flex: 1, fontSize: 16, minHeight: 52 },
  helper: { color: "#64748b", fontSize: 12, lineHeight: 18, marginTop: 8 },
  consentRow: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 20 },
  checkbox: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#94a3b8", borderRadius: 5, borderWidth: 1, height: 22, justifyContent: "center", width: 22 },
  checkboxChecked: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  checkboxTick: { color: "#ffffff", fontSize: 15, fontWeight: "800", lineHeight: 18 },
  consentText: { color: "#475569", flex: 1, fontSize: 13, lineHeight: 19 },
  consentLink: { alignSelf: "flex-start", marginTop: 8, paddingVertical: 5 },
  consentLinkText: { color: "#2563eb", fontSize: 13, fontWeight: "700" },
  otpInput: { fontSize: 22, letterSpacing: 10, textAlign: "center" },
  resend: { color: "#2563eb", fontSize: 14, fontWeight: "600", marginTop: 10, textAlign: "right" },
  disabledText: { color: "#94a3b8" },
  wakingMessage: { color: "#92400e", fontSize: 13, lineHeight: 19, marginTop: 14, textAlign: "center" },
  error: { color: "#b91c1c", fontSize: 14, lineHeight: 20, marginTop: 14 },
  primaryButton: { alignItems: "center", backgroundColor: "#2563eb", borderRadius: 12, justifyContent: "center", marginTop: 22, minHeight: 52, paddingHorizontal: 16 },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "700", textAlign: "center" },
  registerOffer: { alignItems: "center", marginTop: 16, minHeight: 42, justifyContent: "center" },
  registerOfferText: { color: "#1d4ed8", fontSize: 15, fontWeight: "700" },
  divider: { alignItems: "center", flexDirection: "row", gap: 12, marginVertical: 22 },
  dividerLine: { backgroundColor: "#e2e8f0", flex: 1, height: 1 },
  dividerText: { color: "#94a3b8", fontSize: 13 },
});
