import { env } from "../config/env.js";
import { IS_PROMO_FREE_ACCESS } from "../config/monetization.js";
import { pool } from "../db/pool.js";
import { getCloudinaryAsset } from "../services/cloudinary.js";
import { normalizeProPublication } from "../services/proPublication.js";

const PLANS = new Set([
  "ALLIANCE_PRO",
  "SYNDIC",
  "TOWN_HALL",
  "SECURITY_AGENT",
  "WHOLESALER",
  "TRANSPORT_COMPANY",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidPin = (pin) =>
  pin &&
  typeof pin === "object" &&
  typeof pin.merchant_item_id === "string" &&
  typeof pin.caption === "string" &&
  pin.caption.trim().length > 0 &&
  pin.caption.trim().length <= 300 &&
  (pin.sponsored_pin_id === undefined ||
    (typeof pin.sponsored_pin_id === "string" &&
      UUID_PATTERN.test(pin.sponsored_pin_id)));

const getPinImageUrl = async (userId, publicId) => {
  if (publicId === undefined || publicId === null || publicId === "") return null;
  if (
    typeof publicId !== "string" ||
    publicId.length > 255 ||
    !publicId.startsWith(`${userId}_`)
  ) {
    return { error: "La photo téléversée ne vous appartient pas." };
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
    return { error: "La photo téléversée est introuvable ou invalide." };
  }
  return { url: asset.secure_url };
};

export const activateFreeOffer = async (request, response, next) => {
  if (env.billingEnabled && !IS_PROMO_FREE_ACCESS) {
    return response.status(403).json({
      error: "Cette offre nécessite le parcours de paiement.",
    });
  }
  const offer = request.body?.payment_type;
  const pin = request.body?.pin;
  const publication = normalizeProPublication(request.body?.publication);
  if (
    offer === "SPONSORED_PIN" &&
    !isValidPin(pin)
  ) {
    return response.status(400).json({
      error: "Choisissez un commerce et rédigez un texte de 300 caractères maximum.",
    });
  }
  if (offer !== "SPONSORED_PIN" && !PLANS.has(offer)) {
    return response.status(400).json({ error: "Offre invalide." });
  }
  if (offer !== "SPONSORED_PIN" && !publication) {
    return response.status(400).json({
      error: "Le nom de la structure et sa présentation sont obligatoires.",
    });
  }

  try {
    if (offer === "SPONSORED_PIN") {
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
      const image = await getPinImageUrl(
        request.auth.userId,
        pin.media_public_id,
      );
      if (image?.error) {
        return response.status(400).json({ error: image.error });
      }
      if (pin.sponsored_pin_id) {
        const renewed = await pool.query(
          `UPDATE sponsored_pins AS campaign
           SET title = item.title,
               location = item.location::geography,
               icon_url = COALESCE($3, campaign.icon_url),
               caption = $4,
               starts_at = CASE
                 WHEN campaign.expires_at <= NOW() THEN NOW()
                 ELSE campaign.starts_at
               END,
               expires_at = GREATEST(campaign.expires_at, NOW()) + INTERVAL '7 days',
               is_active = TRUE
           FROM marketplace_items AS item
           WHERE campaign.id = $1 AND campaign.user_id = $2
             AND item.id = $5 AND item.seller_id = $2
             AND campaign.marketplace_item_id = item.id
           RETURNING campaign.id, campaign.title, campaign.starts_at, campaign.expires_at`,
          [
            pin.sponsored_pin_id,
            request.auth.userId,
            image?.url ?? null,
            pin.caption.trim(),
            pin.merchant_item_id,
          ],
        );
        if (!renewed.rowCount) {
          return response.status(404).json({
            error: "La campagne à renouveler est introuvable ou ne vous appartient pas.",
          });
        }
        return response.status(200).json({
          activated: true,
          renewed: true,
          pin: renewed.rows[0],
        });
      }
      const result = await pool.query(
        `INSERT INTO sponsored_pins
           (user_id, title, location, icon_url, caption, marketplace_item_id,
            starts_at, expires_at, is_active)
         SELECT $2, item.title, item.location::geography, $3, $4, item.id,
                NOW(), NOW() + INTERVAL '7 days', TRUE
         FROM marketplace_items AS item
         WHERE item.id = $1 AND item.seller_id = $2
         RETURNING id, title, starts_at, expires_at`,
        [pin.merchant_item_id, request.auth.userId, image?.url ?? null, pin.caption.trim()],
      );
      return response.status(201).json({ activated: true, pin: result.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO subscriptions
         (user_id, plan_type, status, starts_at, expires_at, publication)
       VALUES ($1, $2, 'ACTIVE', NOW(), NOW() + INTERVAL '30 days', $3::jsonb)
       ON CONFLICT (user_id, plan_type) DO UPDATE
       SET status = 'ACTIVE',
           publication = EXCLUDED.publication,
           starts_at = CASE
             WHEN subscriptions.expires_at <= NOW() THEN NOW()
             ELSE subscriptions.starts_at
           END,
           expires_at = GREATEST(subscriptions.expires_at, NOW())
             + INTERVAL '30 days'
       RETURNING plan_type, status, starts_at, expires_at`,
      [request.auth.userId, offer, JSON.stringify(publication)],
    );
    if (offer === "ALLIANCE_PRO") {
      await pool.query(
        "UPDATE users SET badge = 'Commerçant Certifié' WHERE id = $1",
        [request.auth.userId],
      );
    }
    return response.status(201).json({
      activated: true,
      subscription: result.rows[0],
    });
  } catch (error) {
    return next(error);
  }
};
