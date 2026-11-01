import { ArrowLeft, CheckCircle2, Clock3, Handshake, MapPin, Plus, Send } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useTheme } from "../context/ThemeContext";
import { API_BASE_URL, apiFetch } from "../services/api";
import type { RootStackParamList } from "../navigation/types";

const CATEGORIES = [
  ["ENTRAIDE", "Entraide"],
  ["COMMERCIAL", "Commerce"],
  ["EVENEMENT", "Événement"],
  ["SPORT", "Sport"],
  ["COMMUNAUTE", "Communauté"],
  ["AUTRE", "Autre"],
] as const;

type CommunityAlliance = {
  id: string;
  title: string;
  description: string;
  objective: string;
  category: string;
  status: string;
  participant_count: number;
  due_date: string | null;
  location: string | null;
};

type AllyCounters = {
  allies: number;
  received_invitations: number;
  pending_invitations: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const responseError = async (response: { json: () => Promise<unknown>; status: number }) => {
  const payload: unknown = await response.json().catch(() => null);
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : `La demande a échoué (HTTP ${response.status}).`;
};

export default function AlliancePlusScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { colors } = useTheme();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [objective, setObjective] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number][0]>("ENTRAIDE");
  const [dueDate, setDueDate] = useState("");
  const [location, setLocation] = useState("");
  const [validationNote, setValidationNote] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [alliance, setAlliance] = useState<CommunityAlliance | null>(null);
  const [counters, setCounters] = useState<AllyCounters | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadCounters = async () => {
    if (!API_BASE_URL) return;
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/social/allies/counter`);
      if (!response.ok) throw new Error(await responseError(response));
      const payload: unknown = await response.json();
      const values = isRecord(payload) && isRecord(payload.counters) ? payload.counters : null;
      if (
        !values ||
        typeof values.allies !== "number" ||
        typeof values.received_invitations !== "number" ||
        typeof values.pending_invitations !== "number"
      ) throw new Error("Les compteurs d’alliés reçus sont invalides.");
      setCounters({
        allies: values.allies,
        received_invitations: values.received_invitations,
        pending_invitations: values.pending_invitations,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Compteur Allié indisponible.");
    }
  };

  useEffect(() => {
    void loadCounters();
  }, []);

  const createAlliance = async () => {
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    if (!title.trim() || !description.trim() || !objective.trim()) {
      setErrorMessage("Le titre, la description et l’objectif sont obligatoires.");
      return;
    }
    setIsCreating(true);
    setErrorMessage(null);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/social/alliances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          objective: objective.trim(),
          category,
          due_date: dueDate.trim() || null,
          location: location.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.alliance) || typeof payload.alliance.id !== "string") {
        throw new Error("La réponse de création est invalide.");
      }
      setAlliance(payload.alliance as unknown as CommunityAlliance);
      void loadCounters();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Création de l’alliance impossible.");
    } finally {
      setIsCreating(false);
    }
  };

  const updateStatus = async (status: "IN_PROGRESS" | "COMPLETED") => {
    if (!alliance || !API_BASE_URL) return;
    if (status === "COMPLETED" && (!validationNote.trim() || !proofUrl.trim())) {
      setErrorMessage("Réalisation refusée : ajoutez une note de validation et une preuve avant l’envoi.");
      return;
    }
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(alliance.id)}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            ...(status === "COMPLETED"
              ? { validation_note: validationNote.trim(), proof_url: proofUrl.trim() }
              : {}),
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `La demande a échoué (HTTP ${response.status}).`;
        throw new Error(reason);
      }
      if (isRecord(payload) && isRecord(payload.alliance)) {
        const updatedAlliance = payload.alliance as Record<string, unknown>;
        setAlliance((current) => current ? { ...current, ...updatedAlliance } as CommunityAlliance : current);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Mise à jour de l’alliance impossible.");
    } finally {
      setIsUpdating(false);
    }
  };

  const inputStyle = [styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.text }];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel="Retour au profil" onPress={() => navigation.goBack()} style={styles.back}>
          <ArrowLeft color={colors.text} size={20} />
          <Text style={[styles.backText, { color: colors.text }]}>Profil</Text>
        </Pressable>
        <View style={styles.heading}>
          <Handshake color="#087f5b" size={25} />
          <View style={styles.headingCopy}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Alliance+</Text>
            <Text style={[styles.subtitle, { color: colors.secondaryText }]}>Des objectifs concrets, construits avec le quartier.</Text>
          </View>
        </View>

        <View style={[styles.counterRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <View style={styles.counter}><Text style={[styles.counterValue, { color: colors.text }]}>{counters?.allies ?? "—"}</Text><Text style={[styles.counterLabel, { color: colors.secondaryText }]}>Alliés</Text></View>
          <View style={styles.counter}><Text style={[styles.counterValue, { color: colors.text }]}>{counters?.received_invitations ?? "—"}</Text><Text style={[styles.counterLabel, { color: colors.secondaryText }]}>Invitations reçues</Text></View>
          <View style={styles.counter}><Text style={[styles.counterValue, { color: colors.text }]}>{counters?.pending_invitations ?? "—"}</Text><Text style={[styles.counterLabel, { color: colors.secondaryText }]}>Envoyées en attente</Text></View>
        </View>
        <Text style={[styles.note, { color: colors.secondaryText }]}>Ces invitations concernent les relations d’alliés, pas encore les invitations à un projet.</Text>

        {!alliance ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Créer une alliance</Text>
            <TextInput accessibilityLabel="Titre de l’alliance" maxLength={150} onChangeText={setTitle} placeholder="Titre" placeholderTextColor={colors.secondaryText} style={inputStyle} value={title} />
            <TextInput accessibilityLabel="Description de l’alliance" maxLength={2000} multiline onChangeText={setDescription} placeholder="Description" placeholderTextColor={colors.secondaryText} style={[...inputStyle, styles.multiline]} value={description} />
            <Text style={[styles.inputLabel, { color: colors.text }]}>Catégorie</Text>
            <View style={styles.categories}>
              {CATEGORIES.map(([value, label]) => (
                <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: category === value }} onPress={() => setCategory(value)} style={[styles.category, { borderColor: colors.border }, category === value && styles.categorySelected]}>
                  <Text style={[styles.categoryText, category === value && styles.categoryTextSelected]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput accessibilityLabel="Objectif concret" maxLength={500} onChangeText={setObjective} placeholder="Objectif mesurable" placeholderTextColor={colors.secondaryText} style={inputStyle} value={objective} />
            <TextInput accessibilityLabel="Date limite facultative" onChangeText={setDueDate} placeholder="Date limite (AAAA-MM-JJ, facultative)" placeholderTextColor={colors.secondaryText} style={inputStyle} value={dueDate} />
            <View style={styles.locationInput}>
              <MapPin color={colors.secondaryText} size={18} />
              <TextInput accessibilityLabel="Lieu facultatif" onChangeText={setLocation} placeholder="Lieu (facultatif, texte uniquement)" placeholderTextColor={colors.secondaryText} style={[inputStyle, styles.locationField]} value={location} />
            </View>
            <Pressable accessibilityRole="button" disabled={isCreating} onPress={() => void createAlliance()} style={styles.primaryButton}>
              {isCreating ? <ActivityIndicator color="#ffffff" /> : <><Plus color="#ffffff" size={18} /><Text style={styles.primaryText}>Créer une alliance</Text></>}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void loadCounters()} style={styles.secondaryButton}>
              <Text style={[styles.secondaryText, { color: colors.text }]}>Actualiser le Compteur Allié</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.section, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{alliance.title}</Text>
            <Text style={[styles.body, { color: colors.secondaryText }]}>{alliance.description}</Text>
            <Text style={[styles.objective, { color: colors.text }]}>Objectif · {alliance.objective}</Text>
            <View style={styles.statusLine}><Clock3 color="#087f5b" size={17} /><Text style={[styles.statusText, { color: colors.text }]}>Statut : {alliance.status}</Text><Text style={[styles.statusText, { color: colors.secondaryText }]}>{alliance.participant_count} participant(s)</Text></View>
            <View style={styles.disabledActions}>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={styles.disabledButton}><Text style={styles.disabledText}>Rejoindre</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={styles.disabledButton}><Text style={styles.disabledText}>Inviter un allié</Text></Pressable>
            </View>
            <Text style={[styles.note, { color: colors.secondaryText }]}>Indisponible : le serveur ne fournit pas encore de routes pour lister les projets, rejoindre ou inviter un participant.</Text>
            {alliance.status !== "IN_PROGRESS" && alliance.status !== "COMPLETED" && (
              <Pressable accessibilityRole="button" disabled={isUpdating} onPress={() => void updateStatus("IN_PROGRESS")} style={styles.primaryButton}>
                {isUpdating ? <ActivityIndicator color="#ffffff" /> : <><CheckCircle2 color="#ffffff" size={18} /><Text style={styles.primaryText}>Démarrer le projet</Text></>}
              </Pressable>
            )}
            {alliance.status !== "COMPLETED" && (
              <>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Demande de réalisation</Text>
                <TextInput accessibilityLabel="Compte rendu de réalisation" maxLength={1000} multiline onChangeText={setValidationNote} placeholder="Compte rendu de réalisation" placeholderTextColor={colors.secondaryText} style={[...inputStyle, styles.multiline]} value={validationNote} />
                <TextInput accessibilityLabel="Lien de preuve" autoCapitalize="none" keyboardType="url" onChangeText={setProofUrl} placeholder="Lien vers une preuve" placeholderTextColor={colors.secondaryText} style={inputStyle} value={proofUrl} />
                <Pressable accessibilityRole="button" disabled={isUpdating} onPress={() => void updateStatus("COMPLETED")} style={styles.secondaryButton}>
                  {isUpdating ? <ActivityIndicator color="#087f5b" /> : <><Send color="#087f5b" size={17} /><Text style={[styles.secondaryText, { color: colors.text }]}>Soumettre la réalisation</Text></>}
                </Pressable>
              </>
            )}
          </View>
        )}
        {errorMessage && <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 18, paddingBottom: 36, gap: 14 },
  back: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 40 },
  backText: { fontSize: 14, fontWeight: "600" },
  heading: { alignItems: "center", flexDirection: "row", gap: 12, marginBottom: 4 },
  headingCopy: { flex: 1 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  counterRow: { borderWidth: 1, flexDirection: "row", borderRadius: 8 },
  counter: { alignItems: "center", flex: 1, minHeight: 68, justifyContent: "center", paddingHorizontal: 5 },
  counterValue: { fontSize: 20, fontWeight: "800" },
  counterLabel: { fontSize: 10, textAlign: "center" },
  note: { fontSize: 12, lineHeight: 17 },
  section: { borderRadius: 8, gap: 12, padding: 14 },
  sectionTitle: { fontSize: 18, fontWeight: "700" },
  input: { borderRadius: 6, borderWidth: 1, fontSize: 15, minHeight: 48, paddingHorizontal: 12, paddingVertical: 11 },
  multiline: { minHeight: 92, textAlignVertical: "top" },
  inputLabel: { fontSize: 13, fontWeight: "700" },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  category: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  categorySelected: { backgroundColor: "#087f5b", borderColor: "#087f5b" },
  categoryText: { color: "#42524b", fontSize: 12, fontWeight: "600" },
  categoryTextSelected: { color: "#ffffff" },
  locationInput: { alignItems: "center", flexDirection: "row", gap: 8 },
  locationField: { flex: 1 },
  primaryButton: { alignItems: "center", backgroundColor: "#087f5b", borderRadius: 6, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 48, paddingHorizontal: 12 },
  primaryText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  secondaryButton: { alignItems: "center", borderColor: "#087f5b", borderRadius: 6, borderWidth: 1, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 45, paddingHorizontal: 12 },
  secondaryText: { fontSize: 13, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  objective: { fontSize: 14, fontWeight: "700", lineHeight: 20 },
  statusLine: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 7 },
  statusText: { fontSize: 12, fontWeight: "600" },
  disabledActions: { flexDirection: "row", gap: 8 },
  disabledButton: { alignItems: "center", backgroundColor: "#e5e7eb", borderRadius: 6, flex: 1, justifyContent: "center", minHeight: 42, paddingHorizontal: 8 },
  disabledText: { color: "#6b7280", fontSize: 12, fontWeight: "700" },
  error: { backgroundColor: "#fef2f2", borderRadius: 6, color: "#b91c1c", fontSize: 13, lineHeight: 19, padding: 12 },
});
