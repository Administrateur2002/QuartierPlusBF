import { useCallback, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import api, { API_BASE_URL, getStoredAuthToken } from "../../services/api";
import { getApiErrorMessage } from "../../services/apiError";
import type { VoyageStackParamList } from "../../navigation/types";
import ProfileAvatar from "../../components/ProfileAvatar";

const CITIES = [
  "Banfora",
  "Bobo-Dioulasso",
  "Dédougou",
  "Fada N’Gourma",
  "Gaoua",
  "Kaya",
  "Koudougou",
  "Ouagadougou",
  "Ouahigouya",
  "Tenkodogo",
];

type CompanyRoute = { id: string; departure: string; arrival: string; is_active: boolean };
type CompanyTrip = {
  id: string;
  route_id: string;
  departure: string;
  arrival: string;
  departure_at: string;
  arrival_at: string;
  vehicle: string;
  price: number | string;
  seat_count: number;
  seats_available: number;
  tickets_sold: number;
  tickets_pending: number;
  sales_total: number | string;
};
type Company = {
  id: string;
  name: string;
  logo_url: string | null;
  owner_photo_url: string | null;
  owner_badge: string | null;
};
type CompanyResponse = {
  company: Company | null;
  routes: CompanyRoute[];
  trips: CompanyTrip[];
};
type CityField = "departure" | "arrival";

export default function VoyageCompanyScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<VoyageStackParamList>>();
  const [company, setCompany] = useState<Company | null>(null);
  const [routes, setRoutes] = useState<CompanyRoute[]>([]);
  const [trips, setTrips] = useState<CompanyTrip[]>([]);
  const [companyName, setCompanyName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [departure, setDeparture] = useState("");
  const [arrival, setArrival] = useState("");
  const [selectedRoute, setSelectedRoute] = useState("");
  const [departureDate, setDepartureDate] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [arrivalTime, setArrivalTime] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [price, setPrice] = useState("");
  const [seatCount, setSeatCount] = useState("");
  const [agentPhone, setAgentPhone] = useState("");
  const [cityPicker, setCityPicker] = useState<CityField | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<CompanyResponse>("/v1/voyage/companies/mine");
      setCompany(data.company);
      setRoutes(data.routes);
      setTrips(data.trips);
      if (data.company) {
        setCompanyName(data.company.name);
        setLogoUrl(data.company.logo_url ?? "");
      }
      setError("");
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Chargement de l’espace compagnie impossible."));
    }
  }, []);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(successMessage);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Action impossible."));
    } finally {
      setBusy(false);
    }
  };

  const createCompany = () => {
    if (!companyName.trim()) {
      setError("Indiquez le nom de la compagnie.");
      return;
    }
    void runAction(async () => {
      await api.post("/v1/voyage/companies", {
        name: companyName.trim(),
        logo_url: logoUrl.trim() || null,
      });
    }, "Espace compagnie activé.");
  };

  const createRoute = () => {
    if (!departure || !arrival || departure === arrival) {
      setError("Choisissez deux villes différentes.");
      return;
    }
    void runAction(async () => {
      const { data } = await api.post<{ route: CompanyRoute }>("/v1/voyage/routes", {
        departure,
        arrival,
      });
      setSelectedRoute(data.route.id);
      setDeparture("");
      setArrival("");
    }, "Ligne créée.");
  };

  const createTrip = () => {
    const departureAt = new Date(`${departureDate}T${departureTime}:00`);
    const arrivalAt = new Date(`${arrivalDate}T${arrivalTime}:00`);
    const seatCountNumber = Number(seatCount);
    const priceNumber = Number(price);
    if (
      !selectedRoute ||
      Number.isNaN(departureAt.getTime()) ||
      Number.isNaN(arrivalAt.getTime()) ||
      departureAt.getTime() <= Date.now() ||
      arrivalAt <= departureAt ||
      !vehicle.trim() ||
      !Number.isInteger(seatCountNumber) ||
      seatCountNumber < 1 ||
      seatCountNumber > 500 ||
      !Number.isSafeInteger(priceNumber) ||
      priceNumber < 0
    ) {
      setError("Vérifiez la ligne, les dates, les heures, le prix et le nombre de places.");
      return;
    }
    void runAction(async () => {
      await api.post("/v1/voyage/trips", {
        route_id: selectedRoute,
        departure_at: departureAt.toISOString(),
        arrival_at: arrivalAt.toISOString(),
        vehicle: vehicle.trim(),
        price: priceNumber,
        seat_count: seatCountNumber,
      });
      setDepartureDate("");
      setDepartureTime("");
      setArrivalDate("");
      setArrivalTime("");
      setVehicle("");
      setPrice("");
      setSeatCount("");
    }, "Départ publié.");
  };

  const inviteAgent = () => {
    if (!agentPhone.trim()) {
      setError("Saisissez le numéro de téléphone de l’agent au format international.");
      return;
    }
    void runAction(async () => {
      await api.post("/v1/voyage/agents", { phone_number: agentPhone.trim() });
      setAgentPhone("");
    }, "Agent invité.");
  };

  const downloadManifest = async (trip: CompanyTrip) => {
    try {
      if (!API_BASE_URL) throw new Error("L’adresse du serveur n’est pas configurée.");
      const token = await getStoredAuthToken();
      if (!token) throw new Error("Connectez-vous pour télécharger le manifeste.");
      const file = await File.downloadFileAsync(
        `${API_BASE_URL}/v1/voyage/trips/${trip.id}/passengers.pdf`,
        new File(Paths.cache, `quartierplus-voyage-${trip.id}.pdf`),
        { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
      );
      if (!(await Sharing.isAvailableAsync())) throw new Error("Le partage de fichiers n’est pas disponible sur cet appareil.");
      await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: "Manifeste des passagers" });
    } catch (downloadError) {
      setError(getApiErrorMessage(downloadError, "Téléchargement du manifeste impossible."));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={styles.backButton}>
        <Text style={styles.backText}>‹ Retour à Voyage</Text>
      </Pressable>
      <Text style={styles.eyebrow}>ESPACE PRO · TRANSPORT</Text>
      <Text style={styles.title}>Ma compagnie</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {busy ? <ActivityIndicator color="#df5f36" /> : null}

      {!company ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Activer mon espace</Text>
          <Text style={styles.help}>Renseignez le nom public et le lien HTTPS du logo de votre compagnie.</Text>
          <TextInput accessibilityLabel="Nom de la compagnie" onChangeText={setCompanyName} placeholder="Nom de la compagnie" style={styles.input} value={companyName} />
          <TextInput accessibilityLabel="URL HTTPS du logo" autoCapitalize="none" onChangeText={setLogoUrl} placeholder="URL HTTPS du logo (facultatif)" style={styles.input} value={logoUrl} />
          <Pressable accessibilityRole="button" disabled={busy} onPress={createCompany} style={styles.primaryButton}>
            <Text style={styles.primaryText}>Activer mon espace</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.companyHeader}>
              <ProfileAvatar
                name={company.name}
                photoUrl={company.owner_photo_url}
                size={54}
                isProVerified={company.owner_badge === "Commerçant Certifié"}
              />
              {company.logo_url ? <Image source={{ uri: company.logo_url }} style={styles.logo} /> : null}
              <View style={styles.companyInfo}>
                <Text style={styles.heading}>{company.name}</Text>
                <Text style={styles.help}>Espace compagnie actif</Text>
              </View>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>Créer une ligne</Text>
            <Text style={styles.help}>Choisissez les villes desservies au Burkina Faso.</Text>
            <Pressable accessibilityRole="button" onPress={() => setCityPicker("departure")} style={styles.inputButton}>
              <Text style={departure ? styles.inputValue : styles.placeholder}>{departure || "Ville de départ"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setCityPicker("arrival")} style={styles.inputButton}>
              <Text style={arrival ? styles.inputValue : styles.placeholder}>{arrival || "Ville d’arrivée"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={createRoute} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>Ajouter la ligne</Text>
            </Pressable>
            {!!routes.length && (
              <View style={styles.routeList}>
                {routes.map((route) => (
                  <Text key={route.id} style={styles.detail}>• {route.departure} → {route.arrival}</Text>
                ))}
              </View>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>Créer un départ</Text>
            <Text style={styles.help}>Date au format AAAA-MM-JJ et heure locale au format HH:mm.</Text>
            <Text style={styles.label}>Ligne</Text>
            {routes.map((route) => (
              <Pressable accessibilityRole="button" accessibilityState={{ selected: selectedRoute === route.id }} key={route.id} onPress={() => setSelectedRoute(route.id)} style={[styles.routeOption, selectedRoute === route.id && styles.routeSelected]}>
                <Text style={styles.inputValue}>{route.departure} → {route.arrival}</Text>
              </Pressable>
            ))}
            <TextInput accessibilityLabel="Date du départ AAAA-MM-JJ" onChangeText={setDepartureDate} placeholder="Date du départ · AAAA-MM-JJ" style={styles.input} value={departureDate} />
            <TextInput accessibilityLabel="Heure du départ HH:mm" keyboardType="numbers-and-punctuation" onChangeText={setDepartureTime} placeholder="Heure du départ · HH:mm" style={styles.input} value={departureTime} />
            <TextInput accessibilityLabel="Date d’arrivée AAAA-MM-JJ" onChangeText={setArrivalDate} placeholder="Date d’arrivée · AAAA-MM-JJ" style={styles.input} value={arrivalDate} />
            <TextInput accessibilityLabel="Heure d’arrivée HH:mm" keyboardType="numbers-and-punctuation" onChangeText={setArrivalTime} placeholder="Heure d’arrivée · HH:mm" style={styles.input} value={arrivalTime} />
            <TextInput accessibilityLabel="Véhicule" onChangeText={setVehicle} placeholder="Véhicule ou numéro de car" style={styles.input} value={vehicle} />
            <View style={styles.row}>
              <TextInput accessibilityLabel="Prix du billet en FCFA" keyboardType="number-pad" onChangeText={setPrice} placeholder="Prix · FCFA" style={[styles.input, styles.half]} value={price} />
              <TextInput accessibilityLabel="Nombre de places" keyboardType="number-pad" onChangeText={setSeatCount} placeholder="Places" style={[styles.input, styles.half]} value={seatCount} />
            </View>
            <Pressable accessibilityRole="button" disabled={busy || routes.length === 0} onPress={createTrip} style={styles.primaryButton}>
              <Text style={styles.primaryText}>Publier le départ</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>Inviter un agent</Text>
            <Text style={styles.help}>Le numéro doit être associé à un compte QuartierPlus.</Text>
            <TextInput accessibilityLabel="Téléphone de l’agent" autoComplete="tel" keyboardType="phone-pad" onChangeText={setAgentPhone} placeholder="+226 …" style={styles.input} value={agentPhone} />
            <Pressable accessibilityRole="button" disabled={busy} onPress={inviteAgent} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>Inviter par téléphone</Text>
            </Pressable>
          </View>

          <Text style={styles.section}>Ventes et départs</Text>
          {!trips.length ? <Text style={styles.help}>Aucun départ publié.</Text> : trips.map((trip) => (
            <View key={trip.id} style={styles.card}>
              <Text style={styles.heading}>{trip.departure} → {trip.arrival}</Text>
              <Text style={styles.detail}>{new Date(trip.departure_at).toLocaleString("fr-FR")} · {trip.vehicle}</Text>
              <Text style={styles.detail}>{Number(trip.price).toLocaleString("fr-FR")} FCFA · {trip.seats_available} places restantes</Text>
              <Text style={styles.detail}>{trip.tickets_sold} billets payés · {trip.tickets_pending} réservations en attente · {Number(trip.sales_total).toLocaleString("fr-FR")} FCFA encaissés</Text>
              <Pressable accessibilityRole="button" onPress={() => void downloadManifest(trip)} style={styles.secondaryButton}>
                <Text style={styles.secondaryText}>Télécharger le manifeste PDF</Text>
              </Pressable>
            </View>
          ))}
        </>
      )}

      <Modal animationType="slide" onRequestClose={() => setCityPicker(null)} transparent visible={cityPicker !== null}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.heading}>{cityPicker === "departure" ? "Ville de départ" : "Ville d’arrivée"}</Text>
            <ScrollView>
              {CITIES.filter((city) => city !== (cityPicker === "departure" ? arrival : departure)).map((city) => (
                <Pressable accessibilityRole="button" key={city} onPress={() => {
                  if (cityPicker === "departure") setDeparture(city);
                  else setArrival(city);
                  setCityPicker(null);
                }} style={styles.cityOption}>
                  <Text style={styles.inputValue}>{city}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: "#f4f7f5", flexGrow: 1, gap: 12, padding: 18, paddingBottom: 48, paddingTop: 54 },
  backButton: { alignSelf: "flex-start", paddingVertical: 5 },
  backText: { color: "#61726e", fontSize: 13, fontWeight: "700" },
  eyebrow: { color: "#df5f36", fontSize: 11, fontWeight: "800" },
  title: { color: "#153b35", fontSize: 28, fontWeight: "900" },
  card: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 12, borderWidth: 1, gap: 9, padding: 14 },
  heading: { color: "#153b35", fontSize: 16, fontWeight: "800" },
  help: { color: "#61726e", fontSize: 12, lineHeight: 18 },
  label: { color: "#61726e", fontSize: 12, fontWeight: "700" },
  input: { backgroundColor: "#f8faf9", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, color: "#153b35", minHeight: 44, paddingHorizontal: 11 },
  inputButton: { backgroundColor: "#f8faf9", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, justifyContent: "center", minHeight: 44, paddingHorizontal: 11 },
  inputValue: { color: "#153b35", fontSize: 13, fontWeight: "600" },
  placeholder: { color: "#82908c", fontSize: 13 },
  primaryButton: { alignItems: "center", backgroundColor: "#df5f36", borderRadius: 8, padding: 12 },
  primaryText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  secondaryButton: { alignItems: "center", borderColor: "#df5f36", borderRadius: 8, borderWidth: 1, padding: 11 },
  secondaryText: { color: "#a84428", fontSize: 13, fontWeight: "800" },
  routeOption: { backgroundColor: "#f8faf9", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, padding: 11 },
  routeSelected: { backgroundColor: "#fff3ee", borderColor: "#df5f36" },
  routeList: { gap: 5, marginTop: 4 },
  detail: { color: "#61726e", fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", gap: 8 },
  half: { flex: 1 },
  section: { color: "#153b35", fontSize: 18, fontWeight: "900", marginTop: 8 },
  companyHeader: { alignItems: "center", flexDirection: "row", gap: 12 },
  companyInfo: { flex: 1 },
  logo: { borderRadius: 10, height: 54, width: 54 },
  error: { color: "#a1341c", fontSize: 13 },
  notice: { color: "#1c7d4a", fontSize: 13, fontWeight: "700" },
  modalBackdrop: { backgroundColor: "rgba(15,23,42,0.5)", flex: 1, justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "75%", padding: 18 },
  cityOption: { borderBottomColor: "#e6ece9", borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 14 },
});
