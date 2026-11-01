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
             AS active_pins_count`,
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
