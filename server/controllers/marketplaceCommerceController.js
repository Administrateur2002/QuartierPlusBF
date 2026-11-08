import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_TRANSITIONS = {
  SENT: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["SHIPPED", "DELIVERED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

const httpError = (status, code, message) =>
  Object.assign(new Error(message), { status, code });
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) => UUID_PATTERN.test(String(value ?? ""));
const cleanString = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export const isAllowedMarketplaceOrderTransition = (current, next) =>
  ORDER_TRANSITIONS[current]?.includes(next) === true;

const withError = (handler) => async (request, response, next) => {
  try {
    return await handler(request, response);
  } catch (error) {
    if (error.status) {
      return response.status(error.status).json({
        error: error.message,
        code: error.code,
      });
    }
    console.error("Marketplace commerce request failed:", error);
    return next(error);
  }
};

const getOrderForUser = async (client, orderId, userId, lock = false) => {
  if (!validId(orderId)) {
    throw httpError(400, "INVALID_ORDER_ID", "L’identifiant de commande est invalide.");
  }
  const result = await client.query(
    `SELECT orders.*
     FROM marketplace_orders orders
     WHERE orders.id = $1
       AND (orders.buyer_id = $2 OR orders.seller_id = $2 OR orders.courier_id = $2)
     ${lock ? "FOR UPDATE" : ""}`,
    [orderId, userId],
  );
  if (!result.rowCount) {
    throw httpError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
  }
  return result.rows[0];
};

export const getMarketplaceShop = withError(async (request, response) => {
  const sellerId = request.params.sellerId;
  if (!validId(sellerId)) {
    throw httpError(400, "INVALID_SELLER_ID", "L’identifiant du vendeur est invalide.");
  }
  const result = await pool.query(
    `SELECT shop.seller_id, shop.business_name, shop.description,
            COALESCE(shop.country_code, seller.country_code) AS country_code,
            COALESCE(NULLIF(shop.city, ''), seller.neighborhood, '') AS city,
            shop.language_code, seller.full_name AS seller_name,
            seller.profile_photo_url, seller.is_verified AS verified,
            COALESCE(rating.average_rating, 0) AS average_rating,
            COALESCE(rating.review_count, 0)::INTEGER AS review_count,
            COALESCE(items.products, '[]'::json) AS products
     FROM marketplace_shops shop
     JOIN users seller ON seller.id = shop.seller_id
     LEFT JOIN LATERAL (
       SELECT ROUND(AVG(reviews.rating)::numeric, 1) AS average_rating,
              COUNT(*) AS review_count
       FROM marketplace_reviews reviews
       WHERE reviews.seller_id = shop.seller_id
     ) rating ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
         'id', item.id, 'title', item.title, 'description', item.description,
         'price', CASE WHEN item.promo_price IS NOT NULL
                         AND item.promo_expires_at > NOW()
                       THEN item.promo_price ELSE item.price_amount END,
         'currency', CASE WHEN item.currency_code = 'XOF'
                          THEN 'FCFA' ELSE item.currency_code END,
         'category', item.category, 'item_type', item.item_type,
         'image_url', item.image_urls[1], 'promo_price', item.promo_price,
         'is_promoted', item.promo_price IS NOT NULL
           AND item.promo_expires_at > NOW(),
         'promo_expires_at', item.promo_expires_at
       ) ORDER BY item.created_at DESC) AS products
       FROM marketplace_items item
       WHERE item.seller_id = shop.seller_id
         AND item.item_type <> 'service'
     ) items ON TRUE
     WHERE shop.seller_id = $1 AND shop.is_active = TRUE`,
    [sellerId],
  );
  if (!result.rowCount) {
    throw httpError(404, "SHOP_NOT_FOUND", "Cette boutique n’existe pas.");
  }
  return response.json({ shop: result.rows[0] });
});

export const listMarketplaceShops = withError(async (request, response) => {
  const countryCode = cleanString(request.query.country_code, 3).toUpperCase();
  const city = cleanString(request.query.city, 120);
  const languageCode = cleanString(request.query.language_code, 12).toLowerCase();
  const search = cleanString(request.query.q, 120);
  const scope =
    cleanString(request.query.scope, 20) ||
    (countryCode ? "country" : "international");
  if (!["nearby", "country", "international"].includes(scope)) {
    throw httpError(400, "INVALID_SHOP_SCOPE", "La portée des boutiques est invalide.");
  }
  if (scope === "country" && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw httpError(400, "INVALID_COUNTRY", "Le code du pays est invalide.");
  }
  const latitude =
    request.query.latitude === undefined ? null : Number(request.query.latitude);
  const longitude =
    request.query.longitude === undefined ? null : Number(request.query.longitude);
  const radius = Number(request.query.radius_m ?? 100_000);
  if (
    scope === "nearby" &&
    (!Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(radius) ||
      radius < 1 ||
      radius > 100_000)
  ) {
    throw httpError(400, "INVALID_SHOP_LOCATION", "La position de recherche des boutiques est invalide.");
  }
  const result = await pool.query(
    `SELECT shop.seller_id, shop.business_name, shop.description,
            COALESCE(shop.country_code, seller.country_code) AS country_code,
            COALESCE(NULLIF(shop.city, ''), seller.neighborhood, '') AS city,
            shop.language_code, seller.full_name AS seller_name,
            seller.profile_photo_url, seller.is_verified AS verified,
            COALESCE(rating.average_rating, 0) AS average_rating,
            COALESCE(rating.review_count, 0)::INTEGER AS review_count,
            COALESCE(products.product_count, 0)::INTEGER AS product_count
     FROM marketplace_shops shop
     JOIN users seller ON seller.id = shop.seller_id
     LEFT JOIN LATERAL (
       SELECT ROUND(AVG(reviews.rating)::numeric, 1) AS average_rating,
              COUNT(*) AS review_count
       FROM marketplace_reviews reviews
       WHERE reviews.seller_id = shop.seller_id
     ) rating ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS product_count
       FROM marketplace_items item
       WHERE item.seller_id = shop.seller_id AND item.item_type <> 'service'
     ) products ON TRUE
     WHERE shop.is_active = TRUE
       AND CASE
         WHEN $5 = 'international' THEN TRUE
         WHEN $5 = 'country' THEN COALESCE(shop.country_code, seller.country_code) = $1
         ELSE EXISTS (
           SELECT 1 FROM marketplace_items nearby_item
           WHERE nearby_item.seller_id = shop.seller_id
             AND ST_DWithin(
               nearby_item.location::geography,
               ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography,
               $8
             )
         )
       END
       AND ($2::text = '' OR LOWER(COALESCE(NULLIF(shop.city, ''), seller.neighborhood, '')) = LOWER($2))
       AND ($3::text = '' OR shop.language_code = $3)
       AND ($4::text = '' OR shop.business_name ILIKE '%' || $4 || '%'
         OR seller.full_name ILIKE '%' || $4 || '%')
     ORDER BY products.product_count DESC, shop.created_at DESC
     LIMIT 100`,
    [
      countryCode,
      city,
      languageCode,
      search,
      scope,
      latitude,
      longitude,
      radius,
    ],
  );
  return response.json({ shops: result.rows });
});

export const getMyMarketplaceShop = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT seller_id, business_name, description, country_code, city, language_code
     FROM marketplace_shops WHERE seller_id = $1`,
    [request.auth.userId],
  );
  return response.json({ shop: result.rows[0] ?? null });
});

export const saveMyMarketplaceShop = withError(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  const businessName = cleanString(body.business_name, 120);
  const description = cleanString(body.description, 2000);
  const city = cleanString(body.city, 120);
  const languageCode = cleanString(body.language_code ?? "fr", 12).toLowerCase();
  const countryCode = cleanString(body.country_code, 3).toUpperCase();
  if (!businessName) {
    throw httpError(400, "INVALID_SHOP_NAME", "Le nom de la boutique est obligatoire.");
  }
  if (countryCode && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw httpError(400, "INVALID_COUNTRY", "Le code du pays est invalide.");
  }
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(languageCode)) {
    throw httpError(400, "INVALID_LANGUAGE", "Le code de langue est invalide.");
  }
  const result = await pool.query(
    `INSERT INTO marketplace_shops
       (seller_id, business_name, description, country_code, city, language_code)
     SELECT profile.id, $2, $3, COALESCE($4, profile.country_code), $5, $6
     FROM users profile WHERE profile.id = $1
     ON CONFLICT (seller_id) DO UPDATE SET
       business_name = EXCLUDED.business_name,
       description = EXCLUDED.description,
       country_code = EXCLUDED.country_code,
       city = EXCLUDED.city,
       language_code = EXCLUDED.language_code,
       is_active = TRUE,
       updated_at = NOW()
     RETURNING seller_id, business_name, description, country_code, city, language_code`,
    [
      request.auth.userId,
      businessName,
      description,
      countryCode || null,
      city,
      languageCode,
    ],
  );
  if (!result.rowCount) {
    throw httpError(404, "USER_NOT_FOUND", "Le compte vendeur est introuvable.");
  }
  return response.status(200).json({ shop: result.rows[0] });
});

export const listMarketplaceOrders = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT orders.*, seller.full_name AS seller_name,
            buyer.full_name AS buyer_name,
            courier.full_name AS courier_name,
            review.id AS review_id,
            COALESCE((
              SELECT json_agg(json_build_object(
                'status', events.status, 'note', events.note,
                'created_at', events.created_at
              ) ORDER BY events.created_at)
              FROM marketplace_order_events events
              WHERE events.order_id = orders.id
            ), '[]'::json) AS events
     FROM marketplace_orders orders
     LEFT JOIN users seller ON seller.id = orders.seller_id
     LEFT JOIN users buyer ON buyer.id = orders.buyer_id
     LEFT JOIN users courier ON courier.id = orders.courier_id
     LEFT JOIN marketplace_reviews review
       ON review.order_id = orders.id AND review.buyer_id = $1
     WHERE orders.buyer_id = $1 OR orders.seller_id = $1 OR orders.courier_id = $1
     ORDER BY orders.created_at DESC
     LIMIT 100`,
    [request.auth.userId],
  );
  return response.json({ orders: result.rows });
});

export const createMarketplaceOrder = withError(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  const itemId = body.item_id;
  if (!validId(itemId)) {
    throw httpError(400, "INVALID_ITEM_ID", "L’identifiant du produit est invalide.");
  }
  const deliveryMethod = body.delivery_method;
  if (!["HOME_DELIVERY", "PICKUP"].includes(deliveryMethod)) {
    throw httpError(400, "INVALID_DELIVERY_METHOD", "Choisissez une livraison à domicile ou un retrait.");
  }
  const address = cleanString(body.delivery_address, 500);
  const city = cleanString(body.delivery_city, 120);
  const countryCode = cleanString(body.delivery_country_code, 3).toUpperCase();
  if (deliveryMethod === "HOME_DELIVERY" && (!address || !city)) {
    throw httpError(400, "DELIVERY_ADDRESS_REQUIRED", "L’adresse et la ville de livraison sont obligatoires.");
  }
  if (deliveryMethod === "HOME_DELIVERY" && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw httpError(400, "DELIVERY_COUNTRY_REQUIRED", "Le pays de livraison est obligatoire.");
  }
  if (countryCode && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw httpError(400, "INVALID_COUNTRY", "Le code du pays de livraison est invalide.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const itemResult = await client.query(
      `SELECT item.id, item.seller_id, item.title, item.item_type,
              item.price_amount, item.currency_code, item.promo_price,
              item.promo_expires_at
       FROM marketplace_items item
       WHERE item.id = $1
       FOR UPDATE`,
      [itemId],
    );
    const item = itemResult.rows[0];
    if (!item || item.item_type === "service") {
      throw httpError(404, "PRODUCT_UNAVAILABLE", "Ce produit ne peut pas être commandé.");
    }
    if (item.seller_id === request.auth.userId) {
      throw httpError(400, "OWN_PRODUCT", "Vous ne pouvez pas commander votre propre produit.");
    }
    const amount =
      item.promo_price !== null &&
      item.promo_expires_at &&
      new Date(item.promo_expires_at).getTime() > Date.now()
        ? item.promo_price
        : item.price_amount;
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw httpError(400, "PRODUCT_NOT_ORDERABLE", "Ce produit n’a pas de prix commandable.");
    }
    const id = validId(body.client_order_id) ? body.client_order_id : randomUUID();
    const orderResult = await client.query(
      `INSERT INTO marketplace_orders
         (id, buyer_id, seller_id, item_id, item_title, amount, currency_code,
          status, delivery_method, delivery_address, delivery_city,
          delivery_country_code, buyer_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'SENT', $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        request.auth.userId,
        item.seller_id,
        item.id,
        item.title,
        amount,
        item.currency_code,
        deliveryMethod,
        deliveryMethod === "PICKUP" ? "" : address,
        deliveryMethod === "PICKUP" ? "" : city,
        deliveryMethod === "PICKUP" ? null : countryCode || null,
        cleanString(body.buyer_note, 1000),
      ],
    );
    await client.query(
      `INSERT INTO marketplace_order_events (order_id, actor_id, status)
       VALUES ($1, $2, 'SENT')`,
      [id, request.auth.userId],
    );
    await client.query("COMMIT");
    return response.status(201).json({ order: orderResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export const getMarketplaceOrder = withError(async (request, response) => {
  const order = await getOrderForUser(
    pool,
    request.params.orderId,
    request.auth.userId,
  );
  const events = await pool.query(
    `SELECT status, note, created_at
     FROM marketplace_order_events WHERE order_id = $1 ORDER BY created_at`,
    [order.id],
  );
  return response.json({ order, events: events.rows });
});

export const updateMarketplaceOrderStatus = withError(async (request, response) => {
  const nextStatus = cleanString(request.body?.status, 16).toUpperCase();
  if (!Object.hasOwn(ORDER_TRANSITIONS, nextStatus)) {
    throw httpError(400, "INVALID_ORDER_STATUS", "Le statut de commande est inconnu.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await getOrderForUser(
      client,
      request.params.orderId,
      request.auth.userId,
      true,
    );
    const actorId = request.auth.userId;
    const isBuyer = order.buyer_id === actorId;
    const isSeller = order.seller_id === actorId;
    const isCourier = order.courier_id === actorId;
    const allowed =
      isAllowedMarketplaceOrderTransition(order.status, nextStatus) &&
      ((isBuyer && nextStatus === "CANCELLED" &&
        ["SENT", "ACCEPTED"].includes(order.status)) ||
        (isSeller && (
          ["SENT:ACCEPTED", "SENT:CANCELLED", "ACCEPTED:PREPARING",
            "ACCEPTED:CANCELLED"].includes(`${order.status}:${nextStatus}`) ||
          (order.delivery_method === "PICKUP" &&
            order.status === "PREPARING" && nextStatus === "DELIVERED") ||
          (order.delivery_method === "HOME_DELIVERY" &&
            order.status === "PREPARING" && nextStatus === "CANCELLED")
        )) ||
        (isCourier && (
          (order.status === "PREPARING" && nextStatus === "SHIPPED") ||
          (order.status === "SHIPPED" && nextStatus === "DELIVERED")
        )));
    if (!allowed) {
      throw httpError(409, "ORDER_TRANSITION_FORBIDDEN", "Cette évolution de commande n’est pas autorisée.");
    }
    if (nextStatus === "SHIPPED" && !order.courier_id) {
      throw httpError(409, "COURIER_REQUIRED", "Un livreur indépendant doit prendre en charge la commande.");
    }
    const updated = await client.query(
      `UPDATE marketplace_orders
       SET status = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [order.id, nextStatus],
    );
    await client.query(
      `INSERT INTO marketplace_order_events (order_id, actor_id, status)
       VALUES ($1, $2, $3)`,
      [order.id, actorId, nextStatus],
    );
    if (nextStatus === "DELIVERED" && order.item_id) {
      await client.query(
        `UPDATE marketplace_items
         SET completed_sales = completed_sales + 1
         WHERE id = $1`,
        [order.item_id],
      );
    }
    await client.query("COMMIT");
    return response.json({ order: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export const confirmMarketplaceDelivery = withError(async (request, response) => {
  const orderId = request.params.orderId;
  if (!validId(orderId)) {
    throw httpError(400, "INVALID_ORDER_ID", "L’identifiant de commande est invalide.");
  }
  const result = await pool.query(
    `UPDATE marketplace_orders
     SET buyer_confirmed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND buyer_id = $2 AND status = 'DELIVERED'
       AND buyer_confirmed_at IS NULL
     RETURNING id, buyer_confirmed_at`,
    [orderId, request.auth.userId],
  );
  if (!result.rowCount) {
    throw httpError(409, "DELIVERY_CONFIRMATION_UNAVAILABLE", "La livraison doit être marquée livrée et vous devez être l’acheteur.");
  }
  return response.json({ order_id: result.rows[0].id, buyer_confirmed_at: result.rows[0].buyer_confirmed_at });
});

export const saveMarketplaceCourier = withError(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  const countryCode = cleanString(body.country_code, 3).toUpperCase();
  const city = cleanString(body.city, 120);
  const isAvailable = body.is_available !== false;
  if (!/^[A-Z]{2,3}$/.test(countryCode) || !city) {
    throw httpError(400, "INVALID_COURIER_PROFILE", "Choisissez un pays et une ville de livraison.");
  }
  const result = await pool.query(
    `INSERT INTO marketplace_couriers (user_id, country_code, city, is_available)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       country_code = EXCLUDED.country_code,
       city = EXCLUDED.city,
       is_available = EXCLUDED.is_available,
       updated_at = NOW()
     RETURNING user_id, country_code, city, is_available`,
    [request.auth.userId, countryCode, city, isAvailable],
  );
  return response.json({ courier: result.rows[0] });
});

export const getMarketplaceCourier = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT user_id, country_code, city, is_available
     FROM marketplace_couriers WHERE user_id = $1`,
    [request.auth.userId],
  );
  return response.json({ courier: result.rows[0] ?? null });
});

export const listMarketplaceDeliveries = withError(async (request, response) => {
  const profile = await pool.query(
    `SELECT country_code, city, is_available
     FROM marketplace_couriers WHERE user_id = $1`,
    [request.auth.userId],
  );
  if (!profile.rowCount || !profile.rows[0].is_available) {
    throw httpError(403, "COURIER_PROFILE_REQUIRED", "Activez votre profil de livreur indépendant pour voir les livraisons.");
  }
  const result = await pool.query(
    `SELECT orders.id, orders.item_title, orders.amount, orders.currency_code,
            orders.delivery_city, orders.delivery_country_code, orders.created_at,
            seller.full_name AS seller_name
     FROM marketplace_orders orders
     JOIN users seller ON seller.id = orders.seller_id
     WHERE orders.status = 'PREPARING'
       AND orders.delivery_method = 'HOME_DELIVERY'
       AND orders.courier_id IS NULL
       AND orders.delivery_country_code = $1
       AND LOWER(orders.delivery_city) = LOWER($2)
     ORDER BY orders.created_at
     LIMIT 100`,
    [profile.rows[0].country_code, profile.rows[0].city],
  );
  return response.json({ deliveries: result.rows });
});

export const claimMarketplaceDelivery = withError(async (request, response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await getOrderForUser(
      client,
      request.params.orderId,
      request.auth.userId,
      true,
    ).catch((error) => {
      if (error.status !== 404) throw error;
      return null;
    });
    if (order) {
      throw httpError(409, "DELIVERY_ALREADY_CLAIMED", "Cette commande est déjà prise en charge.");
    }
    const profile = await client.query(
      `SELECT country_code, city, is_available
       FROM marketplace_couriers WHERE user_id = $1 FOR UPDATE`,
      [request.auth.userId],
    );
    if (!profile.rowCount || !profile.rows[0].is_available) {
      throw httpError(403, "COURIER_PROFILE_REQUIRED", "Activez votre profil de livreur indépendant.");
    }
    const result = await client.query(
      `UPDATE marketplace_orders orders
       SET courier_id = $2, updated_at = NOW()
       WHERE orders.id = $1
         AND orders.status = 'PREPARING'
         AND orders.delivery_method = 'HOME_DELIVERY'
         AND orders.courier_id IS NULL
         AND orders.seller_id <> $2
         AND orders.buyer_id <> $2
         AND orders.delivery_country_code = $3
         AND LOWER(orders.delivery_city) = LOWER($4)
       RETURNING orders.*`,
      [
        request.params.orderId,
        request.auth.userId,
        profile.rows[0].country_code,
        profile.rows[0].city,
      ],
    );
    if (!result.rowCount) {
      throw httpError(409, "DELIVERY_UNAVAILABLE", "Cette livraison n’est plus disponible dans votre zone.");
    }
    await client.query(
      `INSERT INTO marketplace_order_events
         (order_id, actor_id, status, note)
       VALUES ($1, $2, 'PREPARING', 'Livreur indépendant assigné')`,
      [result.rows[0].id, request.auth.userId],
    );
    await client.query("COMMIT");
    return response.json({ order: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export const createMarketplaceReview = withError(async (request, response) => {
  const orderId = request.params.orderId;
  if (!validId(orderId)) {
    throw httpError(400, "INVALID_ORDER_ID", "L’identifiant de commande est invalide.");
  }
  const rating = Number(request.body?.rating);
  const comment = cleanString(request.body?.comment, 1000);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw httpError(400, "INVALID_RATING", "La note doit être comprise entre 1 et 5.");
  }
  const result = await pool.query(
    `INSERT INTO marketplace_reviews (order_id, buyer_id, seller_id, rating, comment)
     SELECT orders.id, orders.buyer_id, orders.seller_id, $3, $4
     FROM marketplace_orders orders
     WHERE orders.id = $1
       AND orders.buyer_id = $2
       AND orders.status = 'DELIVERED'
       AND orders.buyer_confirmed_at IS NOT NULL
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id, order_id, seller_id, rating, comment, created_at`,
    [orderId, request.auth.userId, rating, comment],
  );
  if (!result.rowCount) {
    const order = await pool.query(
      `SELECT status, buyer_confirmed_at FROM marketplace_orders
       WHERE id = $1 AND buyer_id = $2`,
      [orderId, request.auth.userId],
    );
    if (
    !order.rowCount ||
    order.rows[0].status !== "DELIVERED" ||
    !order.rows[0].buyer_confirmed_at
    ) {
    throw httpError(409, "REVIEW_REQUIRES_DELIVERY", "Confirmez la réception de votre achat avant de publier un avis.");
    }
    throw httpError(409, "REVIEW_ALREADY_SUBMITTED", "Vous avez déjà évalué cet achat.");
  }
  return response.status(201).json({ review: result.rows[0] });
});

export const listMarketplaceOpportunities = withError(async (request, response) => {
  const countryCode = cleanString(request.query.country_code, 3).toUpperCase();
  const city = cleanString(request.query.city, 120);
  const languageCode = cleanString(request.query.language_code, 12).toLowerCase();
  const type = cleanString(request.query.type, 20).toUpperCase();
  const search = cleanString(request.query.q, 120);
  const category = cleanString(request.query.category, 60);
  if (type && !["SUPPLIER", "PRODUCER", "PARTNERSHIP"].includes(type)) {
    throw httpError(400, "INVALID_OPPORTUNITY_TYPE", "Le type d’opportunité est invalide.");
  }
  const result = await pool.query(
    `SELECT opportunity.id, opportunity.opportunity_type, opportunity.title,
            opportunity.description, opportunity.category, opportunity.country_code,
            opportunity.city, opportunity.language_code, opportunity.currency_code,
            opportunity.budget_amount, opportunity.created_at,
            owner.full_name AS owner_name, owner.phone_number AS owner_phone,
            owner.is_verified AS owner_verified,
            COALESCE(rating.average_rating, 0) AS owner_rating
     FROM marketplace_opportunities opportunity
     JOIN users owner ON owner.id = opportunity.owner_id
     LEFT JOIN LATERAL (
       SELECT ROUND(AVG(reviews.rating)::numeric, 1) AS average_rating
       FROM marketplace_reviews reviews
       WHERE reviews.seller_id = opportunity.owner_id
     ) rating ON TRUE
     WHERE opportunity.is_active = TRUE
       AND ($1::text IS NULL OR opportunity.country_code = $1)
       AND ($2::text = '' OR LOWER(opportunity.city) = LOWER($2))
       AND ($3::text = '' OR opportunity.language_code = $3)
       AND ($4::text = '' OR opportunity.opportunity_type = $4)
       AND ($5::text = '' OR opportunity.category ILIKE '%' || $5 || '%')
       AND ($6::text = '' OR opportunity.title ILIKE '%' || $6 || '%'
         OR opportunity.description ILIKE '%' || $6 || '%'
         OR opportunity.category ILIKE '%' || $6 || '%')
     ORDER BY opportunity.created_at DESC
     LIMIT 100`,
    [countryCode || null, city, languageCode, type, category, search],
  );
  return response.json({ opportunities: result.rows });
});

export const createMarketplaceOpportunity = withError(async (request, response) => {
  const body = isRecord(request.body) ? request.body : {};
  const opportunityType = cleanString(body.opportunity_type, 20).toUpperCase();
  const title = cleanString(body.title, 150);
  const description = cleanString(body.description, 4000);
  const category = cleanString(body.category, 60);
  const countryCode = cleanString(body.country_code, 3).toUpperCase();
  const city = cleanString(body.city, 120);
  const languageCode = cleanString(body.language_code ?? "fr", 12).toLowerCase();
  const currencyCode = cleanString(body.currency_code ?? "XOF", 3).toUpperCase();
  const budget =
    body.budget_amount === undefined || body.budget_amount === null ||
    body.budget_amount === ""
      ? null
      : Number(body.budget_amount);
  if (!["SUPPLIER", "PRODUCER", "PARTNERSHIP"].includes(opportunityType)) {
    throw httpError(400, "INVALID_OPPORTUNITY_TYPE", "Choisissez fournisseur, producteur ou partenariat.");
  }
  if (!title || !description || !category) {
    throw httpError(400, "INVALID_OPPORTUNITY", "Le titre, la description et la catégorie sont obligatoires.");
  }
  if (countryCode && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw httpError(400, "INVALID_COUNTRY", "Le code du pays est invalide.");
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw httpError(400, "INVALID_CURRENCY", "Utilisez un code devise ISO 4217.");
  }
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
    throw httpError(400, "INVALID_BUDGET", "Le budget doit être nul ou supérieur à zéro.");
  }
  const result = await pool.query(
    `INSERT INTO marketplace_opportunities
       (owner_id, opportunity_type, title, description, category, country_code,
        city, language_code, currency_code, budget_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, opportunity_type, title, description, category, country_code,
               city, language_code, currency_code, budget_amount, created_at`,
    [
      request.auth.userId,
      opportunityType,
      title,
      description,
      category,
      countryCode || null,
      city,
      languageCode,
      currencyCode,
      budget,
    ],
  );
  return response.status(201).json({ opportunity: result.rows[0] });
});
