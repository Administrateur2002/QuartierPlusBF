import { pool } from "../db/pool.js";
import { sendExpoPushNotifications } from "./pushNotifications.js";

export const notifyNearbySosResponders = async ({
  alert,
  radiusKm,
  excludeUserId,
  nearbyUserIds = [],
}) => {
  const [nearbyTokens, responderTokens] = await Promise.all([
    pool.query(
      "SELECT token FROM push_tokens WHERE user_id = ANY($1::uuid[])",
      [nearbyUserIds],
    ),
    pool.query(
      `SELECT DISTINCT pt.token
       FROM sos_alerts s
       JOIN neighbor_responders nr
         ON nr.is_certified_first_aider = TRUE
       JOIN users u ON u.id = nr.user_id AND u.id <> $2
       JOIN push_tokens pt ON pt.user_id = u.id
       WHERE s.id = $1 AND s.status = 'ACTIVE'
         AND u.last_location IS NOT NULL
         AND ST_DWithin(
           u.last_location::geography,
           s.location::geography,
           LEAST(nr.radius_coverage_m, $3)
         )`,
      [alert.id, excludeUserId, radiusKm * 1000],
    ),
  ]);

  await sendExpoPushNotifications(
    [
      ...nearbyTokens.rows.map((row) => row.token),
      ...responderTokens.rows.map((row) => row.token),
    ],
    {
      title: `SOS ${(alert.emergency_type ?? "OTHER").toLowerCase()}`,
      body: `Une alerte est active dans un rayon de ${radiusKm} km. Si vous êtes secouriste, ouvrez QuartierPlus pour intervenir.`,
      priority: "high",
      channelId: "sos",
      data: {
        type: "sos",
        priority: "high",
        alertId: alert.id,
        emergencyType: alert.emergency_type ?? "OTHER",
      },
    },
  );
  return {
    nearbyRecipients: nearbyTokens.rowCount,
    certifiedResponders: responderTokens.rowCount,
  };
};
