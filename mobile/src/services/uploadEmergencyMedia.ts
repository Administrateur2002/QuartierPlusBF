import { File } from "expo-file-system";
import { apiFetch, API_BASE_URL, type ApiFetchResponse } from "./api";
import {
  uploadCloudinaryMedia,
  type CloudinaryUploadSignature,
} from "./cloudinaryUpload";
import { MediaUploadError } from "./mediaUploadError";

type MediaKind = "image" | "video";

type UploadSignature = CloudinaryUploadSignature & {
  max_bytes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const uploadEmergencyMedia = async (
  uri: string,
  filename: string,
  mimeType: string,
  mediaKind: MediaKind,
  onProgress?: (progress: number) => void,
) => {
  if (!API_BASE_URL) throw new Error("L'adresse du serveur n'est pas configurée.");
  const signUrl = `${API_BASE_URL}/v1/media/sign`;
  let response: ApiFetchResponse;
  try {
    response = await apiFetch(signUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: mediaKind }),
    });
  } catch (error) {
    throw new MediaUploadError(
      "Le média d'urgence n'a pas pu être téléversé.",
      `Étape : signature\nURL : ${signUrl}\nErreur : ${
        error instanceof Error ? error.message : "Impossible de joindre le serveur."
      }`,
    );
  }

  const payload: unknown = await response.json();
  if (
    !response.ok ||
    !isRecord(payload) ||
    typeof payload.apiKey !== "string" ||
    typeof payload.cloudName !== "string" ||
    typeof payload.folder !== "string" ||
    typeof payload.public_id !== "string" ||
    typeof payload.signature !== "string" ||
    typeof payload.timestamp !== "number" ||
    typeof payload.max_bytes !== "number" ||
    payload.resource_type !== mediaKind
  ) {
    const message =
      isRecord(payload) && typeof payload.reason === "string"
        ? payload.reason
        : isRecord(payload) && typeof payload.error === "string"
          ? payload.error
        : "Impossible de préparer le média d'urgence.";
    throw new MediaUploadError(
      message,
      `Étape : signature\nURL : ${signUrl}\nStatut HTTP : ${response.status}\nMessage : ${message}`,
    );
  }

  const signature = payload as UploadSignature;
  onProgress?.(5);
  const size = new File(uri).size;
  if (size > signature.max_bytes) {
    throw new MediaUploadError(
      "Le média d'urgence dépasse la taille autorisée.",
      `Taille du fichier : ${size} octets; limite : ${signature.max_bytes} octets.`,
    );
  }
  try {
    const result = await uploadCloudinaryMedia(signature, {
      uri,
      name: filename,
      type: mimeType,
      size,
    }, {
      onProgress: (progress) => onProgress?.(5 + Math.round(progress * 0.95)),
    });
    if (!result.secureUrl) {
      throw new MediaUploadError(
        "Cloudinary n'a pas renvoyé l'adresse du média d'urgence.",
        "Statut HTTP : 200\nMessage Cloudinary : adresse sécurisée absente.",
      );
    }
    onProgress?.(100);
    return result.secureUrl;
  } catch (error) {
    if (error instanceof MediaUploadError) {
      throw new MediaUploadError(
        "Le média d'urgence n'a pas pu être téléversé.",
        error.technicalDetails,
      );
    }
    throw error;
  }
};
