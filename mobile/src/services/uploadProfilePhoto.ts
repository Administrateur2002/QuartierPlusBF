import { File } from "expo-file-system";
import { API_BASE_URL, apiFetch } from "./api";
import {
  uploadCloudinaryMedia,
  type CloudinaryUploadSignature,
} from "./cloudinaryUpload";

type ProfileUploadSignature = CloudinaryUploadSignature & {
  max_bytes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const uploadProfilePhoto = async (uri: string) => {
  if (!API_BASE_URL) throw new Error("L'adresse du serveur n'est pas configurée.");
  const signatureResponse = await apiFetch(
    `${API_BASE_URL}/v1/users/me/photo-signature`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const payload: unknown = await signatureResponse.json();
  if (
    !signatureResponse.ok ||
    !isRecord(payload) ||
    typeof payload.apiKey !== "string" ||
    typeof payload.cloudName !== "string" ||
    typeof payload.folder !== "string" ||
    typeof payload.public_id !== "string" ||
    typeof payload.signature !== "string" ||
    typeof payload.timestamp !== "number" ||
    typeof payload.max_bytes !== "number" ||
    !Number.isSafeInteger(payload.max_bytes) ||
    payload.max_bytes < 1 ||
    payload.resource_type !== "image"
  ) {
    const message = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : `Impossible de préparer la photo (HTTP ${signatureResponse.status}).`;
    throw new Error(message);
  }
  const signature = payload as ProfileUploadSignature;
  const size = new File(uri).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > signature.max_bytes) {
    throw new Error("La photo optimisée dépasse la taille autorisée.");
  }
  const uploaded = await uploadCloudinaryMedia(signature, {
    uri,
    name: `profil-${Date.now()}.webp`,
    type: "image/webp",
    size,
  });
  const savedResponse = await apiFetch(`${API_BASE_URL}/v1/users/me/photo`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_photo_public_id: uploaded.publicId }),
  });
  const savedPayload: unknown = await savedResponse.json();
  if (
    !savedResponse.ok ||
    !isRecord(savedPayload) ||
    typeof savedPayload.profile_photo_url !== "string"
  ) {
    const message = isRecord(savedPayload) && typeof savedPayload.error === "string"
      ? savedPayload.error
      : `Impossible d'enregistrer la photo (HTTP ${savedResponse.status}).`;
    throw new Error(message);
  }
  return savedPayload.profile_photo_url;
};
