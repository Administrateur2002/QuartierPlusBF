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
  ScrollView,
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

const isPlanType = (value: unknown): value is PlanType =>
  value === "ALLIANCE_PRO" ||
  value === "SYNDIC" ||
  value === "TOWN_HALL" ||
  value === "SECURITY_AGENT" ||
  value === "WHOLESALER" ||
  value === "TRANSPORT_COMPANY";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export default function ProTabNavigator() {
  const navigation = useNavigation<ProNavigation>();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoFreeAccess, setPromoFreeAccess] = useState(false);
  const [billingDisabled, setBillingDisabled] = useState(false);
  const [promoPlan, setPromoPlan] = useState<PlanType>("ALLIANCE_PRO");

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
          if (!isRecord(response.data) || !("subscription" in response.data)) {
            throw new Error("La réponse de l'abonnement Pro est invalide.");
          }
          const activeSubscription = response.data.subscription;
          if (!isActive) return;
          setPromoFreeAccess(response.data.promo_free_access === true);
          setBillingDisabled(response.data.billing_enabled === false);
          if (activeSubscription === null) {
            if (!isActive) return;
            setSubscription(null);
            setIsLoading(false);
            navigation.navigate("Checkout");
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
              plan_type:
                response.data.promo_free_access === true
                  ? promoPlan
                  : activeSubscription.plan_type,
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
    }, [navigation, promoPlan]),
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
  if (!subscription) return <View style={styles.centered} />;

  const displayedSubscription =
    promoFreeAccess && subscription.plan_type !== promoPlan
      ? { ...subscription, plan_type: promoPlan }
      : subscription;

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
          {promoFreeAccess && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.planPicker}
          >
            {PLAN_OPTIONS.map((plan) => (
              <Pressable
                key={plan.id}
                accessibilityRole="button"
                accessibilityState={{ selected: displayedSubscription.plan_type === plan.id }}
                onPress={() => {
                  setPromoPlan(plan.id);
                  setSubscription({ ...displayedSubscription, plan_type: plan.id });
                }}
                style={[
                  styles.planChip,
                  displayedSubscription.plan_type === plan.id && styles.activePlanChip,
                ]}
              >
                <Text
                  style={[
                    styles.planText,
                    displayedSubscription.plan_type === plan.id && styles.activePlanText,
                  ]}
                >
                  {plan.title}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          )}
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

const PLAN_OPTIONS: { id: PlanType; title: string }[] = [
  { id: "ALLIANCE_PRO", title: "Alliance Pro" },
  { id: "SYNDIC", title: "Syndic" },
  { id: "TOWN_HALL", title: "Mairie" },
  { id: "SECURITY_AGENT", title: "Secours" },
  { id: "WHOLESALER", title: "Grossiste" },
  { id: "TRANSPORT_COMPANY", title: "Transport" },
];

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
  planPicker: { alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 8 },
  planChip: { backgroundColor: "#e2e8f0", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  activePlanChip: { backgroundColor: "#2563eb" },
  planText: { color: "#334155", fontSize: 11, fontWeight: "600" },
  activePlanText: { color: "#ffffff" },
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
