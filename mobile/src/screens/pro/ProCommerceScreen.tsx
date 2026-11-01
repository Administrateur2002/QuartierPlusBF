import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { io, type Socket } from "socket.io-client";
import api, { API_BASE_URL, getStoredAuthToken, subscribeToNetwork } from "../../services/api";
import { getApiErrorMessage } from "../../services/apiError";
import { getQueuedProOrders, submitProOrder, syncQueuedProOrders } from "../../services/proCommerceOffline";
import { requestProDeliveryPermissions, startProDeliveryTracking, stopProDeliveryTracking } from "../../services/proCommerceTracking";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { uploadProProductPhoto } from "../../services/uploadProProductPhoto";

type Tier = { min_quantity: number | string; unit_price: number | string };
type Product = {
  id: string;
  wholesaler_id: string;
  name: string;
  photo_url: string | null;
  unit: string;
  unit_price: number | string;
  stock: number | string;
  min_order_quantity: number | string;
  delivery_days: number;
  price_tiers: Tier[];
  business_name: string;
};
type Wholesaler = {
  id: string;
  business_name: string;
  description: string;
  delivery_zone: string;
  catalog_slug: string;
  rccm_number?: string | null;
  ifu_number?: string | null;
  rccm_status?: string;
  ifu_status?: string;
};
type ProOrder = {
  id: string;
  buyer_id: string;
  wholesaler_id: string;
  deliverer_id: string | null;
  status: string;
  total: number | string;
  payment_method: "PAY_ON_DELIVERY" | "DIRECT_DEPOSIT";
  payment_status: string;
  address: string;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  business_name: string;
};
type OrderDetails = {
  order: ProOrder;
  items: { id: string; product_name: string; quantity: number; unit: string; unit_price: number; line_total: number }[];
  events: { status: string; note: string; created_at: string }[];
  location: { latitude: number; longitude: number; accuracy_meters: number } | null;
  handoff_code: string | null;
};
type Mode = "catalog" | "orders" | "wholesaler";

const BURKINA_DELIVERY_CITIES = [
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

const catalogSlugPreview = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "grossiste";

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Reçue",
  ACCEPTED: "Acceptée",
  PREPARED: "Préparée",
  IN_TRANSIT: "En route",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};
const money = (value: number | string) => `${Number(value).toLocaleString("fr-FR")} FCFA`;
const tierPrice = (product: Product, quantity: number) => {
  const tier = [...(product.price_tiers ?? [])]
    .filter((entry) => Number(entry.min_quantity) <= quantity)
    .sort((left, right) => Number(right.min_quantity) - Number(left.min_quantity))[0];
  return Number(tier?.unit_price ?? product.unit_price);
};
const distanceKm = (leftLat: number, leftLon: number, rightLat: number, rightLon: number) => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = radians(rightLat - leftLat);
  const deltaLon = radians(rightLon - leftLon);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(leftLat)) * Math.cos(radians(rightLat)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

export default function ProCommerceScreen() {
  const { user, requestAuthentication } = useAuth();
  const { colors } = useTheme();
  const [mode, setMode] = useState<Mode>("catalog");
  const [products, setProducts] = useState<Product[]>([]);
  const [wholesalers, setWholesalers] = useState<Wholesaler[]>([]);
  const [myWholesaler, setMyWholesaler] = useState<Wholesaler | null>(null);
  const [hasWholesalerEntitlement, setHasWholesalerEntitlement] = useState(false);
  const [managedProducts, setManagedProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<ProOrder[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartWholesalerId, setCartWholesalerId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [deliveryCoordinates, setDeliveryCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<ProOrder["payment_method"]>("PAY_ON_DELIVERY");
  const [selectedOrder, setSelectedOrder] = useState<OrderDetails | null>(null);
  const [deliveryPoint, setDeliveryPoint] = useState<OrderDetails["location"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [deliveryZone, setDeliveryZone] = useState("");
  const [rccmNumber, setRccmNumber] = useState("");
  const [ifuNumber, setIfuNumber] = useState("");
  const [zonePickerOpen, setZonePickerOpen] = useState(false);
  const [productName, setProductName] = useState("");
  const [productUnit, setProductUnit] = useState("sac");
  const [productPrice, setProductPrice] = useState("");
  const [productStock, setProductStock] = useState("");
  const [productMinimum, setProductMinimum] = useState("1");
  const [tierMinimum, setTierMinimum] = useState("");
  const [tierPriceValue, setTierPriceValue] = useState("");
  const [delivererPhone, setDelivererPhone] = useState("");
  const [productPhotoId, setProductPhotoId] = useState<string | null>(null);
  const [handoffCode, setHandoffCode] = useState("");

  const refresh = async () => {
    setError(null);
    try {
      const [catalogResponse, productsResponse] = await Promise.all([
        api.get<{ wholesalers: Wholesaler[] }>("/v1/pro-commerce/wholesalers"),
        api.get<{ products: Product[] }>("/v1/pro-commerce/products"),
      ]);
      setWholesalers(catalogResponse.data.wholesalers);
      setProducts(productsResponse.data.products);
      if (user) {
        const [ordersResponse, queued, ownProfile, subscriptionResponse] = await Promise.all([
          api.get<{ orders: ProOrder[] }>("/v1/pro-commerce/orders"),
          getQueuedProOrders(),
          api.get<{ wholesaler: Wholesaler | null }>("/v1/pro-commerce/wholesalers/me"),
          api.get<{ active_spaces?: unknown }>("/v1/pro/me/subscription", {
            headers: { "Cache-Control": "no-cache" },
          }),
        ]);
        const hasManagementAccess =
          Array.isArray(subscriptionResponse.data.active_spaces) &&
          subscriptionResponse.data.active_spaces.includes("WHOLESALER");
        setHasWholesalerEntitlement(hasManagementAccess);
        setOrders(ordersResponse.data.orders);
        setQueuedCount(queued.length);
        setMyWholesaler(ownProfile.data.wholesaler);
        if (ownProfile.data.wholesaler) {
          setBusinessName(ownProfile.data.wholesaler.business_name);
          setDeliveryZone(ownProfile.data.wholesaler.delivery_zone);
          setRccmNumber(ownProfile.data.wholesaler.rccm_number ?? "");
          setIfuNumber(ownProfile.data.wholesaler.ifu_number ?? "");
          if (hasManagementAccess) {
            const ownProducts = await api.get<{ products: Product[] }>(
              `/v1/pro-commerce/wholesalers/${ownProfile.data.wholesaler.id}/manage-products`,
            );
            setManagedProducts(ownProducts.data.products);
          } else {
            setManagedProducts([]);
          }
        } else {
          setManagedProducts([]);
        }
      } else {
        setMyWholesaler(null);
        setHasWholesalerEntitlement(false);
        setManagedProducts([]);
      }
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Impossible de charger le catalogue Pro."));
    }
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeToNetwork((online) => {
      if (!online || !user) return;
      void syncQueuedProOrders().then(refresh).catch((syncError: unknown) => {
        setError(getApiErrorMessage(syncError, "La synchronisation des commandes a échoué."));
      });
    });
    return unsubscribe;
  }, [user?.id]);

  useEffect(() => {
    if (!selectedOrder?.order.id || selectedOrder.order.status !== "IN_TRANSIT" || !API_BASE_URL) return;
    let socket: Socket | null = null;
    let active = true;
    void getStoredAuthToken().then((token) => {
      if (!active || !token) return;
      socket = io(API_BASE_URL, { auth: { token }, transports: ["websocket"], reconnection: true });
      socket.emit("pro:order:join", { order_id: selectedOrder.order.id });
      socket.on("pro:delivery:location", (point: OrderDetails["location"] & { order_id: string }) => {
        if (point?.order_id === selectedOrder.order.id) setDeliveryPoint(point);
      });
      socket.on("pro:order:status", (event: { order_id: string; status: string }) => {
        if (event.order_id !== selectedOrder.order.id) return;
        if (event.status !== "IN_TRANSIT" && selectedOrder.order.deliverer_id === user?.id) {
          void stopProDeliveryTracking();
        }
        void refresh();
        void loadOrder(selectedOrder.order.id);
      });
    });
    return () => {
      active = false;
      socket?.emit("pro:order:leave", { order_id: selectedOrder.order.id });
      socket?.disconnect();
    };
  }, [selectedOrder?.order.id, selectedOrder?.order.status, user?.id]);

  const cartItems = useMemo(
    () => Object.entries(cart).flatMap(([productId, quantity]) => {
      const product = products.find((entry) => entry.id === productId);
      return product && quantity > 0 ? [{ product, quantity, unitPrice: tierPrice(product, quantity) }] : [];
    }),
    [cart, products],
  );
  const cartTotal = cartItems.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
  const activeWholesaler = wholesalers.find((entry) => entry.id === cartWholesalerId);
  const ownOrders = orders.filter((order) => order.buyer_id === user?.id);
  const sellerOrders = hasWholesalerEntitlement
    ? orders.filter((order) => order.business_name && order.buyer_id !== user?.id)
    : [];

  const loadOrder = async (orderId: string) => {
    try {
      const response = await api.get<OrderDetails>(`/v1/pro-commerce/orders/${orderId}`);
      setSelectedOrder(response.data);
      setDeliveryPoint(response.data.location);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Impossible de charger la commande."));
    }
  };

  const requireUser = () => {
    if (user) return true;
    requestAuthentication();
    return false;
  };

  const addToCart = (product: Product) => {
    if (!requireUser()) return;
    if (cartWholesalerId && cartWholesalerId !== product.wholesaler_id) {
      Alert.alert("Un grossiste par commande", "Validez ou videz d’abord votre panier actuel.");
      return;
    }
    setCartWholesalerId(product.wholesaler_id);
    setCart((current) => ({ ...current, [product.id]: (current[product.id] ?? 0) + Number(product.min_order_quantity) }));
  };

  const updateCartQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      setCart((current) => {
        const next = { ...current };
        delete next[productId];
        if (Object.keys(next).length === 0) setCartWholesalerId(null);
        return next;
      });
    } else {
      setCart((current) => ({ ...current, [productId]: quantity }));
    }
  };

  const placeOrder = async () => {
    if (!requireUser()) return;
    if (!cartWholesalerId || cartItems.length === 0 || !address.trim()) {
      Alert.alert("Commande incomplète", "Ajoutez un article et renseignez l’adresse de livraison.");
      return;
    }
    setBusy(true);
    try {
      const result = await submitProOrder({
        wholesaler_id: cartWholesalerId,
        items: cartItems.map(({ product, quantity }) => ({ product_id: product.id, quantity })),
        payment_method: paymentMethod,
        address: address.trim(),
        ...(deliveryCoordinates ?? {}),
      });
      setCart({});
      setCartWholesalerId(null);
      if (result.queued) {
        setQueuedCount((count) => count + 1);
        Alert.alert("Commande enregistrée", "Elle sera envoyée automatiquement au retour du réseau.");
      } else {
        Alert.alert("Commande reçue", "Aucun paiement n’a été prélevé par QuartierPlus.");
      }
      await refresh();
    } catch (requestError) {
      Alert.alert("Commande impossible", getApiErrorMessage(requestError, "Vérifiez votre connexion et les informations de commande."));
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (orderId: string) => {
    try {
      await api.post(`/v1/pro-commerce/orders/${orderId}/reorder`);
      await refresh();
      Alert.alert("Nouvelle commande créée", "Les quantités et prix actuels ont été recalculés.");
    } catch (requestError) {
      Alert.alert("Recommande indisponible", getApiErrorMessage(requestError, "Les produits ne sont plus disponibles."));
    }
  };

  const cancelOrder = async (orderId: string) => {
    try {
      await api.post(`/v1/pro-commerce/orders/${orderId}/cancel`);
      await refresh();
    } catch (requestError) {
      Alert.alert("Annulation impossible", getApiErrorMessage(requestError, "La commande a peut-être déjà été préparée."));
    }
  };

  const changeStatus = async (order: ProOrder, status: string) => {
    try {
      await api.patch(`/v1/pro-commerce/orders/${order.id}/status`, { status });
      await refresh();
    } catch (requestError) {
      Alert.alert("Statut non modifié", getApiErrorMessage(requestError, "Vérifiez votre rôle sur cette commande."));
    }
  };

  const confirmDirectDeposit = async (order: ProOrder) => {
    try {
      await api.patch(`/v1/pro-commerce/orders/${order.id}/payment-status`, { payment_status: "DEPOSIT_PAID" });
      await refresh();
    } catch (requestError) {
      Alert.alert("Acompte non confirmé", getApiErrorMessage(requestError, "Vérifiez votre rôle sur cette commande."));
    }
  };

  const downloadReceipt = async (orderId: string) => {
    try {
      if (!API_BASE_URL) throw new Error("L’adresse du serveur n’est pas configurée.");
      const token = await getStoredAuthToken();
      if (!token) throw new Error("Connectez-vous pour télécharger le reçu.");
      const file = await File.downloadFileAsync(
        `${API_BASE_URL}/v1/pro-commerce/orders/${orderId}/receipt.pdf`,
        new File(Paths.cache, `quartierplus-pro-${orderId}.pdf`),
        { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
      );
      if (!(await Sharing.isAvailableAsync())) throw new Error("Le partage de fichiers n’est pas disponible sur cet appareil.");
      await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: "Reçu QuartierPlus Pro" });
    } catch (downloadError) {
      Alert.alert("Reçu indisponible", downloadError instanceof Error ? downloadError.message : "Impossible de télécharger le reçu PDF.");
    }
  };

  const startDelivery = (order: ProOrder) => {
    if (!requireUser()) return;
    Alert.alert(
      "Démarrer la livraison",
      "Avec votre accord, votre position sera partagée uniquement avec le commerçant et le grossiste pendant cette livraison. Le suivi s’arrête dès la remise ou l’annulation.",
      [
        { text: "Pas maintenant", style: "cancel" },
        {
          text: "J’accepte et je démarre",
          onPress: () => void (async () => {
            try {
              await requestProDeliveryPermissions();
              await api.patch(`/v1/pro-commerce/orders/${order.id}/status`, { status: "IN_TRANSIT" });
              await startProDeliveryTracking(order.id);
              await refresh();
              await loadOrder(order.id);
            } catch (trackingError) {
              Alert.alert("Suivi non démarré", trackingError instanceof Error ? trackingError.message : "Vérifiez les autorisations de localisation.");
            }
          })(),
        },
      ],
    );
  };

  const confirmDelivery = async (order: ProOrder) => {
    if (!/^\d{6}$/.test(handoffCode)) {
      Alert.alert("Code invalide", "Saisissez les 6 chiffres communiqués par le commerçant.");
      return;
    }
    try {
      await api.post(`/v1/pro-commerce/orders/${order.id}/deliver`, { code: handoffCode });
      setHandoffCode("");
      await stopProDeliveryTracking();
      await refresh();
      await loadOrder(order.id);
    } catch (requestError) {
      Alert.alert("Remise non validée", getApiErrorMessage(requestError, "Le code de remise est incorrect."));
    }
  };

  const createWholesalerProfile = async () => {
    if (!requireUser()) return;
    try {
      const response = await api.post<{ wholesaler: Wholesaler }>("/v1/pro-commerce/wholesalers", {
        business_name: businessName.trim(),
        delivery_zone: deliveryZone.trim(),
        rccm_number: rccmNumber.trim() || undefined,
        ifu_number: ifuNumber.trim() || undefined,
      });
      await refresh();
      setMyWholesaler(response.data.wholesaler);
      Alert.alert("Profil créé", "Le catalogue sera public après la vérification RCCM et IFU.");
      setBusinessName(response.data.wholesaler.business_name);
      setDeliveryZone(response.data.wholesaler.delivery_zone);
      setRccmNumber(response.data.wholesaler.rccm_number ?? "");
      setIfuNumber(response.data.wholesaler.ifu_number ?? "");
    } catch (requestError) {
      Alert.alert("Profil non créé", getApiErrorMessage(requestError, "Vérifiez le nom, la zone et le lien du catalogue."));
    }
  };

  const addProduct = async () => {
    if (!myWholesaler || !productName.trim()) {
      Alert.alert("Profil grossiste requis", "Créez ou actualisez d’abord votre profil grossiste.");
      return;
    }
    try {
      const tiers = tierMinimum && tierPriceValue
        ? [{ min_quantity: Number(tierMinimum), unit_price: Number(tierPriceValue) }]
        : [];
      await api.post(`/v1/pro-commerce/wholesalers/${myWholesaler.id}/products`, {
        name: productName.trim(), unit: productUnit.trim(), unit_price: Number(productPrice),
        stock: Number(productStock), min_order_quantity: Number(productMinimum), delivery_days: 1,
        price_tiers: tiers,
        ...(productPhotoId ? { photo_public_id: productPhotoId } : {}),
      });
      setProductName("");
      setProductPrice("");
      setProductStock("");
      setProductPhotoId(null);
      setTierMinimum("");
      setTierPriceValue("");
      await refresh();
    } catch (requestError) {
      Alert.alert("Produit non ajouté", getApiErrorMessage(requestError, "Vérifiez le prix et le stock."));
    }
  };

  const chooseProductPhoto = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error("Autorisez l’accès à la photothèque pour ajouter une photo.");
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      if (result.canceled || !result.assets[0]?.uri) return;
      const publicId = await uploadProProductPhoto(result.assets[0].uri);
      setProductPhotoId(publicId);
    } catch (photoError) {
      Alert.alert("Photo non téléversée", photoError instanceof Error ? photoError.message : "Vérifiez votre connexion et la configuration Cloudinary.");
    }
  };

  const shareCatalog = async () => {
    if (!myWholesaler || myWholesaler.rccm_status !== "VERIFIED" || myWholesaler.ifu_status !== "VERIFIED") {
      Alert.alert("Catalogue indisponible", "Le grossiste doit d’abord être vérifié avant de partager son catalogue.");
      return;
    }
    const url = `${API_BASE_URL ?? ""}/v1/pro-commerce/wholesalers/${myWholesaler.catalog_slug}`;
    await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(`Catalogue ${myWholesaler.business_name} : ${url}`)}`);
  };

  const inviteDeliverer = async () => {
    if (!myWholesaler) return;
    try {
      await api.post(`/v1/pro-commerce/wholesalers/${myWholesaler.id}/members`, { phone_number: delivererPhone.trim(), role: "DELIVERER" });
      setDelivererPhone("");
      Alert.alert("Livreur invité", "Le compte QuartierPlus associé à ce numéro peut maintenant prendre les commandes prêtes.");
    } catch (inviteError) {
      Alert.alert("Invitation impossible", getApiErrorMessage(inviteError, "Vérifiez le numéro E.164 et le compte du livreur."));
    }
  };

  const favorite = async (wholesalerId: string) => {
    if (!requireUser()) return;
    try {
      await api.post(`/v1/pro-commerce/favorites/${wholesalerId}`);
    } catch (requestError) {
      Alert.alert("Favori non enregistré", getApiErrorMessage(requestError, "Réessayez lorsque le réseau sera disponible."));
    }
  };

  const renderOrder = (order: ProOrder, buyerOrder: boolean) => (
    <View key={order.id} style={[styles.orderRow, { borderBottomColor: colors.border }]}>
      <Pressable onPress={() => void loadOrder(order.id)} style={styles.orderInfo}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{order.business_name || "Commande grossiste"}</Text>
        <Text style={[styles.muted, { color: colors.secondaryText }]}>{STATUS_LABELS[order.status] ?? order.status} · {money(order.total)}</Text>
        <Text style={[styles.muted, { color: colors.secondaryText }]}>{order.payment_method === "DIRECT_DEPOSIT" ? `Acompte direct · ${order.payment_status === "DEPOSIT_PAID" ? "confirmé par le grossiste" : "à régler au grossiste"}` : "Paiement à la livraison"}</Text>
      </Pressable>
      {buyerOrder && ["RECEIVED", "ACCEPTED"].includes(order.status) && <IconButton label="Annuler" onPress={() => void cancelOrder(order.id)} colors={colors} />}
      {buyerOrder && order.status === "DELIVERED" && <IconButton label="Recommander" onPress={() => void reorder(order.id)} colors={colors} />}
      {!buyerOrder && order.status === "RECEIVED" && <IconButton label="Accepter" onPress={() => void changeStatus(order, "ACCEPTED")} colors={colors} />}
      {!buyerOrder && order.status === "ACCEPTED" && <IconButton label="Préparer" onPress={() => void changeStatus(order, "PREPARED")} colors={colors} />}
      {!buyerOrder && order.payment_method === "DIRECT_DEPOSIT" && order.payment_status !== "DEPOSIT_PAID" && order.status !== "CANCELLED" && <IconButton label="Confirmer acompte reçu" onPress={() => void confirmDirectDeposit(order)} colors={colors} />}
      {order.status === "PREPARED" && !order.deliverer_id && <IconButton label="Démarrer" onPress={() => startDelivery(order)} colors={colors} />}
      {order.status === "IN_TRANSIT" && order.deliverer_id === user?.id && (
        <View style={styles.deliveryCodeRow}>
          <TextInput value={handoffCode} onChangeText={setHandoffCode} keyboardType="number-pad" maxLength={6} placeholder="Code à 6 chiffres" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.codeInput, { color: colors.text, borderColor: colors.border }]} />
          <IconButton label="Remise" onPress={() => void confirmDelivery(order)} colors={colors} />
        </View>
      )}
      {order.status === "IN_TRANSIT" && order.deliverer_id === user?.id && (
        <IconButton label="Reprendre le suivi" onPress={() => void requestProDeliveryPermissions().then(() => startProDeliveryTracking(order.id)).catch((error: unknown) => Alert.alert("Suivi non démarré", error instanceof Error ? error.message : "Autorisation GPS requise."))} colors={colors} />
      )}
    </View>
  );

  const modeOptions: { id: Mode; label: string }[] = [
    { id: "catalog", label: "Catalogue" },
    { id: "orders", label: "Commandes" },
    ...(hasWholesalerEntitlement
      ? [{ id: "wholesaler" as const, label: "Grossiste" }]
      : []),
  ];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.kicker, { color: colors.primary }]}>QUARTIERPLUS PRO</Text>
          <Text style={[styles.title, { color: colors.text }]}>Approvisionnement local</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.refreshButton}>
          <Text style={{ color: colors.primary, fontWeight: "700" }}>Actualiser</Text>
        </Pressable>
      </View>
      <View style={[styles.segment, { borderBottomColor: colors.border }]}>
        {modeOptions.map(({ id, label }) => (
          <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: mode === id }} onPress={() => setMode(id)} style={[styles.segmentButton, mode === id && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}>
            <Text style={{ color: mode === id ? colors.primary : colors.secondaryText, fontSize: 13, fontWeight: "700" }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <ScrollView contentContainerStyle={styles.content}>
        {mode === "catalog" && (
          <>
            {wholesalers.map((wholesaler) => (
              <View key={wholesaler.id} style={[styles.wholesalerRow, { borderBottomColor: colors.border }]}>
                <View style={styles.grow}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>{wholesaler.business_name}</Text>
                  <Text style={[styles.muted, { color: colors.secondaryText }]}>{wholesaler.delivery_zone}</Text>
                </View>
                <IconButton label="Favori" onPress={() => void favorite(wholesaler.id)} colors={colors} />
              </View>
            ))}
            {products.map((product) => {
              const quantity = cart[product.id] ?? 0;
              return (
                <View key={product.id} style={[styles.productRow, { borderBottomColor: colors.border }]}>
                  <View style={styles.grow}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>{product.name}</Text>
                    <Text style={[styles.muted, { color: colors.secondaryText }]}>{product.business_name} · min. {product.min_order_quantity} {product.unit} · stock {product.stock}</Text>
                    <Text style={[styles.price, { color: colors.text }]}>{money(tierPrice(product, Math.max(quantity, Number(product.min_order_quantity))))}/{product.unit}</Text>
                    {product.photo_url && <Image source={{ uri: product.photo_url }} style={styles.productImage} />}
                    {product.price_tiers?.length > 0 && <Text style={[styles.muted, { color: colors.secondaryText }]}>{product.price_tiers.map((tier) => `${tier.min_quantity}+ à ${money(tier.unit_price)}`).join(" · ")}</Text>}
                  </View>
                  {quantity ? (
                    <View style={styles.quantityControl}>
                      <IconButton label="−" onPress={() => updateCartQuantity(product.id, quantity - 1)} colors={colors} />
                      <Text style={[styles.quantity, { color: colors.text }]}>{quantity}</Text>
                      <IconButton label="+" onPress={() => updateCartQuantity(product.id, quantity + 1)} colors={colors} />
                    </View>
                  ) : <IconButton label="Ajouter" onPress={() => addToCart(product)} colors={colors} />}
                </View>
              );
            })}
            {products.length === 0 && <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucun catalogue vérifié disponible pour le moment.</Text>}
            {cartItems.length > 0 && (
              <View style={[styles.checkout, { borderColor: colors.border }]}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Panier · {activeWholesaler?.business_name}</Text>
                {cartItems.map(({ product, quantity, unitPrice }) => <Text key={product.id} style={[styles.muted, { color: colors.secondaryText }]}>{quantity} {product.unit} × {money(unitPrice)} = {money(quantity * unitPrice)}</Text>)}
                <Text style={[styles.total, { color: colors.text }]}>Total indicatif · {money(cartTotal)}</Text>
                <TextInput value={address} onChangeText={setAddress} placeholder="Adresse de livraison" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
                <IconButton label={deliveryCoordinates ? "Position ajoutée" : "Ajouter ma position de livraison"} onPress={() => void (async () => {
                  try {
                    const permission = await Location.requestForegroundPermissionsAsync();
                    if (permission.status !== "granted") throw new Error("Autorisez la position pendant l’utilisation pour placer le point de livraison.");
                    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                    setDeliveryCoordinates({ latitude: position.coords.latitude, longitude: position.coords.longitude });
                  } catch (locationError) {
                    Alert.alert("Position non ajoutée", locationError instanceof Error ? locationError.message : "La position actuelle est indisponible.");
                  }
                })()} colors={colors} />
                <View style={styles.paymentChoices}>
                  <Choice label="À la livraison" selected={paymentMethod === "PAY_ON_DELIVERY"} onPress={() => setPaymentMethod("PAY_ON_DELIVERY")} colors={colors} />
                  <Choice label="Acompte direct au grossiste" selected={paymentMethod === "DIRECT_DEPOSIT"} onPress={() => setPaymentMethod("DIRECT_DEPOSIT")} colors={colors} />
                </View>
                <Text style={[styles.muted, { color: colors.secondaryText }]}>QuartierPlus ne reçoit ni ne transfère aucun paiement.</Text>
                <ActionButton label={busy ? "Enregistrement…" : "Valider la commande"} onPress={() => void placeOrder()} colors={colors} disabled={busy} />
              </View>
            )}
          </>
        )}
        {mode === "orders" && (
          <>
            {!!queuedCount && <Text style={[styles.pending, { color: colors.primary }]}>{queuedCount} commande(s) en attente du réseau</Text>}
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Mes achats</Text>
            {ownOrders.map((order) => renderOrder(order, true))}
            {selectedOrder && (
              <View style={[styles.details, { borderColor: colors.border }]}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Commande {selectedOrder.order.id.slice(0, 8)}</Text>
                {selectedOrder.items.map((item) => <Text key={item.id} style={[styles.muted, { color: colors.secondaryText }]}>{item.product_name} · {item.quantity} {item.unit} · {money(item.line_total)}</Text>)}
                {selectedOrder.handoff_code && <Text style={[styles.handoff, { color: colors.primary }]}>Code à communiquer au livreur : {selectedOrder.handoff_code}</Text>}
                {selectedOrder.events.map((event) => <Text key={`${event.status}-${event.created_at}`} style={[styles.muted, { color: colors.secondaryText }]}>{STATUS_LABELS[event.status] ?? event.status} · {new Date(event.created_at).toLocaleString("fr-FR")}</Text>)}
                {selectedOrder.order.status === "IN_TRANSIT" && selectedOrder.order.delivery_latitude !== null && selectedOrder.order.delivery_longitude !== null && (
                  <>
                    <MapView
                      provider={PROVIDER_GOOGLE}
                      style={styles.map}
                      initialRegion={{ latitude: deliveryPoint?.latitude ?? selectedOrder.order.delivery_latitude, longitude: deliveryPoint?.longitude ?? selectedOrder.order.delivery_longitude, latitudeDelta: 0.06, longitudeDelta: 0.06 }}
                      region={deliveryPoint ? { latitude: deliveryPoint.latitude, longitude: deliveryPoint.longitude, latitudeDelta: 0.06, longitudeDelta: 0.06 } : undefined}
                    >
                      <Marker coordinate={{ latitude: selectedOrder.order.delivery_latitude, longitude: selectedOrder.order.delivery_longitude }} title="Adresse de livraison" />
                      {deliveryPoint && <Marker coordinate={{ latitude: deliveryPoint.latitude, longitude: deliveryPoint.longitude }} title="Livreur" pinColor="#db5a39" />}
                    </MapView>
                    {deliveryPoint && <Text style={[styles.muted, { color: colors.secondaryText }]}>Arrivée estimée : {Math.max(1, Math.ceil(distanceKm(deliveryPoint.latitude, deliveryPoint.longitude, selectedOrder.order.delivery_latitude, selectedOrder.order.delivery_longitude) / 20 * 60))} min</Text>}
                  </>
                )}
                {selectedOrder.order.status === "DELIVERED" && <ActionButton label="Partager le reçu PDF" onPress={() => void downloadReceipt(selectedOrder.order.id)} colors={colors} />}
              </View>
            )}
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Commandes à traiter</Text>
            {sellerOrders.map((order) => renderOrder(order, false))}
            {!ownOrders.length && !sellerOrders.length && <Text style={[styles.empty, { color: colors.secondaryText }]}>Aucune commande pour le moment.</Text>}
          </>
        )}
        {mode === "wholesaler" && (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Mon profil grossiste</Text>
            {myWholesaler && <Text style={[styles.muted, { color: colors.secondaryText }]}>RCCM : {myWholesaler.rccm_status} · IFU : {myWholesaler.ifu_status}</Text>}
            <TextInput value={businessName} onChangeText={setBusinessName} placeholder="Nom du commerce" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            <Pressable
              accessibilityLabel={`Choisir la ville de livraison${deliveryZone ? `, ${deliveryZone}` : ""}`}
              accessibilityRole="button"
              onPress={() => setZonePickerOpen(true)}
              style={[styles.citySelector, { borderColor: colors.border }]}
            >
              <Text style={{ color: deliveryZone ? colors.text : colors.secondaryText, fontSize: 14 }}>
                {deliveryZone || "Choisir une ville de livraison"}
              </Text>
            </Pressable>
            <Text style={[styles.muted, { color: colors.secondaryText }]}>
              Lien catalogue généré automatiquement : {catalogSlugPreview(businessName)}
            </Text>
            <TextInput
              accessibilityLabel="Numéro RCCM facultatif"
              value={rccmNumber}
              onChangeText={setRccmNumber}
              placeholder="RCCM (facultatif)"
              placeholderTextColor={colors.secondaryText}
              style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            />
            <TextInput
              accessibilityLabel="Numéro IFU facultatif"
              value={ifuNumber}
              onChangeText={setIfuNumber}
              placeholder="IFU (facultatif)"
              placeholderTextColor={colors.secondaryText}
              style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            />
            <ActionButton label="Créer ou actualiser mon profil" onPress={() => void createWholesalerProfile()} colors={colors} />
            {myWholesaler && (
              <>
                <View style={styles.formRow}>
                  <TextInput value={delivererPhone} onChangeText={setDelivererPhone} keyboardType="phone-pad" placeholder="Téléphone livreur (+226…)" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
                  <IconButton label="Inviter" onPress={() => void inviteDeliverer()} colors={colors} />
                </View>
                <Text style={[styles.muted, { color: colors.secondaryText }]}>Employés invités : accès limité aux livraisons prêtes ou assignées.</Text>
              </>
            )}
            <View style={styles.metrics}>
              <Metric label="Aujourd’hui" value={orders.filter((order) => order.status === "RECEIVED").length} colors={colors} />
              <Metric label="Acceptées" value={orders.filter((order) => order.status === "ACCEPTED").length} colors={colors} />
              <Metric label="À livrer" value={orders.filter((order) => order.status === "PREPARED" || order.status === "IN_TRANSIT").length} colors={colors} />
            </View>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Nouveau produit</Text>
            <TextInput value={productName} onChangeText={setProductName} placeholder="Nom du produit" placeholderTextColor={colors.secondaryText} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            <IconButton label={productPhotoId ? "Photo Cloudinary ajoutée" : "Ajouter une photo"} onPress={() => void chooseProductPhoto()} colors={colors} />
            <View style={styles.formRow}>
              <TextInput value={productPrice} onChangeText={setProductPrice} keyboardType="decimal-pad" placeholder="Prix unitaire" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
              <TextInput value={productStock} onChangeText={setProductStock} keyboardType="decimal-pad" placeholder="Stock" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
            </View>
            <View style={styles.formRow}>
              <TextInput value={tierMinimum} onChangeText={setTierMinimum} keyboardType="decimal-pad" placeholder="Palier dès quantité" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
              <TextInput value={tierPriceValue} onChangeText={setTierPriceValue} keyboardType="decimal-pad" placeholder="Prix du palier" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
            </View>
            <View style={styles.formRow}>
              <TextInput value={productUnit} onChangeText={setProductUnit} placeholder="Unité" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
              <TextInput value={productMinimum} onChangeText={setProductMinimum} keyboardType="decimal-pad" placeholder="Commande min." placeholderTextColor={colors.secondaryText} style={[styles.input, styles.formInput, { color: colors.text, borderColor: colors.border }]} />
            </View>
            <ActionButton label="Ajouter le produit" onPress={() => void addProduct()} colors={colors} />
            <ActionButton label="Partager le catalogue sur WhatsApp" onPress={() => void shareCatalog()} colors={colors} />
            {managedProducts.map((product) => (
              <View key={product.id} style={[styles.productRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.rowTitle, { color: colors.text }]}>{product.name} · {money(product.unit_price)}/{product.unit}</Text>
                <Text style={[styles.muted, { color: colors.secondaryText }]}>Stock {product.stock}</Text>
                <View style={styles.quantityControl}>
                  <IconButton label="− Stock" onPress={() => void api.patch(`/v1/pro-commerce/products/${product.id}`, { stock: Math.max(0, Number(product.stock) - 1) }).then(refresh)} colors={colors} />
                  <IconButton label="+ Stock" onPress={() => void api.patch(`/v1/pro-commerce/products/${product.id}`, { stock: Number(product.stock) + 1 }).then(refresh)} colors={colors} />
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
      <Modal
        animationType="slide"
        onRequestClose={() => setZonePickerOpen(false)}
        transparent
        visible={zonePickerOpen}
      >
        <View style={styles.cityBackdrop}>
          <View style={[styles.citySheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Ville de livraison</Text>
            <ScrollView>
              {BURKINA_DELIVERY_CITIES.map((city) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: city === deliveryZone }}
                  key={city}
                  onPress={() => {
                    setDeliveryZone(city);
                    setZonePickerOpen(false);
                  }}
                  style={[styles.cityOption, { borderBottomColor: colors.border }]}
                >
                  <Text style={{ color: city === deliveryZone ? colors.primary : colors.text, fontSize: 14, fontWeight: "700" }}>
                    {city}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function IconButton({ label, onPress, colors }: { label: string; onPress: () => void; colors: { primary: string; border: string } }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.smallButton, { borderColor: colors.border }]}><Text style={{ color: colors.primary, fontWeight: "700", fontSize: 12 }}>{label}</Text></Pressable>;
}
function ActionButton({ label, onPress, colors, disabled = false }: { label: string; onPress: () => void; colors: { primary: string }; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.actionButton, { backgroundColor: colors.primary, opacity: disabled ? 0.6 : 1 }]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}
function Choice({ label, selected, onPress, colors }: { label: string; selected: boolean; onPress: () => void; colors: { primary: string; border: string; text: string; secondaryText: string } }) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={[styles.choice, { borderColor: selected ? colors.primary : colors.border }]}><Text style={{ color: selected ? colors.primary : colors.secondaryText, fontSize: 12, fontWeight: selected ? "700" : "500" }}>{label}</Text></Pressable>;
}
function Metric({ label, value, colors }: { label: string; value: number; colors: { text: string; secondaryText: string } }) {
  return <View style={styles.metric}><Text style={[styles.metricValue, { color: colors.text }]}>{value}</Text><Text style={[styles.muted, { color: colors.secondaryText }]}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  kicker: { fontSize: 10, fontWeight: "800", letterSpacing: 0 },
  title: { fontSize: 18, fontWeight: "800", letterSpacing: 0, marginTop: 2 },
  refreshButton: { padding: 8 },
  segment: { borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "space-around", paddingHorizontal: 8 },
  segmentButton: { alignItems: "center", borderBottomColor: "transparent", borderBottomWidth: 2, flex: 1, paddingVertical: 12 },
  content: { paddingHorizontal: 16, paddingBottom: 36 },
  error: { color: "#b42318", fontSize: 13, paddingHorizontal: 16, paddingTop: 8 },
  empty: { fontSize: 14, paddingVertical: 24, textAlign: "center" },
  sectionTitle: { fontSize: 16, fontWeight: "800", marginBottom: 8, marginTop: 18 },
  citySelector: { borderRadius: 6, borderWidth: 1, justifyContent: "center", marginTop: 8, minHeight: 44, paddingHorizontal: 11 },
  cityBackdrop: { backgroundColor: "rgba(15,23,42,0.5)", flex: 1, justifyContent: "flex-end" },
  citySheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "75%", paddingBottom: 28, paddingHorizontal: 18, paddingTop: 12 },
  cityOption: { borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: "center", minHeight: 48, paddingHorizontal: 8 },
  rowTitle: { fontSize: 14, fontWeight: "700" },
  muted: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  price: { fontSize: 14, fontWeight: "700", marginTop: 5 },
  grow: { flex: 1 },
  wholesalerRow: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", paddingVertical: 11 },
  productRow: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 8, paddingVertical: 12 },
  productImage: { aspectRatio: 1, borderRadius: 4, height: 52, width: 52 },
  smallButton: { alignItems: "center", borderRadius: 6, borderWidth: 1, justifyContent: "center", minHeight: 36, paddingHorizontal: 10 },
  quantityControl: { alignItems: "center", flexDirection: "row", gap: 6 },
  quantity: { fontSize: 14, fontWeight: "700", minWidth: 20, textAlign: "center" },
  checkout: { borderRadius: 6, borderWidth: 1, gap: 8, marginTop: 16, padding: 12 },
  total: { fontSize: 15, fontWeight: "800", marginVertical: 4 },
  input: { borderRadius: 6, borderWidth: 1, fontSize: 14, minHeight: 44, paddingHorizontal: 11, paddingVertical: 8 },
  paymentChoices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 8 },
  actionButton: { alignItems: "center", borderRadius: 6, justifyContent: "center", marginTop: 8, minHeight: 42, paddingHorizontal: 12 },
  actionText: { color: "#ffffff", fontSize: 13, fontWeight: "800", textAlign: "center" },
  pending: { fontSize: 13, fontWeight: "700", marginTop: 12 },
  orderRow: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", flexWrap: "wrap", gap: 7, paddingVertical: 12 },
  orderInfo: { flex: 1, minWidth: 170 },
  deliveryCodeRow: { alignItems: "center", flexDirection: "row", gap: 6, width: "100%" },
  codeInput: { flex: 1, minHeight: 38 },
  details: { borderRadius: 6, borderWidth: 1, gap: 4, marginTop: 12, padding: 10 },
  handoff: { fontSize: 16, fontWeight: "800", marginVertical: 8 },
  map: { height: 240, marginTop: 10, width: "100%" },
  metrics: { flexDirection: "row", justifyContent: "space-between", marginVertical: 12 },
  metric: { alignItems: "center", flex: 1 },
  metricValue: { fontSize: 20, fontWeight: "800" },
  formRow: { flexDirection: "row", gap: 8 },
  formInput: { flex: 1, minWidth: 0 },
});
