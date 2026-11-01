import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import QRCode from "react-native-qrcode-svg";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import api from "../../services/api";
import { getApiErrorMessage } from "../../services/apiError";
import type { VoyageStackParamList } from "../../navigation/types";

type Navigation = NativeStackNavigationProp<VoyageStackParamList, "VoyageHome">;
type Trip = {
  id: string;
  departure: string;
  arrival: string;
  departure_at: string;
  arrival_at: string;
  vehicle: string;
  price: number;
  company_name: string;
  seats: { id: string; seat_number: string }[];
};
type VoyageTicket = {
  id: string;
  trip_id: string;
  qr_payload: string;
  status: string;
  expires_at: string;
  short_code: string;
  seat_number: string;
  company_name: string;
  traveler_name: string;
  departure: string;
  arrival: string;
  departure_at: string;
  price: number;
};

export default function VoyageHomeScreen() {
  const navigation = useNavigation<Navigation>();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tickets, setTickets] = useState<VoyageTicket[]>([]);
  const [departure, setDeparture] = useState("");
  const [arrival, setArrival] = useState("");
  const [date, setDate] = useState("");
  const [message, setMessage] = useState("");
  const [selectedTrip, setSelectedTrip] = useState("");
  const [bookedTrip, setBookedTrip] = useState<Trip | null>(null);

  useEffect(() => {
    void Notifications.setNotificationCategoryAsync("voyage-arrival", [
      {
        identifier: "notify_contacts",
        buttonTitle: "Prévenir mes proches",
        options: { opensAppToForeground: true },
      },
    ]).catch((error: unknown) => {
      console.error("Unable to configure the arrival notification action:", error);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (
        response.notification.request.content.data?.type === "voyage-arrival" &&
        response.actionIdentifier === "notify_contacts"
      ) {
        void Share.share({ message: "Je suis bien arrivé(e) ! Mon voyage avec QuartierPlus est terminé." })
          .catch((error: unknown) => console.error("Unable to share arrival status:", error));
      }
    });
    return () => subscription.remove();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [tripResponse, ticketResponse] = await Promise.all([
        api.get<{ trips: Trip[] }>("/v1/voyage/trips", { params: { departure, arrival, date } }),
        api.get<{ tickets: VoyageTicket[] }>("/v1/voyage/tickets/mine"),
      ]);
      setTrips(tripResponse.data.trips);
      setTickets(ticketResponse.data.tickets);
      setMessage("");
    } catch (error) {
      setMessage(getApiErrorMessage(error, "Chargement Voyage impossible."));
    }
  }, [arrival, date, departure]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const search = async () => {
    const params = new URLSearchParams({ departure, arrival, date }).toString();
    try {
      const response = await api.get<{ trips: Trip[] }>(`/v1/voyage/trips?${params}`);
      setTrips(response.data.trips);
      setMessage("");
    } catch (error) {
      setMessage(getApiErrorMessage(error, "Recherche impossible."));
    }
  };

  const book = async (trip: Trip, seatId: string) => {
    try {
      await api.post(`/v1/voyage/trips/${trip.id}/book`, { seat_id: seatId });
      setSelectedTrip("");
      setBookedTrip(trip);
      setMessage("");
      await refresh();
      try {
        const currentPermission = await Notifications.getPermissionsAsync();
        const permission =
          currentPermission.status === "granted"
            ? currentPermission
            : await Notifications.requestPermissionsAsync();
        if (permission.status !== "granted") {
          setMessage("Billet confirmé. Activez les notifications pour recevoir les rappels de voyage.");
          return;
        }
        const departureReminder = new Date(
          new Date(trip.departure_at).getTime() - 2 * 60 * 60 * 1000,
        );
        if (departureReminder.getTime() > Date.now()) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "Bon voyage !",
              body: `Votre départ pour ${trip.arrival} est dans 2 heures.`,
              data: { type: "voyage-departure", tripId: trip.id },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: departureReminder,
            },
          });
        }
        const arrival = new Date(trip.arrival_at);
        if (arrival.getTime() > Date.now()) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "Bien arrivé ?",
              body: "Touchez « Prévenir mes proches » pour partager votre arrivée.",
              categoryIdentifier: "voyage-arrival",
              data: { type: "voyage-arrival", tripId: trip.id },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: arrival,
            },
          });
        }
      } catch (notificationError) {
        setMessage(
          `Billet confirmé, mais les rappels n’ont pas pu être programmés : ${
            notificationError instanceof Error ? notificationError.message : "erreur inconnue"
          }`,
        );
      }
    } catch (error) {
      setMessage(getApiErrorMessage(error, "Réservation impossible."));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>QUARTIERPLUS</Text>
      <Text style={styles.title}>Voyage</Text>
      <View style={styles.searchRow}>
        <TextInput value={departure} onChangeText={setDeparture} placeholder="Départ" style={styles.input} />
        <TextInput value={arrival} onChangeText={setArrival} placeholder="Arrivée" style={styles.input} />
      </View>
      <View style={styles.searchRow}>
        <TextInput value={date} onChangeText={setDate} placeholder="Date (AAAA-MM-JJ)" style={[styles.input, styles.dateInput]} />
        <Pressable onPress={() => void search()} style={styles.searchButton}><Text style={styles.searchText}>Rechercher</Text></Pressable>
      </View>
      {message ? <Text accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
      <Modal
        animationType="fade"
        onRequestClose={() => setBookedTrip(null)}
        transparent
        visible={bookedTrip !== null}
      >
        {bookedTrip ? (
          <View style={styles.welcomeBackdrop}>
            <View style={styles.welcomeCard}>
              <Text style={styles.welcomeTitle}>
                Bon voyage, {tickets.find((ticket) => ticket.trip_id === bookedTrip.id)?.traveler_name.split(" ")[0] || "voyageur"} ! 🚌
              </Text>
              <Text style={styles.welcomeRoute}>{bookedTrip.departure} → {bookedTrip.arrival}</Text>
              <Text style={styles.welcomeDetail}>
                {new Date(bookedTrip.departure_at).toLocaleString("fr-FR")} · {bookedTrip.company_name}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void Share.share({
                  message: `Je voyage de ${bookedTrip.departure} à ${bookedTrip.arrival} le ${new Date(bookedTrip.departure_at).toLocaleString("fr-FR")} avec ${bookedTrip.company_name}.`,
                })}
                style={styles.shareTripButton}
              >
                <Text style={styles.shareTripText}>Partager mon trajet</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => setBookedTrip(null)} style={styles.closeWelcome}>
                <Text style={styles.closeWelcomeText}>Continuer</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </Modal>
      <Text style={styles.section}>Départs disponibles</Text>
      {!trips.length ? <Text style={styles.empty}>Aucun départ disponible.</Text> : trips.map((trip) => (
        <View key={trip.id} style={styles.trip}>
          <View style={styles.tripHead}>
            <Text style={styles.route}>{trip.departure}  →  {trip.arrival}</Text>
            <Text style={styles.price}>{Number(trip.price).toLocaleString("fr-FR")} FCFA</Text>
          </View>
          <Text style={styles.detail}>{trip.company_name} · {new Date(trip.departure_at).toLocaleString("fr-FR")}</Text>
          <Text style={styles.detail}>{trip.vehicle} · {trip.seats.length} places libres</Text>
          <Pressable onPress={() => { setSelectedTrip(selectedTrip === trip.id ? "" : trip.id); }} style={styles.selectButton}>
            <Text style={styles.selectText}>{selectedTrip === trip.id ? "Masquer les places" : "Choisir une place"}</Text>
          </Pressable>
          {selectedTrip === trip.id && <View style={styles.seats}>{trip.seats.map((seat) => (
            <Pressable key={seat.id} onPress={() => void book(trip, seat.id)} style={styles.seat}>
              <Text style={styles.seatText}>{seat.seat_number}</Text>
            </Pressable>
          ))}</View>}
          <Pressable onPress={() => navigation.navigate("VoyageAgentScanner", { tripId: trip.id })} style={styles.agentButton}>
            <Text style={styles.agentText}>Scanner agent</Text>
          </Pressable>
        </View>
      ))}
      <Text style={styles.section}>Mes billets</Text>
      {tickets.map((ticket) => (
        <View key={ticket.id} style={styles.ticket}>
          <View style={styles.tripHead}>
            <Text style={styles.route}>{ticket.departure}  →  {ticket.arrival}</Text>
            <Text style={ticket.status === "VALID" ? styles.valid : styles.invalid}>{ticket.status}</Text>
          </View>
          <Text style={styles.detail}>{ticket.company_name} · {ticket.traveler_name}</Text>
          <Text style={styles.detail}>{new Date(ticket.departure_at).toLocaleString("fr-FR")} · Siège {ticket.seat_number}</Text>
          <Text style={styles.detail}>{Number(ticket.price).toLocaleString("fr-FR")} FCFA · expire {new Date(ticket.expires_at).toLocaleString("fr-FR")}</Text>
          {ticket.status === "VALID" && <View style={styles.qr}><QRCode value={ticket.qr_payload} size={190} ecl="H" logo={require("../../../assets/icon-small.webp")} logoSize={30} logoBackgroundColor="#ffffff" quietZone={10} /><Text style={styles.code}>Code secours : {ticket.short_code}</Text></View>}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: "#f4f7f5", flexGrow: 1, padding: 18, paddingBottom: 100, paddingTop: 56 },
  eyebrow: { color: "#df5f36", fontSize: 11, fontWeight: "800" },
  title: { color: "#153b35", fontSize: 30, fontWeight: "800", marginBottom: 18, marginTop: 4 },
  searchRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  input: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, color: "#153b35", flex: 1, minWidth: 0, paddingHorizontal: 11, paddingVertical: 11 },
  dateInput: { flex: 1.3 },
  searchButton: { alignItems: "center", backgroundColor: "#df5f36", borderRadius: 8, justifyContent: "center", paddingHorizontal: 15 },
  searchText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  message: { color: "#a1341c", fontSize: 13, marginTop: 8 },
  section: { borderBottomColor: "#d8e2de", borderBottomWidth: 1, color: "#153b35", fontSize: 18, fontWeight: "800", marginBottom: 8, marginTop: 24, paddingBottom: 8 },
  empty: { color: "#61726e", fontSize: 14, paddingVertical: 16 },
  trip: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, marginTop: 10, padding: 14 },
  tripHead: { alignItems: "center", flexDirection: "row", gap: 8, justifyContent: "space-between" },
  route: { color: "#153b35", flex: 1, fontSize: 15, fontWeight: "800" },
  price: { color: "#df5f36", fontSize: 14, fontWeight: "800" },
  detail: { color: "#61726e", fontSize: 12, lineHeight: 18, marginTop: 5 },
  selectButton: { alignItems: "center", backgroundColor: "#153b35", borderRadius: 7, marginTop: 12, padding: 10 },
  selectText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  seats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  seat: { alignItems: "center", aspectRatio: 1, backgroundColor: "#e2efe9", borderRadius: 6, justifyContent: "center", width: 42 },
  seatText: { color: "#153b35", fontWeight: "700" },
  agentButton: { alignSelf: "flex-start", borderColor: "#df5f36", borderRadius: 7, borderWidth: 1, marginTop: 8, paddingHorizontal: 10, paddingVertical: 7 },
  agentText: { color: "#a84428", fontSize: 12, fontWeight: "700" },
  ticket: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, marginTop: 10, padding: 14 },
  valid: { color: "#1c7d4a", fontSize: 11, fontWeight: "900" },
  invalid: { color: "#a1341c", fontSize: 11, fontWeight: "900" },
  qr: { alignItems: "center", marginTop: 14, paddingVertical: 8 },
  code: { color: "#61726e", fontSize: 12, fontWeight: "700", marginTop: 9 },
  welcomeBackdrop: { alignItems: "center", backgroundColor: "rgba(15,23,42,0.65)", flex: 1, justifyContent: "center", padding: 22 },
  welcomeCard: { alignItems: "center", backgroundColor: "#fffaf0", borderRadius: 22, padding: 24, width: "100%" },
  welcomeTitle: { color: "#153b35", fontSize: 22, fontWeight: "900", textAlign: "center" },
  welcomeRoute: { color: "#df5f36", fontSize: 18, fontWeight: "800", marginTop: 16 },
  welcomeDetail: { color: "#61726e", fontSize: 13, marginTop: 8, textAlign: "center" },
  shareTripButton: { backgroundColor: "#df5f36", borderRadius: 10, marginTop: 22, paddingHorizontal: 20, paddingVertical: 13 },
  shareTripText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  closeWelcome: { padding: 12 },
  closeWelcomeText: { color: "#153b35", fontSize: 13, fontWeight: "700" },
});