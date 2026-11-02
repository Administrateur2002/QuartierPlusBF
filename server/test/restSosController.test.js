import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";

const { pool } = await import("../db/pool.js");
const { createSosAlert } = await import("../controllers/restSosController.js");

const createResponse = () => ({
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

test("REST SOS rejects inaccurate GPS before touching the database", async () => {
  const originalConnect = pool.connect;
  pool.connect = async () => {
    throw new Error("Invalid SOS data must not reach the database.");
  };
  const response = createResponse();
  try {
    await createSosAlert(
      {
        body: {
          latitude: 6.3,
          longitude: 2.4,
          accuracy_m: 201,
          emergency_type: "MEDICAL",
        },
        auth: { userId: "user-1" },
      },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  } finally {
    pool.connect = originalConnect;
  }
});

test("REST SOS persists the GPS, escalation, and optional emergency media", async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const statements = [];
  pool.connect = async () => ({
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM users")) {
        return { rows: [{ phone_verified: true, is_new_account: false }] };
      }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }] };
      if (sql.includes("INSERT INTO sos_alerts")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            latitude: 6.3,
            longitude: 2.4,
            status: "ACTIVE",
            emergency_type: "FIRE",
            escalation_level: 2,
            emergency_image_url: "https://media.example/sos.jpg",
            emergency_audio_url: null,
          }],
        };
      }
      throw new Error(`Unexpected SQL in REST SOS test: ${sql}`);
    },
    release() {},
  });
  pool.query = async () => ({ rows: [] });
  const response = createResponse();
  try {
    await createSosAlert(
      {
        body: {
          latitude: 6.3,
          longitude: 2.4,
          accuracy_m: 18,
          emergency_type: "FIRE",
          escalation_level: 2,
          emergency_image_url: "https://media.example/sos.jpg",
        },
        auth: { userId: "00000000-0000-4000-8000-000000000002" },
      },
      response,
      (error) => { throw error; },
    );
    const insert = statements.find(({ sql }) => sql.includes("INSERT INTO sos_alerts"));
    assert.ok(insert);
    assert.deepEqual(insert.params, [
      "00000000-0000-4000-8000-000000000002",
      2.4,
      6.3,
      "FIRE",
      2,
      "https://media.example/sos.jpg",
      null,
    ]);
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.alert.escalation_radius_km, 10);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});
