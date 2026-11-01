import {
  useFocusEffect,
  useNavigation,
  type CompositeNavigationProp,
} from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useCallback, useState } from "react";
import api from "../services/api";
import type { MainTabParamList, RootStackParamList } from "./types";
import ProDashboardScreen from "../screens/pro/ProDashboardScreen";
import { PROMO_FREE_ACCESS_BANNER } from "../config/monetization";

type PlanType =
  | "ALLIANCE_PRO"
  | "SYNDIC"
  | "TOWN_HALL"
  | "SECURITY_AGENT"
  | "WHOLESALER"
  | "TRANSPORT_COMPANY";

type ProNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, "EspacePro">,
  NativeStackNavigationProp<RootStackParamList>
>;

type Subscription = {
  plan_type: PlanType;
  status: "ACTIVE";
  starts_at: string;
  expires_at: string;
};
type ActiveSpace = PlanType | "SPONSORED_PIN";

const isPlanType = (value: unknown): value is PlanType =>
  value === "ALLIANCE_PRO" ||
  value === "SYNDIC" ||
  value === "TOWN_HALL" ||
  value === "SECURITY_AGENT" ||
  value === "WHOLESALER" ||
  value === "TRANSPORT_COMPANY";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isActiveSpace = (value: unknown): value is ActiveSpace =>
  value === "SPONSORED_PIN" || isPlanType(value);
const isActiveSpaceList = (value: unknown): value is ActiveSpace[] =>
  Array.isArray(value) && value.every(isActiveSpace);

export default function ProTabNavigator() {
  const navigation = useNavigation<ProNavigation>();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoFreeAccess, setPromoFreeAccess] = useState(false);
  const [billingDisabled, setBillingDisabled] = useState(false);
  const [activeSpaces, setActiveSpaces] = useState<ActiveSpace[]>([]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      setIsLoading(true);
      setError(null);
      void (async () => {
        try {
          const response = await api.get<unknown>(
            "/v1/pro/me/subscription",
            { headers: { "Cache-Control": "no-cache" } },
          );
          if (
            !isRecord(response.data) ||
            !("subscription" in response.data) ||
            !isActiveSpaceList(response.data.active_spaces)
          ) {
            throw new Error("La réponse de l'abonnement Pro est invalide.");
          }
          const activeSubscription = response.data.subscription;
          if (!isActive) return;
          setActiveSpaces(response.data.active_spaces);
          setPromoFreeAccess(response.data.promo_free_access === true);
          setBillingDisabled(response.data.billing_enabled === false);
          if (activeSubscription === null) {
            if (!isActive) return;
            setSubscription(null);
            setIsLoading(false);
            if (!response.data.active_spaces.includes("SPONSORED_PIN")) {
              navigation.navigate("Checkout");
            }
            return;
          }
          if (
            !isRecord(activeSubscription) ||
            activeSubscription.status !== "ACTIVE" ||
            !isPlanType(activeSubscription.plan_type)
          ) {
            if (!isActive) return;
            setSubscription(null);
            setIsLoading(false);
            navigation.navigate("Checkout");
            return;
          }
          if (
            typeof activeSubscription.starts_at !== "string" ||
            typeof activeSubscription.expires_at !== "string"
          ) {
            throw new Error("Les dates de l'abonnement Pro sont invalides.");
          }
          if (isActive) {
            setSubscription({
              plan_type: activeSubscription.plan_type,
              status: "ACTIVE",
              starts_at: activeSubscription.starts_at,
              expires_at: activeSubscription.expires_at,
            });
          }
        } catch (requestError) {
          if (!isActive) return;
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Impossible de vérifier votre abonnement Pro.",
          );
        } finally {
          if (isActive) setIsLoading(false);
        }
      })();
      return () => {
        isActive = false;
      };
    }, [navigation]),
  );

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#2563eb" size="large" />
        <Text style={styles.message}>Vérification de votre abonnement…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centered}>
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      </View>
    );
  }
  if (!subscription && activeSpaces.includes("SPONSORED_PIN")) {
    return (
      <View style={styles.centered}>
        <Text style={styles.growthTitle}>Épingle sponsorisée active</Text>
        <Text style={styles.message}>
          Votre épingle est active jusqu’à son expiration. Vous pouvez la renouveler depuis les offres Pro.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Checkout", { offer: "SPONSORED_PIN" })}
          style={styles.growthButton}
        >
          <Text style={styles.growthButtonText}>Renouveler l’épingle</Text>
        </Pressable>
      </View>
    );
  }
  if (!subscription) return <View style={styles.centered} />;

  const displayedSubscription = subscription;

  return (
    <View style={styles.dashboard}>
      {(promoFreeAccess || billingDisabled) && (
        <>
          <View accessibilityRole="summary" style={styles.promoBanner}>
            <Text style={styles.promoText}>
              {billingDisabled
                ? "Gratuit pendant la phase de test"
                : PROMO_FREE_ACCESS_BANNER}
            </Text>
          </View>
        </>
      )}
      {displayedSubscription.plan_type === "WHOLESALER" ||
      displayedSubscription.plan_type === "TRANSPORT_COMPANY" ? (
        <View style={styles.growthPanel}>
          <Text style={styles.growthTitle}>
            {displayedSubscription.plan_type === "WHOLESALER"
              ? "Espace Grossiste actif"
              : "Espace Compagnie de transport actif"}
          </Text>
          <Text style={styles.growthCopy}>
            Votre abonnement est actif jusqu’au{" "}
            {new Date(displayedSubscription.expires_at).toLocaleDateString("fr-FR")}.
          </Text>
          {displayedSubscription.plan_type === "WHOLESALER" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("Grossistes")}
              style={styles.growthButton}
            >
              <Text style={styles.growthButtonText}>Ouvrir l’espace Grossistes</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <ProDashboardScreen subscription={displayedSubscription} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dashboard: { backgroundColor: "#f8fafc", flex: 1 },
  centered: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  message: { color: "#64748b", fontSize: 14, marginTop: 12 },
  error: { color: "#b91c1c", fontSize: 14, textAlign: "center" },
  promoBanner: {
    backgroundColor: "#dcfce7",
    borderColor: "#86efac",
    borderRadius: 9,
    borderWidth: 1,
    marginHorizontal: 12,
    marginTop: 8,
    padding: 9,
  },
  promoText: { color: "#166534", fontSize: 12, fontWeight: "700", textAlign: "center" },
  growthPanel: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 14,
    borderWidth: 1,
    margin: 16,
    padding: 18,
  },
  growthTitle: { color: "#172b4d", fontSize: 18, fontWeight: "800" },
  growthCopy: { color: "#64748b", fontSize: 13, lineHeight: 20, marginTop: 8 },
  growthButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 9,
    marginTop: 16,
    padding: 12,
  },
  growthButtonText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
});
