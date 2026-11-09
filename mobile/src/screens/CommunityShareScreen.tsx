import { useNavigation, useRoute } from "@react-navigation/native";
import type { NavigationProp, RouteProp } from "@react-navigation/native";
import { ArrowLeft, Check, Plus, RefreshCw, Users } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTheme } from "../context/ThemeContext";
import type { RootStackParamList } from "../navigation/types";
import api from "../services/api";
import FeedMedia from "./FeedMedia";

type Destination = {
  id: string;
  name: string;
  description: string;
  status?: string;
  visibility?: "PUBLIC" | "PRIVATE";
  participant_count?: number;
  member_count?: number;
};

type SharedFeedPost = {
  id: string;
  post_id: string;
  caption: string;
  media_url: string;
  media_type: "image" | "video";
  author_name: string | null;
  shared_by_name: string | null;
  comment: string | null;
  shared_at: string;
  additional_media: string[];
};

const messageFrom = (error: unknown) =>
  error instanceof Error ? error.message : "Une erreur est survenue.";

export default function CommunityShareScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "CommunityShare">>();
  const { colors } = useTheme();
  const { destinationType, post } = route.params;
  const destinationLabel = destinationType === "alliance" ? "alliance" : "groupe";
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [discoverableGroups, setDiscoverableGroups] = useState<Destination[]>([]);
  const [selectedDestination, setSelectedDestination] = useState<Destination | null>(null);
  const [sharedPosts, setSharedPosts] = useState<SharedFeedPost[]>([]);
  const [comment, setComment] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupVisibility, setGroupVisibility] = useState<"PUBLIC" | "PRIVATE">("PRIVATE");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDestinations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [available, discoverable] = await Promise.all([
        api.get<{ destinations: Destination[] }>(
          `/v1/social/share-destinations/${destinationType}`,
          { headers: { "Cache-Control": "no-cache" } },
        ),
        destinationType === "group"
          ? api.get<{ groups: Destination[] }>("/v1/social/groups/discover", {
              headers: { "Cache-Control": "no-cache" },
            })
          : Promise.resolve({ data: { groups: [] } }),
      ]);
      setDestinations(available.data.destinations);
      setDiscoverableGroups(discoverable.data.groups);
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [destinationType]);

  useEffect(() => {
    void loadDestinations();
  }, [loadDestinations]);

  const fetchFeed = useCallback(async (destinationId: string) => {
    const response = await api.get<{ posts: SharedFeedPost[] }>(
      `/v1/social/destinations/${destinationType}/${encodeURIComponent(destinationId)}/feed`,
      { headers: { "Cache-Control": "no-cache" } },
    );
    return response.data.posts;
  }, [destinationType]);

  useEffect(() => {
    if (!selectedDestination) {
      setSharedPosts([]);
      setFeedError(null);
      return;
    }
    let active = true;
    setIsLoadingFeed(true);
    setFeedError(null);
    void fetchFeed(selectedDestination.id)
      .then((posts) => {
        if (active) setSharedPosts(posts);
      })
      .catch((loadError) => {
        if (active) setFeedError(messageFrom(loadError));
      })
      .finally(() => {
        if (active) setIsLoadingFeed(false);
      });
    return () => {
      active = false;
    };
  }, [fetchFeed, selectedDestination]);

  const createGroup = async () => {
    if (!groupName.trim()) {
      setError("Saisissez un nom pour le groupe.");
      return;
    }
    setIsCreatingGroup(true);
    setError(null);
    try {
      const response = await api.post<{ group: Destination }>("/v1/social/groups", {
        name: groupName.trim(),
        description: groupDescription.trim(),
        visibility: groupVisibility,
      });
      setGroupName("");
      setGroupDescription("");
      await loadDestinations();
      setSelectedDestination(response.data.group);
      setNotice("Groupe créé. Vous en êtes le premier membre.");
    } catch (createError) {
      setError(messageFrom(createError));
    } finally {
      setIsCreatingGroup(false);
    }
  };

  const joinGroup = async (group: Destination) => {
    setJoiningGroupId(group.id);
    setError(null);
    try {
      await api.post(`/v1/social/groups/${encodeURIComponent(group.id)}/join`);
      await loadDestinations();
      setSelectedDestination(group);
      setNotice(`Vous avez rejoint « ${group.name} ».`);
    } catch (joinError) {
      setError(messageFrom(joinError));
    } finally {
      setJoiningGroupId(null);
    }
  };

  const confirmShare = async () => {
    if (!selectedDestination) {
      setError(`Choisissez une destination ${destinationLabel}.`);
      return;
    }
    setIsSharing(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/v1/social/posts/${encodeURIComponent(post.id)}/share`, {
        destination_type: destinationType,
        destination_id: selectedDestination.id,
        comment: comment.trim() || undefined,
      });
      setSharedPosts(await fetchFeed(selectedDestination.id));
      setComment("");
      setNotice(`Média partagé dans « ${selectedDestination.name} ».`);
    } catch (shareError) {
      setError(messageFrom(shareError));
    } finally {
      setIsSharing(false);
    }
  };

  const inputStyle = [
    styles.input,
    {
      backgroundColor: colors.card,
      borderColor: colors.border,
      color: colors.text,
    },
  ];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retour"
          onPress={() => navigation.goBack()}
          style={styles.back}
        >
          <ArrowLeft color={colors.text} size={20} />
          <Text style={[styles.backText, { color: colors.text }]}>Retour</Text>
        </Pressable>
        <View style={styles.heading}>
          <Users color={colors.primary} size={23} />
          <View style={styles.headingCopy}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              Partager dans {destinationLabel}
            </Text>
            <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
              Choisissez un espace auquel vous avez accès, puis confirmez le partage.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Actualiser les destinations"
            onPress={() => void loadDestinations()}
            style={styles.refresh}
          >
            <RefreshCw color={colors.text} size={18} />
          </Pressable>
        </View>

        <View style={[styles.preview, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.previewTitle, { color: colors.text }]}>{post.title}</Text>
          {post.caption ? (
            <Text style={[styles.body, { color: colors.secondaryText }]}>{post.caption}</Text>
          ) : null}
          <FeedMedia
            uri={post.mediaUrl}
            type={post.mediaType}
            active={false}
            autoPlay={false}
            creatorName={post.authorName}
            height={320}
            showControls
          />
          <Text style={[styles.attribution, { color: colors.secondaryText }]}>
            Publication originale de {post.authorName || "un membre"}
          </Text>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {destinationType === "alliance" ? "Mes alliances" : "Mes groupes"}
        </Text>
        {isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {!isLoading && destinations.length === 0 ? (
          <Text style={[styles.empty, { color: colors.secondaryText }]}>
            {destinationType === "alliance"
              ? "Vous ne participez à aucune alliance partageable."
              : "Vous n’avez pas encore rejoint de groupe."}
          </Text>
        ) : null}
        {destinations.map((destination) => {
          const selected = selectedDestination?.id === destination.id;
          return (
            <Pressable
              key={destination.id}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => {
                setSelectedDestination(destination);
                setNotice(null);
                setError(null);
              }}
              style={[
                styles.destination,
                { backgroundColor: colors.card, borderColor: selected ? colors.primary : colors.border },
              ]}
            >
              <View style={styles.destinationCopy}>
                <Text style={[styles.destinationName, { color: colors.text }]}>{destination.name}</Text>
                <Text style={[styles.destinationDescription, { color: colors.secondaryText }]}>
                  {destination.description || destination.status || destination.visibility || ""}
                </Text>
              </View>
              {selected ? <Check color={colors.primary} size={20} /> : null}
            </Pressable>
          );
        })}

        {destinationType === "group" ? (
          <>
            <View style={[styles.groupForm, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Créer un groupe</Text>
              <TextInput
                accessibilityLabel="Nom du groupe"
                maxLength={100}
                onChangeText={setGroupName}
                placeholder="Nom du groupe"
                placeholderTextColor={colors.secondaryText}
                style={inputStyle}
                value={groupName}
              />
              <TextInput
                accessibilityLabel="Description du groupe"
                maxLength={500}
                multiline
                onChangeText={setGroupDescription}
                placeholder="Description (facultative)"
                placeholderTextColor={colors.secondaryText}
                style={[...inputStyle, styles.multiline]}
                value={groupDescription}
              />
              <View style={styles.visibilityRow}>
                {(["PRIVATE", "PUBLIC"] as const).map((visibility) => {
                  const selected = groupVisibility === visibility;
                  return (
                    <Pressable
                      key={visibility}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => setGroupVisibility(visibility)}
                      style={[
                        styles.visibilityButton,
                        { borderColor: selected ? colors.primary : colors.border },
                      ]}
                    >
                      <Text style={[styles.visibilityText, { color: selected ? colors.primary : colors.text }]}>
                        {visibility === "PRIVATE" ? "Privé" : "Public"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.hint, { color: colors.secondaryText }]}>
                Un groupe privé n’est visible que par ses membres. Un groupe public peut être découvert et rejoint.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={isCreatingGroup}
                onPress={() => void createGroup()}
                style={[styles.primaryButton, isCreatingGroup && styles.disabled]}
              >
                {isCreatingGroup
                  ? <ActivityIndicator color="#ffffff" />
                  : <><Plus color="#ffffff" size={18} /><Text style={styles.primaryText}>Créer le groupe</Text></>}
              </Pressable>
            </View>

            {discoverableGroups.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Groupes publics à rejoindre</Text>
                {discoverableGroups.map((group) => (
                  <View
                    key={group.id}
                    style={[styles.discoverRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.destinationCopy}>
                      <Text style={[styles.destinationName, { color: colors.text }]}>{group.name}</Text>
                      <Text style={[styles.destinationDescription, { color: colors.secondaryText }]}>
                        {group.description || `${group.member_count ?? 0} membre(s)`}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={joiningGroupId === group.id}
                      onPress={() => void joinGroup(group)}
                      style={styles.joinButton}
                    >
                      {joiningGroupId === group.id
                        ? <ActivityIndicator color={colors.primary} />
                        : <Text style={[styles.joinText, { color: colors.primary }]}>Rejoindre</Text>}
                    </Pressable>
                  </View>
                ))}
              </>
            ) : null}
          </>
        ) : null}

        {selectedDestination ? (
          <View style={[styles.shareForm, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Confirmer dans « {selectedDestination.name} »
            </Text>
            <TextInput
              accessibilityLabel="Commentaire facultatif"
              maxLength={1000}
              multiline
              onChangeText={setComment}
              placeholder="Ajouter un commentaire (facultatif)"
              placeholderTextColor={colors.secondaryText}
              style={[...inputStyle, styles.multiline]}
              value={comment}
            />
            <Pressable
              accessibilityRole="button"
              disabled={isSharing}
              onPress={() => void confirmShare()}
              style={[styles.primaryButton, isSharing && styles.disabled]}
            >
              {isSharing
                ? <ActivityIndicator color="#ffffff" />
                : <><Check color="#ffffff" size={18} /><Text style={styles.primaryText}>Confirmer le partage</Text></>}
            </Pressable>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Fil de {destinationLabel}</Text>
            {isLoadingFeed ? <ActivityIndicator color={colors.primary} /> : null}
            {feedError ? <Text accessibilityRole="alert" style={styles.error}>{feedError}</Text> : null}
            {!isLoadingFeed && !feedError && sharedPosts.length === 0 ? (
              <Text style={[styles.empty, { color: colors.secondaryText }]}>
                Aucun média n’a encore été partagé dans cet espace.
              </Text>
            ) : null}
            {sharedPosts.map((item) => (
              <View
                key={item.id}
                style={[styles.feedItem, { borderColor: colors.border }]}
              >
                <Text style={[styles.attribution, { color: colors.secondaryText }]}>
                  {item.shared_by_name || "Un membre"} a partagé la publication de {item.author_name || "un membre"}
                </Text>
                {item.comment ? <Text style={[styles.body, { color: colors.text }]}>{item.comment}</Text> : null}
                {item.caption ? <Text style={[styles.body, { color: colors.secondaryText }]}>{item.caption}</Text> : null}
                <FeedMedia
                  uri={item.media_url}
                  type={item.media_type}
                  active={false}
                  autoPlay={false}
                  creatorName={item.author_name || undefined}
                  height={320}
                  showControls
                />
              </View>
            ))}
          </View>
        ) : null}

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={[styles.notice, { color: colors.primary }]}>{notice}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 18, paddingBottom: 36, gap: 14 },
  back: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 40 },
  backText: { fontSize: 14, fontWeight: "600" },
  heading: { alignItems: "center", flexDirection: "row", gap: 12 },
  headingCopy: { flex: 1 },
  title: { fontSize: 22, fontWeight: "800" },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  refresh: { padding: 8 },
  preview: { borderRadius: 14, borderWidth: 1, gap: 8, overflow: "hidden", padding: 12 },
  previewTitle: { fontSize: 17, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  attribution: { fontSize: 12, lineHeight: 18 },
  sectionTitle: { fontSize: 17, fontWeight: "700" },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: 8 },
  destination: { alignItems: "center", borderRadius: 12, borderWidth: 1.5, flexDirection: "row", gap: 10, padding: 14 },
  destinationCopy: { flex: 1, gap: 4 },
  destinationName: { fontSize: 15, fontWeight: "700" },
  destinationDescription: { fontSize: 12, lineHeight: 17 },
  groupForm: { borderRadius: 14, borderWidth: 1, gap: 10, padding: 14 },
  input: { borderRadius: 10, borderWidth: 1, fontSize: 14, minHeight: 46, paddingHorizontal: 12, paddingVertical: 10 },
  multiline: { minHeight: 78, textAlignVertical: "top" },
  visibilityRow: { flexDirection: "row", gap: 10 },
  visibilityButton: { alignItems: "center", borderRadius: 9, borderWidth: 1, flex: 1, minHeight: 40, justifyContent: "center" },
  visibilityText: { fontSize: 13, fontWeight: "700" },
  hint: { fontSize: 12, lineHeight: 17 },
  primaryButton: { alignItems: "center", backgroundColor: "#087f5b", borderRadius: 10, flexDirection: "row", gap: 9, justifyContent: "center", minHeight: 48, paddingHorizontal: 14 },
  primaryText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.6 },
  discoverRow: { alignItems: "center", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 10, padding: 13 },
  joinButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 8 },
  joinText: { fontSize: 13, fontWeight: "700" },
  shareForm: { borderRadius: 14, borderWidth: 1, gap: 12, padding: 14 },
  feedItem: { borderTopWidth: 1, gap: 8, paddingTop: 12 },
  error: { color: "#b42318", fontSize: 13, lineHeight: 19 },
  notice: { fontSize: 13, fontWeight: "600" },
});
