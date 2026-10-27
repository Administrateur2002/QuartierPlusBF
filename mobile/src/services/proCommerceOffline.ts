import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import api from "./api";

type OrderDraft = {
  client_order_id: string;
  wholesaler_id: string;
  items: { product_id: string; quantity: number }[];
  payment_method: "PAY_ON_DELIVERY" | "DIRECT_DEPOSIT";
  address: string;
  notes?: string;
  latitude?: number;
  longitude?: number;
};
type QueuedOrder = { payload: OrderDraft; queued_at: string };
const QUEUE_KEY = "quartierplus.pro.orders.pending";

const createId = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });

const readQueue = async (): Promise<QueuedOrder[]> => {
  const value = await AsyncStorage.getItem(QUEUE_KEY);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as QueuedOrder[]) : [];
  } catch {
    return [];
  }
};

const saveQueue = (queue: QueuedOrder[]) =>
  AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

export const getQueuedProOrders = readQueue;

export const submitProOrder = async (draft: Omit<OrderDraft, "client_order_id">) => {
  const payload = { ...draft, client_order_id: createId() };
  try {
    const response = await api.post("/v1/pro-commerce/orders", payload);
    return { queued: false, order: response.data.order };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) throw error;
    await saveQueue([
      ...(await readQueue()),
      { payload, queued_at: new Date().toISOString() },
    ]);
    return { queued: true, order: null };
  }
};

export const syncQueuedProOrders = async () => {
  const queue = await readQueue();
  const remaining: QueuedOrder[] = [];
  let synced = 0;
  for (const queued of queue) {
    try {
      await api.post("/v1/pro-commerce/orders", queued.payload);
      synced += 1;
    } catch (error) {
      remaining.push(queued, ...queue.slice(queue.indexOf(queued) + 1));
      if (!axios.isAxiosError(error) || !error.response) break;
      break;
    }
  }
  await saveQueue(remaining);
  return { synced, remaining: remaining.length };
};
