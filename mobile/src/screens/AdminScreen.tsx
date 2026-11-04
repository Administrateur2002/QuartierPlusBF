import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BellRing, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../context/ThemeContext";
import api from "../services/api";

type Report = {
  id: string;
  target_type: string;
  target_id: string;
  target_user_id?: string | null;
  target_user_name?: string | null;
  reason: string;
  status: string;
  severity: string;
  content: string;
  media_url?: string | null;
  created_at: string;
  appeal_reason?: string | null;
};

type LiveEvent = {
  id: string;
  participant_id: string;
  participant_name?: string | null;
  media_type: string;
  category: string;
  confidence: number;
  status: string;
  appeal_reason?: string | null;
  created_at: string;
};

type Flash = {
  id: string;
  title: string;
  body: string;
  target_type: string;
  status: string;
  scheduled_at: string;
  sent_at?: string | null;
  recipient_count?: number;
  accepted_count?: number;
  failed_count?: number;
  error_message?: string | null;
};

type Panel = "reports" | "flash" | "history";
type TargetType = "ALL" | "COUNTRY" | "NEIGHBORHOOD" | "REGION";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Une erreur est survenue.";

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date indisponible" : date.toLocaleString("fr-FR");
};

export default function AdminScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<Panel>("reports");
  const [filter, setFilter] = useState("PENDING");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [reports, setReports] = useState<Report[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("ALL");
  const [country, setCountry] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [radius, setRadius] = useState("25");
  const [scheduledAt, setScheduledAt] = useState("");
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (panel === "reports") {
        const result = await api.get<{
          reports: Report[];
          live_events: LiveEvent[];
          counts: Record<string, number>;
        }>(`/v1/admin/dashboard?status=${filter}`, {
          headers: { "Cache-Control": "no-cache" },
        });
        setReports(result.data.reports);
        setEvents(result.data.live_events);
        setCounts(result.data.counts);
      } else if (panel === "flash") {
        const result = await api.get<{ broadcasts: Flash[] }>("/v1/admin/flashes", {
          headers: { "Cache-Control": "no-cache" },
        });
        setFlashes(result.data.broadcasts);
      } else {
        const result = await api.get<{ history: Record<string, unknown>[] }>(
          "/v1/admin/history",
          { headers: { "Cache-Control": "no-cache" } },
        );
        setHistory(result.data.history);
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [filter, panel]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  const visibleReports = reports.filter((report) =>
    severityFilter === "ALL" ||
    (severityFilter === "HIGH" && ["CRITIQUE", "ÉLEVÉ"].includes(report.severity)) ||
    (severityFilter === "NORMAL" && report.severity === "MODÉRÉ"),
  );

  const moderateReport = (report: Report, action: string) => {
    const actionLabel =
      action === "hide" ? "masquer la publication" :
        action === "delete" ? "supprimer le contenu" :
          action === "suspend" ? "suspendre le compte 7 jours" :
            action === "dismiss" ? "classer sans suite" : "marquer comme examiné";
    Alert.alert("Confirmer l'action", `Voulez-vous ${actionLabel} ?`, [
      { text: "Annuler", style: "cancel" },
      {
        text: "Confirmer",
        style: action === "delete" || action === "suspend" ? "destructive" : "default",
        onPress: () => {
          void api
            .post(`/v1/admin/reports/${report.id}/action`, {
              action,
              ...(action === "suspend" ? { days: 7 } : {}),
            })
            .then(() => setRefreshKey((key) => key + 1))
            .catch((actionError: unknown) =>
              Alert.alert("Action impossible", errorMessage(actionError)),
            );
        },
      },
    ]);
  };

  const moderateLiveEvent = (event: LiveEvent, outcome: "clear" | "confirm") => {
    const decision = outcome === "clear" ? "innocent" : "confirmé";
    Alert.alert("Décision de modération", `Marquer ce contenu comme ${decision} ?`, [
      { text: "Annuler", style: "cancel" },
      {
        text: "Confirmer",
        onPress: () => {
          void api
            .post(`/v1/admin/live-events/${event.id}/action`, { outcome })
            .then(() => setRefreshKey((key) => key + 1))
            .catch((actionError: unknown) =>
              Alert.alert("Action impossible", errorMessage(actionError)),
            );
        },
      },
    ]);
  };

  const sendFlash = () => {
    if (!title.trim() || !message.trim()) {
      Alert.alert("Message incomplet", "Ajoutez un titre et un message.");
      return;
    }
    const sendAt = scheduledAt.trim() ? new Date(scheduledAt) : null;
    if (sendAt && (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now())) {
      Alert.alert("Date invalide", "La programmation doit être une date future valide.");
      return;
    }
    const regionCenter =
      targetType === "REGION"
        ? {
            latitude: latitude.trim() ? Number(latitude) : Number.NaN,
            longitude: longitude.trim() ? Number(longitude) : Number.NaN,
            radius_km: radius.trim() ? Number(radius) : Number.NaN,
          }
        : null;
    const target =
      targetType === "COUNTRY"
        ? { country_code: country.trim().toUpperCase() }
        : targetType === "NEIGHBORHOOD"
          ? { neighborhood: neighborhood.trim() }
          : targetType === "REGION"
            ? regionCenter ?? {}
            : {};
    const targetDescription =
      targetType === "ALL"
        ? "Tous les utilisateurs"
        : targetType === "COUNTRY"
            ? `Pays ${country.trim().toUpperCase()}`
            : targetType === "NEIGHBORHOOD"
              ? `Quartier ${neighborhood.trim()}`
              : `Rayon de ${radius.trim()} km autour de ${latitude.trim()}, ${longitude.trim()}`;
    Alert.alert(
      "Aperçu du message flash",
      `${title.trim()}\n\n${message.trim()}\n\nCible : ${targetDescription}${sendAt ? `\nEnvoi : ${dateLabel(sendAt.toISOString())}` : "\nEnvoi : maintenant"}`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: scheduledAt.trim() ? "Programmer" : "Envoyer maintenant",
          onPress: () => {
            setSending(true);
            void api
              .post<{ broadcast?: Flash }>("/v1/admin/flashes", {
                title: title.trim(),
                body: message.trim(),
                target_type: targetType,
                target,
                ...(sendAt ? { scheduled_at: sendAt.toISOString() } : {}),
              })
              .then((response) => {
                const broadcast = response.data.broadcast;
                Alert.alert(
                  "Message enregistré",
                  broadcast?.status === "SENT"
                    ? `Distribution acceptée pour ${broadcast.accepted_count ?? 0} appareil(s).`
                    : broadcast?.status === "FAILED"
                      ? broadcast.error_message ?? "La diffusion a échoué."
                      : broadcast?.status === "SENDING"
                        ? "La diffusion est en cours."
                        : "Le message est programmé.",
                );
                setTitle("");
                setMessage("");
                setScheduledAt("");
                setRefreshKey((key) => key + 1);
              })
              .catch((sendError: unknown) =>
                Alert.alert("Envoi impossible", errorMessage(sendError)),
              )
              .finally(() => setSending(false));
          },
        },
      ],
    );
  };

  const pill = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      key={label}
      onPress={onPress}
      style={[
        styles.pill,
        { backgroundColor: selected ? colors.primary : colors.muted },
      ]}
    >
      <Text style={{ color: selected ? colors.onPrimary : colors.text, fontWeight: "700" }}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: Math.max(insets.top, 16),
        },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.headerIcon, { backgroundColor: colors.primary }]}>
          <ShieldCheck color={colors.onPrimary} size={22} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]}>Espace Administrateur</Text>
          <Text style={{ color: colors.secondaryText }}>QuartierPlus · accès sécurisé</Text>
        </View>
        <Pressable
          accessibilityLabel="Actualiser"
          accessibilityRole="button"
          onPress={() => setRefreshKey((key) => key + 1)}
          style={styles.refresh}
        >
          <RefreshCw color={colors.primary} size={20} />
        </Pressable>
      </View>

      <View style={styles.navigation}>
        {(["reports", "flash", "history"] as const).map((value) =>
          pill(
            value === "reports" ? "Signalements" : value === "flash" ? "Message flash" : "Historique",
            panel === value,
            () => setPanel(value),
          ),
        )}
      </View>

      {panel === "reports" && (
        <View>
          <View style={styles.counts}>
            <View style={[styles.countCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.countNumber, { color: colors.primary }]}>{counts.PENDING ?? 0}</Text>
              <Text style={{ color: colors.secondaryText }}>À traiter</Text>
            </View>
            <View style={[styles.countCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.countNumber, { color: "#b91c1c" }]}>{counts.APPEALED ?? 0}</Text>
              <Text style={{ color: colors.secondaryText }}>Recours</Text>
            </View>
            <View style={[styles.countCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.countNumber, { color: colors.text }]}>{events.length}</Text>
              <Text style={{ color: colors.secondaryText }}>Lives</Text>
            </View>
          </View>
          <View style={styles.filters}>
            {(["PENDING", "APPEALED", "ALL"] as const).map((value) =>
              pill(
                value === "PENDING" ? "En attente" : value === "APPEALED" ? "Recours" : "Tous",
                filter === value,
                () => setFilter(value),
              ),
            )}
            {(["ALL", "HIGH", "NORMAL"] as const).map((value) =>
              pill(
                value === "ALL" ? "Toutes gravités" : value === "HIGH" ? "Élevé+" : "Modéré",
                severityFilter === value,
                () => setSeverityFilter(value),
              ),
            )}
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.danger, textAlign: "center" }}>{error}</Text>
          <Pressable onPress={() => setRefreshKey((key) => key + 1)} style={styles.primaryButton}>
            <Text style={styles.primaryText}>Réessayer</Text>
          </Pressable>
        </View>
      ) : panel === "reports" ? (
        <ScrollView contentContainerStyle={styles.list}>
          {events.map((event) => (
            <View key={`live-${event.id}`} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardHeading}>
                <ShieldAlert color="#dc2626" size={18} />
                <Text style={[styles.cardTitle, { color: colors.text }]}>Live · {event.media_type}</Text>
                <Text style={styles.severity}>{event.confidence}%</Text>
              </View>
              <Text style={{ color: colors.text }}>{event.category} · {event.participant_name ?? event.participant_id}</Text>
              {event.appeal_reason ? <Text style={{ color: colors.secondaryText }}>Recours : {event.appeal_reason}</Text> : null}
              <Text style={[styles.meta, { color: colors.secondaryText }]}>{dateLabel(event.created_at)}</Text>
              <View style={styles.actions}>
                <Pressable onPress={() => moderateLiveEvent(event, "clear")} style={styles.secondaryButton}>
                  <Text style={[styles.secondaryText, { color: colors.text }]}>Infirmer</Text>
                </Pressable>
                <Pressable onPress={() => moderateLiveEvent(event, "confirm")} style={styles.dangerButton}>
                  <Text style={styles.primaryText}>Confirmer</Text>
                </Pressable>
              </View>
            </View>
          ))}
          {visibleReports.map((report) => (
            <View key={report.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardHeading}>
                <ShieldAlert color={report.severity === "CRITIQUE" ? "#dc2626" : "#f59e0b"} size={18} />
                <Text style={[styles.cardTitle, { color: colors.text }]}>{report.reason}</Text>
                <Text style={styles.severity}>{report.severity}</Text>
              </View>
              <Text style={[styles.content, { color: colors.text }]}>{report.content}</Text>
              {report.media_url ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    const mediaUrl = report.media_url;
                    if (!mediaUrl || !mediaUrl.startsWith("https://")) {
                      Alert.alert("Média indisponible", "L'adresse du média n'est pas valide.");
                      return;
                    }
                    void Linking.openURL(mediaUrl).catch(() =>
                      Alert.alert("Média indisponible", "Impossible d'ouvrir ce média."),
                    );
                  }}
                  style={styles.secondaryButton}
                >
                  <Text style={{ color: colors.text, fontWeight: "700" }}>Consulter le média</Text>
                </Pressable>
              ) : null}
              <Text style={[styles.meta, { color: colors.secondaryText }]}>
                {report.target_user_name ?? report.target_user_id ?? "Compte indisponible"} · {report.target_type}
              </Text>
              <Text style={[styles.meta, { color: colors.secondaryText }]}>
                Signalé le {dateLabel(report.created_at)} · Statut : {report.status}
              </Text>
              {report.appeal_reason ? (
                <Text style={[styles.appeal, { color: colors.primary }]}>Recours : {report.appeal_reason}</Text>
              ) : null}
              {report.status !== "DISMISSED" && report.status !== "RESOLVED" && (
                <View style={styles.actions}>
                  <Pressable onPress={() => moderateReport(report, "review")} style={styles.secondaryButton}>
                    <Text style={[styles.secondaryText, { color: colors.text }]}>Examiner</Text>
                  </Pressable>
                  <Pressable onPress={() => moderateReport(report, "dismiss")} style={styles.secondaryButton}>
                    <Text style={[styles.secondaryText, { color: colors.text }]}>Classer</Text>
                  </Pressable>
                  {["POST", "SOS"].includes(report.target_type) ? (
                    <Pressable onPress={() => moderateReport(report, "hide")} style={styles.secondaryButton}>
                      <Text style={[styles.secondaryText, { color: colors.text }]}>Masquer</Text>
                    </Pressable>
                  ) : null}
                  {report.target_user_id ? (
                    <Pressable onPress={() => moderateReport(report, "suspend")} style={styles.dangerButton}>
                      <Text style={styles.primaryText}>Sanctionner</Text>
                    </Pressable>
                  ) : null}
                  {!["PROFILE", "LIVE_PARTICIPANT", "SOS"].includes(report.target_type) ? (
                    <Pressable onPress={() => moderateReport(report, "delete")} style={styles.dangerButton}>
                      <Text style={styles.primaryText}>Supprimer</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}
            </View>
          ))}
          {visibleReports.length === 0 && events.length === 0 ? (
            <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucun dossier dans cette file.</Text>
          ) : null}
        </ScrollView>
      ) : panel === "flash" ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.cardHeading}>
              <BellRing color={colors.primary} size={19} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Nouvelle annonce officielle</Text>
            </View>
            <TextInput value={title} onChangeText={setTitle} maxLength={80} placeholder="Titre" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            <TextInput value={message} onChangeText={setMessage} maxLength={280} multiline placeholder="Message (280 caractères maximum)" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.multiline, { color: colors.text, borderColor: colors.border }]} />
            <View style={styles.filters}>
              {(["ALL", "COUNTRY", "NEIGHBORHOOD", "REGION"] as const).map((value) =>
                pill(
                  value === "ALL" ? "Tous" : value === "COUNTRY" ? "Pays" : value === "NEIGHBORHOOD" ? "Quartier" : "Région",
                  targetType === value,
                  () => setTargetType(value),
                ),
              )}
            </View>
            {targetType === "COUNTRY" ? (
              <TextInput value={country} onChangeText={setCountry} autoCapitalize="characters" maxLength={3} placeholder="Code pays (ex. BF)" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            ) : null}
            {targetType === "NEIGHBORHOOD" ? (
              <TextInput value={neighborhood} onChangeText={setNeighborhood} maxLength={100} placeholder="Nom exact du quartier" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            ) : null}
            {targetType === "REGION" ? (
              <View style={styles.row}>
                <TextInput value={latitude} onChangeText={setLatitude} keyboardType="decimal-pad" placeholder="Latitude" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.flexInput, { color: colors.text, borderColor: colors.border }]} />
                <TextInput value={longitude} onChangeText={setLongitude} keyboardType="decimal-pad" placeholder="Longitude" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.flexInput, { color: colors.text, borderColor: colors.border }]} />
                <TextInput value={radius} onChangeText={setRadius} keyboardType="number-pad" placeholder="Rayon km" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.radiusInput, { color: colors.text, borderColor: colors.border }]} />
              </View>
            ) : null}
            <TextInput value={scheduledAt} onChangeText={setScheduledAt} placeholder="Programmation ISO facultative (ex. 2026-12-01T10:00:00Z)" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            <Text style={[styles.meta, { color: colors.secondaryText }]}>L’aperçu et une confirmation seront demandés avant la diffusion.</Text>
            <Pressable disabled={sending} onPress={sendFlash} style={[styles.primaryButton, sending && styles.disabled]}>
              <Text style={styles.primaryText}>{sending ? "Traitement…" : scheduledAt.trim() ? "Prévisualiser et programmer" : "Prévisualiser et envoyer"}</Text>
            </Pressable>
          </View>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Historique des envois</Text>
          {flashes.map((flash) => (
            <View key={flash.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{flash.title}</Text>
              <Text style={{ color: colors.secondaryText }}>{flash.body}</Text>
              <Text style={[styles.meta, { color: colors.secondaryText }]}>
                {flash.target_type} · {flash.status} · {dateLabel(flash.sent_at ?? flash.scheduled_at)}
              </Text>
              {flash.status === "SENT" ? (
                <Text style={[styles.meta, { color: colors.secondaryText }]}>
                  Appareils : {flash.accepted_count ?? 0} acceptés / {flash.failed_count ?? 0} échecs (destinataires : {flash.recipient_count ?? 0})
                </Text>
              ) : null}
              {flash.status === "FAILED" && flash.error_message ? (
                <Text style={{ color: colors.danger }}>{flash.error_message}</Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {history.map((entry, index) => (
            <View key={String(entry.id ?? index)} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{String(entry.action ?? "Action")} · {String(entry.target_type ?? "")}</Text>
              <Text style={{ color: colors.secondaryText }}>{String(entry.actor_name ?? "Administrateur")} · {dateLabel(String(entry.created_at ?? ""))}</Text>
              {entry.details ? <Text style={[styles.meta, { color: colors.secondaryText }]}>{JSON.stringify(entry.details)}</Text> : null}
            </View>
          ))}
          {history.length === 0 ? <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucune action enregistrée.</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 14, paddingTop: 16 },
  header: { alignItems: "center", flexDirection: "row", gap: 11, marginBottom: 16 },
  headerIcon: { alignItems: "center", borderRadius: 13, height: 42, justifyContent: "center", width: 42 },
  headerText: { flex: 1 },
  title: { fontSize: 19, fontWeight: "800" },
  refresh: { padding: 8 },
  navigation: { flexDirection: "row", gap: 6, marginBottom: 10 },
  counts: { flexDirection: "row", gap: 8, marginBottom: 10 },
  countCard: { alignItems: "center", borderRadius: 10, borderWidth: 1, flex: 1, padding: 8 },
  countNumber: { fontSize: 18, fontWeight: "800" },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginBottom: 10 },
  pill: { alignItems: "center", borderRadius: 20, justifyContent: "center", minHeight: 34, paddingHorizontal: 12, paddingVertical: 6 },
  center: { alignItems: "center", flex: 1, gap: 14, justifyContent: "center", padding: 20 },
  list: { gap: 11, paddingBottom: 32 },
  card: { borderRadius: 14, borderWidth: 1, gap: 9, padding: 14 },
  cardHeading: { alignItems: "center", flexDirection: "row", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "800" },
  severity: { color: "#b91c1c", fontSize: 10, fontWeight: "800" },
  content: { fontSize: 15, lineHeight: 21 },
  meta: { fontSize: 12, lineHeight: 17 },
  appeal: { fontWeight: "700" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 2 },
  secondaryButton: { backgroundColor: "#e2e8f0", borderRadius: 8, minHeight: 38, justifyContent: "center", paddingHorizontal: 10 },
  secondaryText: { fontSize: 12, fontWeight: "700" },
  dangerButton: { alignItems: "center", backgroundColor: "#b91c1c", borderRadius: 8, justifyContent: "center", minHeight: 38, paddingHorizontal: 10 },
  primaryButton: { alignItems: "center", alignSelf: "stretch", backgroundColor: "#1d4ed8", borderRadius: 10, justifyContent: "center", marginTop: 5, minHeight: 46, padding: 10 },
  primaryText: { color: "#ffffff", fontWeight: "800", textAlign: "center" },
  disabled: { opacity: 0.6 },
  empty: { padding: 20, textAlign: "center" },
  input: { borderRadius: 9, borderWidth: 1, minHeight: 45, paddingHorizontal: 11 },
  multiline: { minHeight: 90, paddingTop: 11, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 7 },
  flexInput: { flex: 1, minWidth: 70 },
  radiusInput: { width: 78 },
  sectionTitle: { fontSize: 16, fontWeight: "800", marginTop: 5 },
});
