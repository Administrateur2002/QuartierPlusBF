import { pool } from "../db/pool.js";

export const cleanupExpiredProDeliveryLocations = async () => {
  const schema = await pool.query("SELECT to_regclass('public.pro_delivery_locations') AS table_name");
  if (!schema.rows[0]?.table_name) return 0;
  const result = await pool.query("SELECT pro_delete_expired_delivery_locations() AS deleted_count");
  return Number(result.rows[0]?.deleted_count ?? 0);
};

export const scheduleProDeliveryLocationCleanup = () => {
  const run = () => {
    void cleanupExpiredProDeliveryLocations().catch((error) => {
      console.error("QuartierPlus Pro location cleanup failed:", error);
    });
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
};