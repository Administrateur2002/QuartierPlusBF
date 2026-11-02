import { useCallback, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "@react-navigation/native";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Search, UserPlus } from "lucide-react-native";
import api from "../services/api";
import { getApiErrorMessage } from "../services/apiError";
import { useTheme } from "../context/ThemeContext";
import ProfileAvatar from "../components/ProfileAvatar";
import ProfilePhotoViewer from "../components/ProfilePhotoViewer";
import type { RootStackParamList } from "../navigation/types";

type Person = {
  id: string;
  name: string | null;
  neighborhood: string | null;
  profile_photo_url: string | null;
  badge: string | null;
  alliance_status: "ALLIED" | "PENDING" | "RECEIVED" | null;
};

type AllianceRequest = {
  id: string;
  name: string | null;
  profile_photo_url: string | null;
  badge: string | null;
};

export default function AlliancePeopleScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [requests, setRequests] = useState<AllianceRequest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [profilePhotoViewer, setProfilePhotoViewer] = useState<{ uri: string; name?: string } | null>(null);

  const load = useCallback(async (searchQuery: string) => {
    setIsLoading(true);
    setError("");
    try {
      const [peopleResponse, requestsResponse] = await Promise.all([
        api.get<{ people: Person[] }>("/v1/social/allies/people", { params: { query: searchQuery } }),
        api.get<{ requests: AllianceRequest[] }>("/v1/social/allies/requests"),
      ]);
      setPeople(peopleResponse.data.people);
      setRequests(requestsResponse.data.requests);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Chargement des personnes impossible."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load("");
  }, [load]));

  const search = () => void load(query.trim());

  const openProfilePhoto = (photoUrl: string | null, name: string | null) => {
    if (!photoUrl) return;
    setProfilePhotoViewer({ uri: photoUrl, name: name ?? undefined });
  };

  const requestAlliance = async (person: Person) => {
    setWorkingId(person.id);
    setError("");
    setNotice("");
    try {
      const { data } = await api.post<{ status: string }>(`/v1/social/alliance/${encodeURIComponent(person.id)}`);
      setNotice(data.status === "ALLIED" ? "Vous êtes maintenant alliés." : "Demande d’alliance envoyée.");
      await load(query.trim());
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Envoi de la demande impossible."));
    } finally {
      setWorkingId(null);
    }
  };

  const answerRequest = async (request: AllianceRequest, decision: "accept" | "decline") => {
    setWorkingId(request.id);
    setError("");
    setNotice("");
    try {
      const requestPath =
        decision === "accept"
          ? `/v1/social/alliance/${encodeURIComponent(request.id)}/accept`
          : `/v1/social/alliance/${encodeURIComponent(request.id)}/decline`;
      await api.post(requestPath);
      setNotice(decision === "accept" ? "Demande acceptée." : "Demande refusée.");
      await load(query.trim());
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Mise à jour de la demande impossible."));
    } finally {
      setWorkingId(null);
    }
  };

  const inviteOnWhatsApp = async () => {
    const digits = query.replace(/\D/g, "");
    const phone = digits.length >= 8 && digits.length <= 15 ? digits : "";
    const link = phone ? `https://wa.me/${phone}` : "https://wa.me/";
    const message = encodeURIComponent("Rejoignez-moi sur QuartierPlus pour tisser des alliances dans le quartier.");
    try {
      await Linking.openURL(`${link}?text=${message}`);
    } catch (linkError) {
      setError(getApiErrorMessage(linkError, "Ouverture de WhatsApp impossible."));
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={styles.back}>
          <ArrowLeft color={colors.text} size={19} />
          <Text style={[styles.backText, { color: colors.text }]}>Profil</Text>
        </Pressable>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Personnes à rallier</Text>
        <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
          Découvrez les personnes de votre quartier ou recherchez un nom ou un numéro.
        </Text>

        <View style={[styles.searchRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            accessibilityLabel="Rechercher par nom ou numéro de téléphone"
            autoCapitalize="none"
            onChangeText={setQuery}
            onSubmitEditing={search}
            placeholder="Nom ou numéro de téléphone"
            placeholderTextColor={colors.secondaryText}
            style={[styles.searchInput, { color: colors.text }]}
            value={query}
          />
          <Pressable accessibilityLabel="Rechercher" accessibilityRole="button" onPress={search} style={styles.searchButton}>
            <Search color="#ffffff" size={18} />
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" onPress={() => void inviteOnWhatsApp()} style={[styles.whatsappButton, { borderColor: colors.border }]}>
          <UserPlus color="#16834f" size={17} />
          <Text style={[styles.whatsappText, { color: colors.text }]}>Inviter sur WhatsApp</Text>
        </Pressable>

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {isLoading ? <ActivityIndicator color="#16834f" style={styles.loader} /> : null}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {query.trim() ? "Résultats de recherche" : "Suggestions de votre quartier"}
        </Text>
        {!isLoading && !people.length ? (
          <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucune personne trouvée pour le moment.</Text>
        ) : people.map((person) => (
          <View key={person.id} style={[styles.personRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Pressable
              accessibilityLabel={`Agrandir la photo de ${person.name || "profil"}`}
              accessibilityRole="button"
              disabled={!person.profile_photo_url}
              onPress={() => openProfilePhoto(person.profile_photo_url, person.name)}
            >
              <ProfileAvatar
                name={person.name}
                photoUrl={person.profile_photo_url}
                size={42}
                isAlly={person.alliance_status === "ALLIED"}
                isProVerified={person.badge === "Commerçant Certifié"}
              />
            </Pressable>
            <View style={styles.personInfo}>
              <Text style={[styles.personName, { color: colors.text }]}>{person.name || "Membre QuartierPlus"}</Text>
              <Text style={[styles.personNeighborhood, { color: colors.secondaryText }]}>{person.neighborhood || "Quartier non renseigné"}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: person.alliance_status !== null || workingId === person.id }}
              disabled={person.alliance_status !== null || workingId === person.id}
              onPress={() => void requestAlliance(person)}
              style={[styles.actionButton, person.alliance_status && styles.actionDisabled]}
            >
              <Text style={styles.actionText}>
                {person.alliance_status === "ALLIED" ? "Allié ✓" :
                  person.alliance_status === "PENDING" ? "Envoyé" :
                    person.alliance_status === "RECEIVED" ? "Demande reçue" : "Se rallier"}
              </Text>
            </Pressable>
          </View>
        ))}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>Demandes reçues</Text>
        {!requests.length ? (
          <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucune demande en attente.</Text>
        ) : requests.map((request) => (
          <View key={request.id} style={[styles.requestCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.requestHeader}>
              <Pressable
                accessibilityLabel={`Agrandir la photo de ${request.name || "profil"}`}
                accessibilityRole="button"
                disabled={!request.profile_photo_url}
                onPress={() => openProfilePhoto(request.profile_photo_url, request.name)}
              >
                <ProfileAvatar
                  name={request.name}
                  photoUrl={request.profile_photo_url}
                  size={42}
                  isProVerified={request.badge === "Commerçant Certifié"}
                />
              </Pressable>
              <Text style={[styles.personName, styles.requestName, { color: colors.text }]}>{request.name || "Membre QuartierPlus"}</Text>
            </View>
            <View style={styles.requestActions}>
              <Pressable accessibilityRole="button" disabled={workingId === request.id} onPress={() => void answerRequest(request, "accept")} style={styles.actionButton}>
                <Text style={styles.actionText}>Accepter</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={workingId === request.id} onPress={() => void answerRequest(request, "decline")} style={styles.declineButton}>
                <Text style={styles.declineText}>Refuser</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {profilePhotoViewer?.uri && (
          <ProfilePhotoViewer
            uri={profilePhotoViewer.uri}
            visible={!!profilePhotoViewer}
            onRequestClose={() => setProfilePhotoViewer(null)}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { gap: 12, padding: 18, paddingBottom: 48, paddingTop: 54 },
  back: { alignItems: "center", flexDirection: "row", gap: 7, minHeight: 34 },
  backText: { fontSize: 13, fontWeight: "700" },
  title: { fontSize: 27, fontWeight: "900" },
  subtitle: { fontSize: 13, lineHeight: 19, marginTop: -7 },
  searchRow: { alignItems: "center", borderRadius: 10, borderWidth: 1, flexDirection: "row", minHeight: 48, paddingLeft: 12, paddingRight: 4 },
  searchInput: { flex: 1, fontSize: 14, minHeight: 44 },
  searchButton: { alignItems: "center", backgroundColor: "#16834f", borderRadius: 8, height: 40, justifyContent: "center", width: 42 },
  whatsappButton: { alignItems: "center", alignSelf: "flex-start", borderRadius: 8, borderWidth: 1, flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  whatsappText: { fontSize: 12, fontWeight: "700" },
  sectionTitle: { fontSize: 16, fontWeight: "800", marginTop: 8 },
  personRow: { alignItems: "center", borderRadius: 10, borderWidth: 1, flexDirection: "row", gap: 10, padding: 10 },
  personInfo: { flex: 1 },
  personName: { fontSize: 13, fontWeight: "800" },
  personNeighborhood: { fontSize: 11, marginTop: 3 },
  actionButton: { alignItems: "center", backgroundColor: "#16834f", borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8 },
  actionDisabled: { backgroundColor: "#64748b" },
  actionText: { color: "#ffffff", fontSize: 11, fontWeight: "800" },
  requestCard: { borderRadius: 10, borderWidth: 1, gap: 10, padding: 11 },
  requestHeader: { alignItems: "center", flexDirection: "row", gap: 10 },
  requestName: { flex: 1 },
  requestActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  declineButton: { alignItems: "center", borderColor: "#b91c1c", borderRadius: 7, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  declineText: { color: "#b91c1c", fontSize: 11, fontWeight: "800" },
  empty: { fontSize: 13, lineHeight: 18, paddingVertical: 6 },
  error: { color: "#b91c1c", fontSize: 13 },
  notice: { color: "#16834f", fontSize: 13, fontWeight: "700" },
  loader: { marginVertical: 7 },
});
