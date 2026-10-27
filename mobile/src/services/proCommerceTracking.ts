import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import api from "./api";

const LOCATION_TASK = "quartierplus-pro-delivery-location";
const ACTIVE_ORDER_KEY = "quartierplus.pro.tracking.order";
const PENDING_LOCATIONS_KEY = "quartierplus.pro.tracking.queue";
type DeliveryPoint = {
  latitude: number;
  longitude: number;
  accuracy_meters: number;
};

const readPendingPoints = async (): Promise<DeliveryPoint[]> => {
  const value = await AsyncStorage.getItem(PENDING_LOCATIONS_KEY);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as DeliveryPoint[]) : [];
  } catch {
    return [];
  }
};

const stopTaskAndClear = async () => {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await AsyncStorage.multiRemove([ACTIVE_ORDER_KEY, PENDING_LOCATIONS_KEY]);
};

const sendPendingPoints = async (orderId: string, latest: DeliveryPoint) => {
  const orderResponse = await api.get(`/v1/pro-commerce/orders/${orderId}`);
  if (orderResponse.data?.order?.status !== "IN_TRANSIT") {
    await stopTaskAndClear();
    return;
  }
  const pending = [...(await readPendingPoints()), latest].slice(-40);
  await AsyncStorage.setItem(PENDING_LOCATIONS_KEY, JSON.stringify(pending));
  while (pending.length) {
    await api.post(`/v1/pro-commerce/orders/${orderId}/location`, pending[0]);
    pending.shift();
    await AsyncStorage.setItem(PENDING_LOCATIONS_KEY, JSON.stringify(pending));
  }
};

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error("QuartierPlus Pro location task failed:", error);
    return;
  }
  const orderId = await AsyncStorage.getItem(ACTIVE_ORDER_KEY);
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)
    ?.locations;
  const latest = locations?.at(-1);
  if (!orderId || !latest) return;
  try {
    await sendPendingPoints(orderId, {
      latitude: latest.coords.latitude,
      longitude: latest.coords.longitude,
      accuracy_meters: latest.coords.accuracy ?? 0,
    });
  } catch (requestError) {
    console.warn("Position QuartierPlus Pro mise en attente hors ligne:", requestError);
    const queued = await readPendingPoints();
    const point = {
      latitude: latest.coords.latitude,
      longitude: latest.coords.longitude,
      accuracy_meters: latest.coords.accuracy ?? 0,
    };
    const last = queued.at(-1);
    if (!last || last.latitude !== point.latitude || last.longitude !== point.longitude) {
      queued.push(point);
    }
    await AsyncStorage.setItem(PENDING_LOCATIONS_KEY, JSON.stringify(queued.slice(-40)));
  }
});

export const requestProDeliveryPermissions = async () => {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") {
    throw new Error("L’autorisation de localisation pendant la livraison est nécessaire.");
  }
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") {
    throw new Error("Autorisez la localisation en arrière-plan pour garder le suivi actif écran éteint.");
  }
  if (!(await Location.hasServicesEnabledAsync())) {
    throw new Error("Activez le service de localisation du téléphone pour démarrer le suivi.");
  }
};

export const startProDeliveryTracking = async (orderId: string) => {
  await AsyncStorage.setItem(ACTIVE_ORDER_KEY, orderId);
  await AsyncStorage.removeItem(PENDING_LOCATIONS_KEY);
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 20000,
      distanceInterval: 50,
      pausesUpdatesAutomatically: true,
      foregroundService: {
        notificationTitle: "Livraison en cours",
        notificationBody: "Votre position est partagée uniquement pendant cette livraison.",
        killServiceOnDestroy: false,
      },
    });
  } catch (error) {
    await stopTaskAndClear();
    throw error;
  }
};

export const stopProDeliveryTracking = stopTaskAndClear;
