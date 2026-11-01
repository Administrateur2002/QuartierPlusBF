import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MapPin,
  X,
} from "lucide-react-native";
import QRCode from "react-native-qrcode-svg";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import api from "../../services/api";
import { getApiErrorMessage } from "../../services/apiError";
import type { VoyageStackParamList } from "../../navigation/types";
import ProfileAvatar from "../../components/ProfileAvatar";

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
  traveler_photo_url?: string | null;
  traveler_badge?: string | null;
};

type DemoTrip = {
  id: string;
  departure: string;
  arrival: string;
  departure_at: string;
  vehicle: string;
  price: number;
  company_name: string;
  seats_available: number;
};

type CityField = "departure" | "arrival";

const VOYAGE_CITIES = [
  "Abidjan",
  "Abengourou",
  "Bouaké",
  "Daloa",
  "Gagnoa",
  "Grand-Bassam",
  "Korhogo",
  "Man",
  "San-Pédro",
  "Yamoussoukro",
];

const demoDepartureDate = (daysFromToday: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

export const VOYAGE_DEMO_DATA: DemoTrip[] = [
  {
    id: "demo-abidjan-yamoussoukro",
    departure: "Abidjan",
    arrival: "Yamoussoukro",
    departure_at: demoDepartureDate(1, 8),
    vehicle: "Car climatisé · exemple",
    price: 6500,
    company_name: "Compagnie de démonstration",
    seats_available: 12,
  },
  {
    id: "demo-abidjan-bouake",
    departure: "Abidjan",
    arrival: "Bouaké",
    departure_at: demoDepartureDate(2, 9),
    vehicle: "Autocar · exemple",
    price: 9000,
    company_name: "Compagnie de démonstration",
    seats_available: 8,
  },
];

const formatDateValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const formatDateLabel = (value: string) => {
  if (!value) return "Toutes les dates";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
};

const formatDateFieldLabel = (value: string) => {
  if (!value) return "Toutes les dates";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
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
  const [citySelector, setCitySelector] = useState<CityField | null>(null);
  const [dateSelectorOpen, setDateSelectorOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const monthDayCount = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const monthOffset = (monthStart.getDay() + 6) % 7;
  const calendarDays = Array.from(
    { length: Math.ceil((monthOffset + monthDayCount) / 7) * 7 },
    (_, index) => {
      const day = index - monthOffset + 1;
      return day > 0 && day <= monthDayCount
        ? new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day)
        : null;
    },
  );
  const todayValue = formatDateValue(new Date());
  const matchingDemoTrips = VOYAGE_DEMO_DATA.filter((trip) =>
    (!departure || trip.departure.toLocaleLowerCase() === departure.toLocaleLowerCase()) &&
    (!arrival || trip.arrival.toLocaleLowerCase() === arrival.toLocaleLowerCase()) &&
    (!date || formatDateValue(new Date(trip.departure_at)) === date),
  );

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
      <View style={styles.searchCard}>
        <Text style={styles.searchHeading}>Où souhaitez-vous aller ?</Text>
        <View style={styles.searchRow}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Ville de départ</Text>
            <Pressable
              accessibilityLabel={`Choisir la ville de départ${departure ? `, ${departure}` : ""}`}
              accessibilityRole="button"
              onPress={() => setCitySelector("departure")}
              style={styles.fieldSelector}
            >
              <MapPin color="#61726e" size={17} />
              <Text numberOfLines={1} style={[styles.fieldValue, !departure && styles.fieldPlaceholder]}>
                {departure || "Choisir une ville"}
              </Text>
              <ChevronDown color="#61726e" size={17} />
            </Pressable>
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Ville d’arrivée</Text>
            <Pressable
              accessibilityLabel={`Choisir la ville d’arrivée${arrival ? `, ${arrival}` : ""}`}
              accessibilityRole="button"
              onPress={() => setCitySelector("arrival")}
              style={styles.fieldSelector}
            >
              <MapPin color="#61726e" size={17} />
              <Text numberOfLines={1} style={[styles.fieldValue, !arrival && styles.fieldPlaceholder]}>
                {arrival || "Choisir une ville"}
              </Text>
              <ChevronDown color="#61726e" size={17} />
            </Pressable>
          </View>
        </View>
        <View style={styles.searchRow}>
          <View style={[styles.field, styles.dateField]}>
            <Text style={styles.fieldLabel}>Date du voyage</Text>
            <Pressable
              accessibilityLabel={`Choisir la date du voyage, ${formatDateLabel(date)}`}
              accessibilityRole="button"
              onPress={() => {
                const selectedDate = date ? new Date(`${date}T12:00:00`) : new Date();
                setCalendarMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
                setDateSelectorOpen(true);
              }}
              style={styles.fieldSelector}
            >
              <CalendarDays color="#61726e" size={17} />
              <Text numberOfLines={1} style={[styles.fieldValue, !date && styles.fieldPlaceholder]}>
                {formatDateFieldLabel(date)}
              </Text>
              <ChevronDown color="#61726e" size={17} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => void search()}
            style={styles.searchButton}
          >
            <Text style={styles.searchText}>Rechercher</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.helpCard}>
        <Text style={styles.helpTitle}>Comment fonctionne Voyage ?</Text>
        <Text style={styles.helpText}><Text style={styles.helpRole}>Voyageur :</Text> recherchez un départ, choisissez une place et présentez votre billet QR à l’embarquement.</Text>
        <Text style={styles.helpText}><Text style={styles.helpRole}>Compagnie :</Text> publiez vos lignes et départs avec leurs horaires, tarifs et places disponibles.</Text>
        <Text style={styles.helpText}><Text style={styles.helpRole}>Agent :</Text> scannez le QR code du billet au départ pour vérifier l’embarquement.</Text>
      </View>
      {message ? <Text accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
      <Modal
        animationType="slide"
        onRequestClose={() => setCitySelector(null)}
        transparent
        visible={citySelector !== null}
      >
        <View style={styles.selectorBackdrop}>
          <View style={styles.selectorSheet}>
            <View style={styles.selectorHeader}>
              <Text style={styles.selectorTitle}>
                {citySelector === "departure" ? "Choisir la ville de départ" : "Choisir la ville d’arrivée"}
              </Text>
              <Pressable
                accessibilityLabel="Fermer le choix de ville"
                accessibilityRole="button"
                onPress={() => setCitySelector(null)}
                style={styles.selectorClose}
              >
                <X color="#153b35" size={20} />
              </Pressable>
            </View>
            <ScrollView>
              {VOYAGE_CITIES
                .filter((city) => city !== (citySelector === "departure" ? arrival : departure))
                .map((city) => {
                  const selected = city === (citySelector === "departure" ? departure : arrival);
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={city}
                      onPress={() => {
                        if (citySelector === "departure") setDeparture(city);
                        else setArrival(city);
                        setCitySelector(null);
                      }}
                      style={[styles.selectorOption, selected && styles.selectorOptionSelected]}
                    >
                      <MapPin color={selected ? "#df5f36" : "#61726e"} size={18} />
                      <Text style={[styles.selectorOptionText, selected && styles.selectorOptionTextSelected]}>{city}</Text>
                    </Pressable>
                  );
                })}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setDateSelectorOpen(false)}
        transparent
        visible={dateSelectorOpen}
      >
        <View style={styles.selectorBackdrop}>
          <View style={styles.selectorSheet}>
            <View style={styles.selectorHeader}>
              <Text style={styles.selectorTitle}>Choisir une date</Text>
              <Pressable
                accessibilityLabel="Fermer le choix de date"
                accessibilityRole="button"
                onPress={() => setDateSelectorOpen(false)}
                style={styles.selectorClose}
              >
                <X color="#153b35" size={20} />
              </Pressable>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: !date }}
              onPress={() => {
                setDate("");
                setDateSelectorOpen(false);
              }}
              style={[styles.selectorOption, !date && styles.selectorOptionSelected]}
            >
              <CalendarDays color={!date ? "#df5f36" : "#61726e"} size={18} />
              <Text style={[styles.selectorOptionText, !date && styles.selectorOptionTextSelected]}>Toutes les dates</Text>
            </Pressable>
            <View style={styles.calendarNavigation}>
              <Pressable
                accessibilityLabel="Mois précédent"
                accessibilityRole="button"
                disabled={
                  calendarMonth.getFullYear() === new Date().getFullYear() &&
                  calendarMonth.getMonth() === new Date().getMonth()
                }
                onPress={() => setCalendarMonth((current) =>
                  new Date(current.getFullYear(), current.getMonth() - 1, 1),
                )}
                style={styles.calendarArrow}
              >
                <ChevronLeft color="#153b35" size={20} />
              </Pressable>
              <Text style={styles.calendarMonth}>
                {calendarMonth.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
              </Text>
              <Pressable
                accessibilityLabel="Mois suivant"
                accessibilityRole="button"
                onPress={() => setCalendarMonth((current) =>
                  new Date(current.getFullYear(), current.getMonth() + 1, 1),
                )}
                style={styles.calendarArrow}
              >
                <ChevronRight color="#153b35" size={20} />
              </Pressable>
            </View>
            <View style={styles.calendarWeekdays}>
              {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((weekday) => (
                <Text key={weekday} style={styles.calendarWeekday}>{weekday}</Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {calendarDays.map((calendarDay, index) => {
                if (!calendarDay) {
                  return <View key={`empty-${index}`} style={styles.calendarDayCell} />;
                }
                const value = formatDateValue(calendarDay);
                const selected = value === date;
                const isPast = value < todayValue;
                return (
                  <Pressable
                    accessibilityLabel={formatDateLabel(value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: isPast }}
                    disabled={isPast}
                    key={value}
                    onPress={() => {
                      setDate(value);
                      setDateSelectorOpen(false);
                    }}
                    style={[
                      styles.calendarDayCell,
                      styles.calendarDayButton,
                      selected && styles.calendarDaySelected,
                      isPast && styles.calendarDayDisabled,
                    ]}
                  >
                    <Text style={[styles.calendarDayText, selected && styles.calendarDayTextSelected, isPast && styles.calendarDayTextDisabled]}>
                      {calendarDay.getDate()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
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
      {!trips.length ? (
        <View>
          <Text style={styles.empty}>Aucun trajet réel ne correspond à la recherche.</Text>
          {matchingDemoTrips.length > 0 ? (
            <View>
              <Text style={styles.demoTitle}>Exemples de démonstration</Text>
              <Text style={styles.demoNotice}>Ces exemples servent à découvrir l’écran et ne sont pas réservables.</Text>
              {matchingDemoTrips.map((trip) => (
                <View key={trip.id} style={styles.demoTrip}>
                  <View style={styles.tripHead}>
                    <Text style={styles.route}>{trip.departure} → {trip.arrival}</Text>
                    <Text style={styles.price}>{trip.price.toLocaleString("fr-FR")} FCFA</Text>
                  </View>
                  <Text style={styles.detail}>{trip.company_name} · {new Date(trip.departure_at).toLocaleString("fr-FR")}</Text>
                  <Text style={styles.detail}>{trip.vehicle} · {trip.seats_available} places libres</Text>
                  <Text style={styles.demoBadge}>EXEMPLE · NON RÉSERVABLE</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : trips.map((trip) => (
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
            <ProfileAvatar
              name={ticket.traveler_name}
              photoUrl={ticket.traveler_photo_url}
              size={38}
              isProVerified={ticket.traveler_badge === "Commerçant Certifié"}
            />
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
  searchCard: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 14, borderWidth: 1, gap: 12, padding: 13 },
  searchHeading: { color: "#153b35", fontSize: 15, fontWeight: "800" },
  searchRow: { flexDirection: "row", gap: 8 },
  field: { flex: 1, minWidth: 0 },
  dateField: { flex: 1.35 },
  fieldLabel: { color: "#61726e", fontSize: 11, fontWeight: "700", marginBottom: 5 },
  fieldSelector: { alignItems: "center", backgroundColor: "#f8faf9", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, flexDirection: "row", gap: 6, minHeight: 44, paddingHorizontal: 8 },
  fieldValue: { color: "#153b35", flex: 1, fontSize: 12, fontWeight: "700" },
  fieldPlaceholder: { color: "#82908c", fontWeight: "500" },
  searchButton: { alignItems: "center", alignSelf: "flex-end", backgroundColor: "#df5f36", borderRadius: 8, justifyContent: "center", minHeight: 44, paddingHorizontal: 13 },
  searchText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  helpCard: { backgroundColor: "#eaf2ee", borderRadius: 12, gap: 7, marginTop: 12, padding: 13 },
  helpTitle: { color: "#153b35", fontSize: 13, fontWeight: "800", marginBottom: 2 },
  helpText: { color: "#425650", fontSize: 12, lineHeight: 18 },
  helpRole: { color: "#153b35", fontWeight: "800" },
  message: { color: "#a1341c", fontSize: 13, marginTop: 8 },
  section: { borderBottomColor: "#d8e2de", borderBottomWidth: 1, color: "#153b35", fontSize: 18, fontWeight: "800", marginBottom: 8, marginTop: 24, paddingBottom: 8 },
  empty: { color: "#61726e", fontSize: 14, paddingVertical: 16 },
  trip: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 8, borderWidth: 1, marginTop: 10, padding: 14 },
  demoTitle: { color: "#153b35", fontSize: 14, fontWeight: "800", marginTop: 2 },
  demoNotice: { color: "#61726e", fontSize: 12, lineHeight: 18, marginTop: 4 },
  demoTrip: { backgroundColor: "#fff", borderColor: "#d8e2de", borderRadius: 8, borderStyle: "dashed", borderWidth: 1, marginTop: 10, padding: 14 },
  demoBadge: { color: "#a84428", fontSize: 10, fontWeight: "900", marginTop: 9 },
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
  selectorBackdrop: { backgroundColor: "rgba(15,23,42,0.5)", flex: 1, justifyContent: "flex-end" },
  selectorSheet: { backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "78%", paddingBottom: 28, paddingHorizontal: 18, paddingTop: 18 },
  selectorHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  selectorTitle: { color: "#153b35", flex: 1, fontSize: 17, fontWeight: "800" },
  selectorClose: { alignItems: "center", height: 38, justifyContent: "center", width: 38 },
  selectorOption: { alignItems: "center", borderBottomColor: "#e6ece9", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 12, minHeight: 50, paddingHorizontal: 10 },
  selectorOptionSelected: { backgroundColor: "#fff3ee" },
  selectorOptionText: { color: "#425650", fontSize: 14, fontWeight: "600" },
  selectorOptionTextSelected: { color: "#a84428", fontWeight: "800" },
  calendarNavigation: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  calendarArrow: { alignItems: "center", height: 40, justifyContent: "center", width: 40 },
  calendarMonth: { color: "#153b35", fontSize: 15, fontWeight: "800", textTransform: "capitalize" },
  calendarWeekdays: { flexDirection: "row", marginTop: 8 },
  calendarWeekday: { color: "#61726e", fontSize: 11, fontWeight: "700", textAlign: "center", width: "14.2857%" },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 5 },
  calendarDayCell: { alignItems: "center", aspectRatio: 1, justifyContent: "center", width: "14.2857%" },
  calendarDayButton: { borderRadius: 20 },
  calendarDaySelected: { backgroundColor: "#df5f36" },
  calendarDayDisabled: { opacity: 0.35 },
  calendarDayText: { color: "#153b35", fontSize: 13, fontWeight: "600" },
  calendarDayTextSelected: { color: "#ffffff", fontWeight: "900" },
  calendarDayTextDisabled: { color: "#61726e" },
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