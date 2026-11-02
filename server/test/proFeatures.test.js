import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";

const { pool } = await import("../db/pool.js");
const {
  createFlashSale,
  getSecurityIntervention,
  getSyndicWall,
  updateSecurityIntervention,
} = await import("../controllers/proFeatureController.js");

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

test("flash sale creation rejects invalid data before database access", async () => {
  const originalQuery = pool.query;
  pool.query = async () => {
    throw new Error("Invalid flash sale input must not reach the database.");
  };
  const response = createResponse();
  try {
    await createFlashSale(
      {
        body: {
          title: "Promotion",
          discount_percent: 0,
          latitude: 6.3,
          longitude: 2.4,
        },
        auth: { userId: "user-1" },
      },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  } finally {
    pool.query = originalQuery;
  }
});

test("Syndic wall is inaccessible without an administered residence membership", async () => {
  const originalQuery = pool.query;
  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    assert.match(sql, /JOIN residence_members/);
    assert.deepEqual(params, ["user-1", null]);
    return { rows: [], rowCount: 0 };
  };
  const response = createResponse();
  try {
    await getSyndicWall(
      { auth: { userId: "user-1" }, query: {} },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 403);
    assert.equal(queryCount, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test("a security agent can claim an active SOS and receive its media references", async () => {
  const originalQuery = pool.query;
  const statements = [];
  pool.query = async (sql, params) => {
    statements.push({ sql, params });
    if (statements.length === 1) {
      return {
        rowCount: 1,
        rows: [{
          id: "intervention-1",
          sos_id: "00000000-0000-4000-8000-000000000001",
          agent_id: "agent-1",
          patient_medical_summary: {},
          status: "ACCEPTED",
          route_coordinates: [],
        }],
      };
    }
    return {
      rowCount: 1,
      rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        emergency_type: "MEDICAL",
        emergency_image_url: "https://media.example/sos.jpg",
        emergency_audio_url: null,
        latitude: 6.3,
        longitude: 2.4,
      }],
    };
  };
  const response = createResponse();
  try {
    await getSecurityIntervention(
      {
        params: { sos_id: "00000000-0000-4000-8000-000000000001" },
        auth: { userId: "agent-1" },
      },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.intervention.status, "ACCEPTED");
    assert.equal(
      response.payload.sos.emergency_image_url,
      "https://media.example/sos.jpg",
    );
    assert.match(statements[0].sql, /ON CONFLICT \(sos_id\) DO NOTHING/);
  } finally {
    pool.query = originalQuery;
  }
});

test("an intervention can advance only through its ordered status lifecycle", async () => {
  const originalQuery = pool.query;
  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    assert.match(sql, /UPDATE interventions/);
    assert.deepEqual(params, [
      "00000000-0000-4000-8000-000000000001",
      "EN_ROUTE",
      "agent-1",
      "ACCEPTED",
    ]);
    return {
      rowCount: 1,
      rows: [{ id: "intervention-1", status: "EN_ROUTE" }],
    };
  };
  const response = createResponse();
  try {
    await updateSecurityIntervention(
      {
        params: { sos_id: "00000000-0000-4000-8000-000000000001" },
        body: { status: "EN_ROUTE" },
        auth: { userId: "agent-1" },
      },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.intervention.status, "EN_ROUTE");
    assert.equal(queryCount, 1);
  } finally {
    pool.query = originalQuery;
  }
});
