import { env } from "../config/env.js";
import {
  deleteCloudinaryAsset,
  getCloudinaryAsset,
  hasGpsMetadata,
  isCloudinaryPublicIdOwnedByUser,
} from "./cloudinary.js";

export const verifyMessageMedia = async ({ userId, mediaUrl, mediaType, mediaPublicId }) => {
  if (!["image", "video", "audio"].includes(mediaType)) {
    return { error: "Le type de média est invalide." };
  }
  if (!isCloudinaryPublicIdOwnedByUser(userId, mediaPublicId)) {
    return { error: "Le média ne vous appartient pas." };
  }
  const cloudinaryType = mediaType === "audio" ? "video" : mediaType;
  const asset = await getCloudinaryAsset(cloudinaryType, mediaPublicId);
  const maxBytes = mediaType === "image" ? env.postMaxPhotoBytes : env.postMaxVideoBytes;
  const allowedFormat = mediaType === "image"
    ? ["jpg", "jpeg", "png", "webp"].includes(String(asset?.format).toLowerCase())
    : mediaType === "audio"
      ? ["m4a", "mp3", "aac", "wav", "ogg"].includes(String(asset?.format).toLowerCase())
      : String(asset?.format).toLowerCase() === "mp4";
  if (
    !asset ||
    asset.public_id !== mediaPublicId ||
    asset.secure_url !== mediaUrl ||
    !mediaUrl.startsWith(`https://res.cloudinary.com/${env.cloudinaryCloudName}/`) ||
    !allowedFormat ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > maxBytes ||
    ((mediaType === "video" || mediaType === "audio") &&
      (!Number.isFinite(Number(asset.duration)) ||
        Number(asset.duration) <= 0 ||
        Number(asset.duration) > env.postMaxVideoSeconds))
  ) {
    return { error: "Le média est invalide ou dépasse les limites autorisées." };
  }
  if (mediaType === "image" && hasGpsMetadata(asset.image_metadata)) {
    await deleteCloudinaryAsset(mediaType, mediaPublicId);
    return { error: "La photo contenait des coordonnées GPS et a été supprimée." };
  }
  return { mediaUrl, mediaType };
};