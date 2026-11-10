import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { Clapperboard, Plus, RefreshCw } from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import type { MainTabParamList } from "../navigation/types";
import {
  uploadCloudinaryMedia,
  type CloudinaryUploadSignature,
} from "../services/cloudinaryUpload";
import { exceedsVideoDurationLimit } from "../services/videoDuration";
import api from "../services/api";

type SeriesItem = {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  poster_url: string | null;
  country_code: string | null;
  language_code: string;
  culture_tags: string[];
  credits: { name: string; role: string }[];
  status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  episode_count?: number;
};

type EpisodeItem = {
  id: string;
  episode_number: number;
  title: string;
  description: string;
  video_url: string | null;
  duration_seconds: number | null;
  subtitles: { language_code: string; url: string }[];
  progress_seconds: number;
  completed: boolean;
};

type SeriesDetail = SeriesItem & {
  seasons: { id: string; season_number: number; title: string; episodes: EpisodeItem[] }[];
};

type ResumeEpisode = {
  series_id: string;
  series_title: string;
  episode_id: string;
  episode_title: string;
  video_url: string;
  duration_seconds: number | null;
  position_seconds: number;
};

const messageFrom = (error: unknown) =>
  error instanceof Error ? error.message : "Une erreur est survenue.";

const formatDuration = (milliseconds: number | null | undefined) => {
  if (!milliseconds || !Number.isFinite(milliseconds)) return "Durée inconnue";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
};

export default function SeriesScreen() {
  const { colors } = useTheme();
  const { user, requestAuthentication } = useAuth();
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const route = useRoute<RouteProp<MainTabParamList, "Séries">>();
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [mine, setMine] = useState<SeriesItem[]>([]);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [resume, setResume] = useState<ResumeEpisode | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cultureTagsText, setCultureTagsText] = useState("");
  const [countryCode, setCountryCode] = useState(user?.country_code ?? "BF");
  const [languageCode, setLanguageCode] = useState("fr");
  const [seasonTitle, setSeasonTitle] = useState("Saison 1");
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [episodeVideoUrl, setEpisodeVideoUrl] = useState("");
  const [selectedVideo, setSelectedVideo] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [selectedVideoSize, setSelectedVideoSize] = useState<number | null>(null);
  const [videoUploadProgress, setVideoUploadProgress] = useState<number | null>(null);
  const [isSavingEpisode, setIsSavingEpisode] = useState(false);
  const videoUploadController = useRef<AbortController | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [cultureFilter, setCultureFilter] = useState<string | null>(null);

  const loadSeries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [catalog, own, latest] = await Promise.all([
        api.get<{ series: SeriesItem[] }>("/v1/series", {
          headers: { "Cache-Control": "no-cache" },
        }),
        user
          ? api.get<{ series: SeriesItem[] }>("/v1/series/mine", {
              headers: { "Cache-Control": "no-cache" },
            })
          : Promise.resolve({ data: { series: [] } }),
        user
          ? api.get<{ resume: ResumeEpisode | null }>("/v1/series/resume", {
              headers: { "Cache-Control": "no-cache" },
            })
          : Promise.resolve({ data: { resume: null } }),
      ]);
      setSeries(catalog.data.series);
      setMine(own.data.series);
      setResume(latest.data.resume);
      if (route.params?.action === "cultures") setCultureFilter(null);
      if (route.params?.action === "resume" && latest.data.resume) {
        const detailResponse = await api.get<{ series: SeriesDetail }>(
          `/v1/series/${latest.data.resume.series_id}`,
          { headers: { "Cache-Control": "no-cache" } },
        );
        setDetail(detailResponse.data.series);
        const episode = detailResponse.data.series.seasons
          .flatMap((season) => season.episodes)
          .find((item) => item.id === latest.data.resume?.episode_id);
        if (episode) setActiveEpisode(episode);
        else setError("L’épisode à reprendre n’est plus disponible.");
      }
      if (route.params?.action) navigation.setParams({ action: undefined });
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [navigation, route.params?.action, user]);

  const openSeries = async (item: SeriesItem) => {
    setError(null);
    try {
      const response = await api.get<{ series: SeriesDetail }>(`/v1/series/${item.id}`, {
        headers: { "Cache-Control": "no-cache" },
      });
      setDetail(response.data.series);
    } catch (detailError) {
      setError(messageFrom(detailError));
    }
  };

  const resumeLastEpisode = async () => {
    if (!resume) return;
    try {
      const response = await api.get<{ series: SeriesDetail }>(`/v1/series/${resume.series_id}`, {
        headers: { "Cache-Control": "no-cache" },
      });
      setDetail(response.data.series);
      const episode = response.data.series.seasons.flatMap((season) => season.episodes)
        .find((item) => item.id === resume.episode_id);
      if (episode) setActiveEpisode(episode);
    } catch (resumeError) {
      Alert.alert("Reprise impossible", messageFrom(resumeError));
    }
  };

  const saveProgress = useCallback(async (episodeId: string, position: number, completed: boolean) => {
    if (!user || !Number.isFinite(position)) return;
    try {
      await api.post(`/v1/series/episodes/${episodeId}/progress`, {
        position_seconds: Math.max(0, Math.floor(position)),
        completed,
      });
    } catch (progressError) {
      console.warn("Unable to save series playback progress:", progressError);
    }
  }, [user?.id]);

  const handleEpisodeProgress = useCallback((position: number, completed: boolean) => {
    if (activeEpisode) void saveProgress(activeEpisode.id, position, completed);
  }, [activeEpisode?.id, saveProgress]);

  const selectAndUploadVideo = async () => {
    if (!detail || detail.creator_id !== user?.id || videoUploadController.current) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Autorisez l’accès à la photothèque pour choisir une vidéo.");
      }
      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        allowsEditing: false,
        quality: 1,
      });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      if (!asset?.uri) throw new Error("La vidéo sélectionnée est indisponible.");
      const extension = asset.fileName?.split(".").pop()?.toLowerCase();
      const mimeType = asset.mimeType?.toLowerCase() ??
        (extension === "mov" ? "video/quicktime" : extension === "mp4" ? "video/mp4" : "");
      if (!["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType)) {
        throw new Error("Format non accepté. Choisissez une vidéo MP4 ou MOV.");
      }
      setSelectedVideo(asset);
      const size = asset.fileSize ?? new File(asset.uri).size;
      setSelectedVideoSize(size);
      setEpisodeVideoUrl("");
      setVideoUploadProgress(0);
      const controller = new AbortController();
      videoUploadController.current = controller;
      const response = await api.post<CloudinaryUploadSignature & {
        max_bytes: number;
        max_duration_seconds: number;
      }>(`/v1/series/${detail.id}/media/sign`, { media_type: "video" }, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error("Importation annulée.");
      if (size > response.data.max_bytes) {
        throw new Error(`La vidéo dépasse la limite de ${(response.data.max_bytes / (1024 * 1024)).toFixed(0)} Mo.`);
      }
      if (typeof asset.duration === "number" && exceedsVideoDurationLimit(
        asset.duration / 1000,
        response.data.max_duration_seconds,
      )) {
        throw new Error(`La vidéo doit durer au maximum ${response.data.max_duration_seconds} secondes.`);
      }
      const upload = await uploadCloudinaryMedia(
        response.data,
        {
          uri: asset.uri,
          name: asset.fileName ?? `episode-${Date.now()}.${extension ?? "mp4"}`,
          type: mimeType,
          size,
        },
        { signal: controller.signal, onProgress: setVideoUploadProgress },
      );
      if (!upload.secureUrl) throw new Error("Le serveur de stockage n’a pas confirmé la vidéo.");
      setEpisodeVideoUrl(upload.secureUrl);
      setVideoUploadProgress(100);
    } catch (uploadError) {
      if (!(uploadError instanceof Error && uploadError.name === "CanceledError")) {
        Alert.alert("Importation impossible", messageFrom(uploadError));
      }
      setSelectedVideo(null);
      setSelectedVideoSize(null);
      setVideoUploadProgress(null);
      setEpisodeVideoUrl("");
    } finally {
      videoUploadController.current = null;
    }
  };

  const cancelVideoUpload = () => {
    videoUploadController.current?.abort();
    videoUploadController.current = null;
    setSelectedVideo(null);
    setSelectedVideoSize(null);
    setVideoUploadProgress(null);
    setEpisodeVideoUrl("");
  };

  const addEpisode = async (publish: boolean) => {
    if (!detail || detail.creator_id !== user?.id) return;
    if (!episodeTitle.trim() || (publish && !episodeVideoUrl.trim().startsWith("https://"))) {
      Alert.alert("Épisode incomplet", publish ? "Ajoutez un titre et une vidéo importée ou une URL HTTPS valide." : "Ajoutez un titre à l’épisode.");
      return;
    }
    setIsSavingEpisode(true);
    try {
      let season = detail.seasons[0];
      if (!season) {
        const seasonResponse = await api.post<{ season: { id: string; title: string; season_number: number } }>(
          `/v1/series/${detail.id}/seasons`,
          { season_number: 1, title: seasonTitle.trim() || "Saison 1" },
        );
        season = { ...seasonResponse.data.season, episodes: [] };
      }
      await api.post(`/v1/series/seasons/${season.id}/episodes`, {
        episode_number: season.episodes.length + 1,
        title: episodeTitle.trim(),
        video_url: episodeVideoUrl.trim(),
        is_published: publish,
      });
      if (publish && detail.status !== "PUBLISHED") {
        await api.post(`/v1/series/${detail.id}/publish`);
      }
      setEpisodeTitle("");
      setEpisodeVideoUrl("");
      setSelectedVideo(null);
      setSelectedVideoSize(null);
      setVideoUploadProgress(null);
      await Promise.all([loadSeries(), openSeries(detail)]);
      Alert.alert(publish ? "Épisode publié" : "Brouillon enregistré", publish ? "Votre épisode est maintenant disponible dans le catalogue." : "Votre brouillon est enregistré.");
    } catch (episodeError) {
      Alert.alert("Publication impossible", messageFrom(episodeError));
    } finally {
      setIsSavingEpisode(false);
    }
  };

  useFocusEffect(useCallback(() => {
    void loadSeries();
  }, [loadSeries]));

  const cultureOptions = [...new Set(series.flatMap((item) => item.culture_tags))]
    .filter((tag) => tag.trim())
    .sort((left, right) => left.localeCompare(right));
  const filteredSeries = series.filter((item) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const matchesSearch = !query ||
      `${item.title} ${item.description} ${item.country_code ?? ""} ${item.language_code} ${item.culture_tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(query);
    return matchesSearch && (!cultureFilter || item.culture_tags.includes(cultureFilter));
  });

  const createSeries = async () => {
    if (!user) {
      requestAuthentication();
      return;
    }
    const cultureTags = [...new Set(cultureTagsText.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (!title.trim() || !/^[A-Z]{2,3}$/.test(countryCode.trim()) ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(languageCode.trim())) {
      Alert.alert("Informations invalides", "Vérifiez le titre, le code pays et la langue.");
      return;
    }
    if (cultureTags.length > 10 || cultureTags.some((tag) => tag.length > 48)) {
      Alert.alert("Cultures invalides", "Saisissez au maximum 10 cultures de 48 caractères chacune.");
      return;
    }
    setIsCreating(true);
    try {
      await api.post("/v1/series", {
        title: title.trim(),
        description: description.trim(),
        country_code: countryCode.trim(),
        language_code: languageCode.trim(),
        culture_tags: cultureTags,
      });
      setTitle("");
      setDescription("");
      setCultureTagsText("");
      setShowCreateForm(false);
      await loadSeries();
      Alert.alert("Série créée", "Le brouillon est enregistré dans vos productions.");
    } catch (createError) {
      Alert.alert("Création impossible", messageFrom(createError));
    } finally {
      setIsCreating(false);
    }
  };

  const styles = createStyles(colors);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.switcher} accessibilityRole="tablist">
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: true }} style={[styles.switchButton, styles.selectedSwitch]}>
          <Clapperboard color={colors.onPrimary} size={16} />
          <Text style={styles.selectedSwitchText}>Séries</Text>
        </Pressable>
        <Pressable accessibilityRole="tab" onPress={() => navigation.navigate("Accueil")} style={styles.switchButton}>
          <Text style={styles.switchText}>Communauté</Text>
        </Pressable>
      </View>

      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>QUARTIERPLUS ORIGINALS</Text>
          <Text style={styles.title}>Séries</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Actualiser les séries" onPress={() => void loadSeries()} style={styles.iconButton}>
          <RefreshCw color={colors.text} size={18} />
        </Pressable>
      </View>

      <View style={styles.creatorRow}>
        <Text style={styles.sectionTitle}>Productions africaines et du monde</Text>
        <Pressable accessibilityRole="button" onPress={() => user ? setShowCreateForm((shown) => !shown) : requestAuthentication()} style={styles.createButton}>
          <Plus color={colors.onPrimary} size={17} />
          <Text style={styles.createButtonText}>Créer une série</Text>
        </Pressable>
      </View>

      <View style={styles.discoveryBlock}>
        <Text style={styles.sectionTitle}>Explorer les cultures</Text>
        <TextInput
          accessibilityLabel="Rechercher une série"
          onChangeText={setSearchQuery}
          placeholder="Série, pays, langue ou culture"
          placeholderTextColor={colors.secondaryText}
          style={styles.searchInput}
          value={searchQuery}
        />
        {cultureOptions.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cultureFilters}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: cultureFilter === null }}
              onPress={() => setCultureFilter(null)}
              style={[styles.cultureChip, cultureFilter === null && styles.cultureChipSelected]}
            >
              <Text style={[styles.cultureChipText, cultureFilter === null && styles.cultureChipTextSelected]}>Toutes</Text>
            </Pressable>
            {cultureOptions.map((tag) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: cultureFilter === tag }}
                key={tag}
                onPress={() => setCultureFilter((current) => current === tag ? null : tag)}
                style={[styles.cultureChip, cultureFilter === tag && styles.cultureChipSelected]}
              >
                <Text style={[styles.cultureChipText, cultureFilter === tag && styles.cultureChipTextSelected]}>{tag}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text style={styles.metadata}>Les productions publiées n’ont pas encore de culture renseignée.</Text>
        )}
      </View>

      {resume && (
        <Pressable accessibilityRole="button" onPress={() => void resumeLastEpisode()} style={styles.resumeButton}>
          <Text style={styles.resumeEyebrow}>REPRENDRE MA SÉRIE</Text>
          <Text numberOfLines={1} style={styles.resumeTitle}>{resume.series_title} · {resume.episode_title}</Text>
          <Text style={styles.resumeAction}>Continuer à {Math.floor(resume.position_seconds / 60)} min</Text>
        </Pressable>
      )}

      {showCreateForm && (
        <View style={styles.form}>
          <Text style={styles.formTitle}>Nouvelle production</Text>
          <Field label="Titre" value={title} onChangeText={setTitle} maxLength={160} styles={styles} />
          <Field label="Synopsis" value={description} onChangeText={setDescription} maxLength={10000} multiline styles={styles} />
          <Field label="Cultures (séparées par des virgules)" value={cultureTagsText} onChangeText={setCultureTagsText} maxLength={500} styles={styles} />
          <View style={styles.fieldRow}>
            <Field label="Pays (ISO)" value={countryCode} onChangeText={(value) => setCountryCode(value.toUpperCase())} maxLength={3} styles={styles} />
            <Field label="Langue" value={languageCode} onChangeText={setLanguageCode} maxLength={12} styles={styles} />
          </View>
          <Pressable accessibilityRole="button" disabled={isCreating} onPress={() => void createSeries()} style={[styles.submitButton, isCreating && styles.disabled]}>
            <Text style={styles.submitButtonText}>{isCreating ? "Enregistrement…" : "Enregistrer le brouillon"}</Text>
          </Pressable>
        </View>
      )}

      {user && mine.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Mes productions</Text>
          {mine.map((item) => <SeriesRow key={item.id} item={item} styles={styles} onPress={() => void openSeries(item)} />)}
        </>
      )}
      <Text style={styles.sectionTitle}>À découvrir</Text>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {isLoading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
      {!isLoading && !error && series.length === 0 && (
        <Text style={styles.empty}>Les premières séries seront bientôt disponibles.</Text>
      )}
      {filteredSeries.map((item) => <SeriesRow key={item.id} item={item} styles={styles} onPress={() => void openSeries(item)} />)}
      {!isLoading && !error && series.length > 0 && filteredSeries.length === 0 && (
        <Text style={styles.empty}>Aucune série ne correspond à cette recherche.</Text>
      )}

      {detail && (
        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <View style={styles.detailCopy}>
              <Text style={styles.eyebrow}>SÉRIE</Text>
              <Text style={styles.detailTitle}>{detail.title}</Text>
            </View>
            {detail.credits.length > 0 && (
              <View style={styles.creditsBlock}>
                <Text style={styles.sectionTitle}>Générique et distribution</Text>
                {detail.credits.map((credit, index) => (
                  <Text key={`${credit.role}:${credit.name}:${index}`} style={styles.metadata}>
                    {credit.name} · {credit.role}
                  </Text>
                ))}
              </View>
            )}
            {!activeEpisode && (
              <Pressable accessibilityRole="button" onPress={() => setDetail(null)} style={styles.closeButton}>
                <Text style={styles.closeText}>Fermer</Text>
              </Pressable>
            )}
          </View>
          {detail.seasons.map((season) => (
            <View key={season.id} style={styles.season}>
              <Text style={styles.sectionTitle}>{season.title}</Text>
              {season.episodes.map((episode) => (
                <Pressable key={episode.id} accessibilityRole="button" onPress={() => setActiveEpisode(episode)} style={styles.episodeRow}>
                  <Text style={styles.episodeNumber}>{String(episode.episode_number).padStart(2, "0")}</Text>
                  <View style={styles.episodeCopy}>
                    <Text style={styles.seriesTitle}>{episode.title}</Text>
                    <Text style={styles.metadata}>{episode.completed ? "Terminé" : episode.progress_seconds > 0 ? `Reprendre · ${Math.floor(episode.progress_seconds / 60)} min` : "Épisode"}</Text>
                  </View>
                  <Text style={styles.playLabel}>Lire</Text>
                </Pressable>
              ))}
            </View>
          ))}
          {detail.seasons.length === 0 && <Text style={styles.empty}>Aucun épisode publié pour le moment.</Text>}
          {detail.creator_id === user?.id && (
            <View style={styles.form}>
              <Text style={styles.formTitle}>{detail.seasons.length === 0 ? "Créer la saison 1 et son épisode" : "Ajouter un épisode"}</Text>
              {detail.seasons.length === 0 && <Field label="Titre de la saison" value={seasonTitle} onChangeText={setSeasonTitle} maxLength={160} styles={styles} />}
              <Field label="Titre de l’épisode" value={episodeTitle} onChangeText={setEpisodeTitle} maxLength={160} styles={styles} />
              <Pressable accessibilityRole="button" disabled={videoUploadProgress !== null && videoUploadProgress < 100} onPress={() => void selectAndUploadVideo()} style={[styles.importButton, videoUploadProgress !== null && videoUploadProgress < 100 && styles.disabled]}>
                <Plus color={colors.onPrimary} size={17} />
                <Text style={styles.importButtonText}>{videoUploadProgress !== null && videoUploadProgress < 100 ? "Importation en cours…" : "Importer une vidéo"}</Text>
              </Pressable>
              {selectedVideo && (
                <View style={styles.selectedVideoBlock}>
                  <SelectedVideoPreview uri={selectedVideo.uri} styles={styles} />
                  <Text numberOfLines={1} style={styles.metadata}>{selectedVideo.fileName ?? "Vidéo sélectionnée"}</Text>
                  <Text style={styles.metadata}>
                    {formatDuration(selectedVideo.duration)} · {((selectedVideoSize ?? 0) / (1024 * 1024)).toFixed(1)} Mo
                  </Text>
                  {videoUploadProgress !== null && (
                    <>
                      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: videoUploadProgress }} style={styles.progressTrack}>
                        <View style={[styles.progressBar, { width: `${videoUploadProgress}%` }]} />
                      </View>
                      <Text style={styles.metadata}>{videoUploadProgress < 100 ? `Transfert · ${videoUploadProgress}%` : "Vidéo prête à publier"}</Text>
                    </>
                  )}
                  <Pressable accessibilityRole="button" onPress={cancelVideoUpload} style={styles.cancelUploadButton}>
                    <Text style={styles.cancelUploadText}>{videoUploadProgress !== null && videoUploadProgress < 100 ? "Annuler le transfert" : "Retirer la vidéo"}</Text>
                  </Pressable>
                </View>
              )}
              <Field label="URL vidéo HTTPS (alternative)" value={episodeVideoUrl} onChangeText={(value) => { setEpisodeVideoUrl(value); if (value) setSelectedVideo(null); }} maxLength={2000} styles={styles} />
              <Pressable accessibilityRole="button" disabled={isSavingEpisode || (videoUploadProgress !== null && videoUploadProgress < 100)} onPress={() => void addEpisode(false)} style={[styles.secondarySubmitButton, isSavingEpisode && styles.disabled]}>
                <Text style={styles.secondarySubmitText}>{isSavingEpisode ? "Enregistrement…" : "Enregistrer en brouillon"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={isSavingEpisode || (videoUploadProgress !== null && videoUploadProgress < 100)} onPress={() => void addEpisode(true)} style={[styles.submitButton, isSavingEpisode && styles.disabled]}>
                <Text style={styles.submitButtonText}>{isSavingEpisode ? "Publication…" : "Publier l’épisode"}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
      {activeEpisode && activeEpisode.video_url && (
        <EpisodePlayback
          key={activeEpisode.id}
          episode={activeEpisode}
          isCreator={detail?.creator_id === user?.id}
          onClose={() => setActiveEpisode(null)}
          onProgress={handleEpisodeProgress}
          styles={styles}
        />
      )}
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  maxLength,
  multiline = false,
  styles,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength: number;
  multiline?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        maxLength={maxLength}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={label}
        placeholderTextColor={styles.placeholder.color as string}
        style={[styles.input, multiline && styles.multiline]}
        value={value}
      />
    </View>
  );
}

function SelectedVideoPreview({
  uri,
  styles,
}: {
  uri: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.muted = true;
  });
  return <VideoView nativeControls player={player} contentFit="contain" style={styles.selectedVideoPreview} />;
}

function SeriesRow({ item, styles, onPress }: { item: SeriesItem; styles: ReturnType<typeof createStyles>; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.seriesRow}>
      <View style={styles.seriesMark}><Clapperboard color="#16856b" size={19} /></View>
      <View style={styles.seriesInfo}>
        <Text style={styles.seriesTitle}>{item.title}</Text>
        <Text numberOfLines={2} style={styles.seriesDescription}>{item.description || "Synopsis à venir"}</Text>
        <Text style={styles.metadata}>{[item.country_code, item.language_code.toUpperCase(), item.episode_count !== undefined ? `${item.episode_count} épisodes` : item.status].filter(Boolean).join(" · ")}</Text>
      </View>
    </Pressable>
  );
}

function EpisodePlayback({
  episode,
  isCreator,
  onClose,
  onProgress,
  styles,
}: {
  episode: EpisodeItem;
  isCreator: boolean;
  onClose: () => void;
  onProgress: (position: number, completed: boolean) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  const { user, requestAuthentication } = useAuth();
  const [poll, setPoll] = useState<{
    id: string;
    question: string;
    closes_at: string;
    options: { id: string; label: string }[];
    has_voted: boolean;
  } | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [pollBusy, setPollBusy] = useState(false);
  const [optionOne, setOptionOne] = useState("");
  const [optionTwo, setOptionTwo] = useState("");
  const [results, setResults] = useState<{ option_id: string; label: string; votes: number }[]>([]);
  const lastSavedPosition = useRef(episode.progress_seconds);
  const player = useVideoPlayer(episode.video_url, (instance) => {
    instance.muted = false;
    instance.timeUpdateEventInterval = 5;
    if (episode.progress_seconds > 0) instance.currentTime = episode.progress_seconds;
    instance.play();
  });

  useEffect(() => {
    const subscription = player.addListener("timeUpdate", ({ currentTime }) => {
      const finished = episode.duration_seconds !== null
        && episode.duration_seconds > 0
        && currentTime >= episode.duration_seconds - 2;
      if (finished || currentTime - lastSavedPosition.current >= 10) {
        lastSavedPosition.current = currentTime;
        onProgress(currentTime, finished);
      }
    });
    return () => subscription.remove();
  }, [episode.duration_seconds, onProgress, player]);

  const closePlayback = useCallback(() => {
    const currentTime = player.currentTime;
    if (currentTime > lastSavedPosition.current) {
      lastSavedPosition.current = currentTime;
      onProgress(currentTime, false);
    }
    player.pause();
    onClose();
  }, [onClose, onProgress, player]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closePlayback();
      return true;
    });
    return () => subscription.remove();
  }, [closePlayback]);

  const loadPoll = useCallback(async () => {
    try {
      const response = await api.get<{
        poll: { id: string; question: string; closes_at: string; options: { id: string; label: string }[]; has_voted: boolean };
        is_open: boolean;
      }>(`/v1/series/episodes/${episode.id}/poll`, { headers: { "Cache-Control": "no-cache" } });
      setPoll(response.data.poll);
      setPollOpen(response.data.is_open);
      if (response.data.poll.has_voted) setSelectedOption("voted");
    } catch {
      setPoll(null);
      setResults([]);
    }
  }, [episode.id]);

  useEffect(() => {
    void loadPoll();
  }, [loadPoll]);

  useEffect(() => {
    if (!isCreator || !poll) return;
    void api.get<{ results: { option_id: string; label: string; votes: number }[] }>(
      `/v1/series/episodes/${episode.id}/poll/results`,
    ).then((response) => setResults(response.data.results)).catch(() => setResults([]));
  }, [episode.id, isCreator, poll]);

  const createPoll = async () => {
    if (!user) {
      requestAuthentication();
      return;
    }
    if (!optionOne.trim() || !optionTwo.trim() || optionOne.trim().toLocaleLowerCase() === optionTwo.trim().toLocaleLowerCase()) {
      Alert.alert("Choix invalides", "Saisissez deux propositions différentes.");
      return;
    }
    setPollBusy(true);
    try {
      await api.post(`/v1/series/episodes/${episode.id}/polls`, {
        options: [optionOne.trim(), optionTwo.trim()],
        closes_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      setOptionOne("");
      setOptionTwo("");
      await loadPoll();
    } catch (error) {
      Alert.alert("Création impossible", messageFrom(error));
    } finally {
      setPollBusy(false);
    }
  };

  const submitVote = async () => {
    if (!user) {
      requestAuthentication();
      return;
    }
    if (!poll || !selectedOption || selectedOption === "voted") return;
    setPollBusy(true);
    try {
      await api.post(`/v1/series/episodes/${episode.id}/vote`, { option_id: selectedOption });
      setSelectedOption("voted");
      await loadPoll();
    } catch (error) {
      Alert.alert("Vote non enregistré", messageFrom(error));
    } finally {
      setPollBusy(false);
    }
  };

  return (
    <View style={styles.playerBlock}>
      <View style={styles.detailHeader}>
        <Text style={styles.sectionTitle}>{episode.title}</Text>
        <Pressable accessibilityRole="button" onPress={closePlayback} style={styles.closeButton}><Text style={styles.closeText}>Fermer</Text></Pressable>
      </View>
      <VideoView nativeControls player={player} contentFit="contain" style={styles.video} />
      {episode.description ? <Text style={styles.seriesDescription}>{episode.description}</Text> : null}
      {episode.subtitles.length > 0 && <Text style={styles.metadata}>Sous-titres disponibles : {episode.subtitles.map((item) => item.language_code).join(", ")}</Text>}
      {poll ? (
        <View style={styles.pollBlock}>
          <Text style={styles.pollQuestion}>{poll.question}</Text>
          {!isCreator && poll.options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedOption === option.id }}
              disabled={!pollOpen || selectedOption === "voted" || pollBusy}
              onPress={() => setSelectedOption(option.id)}
              style={[styles.pollOption, selectedOption === option.id && styles.pollOptionSelected]}
            >
              <Text style={[styles.pollOptionText, selectedOption === option.id && styles.pollOptionTextSelected]}>{option.label}</Text>
            </Pressable>
          ))}
          {!isCreator && selectedOption !== "voted" && pollOpen && (
            <Pressable accessibilityRole="button" disabled={!selectedOption || pollBusy} onPress={() => void submitVote()} style={[styles.submitButton, (!selectedOption || pollBusy) && styles.disabled]}>
              <Text style={styles.submitButtonText}>{pollBusy ? "Envoi…" : "Voter"}</Text>
            </Pressable>
          )}
          {!isCreator && selectedOption === "voted" && <Text style={styles.pollNotice}>Votre vote a été enregistré.</Text>}
          {!pollOpen && <Text style={styles.pollNotice}>Le vote est clôturé.</Text>}
          {isCreator && results.map((item) => (
            <View key={item.option_id} style={styles.resultRow}>
              <Text style={styles.pollOptionText}>{item.label}</Text>
              <Text style={styles.resultCount}>{item.votes}</Text>
            </View>
          ))}
        </View>
      ) : isCreator ? (
        <View style={styles.pollBlock}>
          <Text style={styles.pollQuestion}>Que doit-il se passer dans le prochain épisode ?</Text>
          <Field label="Proposition 1" value={optionOne} onChangeText={setOptionOne} maxLength={240} styles={styles} />
          <Field label="Proposition 2" value={optionTwo} onChangeText={setOptionTwo} maxLength={240} styles={styles} />
          <Pressable accessibilityRole="button" disabled={pollBusy} onPress={() => void createPoll()} style={[styles.submitButton, pollBusy && styles.disabled]}>
            <Text style={styles.submitButtonText}>{pollBusy ? "Création…" : "Ouvrir le vote · 7 jours"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 40, gap: 16 },
  switcher: { flexDirection: "row", alignSelf: "center", backgroundColor: colors.muted, borderRadius: 10, padding: 4, gap: 4 },
  switchButton: { minHeight: 40, paddingHorizontal: 20, borderRadius: 7, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  selectedSwitch: { backgroundColor: "#16856b" },
  selectedSwitchText: { color: "#ffffff", fontWeight: "700" },
  switchText: { color: colors.secondaryText, fontWeight: "600" },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headingCopy: { gap: 3 },
  eyebrow: { color: "#16856b", fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  iconButton: { width: 42, height: 42, borderRadius: 9, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  creatorRow: { gap: 12, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  discoveryBlock: { gap: 9, padding: 14, borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  searchInput: { minHeight: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text },
  cultureFilters: { gap: 8, paddingRight: 8 },
  cultureChip: { minHeight: 34, justifyContent: "center", paddingHorizontal: 12, borderRadius: 17, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  cultureChipSelected: { borderColor: "#16856b", backgroundColor: "#16856b" },
  cultureChipText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  cultureChipTextSelected: { color: "#ffffff" },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  createButton: { alignSelf: "flex-start", minHeight: 42, borderRadius: 8, paddingHorizontal: 14, backgroundColor: "#16856b", flexDirection: "row", alignItems: "center", gap: 8 },
  createButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  resumeButton: { backgroundColor: "#173f36", paddingHorizontal: 15, paddingVertical: 13, borderRadius: 8, gap: 4 },
  resumeEyebrow: { color: "#a4ddc9", fontSize: 10, fontWeight: "800" },
  resumeTitle: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
  resumeAction: { color: "#c5e8dc", fontSize: 12 },
  form: { padding: 14, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 12 },
  formTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  fieldRow: { flexDirection: "row", gap: 12 },
  field: { flex: 1, gap: 5 },
  fieldLabel: { color: colors.secondaryText, fontSize: 12, fontWeight: "600" },
  input: { minHeight: 44, paddingHorizontal: 11, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.text },
  multiline: { minHeight: 88, textAlignVertical: "top", paddingTop: 10 },
  placeholder: { color: colors.secondaryText },
  submitButton: { minHeight: 44, borderRadius: 7, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  submitButtonText: { color: colors.background, fontWeight: "700" },
  secondarySubmitButton: { minHeight: 42, borderRadius: 7, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  secondarySubmitText: { color: colors.text, fontWeight: "700" },
  importButton: { minHeight: 44, borderRadius: 7, backgroundColor: "#16856b", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  importButtonText: { color: "#ffffff", fontWeight: "700" },
  selectedVideoBlock: { gap: 6, padding: 10, borderRadius: 8, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  selectedVideoPreview: { width: "100%", aspectRatio: 16 / 9, maxHeight: 240, backgroundColor: "#101010", borderRadius: 6 },
  progressTrack: { height: 6, overflow: "hidden", borderRadius: 3, backgroundColor: colors.muted },
  progressBar: { height: "100%", backgroundColor: "#16856b" },
  cancelUploadButton: { alignSelf: "flex-start", minHeight: 32, justifyContent: "center" },
  cancelUploadText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.55 },
  seriesRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.border },
  seriesMark: { width: 46, height: 60, borderRadius: 5, backgroundColor: "#d8eee8", alignItems: "center", justifyContent: "center" },
  seriesInfo: { flex: 1, gap: 4 },
  seriesTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  seriesDescription: { color: colors.secondaryText, fontSize: 13, lineHeight: 18 },
  metadata: { color: colors.secondaryText, fontSize: 11, fontWeight: "600" },
  error: { color: colors.danger, paddingVertical: 8 },
  loader: { padding: 20 },
  empty: { color: colors.secondaryText, paddingVertical: 18, textAlign: "center" },
  detail: { padding: 14, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 14 },
  detailHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  detailCopy: { flex: 1, gap: 3 },
  detailTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  creditsBlock: { gap: 5, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  closeButton: { minHeight: 36, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border },
  closeText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  season: { gap: 4 },
  episodeRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  episodeNumber: { color: "#16856b", fontWeight: "800", width: 28 },
  episodeCopy: { flex: 1, gap: 2 },
  playLabel: { color: "#16856b", fontSize: 12, fontWeight: "700" },
  playerBlock: { padding: 12, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 10 },
  video: { width: "100%", aspectRatio: 9 / 16, maxHeight: 520, backgroundColor: "#101010", borderRadius: 6 },
  pollBlock: { paddingTop: 10, gap: 8, borderTopWidth: 1, borderTopColor: colors.border },
  pollQuestion: { color: colors.text, fontSize: 15, fontWeight: "700" },
  pollOption: { minHeight: 42, borderRadius: 7, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, justifyContent: "center" },
  pollOptionSelected: { borderColor: "#16856b", backgroundColor: "#e4f3ee" },
  pollOptionText: { color: colors.text, fontSize: 13 },
  pollOptionTextSelected: { color: "#11644f", fontWeight: "700" },
  pollNotice: { color: colors.secondaryText, fontSize: 12 },
  resultRow: { minHeight: 34, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.border },
  resultCount: { color: "#16856b", fontWeight: "800" },
});