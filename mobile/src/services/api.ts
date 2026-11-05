import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import {
  cacheAlerts,
  cachePosts,
  getApiCache,
  setApiCache,
} from "./db";
import { ensureServerContract } from "./serverContract";
import appJson from "../../app.json";

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
export const API_TIMEOUT_MS = 60_000;
export const SESSION_TOKEN_KEY = "quartierplus.session.token";

type CachedRequestConfig = InternalAxiosRequestConfig & {
  __offlineCacheKey?: string;
  __servedFromOfflineCache?: boolean;
};

const isStateOnline = (state: NetInfoState) =>
  state.isConnected === true && state.isInternetReachable !== false;

let isOnline: boolean | null = null;
let networkSubscription: ReturnType<typeof NetInfo.addEventListener> | null =
  null;

const ensureNetworkListener = () => {
  if (networkSubscription) return;
  networkSubscription = NetInfo.addEventListener((state) => {
    isOnline = isStateOnline(state);
  });
};

export const getNetworkStatus = async () => {
  ensureNetworkListener();
  if (isOnline !== null) return isOnline;
  const state = await NetInfo.fetch();
  isOnline = isStateOnline(state);
  return isOnline;
};

export const subscribeToNetwork = (
  listener: (online: boolean) => void,
) => {
  ensureNetworkListener();
  return NetInfo.addEventListener((state) => {
    const online = isStateOnline(state);
    isOnline = online;
    listener(online);
  });
};

export const getStoredAuthToken = () =>
  SecureStore.getItemAsync(SESSION_TOKEN_KEY);
export const storeAuthToken = (token: string) =>
  SecureStore.setItemAsync(SESSION_TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
export const clearStoredAuthToken = () =>
  SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);

const sortParams = (params: unknown): string => {
  if (!params || typeof params !== "object") return "";
  return JSON.stringify(
    Object.entries(params as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
};

const getCacheKey = (config: AxiosRequestConfig) =>
  `${config.baseURL ?? ""}${config.url ?? ""}?${sortParams(config.params)}`;

const responseFromCache = async (config: CachedRequestConfig) => {
  const cacheKey = config.__offlineCacheKey ?? getCacheKey(config);
  const data = await getApiCache<unknown>(cacheKey);
  if (data === null) return null;
  config.__servedFromOfflineCache = true;
  return {
    data,
    status: 200,
    statusText: "OK (offline cache)",
    headers: new AxiosHeaders({ "x-quartierplus-cache": "offline" }),
    config,
  };
};

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  headers: {
    Accept: "application/json",
    "X-App-Version": appJson.expo.version,
  },
});

api.interceptors.request.use(async (config: CachedRequestConfig) => {
  if (
    config.method?.toLowerCase() === "get" &&
    config.url !== "/health" &&
    !config.url?.endsWith("/health") &&
    await getNetworkStatus()
  ) {
    await ensureServerContract();
  }
  const token = await getStoredAuthToken();
  if (token) {
    config.headers.set("Authorization", `Bearer ${token}`);
  }

  const method = (config.method ?? "get").toLowerCase();
  if (method === "get") {
    const skipOfflineCache =
      String(config.headers.get("Cache-Control") ?? "").toLowerCase() ===
      "no-cache";
    const online = await getNetworkStatus();
    if (!online) {
      const cachedResponse = skipOfflineCache
        ? null
        : await responseFromCache(config);
      if (cachedResponse) {
        config.adapter = async () => cachedResponse;
        return config;
      }
      throw new AxiosError(
        "Aucune connexion réseau et aucune copie hors ligne de cette ressource.",
        AxiosError.ERR_NETWORK,
        config,
      );
    }
    if (!skipOfflineCache) config.__offlineCacheKey = getCacheKey(config);
  }
  return config;
});

api.interceptors.response.use(
  async (response) => {
    const config = response.config as CachedRequestConfig;
    if (
      config.method?.toLowerCase() === "get" &&
      String(config.headers.get("Cache-Control") ?? "").toLowerCase() !==
        "no-cache" &&
      !config.__servedFromOfflineCache
    ) {
      try {
        await setApiCache(config.__offlineCacheKey ?? getCacheKey(config), response.data);
        const path = config.url?.split("?")[0] ?? "";
        const records = Array.isArray(response.data)
          ? response.data
          : response.data &&
              typeof response.data === "object" &&
              !Array.isArray(response.data)
            ? Object.values(response.data as Record<string, unknown>).find(
                Array.isArray,
              )
            : null;
        if (Array.isArray(records) && path.includes("/marketplace/items")) {
          await cachePosts(records);
        } else if (
          Array.isArray(records) &&
          (path.endsWith("/sos") || path.includes("/sos/alerts"))
        ) {
          await cacheAlerts(records);
        }
      } catch (error) {
        console.error("Unable to persist API response for offline use:", error);
      }
    }
    return response;
  },
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) throw error;
    const config = error.config as CachedRequestConfig | undefined;
    const canUseCache =
      config?.method?.toLowerCase() === "get" &&
      String(config.headers?.get("Cache-Control") ?? "").toLowerCase() !==
        "no-cache" &&
      !error.response &&
      !config.__servedFromOfflineCache;
    if (!config || !canUseCache) throw error;
    const cachedResponse = await responseFromCache(config);
    if (cachedResponse) return cachedResponse;
    throw error;
  },
);

export default api;

export type ApiFetchResponse = {
  ok: boolean;
  status: number;
  json: <T = unknown>() => Promise<T>;
  text: () => Promise<string>;
};

export const apiFetch = async (
  input: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<ApiFetchResponse> => {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = init.body;
  if (
    typeof body === "string" &&
    headers.get("Content-Type")?.includes("application/json")
  ) {
    try {
      body = JSON.parse(body) as BodyInit;
    } catch {
      throw new Error("Le corps JSON de la requête est invalide.");
    }
  }

  try {
    const response = await api.request({
      url: input,
      method,
      ...(init.timeoutMs ? { timeout: init.timeoutMs } : {}),
      headers: Object.fromEntries(headers.entries()),
      data: body,
      signal: init.signal ?? undefined,
    });
    const data = response.data;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json<T>() {
        return data as T;
      },
      async text() {
        return typeof data === "string" ? data : JSON.stringify(data);
      },
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const data: unknown = error.response.data;
      return {
        ok: false,
        status: error.response.status,
        async json<T>() {
          return data as T;
        },
        async text() {
          return typeof data === "string" ? data : JSON.stringify(data);
        },
      };
    }
    throw error;
  }
};

export const API_URL = API_BASE_URL;
