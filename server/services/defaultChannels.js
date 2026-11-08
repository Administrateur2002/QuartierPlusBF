import { pool } from "../db/pool.js";

export const ensureDefaultChannels = async () => {
  await pool.query(
    `INSERT INTO channels (name, kind, country_code)
     SELECT channel.name, channel.kind, country.code
     FROM country_config AS country
     CROSS JOIN (
       VALUES
         ('URGENCES', 'EMERGENCY'),
         ('ANNONCES', 'ANNOUNCEMENTS'),
         ('Communauté', 'COMMUNITY')
     ) AS channel(name, kind)
     ON CONFLICT (country_code, kind)
       WHERE country_code IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
  );
  await pool.query(
    `INSERT INTO channels (name, kind, geography_scope)
     SELECT 'International · Communauté', 'COMMUNITY', 'international'
     WHERE NOT EXISTS (
       SELECT 1 FROM channels
       WHERE kind = 'COMMUNITY'
         AND geography_scope = 'international'
         AND country_code IS NULL
         AND communication_area_id IS NULL
     )`,
  );
};
