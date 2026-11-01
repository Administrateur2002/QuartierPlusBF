import axios from "axios";
import { File } from "expo-file-system";
import { API_BASE_URL, apiFetch } from "./api";
import { MediaUploadError } from "./mediaUploadError";

export type CloudinaryMediaType = "image" | "video";

export type CloudinaryUploadSignature = {
  apiKey: string;
  cloudName: string;
  folder: string;
  public_id: string;
  resource_type: CloudinaryMediaType;
  signature: string;
  timestamp: number;
  context?: string;
};

type UploadFile = {
  uri: string;
  name: string;
  type: string;
  size: number;
};

export type CloudinaryUploadResult = {
  publicId: string;
  secureUrl?: string;
};

type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

const LARGE_VIDEO_THRESHOLD = 20 * 1024 * 1024;
const VIDEO_CHUNK_SIZE = 5 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createFormData = (
  signature: CloudinaryUploadSignature,
  file: UploadFile,
  payload: Blob | { uri: string; name: string; type: string },
) => {
  const formData = new FormData();
  (formData as FormData & {
    append: (
      name: string,
      value: string | Blob | { uri: string; name: string; type: string },
      filename?: string,
    ) => void;
  }).append("file", payload, file.name);
  formData.append("api_key", signature.apiKey);
  formData.append("timestamp", String(signature.timestamp));
  formData.append("folder", signature.folder);
  formData.append("public_id", signature.public_id);
  formData.append("signature", signature.signature);
  if (signature.context) formData.append("context", signature.context);
  return formData;
};

const cloudinaryMessage = (error: unknown) => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const responseData: unknown = axios.isAxiosError(error)
    ? error.response?.data
    : null;
  const message =
    isRecord(responseData) &&
    isRecord(responseData.error) &&
    typeof responseData.error.message === "string"
      ? responseData.error.message
      : error instanceof Error
        ? error.message
        : "Réponse Cloudinary indisponible.";
  return { status, message };
};

export const reportCloudinaryUploadFailure = async (
  mediaType: CloudinaryMediaType,
  status: number | null,
  message: string,
  expectedPublicId: string,
  receivedPublicId: string | null,
) => {
  if (!API_BASE_URL) {
    console.error("Unable to report Cloudinary upload failure: API URL is missing.");
    return;
  }
  try {
    const response = await apiFetch(`${API_BASE_URL}/v1/media/upload-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: mediaType,
        status,
        message: message.slice(0, 500),
        expected_public_id: expectedPublicId,
        received_public_id: receivedPublicId,
      }),
    });
    if (!response.ok) {
      console.error(
        `Unable to report Cloudinary upload failure (HTTP ${response.status}).`,
      );
    }
  } catch (error) {
    console.error("Unable to report Cloudinary upload failure:", error);
  }
};

export const uploadCloudinaryMedia = async (
  signature: CloudinaryUploadSignature,
  file: UploadFile,
  options: UploadOptions = {},
): Promise<CloudinaryUploadResult> => {
  if (signature.resource_type !== "image" && signature.resource_type !== "video") {
    throw new Error("Type de ressource Cloudinary invalide.");
  }
  const uploadUrl = `https://api.cloudinary.com/v1_1/${signature.cloudName}/${signature.resource_type}/upload`;
  let result: { public_id?: string; secure_url?: string } | undefined;
  try {
    const size = file.size || new File(file.uri).size;
    if (
      signature.resource_type === "video" &&
      size > LARGE_VIDEO_THRESHOLD
    ) {
      const source = new File(file.uri);
      for (let start = 0; start < size; start += VIDEO_CHUNK_SIZE) {
        const end = Math.min(start + VIDEO_CHUNK_SIZE, size);
        const chunk = source.slice(start, end, file.type);
        const formData = createFormData(signature, file, chunk);
        const response = await axios.post<{
          public_id?: string;
          secure_url?: string;
        }>(
          uploadUrl,
          formData,
          {
            signal: options.signal,
            timeout: 60_000,
            headers: {
              "Content-Range": `bytes ${start}-${end - 1}/${size}`,
              "X-Unique-Upload-Id": signature.public_id,
            },
          },
        );
        result = response.data;
        options.onProgress?.(Math.min(90, Math.round((end / size) * 90)));
      }
    } else {
      const uploadFile = { uri: file.uri, name: file.name, type: file.type };
      const response = await axios.post<{
        public_id?: string;
        secure_url?: string;
      }>(
        uploadUrl,
        createFormData(signature, file, uploadFile),
        {
          signal: options.signal,
          timeout: 60_000,
          onUploadProgress(event) {
            if (event.total) {
              options.onProgress?.(
                Math.min(90, Math.round((event.loaded / event.total) * 90)),
              );
            }
          },
        },
      );
      result = response.data;
    }
    const expectedPublicId = signature.public_id;
    const receivedPublicId = result?.public_id;
    if (!result || typeof receivedPublicId !== "string" || !receivedPublicId) {
      throw new Error("Cloudinary n'a pas renvoyé d'identifiant public.");
    }
    if (receivedPublicId.split("/").at(-1) !== expectedPublicId.split("/").at(-1)) {
      throw new Error(
        `Cloudinary a renvoyé un identifiant public inattendu (code CLOUDINARY_PUBLIC_ID_MISMATCH). Attendu : ${expectedPublicId} ; reçu : ${receivedPublicId}.`,
      );
    }
    return {
      publicId: receivedPublicId,
      ...(typeof result.secure_url === "string"
        ? { secureUrl: result.secure_url }
        : {}),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const { status, message } = cloudinaryMessage(error);
    const technicalDetails = [
      "Étape : téléversement Cloudinary",
      `URL : ${uploadUrl}`,
      `Type de ressource : ${signature.resource_type}`,
      `Timestamp signé : ${signature.timestamp}`,
      "Paramètres signés : folder, public_id, timestamp",
      `public_id attendu : ${signature.public_id}`,
      `public_id reçu : ${result?.public_id ?? "absent"}`,
      `Statut HTTP : ${status ?? "indisponible"}`,
      `Message Cloudinary : ${message}`,
      `Code : ${
        status
          ? `CLOUDINARY_HTTP_${status}`
          : message.includes("CLOUDINARY_PUBLIC_ID_MISMATCH")
            ? "CLOUDINARY_PUBLIC_ID_MISMATCH"
            : "CLOUDINARY_UPLOAD_FAILED"
      }`,
    ].join("\n");
    console.error("Cloudinary upload failed:", {
      resourceType: signature.resource_type,
      status: status ?? null,
      message,
      expectedPublicId: signature.public_id,
      receivedPublicId: result?.public_id ?? null,
    });
    await reportCloudinaryUploadFailure(
      signature.resource_type,
      status ?? null,
      message,
      signature.public_id,
      result?.public_id ?? null,
    );
    throw new MediaUploadError(
      status
        ? `Cloudinary a refusé le téléversement (HTTP ${status}, code CLOUDINARY_HTTP_${status}) : ${message}`
        : `Le téléversement Cloudinary a échoué : ${message}`,
      technicalDetails,
    );
  }
};
