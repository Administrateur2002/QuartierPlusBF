import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import api, { API_BASE_URL } from "../services/api";

type PanelMode = "shops" | "orders" | "opportunities" | "deliveries";
type Product = {
  id: string;
  title: string;
  description?: string;
  price: number | string | null;
  currency?: string;
  currency_code?: string;
  category?: string;
  item_type?: string;
  image_url?: string | null;
  seller_id?: string;
  seller_name?: string;
  seller_verified?: boolean;
  seller_rating?: number;
};
type Shop = {
  seller_id: string;
  business_name: string;
  description: string;
  country_code: string;
  city: string;
  language_code: string;
  seller_name: string;
  verified: boolean;
  average_rating: number | string;
  review_count: number;
  product_count?: number;
  products?: Product[];
};
type OrderEvent = { status: string; note: string; created_at: string };
type Order = {
  id: string;
  buyer_id: string;
  seller_id: string;
  courier_id: string | null;
  item_title: string;
  amount: number | string;
  currency_code: string;
  status: string;
  buyer_confirmed_at?: string | null;
  delivery_method: "HOME_DELIVERY" | "PICKUP";
  delivery_address: string;
  delivery_city: string;
  delivery_country_code: string | null;
  buyer_name?: string;
  seller_name?: string;
  courier_name?: string;
  review_id?: string | null;
  events?: OrderEvent[];
};
type Opportunity = {
  id: string;
  opportunity_type: "SUPPLIER" | "PRODUCER" | "PARTNERSHIP";
  title: string;
  description: string;
  category: string;
  country_code: string | null;
  city: string;
  currency_code: string;
  budget_amount: number | string | null;
  owner_name: string;
  owner_phone: string | null;
  owner_verified: boolean;
  owner_rating: number | string;
};

const ORDER_LABELS: Record<string, string> = {
  SENT: "Envoyée",
  ACCEPTED: "Acceptée",
  PREPARING: "En préparation",
  SHIPPED: "Expédiée",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};
const OPPORTUNITY_LABELS: Record<string, string> = {
  SUPPLIER: "Fournisseur",
  PRODUCER: "Producteur",
  PARTNERSHIP: "Partenariat",
};
const formatMoney = (amount: number | string | null, currency: string) =>
  `${new Intl.NumberFormat("fr-FR").format(Number(amount ?? 0))} ${currency === "XOF" ? "FCFA" : currency}`;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "La requête n’a pas abouti.";

export default function MarketplaceCommercePanel({
  mode,
  countryCode,
  city,
  languageCode,
  search,
  initialSellerId,
  latitude,
  longitude,
  onOrderProduct,
}: {
  mode: PanelMode;
  countryCode: string;
  city: string;
  languageCode: string;
  search: string;
  initialSellerId?: string | null;
  latitude?: number;
  longitude?: number;
  onOrderProduct: (product: Product) => void;
}) {
  const { colors } = useTheme();
  const { authStatus, requestAuthentication, user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [shops, setShops] = useState<Shop[]>([]);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [deliveries, setDeliveries] = useState<Order[]>([]);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [shopModalVisible, setShopModalVisible] = useState(false);
  const [shopName, setShopName] = useState("");
  const [shopDescription, setShopDescription] = useState("");
  const [shopCity, setShopCity] = useState(city);
  const [opportunityModalVisible, setOpportunityModalVisible] = useState(false);
  const [opportunityType, setOpportunityType] =
    useState<Opportunity["opportunity_type"]>("SUPPLIER");
  const [opportunityTitle, setOpportunityTitle] = useState("");
  const [opportunityDescription, setOpportunityDescription] = useState("");
  const [opportunityCategory, setOpportunityCategory] = useState("");
  const [opportunityCity, setOpportunityCity] = useState(city);
  const [opportunityBudget, setOpportunityBudget] = useState("");
  const [opportunityCurrency, setOpportunityCurrency] = useState("XOF");
  const [courierCity, setCourierCity] = useState(city);
  const [courierReady, setCourierReady] = useState(false);
  const [reviewOrder, setReviewOrder] = useState<Order | null>(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureSignedIn = () => {
    if (authStatus === "connected") return true;
    requestAuthentication();
    return false;
  };

  const refresh = useCallback(async () => {
    if (!API_BASE_URL) {
      setError("L’adresse du serveur n’est pas configurée.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (mode === "shops") {
        const scope =
          countryCode === "INT"
            ? "international"
            : countryCode !== "ALL"
              ? "country"
              : latitude !== undefined && longitude !== undefined
                ? "nearby"
                : "international";
        const response = await api.get<{ shops: Shop[] }>("/v1/marketplace/shops", {
          params: {
            country_code: ["ALL", "INT"].includes(countryCode) ? "" : countryCode,
            city,
            language_code: languageCode,
            q: search.trim(),
            scope,
            ...(scope === "nearby"
              ? { latitude, longitude, radius_m: 100_000 }
              : {}),
          },
        });
        setShops(response.data.shops);
      } else if (mode === "orders") {
        if (!ensureSignedIn()) return;
        const response = await api.get<{ orders: Order[] }>("/v1/marketplace/orders");
        setOrders(response.data.orders);
      } else if (mode === "opportunities") {
        const response = await api.get<{ opportunities: Opportunity[] }>(
          "/v1/marketplace/opportunities",
          {
            params: {
              country_code: ["ALL", "INT"].includes(countryCode) ? "" : countryCode,
              city,
              language_code: languageCode,
              q: search.trim(),
            },
          },
        );
        setOpportunities(response.data.opportunities);
      } else {
        if (!ensureSignedIn()) return;
        const profile = await api.get<{
          courier: { is_available: boolean } | null;
        }>("/v1/marketplace/couriers/me");
        setCourierReady(profile.data.courier?.is_available === true);
        if (profile.data.courier?.is_available !== true) {
          setDeliveries([]);
          return;
        }
        const available = await api.get<{ deliveries: Order[] }>(
          "/v1/marketplace/deliveries/open",
        );
        setDeliveries(available.data.deliveries);
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [
    authStatus,
    city,
    countryCode,
    languageCode,
    latitude,
    longitude,
    mode,
    requestAuthentication,
    search,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openShop = async (sellerId: string) => {
    try {
      const response = await api.get<{ shop: Shop }>(
        `/v1/marketplace/shops/${encodeURIComponent(sellerId)}`,
      );
      setSelectedShop(response.data.shop);
    } catch (requestError) {
      Alert.alert("Boutique indisponible", errorMessage(requestError));
    }
  };

  useEffect(() => {
    if (mode === "shops" && initialSellerId) void openShop(initialSellerId);
  }, [initialSellerId, mode]);

  const saveShop = async () => {
    if (!ensureSignedIn()) return;
    if (!shopName.trim()) {
      Alert.alert("Nom requis", "Saisissez le nom commercial de votre boutique.");
      return;
    }
    setBusy(true);
    try {
      const response = await api.put<{ shop: Shop }>("/v1/marketplace/shops/me", {
        business_name: shopName.trim(),
        description: shopDescription.trim(),
        country_code: ["ALL", "INT"].includes(countryCode)
          ? user?.country_code
          : countryCode,
        city: shopCity.trim(),
        language_code: languageCode || "fr",
      });
      setShopModalVisible(false);
      setSelectedShop(response.data.shop);
      Alert.alert("Vitrine enregistrée", "Votre boutique est maintenant visible dans le Marché.");
      await refresh();
    } catch (requestError) {
      Alert.alert("Enregistrement impossible", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const editOwnShop = async () => {
    if (!ensureSignedIn()) return;
    try {
      const response = await api.get<{ shop: Shop | null }>("/v1/marketplace/shops/me");
      setShopName(response.data.shop?.business_name ?? "");
      setShopDescription(response.data.shop?.description ?? "");
      setShopCity(response.data.shop?.city ?? city);
      setShopModalVisible(true);
    } catch (requestError) {
      Alert.alert("Vitrine indisponible", errorMessage(requestError));
    }
  };

  const updateOrder = async (order: Order, status: string) => {
    if (!ensureSignedIn()) return;
    setBusy(true);
    try {
      await api.patch(`/v1/marketplace/orders/${encodeURIComponent(order.id)}/status`, {
        status,
      });
      await refresh();
    } catch (requestError) {
      Alert.alert("Commande inchangée", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async () => {
    if (!ensureSignedIn() || !reviewOrder) return;
    setBusy(true);
    try {
      await api.post(
        `/v1/marketplace/orders/${encodeURIComponent(reviewOrder.id)}/reviews`,
        { rating: reviewRating, comment: reviewComment.trim() },
      );
      setReviewOrder(null);
      setReviewComment("");
      await refresh();
      Alert.alert("Avis publié", "Merci d’avoir évalué un achat confirmé.");
    } catch (requestError) {
      Alert.alert("Avis non publié", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelivery = async (order: Order) => {
    if (!ensureSignedIn()) return;
    setBusy(true);
    try {
      await api.post(
        `/v1/marketplace/orders/${encodeURIComponent(order.id)}/confirm-delivery`,
      );
      await refresh();
      Alert.alert("Réception confirmée", "Vous pouvez maintenant partager votre avis sur cet achat.");
    } catch (requestError) {
      Alert.alert("Confirmation impossible", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const saveOpportunity = async () => {
    if (!ensureSignedIn()) return;
    if (!opportunityTitle.trim() || !opportunityDescription.trim() || !opportunityCategory.trim()) {
      Alert.alert("Champs obligatoires", "Ajoutez un titre, une catégorie et une description.");
      return;
    }
    const budget = opportunityBudget.trim()
      ? Number(opportunityBudget.replace(/\s/g, "").replace(",", "."))
      : null;
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
      Alert.alert("Budget invalide", "Saisissez un montant valide ou laissez le champ vide.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/v1/marketplace/opportunities", {
        opportunity_type: opportunityType,
        title: opportunityTitle.trim(),
        description: opportunityDescription.trim(),
        category: opportunityCategory.trim(),
        country_code: ["ALL", "INT"].includes(countryCode)
          ? user?.country_code
          : countryCode,
        city: opportunityCity.trim(),
        language_code: languageCode || "fr",
        currency_code: opportunityCurrency,
        budget_amount: budget,
      });
      setOpportunityModalVisible(false);
      setOpportunityTitle("");
      setOpportunityDescription("");
      setOpportunityCategory("");
      setOpportunityBudget("");
      await refresh();
    } catch (requestError) {
      Alert.alert("Publication impossible", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const registerCourier = async () => {
    if (!ensureSignedIn()) return;
    const homeCountry = ["ALL", "INT"].includes(countryCode)
      ? user?.country_code
      : countryCode;
    if (!homeCountry || !courierCity.trim()) {
      Alert.alert("Zone requise", "Choisissez votre pays et votre ville de livraison.");
      return;
    }
    setBusy(true);
    try {
      await api.put("/v1/marketplace/couriers/me", {
        country_code: homeCountry,
        city: courierCity.trim(),
        is_available: true,
      });
      setCourierReady(true);
      await refresh();
    } catch (requestError) {
      Alert.alert("Inscription livreur impossible", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const toggleCourierAvailability = async () => {
    if (!ensureSignedIn()) return;
    const homeCountry = countryCode === "ALL" || countryCode === "INT"
      ? user?.country_code
      : countryCode;
    if (!homeCountry || !courierCity.trim()) {
      Alert.alert("Zone requise", "Choisissez votre pays et votre ville de livraison.");
      return;
    }
    setBusy(true);
    try {
      const available = !courierReady;
      await api.put("/v1/marketplace/couriers/me", {
        country_code: homeCountry,
        city: courierCity.trim(),
        is_available: available,
      });
      setCourierReady(available);
      if (available) await refresh();
      else setDeliveries([]);
    } catch (requestError) {
      Alert.alert("Profil livreur inchangé", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const claimDelivery = async (order: Order) => {
    if (!ensureSignedIn()) return;
    setBusy(true);
    try {
      await api.post(
        `/v1/marketplace/orders/${encodeURIComponent(order.id)}/claim-delivery`,
      );
      await refresh();
      Alert.alert("Livraison attribuée", "L’adresse complète est visible dans vos commandes.");
    } catch (requestError) {
      Alert.alert("Livraison indisponible", errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const contactOpportunity = async (opportunity: Opportunity) => {
    const phone = opportunity.owner_phone?.replace(/[^\d+]/g, "") ?? "";
    if (!phone) {
      Alert.alert("Contact indisponible", "Aucun numéro public n’est associé à cette opportunité.");
      return;
    }
    try {
      await Linking.openURL(`tel:${phone}`);
    } catch (linkError) {
      Alert.alert("Appel indisponible", errorMessage(linkError));
    }
  };

  const panelTitle = {
    shops: "Boutiques professionnelles",
    orders: "Mes commandes",
    opportunities: "Opportunités commerciales",
    deliveries: "Livraisons indépendantes",
  }[mode];

  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.panelHeader}>
        <View style={styles.panelHeading}>
          <Text style={[styles.panelTitle, { color: colors.text }]}>{panelTitle}</Text>
          <Text style={[styles.panelSubtitle, { color: colors.secondaryText }]}>
            {mode === "orders"
              ? "Suivi de la commande et échanges directs entre acheteur et vendeur."
              : mode === "deliveries"
                ? "Mise en relation locale, sans collecte ni conservation de paiement."
                : mode === "opportunities"
                  ? "Fournisseurs, producteurs et partenariats publiés par la communauté."
                  : "Vitrines vendeurs et catalogues de produits disponibles."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void refresh()}
          style={[styles.secondaryButton, { borderColor: colors.border }]}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.primary }]}>Actualiser</Text>
        </Pressable>
      </View>

      {mode === "shops" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void editOwnShop()}
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.primaryButtonText}>Créer ou modifier ma vitrine professionnelle</Text>
        </Pressable>
      )}
      {mode === "opportunities" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (ensureSignedIn()) setOpportunityModalVisible(true);
          }}
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.primaryButtonText}>Publier une opportunité</Text>
        </Pressable>
      )}
      {mode === "deliveries" && (
        <View style={[styles.courierForm, { borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            {courierReady ? "Votre profil livreur est actif" : "Devenir livreur indépendant"}
          </Text>
          <TextInput
            accessibilityLabel="Ville de livraison"
            onChangeText={setCourierCity}
            placeholder="Ville de livraison"
            placeholderTextColor={colors.secondaryText}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
            value={courierCity}
          />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void registerCourier()}
              style={[styles.primaryButton, { backgroundColor: colors.primary, flex: 1 }]}
            >
              <Text style={styles.primaryButtonText}>
                {courierReady ? "Mettre à jour ma zone" : "Activer mon profil livreur"}
              </Text>
            </Pressable>
            {courierReady && (
              <ActionButton
                label="Mettre en pause"
                onPress={() => void toggleCourierAvailability()}
                colors={colors}
              />
            )}
          </View>
        </View>
      )}

      {loading && <ActivityIndicator color={colors.primary} />}
      {error && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}

      {mode === "shops" && (
        <View style={styles.list}>
          {shops.map((shop) => (
            <Pressable
              accessibilityRole="button"
              key={shop.seller_id}
              onPress={() => void openShop(shop.seller_id)}
              style={[styles.listCard, { borderColor: colors.border }]}
            >
              <Text style={[styles.cardTitle, { color: colors.text }]}>{shop.business_name}</Text>
              <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                {shop.city || shop.country_code} · {shop.product_count ?? 0} produits
              </Text>
              <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                {shop.verified ? "✓ Vendeur vérifié · " : ""}
                ★ {Number(shop.average_rating).toFixed(1)} ({shop.review_count} avis)
              </Text>
              {shop.description ? (
                <Text numberOfLines={3} style={[styles.bodyText, { color: colors.text }]}>
                  {shop.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
          {!loading && shops.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              Aucune vitrine ne correspond aux filtres internationaux.
            </Text>
          )}
        </View>
      )}

      {mode === "orders" && (
        <View style={styles.list}>
          {orders.map((order) => {
            const isBuyer = order.buyer_id === user?.id;
            const isSeller = order.seller_id === user?.id;
            const isCourier = order.courier_id === user?.id;
            const expanded = expandedOrderId === order.id;
            return (
              <View key={order.id} style={[styles.listCard, { borderColor: colors.border }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => setExpandedOrderId(expanded ? null : order.id)}
                >
                  <View style={styles.orderHeading}>
                    <Text style={[styles.cardTitle, { color: colors.text, flex: 1 }]}>
                      {order.item_title}
                    </Text>
                    <Text style={[styles.statusBadge, { color: colors.primary }]}>
                      {ORDER_LABELS[order.status] ?? order.status}
                    </Text>
                  </View>
                  <Text style={[styles.bodyText, { color: colors.text }]}>
                    {formatMoney(order.amount, order.currency_code)} ·{" "}
                    {order.delivery_method === "PICKUP" ? "Retrait" : "Livraison à domicile"}
                  </Text>
                  <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                    {isBuyer ? `Vendeur : ${order.seller_name ?? "Vendeur"}` :
                      isCourier ? `Livraison pour ${order.buyer_name ?? "acheteur"}` :
                        `Acheteur : ${order.buyer_name ?? "Acheteur"}`}
                  </Text>
                  {(isSeller || isCourier) && order.delivery_address ? (
                    <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                      {order.delivery_address}, {order.delivery_city}
                    </Text>
                  ) : null}
                </Pressable>
                {expanded && (
                  <View style={styles.timeline}>
                    {(order.events ?? []).map((event, index) => (
                      <Text key={`${event.status}-${event.created_at}-${index}`} style={[styles.timelineText, { color: colors.secondaryText }]}>
                        • {ORDER_LABELS[event.status] ?? event.status}
                        {event.note ? ` — ${event.note}` : ""}
                        {" · "}
                        {new Date(event.created_at).toLocaleString()}
                      </Text>
                    ))}
                    {order.courier_id && (
                      <Text style={[styles.timelineText, { color: colors.secondaryText }]}>
                        Livreur : {order.courier_name ?? "Livreur indépendant assigné"}
                      </Text>
                    )}
                  </View>
                )}
                <View style={styles.actions}>
                  {isSeller && order.status === "SENT" && (
                    <ActionButton label="Accepter" onPress={() => void updateOrder(order, "ACCEPTED")} colors={colors} />
                  )}
                  {isSeller && order.status === "ACCEPTED" && (
                    <ActionButton label="Préparer" onPress={() => void updateOrder(order, "PREPARING")} colors={colors} />
                  )}
                  {isSeller && order.status === "PREPARING" && order.delivery_method === "PICKUP" && (
                    <ActionButton label="Confirmer le retrait" onPress={() => void updateOrder(order, "DELIVERED")} colors={colors} />
                  )}
                  {isCourier && order.status === "PREPARING" && (
                    <ActionButton label="Colis récupéré" onPress={() => void updateOrder(order, "SHIPPED")} colors={colors} />
                  )}
                  {isCourier && order.status === "SHIPPED" && (
                    <ActionButton label="Confirmer la livraison" onPress={() => void updateOrder(order, "DELIVERED")} colors={colors} />
                  )}
                  {(isBuyer && ["SENT", "ACCEPTED"].includes(order.status) ||
                    isSeller && ["SENT", "ACCEPTED"].includes(order.status) ||
                    isSeller && order.status === "PREPARING" &&
                      order.delivery_method === "HOME_DELIVERY" && !order.courier_id) && (
                    <ActionButton label="Annuler" onPress={() => void updateOrder(order, "CANCELLED")} colors={colors} />
                  )}
                  {isBuyer && order.status === "DELIVERED" && !order.buyer_confirmed_at && (
                    <ActionButton
                      label="Confirmer la réception"
                      onPress={() => void confirmDelivery(order)}
                      colors={colors}
                    />
                  )}
                  {isBuyer && order.status === "DELIVERED" &&
                    order.buyer_confirmed_at && !order.review_id && (
                    <ActionButton
                      label="Évaluer l’achat"
                      onPress={() => {
                        setReviewRating(5);
                        setReviewComment("");
                        setReviewOrder(order);
                      }}
                      colors={colors}
                    />
                  )}
                </View>
              </View>
            );
          })}
          {!loading && orders.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              Vos commandes et leur suivi apparaîtront ici.
            </Text>
          )}
        </View>
      )}

      {mode === "opportunities" && (
        <View style={styles.list}>
          {opportunities.map((opportunity) => (
            <View key={opportunity.id} style={[styles.listCard, { borderColor: colors.border }]}>
              <Text style={[styles.statusBadge, { color: colors.primary }]}>
                {OPPORTUNITY_LABELS[opportunity.opportunity_type]}
              </Text>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{opportunity.title}</Text>
              <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                {opportunity.category} · {[opportunity.city, opportunity.country_code].filter(Boolean).join(", ")}
              </Text>
              <Text style={[styles.bodyText, { color: colors.text }]}>{opportunity.description}</Text>
              {opportunity.budget_amount !== null && (
                <Text style={[styles.bodyText, { color: colors.primary }]}>
                  Budget indicatif : {formatMoney(opportunity.budget_amount, opportunity.currency_code)}
                </Text>
              )}
              <View style={styles.orderHeading}>
                <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                  {opportunity.owner_name}
                  {opportunity.owner_verified ? " · ✓ Vérifié" : ""}
                  {" · ★ "}{Number(opportunity.owner_rating).toFixed(1)}
                </Text>
                <ActionButton label="Contacter" onPress={() => void contactOpportunity(opportunity)} colors={colors} />
              </View>
            </View>
          ))}
          {!loading && opportunities.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              Aucune opportunité publiée dans cette zone.
            </Text>
          )}
        </View>
      )}

      {mode === "deliveries" && (
        <View style={styles.list}>
          {deliveries.map((order) => (
            <View key={order.id} style={[styles.listCard, { borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{order.item_title}</Text>
              <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                {order.delivery_city} · {formatMoney(order.amount, order.currency_code)}
              </Text>
              <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
                Vendeur : {order.seller_name}
              </Text>
              <ActionButton label="Prendre cette livraison" onPress={() => void claimDelivery(order)} colors={colors} />
            </View>
          ))}
          {courierReady && !loading && deliveries.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              Aucune livraison indépendante disponible dans votre ville.
            </Text>
          )}
        </View>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => setShopModalVisible(false)}
        transparent
        visible={shopModalVisible}
      >
        <ModalFrame title="Créer ma vitrine" onClose={() => setShopModalVisible(false)} colors={colors}>
          <TextInput
            accessibilityLabel="Nom de la boutique"
            onChangeText={setShopName}
            placeholder="Nom commercial"
            placeholderTextColor={colors.secondaryText}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
            value={shopName}
          />
          <TextInput
            accessibilityLabel="Description de la boutique"
            multiline
            onChangeText={setShopDescription}
            placeholder="Présentation, produits et savoir-faire"
            placeholderTextColor={colors.secondaryText}
            style={[styles.input, styles.multiline, { borderColor: colors.border, color: colors.text }]}
            value={shopDescription}
          />
          <TextInput
            accessibilityLabel="Ville de la boutique"
            onChangeText={setShopCity}
            placeholder="Ville"
            placeholderTextColor={colors.secondaryText}
            style={[styles.input, { borderColor: colors.border, color: colors.text }]}
            value={shopCity}
          />
          <ActionButton label={busy ? "Enregistrement…" : "Enregistrer la vitrine"} onPress={() => void saveShop()} colors={colors} />
        </ModalFrame>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setOpportunityModalVisible(false)}
        transparent
        visible={opportunityModalVisible}
      >
        <ModalFrame title="Nouvelle opportunité" onClose={() => setOpportunityModalVisible(false)} colors={colors}>
          <View style={styles.actions}>
            {(["SUPPLIER", "PRODUCER", "PARTNERSHIP"] as const).map((type) => (
              <ActionButton
                key={type}
                label={OPPORTUNITY_LABELS[type]}
                onPress={() => setOpportunityType(type)}
                colors={colors}
                selected={type === opportunityType}
              />
            ))}
          </View>
          <TextInput accessibilityLabel="Titre de l’opportunité" onChangeText={setOpportunityTitle} placeholder="Titre" placeholderTextColor={colors.secondaryText} style={[styles.input, { borderColor: colors.border, color: colors.text }]} value={opportunityTitle} />
          <TextInput accessibilityLabel="Catégorie de l’opportunité" onChangeText={setOpportunityCategory} placeholder="Catégorie" placeholderTextColor={colors.secondaryText} style={[styles.input, { borderColor: colors.border, color: colors.text }]} value={opportunityCategory} />
          <TextInput accessibilityLabel="Ville de l’opportunité" onChangeText={setOpportunityCity} placeholder="Ville" placeholderTextColor={colors.secondaryText} style={[styles.input, { borderColor: colors.border, color: colors.text }]} value={opportunityCity} />
          <TextInput accessibilityLabel="Description de l’opportunité" multiline onChangeText={setOpportunityDescription} placeholder="Décrivez le besoin ou l’offre" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.multiline, { borderColor: colors.border, color: colors.text }]} value={opportunityDescription} />
          <View style={styles.actions}>
            {["XOF", "XAF", "USD", "EUR", "NGN", "GHS"].map((currency) => (
              <ActionButton key={currency} label={currency} onPress={() => setOpportunityCurrency(currency)} colors={colors} selected={currency === opportunityCurrency} />
            ))}
          </View>
          <TextInput accessibilityLabel="Budget indicatif" keyboardType="decimal-pad" onChangeText={setOpportunityBudget} placeholder="Budget indicatif (facultatif)" placeholderTextColor={colors.secondaryText} style={[styles.input, { borderColor: colors.border, color: colors.text }]} value={opportunityBudget} />
          <ActionButton label={busy ? "Publication…" : "Publier"} onPress={() => void saveOpportunity()} colors={colors} />
        </ModalFrame>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setReviewOrder(null)}
        transparent
        visible={reviewOrder !== null}
      >
        <ModalFrame title="Évaluer cet achat livré" onClose={() => setReviewOrder(null)} colors={colors}>
          <View style={styles.actions}>
            {[1, 2, 3, 4, 5].map((rating) => (
              <ActionButton
                key={rating}
                label={`${rating} ★`}
                onPress={() => setReviewRating(rating)}
                colors={colors}
                selected={rating === reviewRating}
              />
            ))}
          </View>
          <TextInput accessibilityLabel="Commentaire sur le vendeur" multiline maxLength={1000} onChangeText={setReviewComment} placeholder="Votre avis (facultatif)" placeholderTextColor={colors.secondaryText} style={[styles.input, styles.multiline, { borderColor: colors.border, color: colors.text }]} value={reviewComment} />
          <ActionButton label={busy ? "Envoi…" : "Publier l’avis"} onPress={() => void submitReview()} colors={colors} />
        </ModalFrame>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedShop(null)}
        transparent
        visible={selectedShop !== null}
      >
        {selectedShop && (
          <ModalFrame title={selectedShop.business_name} onClose={() => setSelectedShop(null)} colors={colors}>
            <Text style={[styles.bodyText, { color: colors.secondaryText }]}>
              {selectedShop.city} · {selectedShop.country_code}
              {selectedShop.verified ? " · Vendeur vérifié" : ""}
              {" · ★ "}{Number(selectedShop.average_rating).toFixed(1)} ({selectedShop.review_count} avis)
            </Text>
            {selectedShop.description ? (
              <Text style={[styles.bodyText, { color: colors.text }]}>{selectedShop.description}</Text>
            ) : null}
            <ScrollView style={styles.shopProducts}>
              {(selectedShop.products ?? []).map((product) => (
                <View key={product.id} style={[styles.listCard, { borderColor: colors.border }]}>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>{product.title}</Text>
                  <Text style={[styles.bodyText, { color: colors.primary }]}>
                    {formatMoney(product.price, product.currency ?? product.currency_code ?? "XOF")}
                  </Text>
                  {product.description ? (
                    <Text style={[styles.bodyText, { color: colors.secondaryText }]}>{product.description}</Text>
                  ) : null}
                  <ActionButton
                    label="Commander"
                    onPress={() => {
                      setSelectedShop(null);
                      onOrderProduct({
                        ...product,
                        seller_id: selectedShop.seller_id,
                        seller_name: selectedShop.business_name,
                        seller_verified: selectedShop.verified,
                        seller_rating: Number(selectedShop.average_rating),
                      });
                    }}
                    colors={colors}
                  />
                </View>
              ))}
              {selectedShop.products?.length === 0 && (
                <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
                  Cette vitrine n’a pas encore de produit au catalogue.
                </Text>
              )}
            </ScrollView>
          </ModalFrame>
        )}
      </Modal>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  colors,
  selected = false,
}: {
  label: string;
  onPress: () => void;
  colors: { primary: string; border: string };
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      disabled={false}
      onPress={onPress}
      style={[
        styles.actionButton,
        { borderColor: selected ? colors.primary : colors.border },
        selected && { backgroundColor: `${colors.primary}18` },
      ]}
    >
      <Text style={[styles.actionText, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

function ModalFrame({
  title,
  onClose,
  colors,
  children,
}: {
  title: string;
  onClose: () => void;
  colors: { card: string; text: string; border: string };
  children: ReactNode;
}) {
  return (
    <View style={styles.modalBackdrop}>
      <View style={[styles.modalContent, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.modalHeader}>
          <Text style={[styles.panelTitle, { color: colors.text, flex: 1 }]}>{title}</Text>
          <Pressable accessibilityLabel="Fermer" accessibilityRole="button" onPress={onClose}>
            <Text style={[styles.closeText, { color: colors.text }]}>×</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 16,
    borderWidth: 1,
    gap: 14,
    marginBottom: 20,
    padding: 14,
  },
  panelHeader: { alignItems: "flex-start", flexDirection: "row", gap: 8 },
  panelHeading: { flex: 1, gap: 4 },
  panelTitle: { fontSize: 17, fontWeight: "800" },
  panelSubtitle: { fontSize: 12, lineHeight: 18 },
  secondaryButton: { borderRadius: 9, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  secondaryButtonText: { fontSize: 11, fontWeight: "700" },
  primaryButton: { alignItems: "center", borderRadius: 10, minHeight: 42, justifyContent: "center", paddingHorizontal: 12 },
  primaryButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "800", textAlign: "center" },
  list: { gap: 10 },
  listCard: { borderRadius: 12, borderWidth: 1, gap: 7, padding: 12 },
  cardTitle: { fontSize: 14, fontWeight: "800" },
  bodyText: { fontSize: 12, lineHeight: 18 },
  statusBadge: { fontSize: 11, fontWeight: "800" },
  orderHeading: { alignItems: "center", flexDirection: "row", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 7 },
  actionButton: { alignItems: "center", borderRadius: 8, borderWidth: 1, justifyContent: "center", minHeight: 34, paddingHorizontal: 10 },
  actionText: { fontSize: 11, fontWeight: "700" },
  timeline: { borderTopColor: "#e2e8f0", borderTopWidth: 1, gap: 5, marginTop: 9, paddingTop: 8 },
  timelineText: { fontSize: 11, lineHeight: 17 },
  emptyText: { fontSize: 13, lineHeight: 19, paddingVertical: 8 },
  errorText: { color: "#b91c1c", fontSize: 12 },
  courierForm: { borderRadius: 12, borderWidth: 1, gap: 8, padding: 10 },
  input: { borderRadius: 10, borderWidth: 1, fontSize: 14, minHeight: 42, paddingHorizontal: 11, paddingVertical: 9 },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  modalBackdrop: { backgroundColor: "rgba(15, 23, 42, 0.55)", flex: 1, justifyContent: "center", padding: 18 },
  modalContent: { borderRadius: 18, borderWidth: 1, maxHeight: "88%", padding: 15 },
  modalHeader: { alignItems: "center", flexDirection: "row", gap: 8, paddingBottom: 12 },
  closeText: { fontSize: 28, lineHeight: 30, paddingHorizontal: 4 },
  modalBody: { gap: 11, paddingBottom: 12 },
  shopProducts: { maxHeight: 430 },
});
