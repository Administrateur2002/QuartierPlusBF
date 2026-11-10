import { readFile } from "node:fs/promises";

const servicesFile = process.env.GOOGLE_SERVICES_JSON || "./google-services.json";
const services = JSON.parse(await readFile(servicesFile, "utf8"));
const app = JSON.parse(await readFile("./app.json", "utf8")).expo;
const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || services.project_info?.project_id;
const expectedProjectId = services.project_info?.project_id;
const androidPackage = app.android?.package;
const clients = services.client?.flatMap((entry) => entry.oauth_client ?? []) ?? [];
const androidClient = clients.find(
  (client) =>
    client.client_type === 1 &&
    client.android_info?.package_name === androidPackage,
);
const webClient = clients.find((client) => client.client_type === 3)?.client_id;

if (!expectedProjectId || projectId !== expectedProjectId) {
  throw new Error("EXPO_PUBLIC_FIREBASE_PROJECT_ID ne correspond pas au google-services.json sélectionné.");
}
if (!androidPackage || !androidClient) {
  throw new Error("Aucun client OAuth Android du JSON ne correspond au package configuré dans app.json.");
}
if (!webClient || !/^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(webClient)) {
  throw new Error("Le client OAuth Web Firebase est absent ou invalide dans google-services.json.");
}
if (
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID &&
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID !== webClient
) {
  throw new Error("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ne correspond pas au client OAuth Web du JSON Firebase sélectionné.");
}

console.log(`Projet Firebase : ${projectId}`);
console.log(`Package Android : ${androidPackage} (client OAuth correspondant)`);
console.log("Client OAuth Web : présent et cohérent");