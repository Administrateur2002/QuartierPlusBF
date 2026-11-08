import {
  AlertTriangle,
  ChevronRight,
  Flag,
  Globe,
  ImagePlus,
  MessageSquare,
  MapPin,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tag,
  Wrench,
  X,
} from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { File, Paths } from "expo-file-system";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { API_BASE_URL, apiFetch } from "../services/api";
import { uploadMarketplaceImage } from "../services/uploadMarketplaceImage";
import { MediaUploadError } from "../services/mediaUploadError";
import { openProfileStore } from "../storage/profileStore";
import type { MainTabParamList } from "../navigation/types";
import VoiceTextInput from "../components/VoiceTextInput";
import { EMBEDDED_PHONE_COUNTRIES } from "./auth/phoneNumber";
import MarketplaceCommercePanel from "./MarketplaceCommercePanel";

type MarketTab = "Annonces" | "Local / Made in" | "Services & Métiers";
type MarketSection =
  | "explore"
  | "shops"
  | "orders"
  | "opportunities"
  | "deliveries";
type ListingCategory =
  | "Tous"
  | "Alimentation"
  | "Électronique"
  | "Mode"
  | "Équipements";
type TradeCategory =
  | "Tous"
  | "Électricité"
  | "Plomberie"
  | "Maçonnerie"
  | "Couture"
  | "Boulangerie";
type MarketplaceItem = {
  id: string;
  sellerId?: string;
  isAlly: boolean;
  alliancePending: boolean;
  name: string;
  description: string;
  price: number | null;
  promoPrice?: number | null;
  isPromoted: boolean;
  isFree: boolean;
  currency: string;
  currencyCode: string;
  location: string;
  countryCode?: string;
  city?: string;
  languageCode?: string;
  category: string;
  countryOfOrigin?: string;
  seller: string;
  verified: boolean;
  sellerRating: number;
  sellerReviewCount: number;
  shopName?: string;
  phone: string;
  whatsappPhone: string;
  imageUrl?: string;
  itemType: "listing" | "local" | "service";
  distanceMeters?: number;
};

const TABS: MarketTab[] = [
  "Annonces",
  "Local / Made in",
  "Services & Métiers",
];
const MARKET_SECTIONS: { id: MarketSection; label: string }[] = [
  { id: "explore", label: "Explorer" },
  { id: "shops", label: "Boutiques" },
  { id: "orders", label: "Commandes" },
  { id: "opportunities", label: "Opportunités" },
  { id: "deliveries", label: "Livraisons" },
];
const LISTING_CATEGORIES: ListingCategory[] = [
  "Tous",
  "Alimentation",
  "Électronique",
  "Mode",
  "Équipements",
];
const TRADE_CATEGORIES: TradeCategory[] = [
  "Tous",
  "Électricité",
  "Plomberie",
  "Maçonnerie",
  "Couture",
  "Boulangerie",
];
const FALLBACK_COUNTRIES = [
  { code: "SN", name: "Sénégal", prefix: "+221" },
  { code: "CI", name: "Côte d'Ivoire", prefix: "+225" },
  { code: "BJ", name: "Bénin", prefix: "+229" },
];
const MARKET_COUNTRIES =
  EMBEDDED_PHONE_COUNTRIES.length > 0
    ? EMBEDDED_PHONE_COUNTRIES
    : FALLBACK_COUNTRIES;
const COUNTRY_OPTIONS = [
  { code: "ALL", name: "À proximité" },
  { code: "INT", name: "International" },
  ...MARKET_COUNTRIES,
];
const MARKET_CURRENCIES = [
  { code: "XOF", name: "FCFA (UEMOA)" },
  { code: "XAF", name: "FCFA (CEMAC)" },
  { code: "USD", name: "Dollar US" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "Livre sterling" },
  { code: "NGN", name: "Naira" },
  { code: "GHS", name: "Cedi" },
  { code: "MAD", name: "Dirham marocain" },
  { code: "KES", name: "Shilling kényan" },
  { code: "ZAR", name: "Rand" },
  { code: "CAD", name: "Dollar canadien" },
];
const MAX_IMAGE_BYTES = 300 * 1024;
const VALIDATION_FIELD_LABELS: Record<string, string> = {
  title: "Titre",
  description: "Description",
  category: "Catégorie",
  item_type: "Portée",
  price: "Prix",
  currency: "Devise",
  currency_code: "Devise",
  promo_price: "Prix promotionnel",
  country_code: "Pays",
  country_of_origin: "Pays d'origine",
  "location.latitude": "Position (latitude)",
  "location.longitude": "Position (longitude)",
  media_public_id: "Photo",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeItem = (value: unknown): MarketplaceItem | null => {
  if (!isRecord(value)) return null;
  const seller = isRecord(value.seller) ? value.seller : null;
  const id = String(value.id ?? "");
  const name = String(value.title ?? value.name ?? "");
  const rawPrice = value.price;
  const isFree =
    value.is_free === true ||
    value.isFree === true ||
    String(value.price_type ?? "").toUpperCase() === "FREE";
  const price =
    rawPrice === null || rawPrice === undefined || rawPrice === ""
      ? null
      : Number(rawPrice);
  const rawType = String(
    value.item_type ?? value.itemType ?? value.type ?? "listing",
  ).toLowerCase();
  const rawDistance = Number(value.distance_m ?? value.distanceMeters);
  const rawCurrencyCode = String(value.currency_code ?? "").toUpperCase();
  const promoPrice =
    value.promo_price === null || value.promo_price === undefined
      ? null
      : Number(value.promo_price);
  const isPromoted =
    value.is_promoted === true ||
    (promoPrice !== null &&
      Number.isFinite(promoPrice) &&
      (!value.promo_expires_at ||
        new Date(String(value.promo_expires_at)).getTime() > Date.now()));
  if (
    !id ||
    !name ||
    (!isFree && (price === null || !Number.isFinite(price) || price < 0))
  ) {
    return null;
  }
  return {
    id,
    sellerId: typeof value.seller_id === "string" ? value.seller_id : undefined,
    isAlly: value.seller_is_ally === true,
    alliancePending: value.seller_alliance_pending === true,
    name,
    description: String(value.description ?? ""),
    price,
    promoPrice:
      promoPrice !== null && Number.isFinite(promoPrice) ? promoPrice : null,
    isPromoted,
    isFree,
    currency:
      String(value.currency ?? "").toUpperCase() ||
      (rawCurrencyCode === "XOF" ? "FCFA" : rawCurrencyCode || "FCFA"),
    currencyCode: rawCurrencyCode || "XOF",
    location: String(
      value.neighborhood ?? value.city ?? value.location_name ?? value.location ?? "",
    ),
    ...(typeof value.country_code === "string"
      ? { countryCode: value.country_code }
      : {}),
    ...(typeof value.city === "string" ? { city: value.city } : {}),
    ...(typeof value.language_code === "string"
      ? { languageCode: value.language_code }
      : {}),
    category: String(value.category ?? "Autre"),
    ...(typeof value.country_of_origin === "string"
      ? { countryOfOrigin: value.country_of_origin }
      : {}),
    seller: String(
      value.shop_name ??
      seller?.name ?? value.seller_name ?? value.maker ?? value.provider_name ?? "Vendeur",
    ),
    verified: seller?.verified === true || value.seller_verified === true,
    sellerRating: Number(value.seller_rating ?? 0),
    sellerReviewCount: Number(value.seller_review_count ?? 0),
    ...(typeof value.shop_name === "string" ? { shopName: value.shop_name } : {}),
    phone: String(seller?.phone ?? value.seller_phone ?? value.phone ?? ""),
    whatsappPhone: String(
      seller?.whatsapp ?? value.whatsapp_phone ?? value.whatsapp ?? "",
    ),
    imageUrl:
      typeof value.image_url === "string"
        ? value.image_url
        : typeof value.imageUrl === "string"
          ? value.imageUrl
          : undefined,
    itemType:
      rawType === "local" || rawType === "made_in"
        ? "local"
        : rawType === "service" || rawType === "trade"
          ? "service"
          : "listing",
    distanceMeters:
      Number.isFinite(rawDistance) && rawDistance >= 0
        ? rawDistance
        : undefined,
  };
};

const categoryQuery = (
  tab: MarketTab,
  listingCategory: ListingCategory,
  tradeCategory: TradeCategory,
) => {
  if (tab === "Local / Made in") return "MADE_IN";
  if (tab === "Services & Métiers") {
    return tradeCategory === "Tous"
      ? "SERVICE"
      : tradeCategory.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .toUpperCase()
          .replaceAll(" ", "_");
  }
  return listingCategory === "Tous"
    ? "ALL"
    : listingCategory.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replaceAll(" ", "_");
};

const normalizeSearchText = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();

export default function MarketplaceScreen() {
  const navigation =
    useNavigation<BottomTabNavigationProp<MainTabParamList>>();
  const route = useRoute<RouteProp<MainTabParamList, "Marche">>();
  const { colors, t } = useTheme();
  const {
    authStatus,
    isOffline,
    queueOfflineAction,
    requestAuthentication,
    user,
  } = useAuth();

  const requireConnectedUser = () => {
    if (authStatus !== "connected") {
      requestAuthentication();
      return false;
    }
    return true;
  };
  const [activeTab, setActiveTab] = useState<MarketTab>("Annonces");
  const [marketSection, setMarketSection] = useState<MarketSection>("explore");
  const [selectedCountry, setSelectedCountry] = useState("ALL");
  const [cityQuery, setCityQuery] = useState("");
  const [languageCode, setLanguageCode] = useState("");
  const [sortMode, setSortMode] = useState<"newest" | "promotions" | "popular">("newest");
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [listingCategory, setListingCategory] =
    useState<ListingCategory>("Tous");
  const [tradeCategory, setTradeCategory] = useState<TradeCategory>("Tous");
  const [searchText, setSearchText] = useState("");
  const [settledSearchText, setSettledSearchText] = useState("");
  const [userLocation, setUserLocation] =
    useState<Location.LocationObjectCoords | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [countryOriginModalVisible, setCountryOriginModalVisible] = useState(false);
  const [countryOfOrigin, setCountryOfOrigin] = useState(
    user?.country_code ?? "SN",
  );
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftCurrencyCode, setDraftCurrencyCode] = useState("XOF");
  const [draftPromoPrice, setDraftPromoPrice] = useState("");
  const [isFreeListing, setIsFreeListing] = useState(false);
  const [draftCategory, setDraftCategory] = useState("");
  const [draftImage, setDraftImage] = useState<{
    uri: string;
    size: number;
  } | null>(null);
  const [pendingMediaPublicId, setPendingMediaPublicId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [mediaTechnicalDetails, setMediaTechnicalDetails] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [selectedReportItem, setSelectedReportItem] =
    useState<MarketplaceItem | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [comparedIds, setComparedIds] = useState<string[]>([]);
  const [compareModalVisible, setCompareModalVisible] = useState(false);
  const [selectedSellerId, setSelectedSellerId] = useState<string | null>(null);
  const [orderItem, setOrderItem] = useState<MarketplaceItem | null>(null);
  const [orderDeliveryMethod, setOrderDeliveryMethod] = useState<
    "HOME_DELIVERY" | "PICKUP"
  >("HOME_DELIVERY");
  const [orderAddress, setOrderAddress] = useState("");
  const [orderCity, setOrderCity] = useState("");
  const [orderNote, setOrderNote] = useState("");
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const handledVoiceRequestRef = useRef<string | null>(null);

  const filteredItems = useMemo(() => {
    const query = normalizeSearchText(searchText.trim());
    return items.filter((item) => {
      const matchesType =
        activeTab === "Annonces"
          ? item.itemType === "listing"
          : activeTab === "Local / Made in"
            ? item.itemType === "local"
            : item.itemType === "service";
      const matchesSearch =
        query.length === 0 ||
        normalizeSearchText(
          `${item.name} ${item.seller} ${item.location} ${item.category}`,
        ).includes(query);
      const matchesPromotion = sortMode !== "promotions" || item.isPromoted;
      return matchesType && matchesSearch && matchesPromotion;
    });
  }, [activeTab, items, searchText, sortMode]);

  const compareItems = useMemo(
    () => items.filter((item) => comparedIds.includes(item.id)),
    [comparedIds, items],
  );

  useEffect(() => {
    const timer = setTimeout(() => setSettledSearchText(searchText.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    const params = route.params;
    const requestId = params?.voiceRequestId;
    if (!requestId || handledVoiceRequestRef.current === requestId) return;
    handledVoiceRequestRef.current = requestId;
    if (typeof params.voiceSearch === "string") {
      setActiveTab("Annonces");
      setSearchText(params.voiceSearch);
    }
    if (params.voiceCreateListing) {
      const targetType = params.voiceCreateType ?? "listing";
      setActiveTab(
        targetType === "local"
          ? "Local / Made in"
          : targetType === "service"
            ? "Services & Métiers"
            : "Annonces",
      );
      setIsCreateModalVisible(true);
    }
  }, [route.params]);

  useEffect(() => {
    let active = true;
    void openProfileStore()
      .then((store) => store.getCountry())
      .then((country) => {
        if (
          active &&
          country?.code &&
          MARKET_COUNTRIES.some(({ code }) => code === country.code)
        ) {
          setCountryOfOrigin(country.code);
        }
      })
      .catch(() => {
        console.warn("Unable to load the active country for the marketplace.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (user?.country_code && MARKET_COUNTRIES.some(({ code }) => code === user.country_code)) {
      setCountryOfOrigin(user.country_code);
    }
  }, [user?.country_code]);

  useEffect(() => {
    let isMounted = true;
    const loadLocation = async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") {
          throw new Error("L'autorisation de localisation est nécessaire au marché de proximité.");
        }
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (isMounted) {
          setUserLocation(position.coords);
          setLocationError(null);
        }
      } catch (error) {
        if (!isMounted) return;
        setLocationError(
          error instanceof Error
            ? error.message
            : "Impossible d'obtenir votre position.",
        );
      }
    };
    void loadLocation();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (marketSection !== "explore") {
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }
    if (!API_BASE_URL) {
      setLoadError(
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }
    if (!userLocation && selectedCountry !== "INT") {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const loadItems = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const query = new URLSearchParams({
          item_type:
            activeTab === "Annonces"
              ? "listing"
              : activeTab === "Local / Made in"
                ? "local"
                : "service",
          sort: sortMode,
        });
        if (userLocation) {
          query.set("latitude", String(userLocation.latitude));
          query.set("longitude", String(userLocation.longitude));
          query.set("radius_m", "100000");
        }
        const selectedCategory = categoryQuery(
          activeTab,
          marketSection,
          listingCategory,
          tradeCategory,
        );
        if (selectedCategory !== "ALL") {
          query.set("category", selectedCategory);
        }
        if (selectedCountry === "INT") {
          query.set("scope", "international");
        } else if (selectedCountry !== "ALL") {
          query.set("country_code", selectedCountry);
          query.set("scope", "country");
        }
        if (settledSearchText) query.set("q", settledSearchText);
        if (cityQuery.trim()) query.set("city", cityQuery.trim());
        if (languageCode.trim()) query.set("language_code", languageCode.trim());
        const response = await apiFetch(
          `${API_BASE_URL}/v1/public/marketplace?${query.toString()}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Chargement du marché refusé (HTTP ${response.status}).`);
        }
        const payload: unknown = await response.json();
        const rawItems = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.items)
            ? payload.items
            : null;
        if (!rawItems) {
          throw new Error("Le serveur a renvoyé une liste d'annonces invalide.");
        }
        const normalized = rawItems.map(normalizeItem);
        if (normalized.some((item) => item === null)) {
          throw new Error("La liste contient une annonce invalide.");
        }
        setItems(normalized.filter((item): item is MarketplaceItem => item !== null));
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Impossible de charger les annonces.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    };
    void loadItems();
    return () => controller.abort();
  }, [
    activeTab,
    isOffline,
    listingCategory,
    cityQuery,
    languageCode,
    refreshKey,
    selectedCountry,
    settledSearchText,
    sortMode,
    tradeCategory,
    userLocation,
  ]);

  const refreshItems = () => {
    if (!userLocation && selectedCountry !== "INT") {
      void Location.requestForegroundPermissionsAsync()
        .then(async (permission) => {
          if (permission.status !== "granted") {
            throw new Error("L'autorisation de localisation est nécessaire au marché de proximité.");
          }
          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUserLocation(position.coords);
          setLocationError(null);
        })
        .catch((error: unknown) => {
          setLocationError(
            error instanceof Error
              ? error.message
              : "Impossible d'obtenir votre position.",
          );
        });
      return;
    }
    setIsRefreshing(true);
    setRefreshKey((current) => current + 1);
  };

  const formatPrice = (item: MarketplaceItem) =>
    item.isFree
      ? "Gratuit / Don"
      : `${new Intl.NumberFormat("fr-FR").format(
          item.isPromoted ? item.promoPrice ?? item.price ?? 0 : item.price ?? 0,
        )} ${item.currency}`;

  const contactSeller = async (item: MarketplaceItem) => {
    if (!requireConnectedUser()) return;
    const whatsappPhone = item.whatsappPhone.replace(/[^\d]/g, "");
    const phone = item.phone.replace(/[^\d+]/g, "");
    const message = `Bonjour, je suis intéressé par votre annonce « ${item.name} ».`;
    const whatsappUrl = `whatsapp://send?phone=${whatsappPhone}&text=${encodeURIComponent(message)}`;
    const phoneUrl = `tel:${phone}`;
    try {
      if (whatsappPhone && (await Linking.canOpenURL(whatsappUrl))) {
        Alert.alert("Contacter le vendeur", item.seller, [
          {
            text: "WhatsApp",
            onPress: () => void openContactLink(whatsappUrl),
          },
          ...(phone
            ? [{ text: "Appeler", onPress: () => void openContactLink(phoneUrl) }]
            : []),
          { text: "Annuler", style: "cancel" },
        ]);
        return;
      }
      if (phone && (await Linking.canOpenURL(phoneUrl))) {
        await Linking.openURL(phoneUrl);
        return;
      }
      if (whatsappPhone) {
        await Linking.openURL(
          `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(message)}`,
        );
        return;
      }
      Alert.alert(
        "Contact indisponible",
        "Aucun numéro de téléphone ou WhatsApp n'est disponible pour ce vendeur.",
      );
    } catch (error) {
      Alert.alert(
        "Impossible de contacter le vendeur",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    }
  };

  const allySeller = async (item: MarketplaceItem) => {
    if (!item.sellerId || item.sellerId === user?.id) return;
    if (!requireConnectedUser() || !API_BASE_URL) return;
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/social/alliance/${encodeURIComponent(item.sellerId)}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`Demande impossible (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !["PENDING", "ALLIED"].includes(String(payload.status))) {
        throw new Error("La réponse d’alliance est invalide.");
      }
      setItems((current) => current.map((entry) =>
        entry.sellerId === item.sellerId
          ? {
              ...entry,
              isAlly: payload.status === "ALLIED",
              alliancePending: payload.status === "PENDING",
            }
          : entry,
      ));
    } catch (error) {
      Alert.alert(
        "Alliance indisponible",
        error instanceof Error ? error.message : "Réessayez.",
      );
    }
  };

  const openContactLink = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert(
        "Contact indisponible",
        error instanceof Error ? error.message : "Impossible d'ouvrir l'application de contact.",
      );
    }
  };

  const openCreateForm = () => {
    if (!requireConnectedUser()) return;
    setDraftTitle("");
    setDraftDescription("");
    setDraftPrice("");
    setDraftCurrencyCode("XOF");
    setDraftPromoPrice("");
    setDraftCategory(
      activeTab === "Annonces"
        ? listingCategory === "Tous"
          ? ""
          : listingCategory
        : activeTab === "Services & Métiers"
          ? tradeCategory === "Tous"
            ? ""
            : tradeCategory
          : "MADE_IN",
    );
    setIsFreeListing(false);
    setDraftImage(null);
    setPendingMediaPublicId(null);
    setPublishError(null);
    setMediaTechnicalDetails(null);
    setIsCreateModalVisible(true);
  };

  const chooseListingImage = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error("L'accès à la photothèque est nécessaire pour ajouter une photo.");
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 1,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) throw new Error("La photo sélectionnée est indisponible.");
      let uri = asset.uri;
      let size = Number.POSITIVE_INFINITY;
      for (const [width, quality] of [
        [1600, 0.72],
        [1280, 0.58],
        [1024, 0.45],
        [800, 0.32],
        [640, 0.22],
      ]) {
        const compressed = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width } }],
          { compress: quality, format: ImageManipulator.SaveFormat.WEBP },
        );
        uri = compressed.uri;
        size = new File(uri).size;
        if (Number.isFinite(size) && size < MAX_IMAGE_BYTES) break;
      }
      if (!Number.isFinite(size) || size >= MAX_IMAGE_BYTES) {
        throw new Error("La photo ne peut pas être compressée sous 300 Ko.");
      }
      setDraftImage({ uri, size });
      setPendingMediaPublicId(null);
      setPublishError(null);
      setMediaTechnicalDetails(null);
    } catch (error) {
      Alert.alert(
        "Image indisponible",
        error instanceof Error ? error.message : "Impossible de compresser la photo.",
      );
    }
  };

  const publishItem = async () => {
    if (!requireConnectedUser()) return;
    const numericPrice = Number(
      draftPrice.replace(/\s/g, "").replace(",", "."),
    );
    if (!draftTitle.trim() || !draftCategory.trim()) {
      Alert.alert("Champs obligatoires", "Saisissez un titre et choisissez une catégorie.");
      return;
    }
    if (
      activeTab === "Local / Made in" &&
      !MARKET_COUNTRIES.some(({ code }) => code === countryOfOrigin)
    ) {
      Alert.alert("Pays obligatoire", "Choisissez le pays d'origine du produit.");
      return;
    }
    if (
      !isFreeListing &&
      (!draftPrice.trim() || !Number.isFinite(numericPrice) || numericPrice < 0)
    ) {
      Alert.alert(
        "Prix invalide",
        `Saisissez un prix valide en ${draftCurrencyCode === "XOF" ? "FCFA" : draftCurrencyCode} ou choisissez « Gratuit / Don ».`,
      );
      return;
    }
    const numericPromoPrice = draftPromoPrice.trim()
      ? Number(draftPromoPrice.replace(/\s/g, "").replace(",", "."))
      : null;
    if (
      numericPromoPrice !== null &&
      (!Number.isFinite(numericPromoPrice) ||
        isFreeListing ||
        numericPromoPrice <= 0 ||
        numericPromoPrice >= numericPrice)
    ) {
      Alert.alert(
        "Promotion invalide",
        "Le prix promotionnel doit être positif et inférieur au prix normal.",
      );
      return;
    }
    if (!API_BASE_URL) {
      Alert.alert(
        "Publication indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    if (!userLocation) {
      Alert.alert("Position indisponible", locationError ?? "La position est nécessaire pour publier.");
      return;
    }
    setIsPublishing(true);
    setPublishError(null);
    setMediaTechnicalDetails(null);
    try {
      if (isOffline) {
        let persistentImageUri: string | null = null;
        if (draftImage) {
          const sourceFile = new File(draftImage.uri);
          const destinationFile = new File(
            Paths.document,
            `marketplace-offline-${Date.now()}.webp`,
          );
          await sourceFile.copy(destinationFile);
          persistentImageUri = destinationFile.uri;
        }
        await queueOfflineAction("create_post", {
          title: draftTitle.trim(),
          description: draftDescription.trim(),
          category: draftCategory,
          item_type:
            activeTab === "Annonces"
              ? "listing"
              : activeTab === "Local / Made in"
                ? "local"
                : "service",
          is_free: String(isFreeListing),
          currency: "FCFA",
          currency_code: draftCurrencyCode,
          language_code: languageCode || "fr",
          ...(cityQuery.trim() ? { city: cityQuery.trim() } : {}),
          ...(numericPromoPrice !== null
            ? { promo_price: String(numericPromoPrice) }
            : {}),
          ...(user?.country_code ? { country_code: user.country_code } : {}),
          ...(activeTab === "Local / Made in"
            ? { country_of_origin: countryOfOrigin }
            : {}),
          ...(isFreeListing ? {} : { price: String(numericPrice) }),
          location: JSON.stringify({
            latitude: userLocation.latitude,
            longitude: userLocation.longitude,
          }),
          image_uri: persistentImageUri,
        });
        setIsCreateModalVisible(false);
        Alert.alert(
          "Annonce enregistrée hors ligne",
          "Elle sera publiée automatiquement dès le retour de la connexion.",
        );
        return;
      }
      let mediaPublicId = pendingMediaPublicId ?? undefined;
      if (draftImage) {
        mediaPublicId ??= await uploadMarketplaceImage(
            draftImage.uri,
            draftImage.size,
            `marketplace-${Date.now()}.webp`,
          );
        setPendingMediaPublicId(mediaPublicId);
      }
      const response = await apiFetch(`${API_BASE_URL}/v1/marketplace/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draftTitle.trim(),
          description: draftDescription.trim(),
          category: draftCategory,
          item_type:
            activeTab === "Annonces"
              ? "listing"
              : activeTab === "Local / Made in"
                ? "local"
                : "service",
          is_free: isFreeListing,
          price: isFreeListing ? 0 : numericPrice,
          currency: "FCFA",
          currency_code: draftCurrencyCode,
          language_code: languageCode || "fr",
          ...(cityQuery.trim() ? { city: cityQuery.trim() } : {}),
          ...(numericPromoPrice !== null ? { promo_price: numericPromoPrice } : {}),
          ...(user?.country_code ? { country_code: user.country_code } : {}),
          ...(activeTab === "Local / Made in"
            ? { country_of_origin: countryOfOrigin }
            : {}),
          location: {
            latitude: userLocation.latitude,
            longitude: userLocation.longitude,
          },
          ...(mediaPublicId ? { media_public_id: mediaPublicId } : {}),
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        const fieldErrors =
          isRecord(payload) && Array.isArray(payload.errors)
            ? payload.errors
                .filter(
                  (item): item is { field: string; message: string } =>
                    isRecord(item) &&
                    typeof item.field === "string" &&
                    typeof item.message === "string",
                )
                .map(
                  ({ field, message }) =>
                    `${VALIDATION_FIELD_LABELS[field] ?? field} : ${message}`,
                )
            : [];
        throw new Error(
          fieldErrors.length
            ? fieldErrors.join("\n")
            : isRecord(payload) && typeof payload.message === "string"
              ? payload.message
              : `La publication a échoué (HTTP ${response.status}).`,
        );
      }
      const payload: unknown = await response.json();
      const rawItem = isRecord(payload) && "item" in payload ? payload.item : payload;
      const newItem = normalizeItem(rawItem);
      if (!newItem) {
        throw new Error("Le serveur n'a pas renvoyé l'annonce créée.");
      }
      setItems((current) => [newItem, ...current.filter((item) => item.id !== newItem.id)]);
      setIsCreateModalVisible(false);
      setPendingMediaPublicId(null);
      Alert.alert("Annonce publiée", "Votre annonce a été publiée sur le marché.");
    } catch (error) {
      if (error instanceof MediaUploadError) {
        setPublishError(error.message);
        setMediaTechnicalDetails(error.technicalDetails);
      } else {
        setPublishError(error instanceof Error ? error.message : "Une erreur est survenue.");
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const retryListingMedia = async () => {
    if (!draftImage || isPublishing) return;
    setIsPublishing(true);
    setPublishError(null);
    setMediaTechnicalDetails(null);
    try {
      const publicId = await uploadMarketplaceImage(
        draftImage.uri,
        draftImage.size,
        `marketplace-${Date.now()}.webp`,
      );
      setPendingMediaPublicId(publicId);
      setPublishError("Photo téléversée. Publiez l’annonce pour l’enregistrer.");
    } catch (error) {
      setPublishError(
        error instanceof Error ? error.message : "Le média n'a pas pu être téléversé.",
      );
      if (error instanceof MediaUploadError) {
        setMediaTechnicalDetails(error.technicalDetails);
      }
    } finally {
      setIsPublishing(false);
    }
  };

  const submitReport = async () => {
    if (!requireConnectedUser()) return;
    if (!selectedReportItem) return;
    if (!reportReason.trim()) {
      Alert.alert("Motif requis", "Précisez pourquoi cette annonce doit être signalée.");
      return;
    }
    if (!API_BASE_URL) {
      Alert.alert(
        "Signalement indisponible",
        "L'adresse du serveur n'est pas configurée (EXPO_PUBLIC_API_URL).",
      );
      return;
    }
    setIsSubmittingReport(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "marketplace_item",
          target_id: selectedReportItem.id,
          reason: reportReason.trim(),
        }),
      });
      if (!response.ok) {
        throw new Error(`Le signalement a échoué (HTTP ${response.status}).`);
      }
      setSelectedReportItem(null);
      setReportReason("");
      Alert.alert("Signalement transmis", "L'annonce a été transmise à la modération.");
    } catch (error) {
      Alert.alert(
        "Signalement impossible",
        error instanceof Error ? error.message : "Une erreur est survenue.",
      );
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const openOrderForm = (item: MarketplaceItem) => {
    if (!requireConnectedUser()) return;
    if (!item.id || item.itemType === "service" || item.isFree) {
      Alert.alert(
        "Commande indisponible",
        "Cette annonce ne peut pas faire l’objet d’une commande en ligne.",
      );
      return;
    }
    setOrderItem(item);
    setOrderDeliveryMethod("HOME_DELIVERY");
    setOrderAddress("");
    setOrderCity(cityQuery);
    setOrderNote("");
  };

  const submitMarketplaceOrder = async () => {
    if (!requireConnectedUser() || !orderItem) return;
    if (!API_BASE_URL) {
      Alert.alert("Commande indisponible", "L’adresse du serveur n’est pas configurée.");
      return;
    }
    if (
      orderDeliveryMethod === "HOME_DELIVERY" &&
      (!orderAddress.trim() || !orderCity.trim())
    ) {
      Alert.alert("Adresse requise", "Saisissez l’adresse et la ville de livraison.");
      return;
    }
    if (isOffline) {
      Alert.alert(
        "Connexion requise",
        "La commande doit être transmise au vendeur en ligne. Aucun paiement ne sera prélevé dans l’application.",
      );
      return;
    }
    setIsCreatingOrder(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/marketplace/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: orderItem.id,
          delivery_method: orderDeliveryMethod,
          ...(orderDeliveryMethod === "HOME_DELIVERY"
            ? {
                delivery_address: orderAddress.trim(),
                delivery_city: orderCity.trim(),
                delivery_country_code:
                  selectedCountry !== "ALL" && selectedCountry !== "INT"
                    ? selectedCountry
                    : user?.country_code,
              }
            : {}),
          buyer_note: orderNote.trim(),
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        throw new Error(
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `La commande n’a pas été créée (HTTP ${response.status}).`,
        );
      }
      setOrderItem(null);
      setMarketSection("orders");
      Alert.alert(
        "Commande envoyée",
        "Le vendeur a reçu votre demande. Le paiement se règle directement entre vous et lui.",
      );
    } catch (error) {
      Alert.alert(
        "Commande impossible",
        error instanceof Error ? error.message : "Réessayez plus tard.",
      );
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const toggleComparedItem = (item: MarketplaceItem) => {
    setComparedIds((current) => {
      if (current.includes(item.id)) return current.filter((id) => id !== item.id);
      if (current.length >= 3) {
        Alert.alert("Comparaison limitée", "Comparez jusqu’à trois produits à la fois.");
        return current;
      }
      return [...current, item.id];
    });
  };

  const handleCommercePanelOrder = (product: {
    id: string;
    title: string;
    description?: string;
    price: number | string | null;
    currency?: string;
    currency_code?: string;
    category?: string;
    item_type?: string;
    seller_id?: string;
    seller_name?: string;
    seller_verified?: boolean;
    seller_rating?: number;
  }) => {
    const item = normalizeItem({
      ...product,
      seller_id: product.seller_id,
      seller_name: product.seller_name,
      seller_verified: product.seller_verified,
      title: product.title,
      price: product.price,
      currency: product.currency,
      currency_code: product.currency_code,
      item_type: product.item_type ?? "listing",
    });
    if (item) openOrderForm(item);
  };

  const renderItemCard = (item: MarketplaceItem) => (
    <View key={item.id} style={[styles.listingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.listingImage}>
        {item.imageUrl ? (
          <Image
            accessibilityLabel={`Photo de ${item.name}`}
            source={{ uri: item.imageUrl }}
            style={styles.listingPhoto}
          />
        ) : (
          <Tag color="#2563eb" size={25} />
        )}
      </View>
      <View style={styles.listingBody}>
        <Text numberOfLines={2} style={[styles.listingName, { color: colors.text }]}>{item.name}</Text>
        <Text style={styles.listingPrice}>{formatPrice(item)}</Text>
        {item.isPromoted && item.price !== null && (
          <Text style={styles.originalPrice}>
            {new Intl.NumberFormat("fr-FR").format(item.price)} {item.currency}
          </Text>
        )}
        {item.isPromoted && (
          <Text style={styles.promotionBadge}>Promotion · prix vendeur</Text>
        )}
        <View style={styles.locationRow}>
          <MapPin color={colors.secondaryText} size={13} />
          <Text numberOfLines={1} style={[styles.locationText, { color: colors.secondaryText }]}>
            {item.location || "À proximité"}
          </Text>
        </View>
        <View style={styles.sellerRow}>
          <Text numberOfLines={1} style={styles.sellerText}>{item.seller}</Text>
          {item.verified && (
            <View style={styles.sellerBadge}>
              <ShieldCheck color="#15803d" size={12} />
              <Text style={styles.sellerBadgeText}>Vérifié</Text>
            </View>
          )}
          {item.sellerId && item.sellerId !== user?.id ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.isAlly }}
              onPress={() => void allySeller(item)}
              style={styles.allySellerButton}
            >
              <Text style={styles.allySellerText}>
                {item.isAlly ? "Allié ✓" : item.alliancePending ? "Demande envoyée" : "Se rallier"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {item.sellerReviewCount > 0 && (
          <Text style={styles.sellerRating}>
            ★ {item.sellerRating.toFixed(1)} · {item.sellerReviewCount} avis après achat
          </Text>
        )}
        <View style={styles.cardActions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => toggleComparedItem(item)}
            style={[
              styles.compareButton,
              comparedIds.includes(item.id) && styles.compareButtonSelected,
            ]}
          >
            <Text
              style={[
                styles.compareButtonText,
                comparedIds.includes(item.id) && styles.compareButtonTextSelected,
              ]}
            >
              {comparedIds.includes(item.id) ? "✓ Comparé" : "Comparer"}
            </Text>
          </Pressable>
          {item.itemType !== "service" && !item.isFree && (
            <Pressable
              accessibilityRole="button"
              onPress={() => openOrderForm(item)}
              style={styles.orderButton}
            >
              <Text style={styles.orderButtonText}>Commander</Text>
            </Pressable>
          )}
        </View>
        {item.sellerId && item.shopName && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSelectedSellerId(item.sellerId ?? null);
              setMarketSection("shops");
            }}
            style={styles.storeButton}
          >
            <Store color="#2563eb" size={13} />
            <Text style={styles.storeButtonText}>
              {item.shopName ? `Vitrine · ${item.shopName}` : "Voir le vendeur"}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={() => void contactSeller(item)}
          style={styles.contactButton}
        >
          <MessageSquare color="#ffffff" size={14} />
          <Text style={styles.contactButtonText}>Contacter</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setSelectedReportItem(item);
            setReportReason("");
          }}
          style={styles.reportListingButton}
        >
          <Flag color="#b91c1c" size={13} />
          <Text style={styles.reportListingText}>Signaler cette annonce</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={refreshItems}
            refreshing={isRefreshing}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <ShoppingBag color={colors.primary} size={22} />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>{t("marketTitle")}</Text>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("Grossistes")}
          style={[styles.wholesalerEntry, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Store color={colors.primary} size={20} />
          <View style={styles.wholesalerEntryCopy}>
            <Text style={[styles.wholesalerEntryTitle, { color: colors.text }]}>Commander chez un grossiste</Text>
            <Text style={[styles.wholesalerEntrySubtitle, { color: colors.secondaryText }]}>Acheteur · sans abonnement</Text>
          </View>
          <ChevronRight color={colors.secondaryText} size={19} />
        </Pressable>

        <ScrollView contentContainerStyle={styles.marketSections} horizontal showsHorizontalScrollIndicator={false}>
          {MARKET_SECTIONS.map(({ id, label }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: marketSection === id }}
              key={id}
              onPress={() => {
                setSelectedSellerId(null);
                setMarketSection(id);
              }}
              style={[
                styles.marketSectionButton,
                { borderColor: marketSection === id ? colors.primary : colors.border },
                marketSection === id && { backgroundColor: colors.primary },
              ]}
            >
              <Text
                style={[
                  styles.marketSectionText,
                  { color: marketSection === id ? "#ffffff" : colors.text },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {marketSection === "explore" && (
          <ScrollView
            contentContainerStyle={styles.tabs}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {TABS.map((tab) => {
              const isSelected = activeTab === tab;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  style={[styles.tab, isSelected && styles.tabSelected]}
                >
                  <Text
                    style={[styles.tabText, isSelected && styles.tabTextSelected]}
                  >
                    {tab === "Annonces"
                      ? t("marketListings")
                      : tab === "Local / Made in"
                        ? t("marketLocal")
                        : t("marketServices")}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        <View style={styles.countryContainer}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: countryMenuOpen }}
            onPress={() => setCountryMenuOpen(!countryMenuOpen)}
            style={styles.countrySelector}
          >
            <Globe color="#2563eb" size={19} />
            <Text style={styles.countryLabel}>Pays cibles :</Text>
            <Text style={styles.countryValue}>
              {COUNTRY_OPTIONS.find((country) => country.code === selectedCountry)?.name ??
                "Tous les pays"}
            </Text>
            <Text style={styles.chevron}>{countryMenuOpen ? "⌃" : "⌄"}</Text>
          </Pressable>
          {countryMenuOpen && (
            <ScrollView
              nestedScrollEnabled
              style={styles.countryOptions}
              showsVerticalScrollIndicator
            >
              {COUNTRY_OPTIONS.map((country) => (
                <Pressable
                  accessibilityRole="button"
                  key={country.code}
                  onPress={() => {
                    setSelectedCountry(country.code);
                    setCountryMenuOpen(false);
                  }}
                  style={styles.countryOption}
                >
                  <Text
                    style={[
                      styles.countryOptionText,
                      selectedCountry === country.code &&
                        styles.countryOptionTextSelected,
                    ]}
                  >
                    {country.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <View style={styles.rangeNote}>
            <MapPin color="#64748b" size={14} />
            <Text style={styles.rangeText}>
              {selectedCountry === "ALL"
                ? "Portée locale : 0–100 km"
                : selectedCountry === "INT"
                  ? "Recherche internationale · prix affichés dans la devise du vendeur"
                  : `Affichage par pays : ${COUNTRY_OPTIONS.find((country) => country.code === selectedCountry)?.name ?? selectedCountry}`}
            </Text>
          </View>
          <View style={styles.internationalFilters}>
            <TextInput
              accessibilityLabel="Filtrer par ville"
              onChangeText={setCityQuery}
              placeholder="Ville (facultatif)"
              placeholderTextColor="#94a3b8"
              style={styles.internationalInput}
              value={cityQuery}
            />
            <View style={styles.languageOptions}>
              {[
                { code: "", label: "Toutes langues" },
                { code: "fr", label: "FR" },
                { code: "en", label: "EN" },
                { code: "pt", label: "PT" },
                { code: "ar", label: "AR" },
                { code: "sw", label: "SW" },
              ].map(({ code, label }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: languageCode === code }}
                  key={label}
                  onPress={() => setLanguageCode(code)}
                  style={[
                    styles.languageChip,
                    languageCode === code && styles.languageChipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.languageChipText,
                      languageCode === code && styles.languageChipTextSelected,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {marketSection === "explore" && (
            <ScrollView
              contentContainerStyle={styles.filters}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {[
                { id: "newest" as const, label: "Nouveautés" },
                { id: "promotions" as const, label: "Promotions" },
                { id: "popular" as const, label: "Populaires" },
              ].map(({ id, label }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: sortMode === id }}
                  key={id}
                  onPress={() => setSortMode(id)}
                  style={[
                    styles.filterChip,
                    sortMode === id && styles.filterChipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.filterText,
                      sortMode === id && styles.filterTextSelected,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>

        {locationError && (
          <Text accessibilityRole="alert" style={styles.loadError}>
            {locationError}
          </Text>
        )}
        {loadError && (
          <Text accessibilityRole="alert" style={styles.loadError}>
            {loadError}
          </Text>
        )}
        {marketSection !== "explore" && (
          <View style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Search color="#94a3b8" size={19} />
            <VoiceTextInput
              accessibilityLabel="Rechercher une boutique ou une opportunité"
              onChangeText={setSearchText}
              placeholder="Rechercher une boutique ou une opportunité"
              placeholderTextColor="#94a3b8"
              returnKeyType="search"
              style={styles.searchInput}
              value={searchText}
            />
          </View>
        )}
        {isLoading && (
          <View style={styles.loadingState}>
            <ActivityIndicator color="#2563eb" size="large" />
            <Text style={styles.loadingText}>Chargement du marché…</Text>
          </View>
        )}

        {marketSection === "explore" && activeTab === "Annonces" && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.searchBar}>
              <Search color="#94a3b8" size={19} />
              <VoiceTextInput
                accessibilityLabel="Rechercher un article"
                onChangeText={setSearchText}
                placeholder={`${t("search")}...`}
                placeholderTextColor="#94a3b8"
                returnKeyType="search"
                style={styles.searchInput}
                value={searchText}
              />
            </View>
            <ScrollView
              contentContainerStyle={styles.filters}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {LISTING_CATEGORIES.map((category) => {
                const isSelected = listingCategory === category;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={category}
                    onPress={() => setListingCategory(category)}
                    style={[
                      styles.filterChip,
                      isSelected && styles.filterChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        isSelected && styles.filterTextSelected,
                      ]}
                    >
                      {category}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.listingGrid}>
              {filteredItems.map(renderItemCard)}
              {!isLoading && !loadError && filteredItems.length === 0 && (
                <Text style={styles.emptyText}>
                  Aucun article ne correspond à votre recherche.
                </Text>
              )}
            </View>
            {comparedIds.length > 0 && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setCompareModalVisible(true)}
                style={styles.compareLaunchButton}
              >
                <Text style={styles.compareLaunchText}>
                  Comparer {comparedIds.length} produit{comparedIds.length > 1 ? "s" : ""}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {marketSection === "explore" && activeTab === "Local / Made in" && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.localBanner}>
              <View style={styles.flagIcon}>
                <Flag color="#15803d" size={23} />
              </View>
              <View style={styles.localBannerText}>
                <Text style={styles.localBannerTitle}>
                  Savoir-faire & Production Nationale
                </Text>
                <Text style={styles.localBannerSubtext}>
                  Découvrez les produits fabriqués près de chez vous.
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={openCreateForm}
              style={styles.localAddButton}
            >
              <Plus color="#15803d" size={18} />
              <Text style={styles.localAddText}>
                Ajouter un produit local (Made in)
              </Text>
            </Pressable>
            {filteredItems.map(renderItemCard)}
            {comparedIds.length > 0 && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setCompareModalVisible(true)}
                style={styles.compareLaunchButton}
              >
                <Text style={styles.compareLaunchText}>
                  Comparer {comparedIds.length} produit{comparedIds.length > 1 ? "s" : ""}
                </Text>
              </Pressable>
            )}
            {!isLoading && !loadError && filteredItems.length === 0 && (
              <Text style={styles.emptyText}>Aucun produit local disponible.</Text>
            )}
          </View>
        )}

        {marketSection === "explore" && activeTab === "Services & Métiers" && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.servicesInfo}>
              <View style={styles.servicesIcon}>
                <Wrench color="#2563eb" size={23} />
              </View>
              <View style={styles.servicesInfoCopy}>
                <Text style={styles.servicesInfoTitle}>
                  Services & Emplois de Quartier
                </Text>
                <Text style={styles.cardSubtext}>
                  Trouvez un électricien, maçon, boulanger, plombier, couturier
                  et plus encore.
                </Text>
                <View style={styles.servicesRange}>
                  <MapPin color="#2563eb" size={13} />
                  <Text style={styles.servicesRangeText}>
                    Portée de proximité : 0–100 km
                  </Text>
                </View>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={openCreateForm}
              style={styles.serviceAction}
            >
              <Plus color="#ffffff" size={18} />
              <Text style={styles.serviceActionText}>Proposer mes services</Text>
            </Pressable>
            <ScrollView
              contentContainerStyle={styles.filters}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {TRADE_CATEGORIES.map((category) => {
                const isSelected = tradeCategory === category;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    key={category}
                    onPress={() => setTradeCategory(category)}
                    style={[
                      styles.filterChip,
                      isSelected && styles.filterChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        isSelected && styles.filterTextSelected,
                      ]}
                    >
                      {category}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {filteredItems.map(renderItemCard)}
            {comparedIds.length > 0 && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setCompareModalVisible(true)}
                style={styles.compareLaunchButton}
              >
                <Text style={styles.compareLaunchText}>
                  Comparer {comparedIds.length} produit{comparedIds.length > 1 ? "s" : ""}
                </Text>
              </Pressable>
            )}
            {!isLoading && !loadError && filteredItems.length === 0 && (
              <Text style={styles.emptyText}>
                Aucun service trouvé dans cette catégorie.
              </Text>
            )}
          </View>
        )}
        {marketSection !== "explore" && (
          <MarketplaceCommercePanel
            city={cityQuery.trim()}
            countryCode={selectedCountry}
            initialSellerId={selectedSellerId}
            languageCode={languageCode}
            latitude={userLocation?.latitude}
            longitude={userLocation?.longitude}
            mode={marketSection}
            onOrderProduct={handleCommercePanelOrder}
            search={searchText}
          />
        )}
      </ScrollView>

      {marketSection === "explore" && (
      <Pressable
        accessibilityLabel={
          activeTab === "Annonces"
            ? "Ajouter une annonce"
            : activeTab === "Local / Made in"
              ? "Ajouter un produit local"
              : "Proposer un service"
        }
        accessibilityRole="button"
        onPress={openCreateForm}
        style={styles.fab}
      >
        <Plus color="#ffffff" size={27} />
      </Pressable>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => setIsCreateModalVisible(false)}
        transparent
        visible={isCreateModalVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.formModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {activeTab === "Annonces"
                  ? "Publier une annonce"
                  : activeTab === "Local / Made in"
                    ? "Publier un produit local"
                    : "Proposer un service"}
              </Text>
              <Pressable
                accessibilityLabel="Fermer le formulaire"
                accessibilityRole="button"
                onPress={() => setIsCreateModalVisible(false)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={21} />
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.formContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <VoiceTextInput
                accessibilityLabel="Titre de l’annonce"
                maxLength={150}
                onChangeText={setDraftTitle}
                placeholder="Titre"
                placeholderTextColor="#94a3b8"
                style={styles.formInput}
                value={draftTitle}
              />
              <VoiceTextInput
                accessibilityLabel="Description de l’annonce"
                multiline
                onChangeText={setDraftDescription}
                placeholder="Description"
                placeholderTextColor="#94a3b8"
                style={[styles.formInput, styles.descriptionInput]}
                value={draftDescription}
              />
              <Text style={styles.formLabel}>Catégorie</Text>
              <ScrollView
                contentContainerStyle={styles.formCategoryList}
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                {(activeTab === "Annonces"
                  ? LISTING_CATEGORIES.filter((category) => category !== "Tous")
                  : activeTab === "Services & Métiers"
                    ? TRADE_CATEGORIES.filter((category) => category !== "Tous")
                    : ["MADE_IN"]).map((category) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: draftCategory === category }}
                    key={category}
                    onPress={() => setDraftCategory(category)}
                    style={[
                      styles.filterChip,
                      draftCategory === category && styles.filterChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        draftCategory === category && styles.filterTextSelected,
                      ]}
                    >
                      {category}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              {activeTab === "Local / Made in" && (
                <>
                  <Text style={styles.formLabel}>Pays d'origine</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setCountryOriginModalVisible(true)}
                    style={styles.countryOriginButton}
                  >
                    <Text style={styles.countryOriginText}>
                      {MARKET_COUNTRIES.find(({ code }) => code === countryOfOrigin)?.name ??
                        countryOfOrigin}
                    </Text>
                    <ChevronRight color="#64748b" size={18} />
                  </Pressable>
                </>
              )}
              <Text style={styles.formLabel}>
                Devise · {draftCurrencyCode === "XOF" ? "FCFA" : draftCurrencyCode}
              </Text>
              <ScrollView
                contentContainerStyle={styles.formCategoryList}
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                {MARKET_CURRENCIES.map((currency) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: draftCurrencyCode === currency.code }}
                    key={currency.code}
                    onPress={() => setDraftCurrencyCode(currency.code)}
                    style={[
                      styles.filterChip,
                      draftCurrencyCode === currency.code && styles.filterChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        draftCurrencyCode === currency.code && styles.filterTextSelected,
                      ]}
                    >
                      {currency.code}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.formLabel}>Prix · {draftCurrencyCode === "XOF" ? "FCFA" : draftCurrencyCode}</Text>
              <TextInput
                accessibilityLabel={`Prix en ${draftCurrencyCode}`}
                editable={!isFreeListing}
                keyboardType="decimal-pad"
                onChangeText={setDraftPrice}
                placeholder="Ex. 5 000"
                placeholderTextColor="#94a3b8"
                style={[styles.formInput, isFreeListing && styles.disabledInput]}
                value={draftPrice}
              />
              {activeTab !== "Services & Métiers" && !isFreeListing && (
                <>
                  <Text style={styles.formLabel}>Promotion (facultatif, 30 jours)</Text>
                  <TextInput
                    accessibilityLabel="Prix promotionnel"
                    keyboardType="decimal-pad"
                    onChangeText={setDraftPromoPrice}
                    placeholder={`Prix réduit en ${draftCurrencyCode}`}
                    placeholderTextColor="#94a3b8"
                    style={styles.formInput}
                    value={draftPromoPrice}
                  />
                </>
              )}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isFreeListing }}
                onPress={() => {
                  setIsFreeListing((current) => !current);
                  setDraftPrice("");
                  setDraftPromoPrice("");
                }}
                style={styles.freeOption}
              >
                <View
                  style={[
                    styles.checkbox,
                    isFreeListing && styles.checkboxSelected,
                  ]}
                />
                <Text style={styles.formLabel}>Gratuit / Don</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void chooseListingImage()}
                style={styles.imagePickerButton}
              >
                {draftImage ? (
                  <Image
                    accessibilityLabel="Aperçu de la photo WebP"
                    source={{ uri: draftImage.uri }}
                    style={styles.draftImage}
                  />
                ) : (
                  <ImagePlus color="#2563eb" size={21} />
                )}
                <View style={styles.imagePickerCopy}>
                  <Text style={styles.imagePickerTitle}>
                    {draftImage ? "Changer la photo" : "Ajouter une photo"}
                  </Text>
                  <Text style={styles.imagePickerHint}>
                    WebP · moins de 300 Ko
                    {draftImage
                      ? ` · ${(draftImage.size / 1024).toFixed(0)} Ko`
                      : ""}
                  </Text>
                </View>
              </Pressable>
              {publishError ? (
                <View style={styles.publishError}>
                  <Text style={styles.publishErrorText}>{publishError}</Text>
                  {mediaTechnicalDetails ? (
                    <>
                      <Text selectable style={styles.mediaTechnicalDetails}>
                        {mediaTechnicalDetails}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        disabled={isPublishing}
                        onPress={() => void retryListingMedia()}
                        style={styles.retryMediaButton}
                      >
                        <Text style={styles.retryMediaText}>Réessayer le média</Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={isPublishing}
                onPress={() => void publishItem()}
                style={[
                  styles.publishButton,
                  isPublishing && styles.disabledButton,
                ]}
              >
                {isPublishing ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.publishButtonText}>{t("publish")}</Text>
                )}
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setCountryOriginModalVisible(false)}
        transparent
        visible={countryOriginModalVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.countryOriginModal}>
            <Text style={styles.modalTitle}>Pays d'origine</Text>
            <ScrollView>
              {MARKET_COUNTRIES.map((country) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: country.code === countryOfOrigin }}
                  key={country.code}
                  onPress={() => {
                    setCountryOfOrigin(country.code);
                    setCountryOriginModalVisible(false);
                  }}
                  style={styles.countryOriginOption}
                >
                  <Text style={styles.countryOriginText}>{country.name}</Text>
                  <Text style={styles.countryOriginCode}>{country.code}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedReportItem(null)}
        transparent
        visible={selectedReportItem !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.reportModal}>
            <View style={styles.modalHeader}>
              <View style={styles.reportIcon}>
                <AlertTriangle color="#b91c1c" size={20} />
              </View>
              <Text style={styles.modalTitle}>Signaler cette annonce</Text>
              <Pressable
                accessibilityLabel="Fermer le signalement"
                accessibilityRole="button"
                onPress={() => setSelectedReportItem(null)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={21} />
              </Pressable>
            </View>
            {selectedReportItem && (
              <Text style={styles.reportItemName}>
                {selectedReportItem.name}
              </Text>
            )}
            <VoiceTextInput
              accessibilityLabel="Motif du signalement"
              multiline
              onChangeText={setReportReason}
              placeholder="Précisez le motif du signalement"
              placeholderTextColor="#94a3b8"
              style={[styles.formInput, styles.descriptionInput]}
              value={reportReason}
            />
            <Pressable
              accessibilityRole="button"
              disabled={isSubmittingReport}
              onPress={() => void submitReport()}
              style={[
                styles.reportButton,
                isSubmittingReport && styles.disabledButton,
              ]}
            >
              {isSubmittingReport ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.publishButtonText}>Envoyer le signalement</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setOrderItem(null)}
        transparent
        visible={orderItem !== null}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.formModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Confirmer la commande</Text>
              <Pressable
                accessibilityLabel="Fermer la commande"
                accessibilityRole="button"
                onPress={() => setOrderItem(null)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={21} />
              </Pressable>
            </View>
            {orderItem && (
              <>
                <Text style={styles.reportItemName}>{orderItem.name}</Text>
                <Text style={styles.listingPrice}>{formatPrice(orderItem)}</Text>
                <Text style={styles.orderDisclaimer}>
                  La demande est envoyée au vendeur. QuartierPlus ne prélève ni ne conserve de fonds.
                </Text>
                <View style={styles.formCategoryList}>
                  {[
                    { value: "HOME_DELIVERY" as const, label: "Livraison à domicile" },
                    { value: "PICKUP" as const, label: "Retrait" },
                  ].map(({ value, label }) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: orderDeliveryMethod === value }}
                      key={value}
                      onPress={() => setOrderDeliveryMethod(value)}
                      style={[
                        styles.filterChip,
                        orderDeliveryMethod === value && styles.filterChipSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterText,
                          orderDeliveryMethod === value && styles.filterTextSelected,
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {orderDeliveryMethod === "HOME_DELIVERY" && (
                  <>
                    <TextInput
                      accessibilityLabel="Adresse de livraison"
                      onChangeText={setOrderAddress}
                      placeholder="Adresse de livraison"
                      placeholderTextColor="#94a3b8"
                      style={styles.formInput}
                      value={orderAddress}
                    />
                    <TextInput
                      accessibilityLabel="Ville de livraison"
                      onChangeText={setOrderCity}
                      placeholder="Ville"
                      placeholderTextColor="#94a3b8"
                      style={styles.formInput}
                      value={orderCity}
                    />
                  </>
                )}
                <TextInput
                  accessibilityLabel="Note pour le vendeur"
                  multiline
                  maxLength={1000}
                  onChangeText={setOrderNote}
                  placeholder="Note pour le vendeur (facultatif)"
                  placeholderTextColor="#94a3b8"
                  style={[styles.formInput, styles.descriptionInput]}
                  value={orderNote}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={isCreatingOrder}
                  onPress={() => void submitMarketplaceOrder()}
                  style={[
                    styles.publishButton,
                    isCreatingOrder && styles.disabledButton,
                  ]}
                >
                  {isCreatingOrder ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.publishButtonText}>Envoyer la commande</Text>
                  )}
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setCompareModalVisible(false)}
        transparent
        visible={compareModalVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.compareModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Comparateur</Text>
              <Pressable
                accessibilityLabel="Fermer le comparateur"
                accessibilityRole="button"
                onPress={() => setCompareModalVisible(false)}
                style={styles.closeButton}
              >
                <X color="#64748b" size={21} />
              </Pressable>
            </View>
            <Text style={styles.compareNote}>
              Les prix restent dans leur devise d’origine et ne sont pas convertis.
            </Text>
            <ScrollView contentContainerStyle={styles.compareList}>
              {compareItems.map((item) => (
                <View key={item.id} style={styles.compareRow}>
                  <Text style={styles.compareName}>{item.name}</Text>
                  <Text style={styles.comparePrice}>{formatPrice(item)}</Text>
                  <Text style={styles.compareDetail}>Catégorie : {item.category}</Text>
                  <Text style={styles.compareDetail}>Vendeur : {item.seller}</Text>
                  <Text style={styles.compareDetail}>
                    Réputation : ★ {item.sellerRating.toFixed(1)} ({item.sellerReviewCount} avis)
                  </Text>
                  <Text style={styles.compareDetail}>
                    Provenance : {item.countryCode ?? item.countryOfOrigin ?? "Non renseignée"}
                    {item.location ? ` · ${item.location}` : ""}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => toggleComparedItem(item)}
                    style={styles.removeComparedButton}
                  >
                    <Text style={styles.removeComparedText}>Retirer</Text>
                  </Pressable>
                </View>
              ))}
              {compareItems.length === 0 && (
                <Text style={styles.emptyText}>Sélectionnez des produits à comparer.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#f5f7fa",
    flex: 1,
  },
  content: {
    paddingBottom: 112,
    paddingHorizontal: 20,
    paddingTop: 58,
  },
  loadingState: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 14,
    gap: 10,
    marginBottom: 15,
    paddingVertical: 24,
  },
  loadingText: {
    color: "#64748b",
    fontSize: 12,
  },
  loadError: {
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    color: "#b91c1c",
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
    padding: 11,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 11,
    marginBottom: 21,
  },
  wholesalerEntry: {
    alignItems: "center",
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  compareLaunchButton: {
    alignItems: "center",
    backgroundColor: "#1d4ed8",
    borderRadius: 10,
    marginTop: 6,
    minHeight: 42,
    justifyContent: "center",
  },
  compareLaunchText: { color: "#ffffff", fontSize: 12, fontWeight: "800" },
  wholesalerEntryCopy: { flex: 1 },
  wholesalerEntryTitle: { fontSize: 13, fontWeight: "800" },
  wholesalerEntrySubtitle: { fontSize: 11, marginTop: 2 },
  marketSections: { gap: 7, marginBottom: 13 },
  marketSectionButton: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  marketSectionText: { fontSize: 11, fontWeight: "700" },
  headerIcon: {
    alignItems: "center",
    backgroundColor: "#dbeafe",
    borderRadius: 12,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  title: {
    color: "#172b4d",
    fontSize: 25,
    fontWeight: "700",
  },
  sellerRating: { color: "#a16207", fontSize: 9, marginTop: 5 },
  cardActions: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 8 },
  compareButton: {
    alignItems: "center",
    borderColor: "#bfdbfe",
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 30,
    paddingHorizontal: 7,
  },
  compareButtonSelected: { backgroundColor: "#dbeafe" },
  compareButtonText: { color: "#1d4ed8", fontSize: 9, fontWeight: "700" },
  compareButtonTextSelected: { color: "#1e40af" },
  orderButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 7,
    justifyContent: "center",
    minHeight: 30,
    paddingHorizontal: 7,
  },
  orderButtonText: { color: "#ffffff", fontSize: 9, fontWeight: "800" },
  storeButton: { alignItems: "center", flexDirection: "row", gap: 4, marginTop: 7, minHeight: 25 },
  storeButtonText: { color: "#2563eb", fontSize: 9, fontWeight: "700" },
  tabs: {
    gap: 8,
    paddingBottom: 16,
  },
  tab: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 11,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  tabSelected: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  tabText: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "600",
  },
  tabTextSelected: {
    color: "#ffffff",
  },
  countryContainer: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 21,
    padding: 13,
  },
  countrySelector: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 26,
  },
  countryLabel: {
    color: "#475569",
    fontSize: 13,
  },
  countryValue: {
    color: "#172b4d",
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  chevron: {
    color: "#64748b",
    fontSize: 18,
    paddingHorizontal: 5,
  },
  countryOptions: {
    borderTopColor: "#e2e8f0",
    borderTopWidth: 1,
    maxHeight: 240,
    marginTop: 10,
  },
  countryOption: {
    paddingVertical: 10,
  },
  countryOptionText: {
    color: "#475569",
    fontSize: 14,
  },
  countryOptionTextSelected: {
    color: "#2563eb",
    fontWeight: "700",
  },
  rangeNote: {
    alignItems: "center",
    borderTopColor: "#f1f5f9",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
  },
  rangeText: {
    color: "#64748b",
    fontSize: 11,
  },
  internationalFilters: { gap: 9, marginTop: 12 },
  internationalInput: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 10,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 13,
    minHeight: 40,
    paddingHorizontal: 11,
  },
  languageOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  languageChip: {
    borderColor: "#e2e8f0",
    borderRadius: 15,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  languageChipSelected: { backgroundColor: "#dbeafe", borderColor: "#bfdbfe" },
  languageChipText: { color: "#475569", fontSize: 10, fontWeight: "700" },
  languageChipTextSelected: { color: "#1d4ed8" },
  section: {
    gap: 13,
  },
  searchBar: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  searchInput: {
    color: "#172b4d",
    flex: 1,
    fontSize: 14,
    paddingVertical: 10,
  },
  filters: {
    gap: 8,
  },
  filterChip: {
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterChipSelected: {
    backgroundColor: "#dbeafe",
    borderColor: "#bfdbfe",
  },
  filterText: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "600",
  },
  filterTextSelected: {
    color: "#1d4ed8",
  },
  listingGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  listingCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    overflow: "hidden",
    width: "48%",
  },
  listingImage: {
    alignItems: "center",
    backgroundColor: "#eaf1fb",
    height: 108,
    justifyContent: "center",
  },
  listingPhoto: {
    height: "100%",
    width: "100%",
  },
  listingBody: {
    padding: 11,
  },
  listingName: {
    color: "#172b4d",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  listingPrice: {
    color: "#15803d",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 6,
  },
  originalPrice: {
    color: "#64748b",
    fontSize: 10,
    textDecorationLine: "line-through",
  },
  promotionBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#fef3c7",
    borderRadius: 5,
    color: "#92400e",
    fontSize: 9,
    fontWeight: "800",
    marginTop: 4,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  locationRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    marginTop: 6,
  },
  locationText: {
    color: "#64748b",
    fontSize: 11,
  },
  sellerRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 8,
  },
  sellerText: {
    color: "#475569",
    flexShrink: 1,
    fontSize: 10,
  },
  sellerBadge: {
    alignItems: "center",
    backgroundColor: "#dcfce7",
    borderRadius: 5,
    flexDirection: "row",
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  sellerBadgeText: {
    color: "#15803d",
    fontSize: 9,
    fontWeight: "700",
  },
  allySellerButton: {
    alignSelf: "flex-start",
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  allySellerText: { color: "#1d4ed8", fontSize: 11, fontWeight: "700" },
  contactButton: {
    alignItems: "center",
    backgroundColor: "#16a34a",
    borderRadius: 9,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 35,
  },
  contactButtonText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
  },
  reportListingButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 26,
  },
  reportListingText: {
    color: "#b91c1c",
    fontSize: 9,
    fontWeight: "700",
  },
  emptyText: {
    color: "#64748b",
    fontSize: 13,
    paddingVertical: 10,
  },
  localBanner: {
    alignItems: "center",
    backgroundColor: "#ecfdf5",
    borderColor: "#bbf7d0",
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 15,
  },
  flagIcon: {
    alignItems: "center",
    backgroundColor: "#dcfce7",
    borderRadius: 12,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  localBannerText: {
    flex: 1,
  },
  localBannerTitle: {
    color: "#14532d",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 19,
  },
  localBannerSubtext: {
    color: "#4b7b5d",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  localAddButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#86efac",
    borderRadius: 11,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 45,
  },
  localAddText: {
    color: "#15803d",
    fontSize: 12,
    fontWeight: "700",
  },
  productCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  productIcon: {
    alignItems: "center",
    backgroundColor: "#ecfdf5",
    borderRadius: 12,
    height: 46,
    justifyContent: "center",
    width: 46,
  },
  productCopy: {
    flex: 1,
  },
  cardSubtext: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  madeInBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#ecfdf5",
    borderRadius: 6,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  madeInText: {
    color: "#15803d",
    fontSize: 10,
    fontWeight: "700",
  },
  servicesInfo: {
    backgroundColor: "#ffffff",
    borderColor: "#dbeafe",
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 15,
  },
  servicesIcon: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 12,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  servicesInfoCopy: {
    flex: 1,
  },
  servicesInfoTitle: {
    color: "#172b4d",
    fontSize: 14,
    fontWeight: "700",
  },
  servicesRange: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    marginTop: 8,
  },
  servicesRangeText: {
    color: "#2563eb",
    fontSize: 11,
    fontWeight: "600",
  },
  serviceAction: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 11,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 45,
  },
  serviceActionText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  serviceCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  providerAvatar: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 23,
    height: 46,
    justifyContent: "center",
    width: 46,
  },
  providerCopy: {
    flex: 1,
  },
  providerTrade: {
    color: "#2563eb",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 3,
  },
  providerMeta: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 5,
  },
  distanceText: {
    color: "#172b4d",
    fontSize: 11,
    fontWeight: "700",
  },
  fab: {
    alignItems: "center",
    backgroundColor: "#16a34a",
    borderColor: "#ffffff",
    borderRadius: 31,
    borderWidth: 3,
    bottom: 24,
    elevation: 6,
    height: 62,
    justifyContent: "center",
    position: "absolute",
    right: 20,
    shadowColor: "#14532d",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    width: 62,
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.55)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  formModal: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    maxHeight: "88%",
    maxWidth: 480,
    padding: 18,
    width: "100%",
  },
  reportModal: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    maxWidth: 440,
    padding: 18,
    width: "100%",
  },
  modalHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
    marginBottom: 12,
  },
  orderDisclaimer: {
    backgroundColor: "#eff6ff",
    borderRadius: 9,
    color: "#1e3a8a",
    fontSize: 11,
    lineHeight: 17,
    padding: 10,
  },
  compareModal: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    maxHeight: "88%",
    padding: 18,
    width: "100%",
  },
  compareNote: { color: "#64748b", fontSize: 11, marginBottom: 10 },
  compareList: { gap: 10, paddingBottom: 12 },
  compareRow: { backgroundColor: "#f8fafc", borderRadius: 11, gap: 5, padding: 12 },
  compareName: { color: "#172b4d", fontSize: 14, fontWeight: "800" },
  comparePrice: { color: "#15803d", fontSize: 13, fontWeight: "800" },
  compareDetail: { color: "#475569", fontSize: 11, lineHeight: 16 },
  removeComparedButton: { alignSelf: "flex-start", paddingVertical: 5 },
  removeComparedText: { color: "#b91c1c", fontSize: 11, fontWeight: "700" },
  modalTitle: {
    color: "#172b4d",
    flex: 1,
    fontSize: 17,
    fontWeight: "800",
  },
  closeButton: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  formContent: {
    gap: 12,
    paddingBottom: 8,
  },
  formInput: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 11,
    borderWidth: 1,
    color: "#172b4d",
    fontSize: 13,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  descriptionInput: {
    minHeight: 90,
    textAlignVertical: "top",
  },
  formLabel: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "700",
  },
  countryOriginButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e1",
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 46,
    paddingHorizontal: 12,
  },
  countryOriginText: { color: "#334155", fontSize: 14 },
  countryOriginCode: { color: "#64748b", fontSize: 12, fontWeight: "700" },
  countryOriginModal: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    maxHeight: "80%",
    padding: 20,
    width: "90%",
  },
  countryOriginOption: {
    alignItems: "center",
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  formCategoryList: {
    gap: 7,
    paddingVertical: 2,
  },
  disabledInput: {
    opacity: 0.5,
  },
  freeOption: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 8,
    paddingVertical: 3,
  },
  checkbox: {
    borderColor: "#94a3b8",
    borderRadius: 5,
    borderWidth: 1,
    height: 19,
    width: 19,
  },
  checkboxSelected: {
    backgroundColor: "#16a34a",
    borderColor: "#16a34a",
  },
  imagePickerButton: {
    alignItems: "center",
    backgroundColor: "#eff6ff",
    borderColor: "#bfdbfe",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 62,
    padding: 9,
  },
  draftImage: {
    borderRadius: 8,
    height: 44,
    width: 58,
  },
  imagePickerCopy: {
    flex: 1,
  },
  imagePickerTitle: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "800",
  },
  imagePickerHint: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 3,
  },
  publishButton: {
    alignItems: "center",
    backgroundColor: "#16a34a",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 46,
  },
  publishButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
  },
  disabledButton: {
    opacity: 0.6,
  },
  reportIcon: {
    alignItems: "center",
    backgroundColor: "#fef2f2",
    borderRadius: 11,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  reportItemName: {
    color: "#475569",
    fontSize: 12,
    marginBottom: 10,
  },
  reportButton: {
    alignItems: "center",
    backgroundColor: "#b91c1c",
    borderRadius: 11,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 44,
  },
  publishError: {
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    gap: 8,
    padding: 12,
  },
  publishErrorText: { color: "#991b1b", fontSize: 13, lineHeight: 19 },
  mediaTechnicalDetails: { color: "#475569", fontSize: 11, lineHeight: 16 },
  retryMediaButton: { alignSelf: "flex-start", paddingVertical: 6 },
  retryMediaText: { color: "#1d4ed8", fontSize: 13, fontWeight: "700" },
});
