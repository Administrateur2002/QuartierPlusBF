import axios from "axios";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { ArrowLeft, CheckCircle2, Clock3, Handshake, MapPin, Plus, Send, Users } from "lucide-react-native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
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

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  ACCEPTED: "Accepté",
  IN_PROGRESS: "En cours",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",
  DISPUTED: "Contesté",
};

type CommunityAlliance = {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  objective: string;
  category: string;
  status: string;
  participant_count: number;
  due_date: string | null;
  location: string | null;
  is_member: boolean;
  validation_note?: string | null;
  proof_url?: string | null;
  completion_confirmations?: number;
  has_confirmed_completion?: boolean;
};

type AllyCounters = {
  allies: number;
};

type ProjectCounters = {
  received_invitations: number;
  pending_invitations: number;
};

type Ally = {
  id: string;
  name: string;
};

type Participant = Ally & {
  role: string;
};

type ProjectInvitation = {
  id: string;
  alliance_id: string;
  status: string;
  project_title: string;
  project_status: string;
  user_id: string;
  user_name: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageFrom = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const payload: unknown = error.response?.data;
    if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  }
  return error instanceof Error ? error.message : "Une erreur est survenue.";
};

export default function AlliancePlusScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { colors } = useTheme();
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [objective, setObjective] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number][0]>("ENTRAIDE");
  const [dueDate, setDueDate] = useState("");
  const [location, setLocation] = useState("");
  const [validationNote, setValidationNote] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [projects, setProjects] = useState<CommunityAlliance[]>([]);
  const [myProjects, setMyProjects] = useState<CommunityAlliance[]>([]);
  const [allies, setAllies] = useState<Ally[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [receivedInvitations, setReceivedInvitations] = useState<ProjectInvitation[]>([]);
  const [sentInvitations, setSentInvitations] = useState<ProjectInvitation[]>([]);
  const [selectedAlliance, setSelectedAlliance] = useState<CommunityAlliance | null>(null);
  const [allyCounters, setAllyCounters] = useState<AllyCounters | null>(null);
  const [projectCounters, setProjectCounters] = useState<ProjectCounters | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [joiningProjectId, setJoiningProjectId] = useState<string | null>(null);
  const [invitingUserId, setInvitingUserId] = useState<string | null>(null);
  const [respondingInvitationId, setRespondingInvitationId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [
        availableResponse,
        mineResponse,
        receivedResponse,
        sentResponse,
        allyCounterResponse,
        projectCounterResponse,
        alliesResponse,
      ] = await Promise.all([
        apiFetch(`${API_BASE_URL}/v1/social/alliances`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/alliances/mine`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/alliances/invitations/received`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/alliances/invitations/sent`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/allies/counter`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/alliances/invitations/counter`, { headers: { "Cache-Control": "no-cache" } }),
        apiFetch(`${API_BASE_URL}/v1/social/allies`, { headers: { "Cache-Control": "no-cache" } }),
      ]);
      const responses = [
        availableResponse,
        mineResponse,
        receivedResponse,
        sentResponse,
        allyCounterResponse,
        projectCounterResponse,
        alliesResponse,
      ];
      const failed = responses.find((response) => !response.ok);
      if (failed) {
        const payload: unknown = await failed.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `Le chargement des projets a échoué (HTTP ${failed.status}).`,
        );
      }
      const [
        available,
        mine,
        received,
        sent,
        allyCounter,
        projectCounter,
        alliesPayload,
      ] = await Promise.all(responses.map((response) => response.json() as Promise<unknown>));
      if (
        !isRecord(available) || !Array.isArray(available.alliances) ||
        !isRecord(mine) || !Array.isArray(mine.alliances) ||
        !isRecord(received) || !Array.isArray(received.invitations) ||
        !isRecord(sent) || !Array.isArray(sent.invitations) ||
        !isRecord(allyCounter) || !isRecord(allyCounter.counters) ||
        !isRecord(projectCounter) || !isRecord(projectCounter.counters) ||
        !isRecord(alliesPayload) || !Array.isArray(alliesPayload.allies)
      ) {
        throw new Error("Les données Alliance+ reçues du serveur sont invalides.");
      }
      const alliesCount = allyCounter.counters.allies;
      const receivedCount = projectCounter.counters.received_invitations;
      const pendingCount = projectCounter.counters.pending_invitations;
      if (
        typeof alliesCount !== "number" ||
        typeof receivedCount !== "number" ||
        typeof pendingCount !== "number"
      ) {
        throw new Error("Les compteurs Alliance+ reçus sont invalides.");
      }
      setProjects(available.alliances as CommunityAlliance[]);
      setMyProjects(mine.alliances as CommunityAlliance[]);
      setReceivedInvitations(received.invitations as ProjectInvitation[]);
      setSentInvitations(sent.invitations as ProjectInvitation[]);
      setAllies(alliesPayload.allies as Ally[]);
      setAllyCounters({ allies: alliesCount });
      setProjectCounters({
        received_invitations: receivedCount,
        pending_invitations: pendingCount,
      });
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadData();
  }, [loadData]));

  const loadProjectDetails = async (allianceId: string) => {
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(allianceId)}`,
        { headers: { "Cache-Control": "no-cache" } },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `Le chargement du projet a échoué (HTTP ${response.status}).`,
        );
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.alliance)) {
        throw new Error("Les détails du projet reçus sont invalides.");
      }
      const alliance = payload.alliance as unknown as CommunityAlliance;
      setSelectedAlliance(alliance);
      setParticipants([]);
      setValidationNote(alliance.validation_note ?? "");
      setProofUrl(alliance.proof_url ?? "");
      if (alliance.is_member) {
        const participantsResponse = await apiFetch(
          `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(allianceId)}/participants`,
          { headers: { "Cache-Control": "no-cache" } },
        );
        if (!participantsResponse.ok) {
          const errorPayload: unknown = await participantsResponse.json().catch(() => null);
          throw new Error(
            isRecord(errorPayload) && typeof errorPayload.error === "string"
              ? errorPayload.error
              : `Le chargement des participants a échoué (HTTP ${participantsResponse.status}).`,
          );
        }
        const participantsPayload: unknown = await participantsResponse.json();
        if (!isRecord(participantsPayload) || !Array.isArray(participantsPayload.participants)) {
          throw new Error("La liste des participants reçue est invalide.");
        }
        setParticipants(participantsPayload.participants as Participant[]);
      }
    } catch (error) {
      setErrorMessage(messageFrom(error));
    }
  };

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
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La création du projet a échoué (HTTP ${response.status}).`,
        );
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !isRecord(payload.alliance) || typeof payload.alliance.id !== "string") {
        throw new Error("La réponse de création du projet est invalide.");
      }
      const allianceId = payload.alliance.id;
      setTitle("");
      setDescription("");
      setObjective("");
      setDueDate("");
      setLocation("");
      await loadData();
      await loadProjectDetails(allianceId);
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setIsCreating(false);
    }
  };

  const joinProject = async (alliance: CommunityAlliance) => {
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setJoiningProjectId(alliance.id);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(alliance.id)}/join`,
        { method: "POST" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La participation a échoué (HTTP ${response.status}).`,
        );
      }
      await loadData();
      await loadProjectDetails(alliance.id);
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setJoiningProjectId(null);
    }
  };

  const inviteAlly = async (ally: Ally) => {
    if (!selectedAlliance) return;
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setInvitingUserId(ally.id);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(selectedAlliance.id)}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: ally.id }),
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `L’invitation a échoué (HTTP ${response.status}).`,
        );
      }
      await loadData();
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setInvitingUserId(null);
    }
  };

  const respondToInvitation = async (invitation: ProjectInvitation, decision: "ACCEPTED" | "DECLINED") => {
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setRespondingInvitationId(invitation.id);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/invitations/${encodeURIComponent(invitation.id)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La réponse à l’invitation a échoué (HTTP ${response.status}).`,
        );
      }
      await loadData();
      if (decision === "ACCEPTED") await loadProjectDetails(invitation.alliance_id);
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setRespondingInvitationId(null);
    }
  };

  const updateStatus = async (status: "IN_PROGRESS" | "COMPLETED") => {
    if (!selectedAlliance) return;
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    if (status === "COMPLETED" && (!validationNote.trim() || !proofUrl.trim())) {
      setErrorMessage("Ajoutez une note de validation et un lien de preuve avant de soumettre la réalisation.");
      return;
    }
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(selectedAlliance.id)}/status`,
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
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La mise à jour du projet a échoué (HTTP ${response.status}).`,
        );
      }
      await loadData();
      await loadProjectDetails(selectedAlliance.id);
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setIsUpdating(false);
    }
  };

  const confirmCompletion = async () => {
    if (!selectedAlliance) return;
    if (!API_BASE_URL) {
      setErrorMessage("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliances/${encodeURIComponent(selectedAlliance.id)}/completion-confirmation`,
        { method: "POST" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La confirmation a échoué (HTTP ${response.status}).`,
        );
      }
      await loadData();
      await loadProjectDetails(selectedAlliance.id);
    } catch (error) {
      setErrorMessage(messageFrom(error));
    } finally {
      setIsUpdating(false);
    }
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: colors.card, borderColor: colors.border, color: colors.text },
  ];
  const availableProjects = projects.filter((project) => !project.is_member);
  const participantIds = new Set(participants.map((participant) => participant.id));
  const pendingInviteeIds = new Set(
    sentInvitations
      .filter((invitation) => invitation.alliance_id === selectedAlliance?.id && invitation.status === "PENDING")
      .map((invitation) => invitation.user_id),
  );
  const invitableAllies = allies.filter(
    (ally) => !participantIds.has(ally.id) && !pendingInviteeIds.has(ally.id),
  );

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
          <Pressable accessibilityRole="button" accessibilityLabel="Actualiser Alliance+" onPress={() => void loadData()} style={styles.refresh}>
            <Text style={[styles.refreshText, { color: colors.text }]}>Actualiser</Text>
          </Pressable>
        </View>

        <View style={[styles.counterRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Counter value={allyCounters?.allies} label="Alliés" colors={colors} />
          <Counter value={projectCounters?.received_invitations} label="Invitations projet reçues" colors={colors} />
          <Counter value={projectCounters?.pending_invitations} label="Envoyées en attente" colors={colors} />
        </View>

        {isLoading ? <ActivityIndicator color={colors.primary} /> : null}

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Invitations de projet reçues</Text>
          {receivedInvitations.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Aucune invitation de projet en attente.</Text>
          ) : receivedInvitations.map((invitation) => (
            <View key={invitation.id} style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Pressable onPress={() => void loadProjectDetails(invitation.alliance_id)} style={styles.invitationCopy}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>{invitation.project_title}</Text>
                <Text style={[styles.note, { color: colors.secondaryText }]}>
                  Invitation de {invitation.user_name || "un allié"} · {STATUS_LABELS[invitation.project_status] || invitation.project_status}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={respondingInvitationId === invitation.id}
                onPress={() => void respondToInvitation(invitation, "ACCEPTED")}
                style={styles.smallAction}
              >
                {respondingInvitationId === invitation.id
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={[styles.actionText, { color: colors.primary }]}>Accepter</Text>}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={respondingInvitationId === invitation.id}
                onPress={() => void respondToInvitation(invitation, "DECLINED")}
                style={styles.smallAction}
              >
                <Text style={[styles.actionText, { color: colors.secondaryText }]}>Refuser</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Invitations envoyées</Text>
          {sentInvitations.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Aucune invitation envoyée.</Text>
          ) : sentInvitations.map((invitation) => (
            <View key={invitation.id} style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{invitation.project_title}</Text>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                {invitation.user_name || "Un allié"} · {invitation.status}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Mes projets</Text>
          {myProjects.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Vous ne participez pas encore à un projet.</Text>
          ) : myProjects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              selected={selectedAlliance?.id === project.id}
              colors={colors}
              onPress={() => void loadProjectDetails(project.id)}
            />
          ))}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Projets disponibles</Text>
          {availableProjects.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Aucun nouveau projet ouvert à la participation.</Text>
          ) : availableProjects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              selected={selectedAlliance?.id === project.id}
              colors={colors}
              onPress={() => void loadProjectDetails(project.id)}
            />
          ))}
        </View>

        {selectedAlliance ? (
          <View style={[styles.detail, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{selectedAlliance.title}</Text>
            <Text style={[styles.body, { color: colors.secondaryText }]}>{selectedAlliance.description}</Text>
            <Text style={[styles.objective, { color: colors.text }]}>Objectif · {selectedAlliance.objective}</Text>
            <View style={styles.statusLine}>
              <Clock3 color="#087f5b" size={17} />
              <Text style={[styles.statusText, { color: colors.text }]}>
                {STATUS_LABELS[selectedAlliance.status] || selectedAlliance.status}
              </Text>
              <Text style={[styles.statusText, { color: colors.secondaryText }]}>
                {selectedAlliance.participant_count} participant(s)
              </Text>
            </View>
            {selectedAlliance.due_date ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Échéance · {new Date(selectedAlliance.due_date).toLocaleDateString()}
              </Text>
            ) : null}
            {selectedAlliance.location ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>Lieu · {selectedAlliance.location}</Text>
            ) : null}
            {!selectedAlliance.is_member && ["PENDING", "ACCEPTED", "IN_PROGRESS"].includes(selectedAlliance.status) ? (
              <Pressable
                accessibilityRole="button"
                disabled={joiningProjectId === selectedAlliance.id}
                onPress={() => void joinProject(selectedAlliance)}
                style={[styles.primaryButton, joiningProjectId === selectedAlliance.id && styles.disabled]}
              >
                {joiningProjectId === selectedAlliance.id
                  ? <ActivityIndicator color="#ffffff" />
                  : <><Users color="#ffffff" size={17} /><Text style={styles.primaryText}>Rejoindre le projet</Text></>}
              </Pressable>
            ) : null}
            {selectedAlliance.is_member ? (
              <>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Participants</Text>
                {participants.map((participant) => (
                  <Text key={participant.id} style={[styles.note, { color: colors.secondaryText }]}>
                    {participant.name} {participant.role === "CREATOR" ? "· Créateur" : ""}
                  </Text>
                ))}
                <Text style={[styles.inputLabel, { color: colors.text }]}>Inviter un allié</Text>
                {invitableAllies.length === 0 ? (
                  <Text style={[styles.note, { color: colors.secondaryText }]}>Aucun allié disponible à inviter.</Text>
                ) : invitableAllies.map((ally) => (
                  <View key={ally.id} style={styles.allyRow}>
                    <Text style={[styles.note, styles.allyName, { color: colors.text }]}>{ally.name}</Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={invitingUserId === ally.id}
                      onPress={() => void inviteAlly(ally)}
                      style={styles.smallAction}
                    >
                      {invitingUserId === ally.id
                        ? <ActivityIndicator color={colors.primary} />
                        : <Text style={[styles.actionText, { color: colors.primary }]}>Inviter</Text>}
                    </Pressable>
                  </View>
                ))}
              </>
            ) : null}
            {selectedAlliance.creator_id === user?.id &&
              ["PENDING", "ACCEPTED"].includes(selectedAlliance.status) ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={isUpdating}
                  onPress={() => void updateStatus("IN_PROGRESS")}
                  style={[styles.primaryButton, isUpdating && styles.disabled]}
                >
                  {isUpdating ? <ActivityIndicator color="#ffffff" /> : <><CheckCircle2 color="#ffffff" size={18} /><Text style={styles.primaryText}>Démarrer le projet</Text></>}
                </Pressable>
              ) : null}
            {selectedAlliance.creator_id === user?.id && selectedAlliance.status === "IN_PROGRESS" ? (
              <>
                <Text style={[styles.inputLabel, { color: colors.text }]}>Demande de réalisation</Text>
                <TextInput
                  accessibilityLabel="Compte rendu de réalisation"
                  maxLength={1000}
                  multiline
                  onChangeText={setValidationNote}
                  placeholder="Compte rendu de réalisation"
                  placeholderTextColor={colors.secondaryText}
                  style={[...inputStyle, styles.multiline]}
                  value={validationNote}
                />
                <TextInput
                  accessibilityLabel="Lien de preuve"
                  autoCapitalize="none"
                  keyboardType="url"
                  onChangeText={setProofUrl}
                  placeholder="Lien vers une preuve"
                  placeholderTextColor={colors.secondaryText}
                  style={inputStyle}
                  value={proofUrl}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={isUpdating}
                  onPress={() => void updateStatus("IN_PROGRESS")}
                  style={[styles.secondaryButton, isUpdating && styles.disabled]}
                >
                  {isUpdating ? <ActivityIndicator color="#087f5b" /> : <><Send color="#087f5b" size={17} /><Text style={[styles.secondaryText, { color: colors.text }]}>Enregistrer la réalisation</Text></>}
                </Pressable>
                <Text style={[styles.note, { color: colors.secondaryText }]}>
                  Confirmations reçues : {selectedAlliance.completion_confirmations ?? 0}
                </Text>
                {selectedAlliance.validation_note &&
                  selectedAlliance.proof_url &&
                  (selectedAlliance.completion_confirmations ?? 0) >= 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={isUpdating}
                      onPress={() => void updateStatus("COMPLETED")}
                      style={[styles.primaryButton, isUpdating && styles.disabled]}
                    >
                      {isUpdating ? <ActivityIndicator color="#ffffff" /> : <><CheckCircle2 color="#ffffff" size={18} /><Text style={styles.primaryText}>Finaliser le projet</Text></>}
                    </Pressable>
                  ) : (
                    <Text style={[styles.note, { color: colors.secondaryText }]}>
                      Un autre participant doit confirmer la réalisation avant la clôture.
                    </Text>
                  )}
              </>
            ) : null}
            {selectedAlliance.is_member &&
              selectedAlliance.creator_id !== user?.id &&
              selectedAlliance.status === "IN_PROGRESS" &&
              Boolean(selectedAlliance.validation_note) &&
              Boolean(selectedAlliance.proof_url) &&
              !selectedAlliance.has_confirmed_completion ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={isUpdating}
                  onPress={() => void confirmCompletion()}
                  style={[styles.secondaryButton, isUpdating && styles.disabled]}
                >
                  {isUpdating ? <ActivityIndicator color="#087f5b" /> : <><CheckCircle2 color="#087f5b" size={17} /><Text style={[styles.secondaryText, { color: colors.text }]}>Confirmer la réalisation</Text></>}
                </Pressable>
              ) : null}
            {selectedAlliance.has_confirmed_completion ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>Votre confirmation de réalisation a été enregistrée.</Text>
            ) : null}
            {selectedAlliance.status === "COMPLETED" ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Réalisation validée · {selectedAlliance.validation_note || ""}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={[styles.section, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Démarrer un projet</Text>
          <TextInput accessibilityLabel="Titre du projet" maxLength={150} onChangeText={setTitle} placeholder="Titre" placeholderTextColor={colors.secondaryText} style={inputStyle} value={title} />
          <TextInput accessibilityLabel="Description du projet" maxLength={2000} multiline onChangeText={setDescription} placeholder="Description" placeholderTextColor={colors.secondaryText} style={[...inputStyle, styles.multiline]} value={description} />
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
          <Pressable accessibilityRole="button" disabled={isCreating} onPress={() => void createAlliance()} style={[styles.primaryButton, isCreating && styles.disabled]}>
            {isCreating ? <ActivityIndicator color="#ffffff" /> : <><Plus color="#ffffff" size={18} /><Text style={styles.primaryText}>Créer le projet</Text></>}
          </Pressable>
        </View>
        {errorMessage ? <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text> : null}
      </ScrollView>
    </View>
  );
}

function Counter({
  value,
  label,
  colors,
}: {
  value: number | undefined;
  label: string;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <View style={styles.counter}>
      <Text style={[styles.counterValue, { color: colors.text }]}>{value ?? "—"}</Text>
      <Text style={[styles.counterLabel, { color: colors.secondaryText }]}>{label}</Text>
    </View>
  );
}

function ProjectRow({
  project,
  selected,
  colors,
  onPress,
}: {
  project: CommunityAlliance;
  selected: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.listCard,
        { backgroundColor: colors.card, borderColor: selected ? colors.primary : colors.border },
      ]}
    >
      <View style={styles.invitationCopy}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>{project.title}</Text>
        <Text style={[styles.note, { color: colors.secondaryText }]}>
          {STATUS_LABELS[project.status] || project.status} · {project.participant_count} participant(s)
        </Text>
      </View>
      <Text style={[styles.actionText, { color: colors.primary }]}>Détails</Text>
    </Pressable>
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
  refresh: { minHeight: 40, justifyContent: "center", paddingHorizontal: 6 },
  refreshText: { fontSize: 12, fontWeight: "700" },
  counterRow: { borderWidth: 1, flexDirection: "row", borderRadius: 12, padding: 12 },
  counter: { alignItems: "center", flex: 1, gap: 4 },
  counterValue: { fontSize: 20, fontWeight: "800" },
  counterLabel: { fontSize: 10, textAlign: "center" },
  section: { borderRadius: 14, borderWidth: 1, gap: 10, padding: 14 },
  sectionTitle: { fontSize: 17, fontWeight: "700" },
  listCard: { alignItems: "center", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, padding: 12 },
  invitationCopy: { flex: 1, gap: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  note: { fontSize: 12, lineHeight: 17 },
  smallAction: { justifyContent: "center", minHeight: 40, paddingHorizontal: 5 },
  actionText: { fontSize: 12, fontWeight: "700" },
  detail: { borderRadius: 14, borderWidth: 1, gap: 12, padding: 14 },
  body: { fontSize: 14, lineHeight: 20 },
  objective: { fontSize: 14, fontWeight: "700", lineHeight: 20 },
  statusLine: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 9 },
  statusText: { fontSize: 12, fontWeight: "600" },
  input: { borderRadius: 10, borderWidth: 1, fontSize: 14, minHeight: 46, paddingHorizontal: 12, paddingVertical: 10 },
  multiline: { minHeight: 78, textAlignVertical: "top" },
  inputLabel: { fontSize: 13, fontWeight: "700" },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  category: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 7 },
  categorySelected: { backgroundColor: "#e5f5ee", borderColor: "#087f5b" },
  categoryText: { color: "#475467", fontSize: 12, fontWeight: "600" },
  categoryTextSelected: { color: "#087f5b" },
  locationInput: { alignItems: "center", flexDirection: "row", gap: 8 },
  locationField: { flex: 1 },
  primaryButton: { alignItems: "center", backgroundColor: "#087f5b", borderRadius: 10, flexDirection: "row", gap: 9, justifyContent: "center", minHeight: 48, paddingHorizontal: 14 },
  primaryText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  secondaryButton: { alignItems: "center", borderColor: "#087f5b", borderRadius: 10, borderWidth: 1, flexDirection: "row", gap: 9, justifyContent: "center", minHeight: 46, paddingHorizontal: 12 },
  secondaryText: { fontSize: 13, fontWeight: "700" },
  disabled: { opacity: 0.6 },
  allyRow: { alignItems: "center", borderTopColor: "#e4e7ec", borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", minHeight: 42 },
  allyName: { flex: 1 },
  error: { color: "#b42318", fontSize: 13, lineHeight: 19 },
});
