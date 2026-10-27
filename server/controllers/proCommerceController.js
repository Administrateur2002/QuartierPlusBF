import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { sendExpoPushNotifications } from "../services/pushNotifications.js";
import {
  createCloudinaryUploadSignature,
  deleteCloudinaryAsset,
  getCloudinaryAsset,
  hasGpsMetadata,
  isCloudinaryPublicIdOwnedByUser,
} from "../services/cloudinary.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_TRANSITIONS = {
  RECEIVED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARED", "CANCELLED"],
  PREPARED: ["IN_TRANSIT"],
  IN_TRANSIT: [],
  DELIVERED: [],
  CANCELLED: [],
};

const httpError = (status, code, message) =>
  Object.assign(new Error(message), { status, code, reason: message });

export const isAllowedOrderTransition = (current, next) =>
  STATUS_TRANSITIONS[current]?.includes(next) === true;

export const canAccessProOrder = (userId, order) =>
  order.buyer_id === userId ||
  order.wholesaler_owner_id === userId ||
  order.deliverer_id === userId ||
  order.member_role === "MANAGER" ||
  (order.member_role === "DELIVERER" &&
    (order.status === "PREPARED" || order.deliverer_id === userId));

export const isValidHandoffCode = (code) => /^\d{6}$/.test(String(code));
export const isDeliveryTrackingActive = (status) => status === "IN_TRANSIT";

export const doesHandoffCodeMatch = (orderId, code, storedHash) => {
  if (!isValidHandoffCode(code) || typeof storedHash !== "string") return false;
  const expected = Buffer.from(handoffHash(orderId, code), "hex");
  const actual = Buffer.from(storedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const getTierPrice = (unitPrice, tiers, quantity) => {
  const tier = [...tiers]
    .filter((item) => Number(item.min_quantity) <= quantity)
    .sort((left, right) => Number(right.min_quantity) - Number(left.min_quantity))[0];
  return Number(tier?.unit_price ?? unitPrice);
};

const handoffCodeFor = (orderId) => {
  const digest = createHmac("sha256", env.jwtSecret)
    .update(`pro-handoff:${orderId}`)
    .digest();
  return String(100000 + (digest.readUInt32BE(0) % 900000));
};

const handoffHash = (orderId, code) =>
  createHmac("sha256", env.jwtSecret)
    .update(`pro-handoff:${orderId}:${code}`)
    .digest("hex");

const validId = (value) => UUID_PATTERN.test(String(value ?? ""));
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const stringField = (value, max, label) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw httpError(400, "INVALID_FIELD", `${label} est obligatoire (maximum ${max} caractères).`);
  }
  return value.trim();
};
const positiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1000000) {
    throw httpError(400, "INVALID_QUANTITY", `${label} doit être un nombre positif valide.`);
  }
  return number;
};
const respondError = (response, error) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const reason = [
    env.databaseUrl,
    env.jwtSecret,
    env.ticketQrSecret,
    env.smsDeliveryToken,
    env.smtpPass,
    env.emailApiKey,
    env.fedapayPublicKey,
    env.fedapaySecretKey,
    env.fedapayWebhookSecret,
    env.cloudinaryApiKey,
    env.cloudinaryApiSecret,
    env.livekitApiKey,
    env.livekitApiSecret,
    env.proAdminToken,
  ].filter(Boolean).reduce((message, secret) => message.replaceAll(secret, "[masqué]"),
    status === 500
      ? `${error.code ? `PostgreSQL ${error.code}: ` : ""}${error.message ?? "Cause technique inconnue."}`
      : error.message,
  );
  return response.status(status).json({
    error: status === 500 ? "La requête QuartierPlus Pro a échoué." : error.message,
    code: error.code ?? "PRO_INTERNAL_ERROR",
    reason,
  });
};
const withError = (handler) => async (request, response) => {
  try {
    return await handler(request, response);
  } catch (error) {
    if (error.status === 500 || !error.status) {
      console.error("QuartierPlus Pro request failed:", error);
    }
    return respondError(response, error);
  }
};

const getOrderAccess = async (orderId, userId, client = pool) => {
  if (!validId(orderId)) throw httpError(400, "INVALID_ORDER_ID", "L’identifiant de commande est invalide.");
  const result = await client.query(
    `SELECT orders.*, wholesalers.user_id AS wholesaler_owner_id,
            (SELECT members.member_role FROM pro_wholesaler_members members
              WHERE members.wholesaler_id = orders.wholesaler_id
                AND members.user_id = $2) AS member_role
     FROM pro_orders orders
     JOIN pro_wholesalers wholesalers ON wholesalers.id = orders.wholesaler_id
    WHERE orders.id = $1
    FOR UPDATE OF orders`,
    [orderId, userId],
  );
  const order = result.rows[0];
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
  if (!canAccessProOrder(userId, order)) {
    throw httpError(403, "ORDER_FORBIDDEN", "Vous ne participez pas à cette commande.");
  }
  return order;
};

const notifyParticipants = async (orderId, status) => {
  const result = await pool.query(
    `SELECT DISTINCT tokens.token FROM push_tokens tokens
     WHERE tokens.user_id IN (
       SELECT orders.buyer_id FROM pro_orders orders WHERE orders.id = $1
       UNION SELECT wholesalers.user_id FROM pro_orders orders
         JOIN pro_wholesalers wholesalers ON wholesalers.id = orders.wholesaler_id WHERE orders.id = $1
       UNION SELECT orders.deliverer_id FROM pro_orders orders
         WHERE orders.id = $1 AND orders.deliverer_id IS NOT NULL
       UNION SELECT members.user_id FROM pro_orders orders
         JOIN pro_wholesaler_members members ON members.wholesaler_id = orders.wholesaler_id
         WHERE orders.id = $1 AND members.member_role = 'MANAGER'
       UNION SELECT members.user_id FROM pro_orders orders
         JOIN pro_wholesaler_members members ON members.wholesaler_id = orders.wholesaler_id
         WHERE orders.id = $1 AND members.member_role = 'DELIVERER'
           AND orders.status = 'PREPARED' AND orders.deliverer_id IS NULL
     )`,
    [orderId],
  );
  const label = {
    RECEIVED: "reçue",
    ACCEPTED: "acceptée",
    PREPARED: "préparée",
    IN_TRANSIT: "en route",
    DELIVERED: "livrée",
    CANCELLED: "annulée",
    PAYMENT_DEPOSIT_PAID: "acompte confirmé directement par le grossiste",
  }[status] ?? status;
  await sendExpoPushNotifications(
    result.rows.map((row) => row.token),
    {
      title: "Mise à jour de votre commande",
      body: `Votre commande est maintenant ${label}.`,
      data: { type: "pro_order_status", order_id: orderId, status },
    },
  );
};

const emitOrderStatus = (request, orderId, order) => {
  request.app.get("io")?.to(`pro-order:${orderId}`).emit("pro:order:status", {
    order_id: orderId,
    status: order.status,
    updated_at: order.updated_at,
  });
};

const insertEvent = async (client, orderId, actorId, status, note = "") => {
  await client.query(
    `INSERT INTO pro_order_events (order_id, actor_id, status, note)
     VALUES ($1, $2, $3, $4)`,
    [orderId, actorId, status, note],
  );
};

const pdfEscape = (value) =>
  String(value).normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").replace(/[()\\]/g, "\\$&");

const createReceiptPdf = (order, items) => {
  const lines = [
    "QUARTIERPLUS PRO - RECU DE COMMANDE",
    `Commande: ${order.id}`,
    `Date: ${new Date(order.delivered_at).toISOString()}`,
    `Grossiste: ${order.business_name}`,
    `Acheteur: ${order.buyer_name}`,
    `Adresse: ${order.address}`,
    `Paiement declare: ${order.payment_method === "DIRECT_DEPOSIT" ? (order.payment_status === "DEPOSIT_PAID" ? "Acompte confirme directement par le grossiste" : "Acompte a regler directement au grossiste") : "Paiement a la livraison"}`,
    "Articles:",
    ...items.map((item) => `${item.product_name} - ${item.quantity} ${item.unit} x ${item.unit_price} = ${item.line_total}`),
    `TOTAL: ${order.total}`,
    "Aucun paiement ni transfert n'a ete effectue par QuartierPlus.",
  ];
  const stream = `BT /F1 10 Tf 48 790 Td 14 TL ${lines.map((line, index) => `${index ? "T* " : ""}(${pdfEscape(line)}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "ascii"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, "ascii");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(document, "ascii");
};

export const getWholesalers = withError(async (_request, response) => {
  const result = await pool.query(
    `SELECT id, business_name, description, delivery_zone, catalog_slug, created_at
     FROM pro_wholesalers
     WHERE is_active = TRUE AND rccm_status = 'VERIFIED' AND ifu_status = 'VERIFIED'
     ORDER BY business_name`,
  );
  return response.json({ wholesalers: result.rows });
});

export const getWholesaler = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT id, business_name, description, delivery_zone, catalog_slug, created_at
     FROM pro_wholesalers
     WHERE (id::text = $1 OR catalog_slug = $1)
       AND is_active = TRUE AND rccm_status = 'VERIFIED' AND ifu_status = 'VERIFIED'`,
    [request.params.wholesalerId],
  );
  if (!result.rows[0]) throw httpError(404, "WHOLESALER_NOT_FOUND", "Grossiste vérifié introuvable.");
  return response.json({ wholesaler: result.rows[0] });
});

export const getOwnWholesaler = withError(async (request, response) => {
  const result = await pool.query(
    "SELECT * FROM pro_wholesalers WHERE user_id = $1",
    [request.auth.userId],
  );
  return response.json({ wholesaler: result.rows[0] ?? null });
});

export const updateWholesalerVerification = withError(async (request, response) => {
  const rccmStatus = request.body?.rccm_status;
  const ifuStatus = request.body?.ifu_status;
  const allowed = ["PENDING", "VERIFIED", "REJECTED", "NOT_PROVIDED"];
  if (!allowed.includes(rccmStatus) || !allowed.includes(ifuStatus)) {
    throw httpError(400, "INVALID_VERIFICATION_STATUS", "Les statuts RCCM et IFU sont invalides.");
  }
  const result = await pool.query(
    `UPDATE pro_wholesalers SET rccm_status = $2, ifu_status = $3, updated_at = NOW()
     WHERE id = $1 RETURNING id, business_name, rccm_status, ifu_status, is_active`,
    [request.params.wholesalerId, rccmStatus, ifuStatus],
  );
  if (!result.rows[0]) throw httpError(404, "WHOLESALER_NOT_FOUND", "Grossiste introuvable.");
  return response.json({ wholesaler: result.rows[0] });
});

export const getManageableProducts = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT products.*,
       COALESCE(jsonb_agg(jsonb_build_object('min_quantity', tiers.min_quantity, 'unit_price', tiers.unit_price))
         FILTER (WHERE tiers.id IS NOT NULL), '[]'::jsonb) AS price_tiers
     FROM pro_products products
     LEFT JOIN pro_price_tiers tiers ON tiers.product_id = products.id
     JOIN pro_wholesalers wholesalers ON wholesalers.id = products.wholesaler_id
     WHERE wholesalers.id = $1 AND wholesalers.user_id = $2
     GROUP BY products.id ORDER BY products.name`,
    [request.params.wholesalerId, request.auth.userId],
  );
  const owner = await pool.query(
    "SELECT id FROM pro_wholesalers WHERE id = $1 AND user_id = $2",
    [request.params.wholesalerId, request.auth.userId],
  );
  if (!owner.rowCount) throw httpError(403, "WHOLESALER_FORBIDDEN", "Seul le grossiste propriétaire peut gérer ce catalogue.");
  return response.json({ products: result.rows });
});

export const getProducts = withError(async (request, response) => {
  const values = [];
  let filter = "";
  if (request.query.wholesaler_id) {
    filter = "AND products.wholesaler_id = $1";
    values.push(request.query.wholesaler_id);
  }
  const result = await pool.query(
    `SELECT products.*, wholesalers.business_name,
            COALESCE(jsonb_agg(jsonb_build_object('min_quantity', tiers.min_quantity, 'unit_price', tiers.unit_price))
              FILTER (WHERE tiers.id IS NOT NULL), '[]'::jsonb) AS price_tiers
     FROM pro_products products
     JOIN pro_wholesalers wholesalers ON wholesalers.id = products.wholesaler_id
     LEFT JOIN pro_price_tiers tiers ON tiers.product_id = products.id
     WHERE products.is_active = TRUE AND wholesalers.is_active = TRUE
       AND wholesalers.rccm_status = 'VERIFIED' AND wholesalers.ifu_status = 'VERIFIED'
       ${filter}
     GROUP BY products.id, wholesalers.business_name
     ORDER BY products.name`,
    values,
  );
  return response.json({ products: result.rows });
});

export const getProduct = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT products.*, wholesalers.business_name,
            COALESCE(jsonb_agg(jsonb_build_object('min_quantity', tiers.min_quantity, 'unit_price', tiers.unit_price))
              FILTER (WHERE tiers.id IS NOT NULL), '[]'::jsonb) AS price_tiers
     FROM pro_products products
     JOIN pro_wholesalers wholesalers ON wholesalers.id = products.wholesaler_id
     LEFT JOIN pro_price_tiers tiers ON tiers.product_id = products.id
     WHERE products.id = $1 AND products.is_active = TRUE AND wholesalers.is_active = TRUE
       AND wholesalers.rccm_status = 'VERIFIED' AND wholesalers.ifu_status = 'VERIFIED'
     GROUP BY products.id, wholesalers.business_name`,
    [request.params.productId],
  );
  if (!result.rows[0]) throw httpError(404, "PRODUCT_NOT_FOUND", "Produit disponible introuvable.");
  return response.json({ product: result.rows[0] });
});

export const createWholesaler = withError(async (request, response) => {
  const body = record(request.body);
  const businessName = stringField(body.business_name, 120, "Le nom du grossiste");
  const deliveryZone = stringField(body.delivery_zone, 500, "La zone de livraison");
  const slug = stringField(body.catalog_slug, 80, "Le lien catalogue")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw httpError(400, "INVALID_CATALOG_SLUG", "Le lien catalogue doit contenir uniquement des lettres, chiffres et tirets simples.");
  }
  const result = await pool.query(
    `INSERT INTO pro_wholesalers (user_id, business_name, description, delivery_zone, catalog_slug)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name,
       description = EXCLUDED.description, delivery_zone = EXCLUDED.delivery_zone,
       catalog_slug = EXCLUDED.catalog_slug, updated_at = NOW()
     RETURNING *`,
    [request.auth.userId, businessName, String(body.description ?? "").slice(0, 2000), deliveryZone, slug],
  );
  return response.status(201).json({ wholesaler: result.rows[0] });
});

export const createProduct = withError(async (request, response) => {
  const body = record(request.body);
  const productName = stringField(body.name, 160, "Le nom du produit");
  const unit = stringField(body.unit, 40, "L’unité");
  const stock = Number(body.stock);
  const minimum = Number(body.min_order_quantity ?? 1);
  const price = Number(body.unit_price);
  const deliveryDays = Number(body.delivery_days ?? 1);
  if (![stock, minimum, price, deliveryDays].every(Number.isFinite) || stock < 0 || minimum <= 0 || price < 0 || deliveryDays < 0) {
    throw httpError(400, "INVALID_PRODUCT", "Prix, stock, minimum de commande ou délai invalide.");
  }
  const tiers = Array.isArray(body.price_tiers) ? body.price_tiers : [];
  if (tiers.length > 30 || tiers.some((tier) => !Number.isFinite(Number(tier.min_quantity)) || Number(tier.min_quantity) <= 0 || !Number.isFinite(Number(tier.unit_price)) || Number(tier.unit_price) < 0)) {
    throw httpError(400, "INVALID_PRICE_TIERS", "Les paliers de prix sont invalides.");
  }
  let photoUrl = null;
  if (typeof body.photo_public_id === "string" && body.photo_public_id) {
    if (!isCloudinaryPublicIdOwnedByUser(request.auth.userId, body.photo_public_id)) {
      throw httpError(403, "PRODUCT_PHOTO_FORBIDDEN", "Cette photo Cloudinary n’appartient pas à votre compte.");
    }
    const asset = await getCloudinaryAsset("image", body.photo_public_id);
    if (!asset || typeof asset.secure_url !== "string") {
      throw httpError(400, "PRODUCT_PHOTO_MISSING", "La photo du produit est introuvable sur Cloudinary.");
    }
    if (hasGpsMetadata(asset)) {
      await deleteCloudinaryAsset("image", body.photo_public_id);
      throw httpError(400, "PRODUCT_PHOTO_GPS_METADATA", "La photo contient des métadonnées GPS et a été supprimée de Cloudinary.");
    }
    photoUrl = asset.secure_url;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT id FROM pro_wholesalers WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [request.params.wholesalerId, request.auth.userId],
    );
    if (!owner.rowCount) throw httpError(403, "WHOLESALER_FORBIDDEN", "Seul le grossiste propriétaire peut gérer son catalogue.");
    const product = await client.query(
      `INSERT INTO pro_products (wholesaler_id, name, photo_url, unit, unit_price, stock, min_order_quantity, delivery_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [request.params.wholesalerId, productName, photoUrl, unit, price, stock, minimum, deliveryDays],
    );
    for (const tier of tiers) {
      await client.query(
        "INSERT INTO pro_price_tiers (product_id, min_quantity, unit_price) VALUES ($1, $2, $3)",
        [product.rows[0].id, Number(tier.min_quantity), Number(tier.unit_price)],
      );
    }
    await client.query("COMMIT");
    return response.status(201).json({ product: product.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export const updateProduct = withError(async (request, response) => {
  const body = record(request.body);
  const result = await pool.query(
    `UPDATE pro_products products SET
       name = COALESCE($3, products.name),
       stock = COALESCE($4, products.stock),
       unit_price = COALESCE($5, products.unit_price),
       is_active = COALESCE($6, products.is_active), updated_at = NOW()
     FROM pro_wholesalers wholesalers
     WHERE products.id = $1 AND products.wholesaler_id = wholesalers.id AND wholesalers.user_id = $2
     RETURNING products.*`,
    [request.params.productId, request.auth.userId,
      typeof body.name === "string" ? body.name.trim().slice(0, 160) : null,
      Number.isFinite(Number(body.stock)) ? Number(body.stock) : null,
      Number.isFinite(Number(body.unit_price)) ? Number(body.unit_price) : null,
      typeof body.is_active === "boolean" ? body.is_active : null],
  );
  if (!result.rows[0]) throw httpError(404, "PRODUCT_NOT_FOUND", "Produit introuvable ou non autorisé.");
  return response.json({ product: result.rows[0] });
});

export const addWholesalerMember = withError(async (request, response) => {
  const memberId = request.body?.user_id;
  const phoneNumber = typeof request.body?.phone_number === "string"
    ? request.body.phone_number.trim()
    : "";
  const memberRole = request.body?.role === "MANAGER" ? "MANAGER" : "DELIVERER";
  if (!validId(memberId) && !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw httpError(400, "INVALID_USER_ID", "Saisissez un identifiant utilisateur ou un numéro de téléphone E.164 valide.");
  }
  const result = await pool.query(
    `INSERT INTO pro_wholesaler_members (wholesaler_id, user_id, member_role)
     SELECT wholesalers.id, users.id, $4 FROM pro_wholesalers wholesalers
     JOIN users ON users.id = $3::uuid OR ($3::uuid IS NULL AND users.phone_number = $5)
     WHERE wholesalers.id = $1 AND wholesalers.user_id = $2
     ON CONFLICT (wholesaler_id, user_id) DO UPDATE SET member_role = EXCLUDED.member_role
     RETURNING *`,
    [request.params.wholesalerId, request.auth.userId, validId(memberId) ? memberId : null, memberRole, phoneNumber],
  );
  if (!result.rows[0]) throw httpError(403, "WHOLESALER_FORBIDDEN", "Seul le grossiste propriétaire peut inviter un employé.");
  return response.status(201).json({ member: result.rows[0] });
});

export const signProductPhotoUpload = withError(async (request, response) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "quartierplus/pro-products";
  const publicId = `${request.auth.userId}_${randomUUID()}`;
  const signature = createCloudinaryUploadSignature({
    folder,
    public_id: publicId,
    timestamp,
  });
  return response.json({
    ...signature,
    folder,
    public_id: publicId,
    resource_type: "image",
    timestamp,
    max_bytes: env.postMaxPhotoBytes,
  });
});

export const getFavorites = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT wholesalers.* FROM pro_favorites favorites
     JOIN pro_wholesalers wholesalers ON wholesalers.id = favorites.wholesaler_id
     WHERE favorites.user_id = $1 ORDER BY favorites.created_at DESC`,
    [request.auth.userId],
  );
  return response.json({ wholesalers: result.rows });
});

export const addFavorite = withError(async (request, response) => {
  const result = await pool.query(
    `INSERT INTO pro_favorites (user_id, wholesaler_id)
     SELECT $1, id FROM pro_wholesalers WHERE id = $2 AND is_active = TRUE
     ON CONFLICT DO NOTHING RETURNING wholesaler_id`,
    [request.auth.userId, request.params.wholesalerId],
  );
  if (!result.rowCount) {
    const existing = await pool.query(
      "SELECT 1 FROM pro_favorites WHERE user_id = $1 AND wholesaler_id = $2",
      [request.auth.userId, request.params.wholesalerId],
    );
    if (!existing.rowCount) throw httpError(404, "WHOLESALER_NOT_FOUND", "Grossiste introuvable ou indisponible.");
  }
  return response.status(204).end();
});

export const removeFavorite = withError(async (request, response) => {
  await pool.query("DELETE FROM pro_favorites WHERE user_id = $1 AND wholesaler_id = $2", [request.auth.userId, request.params.wholesalerId]);
  return response.status(204).end();
});

export const getOrders = withError(async (request, response) => {
  const result = await pool.query(
    `SELECT DISTINCT orders.*, wholesalers.business_name
     FROM pro_orders orders
     JOIN pro_wholesalers wholesalers ON wholesalers.id = orders.wholesaler_id
     LEFT JOIN pro_wholesaler_members members ON members.wholesaler_id = orders.wholesaler_id
       AND members.user_id = $1
     WHERE orders.buyer_id = $1 OR wholesalers.user_id = $1
       OR members.member_role = 'MANAGER'
       OR (members.member_role = 'DELIVERER'
         AND (orders.deliverer_id = $1 OR (orders.status = 'PREPARED' AND orders.deliverer_id IS NULL)))
     ORDER BY orders.created_at DESC LIMIT 100`,
    [request.auth.userId],
  );
  return response.json({ orders: result.rows });
});

export const createOrder = withError(async (request, response) => {
  const body = record(request.body);
  const wholesalerId = body.wholesaler_id;
  if (!validId(wholesalerId)) throw httpError(400, "INVALID_WHOLESALER_ID", "L’identifiant du grossiste est invalide.");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    throw httpError(400, "INVALID_ORDER_ITEMS", "Une commande doit contenir de 1 à 50 articles.");
  }
  const items = body.items.map((item) => {
    if (!validId(item?.product_id)) throw httpError(400, "INVALID_PRODUCT_ID", "Un produit de la commande est invalide.");
    return { productId: item.product_id, quantity: positiveNumber(item.quantity, "La quantité") };
  });
  if (new Set(items.map((item) => item.productId)).size !== items.length) {
    throw httpError(400, "DUPLICATE_ORDER_ITEM", "Chaque produit doit apparaître une seule fois dans la commande.");
  }
  const paymentMethod = body.payment_method;
  if (!["PAY_ON_DELIVERY", "DIRECT_DEPOSIT"].includes(paymentMethod)) {
    throw httpError(400, "INVALID_PAYMENT_METHOD", "Choisissez paiement à la livraison ou acompte réglé directement au grossiste.");
  }
  const address = stringField(body.address, 500, "L’adresse de livraison");
  const latitude = body.latitude == null ? null : Number(body.latitude);
  const longitude = body.longitude == null ? null : Number(body.longitude);
  if ((latitude === null) !== (longitude === null) || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180))) {
    throw httpError(400, "INVALID_DELIVERY_LOCATION", "Les coordonnées de livraison sont invalides.");
  }
  const client = await pool.connect();
  const orderId = validId(body.client_order_id) ? body.client_order_id : randomUUID();
  let handoffCode;
  try {
    await client.query("BEGIN");
    const wholesaler = await client.query(
      `SELECT id FROM pro_wholesalers WHERE id = $1 AND is_active = TRUE
       AND rccm_status = 'VERIFIED' AND ifu_status = 'VERIFIED' FOR UPDATE`,
      [wholesalerId],
    );
    if (!wholesaler.rowCount) throw httpError(404, "WHOLESALER_UNAVAILABLE", "Ce grossiste n’est pas encore vérifié ou n’accepte pas de commandes.");
    const existing = await client.query(
      "SELECT * FROM pro_orders WHERE id = $1 AND buyer_id = $2 AND wholesaler_id = $3",
      [orderId, request.auth.userId, wholesalerId],
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return response.status(200).json({
        order: existing.rows[0],
        handoff_code: handoffCodeFor(existing.rows[0].id),
        duplicate: true,
      });
    }
    const productsResult = await client.query(
      `SELECT * FROM pro_products WHERE id = ANY($1::uuid[]) AND wholesaler_id = $2
       AND is_active = TRUE FOR UPDATE`,
      [items.map((item) => item.productId), wholesalerId],
    );
    if (productsResult.rowCount !== items.length) throw httpError(400, "PRODUCT_UNAVAILABLE", "Un produit n’est plus disponible chez ce grossiste.");
    const tierResult = await client.query(
      "SELECT * FROM pro_price_tiers WHERE product_id = ANY($1::uuid[])",
      [items.map((item) => item.productId)],
    );
    const tiersByProduct = new Map();
    for (const tier of tierResult.rows) {
      const tiers = tiersByProduct.get(tier.product_id) ?? [];
      tiers.push(tier);
      tiersByProduct.set(tier.product_id, tiers);
    }
    const productsById = new Map(productsResult.rows.map((product) => [product.id, product]));
    const pricedItems = items.map((item) => {
      const product = productsById.get(item.productId);
      if (item.quantity < Number(product.min_order_quantity)) {
        throw httpError(400, "MINIMUM_ORDER_NOT_MET", `${product.name} exige une commande minimale de ${product.min_order_quantity} ${product.unit}.`);
      }
      if (item.quantity > Number(product.stock)) throw httpError(409, "INSUFFICIENT_STOCK", `Stock insuffisant pour ${product.name} : ${product.stock} ${product.unit} disponible(s).`);
      const unitPrice = getTierPrice(product.unit_price, tiersByProduct.get(product.id) ?? [], item.quantity);
      return { product, quantity: item.quantity, unitPrice, lineTotal: Math.round(unitPrice * item.quantity * 100) / 100 };
    });
    const total = Math.round(pricedItems.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
    handoffCode = handoffCodeFor(orderId);
    const orderResult = await client.query(
      `INSERT INTO pro_orders (id, buyer_id, wholesaler_id, status, total, payment_method, payment_status,
          address, delivery_latitude, delivery_longitude, notes, handoff_code_hash)
       VALUES ($1, $2, $3, 'RECEIVED', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [orderId, request.auth.userId, wholesalerId, total, paymentMethod,
        "UNPAID",
        address, latitude, longitude, String(body.notes ?? "").slice(0, 2000), handoffHash(orderId, handoffCode)],
    );
    for (const item of pricedItems) {
      await client.query(
        `INSERT INTO pro_order_items (order_id, product_id, product_name, unit, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, item.product.id, item.product.name, item.product.unit, item.quantity, item.unitPrice, item.lineTotal],
      );
      await client.query("UPDATE pro_products SET stock = stock - $2, updated_at = NOW() WHERE id = $1", [item.product.id, item.quantity]);
    }
    await insertEvent(client, orderId, request.auth.userId, "RECEIVED");
    await client.query("COMMIT");
    void notifyParticipants(orderId, "RECEIVED").catch((error) => console.error("QuartierPlus Pro push failed:", error));
    request.app.get("io")?.to(`pro-order:${orderId}`).emit("pro:order:status", { order_id: orderId, status: "RECEIVED" });
    return response.status(201).json({ order: orderResult.rows[0], items: pricedItems.map(({ product, quantity, unitPrice, lineTotal }) => ({ product_id: product.id, product_name: product.name, quantity, unit_price: unitPrice, line_total: lineTotal })), handoff_code: handoffCode });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

export const getOrder = withError(async (request, response) => {
  const order = await getOrderAccess(request.params.orderId, request.auth.userId);
  const [items, events, location] = await Promise.all([
    pool.query("SELECT * FROM pro_order_items WHERE order_id = $1 ORDER BY id", [order.id]),
    pool.query("SELECT status, note, created_at FROM pro_order_events WHERE order_id = $1 ORDER BY created_at", [order.id]),
    order.status === "IN_TRANSIT"
      ? pool.query("SELECT latitude, longitude, accuracy_meters, recorded_at FROM pro_delivery_locations WHERE order_id = $1 ORDER BY recorded_at DESC LIMIT 1", [order.id])
      : Promise.resolve({ rows: [] }),
  ]);
  return response.json({
    order,
    items: items.rows,
    events: events.rows,
    location: location.rows[0] ?? null,
    handoff_code: order.buyer_id === request.auth.userId && order.status === "IN_TRANSIT" ? handoffCodeFor(order.id) : null,
  });
});

export const cancelOrder = withError(async (request, response) => {
  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    order = await getOrderAccess(request.params.orderId, request.auth.userId, client);
    const isBuyer = order.buyer_id === request.auth.userId;
    const canManage = order.wholesaler_owner_id === request.auth.userId || order.member_role === "MANAGER";
    if (!isBuyer && !canManage) throw httpError(403, "ORDER_FORBIDDEN", "Seul l’acheteur ou l’équipe du grossiste peut annuler la commande.");
    if (!isAllowedOrderTransition(order.status, "CANCELLED")) throw httpError(409, "ORDER_CANNOT_CANCEL", "La commande ne peut plus être annulée après sa préparation.");
    await client.query("UPDATE pro_orders SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1", [order.id]);
    await client.query(
      `UPDATE pro_products products SET stock = products.stock + items.quantity, updated_at = NOW()
       FROM pro_order_items items WHERE items.order_id = $1 AND items.product_id = products.id`,
      [order.id],
    );
    await client.query("DELETE FROM pro_delivery_locations WHERE order_id = $1", [order.id]);
    await insertEvent(client, order.id, request.auth.userId, "CANCELLED");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const updated = { ...order, status: "CANCELLED", updated_at: new Date().toISOString() };
  emitOrderStatus(request, order.id, updated);
  void notifyParticipants(order.id, "CANCELLED").catch((error) => console.error("QuartierPlus Pro push failed:", error));
  return response.json({ order: updated });
});

export const updateOrderStatus = withError(async (request, response) => {
  const nextStatus = request.body?.status;
  if (!Object.hasOwn(STATUS_TRANSITIONS, nextStatus)) throw httpError(400, "INVALID_ORDER_STATUS", "Statut de commande inconnu.");
  if (nextStatus === "CANCELLED") return cancelOrder(request, response);
  if (nextStatus === "DELIVERED") throw httpError(400, "HANDOFF_CODE_REQUIRED", "La livraison doit être validée avec le code de remise à 6 chiffres.");
  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const order = await getOrderAccess(request.params.orderId, request.auth.userId, client);
    const isOwner = order.wholesaler_owner_id === request.auth.userId;
    const isManager = order.member_role === "MANAGER";
    const isDeliverer = order.deliverer_id === request.auth.userId ||
      (order.member_role === "DELIVERER" && order.status === "PREPARED");
    if (!isAllowedOrderTransition(order.status, nextStatus)) throw httpError(409, "INVALID_STATUS_TRANSITION", `Impossible de passer de ${order.status} à ${nextStatus}.`);
    if (nextStatus === "IN_TRANSIT") {
      if (!isOwner && !isManager && !isDeliverer) throw httpError(403, "DELIVERY_FORBIDDEN", "Seul le grossiste ou le livreur assigné peut démarrer la livraison.");
    } else if (!isOwner && !isManager) {
      throw httpError(403, "WHOLESALER_FORBIDDEN", "Seul le grossiste ou son responsable peut modifier ce statut.");
    }
    const delivererId = nextStatus === "IN_TRANSIT" && !order.deliverer_id ? request.auth.userId : order.deliverer_id;
    const result = await client.query(
      `UPDATE pro_orders SET status = $2, deliverer_id = $3, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [order.id, nextStatus, delivererId],
    );
    updated = result.rows[0];
    await insertEvent(client, order.id, request.auth.userId, nextStatus, String(request.body?.note ?? "").slice(0, 500));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  emitOrderStatus(request, updated.id, updated);
  void notifyParticipants(updated.id, updated.status).catch((error) => console.error("QuartierPlus Pro push failed:", error));
  return response.json({ order: updated });
});

export const updatePaymentStatus = withError(async (request, response) => {
  if (request.body?.payment_status !== "DEPOSIT_PAID") {
    throw httpError(400, "INVALID_PAYMENT_STATUS", "Le grossiste peut uniquement confirmer un acompte réglé directement.");
  }
  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const order = await getOrderAccess(request.params.orderId, request.auth.userId, client);
    if (order.wholesaler_owner_id !== request.auth.userId && order.member_role !== "MANAGER") {
      throw httpError(403, "WHOLESALER_FORBIDDEN", "Seul le grossiste ou son responsable peut confirmer l’acompte.");
    }
    if (order.payment_method !== "DIRECT_DEPOSIT") {
      throw httpError(409, "PAYMENT_METHOD_MISMATCH", "Cette commande est prévue pour un paiement à la livraison.");
    }
    if (order.status === "CANCELLED") throw httpError(409, "ORDER_CANCELLED", "Une commande annulée ne peut pas recevoir de confirmation d’acompte.");
    const result = await client.query(
      "UPDATE pro_orders SET payment_status = 'DEPOSIT_PAID', updated_at = NOW() WHERE id = $1 RETURNING *",
      [order.id],
    );
    updated = result.rows[0];
    await insertEvent(client, order.id, request.auth.userId, "PAYMENT_DEPOSIT_PAID");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  emitOrderStatus(request, updated.id, updated);
  void notifyParticipants(updated.id, "PAYMENT_DEPOSIT_PAID").catch((error) => console.error("QuartierPlus Pro push failed:", error));
  return response.json({ order: updated });
});

export const deliverOrder = withError(async (request, response) => {
  const code = String(request.body?.code ?? "");
  if (!/^\d{6}$/.test(code)) throw httpError(400, "INVALID_HANDOFF_CODE", "Le code de remise doit contenir exactement 6 chiffres.");
  const client = await pool.connect();
  let delivered;
  let handoffError;
  try {
    await client.query("BEGIN");
    const order = await getOrderAccess(request.params.orderId, request.auth.userId, client);
    if (order.status !== "IN_TRANSIT") throw httpError(409, "ORDER_NOT_IN_TRANSIT", "Le code ne peut être utilisé que pour une livraison en cours.");
    if (order.deliverer_id !== request.auth.userId) throw httpError(403, "DELIVERER_FORBIDDEN", "Seul le livreur assigné peut valider la remise.");
    if (order.payment_method === "DIRECT_DEPOSIT" && order.payment_status !== "DEPOSIT_PAID") {
      throw httpError(409, "DEPOSIT_NOT_CONFIRMED", "Le grossiste doit confirmer la réception de l’acompte directement avant la remise.");
    }
    if (order.handoff_locked_until && new Date(order.handoff_locked_until) > new Date()) {
      throw httpError(429, "HANDOFF_CODE_LOCKED", "Trop de codes incorrects. Réessayez dans 15 minutes.");
    }
    if (!doesHandoffCodeMatch(order.id, code, order.handoff_code_hash)) {
      const attempts = Number(order.failed_handoff_attempts ?? 0) + 1;
      await client.query(
        `UPDATE pro_orders SET failed_handoff_attempts = $2,
           handoff_locked_until = CASE WHEN $2 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
         WHERE id = $1`,
        [order.id, attempts],
      );
      await client.query("COMMIT");
      handoffError = attempts >= 5
        ? httpError(429, "HANDOFF_CODE_LOCKED", "Trop de codes incorrects. Réessayez dans 15 minutes.")
        : httpError(400, "HANDOFF_CODE_MISMATCH", "Code de remise incorrect. Demandez à l’acheteur de relire son code.");
    } else {
      const result = await client.query(
        `UPDATE pro_orders SET status = 'DELIVERED', delivered_at = NOW(), updated_at = NOW(),
           failed_handoff_attempts = 0, handoff_locked_until = NULL,
           payment_status = CASE WHEN payment_method = 'PAY_ON_DELIVERY' THEN 'PAID_ON_DELIVERY' ELSE payment_status END
         WHERE id = $1 RETURNING *`,
        [order.id],
      );
      delivered = result.rows[0];
      await insertEvent(client, order.id, request.auth.userId, "DELIVERED");
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (handoffError) throw handoffError;
  emitOrderStatus(request, delivered.id, delivered);
  void notifyParticipants(delivered.id, "DELIVERED").catch((error) => console.error("QuartierPlus Pro push failed:", error));
  return response.json({ order: delivered });
});

export const recordDeliveryLocation = withError(async (request, response) => {
  const latitude = Number(request.body?.latitude);
  const longitude = Number(request.body?.longitude);
  const accuracy = Number(request.body?.accuracy_meters);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000) {
    throw httpError(400, "INVALID_DELIVERY_LOCATION", "Latitude, longitude ou précision GPS invalide.");
  }
  const client = await pool.connect();
  let point;
  try {
    await client.query("BEGIN");
    const order = await getOrderAccess(request.params.orderId, request.auth.userId, client);
    if (order.status !== "IN_TRANSIT") throw httpError(409, "TRACKING_STOPPED", "Le suivi est fermé dès que la commande n’est plus en route.");
    if (order.deliverer_id !== request.auth.userId) throw httpError(403, "DELIVERER_FORBIDDEN", "Seul le livreur assigné peut partager sa position.");
    const result = await client.query(
      `INSERT INTO pro_delivery_locations (order_id, deliverer_id, latitude, longitude, accuracy_meters)
       VALUES ($1, $2, $3, $4, $5) RETURNING recorded_at`,
      [order.id, request.auth.userId, latitude, longitude, accuracy],
    );
    point = { order_id: order.id, latitude, longitude, accuracy_meters: accuracy, recorded_at: result.rows[0].recorded_at };
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  request.app.get("io")?.to(`pro-order:${order.id}`).emit("pro:delivery:location", point);
  return response.status(202).json({ location: point });
});

export const getOrderReceipt = withError(async (request, response) => {
  const order = await getOrderAccess(request.params.orderId, request.auth.userId);
  if (order.status !== "DELIVERED") throw httpError(409, "RECEIPT_NOT_READY", "Le reçu PDF est disponible après confirmation de la livraison.");
  const [items, names] = await Promise.all([
    pool.query("SELECT * FROM pro_order_items WHERE order_id = $1 ORDER BY id", [order.id]),
    pool.query(
      `SELECT wholesalers.business_name, users.full_name AS buyer_name FROM pro_orders orders
       JOIN pro_wholesalers wholesalers ON wholesalers.id = orders.wholesaler_id
       JOIN users ON users.id = orders.buyer_id WHERE orders.id = $1`,
      [order.id],
    ),
  ]);
  const pdf = createReceiptPdf({ ...order, ...names.rows[0] }, items.rows);
  response.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="quartierplus-pro-${order.id}.pdf"`, "Content-Length": String(pdf.length) });
  return response.send(pdf);
});

export const reorder = withError(async (request, response) => {
  const order = await getOrderAccess(request.params.orderId, request.auth.userId);
  if (order.buyer_id !== request.auth.userId) throw httpError(403, "BUYER_FORBIDDEN", "Seul l’acheteur peut recommander cette commande.");
  const items = await pool.query("SELECT product_id, quantity FROM pro_order_items WHERE order_id = $1 AND product_id IS NOT NULL", [order.id]);
  if (!items.rowCount) throw httpError(409, "ORDER_ITEMS_UNAVAILABLE", "Les articles de cette commande ne peuvent plus être recommandés.");
  request.body = { wholesaler_id: order.wholesaler_id, items: items.rows, payment_method: order.payment_method, address: order.address, notes: order.notes, latitude: order.delivery_latitude, longitude: order.delivery_longitude };
  return createOrder(request, response);
});

export const getRecurringLists = withError(async (request, response) => {
  const result = await pool.query("SELECT * FROM pro_recurring_lists WHERE user_id = $1 ORDER BY updated_at DESC", [request.auth.userId]);
  return response.json({ lists: result.rows });
});

export const createRecurringList = withError(async (request, response) => {
  const name = stringField(request.body?.name, 100, "Le nom de la liste");
  const wholesalerId = request.body?.wholesaler_id;
  const items = request.body?.items;
  if (!validId(wholesalerId) || !Array.isArray(items) || items.length < 1 || items.length > 50 || items.some((item) => !validId(item.product_id) || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0)) {
    throw httpError(400, "INVALID_RECURRING_LIST", "Les produits ou quantités de la liste récurrente sont invalides.");
  }
  const productIds = items.map((item) => item.product_id);
  if (new Set(productIds).size !== productIds.length) {
    throw httpError(400, "DUPLICATE_RECURRING_ITEM", "Chaque produit doit apparaître une seule fois dans la liste.");
  }
  const validProducts = await pool.query(
    "SELECT id FROM pro_products WHERE wholesaler_id = $1 AND id = ANY($2::uuid[]) AND is_active = TRUE",
    [wholesalerId, productIds],
  );
  if (validProducts.rowCount !== productIds.length) {
    throw httpError(400, "INVALID_RECURRING_PRODUCTS", "Tous les produits doivent être actifs chez le grossiste choisi.");
  }
  const result = await pool.query(
    `INSERT INTO pro_recurring_lists (user_id, wholesaler_id, name, items)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [request.auth.userId, wholesalerId, name, JSON.stringify(items)],
  );
  return response.status(201).json({ list: result.rows[0] });
});