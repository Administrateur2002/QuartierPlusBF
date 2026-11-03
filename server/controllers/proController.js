import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { IS_PROMO_FREE_ACCESS } from "../config/monetization.js";

const FEATURE_SECTIONS = {
  ALLIANCE_PRO: ["STATISTIQUES", "OFFRES", "EPINGLE"],
  SYNDIC: ["COTISATIONS", "GARDIENNAGE"],
  TOWN_HALL: ["COMMUNIQUES", "SIGNALEMENTS"],
  SECURITY_AGENT: ["CONSOLE_SOS"],
  WHOLESALER: ["CATALOGUE", "COMMANDES"],
  TRANSPORT_COMPANY: ["SERVICES_TRANSPORT"],
};

export const getMySubscription = async (request, response, next) => {
  try {
    const [subscriptions, pins] = await Promise.all([
      pool.query(
        `SELECT plan_type, status, starts_at, expires_at
         FROM subscriptions
         WHERE user_id = $1
           AND status = 'ACTIVE'
           AND starts_at <= NOW()
           AND expires_at > NOW()
         ORDER BY expires_at DESC`,
        [request.auth.userId],
      ),
      pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM sponsored_pins
           WHERE user_id = $1 AND is_active = TRUE
             AND starts_at <= NOW() AND expires_at > NOW()
         ) AS active`,
        [request.auth.userId],
      ),
    ]);
    const activeSubscriptions = subscriptions.rows;
    const activeSpaces = activeSubscriptions.map((item) => item.plan_type);
    if (pins.rows[0]?.active === true) activeSpaces.push("SPONSORED_PIN");
    return response.status(200).json({
      subscription: activeSubscriptions[0] ?? null,
      active_subscriptions: activeSubscriptions,
      active_spaces: [...new Set(activeSpaces)],
      promo_free_access: IS_PROMO_FREE_ACCESS,
      billing_enabled: env.billingEnabled,
    });
  } catch (error) {
    return next(error);
  }
};

export const getProDashboard = async (request, response, next) => {
  try {
    const subscription =
      request.proSubscription ??
      (
        await pool.query(
          `SELECT plan_type, status, starts_at, expires_at
           FROM subscriptions
           WHERE user_id = $1
             AND status = 'ACTIVE'
             AND starts_at <= NOW()
             AND expires_at > NOW()
           ORDER BY expires_at DESC
           LIMIT 1`,
          [request.auth.userId],
        )
      ).rows[0];

    if (!subscription || !FEATURE_SECTIONS[subscription.plan_type]) {
      return response.status(403).json({
        error: "Un abonnement Pro actif est requis.",
      });
    }

    let metrics = {};
    if (subscription.plan_type === "ALLIANCE_PRO") {
      const result = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM marketplace_items WHERE seller_id = $1)
             AS offers_count,
           (SELECT COUNT(*)::int FROM sponsored_pins
            WHERE user_id = $1 AND is_active = TRUE AND expires_at > NOW())
             AS active_pins_count,
           (SELECT COUNT(*)::int FROM sponsored_pin_impressions impression
            JOIN sponsored_pins pin ON pin.id = impression.pin_id
            WHERE pin.user_id = $1) AS pin_views_count,
           (SELECT COUNT(*)::int FROM pro_map_impressions
            WHERE owner_id = $1) AS profile_views_count`,
        [request.auth.userId],
      );
      metrics = result.rows[0];
    } else if (subscription.plan_type === "TOWN_HALL") {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS reports_count
         FROM reports WHERE status = 'PENDING'`,
      );
      metrics = result.rows[0];
    } else if (subscription.plan_type === "SECURITY_AGENT") {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS active_sos_count
         FROM sos_alerts WHERE status = 'ACTIVE'`,
      );
      metrics = result.rows[0];
    }

    return response.status(200).json({
      plan_type: subscription.plan_type,
      starts_at: subscription.starts_at,
      expires_at: subscription.expires_at,
      sections: FEATURE_SECTIONS[subscription.plan_type],
      metrics,
    });
  } catch (error) {
    return next(error);
  }
};

export const listPublicProfessionals = async (request, response, next) => {
  const hasCoordinates =
    request.query.latitude !== undefined ||
    request.query.longitude !== undefined;
  const latitude = Number(request.query.latitude);
  const longitude = Number(request.query.longitude);
  const radius = Number(request.query.radius_m ?? 30_000);
  if (
    (hasCoordinates &&
      (!Number.isFinite(latitude) ||
        Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) ||
        Math.abs(longitude) > 180)) ||
    !Number.isFinite(radius) ||
    radius < 1 ||
    radius > 100_000
  ) {
    return response.status(400).json({ error: "Position ou rayon invalide." });
  }

  try {
    const result = await pool.query(
      `SELECT subscription.user_id AS owner_id, subscription.plan_type,
              subscription.publication->>'title' AS title,
              subscription.publication->>'description' AS description,
              subscription.publication->>'services' AS services,
              subscription.publication->>'opening_hours' AS opening_hours,
              subscription.publication->>'phone' AS phone,
              subscription.publication->>'whatsapp' AS whatsapp,
              subscription.publication->'offers' AS offers,
              profile.full_name AS owner_name,
              profile.badge AS owner_badge,
              (SELECT ROUND(AVG(review.rating)::numeric, 1)
               FROM pro_reviews review WHERE review.owner_id = subscription.user_id)
                 AS rating_average,
              (SELECT COUNT(*)::int
               FROM pro_reviews review WHERE review.owner_id = subscription.user_id)
                 AS review_count,
              COALESCE((
                SELECT json_agg(review_row ORDER BY review_row.created_at DESC)
                FROM (
                  SELECT review.rating, review.comment, review.created_at,
                         reviewer.full_name AS reviewer_name
                  FROM pro_reviews review
                  JOIN users reviewer ON reviewer.id = review.reviewer_id
                  WHERE review.owner_id = subscription.user_id
                  ORDER BY review.created_at DESC
                  LIMIT 3
                ) review_row
              ), '[]'::json) AS reviews,
              COALESCE((
                SELECT json_agg(catalog_item ORDER BY catalog_item.created_at DESC)
                FROM (
                  SELECT item.title, item.category, item.price_fcfa, item.created_at
                  FROM marketplace_items item
                  WHERE item.seller_id = subscription.user_id
                  ORDER BY item.created_at DESC
                  LIMIT 10
                ) catalog_item
              ), '[]'::json) AS catalog,
              ST_Y(location.point) AS latitude,
              ST_X(location.point) AS longitude,
              (SELECT COUNT(*)::int FROM pro_map_impressions impression
               WHERE impression.owner_id = subscription.user_id
                 AND impression.plan_type = subscription.plan_type) AS views_count
       FROM subscriptions subscription
       JOIN users profile ON profile.id = subscription.user_id
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN jsonb_typeof(subscription.publication->'latitude') = 'number'
             AND jsonb_typeof(subscription.publication->'longitude') = 'number'
           THEN CASE
             WHEN (subscription.publication->>'latitude')::double precision BETWEEN -90 AND 90
               AND (subscription.publication->>'longitude')::double precision BETWEEN -180 AND 180
             THEN ST_SetSRID(ST_MakePoint(
               (subscription.publication->>'longitude')::double precision,
               (subscription.publication->>'latitude')::double precision
             ), 4326)
             ELSE NULL
           END
           ELSE NULL
         END AS point
       ) location
       WHERE subscription.plan_type IN ('ALLIANCE_PRO', 'WHOLESALER', 'TRANSPORT_COMPANY')
         AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW()
         AND subscription.expires_at > NOW()
         AND subscription.publication->>'visible_on_map' = 'true'
         AND location.point IS NOT NULL
         AND ($1::boolean = FALSE OR ST_DWithin(
           location.point::geography,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           $4
         ))
       ORDER BY subscription.plan_type, title
       LIMIT 500`,
      [
        hasCoordinates,
        hasCoordinates ? longitude : null,
        hasCoordinates ? latitude : null,
        radius,
      ],
    );
    if (request.auth?.userId && hasCoordinates && result.rowCount) {
      await pool.query(
        `INSERT INTO pro_map_impressions (owner_id, plan_type, viewer_id)
         SELECT viewed.owner_id, viewed.plan_type, $3
         FROM unnest($1::uuid[], $2::text[]) AS viewed(owner_id, plan_type)
         WHERE viewed.owner_id <> $3
         ON CONFLICT DO NOTHING`,
        [
          result.rows.map((row) => row.owner_id),
          result.rows.map((row) => row.plan_type),
          request.auth.userId,
        ],
      );
    }
    return response.status(200).json({
      professionals: result.rows.map((row) => ({
        id: `pro:${row.owner_id}:${row.plan_type}`,
        category: "MERCHANT_PRO",
        title: row.title || row.owner_name || "Professionnel",
        description: row.description ?? "",
        services: row.services ?? "",
        opening_hours: row.opening_hours ?? "",
        phone: row.phone ?? "",
        whatsapp: row.whatsapp ?? "",
        offers: Array.isArray(row.offers) ? row.offers : [],
        owner_id: row.owner_id,
        plan_type: row.plan_type,
        badge: row.owner_badge,
        rating_average: row.rating_average === null ? null : Number(row.rating_average),
        review_count: row.review_count,
        reviews: Array.isArray(row.reviews) ? row.reviews : [],
        catalog: Array.isArray(row.catalog) ? row.catalog : [],
        coordinates: {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
        },
        status: "ACTIVE",
        is_sponsored: false,
        views_count: row.views_count,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

export const reviewProfessional = async (request, response, next) => {
  const ownerId = request.params.ownerId;
  const rating = request.body?.rating;
  const comment =
    typeof request.body?.comment === "string" ? request.body.comment.trim() : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId) ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5 ||
    comment.length > 500
  ) {
    return response.status(400).json({ error: "L’avis ou la note est invalide." });
  }
  if (ownerId === request.auth.userId) {
    return response.status(403).json({ error: "Vous ne pouvez pas évaluer votre propre vitrine." });
  }
  try {
    const activeProfessional = await pool.query(
      `SELECT 1 FROM subscriptions
       WHERE user_id = $1 AND plan_type IN ('ALLIANCE_PRO', 'WHOLESALER', 'TRANSPORT_COMPANY')
         AND status = 'ACTIVE' AND starts_at <= NOW() AND expires_at > NOW()
         AND publication->>'visible_on_map' = 'true'
       LIMIT 1`,
      [ownerId],
    );
    if (!activeProfessional.rowCount) {
      return response.status(404).json({ error: "Cette vitrine professionnelle est introuvable." });
    }
    const blocked = await pool.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
       LIMIT 1`,
      [request.auth.userId, ownerId],
    );
    if (blocked.rowCount) {
      return response.status(403).json({ error: "Vous ne pouvez pas évaluer cette vitrine." });
    }
    await pool.query(
      `INSERT INTO pro_reviews (owner_id, reviewer_id, rating, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, reviewer_id) DO UPDATE
       SET rating = EXCLUDED.rating,
           comment = EXCLUDED.comment,
           updated_at = NOW()`,
      [ownerId, request.auth.userId, rating, comment],
    );
    const stats = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS rating_average,
              COUNT(*)::int AS review_count
       FROM pro_reviews WHERE owner_id = $1`,
      [ownerId],
    );
    return response.status(200).json({
      reviewed: true,
      rating_average: Number(stats.rows[0].rating_average),
      review_count: stats.rows[0].review_count,
    });
  } catch (error) {
    return next(error);
  }
};
