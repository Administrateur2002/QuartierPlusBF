import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import { API_BASE_URL, apiFetch } from "../services/api";
import {
  FALLBACK_LEGAL_VERSION,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from "../legal/documents";

const STORAGE_KEY = "quartierplus.legal.acceptances.v1";
const APP_VERSION = require("../../app.json").expo.version as string;

type LegalDocumentStatus = {
  id: LegalDocumentId;
  version: string;
  accepted_version?: string | null;
};

type LocalAcceptance = {
  age_16_or_older: true;
  app_version: string;
  server_verified: boolean;
  versions: Partial<Record<LegalDocumentId, string>>;
};

const fallbackStatuses = (): LegalDocumentStatus[] =>
  LEGAL_DOCUMENTS.map(({ id }) => ({ id, version: FALLBACK_LEGAL_VERSION }));

const parseStatuses = (value: unknown): LegalDocumentStatus[] | null => {
  if (!value || typeof value !== "object" || !("documents" in value)) return null;
  const documents = (value as { documents?: unknown }).documents;
  if (!Array.isArray(documents)) return null;
  const parsed = documents.filter(
    (item): item is LegalDocumentStatus =>
      item !== null &&
      typeof item === "object" &&
      "id" in item &&
      "version" in item &&
      typeof item.id === "string" &&
      typeof item.version === "string" &&
      LEGAL_DOCUMENTS.some((document) => document.id === item.id),
  );
  return parsed.length === LEGAL_DOCUMENTS.length ? parsed : null;
};

const readLocalAcceptance = async (): Promise<LocalAcceptance | null> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("versions" in value) ||
      !("age_16_or_older" in value) ||
      !("server_verified" in value)
    ) {
      return null;
    }
    return value as LocalAcceptance;
  } catch (error) {
    console.error("Unable to read saved legal acceptance:", error);
    return null;
  }
};

export default function LegalConsentGate() {
  const { isOffline, isSessionLoading, user } = useAuth();
  const [documents, setDocuments] = useState<LegalDocumentStatus[]>(fallbackStatuses);
  const [checked, setChecked] = useState<Set<LegalDocumentId>>(new Set());
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const loadGeneration = useRef(0);
  const allDocumentsChecked = useMemo(
    () => LEGAL_DOCUMENTS.every((document) => checked.has(document.id)),
    [checked],
  );

  const loadConsent = async () => {
    const generation = ++loadGeneration.current;
    setVisible(false);
    setLoading(true);
    setError(null);
    try {
      const local = await readLocalAcceptance();
      if (generation !== loadGeneration.current) return;
      if (isOffline) {
        const locallyAccepted =
          local?.age_16_or_older === true &&
          (user
            ? local.server_verified
            : LEGAL_DOCUMENTS.every(
                (document) => local.versions[document.id] === FALLBACK_LEGAL_VERSION,
              ));
        if (locallyAccepted) {
          setVisible(false);
          setLoading(false);
          return;
        }
        setDocuments(fallbackStatuses());
        setVisible(true);
        setError("Connectez-vous à Internet pour vérifier et enregistrer votre acceptation.");
        setLoading(false);
        return;
      }
      if (!API_BASE_URL) throw new Error("L’adresse du serveur n’est pas configurée.");

      const endpoint = user ? "/v1/legal/me" : "/v1/legal/documents";
      const response = await apiFetch(`${API_BASE_URL}${endpoint}`, {
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) throw new Error(`Impossible de charger les documents (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      const statuses = parseStatuses(payload);
      if (!statuses) throw new Error("La liste des versions légales reçue est invalide.");
      if (generation !== loadGeneration.current) return;
      setDocuments(statuses);

      const serverAccepted = user && statuses.every(
        (document) => document.accepted_version === document.version,
      );
      if (serverAccepted) {
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            age_16_or_older: true,
            app_version: APP_VERSION,
            server_verified: true,
            versions: Object.fromEntries(
              statuses.map(({ id, version }) => [id, version]),
            ),
          } satisfies LocalAcceptance),
        );
        setVisible(false);
        return;
      }
      const locallyAccepted = local?.age_16_or_older === true &&
        statuses.every(
          (document) => local.versions[document.id] === document.version,
        );
      if (local && locallyAccepted && (!user || !local.server_verified)) {
        if (user) {
          const response = await apiFetch(`${API_BASE_URL}/v1/legal/acceptances`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              acceptances: statuses.map(({ id, version }) => ({
                document_id: id,
                version,
              })),
              age_16_or_older: local.age_16_or_older,
              app_version: APP_VERSION,
            }),
          });
          if (!response.ok) {
            const responseBody = await response.json<{ error?: string }>();
            throw new Error(
              responseBody.error ??
                `Échec de l’enregistrement (HTTP ${response.status}).`,
            );
          }
          await AsyncStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              ...local,
              app_version: APP_VERSION,
              server_verified: true,
              versions: Object.fromEntries(
                statuses.map(({ id, version }) => [id, version]),
              ),
            } satisfies LocalAcceptance),
          );
        }
        setVisible(false);
        return;
      }
      setChecked(new Set());
      setAgeConfirmed(false);
      setVisible(true);
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      const local = await readLocalAcceptance();
      const locallyAccepted =
        local?.age_16_or_older === true &&
        (user
          ? local.server_verified
          : LEGAL_DOCUMENTS.every(
              (document) => local.versions[document.id] === FALLBACK_LEGAL_VERSION,
            ));
      setDocuments(fallbackStatuses());
      if (locallyAccepted) {
        setVisible(false);
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Impossible de vérifier les versions des documents légaux.",
      );
      setVisible(true);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (isSessionLoading) return;
    void loadConsent();
  }, [isOffline, isSessionLoading, user?.id]);

  const toggleDocument = (id: LegalDocumentId) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const accept = async () => {
    if (!allDocumentsChecked || !ageConfirmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const versions = documents.map(({ id, version }) => ({
        document_id: id,
        version,
      }));
      if (user) {
        if (!API_BASE_URL || isOffline) {
          throw new Error("Une connexion Internet est nécessaire pour enregistrer l’acceptation sur le serveur.");
        }
        const response = await apiFetch(`${API_BASE_URL}/v1/legal/acceptances`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            acceptances: versions,
            age_16_or_older: true,
            app_version: APP_VERSION,
          }),
        });
        if (!response.ok) {
          const responseBody = await response.json<{ error?: string }>();
          throw new Error(responseBody.error ?? `Échec de l’enregistrement (HTTP ${response.status}).`);
        }
      }
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          age_16_or_older: true,
          app_version: APP_VERSION,
          server_verified: Boolean(user),
          versions: Object.fromEntries(
            versions.map(({ document_id, version }) => [document_id, version]),
          ),
        } satisfies LocalAcceptance),
      );
      setVisible(false);
    } catch (acceptError) {
      const message =
        acceptError instanceof Error
          ? acceptError.message
          : "Impossible d’enregistrer votre acceptation.";
      setError(message);
      Alert.alert("Acceptation non enregistrée", message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {}}
      transparent={false}
      visible={visible}
    >
      <View style={styles.screen}>
        <Text accessibilityRole="header" style={styles.title}>
          Avant de commencer
        </Text>
        <Text style={styles.intro}>
          Consultez et acceptez chaque document. Vous devez avoir au moins 16 ans.
          Les copies complètes sont incluses dans l’application pour consultation hors ligne.
        </Text>
        {loading ? (
          <ActivityIndicator color="#2563eb" size="large" />
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.documents}>
              {LEGAL_DOCUMENTS.map((document) => {
                const status = documents.find((item) => item.id === document.id);
                const selected = checked.has(document.id);
                return (
                  <View key={document.id} style={styles.document}>
                    <Text accessibilityRole="header" style={styles.documentTitle}>
                      {document.title}
                    </Text>
                    <Text style={styles.body}>{document.body}</Text>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      onPress={() => toggleDocument(document.id)}
                      style={styles.checkRow}
                    >
                      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                        {selected ? <Text style={styles.tick}>✓</Text> : null}
                      </View>
                      <Text style={styles.checkText}>
                        J’ai lu et j’accepte la version {status?.version ?? FALLBACK_LEGAL_VERSION}.
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ageConfirmed }}
              onPress={() => setAgeConfirmed((value) => !value)}
              style={styles.checkRow}
            >
              <View style={[styles.checkbox, ageConfirmed && styles.checkboxSelected]}>
                {ageConfirmed ? <Text style={styles.tick}>✓</Text> : null}
              </View>
              <Text style={styles.checkText}>
                Je confirme avoir au moins 16 ans.
              </Text>
            </Pressable>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={!allDocumentsChecked || !ageConfirmed || saving}
              onPress={() => void accept()}
              style={[
                styles.accept,
                (!allDocumentsChecked || !ageConfirmed || saving) && styles.disabled,
              ]}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.acceptText}>Accepter et continuer</Text>
              )}
            </Pressable>
            {error ? (
              <Pressable accessibilityRole="button" onPress={() => void loadConsent()}>
                <Text style={styles.retry}>Réessayer</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#fffdf8", flex: 1, padding: 20, paddingTop: 38 },
  title: { color: "#252823", fontSize: 24, fontWeight: "900" },
  intro: { color: "#65675e", fontSize: 14, lineHeight: 21, marginBottom: 14, marginTop: 8 },
  documents: { gap: 22, paddingBottom: 18 },
  document: { gap: 8 },
  documentTitle: { color: "#252823", fontSize: 16, fontWeight: "800" },
  body: { color: "#444840", fontSize: 13, lineHeight: 20 },
  checkRow: { alignItems: "center", flexDirection: "row", gap: 10, paddingVertical: 8 },
  checkbox: {
    alignItems: "center",
    borderColor: "#8a8b82",
    borderRadius: 4,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  checkboxSelected: { backgroundColor: "#28765c", borderColor: "#28765c" },
  tick: { color: "#fff", fontSize: 15, fontWeight: "900" },
  checkText: { color: "#252823", flex: 1, fontSize: 13, lineHeight: 19 },
  error: { color: "#b9382f", fontSize: 13, marginVertical: 8 },
  accept: {
    alignItems: "center",
    backgroundColor: "#28765c",
    borderRadius: 8,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 50,
  },
  disabled: { opacity: 0.45 },
  acceptText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  retry: { color: "#2563eb", fontSize: 14, fontWeight: "700", padding: 12, textAlign: "center" },
});
