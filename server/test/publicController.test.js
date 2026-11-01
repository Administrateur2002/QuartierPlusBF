import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { listNearbyAlerts, listPublicMarketplace } = await import(
  "../controllers/publicController.js"
);
const {
  getMediaStatus,
  getPublicConfig,
} = await import("../controllers/publicController.js");
const { pool } = await import("../db/pool.js");

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

test("public marketplace returns an empty successful feed when there are no items", async (context) => {
  let queryValues;
  context.mock.method(pool, "query", async (_statement, values) => {
    queryValues = values;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await listPublicMarketplace({ query: {} }, response, (error) => {
    throw error;
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { items: [] });
  assert.deepEqual(queryValues, [null, null, null, null, null, null, null, null, 0]);
});

test("nearby SOS alerts accept valid radius filters and return an empty list", async (context) => {
  let queryValues;
  let queryStatement;
  context.mock.method(pool, "query", async (statement, values) => {
    queryStatement = statement;
    queryValues = values;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await listNearbyAlerts(
    {
      query: {
        latitude: "12.37",
        longitude: "-1.52",
        radius_m: "30000",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { alerts: [] });
  assert.deepEqual(queryValues, [12.37, -1.52, 30_000, null, null]);
  assert.match(queryStatement, /ST_SnapToGrid\(alert\.location, 0\.002\)/);
  assert.doesNotMatch(queryStatement, /ST_Y\(alert\.location\)/);
});

test("public feed rejects invalid coordinates instead of ignoring the filter", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Invalid coordinates must not query the database.");
  });
  const response = createResponse();

  await listPublicMarketplace(
    { query: { latitude: "91", longitude: "0" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /position/);
});

test("country scope filters marketplace posts by country without coordinates", async (context) => {
  let queryValues;
  context.mock.method(pool, "query", async (_statement, values) => {
    queryValues = values;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await listPublicMarketplace(
    { query: { scope: "country", country_code: "bf" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(queryValues, [null, null, null, "BF", "country", null, null, null, 0]);
});

test("public marketplace rejects invalid pagination offsets without querying", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("An invalid page must not query the database.");
  });
  const response = createResponse();

  await listPublicMarketplace(
    { query: { scope: "country", country_code: "BF", offset: "1.5" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /page/i);
});

test("neighborhood scope rejects missing position and country code", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Invalid scopes must not query the database.");
  });

  test("public configuration reports billing state without private configuration", () => {
    const response = createResponse();
    getPublicConfig({}, response);
    assert.deepEqual(response.payload, {
      billingEnabled: false,
      promoFreeAccess: false,
    });
  });

  test("media status reports configuration names only", () => {
    const response = createResponse();
    getMediaStatus({}, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      Object.keys(response.payload).sort(),
      ["cloudinaryConfigured", "livekitConfigured", "missing"].sort(),
    );
    assert.equal(Array.isArray(response.payload.missing), true);
    assert.equal(JSON.stringify(response.payload).includes("secret"), false);
    assert.equal(JSON.stringify(response.payload).includes("apiKey"), false);
  });
  const response = createResponse();

  await listPublicMarketplace(
    { query: { scope: "neighborhood" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
});
