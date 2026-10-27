import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const registerProCommerceHandlers = (socket) => {
  if (!env.proEnabled) return;
  socket.on("pro:order:join", async (payload, acknowledge) => {
    const orderId = String(payload?.order_id ?? "");
    if (!UUID_PATTERN.test(orderId)) {
      if (typeof acknowledge === "function") acknowledge({ error: "Identifiant de commande invalide." });
      return;
    }
    try {
      const result = await pool.query(
        `SELECT orders.id
         FROM pro_orders orders
         JOIN pro_wholesalers wholesalers ON wholesalers.id = orders.wholesaler_id
         LEFT JOIN pro_wholesaler_members members
           ON members.wholesaler_id = orders.wholesaler_id
          AND members.user_id = $2
         WHERE orders.id = $1
           AND (orders.buyer_id = $2 OR wholesalers.user_id = $2
             OR orders.deliverer_id = $2 OR members.member_role = 'MANAGER'
             OR (members.member_role = 'DELIVERER'
               AND orders.status = 'PREPARED' AND orders.deliverer_id IS NULL))`,
        [orderId, socket.data.user.id],
      );
      if (!result.rowCount) {
        if (typeof acknowledge === "function") acknowledge({ error: "Vous ne participez pas à cette commande." });
        return;
      }
      await socket.join(`pro-order:${orderId}`);
      if (typeof acknowledge === "function") acknowledge({ ok: true, order_id: orderId });
    } catch (error) {
      console.error("Unable to authorize QuartierPlus Pro order socket:", error);
      if (typeof acknowledge === "function") acknowledge({ error: "Impossible de vérifier l’accès à cette commande." });
    }
  });

  socket.on("pro:order:leave", async (payload) => {
    const orderId = String(payload?.order_id ?? "");
    if (UUID_PATTERN.test(orderId)) await socket.leave(`pro-order:${orderId}`);
  });
};