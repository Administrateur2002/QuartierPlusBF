import { useEffect, useState } from "react";
import * as Location from "expo-location";
import MapView, { Marker } from "react-native-maps";
import { Linking } from "react-native";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import api from "../../services/api";

type PlanType =
  | "ALLIANCE_PRO"
  | "SYNDIC"
  | "TOWN_HALL"
  | "SECURITY_AGENT"
  | "WHOLESALER"
  | "TRANSPORT_COMPANY";
type DashboardPlanType = Exclude<PlanType, "WHOLESALER" | "TRANSPORT_COMPANY">;

type Subscription = {
  plan_type: PlanType;
  expires_at: string;
};
type DashboardSubscription = {
  plan_type: DashboardPlanType;
  expires_at: string;
};

type DashboardData = {
  plan_type: DashboardPlanType;
  expires_at: string;
  sections: string[];
  metrics: Record<string, number>;
};

const DASHBOARD_ENDPOINTS: Record<DashboardPlanType, string> = {
  ALLIANCE_PRO: "/v1/pro/merchant/dashboard",
  SYNDIC: "/v1/pro/syndic/dashboard",
  TOWN_HALL: "/v1/pro/townhall/dashboard",
  SECURITY_AGENT: "/v1/pro/security-agent/dashboard",
};

const PLAN_TITLES: Record<DashboardPlanType, string> = {
  ALLIANCE_PRO: "Espace Alliance Pro",
  SYNDIC: "Espace Syndic",
  TOWN_HALL: "Espace Mairie",
  SECURITY_AGENT: "Console Agent de sécurité",
};

const REQUIRED_METRICS: Record<DashboardPlanType, string[]> = {
  ALLIANCE_PRO: [
    "offers_count",
    "active_pins_count",
    "pin_views_count",
    "profile_views_count",
  ],
  SYNDIC: [],
  TOWN_HALL: ["reports_count"],
  SECURITY_AGENT: ["active_sos_count"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDashboardData = (
  value: unknown,
  expectedPlan: DashboardPlanType,
): DashboardData => {
  if (
    !isRecord(value) ||
    value.plan_type !== expectedPlan ||
    typeof value.expires_at !== "string" ||
    !Array.isArray(value.sections) ||
    !value.sections.every((section) => typeof section === "string") ||
    !isRecord(value.metrics)
  ) {
    throw new Error("Le serveur a renvoyé un tableau de bord Pro invalide.");
  }
  const metrics: Record<string, number> = {};
  for (const key of REQUIRED_METRICS[expectedPlan]) {
    const metric = value.metrics[key];
    if (typeof metric !== "number" || !Number.isFinite(metric)) {
      throw new Error("Les indicateurs du tableau de bord Pro sont invalides.");
    }
    metrics[key] = metric;
  }
  return {
    plan_type: expectedPlan,
    expires_at: value.expires_at,
    sections: value.sections,
    metrics,
  };
};

export default function ProDashboardScreen({
  subscription,
}: {
  subscription: Subscription;
}) {
  switch (subscription.plan_type) {
    case "ALLIANCE_PRO":
      return (
        <MerchantView
          subscription={{
            plan_type: subscription.plan_type,
            expires_at: subscription.expires_at,
          }}
        />
      );
    case "SYNDIC":
      return (
        <SyndicView
          subscription={{
            plan_type: subscription.plan_type,
            expires_at: subscription.expires_at,
          }}
        />
      );
    case "TOWN_HALL":
      return (
        <TownHallView
          subscription={{
            plan_type: subscription.plan_type,
            expires_at: subscription.expires_at,
          }}
        />
      );
    case "SECURITY_AGENT":
      return (
        <SecurityAgentView
          subscription={{
            plan_type: subscription.plan_type,
            expires_at: subscription.expires_at,
          }}
        />
      );
    default:
      return null;
  }
}

function useDashboardData(subscription: DashboardSubscription) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    setData(null);
    setError(null);
    void api
      .get<unknown>(DASHBOARD_ENDPOINTS[subscription.plan_type], {
        headers: { "Cache-Control": "no-cache" },
      })
      .then((response) => {
        const dashboard = readDashboardData(
          response.data,
          subscription.plan_type,
        );
        if (isActive) setData(dashboard);
      })
      .catch((requestError: unknown) => {
        if (!isActive) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Impossible de charger les données de cet espace Pro.",
        );
      });
    return () => {
      isActive = false;
    };
  }, [subscription.plan_type]);

  return { data, error };
}

function DashboardFrame({
  subscription,
  children,
}: {
  subscription: DashboardSubscription;
  children: (data: DashboardData) => React.ReactNode;
}) {
  const { data, error } = useDashboardData(subscription);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{PLAN_TITLES[subscription.plan_type]}</Text>
      <Text style={styles.expiry}>
        Abonnement actif jusqu’au{" "}
        {new Date(subscription.expires_at).toLocaleDateString("fr-FR")}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : !data ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.loadingText}>Chargement de votre espace…</Text>
        </View>
      ) : (
        children(data)
      )}
    </ScrollView>
  );
}

function FeatureCard({
  title,
  description,
  value,
}: {
  title: string;
  description: string;
  value?: number;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardDescription}>{description}</Text>
      {value !== undefined && <Text style={styles.metric}>{value}</Text>}
    </View>
  );
}

function MerchantView({ subscription }: { subscription: DashboardSubscription }) {
  const [title, setTitle] = useState("");
  const [discount, setDiscount] = useState("");
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  const [isPublishing, setIsPublishing] = useState(false);

  const getLocation = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        throw new Error("L'autorisation de localisation est nécessaire.");
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setLocation(position.coords);
    } catch (error) {
      Alert.alert(
        "Position indisponible",
        error instanceof Error ? error.message : "Impossible d'obtenir votre position.",
      );
    }
  };

  const publishFlashSale = async () => {
    if (!title.trim() || !location || !Number.isInteger(Number(discount))) {
      Alert.alert("Informations manquantes", "Complétez le titre, la réduction et la position GPS.");
      return;
    }
    setIsPublishing(true);
    try {
      const response = await api.post("/v1/pro/merchant/flash-sale", {
        title: title.trim(),
        discount_percent: Number(discount),
        latitude: location.latitude,
        longitude: location.longitude,
        duration_hours: 24,
      });
      setTitle("");
      setDiscount("");
      Alert.alert(
        "Vente flash publiée",
        `${response.data.notified_count} citoyen(s) à moins de 800 m ont été ciblés.`,
      );
    } catch (error) {
      Alert.alert(
        "Publication impossible",
        error instanceof Error ? error.message : "Impossible de créer la vente flash.",
      );
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <DashboardFrame subscription={subscription}>
      {(data) => (
        <>
          <FeatureCard
            title="Statistiques"
            description="Vos offres publiées"
            value={data.metrics.offers_count}
          />
          <FeatureCard
            title="Vues de la vitrine"
            description="Professionnels découverts sur la carte"
            value={data.metrics.profile_views_count}
          />
          <FeatureCard
            title="Offres"
            description="Gérez vos annonces et services professionnels."
          />
          <FeatureCard
            title="Épingle sponsorisée"
            description="Épingles actuellement actives sur la carte radar"
            value={data.metrics.active_pins_count}
          />
          <FeatureCard
            title="Vues des épingles"
            description="Visibilité cumulée de vos campagnes"
            value={data.metrics.pin_views_count}
          />
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Lancer une Vente Flash</Text>
            <Text style={styles.cardDescription}>
              Alertez les citoyens situés à moins de 800 m pendant 24 heures.
            </Text>
            <TextInput
              accessibilityLabel="Titre de la vente flash"
              maxLength={150}
              onChangeText={setTitle}
              placeholder="Ex. 20 % sur les fruits"
              style={styles.input}
              value={title}
            />
            <TextInput
              accessibilityLabel="Réduction en pourcentage"
              keyboardType="number-pad"
              maxLength={3}
              onChangeText={setDiscount}
              placeholder="Réduction (%)"
              style={styles.input}
              value={discount}
            />
            <ActionButton
              label={location ? "Actualiser ma position GPS" : "Définir ma position GPS"}
              onPress={() => void getLocation()}
            />
            {location && (
              <Text style={styles.hint}>
                Position prête : {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
              </Text>
            )}
            <ActionButton
              disabled={isPublishing}
              label={isPublishing ? "Publication…" : "Publier la vente flash"}
              onPress={() => void publishFlashSale()}
            />
          </View>
        </>
      )}
    </DashboardFrame>
  );
}

type Residence = { id: string; name: string };
type WallPost = { id: string; author_name: string; content: string; created_at: string };
type ResidenceVote = {
  id: string;
  title: string;
  options: string[];
  status: "OPEN" | "CLOSED";
  response_count: number;
};
type Craftsman = { id: string; name: string; trade: string; phone: string; rating: number };
type SyndicTab = "wall" | "votes" | "craftsmen";

function SyndicView({ subscription }: { subscription: DashboardSubscription }) {
  const [tab, setTab] = useState<SyndicTab>("wall");
  const [residences, setResidences] = useState<Residence[]>([]);
  const [residenceId, setResidenceId] = useState("");
  const [posts, setPosts] = useState<WallPost[]>([]);
  const [votes, setVotes] = useState<ResidenceVote[]>([]);
  const [craftsmen, setCraftsmen] = useState<Craftsman[]>([]);
  const [message, setMessage] = useState("");
  const [voteTitle, setVoteTitle] = useState("");
  const [voteOptions, setVoteOptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .get<{ residences: Residence[] }>("/v1/pro/syndic/residences", {
        headers: { "Cache-Control": "no-cache" },
      })
      .then(({ data }) => {
        if (!active) return;
        setResidences(data.residences);
        setResidenceId((current) =>
          data.residences.some((residence) => residence.id === current)
            ? current
            : data.residences[0]?.id ?? "",
        );
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Résidence indisponible.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!residenceId) return;
    let active = true;
    const params = { residence_id: residenceId };
    setError(null);
    const load = async () => {
      try {
        if (tab === "wall") {
          const response = await api.get<{ posts: WallPost[] }>("/v1/pro/syndic/wall", {
            params,
            headers: { "Cache-Control": "no-cache" },
          });
          if (active) setPosts(response.data.posts);
        } else if (tab === "votes") {
          const response = await api.get<{ votes: ResidenceVote[] }>("/v1/pro/syndic/votes", {
            params,
            headers: { "Cache-Control": "no-cache" },
          });
          if (active) setVotes(response.data.votes);
        } else {
          const response = await api.get<{ craftsmen: Craftsman[] }>(
            "/v1/pro/syndic/craftsmen",
            { params, headers: { "Cache-Control": "no-cache" } },
          );
          if (active) setCraftsmen(response.data.craftsmen);
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Chargement impossible.");
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [residenceId, tab, refreshKey]);

  const createWallPost = async () => {
    try {
      await api.post("/v1/pro/syndic/wall", {
        residence_id: residenceId,
        content: message.trim(),
      });
      setMessage("");
      setRefreshKey((value) => value + 1);
    } catch (postError) {
      Alert.alert("Publication impossible", postError instanceof Error ? postError.message : "Erreur.");
    }
  };

  const createVote = async () => {
    const options = voteOptions.split("\n").map((option) => option.trim()).filter(Boolean);
    try {
      await api.post("/v1/pro/syndic/votes", {
        residence_id: residenceId,
        title: voteTitle.trim(),
        options,
      });
      setVoteTitle("");
      setVoteOptions("");
      setRefreshKey((value) => value + 1);
    } catch (voteError) {
      Alert.alert("Création impossible", voteError instanceof Error ? voteError.message : "Erreur.");
    }
  };

  const participate = async (voteId: string, optionIndex: number) => {
    try {
      await api.post(`/v1/pro/syndic/votes/${encodeURIComponent(voteId)}/participate`, {
        option_index: optionIndex,
      });
      setRefreshKey((value) => value + 1);
      Alert.alert("Vote enregistré", "Votre choix a bien été pris en compte.");
    } catch (voteError) {
      Alert.alert("Vote impossible", voteError instanceof Error ? voteError.message : "Erreur.");
    }
  };

  return (
    <DashboardFrame subscription={subscription}>
      {() => (
        <>
          <View style={styles.tabRow}>
            <TabButton label="Mur" selected={tab === "wall"} onPress={() => setTab("wall")} />
            <TabButton label="Votes" selected={tab === "votes"} onPress={() => setTab("votes")} />
            <TabButton
              label="Artisans"
              selected={tab === "craftsmen"}
              onPress={() => setTab("craftsmen")}
            />
          </View>
          {residences.length > 1 && (
            <View style={styles.tabRow}>
              {residences.map((residence) => (
                <TabButton
                  key={residence.id}
                  label={residence.name}
                  selected={residence.id === residenceId}
                  onPress={() => setResidenceId(residence.id)}
                />
              ))}
            </View>
          )}
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {!residenceId && !error && (
            <Text style={styles.cardDescription}>
              Aucun rattachement de résidence n’est configuré pour ce compte.
            </Text>
          )}
          {tab === "wall" && (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Mur de la résidence</Text>
                <TextInput
                  accessibilityLabel="Message pour le mur de la résidence"
                  multiline
                  onChangeText={setMessage}
                  placeholder="Écrire une annonce aux résidents"
                  style={[styles.input, styles.multilineInput]}
                  value={message}
                />
                <ActionButton label="Publier" onPress={() => void createWallPost()} />
              </View>
              {posts.map((post) => (
                <FeatureCard
                  key={post.id}
                  title={post.author_name}
                  description={`${post.content}\n${new Date(post.created_at).toLocaleString("fr-FR")}`}
                />
              ))}
            </>
          )}
          {tab === "votes" && (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Créer un vote de copropriété</Text>
                <TextInput
                  accessibilityLabel="Titre du vote"
                  onChangeText={setVoteTitle}
                  placeholder="Sujet du vote"
                  style={styles.input}
                  value={voteTitle}
                />
                <TextInput
                  accessibilityLabel="Options du vote, une par ligne"
                  multiline
                  onChangeText={setVoteOptions}
                  placeholder={"Oui\nNon"}
                  style={[styles.input, styles.multilineInput]}
                  value={voteOptions}
                />
                <ActionButton label="Créer le vote" onPress={() => void createVote()} />
              </View>
              {votes.map((vote) => (
                <View key={vote.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{vote.title}</Text>
                  <Text style={styles.cardDescription}>
                    {vote.status === "OPEN" ? "Vote ouvert" : "Vote clôturé"} · {vote.response_count} participation(s)
                  </Text>
                  {vote.options.map((option, index) => (
                    <ActionButton
                      key={`${vote.id}-${index}`}
                      disabled={vote.status !== "OPEN"}
                      label={option}
                      onPress={() => void participate(vote.id, index)}
                    />
                  ))}
                </View>
              ))}
            </>
          )}
          {tab === "craftsmen" &&
            craftsmen.map((craftsman) => (
              <FeatureCard
                key={craftsman.id}
                title={craftsman.name}
                description={`${craftsman.trade} · ${craftsman.phone} · ${Number(craftsman.rating).toFixed(1)}/5`}
              />
            ))}
        </>
      )}
    </DashboardFrame>
  );
}

type Municipality = { id: string; name: string };
type ReportGroup = {
  id: string;
  category: string;
  report_count: number;
  latitude: number;
  longitude: number;
};
type Consultation = { id: string; question: string; ends_at: string };
type OfficialNews = { id: string; title: string; body: string; is_certified: boolean };
type TownHallTab = "map" | "consultations" | "news";

function TownHallView({ subscription }: { subscription: DashboardSubscription }) {
  const [tab, setTab] = useState<TownHallTab>("map");
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [municipalityId, setMunicipalityId] = useState("");
  const [groups, setGroups] = useState<ReportGroup[]>([]);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [news, setNews] = useState<OfficialNews[]>([]);
  const [question, setQuestion] = useState("");
  const [consultationOptions, setConsultationOptions] = useState("");
  const [newsTitle, setNewsTitle] = useState("");
  const [newsBody, setNewsBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .get<{ municipalities: Municipality[] }>("/v1/pro/townhall/municipalities", {
        headers: { "Cache-Control": "no-cache" },
      })
      .then(({ data }) => {
        if (!active) return;
        setMunicipalities(data.municipalities);
        setMunicipalityId((current) =>
          data.municipalities.some((municipality) => municipality.id === current)
            ? current
            : data.municipalities[0]?.id ?? "",
        );
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Mairie indisponible.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!municipalityId) return;
    let active = true;
    setError(null);
    const params = { municipality_id: municipalityId };
    const load = async () => {
      try {
        if (tab === "map") {
          const response = await api.get<{ groups: ReportGroup[] }>(
            "/v1/pro/townhall/grouped-reports",
            { params, headers: { "Cache-Control": "no-cache" } },
          );
          if (active) setGroups(response.data.groups);
        } else {
          const response = await api.get<{
            consultations: Consultation[];
            official_news: OfficialNews[];
          }>("/v1/pro/townhall/content", {
            params,
            headers: { "Cache-Control": "no-cache" },
          });
          if (active) {
            setConsultations(response.data.consultations);
            setNews(response.data.official_news);
          }
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Chargement impossible.");
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [municipalityId, tab, refreshKey]);

  const createConsultation = async () => {
    const options = consultationOptions
      .split("\n")
      .map((option) => option.trim())
      .filter(Boolean);
    try {
      await api.post("/v1/pro/townhall/consultations", {
        municipality_id: municipalityId,
        question: question.trim(),
        options,
        ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      setQuestion("");
      setConsultationOptions("");
      setRefreshKey((value) => value + 1);
    } catch (createError) {
      Alert.alert("Consultation impossible", createError instanceof Error ? createError.message : "Erreur.");
    }
  };

  const publishNews = async () => {
    try {
      await api.post("/v1/pro/townhall/official-news", {
        municipality_id: municipalityId,
        title: newsTitle.trim(),
        body: newsBody.trim(),
      });
      setNewsTitle("");
      setNewsBody("");
      setRefreshKey((value) => value + 1);
    } catch (createError) {
      Alert.alert("Publication impossible", createError instanceof Error ? createError.message : "Erreur.");
    }
  };

  return (
    <DashboardFrame subscription={subscription}>
      {(data) => (
        <>
          <View style={styles.tabRow}>
            <TabButton label="Carte" selected={tab === "map"} onPress={() => setTab("map")} />
            <TabButton
              label="Consultations"
              selected={tab === "consultations"}
              onPress={() => setTab("consultations")}
            />
            <TabButton label="Fil officiel" selected={tab === "news"} onPress={() => setTab("news")} />
          </View>
          {municipalities.length > 1 && (
            <View style={styles.tabRow}>
              {municipalities.map((municipality) => (
                <TabButton
                  key={municipality.id}
                  label={municipality.name}
                  selected={municipality.id === municipalityId}
                  onPress={() => setMunicipalityId(municipality.id)}
                />
              ))}
            </View>
          )}
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {!municipalityId && !error && (
            <Text style={styles.cardDescription}>
              Aucun rattachement de municipalité n’est configuré pour ce compte.
            </Text>
          )}
          <FeatureCard
            title="Signalements"
            description="Alertes SOS actives agrégées par zone sur les 7 derniers jours"
            value={data.metrics.reports_count}
          />
          {tab === "map" && (
            <View style={styles.mapContainer}>
              <MapView
                region={{
                  latitude: groups[0]?.latitude ?? 6.3703,
                  longitude: groups[0]?.longitude ?? 2.3912,
                  latitudeDelta: 0.08,
                  longitudeDelta: 0.08,
                }}
                style={styles.map}
              >
                {groups.map((group) => (
                  <Marker
                    key={group.id}
                    coordinate={{ latitude: group.latitude, longitude: group.longitude }}
                    title={group.category}
                    description={`${group.report_count} signalement(s)`}
                  />
                ))}
              </MapView>
              <Text style={styles.hint}>{groups.length} zone(s) de signalements regroupés</Text>
            </View>
          )}
          {tab === "consultations" && (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Lancer une consultation</Text>
                <TextInput
                  accessibilityLabel="Question de consultation"
                  onChangeText={setQuestion}
                  placeholder="Votre question aux citoyens"
                  style={styles.input}
                  value={question}
                />
                <TextInput
                  accessibilityLabel="Options de consultation, une par ligne"
                  multiline
                  onChangeText={setConsultationOptions}
                  placeholder={"Option 1\nOption 2"}
                  style={[styles.input, styles.multilineInput]}
                  value={consultationOptions}
                />
                <ActionButton label="Publier 7 jours" onPress={() => void createConsultation()} />
              </View>
              {consultations.map((consultation) => (
                <FeatureCard
                  key={consultation.id}
                  title={consultation.question}
                  description={`Clôture le ${new Date(consultation.ends_at).toLocaleDateString("fr-FR")}`}
                />
              ))}
            </>
          )}
          {tab === "news" && (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Publier sur le fil officiel</Text>
                <TextInput
                  accessibilityLabel="Titre du communiqué officiel"
                  onChangeText={setNewsTitle}
                  placeholder="Titre"
                  style={styles.input}
                  value={newsTitle}
                />
                <TextInput
                  accessibilityLabel="Contenu du communiqué officiel"
                  multiline
                  onChangeText={setNewsBody}
                  placeholder="Information officielle"
                  style={[styles.input, styles.multilineInput]}
                  value={newsBody}
                />
                <ActionButton label="Publier le communiqué certifié" onPress={() => void publishNews()} />
              </View>
              {news.map((item) => (
                <FeatureCard
                  key={item.id}
                  title={`${item.is_certified ? "✓ " : ""}${item.title}`}
                  description={item.body}
                />
              ))}
            </>
          )}
        </>
      )}
    </DashboardFrame>
  );
}

type SosAlert = {
  id: string;
  emergency_type: string;
  latitude: number;
  longitude: number;
  created_at: string;
  emergency_image_url?: string | null;
  emergency_audio_url?: string | null;
};
type Intervention = {
  id: string;
  sos_id: string;
  patient_medical_summary: Record<string, unknown>;
  status: "ACCEPTED" | "EN_ROUTE" | "ON_SCENE" | "COMPLETED";
};

function SecurityAgentView({ subscription }: { subscription: DashboardSubscription }) {
  const [alerts, setAlerts] = useState<SosAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<SosAlert | null>(null);
  const [intervention, setIntervention] = useState<Intervention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAlerting, setIsAlerting] = useState(false);
  const [isUpdatingIntervention, setIsUpdatingIntervention] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<{ alerts: SosAlert[] }>("/v1/pro/security/active-sos", {
        headers: { "Cache-Control": "no-cache" },
      })
      .then(({ data }) => {
        if (active) setAlerts(data.alerts);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Alertes indisponibles.");
      });
    return () => {
      active = false;
    };
  }, []);

  const takeIntervention = async (alert: SosAlert) => {
    setError(null);
    try {
      const response = await api.post<{
        intervention: Intervention;
        sos: SosAlert;
      }>(`/v1/pro/security/interventions/${encodeURIComponent(alert.id)}`, {
        headers: { "Cache-Control": "no-store" },
      });
      setSelectedAlert(response.data.sos);
      setIntervention(response.data.intervention);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Prise en charge impossible.");
    }
  };

  const updateInterventionStatus = async (
    status: Exclude<Intervention["status"], "ACCEPTED">,
  ) => {
    if (!selectedAlert || !intervention || isUpdatingIntervention) return;
    setIsUpdatingIntervention(true);
    setError(null);
    try {
      const response = await api.patch<{ intervention: Intervention }>(
        `/v1/pro/security/interventions/${encodeURIComponent(selectedAlert.id)}`,
        { status },
      );
      setIntervention(response.data.intervention);
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Impossible de mettre à jour le suivi de l’intervention.",
      );
    } finally {
      setIsUpdatingIntervention(false);
    }
  };

  const openEmergencyMedia = async (url: string | null | undefined) => {
    if (!url) return;
    try {
      const mediaUrl = new URL(url);
      if (mediaUrl.protocol !== "https:") {
        throw new Error("Le média d’urgence doit utiliser une adresse HTTPS.");
      }
      await Linking.openURL(mediaUrl.href);
    } catch (mediaError) {
      Alert.alert(
        "Média indisponible",
        mediaError instanceof Error
          ? mediaError.message
          : "Impossible d’ouvrir le média d’urgence.",
      );
    }
  };

  const startGpsGuidance = async () => {
    if (!selectedAlert) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${selectedAlert.latitude},${selectedAlert.longitude}`;
    try {
      await Linking.openURL(url);
    } catch (openError) {
      Alert.alert(
        "Guidage GPS indisponible",
        openError instanceof Error ? openError.message : "Impossible d'ouvrir l'application de navigation.",
      );
    }
  };

  const alertNeighbors = async () => {
    if (!selectedAlert || isAlerting) return;
    setIsAlerting(true);
    try {
      const response = await api.post<{ notified_count: number }>(
        "/v1/pro/security/alert-neighbors",
        { sos_id: selectedAlert.id },
      );
      Alert.alert("Secouristes alertés", `${response.data.notified_count} notification(s) envoyée(s).`);
    } catch (alertError) {
      Alert.alert("Envoi impossible", alertError instanceof Error ? alertError.message : "Erreur.");
    } finally {
      setIsAlerting(false);
    }
  };

  return (
    <DashboardFrame subscription={subscription}>
      {(data) => (
        <>
          <FeatureCard
            title="Console SOS"
            description="Alertes actives à prendre en charge"
            value={data.metrics.active_sos_count}
          />
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {alerts.map((alert) => (
            <Pressable
              key={alert.id}
              accessibilityRole="button"
              onPress={() => void takeIntervention(alert)}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>SOS {alert.emergency_type}</Text>
              <Text style={styles.cardDescription}>
                {new Date(alert.created_at).toLocaleString("fr-FR")} ·{" "}
                {alert.latitude.toFixed(4)}, {alert.longitude.toFixed(4)}
              </Text>
              <Text style={styles.linkText}>Prendre en charge</Text>
            </Pressable>
          ))}
          {selectedAlert && intervention && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Fiche d’intervention</Text>
              <Text style={styles.cardDescription}>Statut : {intervention.status}</Text>
              <Text style={styles.cardDescription}>
                Informations médicales d’urgence :{" "}
                {Object.keys(intervention.patient_medical_summary).length
                  ? JSON.stringify(intervention.patient_medical_summary)
                  : "Aucune fiche renseignée"}
              </Text>
              {selectedAlert.emergency_image_url ? (
                <ActionButton
                  label="Ouvrir la photo de l’alerte"
                  onPress={() => void openEmergencyMedia(selectedAlert.emergency_image_url)}
                />
              ) : null}
              {selectedAlert.emergency_audio_url ? (
                <ActionButton
                  label="Ouvrir l’audio de l’alerte"
                  onPress={() => void openEmergencyMedia(selectedAlert.emergency_audio_url)}
                />
              ) : null}
              <ActionButton label="Lancer guidage GPS" onPress={() => void startGpsGuidance()} />
              <ActionButton
                disabled={isAlerting}
                label={isAlerting ? "Envoi en cours…" : "Alerter les secouristes voisins"}
                onPress={() => void alertNeighbors()}
              />
              {intervention.status === "ACCEPTED" ? (
                <ActionButton
                  disabled={isUpdatingIntervention}
                  label={isUpdatingIntervention ? "Mise à jour…" : "Confirmer le départ"}
                  onPress={() => void updateInterventionStatus("EN_ROUTE")}
                />
              ) : null}
              {intervention.status === "EN_ROUTE" ? (
                <ActionButton
                  disabled={isUpdatingIntervention}
                  label={isUpdatingIntervention ? "Mise à jour…" : "Confirmer l’arrivée sur place"}
                  onPress={() => void updateInterventionStatus("ON_SCENE")}
                />
              ) : null}
              {intervention.status === "ON_SCENE" ? (
                <ActionButton
                  disabled={isUpdatingIntervention}
                  label={isUpdatingIntervention ? "Mise à jour…" : "Clôturer l’intervention"}
                  onPress={() => void updateInterventionStatus("COMPLETED")}
                />
              ) : null}
            </View>
          )}
        </>
      )}
    </DashboardFrame>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.actionButton, disabled && styles.disabledButton]}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

function TabButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.tabButton, selected && styles.selectedTab]}
    >
      <Text style={[styles.tabText, selected && styles.selectedTabText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: "#f8fafc", flexGrow: 1, padding: 20, paddingBottom: 112, paddingTop: 60 },
  title: { color: "#172b4d", fontSize: 24, fontWeight: "800" },
  expiry: { color: "#64748b", fontSize: 12, marginBottom: 20, marginTop: 6 },
  card: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 13,
    borderWidth: 1,
    marginBottom: 12,
    padding: 16,
  },
  cardTitle: { color: "#172b4d", fontSize: 16, fontWeight: "700" },
  cardDescription: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 6 },
  metric: { color: "#2563eb", fontSize: 26, fontWeight: "800", marginTop: 10 },
  loading: { alignItems: "center", padding: 30 },
  loadingText: { color: "#64748b", fontSize: 13, marginTop: 10 },
  error: { color: "#b91c1c", fontSize: 14, marginTop: 20 },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 9,
    borderWidth: 1,
    color: "#172b4d",
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 11,
  },
  multilineInput: { minHeight: 88, paddingTop: 10, textAlignVertical: "top" },
  actionButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 9,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  actionButtonText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  disabledButton: { opacity: 0.6 },
  tabRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  tabButton: {
    backgroundColor: "#e2e8f0",
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  selectedTab: { backgroundColor: "#2563eb" },
  tabText: { color: "#334155", fontSize: 12, fontWeight: "600" },
  selectedTabText: { color: "#ffffff" },
  mapContainer: { height: 260, marginBottom: 14 },
  map: { borderRadius: 12, flex: 1 },
  hint: { color: "#64748b", fontSize: 12, marginTop: 6 },
  linkText: { color: "#2563eb", fontSize: 13, fontWeight: "700", marginTop: 10 },
});
