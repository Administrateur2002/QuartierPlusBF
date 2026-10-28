import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import {
  createCloudinaryUploadSignature,
  deleteCloudinaryAsset,
  hasGpsMetadata,
  getCloudinaryAsset,
  isCloudinaryPublicIdOwnedByUser,
} from "../services/cloudinary.js";

const SCOPES = new Set(["neighborhood", "region", "country", "international"]);
const IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "webp"]);
const VIDEO_FORMATS = new Set(["mp4"]);
const GEO_CELL_LATITUDE_DEGREES = 200 / 111_320;

const parseCoordinates = (latitude, longitude) => {
  if (latitude === undefined && longitude === undefined) return null;
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  if (
    !Number.isFinite(parsedLatitude) ||
    Math.abs(parsedLatitude) > 90 ||
    !Number.isFinite(parsedLongitude) ||
    Math.abs(parsedLongitude) > 180
  ) {
    return undefined;
  }
  return { latitude: parsedLatitude, longitude: parsedLongitude };
};

export const roundCoordinatesTo200mGrid = ({ latitude, longitude }) => {
  const latitudeStep = GEO_CELL_LATITUDE_DEGREES;
  const longitudeStep = Math.min(
    360,
    200 /
      (111_320 *
        Math.max(Math.abs(Math.cos((latitude * Math.PI) / 180)), 1e-12)),
  );
  const roundedLatitude = Math.round(latitude / latitudeStep) * latitudeStep;
  const roundedLongitude =
    Math.round(longitude / longitudeStep) * longitudeStep;
  const normalizedLongitude =
    ((((roundedLongitude + 180) % 360) + 360) % 360) - 180;
  return {
    latitude: Number(roundedLatitude.toFixed(6)),
    longitude: Number(normalizedLongitude.toFixed(6)),
  };
};

const isPhoneVerified = (user) =>
  Boolean(user?.phone_number && user?.phone_verified_at);

const findUser = async (userId) => {
  const result = await pool.query(
    "SELECT id, phone_number, phone_verified_at, country_code FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
};

const requireVerifiedPhone = async (userId, response) => {
  const user = await findUser(userId);
  if (!user) {
    response.status(404).json({ error: "Utilisateur introuvable." });
    return null;
  }
  if (!isPhoneVerified(user)) {
    response.status(403).json({
      error: "Vérifiez votre numéro de téléphone avant de publier.",
    });
    return null;
  }
  return user;
};

export const signMediaUpload = async (request, response, next) => {
  try {
    const user = await requireVerifiedPhone(request.auth.userId, response);
    if (!user) return;
    const mediaType = request.body?.media_type;
    if (mediaType !== "image" && mediaType !== "video") {
      return response.status(400).json({ error: "Type de média invalide." });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "quartierplus/posts";
    const publicId = `${user.id}_${randomUUID()}`;
    const signature = createCloudinaryUploadSignature({
      folder,
      public_id: publicId,
      timestamp,
    });
    return response.status(200).json({
      ...signature,
      folder,
      public_id: publicId,
      resource_type: mediaType,
      timestamp,
      max_bytes:
        mediaType === "image"
          ? env.postMaxPhotoBytes
          : env.postMaxVideoBytes,
      max_duration_seconds:
        mediaType === "video" ? env.postMaxVideoSeconds : null,
    });
  } catch (error) {
    return next(error);
  }
};

export const logMediaUploadFailure = (request, response) => {
  const {
    media_type: mediaType,
    status,
    message,
    expected_public_id: expectedPublicId,
    received_public_id: receivedPublicId,
  } = request.body ?? {};
  if (
    !["image", "video"].includes(mediaType) ||
    !(status === null || (Number.isInteger(status) && status >= 100 && status <= 599)) ||
    typeof message !== "string" ||
    message.trim().length === 0
  ) {
    return response.status(400).json({ error: "Détails d'erreur invalides." });
  }
  const safeMessage = message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 500);
  console.error("Cloudinary client upload failed:", {
    userId: request.auth.userId,
    resourceType: mediaType,
    status,
    message: safeMessage,
    ...(typeof expectedPublicId === "string"
      ? {
          expectedPublicId: expectedPublicId
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .slice(0, 255),
        }
      : {}),
    ...(typeof receivedPublicId === "string"
      ? {
          receivedPublicId: receivedPublicId
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .slice(0, 255),
        }
      : {}),
  });
  return response.status(204).end();
};

const getVerifiedAsset = async (userId, mediaPublicId, mediaType) => {
  if (
    typeof mediaPublicId !== "string" ||
    mediaPublicId.length > 255 ||
    !isCloudinaryPublicIdOwnedByUser(userId, mediaPublicId)
  ) {
    return { error: "Le média téléversé ne vous appartient pas." };
  }
  const asset = await getCloudinaryAsset(mediaType, mediaPublicId);
  if (!asset || asset.public_id !== mediaPublicId) {
    console.error("Cloudinary public ID mismatch:", {
      expectedPublicId: mediaPublicId,
      receivedPublicId: asset?.public_id ?? null,
    });
    return { error: "Le média téléversé est introuvable ou invalide." };
  }
  if (mediaType === "image" && hasGpsMetadata(asset.image_metadata)) {
    await deleteCloudinaryAsset(mediaType, mediaPublicId);
    return {
      error: "La photo contenait des coordonnées GPS et a été supprimée.",
    };
  }
  if (
    typeof asset.secure_url !== "string" ||
    !asset.secure_url.startsWith(
      `https://res.cloudinary.com/${env.cloudinaryCloudName}/`,
    )
  ) {
    return { error: "L’adresse sécurisée du média est invalide." };
  }
  const allowedFormats = mediaType === "image" ? IMAGE_FORMATS : VIDEO_FORMATS;
  const format = String(asset.format ?? "").toLowerCase();
  if (!allowedFormats.has(format)) {
    return { error: "Format accepté : JPG, PNG, WebP ou MP4." };
  }
  const maxBytes =
    mediaType === "image" ? env.postMaxPhotoBytes : env.postMaxVideoBytes;
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > maxBytes) {
    return {
      error:
        mediaType === "image"
          ? "La photo dépasse la limite de taille autorisée."
          : "La vidéo dépasse la limite de taille autorisée.",
    };
  }
  const duration =
    mediaType === "video" ? Number(asset.duration) : null;
  if (
    mediaType === "video" &&
    (!Number.isFinite(duration) ||
      duration <= 0 ||
      duration > env.postMaxVideoSeconds)
  ) {
    return {
      error: `La vidéo doit durer au maximum ${env.postMaxVideoSeconds} secondes.`,
    };
  }
  return {
    asset,
    format,
    duration,
  };
};

export const createPost = async (request, response, next) => {
  const scope = request.body?.scope;
  const mediaType = request.body?.media_type;
  const hasMedia = mediaType !== null && mediaType !== undefined;
  const caption =
    typeof request.body?.caption === "string" ? request.body.caption.trim() : "";
  const coordinates = parseCoordinates(
    request.body?.latitude,
    request.body?.longitude,
  );
  if (!SCOPES.has(scope)) {
    return response.status(400).json({ error: "La portée choisie est invalide." });
  }
  if (hasMedia && mediaType !== "image" && mediaType !== "video") {
    return response.status(400).json({ error: "Type de média invalide." });
  }
  if (caption.length > 1000) {
    return response.status(400).json({
      error: "La légende ne peut pas dépasser 1 000 caractères.",
    });
  }
  if (coordinates === undefined) {
    return response.status(400).json({ error: "La position est invalide." });
  }
  if (
    ["neighborhood", "region"].includes(scope) &&
    coordinates === null
  ) {
    return response.status(400).json({
      error: "La localisation est nécessaire pour cette portée.",
    });
  }

  try {
    const user = await requireVerifiedPhone(request.auth.userId, response);
    if (!user) return;
    if (["neighborhood", "region", "country"].includes(scope) && !user.country_code) {
      return response.status(400).json({
        error: "Le pays du compte doit être configuré avant de publier.",
      });
    }
    const media = hasMedia
      ? await getVerifiedAsset(
          user.id,
          request.body?.media_public_id,
          mediaType,
        )
      : null;
    if (media?.error) return response.status(400).json({ error: media.error });
    const roundedPosition = coordinates
      ? roundCoordinatesTo200mGrid(coordinates)
      : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockedUser = await client.query(
        `SELECT id, phone_number, phone_verified_at, country_code
         FROM users WHERE id = $1 FOR UPDATE`,
        [user.id],
      );
      const currentUser = lockedUser.rows[0];
      if (!isPhoneVerified(currentUser)) {
        await client.query("ROLLBACK");
        return response.status(403).json({
          error: "Vérifiez votre numéro de téléphone avant de publier.",
        });
      }
      const dailyPosts = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM posts
         WHERE author_id = $1
           AND created_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
             AT TIME ZONE 'UTC'`,
        [user.id],
      );
      if (dailyPosts.rows[0].count >= env.postDailyLimit) {
        await client.query("ROLLBACK");
        return response.status(429).json({
          error: `La limite de ${env.postDailyLimit} publications par jour est atteinte.`,
        });
      }
      const result = await client.query(
        `INSERT INTO posts (
           author_id, scope, country_code, location, caption, media_public_id,
           media_url, media_type, media_format, media_bytes,
           media_duration_seconds
         )
         VALUES (
           $1, $2, $3,
           CASE WHEN $4::double precision IS NULL THEN NULL
             ELSE ST_SetSRID(ST_MakePoint($5, $4), 4326) END,
           $6, $7, $8, $9, $10, $11, $12
         )
         RETURNING id, caption, scope, media_url, media_type, created_at`,
        [
          user.id,
          scope,
          currentUser.country_code,
          roundedPosition?.latitude ?? null,
          roundedPosition?.longitude ?? null,
          caption,
          media?.asset.public_id ?? null,
          media?.asset.secure_url ?? null,
          mediaType,
          media?.format ?? null,
          media?.asset.bytes ?? null,
          media?.duration ?? null,
        ],
      );
      await client.query("COMMIT");
      return response.status(201).json({ post: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
};

export const listFeed = async (request, response, next) => {
  const scope = request.query.scope;
  const countryCode =
    typeof request.query.country_code === "string"
      ? request.query.country_code.trim().toUpperCase()
      : null;
  const coordinates = parseCoordinates(
    request.query.latitude,
    request.query.longitude,
  );
  if (!SCOPES.has(scope)) {
    return response.status(400).json({ error: "La portée choisie est invalide." });
  }
  if (coordinates === undefined) {
    return response.status(400).json({ error: "La position est invalide." });
  }
  if (
    (scope === "neighborhood" || scope === "region") &&
    (!coordinates || !/^[A-Z]{2,3}$/.test(countryCode ?? ""))
  ) {
    return response.status(400).json({
      error: "La position et le pays sont nécessaires pour cette portée.",
    });
  }
  if (scope === "country" && !/^[A-Z]{2,3}$/.test(countryCode ?? "")) {
    return response.status(400).json({ error: "Le pays choisi est invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT post.id, post.caption, post.scope, post.media_url,
              post.media_type, post.created_at, post.author_id,
              author.full_name AS author_name,
              (SELECT COUNT(*)::int FROM post_likes like_row
               WHERE like_row.post_id = post.id) AS likes_count,
              (SELECT COUNT(*)::int FROM post_comments comment_row
               WHERE comment_row.post_id = post.id) AS comments_count,
              CASE WHEN $5::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM post_likes like_row
                WHERE like_row.post_id = post.id AND like_row.user_id = $5
              ) END AS liked_by_me,
              CASE WHEN $5::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM user_alliances alliance
                WHERE alliance.status = 'ALLIED'
                  AND ((alliance.requester_id = $5 AND alliance.recipient_id = post.author_id)
                    OR (alliance.recipient_id = $5 AND alliance.requester_id = post.author_id))
              ) END AS author_is_ally
       FROM posts AS post
       JOIN users AS author ON author.id = post.author_id
       WHERE post.status = 'ACTIVE'
         AND CASE
           WHEN $1 = 'international' THEN TRUE
           WHEN $1 = 'country' THEN
             post.scope = 'international' OR post.country_code = $2
           WHEN $1 = 'region' THEN
             post.scope = 'international'
             OR (post.scope = 'country' AND post.country_code = $2)
             OR (
               post.scope IN ('neighborhood', 'region')
               AND ST_DWithin(
                 post.location::geography,
                 ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
                 100000
               )
             )
           WHEN $1 = 'neighborhood' THEN
             post.scope = 'international'
             OR (post.scope = 'country' AND post.country_code = $2)
             OR (
               post.scope = 'region' AND ST_DWithin(
                 post.location::geography,
                 ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
                 100000
               )
             )
             OR (
               post.scope = 'neighborhood' AND ST_DWithin(
                 post.location::geography,
                 ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
                 COALESCE(
                   (SELECT default_radius_m FROM country_config WHERE code = $2),
                   5000
                 )
               )
             )
         END
       ORDER BY author_is_ally DESC, post.created_at DESC
       LIMIT 100`,
      [
        scope,
        countryCode,
        coordinates?.latitude ?? null,
        coordinates?.longitude ?? null,
        request.auth?.userId ?? null,
      ],
    );
    return response.status(200).json({ posts: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const deletePost = async (request, response, next) => {
  try {
    const result = await pool.query(
      `UPDATE posts SET status = 'DELETED'
       WHERE id = $1 AND author_id = $2 AND status = 'ACTIVE'
       RETURNING id`,
      [request.params.id, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Publication introuvable." });
    }
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
};

export const reportPost = async (request, response, next) => {
  const reason =
    typeof request.body?.reason === "string"
      ? request.body.reason.trim().slice(0, 500)
      : "Contenu inapproprié";
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const post = await client.query(
        "SELECT id FROM posts WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
        [request.params.id],
      );
      if (!post.rowCount) {
        await client.query("ROLLBACK");
        return response.status(404).json({ error: "Publication introuvable." });
      }
      const priorReport = await client.query(
        `SELECT id FROM reports
         WHERE target_type = 'POST' AND target_id = $1 AND reporter_id = $2`,
        [request.params.id, request.auth.userId],
      );
      if (priorReport.rowCount) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "Vous avez déjà signalé cette publication.",
        });
      }
      await client.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, status)
         VALUES ($1, 'POST', $2, $3, 'PENDING')`,
        [request.auth.userId, request.params.id, reason || "Contenu inapproprié"],
      );
      const pendingReports = await client.query(
        `SELECT COUNT(*)::int AS count FROM reports
         WHERE target_type = 'POST' AND target_id = $1 AND status = 'PENDING'`,
        [request.params.id],
      );
      const hidden =
        pendingReports.rows[0].count >= 3;
      if (hidden) {
        await client.query(
          "UPDATE posts SET status = 'HIDDEN' WHERE id = $1",
          [request.params.id],
        );
      }
      await client.query("COMMIT");
      return response.status(201).json({
        reported: true,
        hidden_pending_moderation: hidden,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
};
