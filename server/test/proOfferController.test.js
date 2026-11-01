import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.BILLING_ENABLED = "false";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { activateFreeOffer } = await import("../controllers/proOfferController.js");
const { pool } = await import("../db/pool.js");

const USER_ID = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
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

test("free Pro offer activation inserts an active subscription immediately", async (context) => {
  const calls = [];
  context.mock.method(pool, "query", async (sql, values) => {
    calls.push({ sql, values });
    return { rowCount: 1, rows: [{ plan_type: "SYNDIC", status: "ACTIVE" }] };
  });

  const result = response();

  await activateFreeOffer(
    {
      auth: { userId: USER_ID },
      body: {
        payment_type: "SYNDIC",
        publication: { title: "Syndic", description: "Présentation du syndic." },
      },
    },
    result,
    (error) => {
      throw error;
    },
  );

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.activated, true);
  assert.match(calls[0].sql, /NOW\(\) \+ INTERVAL '30 days'/);
  assert.deepEqual(calls[0].values, [
    USER_ID,
    "SYNDIC",
    JSON.stringify({ title: "Syndic", description: "Présentation du syndic." }),
  ]);
});

test("free commerce plans activate subscriptions with their publication details", async (context) => {
  let inserted;
  context.mock.method(pool, "query", async (sql, values) => {
    inserted = { sql, values };
    return { rowCount: 1, rows: [{ plan_type: values[1], status: "ACTIVE" }] };
  });
  const result = response();

  await activateFreeOffer(
    {
      auth: { userId: USER_ID },
      body: {
        payment_type: "WHOLESALER",
        publication: { title: "Grossiste du centre", description: "Catalogue local" },
      },
    },
    result,
    (error) => { throw error; },
  );

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.subscription.plan_type, "WHOLESALER");
  assert.deepEqual(inserted.values, [
    USER_ID,
    "WHOLESALER",
    JSON.stringify({ title: "Grossiste du centre", description: "Catalogue local" }),
  ]);
});

test("free sponsored pin requires a user-owned commerce and short publication text", async (context) => {
  let callCount = 0;
  context.mock.method(pool, "query", async (sql) => {
    callCount += 1;
    if (callCount === 1) return { rowCount: 1, rows: [{ id: "item-id" }] };
    assert.match(sql, /INSERT INTO sponsored_pins/);
    return { rowCount: 1, rows: [{ id: "pin-id" }] };
  });
  const result = response();

  await activateFreeOffer(
    {
      auth: { userId: USER_ID },
      body: {
        payment_type: "SPONSORED_PIN",
        pin: { merchant_item_id: "item-id", caption: "Mon commerce" },
      },
    },
    result,
    (error) => {
      throw error;
    },
  );

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.pin.id, "pin-id");
  assert.equal(callCount, 2);
});
