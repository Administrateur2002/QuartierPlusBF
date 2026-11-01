import { ArrowRight, BadgeCheck, MapPin, Store, Truck } from "lucide-react-native";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import type { RootStackParamList } from "../navigation/types";

const OFFERS = [
  {
    id: "ALLIANCE_PRO",
    title: "Alliance Pro",
    description: "Valorisez votre commerce et accédez aux outils professionnels.",
    price: "5 000 FCFA / mois",
    icon: BadgeCheck,
  },
  {
    id: "SPONSORED_PIN",
    title: "Épingle sponsorisée",
    description: "Mettez en avant un commerce sur la carte radar.",
    price: "2 000 FCFA / 7 jours",
    icon: MapPin,
  },
  {
    id: "WHOLESALER",
    title: "Espace Grossiste",
    description: "Présentez votre catalogue et gérez vos commandes professionnelles.",
    price: "25 000 FCFA / mois",
    icon: Store,
  },
  {
    id: "TRANSPORT_COMPANY",
    title: "Espace Compagnie de transport",
    description: "Développez votre présence et vos services de transport.",
    price: "20 000 FCFA / mois",
    icon: Truck,
  },
] as const;

export default function CommerceGrowthScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { user, requestAuthentication } = useAuth();
  const { colors } = useTheme();

  const chooseOffer = (offer: (typeof OFFERS)[number]["id"]) => {
    if (!user) {
      requestAuthentication();
      return;
    }
    navigation.navigate("Checkout", { offer });
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}
    >
      <Text style={[styles.eyebrow, { color: colors.primary }]}>QUARTIERPLUS PRO</Text>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        Développez votre commerce
      </Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        Choisissez les outils adaptés à votre activité. Les voyageurs et les acheteurs
        peuvent utiliser leurs espaces sans abonnement.
      </Text>
      {OFFERS.map(({ id, title, description, price, icon: Icon }) => (
        <Pressable
          accessibilityRole="button"
          key={id}
          onPress={() => chooseOffer(id)}
          style={[
            styles.offer,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Icon color={colors.primary} size={24} />
          <View style={styles.offerCopy}>
            <Text style={[styles.offerTitle, { color: colors.text }]}>{title}</Text>
            <Text style={[styles.description, { color: colors.secondaryText }]}>
              {description}
            </Text>
            <Text style={[styles.price, { color: colors.primary }]}>{price}</Text>
          </View>
          <ArrowRight color={colors.secondaryText} size={19} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 20, paddingBottom: 48, paddingTop: 58 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: "800", lineHeight: 34, marginTop: 8 },
  subtitle: { fontSize: 14, lineHeight: 21, marginBottom: 14, marginTop: 9 },
  offer: {
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
    padding: 16,
  },
  offerCopy: { flex: 1 },
  offerTitle: { fontSize: 15, fontWeight: "800" },
  description: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  price: { fontSize: 13, fontWeight: "800", marginTop: 8 },
});
