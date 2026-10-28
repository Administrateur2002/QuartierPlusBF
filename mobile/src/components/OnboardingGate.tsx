import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState, type PropsWithChildren } from "react";
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

const COMPLETED_KEY = "quartierplus.onboarding.v1";
const SCREENS = [
  {
    title: "Bienvenue dans votre quartier",
    body: "Retrouvez les nouvelles, les services et les personnes qui font vivre votre communauté.",
  },
  {
    title: "Restez proches et solidaires",
    body: "Publiez, échangez et ralliez-vous aux personnes en qui vous avez confiance.",
  },
  {
    title: "Vous gardez le contrôle",
    body: "Votre position reste privée tant que vous ne choisissez pas explicitement de la partager.",
  },
] as const;

export default function OnboardingGate({ children }: PropsWithChildren) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(COMPLETED_KEY)
      .then((completed) => {
        if (active && completed !== "true") setVisible(true);
      })
      .catch((error: unknown) => {
        console.error("Unable to read onboarding completion state:", error);
        if (active) setVisible(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const finish = async () => {
    try {
      await AsyncStorage.setItem(COMPLETED_KEY, "true");
    } catch (error) {
      console.error("Unable to save onboarding completion state:", error);
      Alert.alert(
        "Préférence non enregistrée",
        "L’accueil pourra réapparaître au prochain démarrage.",
      );
    }
    setVisible(false);
  };

  return (
    <>
      {children}
      <Modal
        animationType="fade"
        onRequestClose={() => void finish()}
        transparent
        visible={visible}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {SCREENS[step].title}
            </Text>
            <Text style={styles.body}>{SCREENS[step].body}</Text>
            <View accessibilityLabel={`Étape ${step + 1} sur 3`} style={styles.dots}>
              {SCREENS.map((screen, index) => (
                <View
                  accessibilityLabel={screen.title}
                  key={screen.title}
                  style={[styles.dot, index === step && styles.activeDot]}
                />
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (step === SCREENS.length - 1) void finish();
                else setStep((current) => current + 1);
              }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryText}>
                {step === SCREENS.length - 1 ? "Commencer" : "Continuer"}
              </Text>
            </Pressable>
            {step < SCREENS.length - 1 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void finish()}
                style={styles.skipButton}
              >
                <Text style={styles.skipText}>Passer l’accueil</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.72)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  card: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 24,
    gap: 20,
    padding: 28,
    width: "100%",
  },
  title: {
    color: "#0f172a",
    fontSize: 24,
    fontWeight: "900",
    textAlign: "center",
  },
  body: {
    color: "#475569",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  dots: { flexDirection: "row", gap: 8, paddingVertical: 6 },
  dot: { backgroundColor: "#cbd5e1", borderRadius: 4, height: 8, width: 8 },
  activeDot: { backgroundColor: "#2563eb", width: 24 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 12,
    padding: 14,
    width: "100%",
  },
  primaryText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  skipButton: { padding: 8 },
  skipText: { color: "#475569", fontSize: 13, fontWeight: "700" },
});
