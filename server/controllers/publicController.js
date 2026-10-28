import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

const CLOUDINARY_VARIABLES = [
  ["CLOUDINARY_CLOUD_NAME", env.cloudinaryCloudName],
  ["CLOUDINARY_API_KEY", env.cloudinaryApiKey],
  ["CLOUDINARY_API_SECRET", env.cloudinaryApiSecret],
];
const isCloudinaryValueMissing = (value) =>
  !value ||
  /(?:your[-_]|replace[-_]?with|fake|placeholder|changeme|example(?:\.|$))/i.test(
    value,
  );

export const getPublicConfig = (_request, response) =>
  response.status(200).json({ billingEnabled: env.billingEnabled });

export const getMediaStatus = (_request, response) => {
  const cloudinaryMissing = CLOUDINARY_VARIABLES
    .filter(([, value]) => isCloudinaryValueMissing(value))
    .map(([name]) => name);
  const livekitMissing = env.livekitConfigurationProblems;
  return response.status(200).json({
    cloudinaryConfigured: cloudinaryMissing.length === 0,
    livekitConfigured: env.livekitConfigurationIsUsable,
    missing: [...cloudinaryMissing, ...livekitMissing],
  });
};

const nearbyFilter = (query) => {
  const { latitude, longitude, radius_m: radius, scope } = query;
  const countryCode =
    typeof query.country_code === "string"
      ? query.country_code.trim().toUpperCase()
      : null;
  if (
    scope !== undefined &&
    !["neighborhood", "region", "country", "international"].includes(scope)
  ) {
    return null;
  }
  if (scope === "country" && !/^[A-Z]{2,3}$/.test(countryCode ?? "")) {
    return null;
  }
  if (
    (scope === "neighborhood" || scope === "region") &&
    countryCode !== null &&
    !/^[A-Z]{2,3}$/.test(countryCode)
  ) {
    return null;
  }
  if (scope === "neighborhood" && !countryCode) return null;
  if (scope === "country" || scope === "international") {
    return { values: [null, null, null, countryCode, scope] };
  }
  if (latitude === undefined && longitude === undefined && radius === undefined) {
    if (scope === "neighborhood" || scope === "region") return null;
    return { values: [null, null, null, countryCode, scope ?? null] };
  }

  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  const parsedRadius =
    scope === "region" ? 100_000 : Number(radius ?? 30_000);
  if (
    !Number.isFinite(parsedLatitude) ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    !Number.isFinite(parsedLongitude) ||
    parsedLongitude < -180 ||
    parsedLongitude > 180 ||
    !Number.isFinite(parsedRadius) ||
    parsedRadius < 1 ||
    parsedRadius > 100_000
  ) {
    return null;
  }
  return {
    values: [
      parsedLatitude,
      parsedLongitude,
      scope === "neighborhood" ? null : parsedRadius,
      countryCode,
      scope ?? null,
    ],
  };
};

export const listPublicMarketplace = async (_request, response, next) => {
  const filter = nearbyFilter(_request.query);
  if (!filter) {
    return response.status(400).json({
      error: "La position et le rayon de recherche sont invalides.",
    });
  }
  const requestedType =
    typeof _request.query.item_type === "string"
      ? _request.query.item_type.toLowerCase()
      : null;
  const requestedCategory =
    typeof _request.query.category === "string"
      ? _request.query.category.toUpperCase()
      : null;
  try {
    const result = await pool.query(
      `SELECT item.id, item.title, item.description, item.category,
              item.item_type,
              item.price_fcfa AS price, item.price_fcfa = 0 AS is_free,
              item.country_of_origin, item.created_at, user_profile.neighborhood,
              user_profile.id AS seller_id,
              CASE WHEN $8::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM user_alliances alliance
                WHERE alliance.status = 'ALLIED'
                  AND ((alliance.requester_id = $8 AND alliance.recipient_id = user_profile.id)
                    OR (alliance.recipient_id = $8 AND alliance.requester_id = user_profile.id))
              ) END AS seller_is_ally,
              CASE WHEN $8::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM user_alliances alliance
                WHERE alliance.status = 'PENDING'
                  AND alliance.requester_id = $8
                  AND alliance.recipient_id = user_profile.id
              ) END AS seller_alliance_pending,
              user_profile.full_name AS seller_name,
              user_profile.phone_number AS seller_phone,
              item.whatsapp_phone, item.image_urls[1] AS image_url
       FROM marketplace_items AS item
       LEFT JOIN users AS user_profile ON user_profile.id = item.seller_id
       WHERE CASE
         WHEN $5 = 'international' THEN TRUE
         WHEN $5 = 'country' THEN user_profile.country_code = $4
         WHEN $5 = 'neighborhood' THEN ST_DWithin(
           item.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           COALESCE(
             (SELECT default_radius_m FROM country_config WHERE code = $4),
             5000
           )
         )
         WHEN $5 = 'region' THEN ST_DWithin(
           item.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           100000
         )
         ELSE $1::double precision IS NULL OR ST_DWithin(
           item.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           $3
         )
       END
         AND ($6::text IS NULL OR item.item_type = $6)
         AND (
           $7::text IS NULL OR
           UPPER(REGEXP_REPLACE(TRANSLATE(
             item.category,
             'ÉÈÊËÀÂÄÎÏÔÖÙÛÜÇéèêëàâäîïôöùûüç',
             'EEEEAAAIIOOUUUCeeeeaaaiioouuuc'
           ), '[^A-Za-z0-9]+', '_', 'g')) = $7
         )
       ORDER BY item.created_at DESC
       LIMIT 100`,
      [
        ...filter.values,
        requestedType,
        requestedCategory === "SERVICE" || requestedCategory === "MADE_IN"
          ? null
          : requestedCategory,
        _request.auth?.userId ?? null,
      ],
    );
    return response.status(200).json({ items: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listNearbyAlerts = async (request, response, next) => {
  const filter = nearbyFilter(request.query);
  if (!filter) {
    return response.status(400).json({
      error: "La position et le rayon de recherche sont invalides.",
    });
  }
  try {
    const result = await pool.query(
      `SELECT alert.id, alert.emergency_type, alert.status, alert.created_at,
              ROUND(ST_Distance(
                alert.location::geography,
                ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
              ) / 100) * 100 AS distance_m,
              ST_Y(ST_SnapToGrid(alert.location, 0.002)) AS latitude,
              ST_X(ST_SnapToGrid(alert.location, 0.002)) AS longitude
       FROM sos_alerts AS alert
       LEFT JOIN users AS alert_author ON alert_author.id = alert.user_id
       WHERE alert.status = 'ACTIVE'
         AND CASE
           WHEN $5 = 'international' THEN TRUE
           WHEN $5 = 'country' THEN alert_author.country_code = $4
           WHEN $5 = 'neighborhood' THEN ST_DWithin(
             alert.location::geography,
             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
             COALESCE(
               (SELECT default_radius_m FROM country_config WHERE code = $4),
               5000
             )
           )
           WHEN $5 = 'region' THEN ST_DWithin(
             alert.location::geography,
             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
             100000
           )
           ELSE $1::double precision IS NULL OR ST_DWithin(
           alert.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           $3
         ) END
       ORDER BY alert.created_at DESC
       LIMIT 100`,
      filter.values,
    );
    return response.status(200).json({ alerts: result.rows });
  } catch (error) {
    return next(error);
  }
};
