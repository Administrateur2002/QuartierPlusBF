import { createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import {
  createFedaPayTransaction,
  getFedaPayTransaction,
} from "../services/fedapay.js";
import { issueTicket } from "../services/tickets.service.js";
import { getCloudinaryAsset } from "../services/cloudinary.js";
import { IS_PROMO_FREE_ACCESS } from "../config/monetization.js";

const OFFERS = {
  ALLIANCE_PRO: {
    amount: 5000,
    description: "Alliance Pro - 30 jours",
    durationDays: 30,
  },
  SPONSORED_PIN: {
    amount: 2000,
    description: "Épingle sponsorisée - 7 jours",
    durationDays: 7,
  },
  SYNDIC: { amount: 2500, description: "Syndic - 30 jours", durationDays: 30 },
  TOWN_HALL: {
    amount: 75000,
    description: "Mairie - 30 jours",
    durationDays: 30,
  },
  SECURITY_AGENT: {
    amount: 50000,
    description: "Accès Certifié Secours - 30 jours",
    durationDays: 30,
  },
  WHOLESALER: {
    amount: 25000,
    description: "Espace Grossiste - 30 jours",
    durationDays: 30,
  },
  TRANSPORT_COMPANY: {
    amount: 20000,
    description: "Espace Compagnie de transport - 30 jours",
    durationDays: 30,
  },
};

const getTransactionId = (body) =>
  body?.entity?.id ??
  body?.data?.id ??
  body?.transaction?.id ??
  body?.["v1/transaction"]?.id;

const normalizePhone = (phone, prefix) => {
  let normalized = phone?.replace(/\D/g, "") ?? "";
  const nationalPrefix = prefix?.replace(/\D/g, "") ?? "";
  if (nationalPrefix && normalized.startsWith(nationalPrefix)) {
    normalized = normalized.slice(nationalPrefix.length);
  }
  return normalized;
};

const validatePin = (value) => {
  if (!value || typeof value !== "object") return null;
  const merchantItemId =
    typeof value.merchant_item_id === "string" ? value.merchant_item_id : "";
  const caption = typeof value.caption === "string" ? value.caption.trim() : "";
  if (
    !/^[0-9a-f-]{36}$/i.test(merchantItemId) ||
    !caption ||
    caption.length > 300
  ) {
    return null;
  }
  return {
    merchant_item_id: merchantItemId,
    caption,
    media_public_id:
      typeof value.media_public_id === "string" ? value.media_public_id : null,
  };
};

const validatePublication = (value) => {
  if (!value || typeof value !== "object") return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (!title || title.length > 150 || !description || description.length > 500) {
    return null;
  }
  return { title, description };
};

export const createTransaction = async (request, response, next) => {
  if (!env.billingEnabled || IS_PROMO_FREE_ACCESS) {
    return response.status(403).json({
      error: "Le paiement est désactivé pendant la phase de test.",
    });
  }
  const paymentType = request.body?.payment_type;
  const offer = Object.hasOwn(OFFERS, paymentType) ? OFFERS[paymentType] : null;
  if (!offer) {
    return response.status(400).json({ error: "Offre de paiement invalide." });
  }

  const pin =
    paymentType === "SPONSORED_PIN" ? validatePin(request.body?.pin) : null;
  const publication =
    paymentType === "SPONSORED_PIN"
      ? null
      : validatePublication(request.body?.publication);
  if (paymentType === "SPONSORED_PIN" && !pin) {
    return response.status(400).json({
      error: "Choisissez un commerce et saisissez un texte court pour l'épingle.",
    });
  }
  if (paymentType !== "SPONSORED_PIN" && offer && !publication) {
    return response.status(400).json({
      error: "Le nom de la structure et sa présentation sont obligatoires.",
    });
  }

  try {
    if (paymentType === "SPONSORED_PIN") {
      const ownedItem = await pool.query(
        `SELECT id FROM marketplace_items
         WHERE id = $1 AND seller_id = $2`,
        [pin.merchant_item_id, request.auth.userId],
      );
      if (!ownedItem.rowCount) {
        return response.status(400).json({
          error: "Le commerce sélectionné ne vous appartient pas.",
        });
      }
      if (pin.media_public_id) {
        const publicId = pin.media_public_id;
        if (
          publicId.length > 255 ||
          !publicId.startsWith(`${request.auth.userId}_`)
        ) {
          return response.status(400).json({
            error: "La photo téléversée ne vous appartient pas.",
          });
        }
        const asset = await getCloudinaryAsset("image", publicId);
        if (
          !asset ||
          asset.public_id !== publicId ||
          typeof asset.secure_url !== "string" ||
          !asset.secure_url.startsWith(
            `https://res.cloudinary.com/${env.cloudinaryCloudName}/`,
          )
        ) {
          return response.status(400).json({
            error: "La photo téléversée est introuvable ou invalide.",
          });
        }
        pin.icon_url = asset.secure_url;
      }
    }
    const userResult = await pool.query(
      `SELECT u.full_name, u.email, u.phone_number, u.country_code,
              c.phone_prefix
       FROM users u
       LEFT JOIN country_config c ON c.code = u.country_code
       WHERE u.id = $1`,
      [request.auth.userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    const phoneNumber = normalizePhone(user.phone_number, user.phone_prefix);
    if (!phoneNumber || !user.country_code || !user.phone_prefix) {
      return response.status(400).json({
        error: "Un numéro de téléphone vérifié et son pays sont requis pour payer.",
      });
    }

    const customer = {
      firstname: user.full_name?.trim().split(/\s+/)[0] || "Utilisateur",
      lastname: user.full_name?.trim().split(/\s+/).slice(1).join(" ") || "QuartierPlus",
      phone_number: {
        number: Number(phoneNumber),
        country: user.country_code || "BJ",
      },
      ...(user.email ? { email: user.email } : {}),
    };
    const { transaction, paymentUrl } = await createFedaPayTransaction({
      amount: offer.amount,
      description: offer.description,
      customer,
    });
    const metadata = {
      ...(pin ? { pin } : {}),
      ...(publication ? { publication } : {}),
    };
    const saved = await pool.query(
      `INSERT INTO transactions
         (user_id, fedapay_tx_id, amount, currency, payment_type, metadata)
       VALUES ($1, $2, $3, 'XOF', $4, $5)
       RETURNING id, status`,
      [
        request.auth.userId,
        String(transaction.id),
        offer.amount,
        paymentType,
        JSON.stringify(metadata),
      ],
    );
    return response.status(201).json({
      transaction_id: saved.rows[0].id,
      status: saved.rows[0].status,
      payment_url: paymentUrl,
    });
  } catch (error) {
    return next(error);
  }
};

export const getTransactionStatus = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, status, payment_type
       FROM transactions WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Transaction introuvable." });
    }
    return response.status(200).json({ transaction: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const listSponsoredPins = async (request, response, next) => {
  const latitude = Number(request.query.latitude);
  const longitude = Number(request.query.longitude);
  const radius = Number(request.query.radius_m ?? 30_000);
  const hasLocation =
    request.query.latitude !== undefined &&
    request.query.longitude !== undefined;
  if (
    (hasLocation &&
      (!Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180)) ||
    !Number.isFinite(radius) ||
    radius < 1 ||
    radius > 100_000
  ) {
    return response.status(400).json({ error: "Position ou rayon invalide." });
  }

  try {
    const result = await pool.query(
      `SELECT id, title, icon_url, expires_at,
              ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude
       FROM sponsored_pins
       WHERE is_active = TRUE AND expires_at > NOW()
         AND ($1::boolean = FALSE OR ST_DWithin(
           location,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           $4
         ))
       ORDER BY starts_at DESC
       LIMIT 500`,
      [hasLocation, longitude, latitude, radius],
    );
    return response.status(200).json({
      pins: result.rows.map((pin) => ({
        ...pin,
        category: "MERCHANT_PRO",
        coordinates: {
          latitude: Number(pin.latitude),
          longitude: Number(pin.longitude),
        },
        status: "ACTIVE",
        is_sponsored: true,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

export const handleFedaPayWebhook = async (request, response, next) => {
  const expectedSecret = env.fedapayWebhookSecret;
  if (!expectedSecret) {
    return response.status(503).json({
      error: "Le webhook FedaPay n'est pas configuré.",
      code: "FEDAPAY_WEBHOOK_SECRET_MISSING",
      reason: "Variable FEDAPAY_WEBHOOK_SECRET manquante (code FEDAPAY_WEBHOOK_SECRET_MISSING).",
    });
  }
  if (!Buffer.isBuffer(request.rawBody)) {
    return response.status(400).json({
      error: "Le corps brut du webhook FedaPay est absent.",
      code: "FEDAPAY_RAW_BODY_MISSING",
      reason: "Le middleware JSON n'a pas conservé le corps brut (code FEDAPAY_RAW_BODY_MISSING).",
    });
  }
  const suppliedSignature = (request.get("x-fedapay-signature") ?? "")
    .replace(/^sha256=/i, "")
    .trim();
  const expectedSignature = createHmac("sha256", expectedSecret)
    .update(request.rawBody)
    .digest("hex");
  const suppliedBytes = Buffer.from(suppliedSignature, "hex");
  const expectedBytes = Buffer.from(expectedSignature, "hex");
  if (
    !/^[a-f0-9]{64}$/i.test(suppliedSignature) ||
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return response.status(401).json({
      error: "Signature du webhook FedaPay invalide.",
      code: "FEDAPAY_SIGNATURE_INVALID",
      reason: "La signature HMAC-SHA256 ne correspond pas au corps brut (code FEDAPAY_SIGNATURE_INVALID).",
    });
  }

  const event = request.body?.name ?? request.body?.event;
  const fedapayId = getTransactionId(request.body);
  if (!fedapayId || typeof event !== "string") {
    return response.status(400).json({ error: "Événement FedaPay invalide." });
  }
  if (!["transaction.approved", "transaction.declined", "transaction.canceled"].includes(event)) {
    return response.status(200).json({ received: true, ignored: true });
  }

  try {
    const verified = await getFedaPayTransaction(String(fedapayId));
    if (String(verified?.id) !== String(fedapayId)) {
      return response.status(400).json({ error: "Transaction FedaPay non vérifiée." });
    }

    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await connection.query(
        `SELECT id, user_id, amount, currency, status, payment_type, metadata
         FROM transactions WHERE fedapay_tx_id = $1 FOR UPDATE`,
        [String(fedapayId)],
      );
      const payment = result.rows[0];
      if (!payment) {
        await connection.query("ROLLBACK");
        return response.status(404).json({ error: "Transaction locale introuvable." });
      }

      const providerStatus = String(verified.status ?? "").toLowerCase();
      const expectedProviderStatuses = {
        "transaction.approved": ["approved"],
        "transaction.declined": ["declined", "failed"],
        "transaction.canceled": ["canceled", "cancelled"],
      };
      if (!expectedProviderStatuses[event].includes(providerStatus)) {
        await connection.query("ROLLBACK");
        return response.status(409).json({
          error: "Le statut de cette transaction n'est pas confirmé par FedaPay.",
        });
      }
      const providerCurrency = String(
        verified.currency?.iso ?? verified.currency ?? "",
      ).toUpperCase();
      if (
        Number(verified.amount) !== Number(payment.amount) ||
        (providerCurrency &&
          providerCurrency !== payment.currency.trim().toUpperCase())
      ) {
        await connection.query("ROLLBACK");
        return response.status(409).json({
          error: "Le montant ou la devise ne correspond pas à la transaction locale.",
        });
      }
      if (payment.status !== "PENDING") {
        await connection.query("COMMIT");
        return response.status(200).json({ received: true, already_processed: true });
      }

      if (event === "transaction.approved") {
        await connection.query(
          `UPDATE transactions SET status = 'APPROVED', updated_at = NOW()
           WHERE id = $1`,
          [payment.id],
        );
        if (payment.payment_type === "TICKET") {
          const { event_id: eventId, reservation_id: reservationId } =
            payment.metadata ?? {};
          if (!eventId || !reservationId) {
            throw new Error("Les données de réservation du billet sont absentes.");
          }
          const reservation = await connection.query(
            `SELECT id, event_id, user_id, status
             FROM event_ticket_reservations
             WHERE id = $1 AND event_id = $2 AND user_id = $3
               AND transaction_id = $4
             FOR UPDATE`,
            [reservationId, eventId, payment.user_id, payment.id],
          );
          if (!reservation.rowCount || reservation.rows[0].status !== "PENDING") {
            throw new Error("La réservation du billet est introuvable ou déjà traitée.");
          }
          await issueTicket(connection, eventId, payment.user_id);
          await connection.query(
            `UPDATE event_ticket_reservations
             SET status = 'APPROVED' WHERE id = $1`,
            [reservationId],
          );
        } else {
          const offer = OFFERS[payment.payment_type];
          if (!offer) {
            throw new Error("Le type de paiement confirmé n'est pas pris en charge.");
          }
          if (payment.payment_type !== "SPONSORED_PIN") {
            await connection.query(
              `INSERT INTO subscriptions
                 (user_id, plan_type, status, starts_at, expires_at, publication)
               VALUES (
                 $1, $2, 'ACTIVE', NOW(),
                 NOW() + ($3 * INTERVAL '1 day'), $4::jsonb
               )
               ON CONFLICT (user_id, plan_type) DO UPDATE
               SET status = 'ACTIVE',
                   publication = EXCLUDED.publication,
                   starts_at = CASE
                     WHEN subscriptions.expires_at <= NOW() THEN NOW()
                     ELSE subscriptions.starts_at
                   END,
                   expires_at = GREATEST(subscriptions.expires_at, NOW())
                     + ($3 * INTERVAL '1 day')`,
              [
                payment.user_id,
                payment.payment_type,
                offer.durationDays,
                JSON.stringify(payment.metadata?.publication ?? {}),
              ],
            );
            if (payment.payment_type === "ALLIANCE_PRO") {
              await connection.query(
                "UPDATE users SET badge = 'Commerçant Certifié' WHERE id = $1",
                [payment.user_id],
              );
            }
          } else if (payment.payment_type === "SPONSORED_PIN") {
            const pin = payment.metadata?.pin;
            if (!pin) {
              throw new Error("Les données de l'épingle payée sont absentes.");
            }
            await connection.query(
              `INSERT INTO sponsored_pins
                 (user_id, title, location, icon_url, caption, marketplace_item_id,
                  starts_at, expires_at, is_active)
               SELECT $1, item.title, item.location::geography, $2, $3, item.id,
                      NOW(), NOW() + INTERVAL '7 days', TRUE
               FROM marketplace_items AS item
               WHERE item.id = $4 AND item.seller_id = $1`,
              [payment.user_id, pin.icon_url ?? null, pin.caption, pin.merchant_item_id],
            );
          }
        }
      } else {
        const status = event === "transaction.canceled" ? "CANCELED" : "FAILED";
        await connection.query(
          "UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2",
          [status, payment.id],
        );
        if (payment.payment_type === "TICKET" && payment.metadata?.reservation_id) {
          await connection.query(
            `UPDATE event_ticket_reservations SET status = 'CANCELLED'
             WHERE id = $1 AND status = 'PENDING'`,
            [payment.metadata.reservation_id],
          );
        }
      }
      await connection.query("COMMIT");
      return response.status(200).json({ received: true });
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    return next(error);
  }
};
