import {
  createNavigationContainerRef,
  NavigationContainer,
  useFocusEffect,
} from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Home,
  Clapperboard,
  MapPin,
  Mic,
  MessageSquare,
  ShoppingBag,
  ShieldCheck,
  Store,
  User,
} from "lucide-react-native";
import { StatusBar } from "expo-status-bar";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import VoiceAssistantModal from "./src/components/VoiceAssistantModal";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { useTheme, ThemeProvider } from "./src/context/ThemeContext";
import {
  VoiceAssistantProvider,
  useVoiceAssistant,
} from "./src/context/VoiceAssistantContext";
import type {
  MainTabParamList,
  RootStackParamList,
} from "./src/navigation/types";
import { OfflineQueryProvider } from "./src/services/queryClient";
import api from "./src/services/api";
import "./src/services/proCommerceTracking";
import {
  checkServerContract,
  isServerUpdating,
  subscribeToServerHealth,
} from "./src/services/serverContract";
import type { VoiceCommand } from "./src/services/voiceAssistant";
import CompleteProfileScreen from "./src/screens/auth/CompleteProfileScreen";
import PhoneAuthScreen from "./src/screens/auth/PhoneAuthScreen";
import GuestWelcomeScreen from "./src/screens/GuestWelcomeScreen";
import FeedScreen from "./src/screens/FeedScreen";
import SeriesScreen from "./src/screens/SeriesScreen";
import GrinScreen from "./src/screens/GrinScreen";
import MapScreen from "./src/screens/MapScreen";
import MarketplaceScreen from "./src/screens/MarketplaceScreen";
import MessagesScreen from "./src/screens/MessagesScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import CheckoutScreen from "./src/screens/main/CheckoutScreen";
import CommerceGrowthScreen from "./src/screens/CommerceGrowthScreen";
import MyActivityScreen from "./src/screens/MyActivityScreen";
import ProTabNavigator from "./src/navigation/ProTabNavigator";
import EventsNavigator from "./src/navigation/EventsNavigator";
import VoyageNavigator from "./src/navigation/VoyageNavigator";
import AlliancePlusScreen from "./src/screens/AlliancePlusScreen";
import AlliancePeopleScreen from "./src/screens/AlliancePeopleScreen";
import WalkieTalkieScreen from "./src/screens/WalkieTalkieScreen";
import ProCommerceScreen from "./src/screens/pro/ProCommerceScreen";
import AdminScreen from "./src/screens/AdminScreen";
import { LockKeyhole, X } from "lucide-react-native";
import LegalConsentGate from "./src/components/LegalConsentGate";

const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

const renderTabLabel =
  (label: string, compact = false) =>
  ({ color }: { color: string }) => (
    <Text
      allowFontScaling={false}
      ellipsizeMode="tail"
      maxFontSizeMultiplier={1.1}
      numberOfLines={1}
      style={{ color, fontSize: compact ? 9 : 12, fontWeight: "600", lineHeight: 14 }}
    >
      {label}
    </Text>
  );

function MainTabs() {
  const insets = useSafeAreaInsets();
  const { colors, t } = useTheme();
  const { user } = useAuth();
  const [activeSpaces, setActiveSpaces] = useState<string[]>([]);
  const [adminEnabled, setAdminEnabled] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (!user) {
        setActiveSpaces([]);
        return () => {
          active = false;
        };
      }
      void api
        .get<unknown>("/v1/pro/me/subscription", {
          headers: { "Cache-Control": "no-cache" },
        })
        .then((response) => {
          const spaces =
            response.data &&
            typeof response.data === "object" &&
            "active_spaces" in response.data &&
            Array.isArray(response.data.active_spaces)
              ? response.data.active_spaces.filter(
                  (space): space is string => typeof space === "string",
                )
              : [];
          if (active) setActiveSpaces(spaces);
        })
        .catch((error: unknown) => {
          if (active) {
            setActiveSpaces([]);
            console.warn("Unable to load active Pro spaces:", error);
          }
        });
      return () => {
        active = false;
      };
    }, [user?.id]),
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (!user) {
        setAdminEnabled(false);
        return () => {
          active = false;
        };
      }
      void api
        .get<{ authorized?: boolean }>("/v1/admin/me", {
          headers: { "Cache-Control": "no-cache" },
        })
        .then((response) => {
          if (active) setAdminEnabled(response.data.authorized === true);
        })
        .catch(() => {
          if (active) setAdminEnabled(false);
        });
      return () => {
        active = false;
      };
    }, [user?.id]),
  );
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.secondaryText,
        tabBarStyle: {
          flexDirection: "row",
          width: "100%",
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          justifyContent: "space-around",
          height: 68 + insets.bottom,
          paddingBottom: Math.max(insets.bottom, 4),
          paddingTop: 5,
        },
        tabBarItemStyle: { flex: 1, minWidth: 0 },
      }}
    >
      <Tab.Screen
        name="Accueil"
        component={FeedScreen}
        options={{
          tabBarLabel: renderTabLabel(t("tabHome")),
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Séries"
        component={SeriesScreen}
        options={{
          tabBarLabel: renderTabLabel("Séries"),
          tabBarIcon: ({ color, size }) => <Clapperboard color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="CarteSOS"
        component={MapScreen}
        options={{
          tabBarLabel: renderTabLabel(t("tabMap")),
          tabBarIcon: ({ color, size }) => <MapPin color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Marche"
        component={MarketplaceScreen}
        options={{
          tabBarLabel: renderTabLabel(t("tabMarket")),
          tabBarIcon: ({ color, size }) => <ShoppingBag color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Messages"
        component={MessagesScreen}
        options={{
          tabBarLabel: renderTabLabel(t("tabMessages")),
          tabBarAccessibilityLabel: t("tabMessages"),
          tabBarIcon: ({ color, size }) => <MessageSquare color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Profil"
        component={SettingsScreen}
        options={{
          tabBarLabel: renderTabLabel(t("tabProfile")),
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Grossistes"
        component={ProCommerceScreen}
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: "none" },
        }}
      />
      <Tab.Screen
        name="Voyage"
        component={VoyageNavigator}
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: "none" },
        }}
      />
      <Tab.Screen
        name="Talkie"
        component={WalkieTalkieScreen}
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: "none" },
        }}
      />
      <Tab.Screen
        name="Grin"
        component={GrinScreen}
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: "none" },
        }}
      />
      {activeSpaces.some((space) =>
        ["ALLIANCE_PRO", "SPONSORED_PIN", "WHOLESALER", "TRANSPORT_COMPANY"].includes(space),
      ) && (
        <Tab.Screen
          name="EspacePro"
          component={ProTabNavigator}
          options={{
            tabBarLabel: renderTabLabel("Pro"),
            tabBarIcon: ({ color, size }) => <Store color={color} size={size} />,
          }}
        />
      )}
      {adminEnabled && (
        <Tab.Screen
          name="Admin"
          component={AdminScreen}
          options={{
            tabBarLabel: renderTabLabel("Admin"),
            tabBarIcon: ({ color, size }) => <ShieldCheck color={color} size={size} />,
          }}
        />
      )}
      <Tab.Screen
        name="Événements"
        component={EventsNavigator}
        options={{
          tabBarButton: () => null,
          tabBarItemStyle: { display: "none" },
        }}
      />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const { user, isSessionLoading } = useAuth();
  const { colors } = useTheme();
  const [introductionSeen, setIntroductionSeen] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync("quartierplus.introduction-seen")
      .then((value) => {
        if (active) setIntroductionSeen(value === "true");
      })
      .catch(() => {
        if (active) setIntroductionSeen(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (isSessionLoading || introductionSeen === null) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <StatusBar style={colors.text === "#f8fafc" ? "light" : "dark"} />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const hasCompletedProfile =
    typeof user?.name === "string" && user.name.trim().length > 0;

  return (
    <Stack.Navigator
      initialRouteName={introductionSeen ? "Main" : "Welcome"}
      screenOptions={{ headerShown: false }}
    >
      {!introductionSeen && (
        <Stack.Screen name="Welcome" component={GuestWelcomeScreen} />
      )}
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen name="MyActivity" component={MyActivityScreen} />
      <Stack.Screen name="CommerceGrowth" component={CommerceGrowthScreen} />
      <Stack.Screen name="PhoneAuth" component={PhoneAuthScreen} />
      {user && !hasCompletedProfile && (
        <Stack.Screen name="CompleteProfile" component={CompleteProfileScreen} />
      )}
      {user && hasCompletedProfile && (
        <Stack.Screen name="Checkout" component={CheckoutScreen} />
      )}
      {user && hasCompletedProfile && (
        <>
          <Stack.Screen name="AlliancePlus" component={AlliancePlusScreen} />
          <Stack.Screen name="AlliancePeople" component={AlliancePeopleScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}

function VoiceAssistantLayer({ currentRoute }: { currentRoute: string }) {
  const { isSessionLoading, requestAuthentication, user } = useAuth();
  const {
    isAssistantActive,
    isFloatingButtonEnabled,
    requestAssistant,
  } = useVoiceAssistant();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () =>
      setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  if (isSessionLoading) return null;

  const navigate = (command: VoiceCommand) => {
    const hasCompletedProfile =
      typeof user?.name === "string" && user.name.trim().length > 0;
    if (command.requiresAuthentication && !user) {
      requestAuthentication();
      return true;
    }
    if (!navigationRef.isReady()) return false;
    if (command.requiresAuthentication && user && !hasCompletedProfile) {
      navigationRef.navigate("CompleteProfile");
      return true;
    }
    if (!command.destination) return false;
    switch (command.destination) {
      case "CarteSOS":
        navigationRef.navigate("Main", {
          screen: "CarteSOS",
          params: { voiceSosRequestId: command.requestId },
        });
        break;
      case "Marche":
        navigationRef.navigate("Main", {
          screen: "Marche",
          params: {
            voiceRequestId: command.requestId,
            voiceSearch: command.searchText,
            voiceCreateListing: command.openCreateListing,
          },
        });
        break;
      case "Messages":
        navigationRef.navigate("Main", {
          screen: "Messages",
          params: {
            voiceRequestId: command.requestId,
            voiceContactQuery: command.contactQuery,
            voiceChannelId: command.channelId,
          },
        });
        break;
      case "Accueil":
      case "Talkie":
      case "Grin":
      case "Profil":
        navigationRef.navigate("Main", { screen: command.destination });
        break;
    }
    return true;
  };

  const hideAssistant =
    isAssistantActive ||
    keyboardVisible ||
    ["PhoneAuth", "CompleteProfile", "Welcome"].includes(currentRoute ?? "");
  const assistantBottom =
    currentRoute === "Messages"
      ? 136
      : currentRoute === "CarteSOS"
        ? 104
        : 66;
  return (
    <>
      {isFloatingButtonEnabled && !hideAssistant && (
        <Pressable
          accessibilityLabel="Assistant vocal"
          accessibilityRole="button"
          onPress={requestAssistant}
          style={[styles.voiceButton, { bottom: insets.bottom + assistantBottom }]}
        >
          <Mic color={colors.onPrimary} size={23} />
        </Pressable>
      )}
      <VoiceAssistantModal onNavigate={navigate} />
    </>
  );
}

function AppNavigation() {
  const { clearActiveInput } = useVoiceAssistant();
  const { colors } = useTheme();
  const [currentRoute, setCurrentRoute] = useState("Welcome");
  const [serverUpdating, setServerUpdating] = useState(isServerUpdating);
  useEffect(() => {
    const unsubscribe = subscribeToServerHealth(() =>
      setServerUpdating(isServerUpdating()),
    );
    void checkServerContract();
    return unsubscribe;
  }, []);
  return (
    <View style={{ backgroundColor: colors.background, flex: 1 }}>
      {serverUpdating && (
        <Text accessibilityRole="alert" style={styles.serverUpdating}>
          Le serveur est en cours de mise à jour
        </Text>
      )}
      <NavigationContainer
        onStateChange={() => {
          clearActiveInput();
          setCurrentRoute(navigationRef.getCurrentRoute()?.name ?? "");
        }}
        onReady={() => setCurrentRoute(navigationRef.getCurrentRoute()?.name ?? "")}
        ref={navigationRef}
      >
        <RootNavigator />
        <VoiceAssistantLayer currentRoute={currentRoute} />
        <AuthPromptLayer />
        <LegalConsentGate />
      </NavigationContainer>
    </View>
  );
}

function AuthPromptLayer() {
  const { authPromptVisible, dismissAuthPrompt } = useAuth();
  const { colors } = useTheme();
  const openAuth = (mode: "login" | "register") => {
    dismissAuthPrompt();
    navigationRef.navigate("PhoneAuth", { mode });
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={dismissAuthPrompt}
      transparent
      visible={authPromptVisible}
    >
      <View style={styles.promptBackdrop}>
        <View style={[styles.promptSheet, { backgroundColor: colors.card }]}>
          <Pressable
            accessibilityLabel="Fermer"
            accessibilityRole="button"
            onPress={dismissAuthPrompt}
            style={styles.promptClose}
          >
            <X color={colors.secondaryText} size={20} />
          </Pressable>
          <View style={styles.promptIcon}><LockKeyhole color="#b9382f" size={23} /></View>
          <Text accessibilityRole="header" style={[styles.promptTitle, { color: colors.text }]}>Connectez-vous pour continuer</Text>
          <Text style={[styles.promptCopy, { color: colors.secondaryText }]}>Créez un compte ou connectez-vous pour accéder à cette action.</Text>
          <Pressable accessibilityRole="button" onPress={() => openAuth("login")} style={[styles.promptPrimary, { backgroundColor: colors.primary }]}>
            <Text style={styles.promptPrimaryText}>Se connecter</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => openAuth("register")} style={styles.promptSecondary}>
            <Text style={[styles.promptSecondaryText, { color: colors.text }]}>Créer un compte</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  serverUpdating: {
    backgroundColor: "#fff7ed",
    color: "#9a3412",
    fontSize: 14,
    fontWeight: "600",
    paddingHorizontal: 16,
    paddingVertical: 10,
    textAlign: "center",
  },
  voiceButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 28,
    elevation: 8,
    height: 56,
    justifyContent: "center",
    position: "absolute",
    right: 18,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    width: 56,
    zIndex: 20,
  },
  loading: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    flex: 1,
    justifyContent: "center",
  },
  promptBackdrop: {
    backgroundColor: "rgba(20, 25, 21, 0.42)",
    flex: 1,
    justifyContent: "flex-end",
  },
  promptSheet: {
    alignItems: "center",
    backgroundColor: "#fffdf8",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 30,
    paddingHorizontal: 24,
    paddingTop: 28,
  },
  promptClose: { alignItems: "center", height: 40, justifyContent: "center", position: "absolute", right: 16, top: 12, width: 40 },
  promptIcon: { alignItems: "center", backgroundColor: "#fff0eb", borderRadius: 24, height: 48, justifyContent: "center", width: 48 },
  promptTitle: { color: "#252823", fontSize: 20, fontWeight: "800", marginTop: 16, textAlign: "center" },
  promptCopy: { color: "#65675e", fontSize: 14, lineHeight: 21, marginBottom: 20, marginTop: 8, textAlign: "center" },
  promptPrimary: { alignItems: "center", backgroundColor: "#252823", borderRadius: 8, justifyContent: "center", minHeight: 50, width: "100%" },
  promptPrimaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  promptSecondary: { alignItems: "center", justifyContent: "center", minHeight: 48, width: "100%" },
  promptSecondaryText: { color: "#252823", fontSize: 14, fontWeight: "700" },
});

export default function App() {
  return (
    <OfflineQueryProvider>
      <ThemeProvider>
        <AuthProvider>
          <VoiceAssistantProvider>
            <AppNavigation />
          </VoiceAssistantProvider>
        </AuthProvider>
      </ThemeProvider>
    </OfflineQueryProvider>
  );
}
