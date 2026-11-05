import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import {
  createCloudinaryUploadSignature,
  deleteCloudinaryAsset,
  getCloudinaryAsset,
  getCloudinaryAssetReference,
  hasGpsMetadata,
  isCloudinaryPublicIdOwnedByUser,
} from "../services/cloudinary.js";
import { reserveDailyMediaUpload } from "../services/usageLimits.js";

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
    if (!(await reserveDailyMediaUpload(userId))) {
      return response.status(429).json({
        error: "Vous avez atteint la limite quotidienne de téléversements.",
        code: "UPLOAD_DAILY_LIMIT_REACHED",
      });
    }
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

const quoteIdentifier = (identifier) =>
  `"${String(identifier).replaceAll('"', '""')}"`;

const getUserForeignKeys = async (client) => {
  const result = await client.query(
    `SELECT constraint_name, table_schema, table_name, column_name,
            ordinal_position
     FROM information_schema.key_column_usage
     WHERE table_schema = 'public'
       AND referenced_table_schema = 'public'
       AND referenced_table_name = 'users'
       AND referenced_column_name = 'id'
     ORDER BY table_name, constraint_name, ordinal_position`,
  );
  const tables = new Map();
  for (const row of result.rows) {
    if (row.table_name === "users") continue;
    const table = tables.get(row.table_name) ?? {
      schema: row.table_schema,
      constraints: new Map(),
    };
    const columns = table.constraints.get(row.constraint_name) ?? [];
    columns.push(row.column_name);
    table.constraints.set(row.constraint_name, columns);
    tables.set(row.table_name, table);
  }
  return tables;
};

const getUserLinkedRows = async (client, userId, mediaOnly = false) => {
  const tables = await getUserForeignKeys(client);
  const related = {};
  for (const [tableName, table] of tables) {
    let columns = null;
    if (mediaOnly) {
      const mediaColumnResult = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name ~* '(media|image|photo|asset|public_id|avatar|icon|url)'`,
        [table.schema, tableName],
      );
      columns = mediaColumnResult.rows.map((row) => row.column_name);
      if (columns.length === 0) continue;
    }
    const tableReference =
      `${quoteIdentifier(table.schema)}.${quoteIdentifier(tableName)}`;
    const where = [...table.constraints.values()]
      .map((columns) =>
        columns
          .map((column) => `record_data.${quoteIdentifier(column)} = $1`)
          .join(" AND "),
      )
      .map((constraint) => `(${constraint})`)
      .join(" OR ");
    const selectedColumns = mediaOnly
      ? columns.map(quoteIdentifier).join(", ")
      : "*";
    const result = await client.query(
      `SELECT to_jsonb(record_data) AS data
       FROM (
         SELECT ${selectedColumns}
         FROM ${tableReference} AS record_data
         WHERE ${where}
       ) AS record_data`,
      [userId],
    );
    related[tableName] = result.rows.map((row) => row.data);
  }
  return related;
};

const exportUserData = async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const user = await client.query(
      `SELECT (to_jsonb(account) - 'last_location') ||
                jsonb_build_object(
                  'last_location',
                  CASE WHEN account.last_location IS NULL
                    THEN NULL
                    ELSE ST_AsGeoJSON(account.last_location)::jsonb
                  END
                ) AS data
       FROM users AS account
       WHERE account.id = $1`,
      [request.auth.userId],
    );
    if (!user.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    const related = await getUserLinkedRows(client, request.auth.userId);
    const ownedProducts = await client.query(
      `SELECT to_jsonb(product) AS data
       FROM pro_products AS product
       JOIN pro_wholesalers AS wholesaler
         ON wholesaler.id = product.wholesaler_id
       WHERE wholesaler.user_id = $1`,
      [request.auth.userId],
    );
    related.owned_pro_products = ownedProducts.rows.map((row) => row.data);
    const messages = await client.query(
      `SELECT to_jsonb(message) AS data
       FROM private_messages AS message
       WHERE message.conversation_id IN (
         SELECT participant.conversation_id
         FROM conversation_participants AS participant
         WHERE participant.user_id = $1
       )
       ORDER BY message.created_at`,
      [request.auth.userId],
    );
    related.private_messages = messages.rows.map((row) => row.data);
    await client.query("COMMIT");
    response.set("Cache-Control", "no-store");
    response.set(
      "Content-Disposition",
      `attachment; filename="quartierplus-data-${request.auth.userId}.json"`,
    );
    return response.status(200).json({
      exported_at: new Date().toISOString(),
      app: "QuartierPlus",
      user: user.rows[0].data,
      related,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
};

const collectCloudinaryReferences = (userId, record, references) => {
  if (!record || typeof record !== "object") return;
  const mediaType = String(
    record.media_type ?? record.resource_type ?? record.media_format ?? "",
  ).toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      if (key.toLowerCase().endsWith("public_id")) {
        if (isCloudinaryPublicIdOwnedByUser(userId, item)) {
          references.set(`${mediaType === "video" || mediaType === "mp4" ? "video" : "image"}:${item}`, {
            resourceType:
              mediaType === "video" || mediaType === "mp4" ? "video" : "image",
            publicId: item,
          });
        }
      } else if (key.toLowerCase().includes("url")) {
        const reference = getCloudinaryAssetReference(item);
        if (
          reference &&
          isCloudinaryPublicIdOwnedByUser(userId, reference.publicId)
        ) {
          references.set(
            `${reference.resourceType}:${reference.publicId}`,
            reference,
          );
        }
      }
    }
  }
};

export const deleteCurrentUser = async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await client.query(
      "SELECT profile_photo_public_id FROM users WHERE id = $1 FOR UPDATE",
      [request.auth.userId],
    );
    if (!account.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }

    const mediaRows = await getUserLinkedRows(
      client,
      request.auth.userId,
      true,
    );
    const ownedProductMedia = await client.query(
      `SELECT to_jsonb(product) AS data
       FROM pro_products AS product
       JOIN pro_wholesalers AS wholesaler
         ON wholesaler.id = product.wholesaler_id
       WHERE wholesaler.user_id = $1`,
      [request.auth.userId],
    );
    const ownedWholesalerIds = [
      ...new Set(
        ownedProductMedia.rows
          .map((row) => row.data.wholesaler_id)
          .filter((id) => typeof id === "string"),
      ),
    ];
    const references = new Map();
    if (account.rows[0].profile_photo_public_id) {
      collectCloudinaryReferences(
        request.auth.userId,
        { profile_photo_public_id: account.rows[0].profile_photo_public_id },
        references,
      );
    }
    for (const rows of Object.values(mediaRows)) {
      for (const row of rows) {
        collectCloudinaryReferences(request.auth.userId, row, references);
      }
    }
    for (const row of ownedProductMedia.rows) {
      collectCloudinaryReferences(request.auth.userId, row.data, references);
    }
    for (const reference of references.values()) {
      await deleteCloudinaryAsset(reference.resourceType, reference.publicId);
    }

    await client.query(
      `UPDATE pro_orders
       SET buyer_id = NULL,
           address = '',
           delivery_latitude = NULL,
           delivery_longitude = NULL,
           notes = '',
           handoff_code_hash = repeat('0', 64)
       WHERE buyer_id = $1`,
      [request.auth.userId],
    );
    await client.query(
      "UPDATE pro_orders SET deliverer_id = NULL WHERE deliverer_id = $1",
      [request.auth.userId],
    );
    await client.query(
      "UPDATE pro_wholesalers SET user_id = NULL, is_active = FALSE WHERE user_id = $1",
      [request.auth.userId],
    );
    if (ownedWholesalerIds.length > 0) {
      await client.query(
        `UPDATE pro_products SET photo_url = NULL
         WHERE wholesaler_id = ANY($1::uuid[])`,
        [ownedWholesalerIds],
      );
    }
    const ownedVoyageCompanies = await client.query(
      "SELECT id FROM voy_companies WHERE owner_id = $1",
      [request.auth.userId],
    );
    const companyIds = ownedVoyageCompanies.rows.map((row) => row.id);
    if (companyIds.length > 0) {
      await client.query(
        `UPDATE voy_routes SET is_active = FALSE
         WHERE company_id = ANY($1::uuid[])`,
        [companyIds],
      );
      await client.query(
        `UPDATE voy_tickets
         SET status = 'CANCELLED', signature = ''
         WHERE trip_id IN (
           SELECT trips.id
           FROM voy_trips AS trips
           JOIN voy_routes AS routes ON routes.id = trips.route_id
           WHERE routes.company_id = ANY($1::uuid[])
         )`,
        [companyIds],
      );
      await client.query(
        "UPDATE voy_companies SET owner_id = NULL WHERE id = ANY($1::uuid[])",
        [companyIds],
      );
    }
    await client.query(
      `UPDATE voy_tickets
       SET traveler_id = NULL, status = 'CANCELLED', signature = ''
       WHERE traveler_id = $1`,
      [request.auth.userId],
    );
    await client.query(
      `UPDATE voy_parcels
       SET sender_id = NULL, status = 'CANCELLED', pickup_code_hash = repeat('0', 64)
       WHERE sender_id = $1`,
      [request.auth.userId],
    );
    const deleted = await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING id",
      [request.auth.userId],
    );
    if (!deleted.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    await client.query("COMMIT");
    response.set("Cache-Control", "no-store");
    return response.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
};

export { exportUserData };

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
