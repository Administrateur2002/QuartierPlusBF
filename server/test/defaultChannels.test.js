import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { ensureDefaultChannels } = await import("../services/defaultChannels.js");
const { pool } = await import("../db/pool.js");

test("startup idempotently upserts emergency and announcements channels per country", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (query) => {
    statements.push(query);
    return { rowCount: 2, rows: [] };
  });

  await ensureDefaultChannels();

  const statement = statements[0];
  assert.match(statement, /INSERT INTO channels \(name, kind, country_code\)/);
  assert.match(statement, /'URGENCES', 'EMERGENCY'/);
  assert.match(statement, /'ANNONCES', 'ANNOUNCEMENTS'/);
  assert.match(statement, /ON CONFLICT \(country_code, kind\)/);
  assert.match(statement, /DO UPDATE SET name = EXCLUDED\.name/);
  assert.match(statements[1], /'International · Communauté', 'COMMUNITY', 'international'/);
});
