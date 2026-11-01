import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import {
  createCloudinaryUploadSignature,
  deleteCloudinaryAsset,
  getCloudinaryAsset,
  hasGpsMetadata,
  isCloudinaryPublicIdOwnedByUser,
} from "../services/cloudinary.js";

const profileQuery = `
  SELECT id, phone_number, email, google_id, full_name, neighborhood, role,
         country_code, reputation_score, is_verified, phone_verified_at, badge,
         profile_photo_url
  FROM users
  WHERE id = $1
`;

const formatProfile = (user) => ({
  id: user.id,
  phone_number: user.phone_number,
  email: user.email,
  google_id: user.google_id,
  name: user.full_name,
  neighborhood: user.neighborhood,
  role: user.role,
  country_code: user.country_code,
  reputation_score: user.reputation_score,
  is_verified: user.is_verified,
  phone_verified_at: user.phone_verified_at,
  badge: user.badge,
  profile_photo_url: user.profile_photo_url,
});

export const signProfilePhotoUpload = async (request, response, next) => {
  try {
    const userId = request.auth.userId;
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "quartierplus/profiles";
    const publicId = `${userId}_${randomUUID()}`;
    const signature = createCloudinaryUploadSignature({
      folder,
      public_id: publicId,
      timestamp,
    });
    return response.status(200).json({
      ...signature,
      folder,
      public_id: publicId,
      resource_type: "image",
      timestamp,
      max_bytes: env.postMaxPhotoBytes,
    });
  } catch (error) {
    return next(error);
  }
};

export const updateCurrentUserPhoto = async (request, response, next) => {
  const publicId =
    typeof request.body?.profile_photo_public_id === "string"
      ? request.body.profile_photo_public_id.trim()
      : "";
  const userId = request.auth.userId;
  if (
    !publicId ||
    publicId.length > 255 ||
    !isCloudinaryPublicIdOwnedByUser(userId, publicId)
  ) {
    return response.status(400).json({ error: "La photo téléversée ne vous appartient pas." });
  }
  try {
    const asset = await getCloudinaryAsset("image", publicId);
    if (
      !asset ||
      asset.public_id !== publicId ||
      typeof asset.secure_url !== "string" ||
      !asset.secure_url.startsWith(
        `https://res.cloudinary.com/${env.cloudinaryCloudName}/`,
      ) ||
      !["jpg", "jpeg", "png", "webp"].includes(String(asset.format).toLowerCase()) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > env.postMaxPhotoBytes
    ) {
      return response.status(400).json({ error: "La photo téléversée est invalide." });
    }
    if (hasGpsMetadata(asset.image_metadata)) {
      await deleteCloudinaryAsset("image", publicId);
      return response.status(400).json({
        error: "La photo contient des coordonnées GPS et a été supprimée.",
      });
    }
    const result = await pool.query(
      `UPDATE users
       SET profile_photo_public_id = $1, profile_photo_url = $2
       WHERE id = $3
       RETURNING profile_photo_url`,
      [publicId, asset.secure_url, userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    return response.status(200).json({
      profile_photo_url: result.rows[0].profile_photo_url,
    });
  } catch (error) {
    return next(error);
  }
};

export const getCurrentUser = async (request, response, next) => {
  try {
    const result = await pool.query(profileQuery, [request.auth.userId]);
    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    return response.status(200).json({ user: formatProfile(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
};

export const updateCurrentUser = async (request, response, next) => {
  const name =
    typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const neighborhood =
    typeof request.body?.neighborhood === "string"
      ? request.body.neighborhood.trim()
      : "";
  const countryCode =
    typeof request.body?.country_code === "string"
      ? request.body.country_code.trim().toUpperCase()
      : "";
  if (!name || name.length > 100 || neighborhood.length > 100) {
    return response.status(400).json({
      error: "Le nom (1 à 100 caractères) et le quartier (100 caractères max) sont requis.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET full_name = $1,
           neighborhood = $2,
           country_code = COALESCE(NULLIF($3, ''), country_code)
       WHERE id = $4
       RETURNING id, phone_number, email, google_id, full_name, neighborhood,
                 role, country_code, reputation_score, is_verified,
                 phone_verified_at, badge, profile_photo_url`,
      [name, neighborhood || null, countryCode, request.auth.userId],
    );
    if (result.rowCount === 0) {
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    return response.status(200).json({ user: formatProfile(result.rows[0]) });
  } catch (error) {
    if (error.code === "23503") {
      return response.status(400).json({ error: "Code pays inconnu." });
    }
    return next(error);
  }
};

export const listMyMarketplaceItems = async (request, response, next) => {
  const itemType =
    typeof request.query.item_type === "string"
      ? request.query.item_type
      : null;
  if (
    itemType !== null &&
    !["all", "products", "listing", "local", "service"].includes(itemType)
  ) {
    return response.status(400).json({ error: "Type d'annonce invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT id, title, description, price_fcfa AS price,
              price_fcfa = 0 AS is_free, category, item_type, created_at,
              image_urls[1] AS image_url
       FROM marketplace_items
       WHERE seller_id = $1
         AND (
           $2::text IS NULL OR $2 = 'all' OR
           ($2 = 'products' AND item_type IN ('listing', 'local')) OR
           item_type = $2
         )
       ORDER BY created_at DESC
       LIMIT 100`,
      [request.auth.userId, itemType],
    );
    return response.status(200).json({ items: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listMyAlertsAndReports = async (request, response, next) => {
  try {
    const [alerts, reports] = await Promise.all([
      pool.query(
        `SELECT id, emergency_type, status, created_at
         FROM sos_alerts
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [request.auth.userId],
      ),
      pool.query(
        `SELECT id, target_type, reason, status, created_at
         FROM reports
         WHERE reporter_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [request.auth.userId],
      ),
    ]);
    return response.status(200).json({
      alerts: alerts.rows,
      reports: reports.rows,
    });
  } catch (error) {
    return next(error);
  }
};
