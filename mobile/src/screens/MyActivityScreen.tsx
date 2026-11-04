import { useEffect, useState } from "react";
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from "@react-navigation/native";
import {
  ActivityIndicator,
  Modal,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowLeft, Plus } from "lucide-react-native";
import { API_BASE_URL, apiFetch } from "../services/api";
import type { RootStackParamList } from "../navigation/types";

type Activity = RootStackParamList["MyActivity"]["activity"];
type ActivityItem = {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  imageUrl?: string;
};
type AppealableReport = {
  id: string;
  content: string;
  reason: string;
  reviewed_at: string;
  media_type?: string;
  score?: number | null;
  is_media_moderation?: boolean;
  is_conflict?: boolean;
};

const TITLES: Record<Activity, string> = {
  listings: "Mes Annonces & Produits",
  services: "Mes Services proposés",
  alerts: "Mes Alertes & Signalements émis",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getRows = (value: unknown, key: string): unknown[] => {
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
};

export default function MyActivityScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "MyActivity">>();
  const activity = route.params.activity;
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [appealableReports, setAppealableReports] = useState<AppealableReport[]>([]);
  const [appealReportId, setAppealReportId] = useState<string | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const [appealError, setAppealError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      if (!API_BASE_URL) {
        setError("Le service est momentanément indisponible.");
        setLoading(false);
        return;
      }
      try {
        const url = activity === "alerts"
          ? `${API_BASE_URL}/v1/users/me/activities`
          : `${API_BASE_URL}/v1/users/me/marketplace-items?item_type=${activity === "services" ? "service" : "products"}`;
        const response = await apiFetch(url, {
          headers: { "Cache-Control": "no-cache" },
        });
        let payload: unknown = {};
        if (response.ok) payload = await response.json();
        else if (activity !== "alerts" || response.status !== 403) {
          throw new Error("Chargement refusé.");
        }
        let appealable: AppealableReport[] = [];
        if (activity === "alerts") {
          const appealResponse = await apiFetch(
            `${API_BASE_URL}/v1/admin/appealable-reports`,
            { headers: { "Cache-Control": "no-cache" } },
          );
          if (appealResponse.ok) {
            const appealPayload: unknown = await appealResponse.json();
            const reportRows = getRows(appealPayload, "reports").filter(
              (entry): entry is AppealableReport =>
                isRecord(entry) &&
                typeof entry.id === "string" &&
                typeof entry.content === "string" &&
                typeof entry.reason === "string" &&
                typeof entry.reviewed_at === "string",
            );
            const moderationRows = getRows(
              appealPayload,
              "moderation_events",
            ).flatMap((entry): AppealableReport[] =>
              isRecord(entry) &&
              typeof entry.id === "string" &&
              typeof entry.media_type === "string" &&
              typeof entry.status === "string" &&
              typeof entry.created_at === "string"
                ? [{
                    id: entry.id,
                    content: `${entry.media_type === "video" ? "Vidéo" : "Photo"} · score ${typeof entry.score === "number" ? `${entry.score}%` : "indisponible"}`,
                    reason: "Décision de modération du média",
                    reviewed_at: entry.created_at,
                    media_type: entry.media_type,
                    score: typeof entry.score === "number" ? entry.score : null,
                    is_media_moderation: true,
                  }]
                : [],
            );
            const conflictRows = getRows(appealPayload, "conflicts").flatMap(
              (entry): AppealableReport[] =>
                isRecord(entry) &&
                typeof entry.id === "string" &&
                typeof entry.category === "string" &&
                typeof entry.created_at === "string"
                  ? [{
                      id: entry.id,
                      content: `Décision de modération du texte public · ${entry.category}`,
                      reason: "Décision de modération d’un conflit",
                      reviewed_at: entry.created_at,
                      is_conflict: true,
                    }]
                  : [],
            );
            appealable = [...reportRows, ...moderationRows, ...conflictRows];
          } else {
            throw new Error("Impossible de charger les recours.");
          }
        }
        const source = activity === "alerts"
          ? [...getRows(payload, "alerts"), ...getRows(payload, "reports")]
          : getRows(payload, "items");
        const normalized = source.flatMap((entry): ActivityItem[] => {
          if (!isRecord(entry) || typeof entry.id !== "string") return [];
          return [{
            id: entry.id,
            title: String(
              entry.title ??
                (entry.emergency_type
                  ? `Alerte ${String(entry.emergency_type).toLowerCase()}`
                  : entry.target_type
                    ? `Signalement ${String(entry.target_type).toLowerCase()}`
                    : "Activité"),
            ),
            description: String(entry.description ?? entry.reason ?? ""),
            status: String(entry.status ?? ""),
            createdAt: String(entry.created_at ?? ""),
            ...(typeof entry.image_url === "string"
              ? { imageUrl: entry.image_url }
              : {}),
          }];
        });
        if (active) {
          setItems(normalized);
          setAppealableReports(appealable);
          setError(null);
        }
      } catch {
        if (active) setError("Impossible de charger vos activités. Réessayez.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [activity, retryKey]);

  const create = () => {
    if (activity === "alerts") {
      navigation.navigate("Main", { screen: "CarteSOS" });
      return;
    }
    navigation.navigate("Main", {
      screen: "Marche",
      params: {
        voiceRequestId: String(Date.now()),
        voiceCreateListing: true,
        voiceCreateType: activity === "services" ? "service" : "listing",
      },
    });
  };

  const submitAppeal = async () => {
    if (!appealReportId || appealReason.trim().length < 10 || appealReason.trim().length > 500) {
      setAppealError("Le recours doit contenir entre 10 et 500 caractères.");
      return;
    }
    try {
      const appealable = appealableReports.find((entry) => entry.id === appealReportId);
      const appealUrl = appealable?.is_conflict
        ? `${API_BASE_URL}/v1/admin/conflicts/${encodeURIComponent(appealReportId)}/appeal`
        : appealable?.is_media_moderation
          ? `${API_BASE_URL}/v1/admin/post-moderation-events/${encodeURIComponent(appealReportId)}/appeal`
          : `${API_BASE_URL}/v1/admin/reports/${encodeURIComponent(appealReportId)}/appeal`;
      const response = await apiFetch(appealUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: appealReason.trim() }),
      });
      if (!response.ok) {
        const result: unknown = await response.json();
        throw new Error(
          isRecord(result) && typeof result.error === "string"
            ? result.error
            : "Le recours n'a pas pu être envoyé.",
        );
      }
      setAppealableReports((current) =>
        current.filter((entry) => entry.id !== appealReportId),
      );
      setAppealReportId(null);
      setAppealReason("");
      setAppealError(null);
    } catch (submitError) {
      setAppealError(
        submitError instanceof Error ? submitError.message : "Le recours n'a pas pu être envoyé.",
      );
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Retour" accessibilityRole="button" onPress={() => navigation.goBack()}>
          <ArrowLeft color="#334155" size={23} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{TITLES[activity]}</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#2563eb" size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => setRetryKey((value) => value + 1)} style={styles.button}>
            <Text style={styles.buttonText}>Réessayer</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={create} style={styles.button}>
            <Plus color="#ffffff" size={19} />
            <Text style={styles.buttonText}>{activity === "alerts" ? "Créer une alerte" : "Créer"}</Text>
          </Pressable>
        </View>
      ) : items.length === 0 && appealableReports.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Rien à afficher pour le moment</Text>
          <Text style={styles.emptyCopy}>
            Vos publications apparaîtront ici après leur création.
          </Text>
          <Pressable accessibilityRole="button" onPress={create} style={styles.button}>
            <Plus color="#ffffff" size={19} />
            <Text style={styles.buttonText}>{activity === "alerts" ? "Créer une alerte" : "Créer"}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {appealableReports.map((report) => (
            <View key={`appeal-${report.id}`} style={styles.card}>
              <Text style={styles.itemTitle}>Décision de modération contestable</Text>
              <Text style={styles.copy}>{report.content}</Text>
              <Text style={styles.meta}>
                {report.reason} · {new Date(report.reviewed_at).toLocaleDateString("fr-FR")}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setAppealReportId(report.id);
                  setAppealError(null);
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Contester cette décision</Text>
              </Pressable>
            </View>
          ))}
          {items.map((item) => (
            <View key={item.id} style={styles.card}>
              {item.imageUrl ? <Image source={{ uri: item.imageUrl }} style={styles.image} /> : null}
              <Text style={styles.itemTitle}>{item.title}</Text>
              {item.description ? <Text style={styles.copy}>{item.description}</Text> : null}
              <Text style={styles.meta}>
                {[item.status, item.createdAt ? new Date(item.createdAt).toLocaleDateString("fr-FR") : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
          <Pressable accessibilityRole="button" onPress={create} style={styles.button}>
            <Plus color="#ffffff" size={19} />
            <Text style={styles.buttonText}>{activity === "alerts" ? "Créer une alerte" : "Créer"}</Text>
          </Pressable>
        </ScrollView>
      )}
      <Modal
        animationType="slide"
        onRequestClose={() => setAppealReportId(null)}
        transparent
        visible={appealReportId !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.itemTitle}>Motif du recours</Text>
            <TextInput
              maxLength={500}
              multiline
              onChangeText={setAppealReason}
              placeholder="Expliquez pourquoi cette décision doit être réexaminée (10 à 500 caractères)."
              style={styles.appealInput}
              value={appealReason}
            />
            {appealError ? <Text style={styles.error}>{appealError}</Text> : null}
            <Pressable accessibilityRole="button" onPress={() => void submitAppeal()} style={styles.button}>
              <Text style={styles.buttonText}>Envoyer le recours</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setAppealReportId(null)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Annuler</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#f8fafc", flex: 1, padding: 18, paddingTop: 54 },
  header: { alignItems: "center", flexDirection: "row", gap: 14, marginBottom: 18 },
  title: { color: "#172b4d", flex: 1, fontSize: 20, fontWeight: "800" },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: 24 },
  error: { color: "#b91c1c", textAlign: "center" },
  empty: { alignItems: "center", flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  emptyTitle: { color: "#172b4d", fontSize: 18, fontWeight: "700" },
  emptyCopy: { color: "#64748b", lineHeight: 21, marginTop: 8, textAlign: "center" },
  list: { gap: 12, paddingBottom: 28 },
  card: { backgroundColor: "#fff", borderColor: "#e2e8f0", borderRadius: 12, borderWidth: 1, padding: 14 },
  image: { borderRadius: 8, height: 150, marginBottom: 10, width: "100%" },
  itemTitle: { color: "#172b4d", fontSize: 16, fontWeight: "700" },
  copy: { color: "#475569", lineHeight: 20, marginTop: 6 },
  meta: { color: "#64748b", fontSize: 12, marginTop: 9 },
  button: { alignItems: "center", alignSelf: "stretch", backgroundColor: "#2563eb", borderRadius: 10, flexDirection: "row", gap: 8, justifyContent: "center", marginTop: 14, minHeight: 48 },
  buttonText: { color: "#fff", fontWeight: "700" },
  modalBackdrop: { backgroundColor: "rgba(15,23,42,0.6)", flex: 1, justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, gap: 12, padding: 20, paddingBottom: 34 },
  appealInput: { borderColor: "#cbd5e1", borderRadius: 10, borderWidth: 1, color: "#172b4d", minHeight: 120, padding: 12, textAlignVertical: "top" },
  cancelButton: { alignItems: "center", minHeight: 42, justifyContent: "center" },
  cancelText: { color: "#334155", fontWeight: "700" },
});
