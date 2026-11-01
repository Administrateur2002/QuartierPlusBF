import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from "@react-navigation/native";
import { ArrowLeft, CheckCircle2, ImagePlus, MapPin, ShieldCheck } from "lucide-react-native";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../context/AuthContext";
import type { RootStackParamList } from "../../navigation/types";
import { API_BASE_URL, apiFetch } from "../../services/api";
import { uploadMarketplaceImage } from "../../services/uploadMarketplaceImage";

type Offer =
  | "ALLIANCE_PRO"
  | "SPONSORED_PIN"
  | "SYNDIC"
  | "TOWN_HALL"
  | "SECURITY_AGENT"
  | "WHOLESALER"
  | "TRANSPORT_COMPANY";

const OFFERS: {
  id: Offer;
  title: string;
  description: string;
  price: string;
}[] = [
  {
    id: "ALLIANCE_PRO",
    title: "Alliance Pro",
    description: "Badge Commerçant Certifié et outils professionnels",
    price: "5 000 FCFA / mois",
  },
  {
    id: "SPONSORED_PIN",
    title: "Épingle sponsorisée",
    description: "Votre commerce mis en avant sur la carte radar · 7 jours",
    price: "2 000 FCFA / semaine",
  },
  {
    id: "WHOLESALER",
    title: "Espace Grossiste",
    description: "Catalogue et commandes professionnelles",
    price: "25 000 FCFA / mois",
  },
  {
    id: "TRANSPORT_COMPANY",
    title: "Espace Compagnie de transport",
    description: "Espace professionnel dédié aux compagnies de transport",
    price: "20 000 FCFA / mois",
  },
  {
    id: "SYNDIC",
    title: "Syndic",
    description: "Mur privé, votes de copropriété et annuaire des artisans",
    price: "2 500 FCFA / mois",
  },
  {
    id: "TOWN_HALL",
    title: "Mairie",
    description: "Signalements cartographiés, consultations et fil officiel",
    price: "75 000 FCFA / mois",
  },
  {
    id: "SECURITY_AGENT",
    title: "Accès Certifié Secours",
    description: "Prise en charge SOS, guidage GPS et alertes de proximité",
    price: "50 000 FCFA / mois",
  },
];

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readError = async (response: Awaited<ReturnType<typeof apiFetch>>) => {
  const payload: unknown = await response.json();
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
    ? payload.error
    : `La demande a échoué (HTTP ${response.status}).`;
};

type MerchantItem = { id: string; title: string };
const MAX_PHOTO_BYTES = 300 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export default function CheckoutScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "Checkout">>();
  const { refreshUser } = useAuth();
  const [offer, setOffer] = useState<Offer>(route.params?.offer ?? "ALLIANCE_PRO");
  const [merchantItems, setMerchantItems] = useState<MerchantItem[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [merchantPickerVisible, setMerchantPickerVisible] = useState(false);
  const [pinCaption, setPinCaption] = useState("");
  const [publicationTitle, setPublicationTitle] = useState("");
  const [publicationDescription, setPublicationDescription] = useState("");
  const [pinPhoto, setPinPhoto] = useState<{ uri: string; size: number } | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(true);
  const [promoFreeAccess, setPromoFreeAccess] = useState(false);
  const [billingConfigLoaded, setBillingConfigLoaded] = useState(false);
  const [uploadedPhotoId, setUploadedPhotoId] = useState<string | null>(null);
  const [offerActivatedFree, setOfferActivatedFree] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [isPaid, setIsPaid] = useState(false);

  useEffect(() => {
    setOffer(route.params?.offer ?? "ALLIANCE_PRO");
  }, [route.params?.offer]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!API_BASE_URL) {
        setBillingConfigLoaded(true);
        return;
      }
      try {
        const [config, merchantResponse] = await Promise.all([
          apiFetch(`${API_BASE_URL}/v1/public/config`, {
            headers: { "Cache-Control": "no-cache" },
          }),
          apiFetch(`${API_BASE_URL}/v1/users/me/marketplace-items?item_type=products`, {
            headers: { "Cache-Control": "no-cache" },
          }),
        ]);
        if (!config.ok) throw new Error("La configuration des offres est indisponible.");
        const configPayload: unknown = await config.json();
        if (
          !isRecord(configPayload) ||
          typeof configPayload.billingEnabled !== "boolean" ||
          typeof configPayload.promoFreeAccess !== "boolean"
        ) {
          throw new Error("La configuration des offres est invalide.");
        }
        if (active) {
          setBillingEnabled(configPayload.billingEnabled);
          setPromoFreeAccess(configPayload.promoFreeAccess);
        }
        if (merchantResponse.ok) {
          const merchantPayload: unknown = await merchantResponse.json();
          const rows = isRecord(merchantPayload) && Array.isArray(merchantPayload.items)
            ? merchantPayload.items
            : [];
          const normalized = rows.flatMap((row): MerchantItem[] =>
            isRecord(row) && typeof row.id === "string" && typeof row.title === "string"
              ? [{ id: row.id, title: row.title }]
              : [],
          );
          if (active) {
            setMerchantItems(normalized);
            setMerchantId((current) => current || normalized[0]?.id || "");
          }
        }
      } catch {
        if (active) Alert.alert("Offres indisponibles", "Impossible de vérifier les offres. Réessayez plus tard.");
      } finally {
        if (active) setBillingConfigLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const selectOffer = async (nextOffer: Offer) => {
    setOffer(nextOffer);
  };

  const choosePinPhoto = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error("Autorisez l'accès à vos photos.");
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 1,
      });
      if (picked.canceled) return;
      const selected = picked.assets[0];
      if (!selected?.uri) throw new Error("La photo sélectionnée est indisponible.");
      let uri = selected.uri;
      let size = Number.POSITIVE_INFINITY;
      for (const [width, quality] of [[1600, 0.72], [1280, 0.58], [1024, 0.45], [800, 0.32], [640, 0.22]]) {
        const compressed = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width } }],
          { compress: quality, format: ImageManipulator.SaveFormat.WEBP },
        );
        uri = compressed.uri;
        size = new File(uri).size;
        if (Number.isFinite(size) && size < MAX_PHOTO_BYTES) break;
      }
      if (!Number.isFinite(size) || size >= MAX_PHOTO_BYTES) {
        throw new Error("La photo ne peut pas être compressée sous 300 Ko.");
      }
      setPinPhoto({ uri, size });
      setUploadedPhotoId(null);
    } catch (error) {
      Alert.alert("Photo indisponible", error instanceof Error ? error.message : "Impossible de sélectionner la photo.");
    }
  };

  const startPayment = async () => {
    if (!API_BASE_URL || isPaying) {
      if (!API_BASE_URL) {
        Alert.alert(
          "Service indisponible",
          "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
        );
      }
      return;
    }
    if (!billingConfigLoaded) {
      Alert.alert("Offre indisponible", "La configuration des offres est en cours de vérification.");
      return;
    }
    if (offer === "SPONSORED_PIN" && (!merchantId || !pinCaption.trim())) {
      Alert.alert(
        "Informations manquantes",
        "Choisissez votre commerce et saisissez un texte de présentation.",
      );
      return;
    }
    if (
      offer !== "SPONSORED_PIN" &&
      (!publicationTitle.trim() || !publicationDescription.trim())
    ) {
      Alert.alert(
        "Informations manquantes",
        "Saisissez le nom de votre structure et une présentation courte.",
      );
      return;
    }

    setIsPaying(true);
    try {
      let mediaPublicId = uploadedPhotoId;
      if (offer === "SPONSORED_PIN" && pinPhoto && !mediaPublicId) {
        mediaPublicId = await uploadMarketplaceImage(
          pinPhoto.uri,
          pinPhoto.size,
          `sponsored-pin-${Date.now()}.webp`,
        );
        setUploadedPhotoId(mediaPublicId);
      }
      const pin = offer === "SPONSORED_PIN"
        ? {
            merchant_item_id: merchantId,
            caption: pinCaption.trim(),
            ...(mediaPublicId ? { media_public_id: mediaPublicId } : {}),
          }
        : undefined;
      const publication = offer === "SPONSORED_PIN"
        ? undefined
        : {
            title: publicationTitle.trim(),
            description: publicationDescription.trim(),
          };
      if (!billingEnabled || promoFreeAccess) {
        const activation = await apiFetch(`${API_BASE_URL}/v1/pro/offers/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payment_type: offer,
            ...(pin ? { pin } : {}),
            ...(publication ? { publication } : {}),
          }),
        });
        if (!activation.ok) throw new Error(await readError(activation));
        setOfferActivatedFree(true);
        setIsPaid(true);
        if (offer !== "SPONSORED_PIN") await refreshUser();
        return;
      }
      const response = await apiFetch(`${API_BASE_URL}/v1/payments/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_type: offer,
          ...(pin ? { pin } : {}),
          ...(publication ? { publication } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== "object" ||
        !("transaction_id" in payload) ||
        typeof payload.transaction_id !== "string" ||
        !("payment_url" in payload) ||
        typeof payload.payment_url !== "string" ||
        !/^https:\/\/[^\s]+$/i.test(payload.payment_url)
      ) {
        throw new Error("Le serveur a renvoyé un lien de paiement invalide.");
      }

      await WebBrowser.openBrowserAsync(payload.payment_url);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const statusResponse = await apiFetch(
          `${API_BASE_URL}/v1/payments/transactions/${encodeURIComponent(payload.transaction_id)}`,
        );
        if (!statusResponse.ok) throw new Error(await readError(statusResponse));
        const statusPayload: unknown = await statusResponse.json();
        const transaction =
          statusPayload &&
          typeof statusPayload === "object" &&
          "transaction" in statusPayload &&
          statusPayload.transaction &&
          typeof statusPayload.transaction === "object"
            ? statusPayload.transaction
            : null;
        if (transaction && "status" in transaction) {
          if (transaction.status === "APPROVED") {
            setIsPaid(true);
            await refreshUser();
            return;
          }
          if (transaction.status === "FAILED" || transaction.status === "CANCELED") {
            throw new Error("Le paiement a été refusé ou annulé.");
          }
        }
        await wait(3000);
      }
      Alert.alert(
        "Paiement en cours de vérification",
        "Nous actualiserons votre offre dès que FedaPay aura confirmé le paiement.",
      );
    } catch (error) {
      Alert.alert(
        "Paiement impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsPaying(false);
    }
  };

  if (isPaid) {
    return (
      <View style={styles.successScreen}>
        <CheckCircle2 color="#16a34a" size={58} />
        <Text style={styles.successTitle}>
          {offerActivatedFree ? "Offre activée gratuitement" : "Paiement confirmé"}
        </Text>
        <Text style={styles.subtitle}>
          {offer === "SPONSORED_PIN"
            ? "Votre épingle sponsorisée est visible sur la carte pour 7 jours."
            : `Votre abonnement ${OFFERS.find(({ id }) => id === offer)?.title} est activé pour 30 jours.`}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            navigation.navigate("Main", {
              screen: offer === "SPONSORED_PIN" ? "CarteSOS" : "EspacePro",
            })
          }
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>
            {offer === "SPONSORED_PIN" ? "Voir la carte radar" : "Ouvrir mon espace Pro"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.goBack()}
        style={styles.backButton}
      >
        <ArrowLeft color="#334155" size={20} />
        <Text style={styles.backText}>Retour au profil</Text>
      </Pressable>
      <Text style={styles.title}>Choisissez votre offre</Text>
      <Text style={styles.subtitle}>
        Activez votre présence professionnelle dans votre quartier.
      </Text>
      {(!billingEnabled || promoFreeAccess) && billingConfigLoaded && (
        <View accessibilityRole="summary" style={styles.freeBanner}>
          <Text style={styles.freeBannerText}>Gratuit pendant la phase de test</Text>
        </View>
      )}

      {OFFERS.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="radio"
          accessibilityState={{ selected: offer === item.id }}
          onPress={() => void selectOffer(item.id)}
          style={[styles.offerCard, offer === item.id && styles.selectedOffer]}
        >
          {item.id === "SPONSORED_PIN" ? (
            <MapPin color="#ea580c" size={26} />
          ) : (
            <ShieldCheck color="#2563eb" size={26} />
          )}
          <View style={styles.offerCopy}>
            <Text style={styles.offerTitle}>{item.title}</Text>
            <Text style={styles.offerDescription}>{item.description}</Text>
            <Text style={styles.price}>{item.price}</Text>
          </View>
        </Pressable>
      ))}

      {offer !== "SPONSORED_PIN" && (
        <View style={styles.pinForm}>
          <Text style={styles.inputLabel}>
            {offer === "ALLIANCE_PRO" ? "Nom de votre commerce" : "Nom de votre structure"}
          </Text>
          <TextInput
            accessibilityLabel="Nom de votre structure"
            maxLength={150}
            onChangeText={setPublicationTitle}
            placeholder="Nom"
            style={styles.input}
            value={publicationTitle}
          />
          <Text style={[styles.inputLabel, styles.formLabelSpacing]}>
            Présentation courte (500 caractères maximum)
          </Text>
          <TextInput
            accessibilityLabel="Présentation courte de l'offre"
            maxLength={500}
            multiline
            onChangeText={setPublicationDescription}
            placeholder="Présentez votre activité ou votre structure"
            style={[styles.input, styles.multilineInput]}
            value={publicationDescription}
          />
        </View>
      )}

      {offer === "SPONSORED_PIN" && (
        <View style={styles.pinForm}>
          <Text style={styles.inputLabel}>Choisir mon commerce</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setMerchantPickerVisible(true)}
            style={styles.input}
          >
            <Text style={styles.merchantName}>
              {merchantItems.find(({ id }) => id === merchantId)?.title ??
                "Sélectionner un commerce"}
            </Text>
          </Pressable>
          {!merchantItems.length && (
            <Text style={styles.locationHint}>
              Publiez d'abord une annonce commerciale dans le Marché pour pouvoir la mettre en avant.
            </Text>
          )}
          <Text style={styles.inputLabel}>Texte court (300 caractères maximum)</Text>
          <TextInput
            accessibilityLabel="Texte court de l'épingle sponsorisée"
            maxLength={300}
            onChangeText={setPinCaption}
            placeholder="Présentez votre commerce en quelques mots"
            style={styles.input}
            value={pinCaption}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void choosePinPhoto()}
            style={styles.photoButton}
          >
            {pinPhoto ? (
              <Image source={{ uri: pinPhoto.uri }} style={styles.pinPhoto} />
            ) : (
              <ImagePlus color="#2563eb" size={20} />
            )}
            <Text style={styles.locationHint}>{pinPhoto ? "Changer la photo" : "Ajouter une photo"}</Text>
          </Pressable>
          <Text style={styles.locationHint}>Durée : 7 jours</Text>
        </View>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => setMerchantPickerVisible(false)}
        transparent
        visible={merchantPickerVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.merchantModal}>
            <Text style={styles.inputLabel}>Mes commerces</Text>
            {merchantItems.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => {
                  setMerchantId(item.id);
                  setMerchantPickerVisible(false);
                }}
                style={styles.merchantOption}
              >
                <Text style={styles.merchantName}>{item.title}</Text>
              </Pressable>
            ))}
            {!merchantItems.length && (
              <Text style={styles.locationHint}>Aucun commerce publié pour le moment.</Text>
            )}
            <Pressable onPress={() => setMerchantPickerVisible(false)} style={styles.closeMerchantModal}>
              <Text style={styles.backText}>Fermer</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Pressable
        accessibilityRole="button"
        disabled={isPaying}
        onPress={() => void startPayment()}
        style={[styles.primaryButton, isPaying && styles.disabledButton]}
      >
        {isPaying ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <>
            <Text style={styles.primaryButtonText}>
              {billingEnabled && !promoFreeAccess
                ? "Payer avec FedaPay (Mobile Money / Carte Visa)"
                : "Publier gratuitement"}
            </Text>
          </>
        )}
      </Pressable>
      {billingEnabled && !promoFreeAccess && (
        <Text style={styles.secureNote}>
          Vous serez redirigé vers la page sécurisée de FedaPay. L'offre n'est activée
          qu'après confirmation du paiement.
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: "#f8fafc", flexGrow: 1, padding: 20, paddingTop: 56 },
  backButton: { alignItems: "center", flexDirection: "row", gap: 8, marginBottom: 24 },
  backText: { color: "#334155", fontSize: 14, fontWeight: "600" },
  title: { color: "#172b4d", fontSize: 25, fontWeight: "800" },
  subtitle: { color: "#64748b", fontSize: 14, lineHeight: 21, marginTop: 8 },
  offerCard: {
    alignItems: "flex-start",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 13,
    marginTop: 18,
    padding: 16,
  },
  selectedOffer: { borderColor: "#2563eb", borderWidth: 2 },
  offerCopy: { flex: 1 },
  offerTitle: { color: "#172b4d", fontSize: 16, fontWeight: "700" },
  offerDescription: { color: "#64748b", fontSize: 12, lineHeight: 18, marginTop: 4 },
  price: { color: "#1d4ed8", fontSize: 14, fontWeight: "700", marginTop: 9 },
  freeBanner: { backgroundColor: "#dcfce7", borderColor: "#86efac", borderRadius: 9, borderWidth: 1, marginTop: 14, padding: 10 },
  freeBannerText: { color: "#166534", fontSize: 13, fontWeight: "700", textAlign: "center" },
  pinForm: { marginTop: 18 },
  inputLabel: { color: "#334155", fontSize: 13, fontWeight: "600", marginBottom: 7 },
  formLabelSpacing: { marginTop: 14 },
  multilineInput: { minHeight: 92, paddingTop: 10, textAlignVertical: "top" },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    color: "#172b4d",
    minHeight: 48,
    paddingHorizontal: 12,
  },
  locationHint: { color: "#64748b", fontSize: 12, marginTop: 8 },
  photoButton: { alignItems: "center", backgroundColor: "#fff", borderColor: "#cbd5e1", borderRadius: 10, borderWidth: 1, flexDirection: "row", gap: 10, marginTop: 12, minHeight: 48, paddingHorizontal: 12 },
  pinPhoto: { borderRadius: 6, height: 38, width: 48 },
  modalBackdrop: { alignItems: "center", backgroundColor: "rgba(15,23,42,0.45)", flex: 1, justifyContent: "center", padding: 20 },
  merchantModal: { backgroundColor: "#fff", borderRadius: 14, maxHeight: "75%", padding: 18, width: "100%" },
  merchantOption: { borderBottomColor: "#e2e8f0", borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 13 },
  merchantOptionSelected: { backgroundColor: "#eff6ff" },
  merchantName: { color: "#172b4d", fontSize: 14, fontWeight: "600" },
  closeMerchantModal: { alignItems: "center", paddingTop: 14 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 11,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 24,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  disabledButton: { opacity: 0.65 },
  primaryButtonText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  secureNote: { color: "#64748b", fontSize: 11, lineHeight: 17, marginTop: 12 },
  successScreen: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  successTitle: { color: "#172b4d", fontSize: 24, fontWeight: "800", marginTop: 16 },
});
