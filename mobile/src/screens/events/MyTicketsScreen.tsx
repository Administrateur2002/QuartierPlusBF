import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Brightness from "expo-brightness";
import QRCode from "react-native-qrcode-svg";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import api from "../../services/api";
import type { EventsStackParamList } from "../../navigation/types";
import ProfileAvatar from "../../components/ProfileAvatar";

type Navigation = NativeStackNavigationProp<EventsStackParamList, "MyTickets">;
type Ticket = {
  id: string;
  event_id: string;
  qr_payload: string;
  status: "VALID" | "USED" | "CANCELLED";
  purchased_at: string;
  scanned_at: string | null;
  event_title: string;
  location_name: string;
  event_date: string;
  ticket_owner_photo_url?: string | null;
  ticket_owner_badge?: string | null;
};

export default function MyTicketsScreen() {
  const navigation = useNavigation<Navigation>();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let previousBrightness: number | null = null;
      void (async () => {
        setIsLoading(true);
        setError(null);
        try {
          const response = await api.get<{ tickets: Ticket[] }>("/v1/tickets/my-tickets", {
            headers: { "Cache-Control": "no-cache" },
          });
          if (!active) return;
          setTickets(response.data.tickets);
          if (response.data.tickets.some((ticket) => ticket.status === "VALID")) {
            previousBrightness = await Brightness.getBrightnessAsync();
            if (active) await Brightness.setBrightnessAsync(1);
          }
        } catch (loadError) {
          if (active) {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "Impossible de charger vos billets.",
            );
          }
        } finally {
          if (active) setIsLoading(false);
        }
      })();
      return () => {
        active = false;
        if (previousBrightness !== null) {
          void Brightness.setBrightnessAsync(previousBrightness).catch((restoreError) =>
            console.error("Unable to restore screen brightness:", restoreError),
          );
        }
      };
    }, []),
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" onPress={() => navigation.goBack()}>
        <Text style={styles.back}>‹ Retour</Text>
      </Pressable>
      <Text style={styles.title}>Mes billets</Text>
      <Text style={styles.subtitle}>
        Présentez le QR signé à l’entrée. La luminosité est augmentée pendant l’affichage des pass.
      </Text>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {isLoading ? (
        <ActivityIndicator color="#2563eb" style={styles.loader} />
      ) : tickets.length ? (
        tickets.map((ticket) => (
          <View key={ticket.id} style={styles.card}>
            <View style={styles.statusLine}>
              <ProfileAvatar
                name="Vous"
                photoUrl={ticket.ticket_owner_photo_url}
                size={38}
                isProVerified={
                  ticket.ticket_owner_badge === "Commerçant Certifié"
                }
              />
              <Text style={styles.eventTitle}>{ticket.event_title}</Text>
              <Text
                style={[
                  styles.status,
                  ticket.status === "VALID" ? styles.valid : styles.used,
                ]}
              >
                {ticket.status === "VALID"
                  ? "VALIDE"
                  : ticket.status === "USED"
                    ? "UTILISÉ"
                    : "ANNULÉ"}
              </Text>
            </View>
            <Text style={styles.detail}>
              {new Date(ticket.event_date).toLocaleString("fr-FR")}
            </Text>
            <Text style={styles.detail}>{ticket.location_name}</Text>
            {ticket.status === "VALID" ? (
              <View style={styles.qr}>
                <QRCode
                  value={ticket.qr_payload}
                  size={230}
                  ecl="H"
                  quietZone={12}
                />
                <Text style={styles.qrHint}>Code à usage unique · ne pas partager</Text>
              </View>
            ) : (
              <Text style={styles.scanned}>
                {ticket.scanned_at
                  ? `Passé à l’entrée le ${new Date(ticket.scanned_at).toLocaleString("fr-FR")}`
                  : "Ce billet n’est plus valide."}
              </Text>
            )}
          </View>
        ))
      ) : (
        <View style={styles.empty}>
          <Text style={styles.detail}>Vous n’avez pas encore de billet.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("EventsHome")}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Découvrir les événements</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: "#f8fafc", flexGrow: 1, padding: 18, paddingBottom: 112, paddingTop: 58 },
  back: { color: "#2563eb", fontSize: 14, fontWeight: "600" },
  title: { color: "#172b4d", fontSize: 25, fontWeight: "800", marginTop: 18 },
  subtitle: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 6 },
  card: { backgroundColor: "#ffffff", borderColor: "#e2e8f0", borderRadius: 14, borderWidth: 1, marginTop: 16, padding: 16 },
  statusLine: { alignItems: "flex-start", flexDirection: "row", gap: 8, justifyContent: "space-between" },
  eventTitle: { color: "#172b4d", flex: 1, fontSize: 17, fontWeight: "700" },
  status: { borderRadius: 8, fontSize: 10, fontWeight: "800", overflow: "hidden", paddingHorizontal: 8, paddingVertical: 5 },
  valid: { backgroundColor: "#dcfce7", color: "#166534" },
  used: { backgroundColor: "#fee2e2", color: "#991b1b" },
  detail: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 6 },
  qr: { alignItems: "center", marginTop: 18, paddingBottom: 8 },
  qrHint: { color: "#64748b", fontSize: 11, marginTop: 10 },
  scanned: { color: "#64748b", fontSize: 13, marginTop: 16 },
  empty: { alignItems: "center", paddingVertical: 28 },
  button: { alignItems: "center", backgroundColor: "#2563eb", borderRadius: 9, marginTop: 14, paddingHorizontal: 16, paddingVertical: 12 },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  error: { color: "#b91c1c", fontSize: 13, marginTop: 15 },
  loader: { marginTop: 24 },
});
