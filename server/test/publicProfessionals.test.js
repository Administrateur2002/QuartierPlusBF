import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  listPublicProfessionals,
  reviewProfessional,
} = await import("../controllers/proController.js");
const { pool } = await import("../db/pool.js");

const response = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

test("professional map rejects incomplete coordinates", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Invalid coordinates must not reach the database.");
  });
  const result = response();
  await listPublicProfessionals(
    { query: { latitude: "6.3" } },
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 400);
});

test("public professional cards use opt-in active plans and record unique map views", async (context) => {
  const queries = [];
  context.mock.method(pool, "query", async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes("FROM subscriptions subscription")) {
      return {
        rowCount: 1,
        rows: [{
          owner_id: "00000000-0000-4000-8000-000000000001",
          plan_type: "ALLIANCE_PRO",
          title: "Atelier du quartier",
          description: "Réparations et dépannage",
          services: "Plomberie",
          opening_hours: "Lun-Sam",
          phone: "+22501020304",
          whatsapp: "+22501020304",
          offers: ["-10% cette semaine"],
          owner_name: "Atelier",
          owner_badge: "Commerçant Certifié",
          rating_average: "4.5",
          review_count: 2,
          reviews: [{ reviewer_name: "Awa", rating: 5, comment: "Très bien" }],
          catalog: [{ title: "Réparation", price_fcfa: "2000" }],
          latitude: 6.3,
          longitude: 2.4,
          views_count: 8,
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  const result = response();

  await listPublicProfessionals(
    {
      query: { latitude: "6.3", longitude: "2.4", radius_m: "10000" },
      auth: { userId: "00000000-0000-4000-8000-000000000002" },
    },
    result,
    (error) => { throw error; },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.professionals[0].title, "Atelier du quartier");
  assert.deepEqual(result.payload.professionals[0].offers, ["-10% cette semaine"]);
  assert.equal(result.payload.professionals[0].rating_average, 4.5);
  assert.equal(result.payload.professionals[0].coordinates.latitude, 6.3);
  assert.match(queries[0].sql, /visible_on_map/);
  assert.match(queries[0].sql, /expires_at > NOW\(\)/);
  assert.match(queries[1].sql, /INSERT INTO pro_map_impressions/);
  assert.match(queries[1].sql, /ON CONFLICT DO NOTHING/);
});

test("professional reviews require a visible active business and return refreshed ratings", async (context) => {
  const queries = [];
  context.mock.method(pool, "query", async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes("FROM subscriptions")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("FROM user_blocks")) return { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO pro_reviews")) return { rowCount: 1, rows: [] };
    return { rowCount: 1, rows: [{ rating_average: "4.7", review_count: 3 }] };
  });
  const result = response();

  await reviewProfessional(
    {
      params: { ownerId: "00000000-0000-4000-8000-000000000001" },
      auth: { userId: "00000000-0000-4000-8000-000000000002" },
      body: { rating: 5, comment: "Service rapide" },
    },
    result,
    (error) => { throw error; },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.reviewed, true);
  assert.equal(result.payload.rating_average, 4.7);
  assert.match(queries[0].sql, /visible_on_map/);
  assert.match(queries[2].sql, /ON CONFLICT \(owner_id, reviewer_id\) DO UPDATE/);
});
