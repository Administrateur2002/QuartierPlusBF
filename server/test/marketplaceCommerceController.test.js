import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createMarketplaceReview,
  isAllowedMarketplaceOrderTransition,
} = await import("../controllers/marketplaceCommerceController.js");
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

test("marketplace orders follow the declared shipment lifecycle", () => {
  for (const [current, next] of [
    ["SENT", "ACCEPTED"],
    ["SENT", "CANCELLED"],
    ["ACCEPTED", "PREPARING"],
    ["ACCEPTED", "CANCELLED"],
    ["PREPARING", "SHIPPED"],
    ["PREPARING", "DELIVERED"],
    ["PREPARING", "CANCELLED"],
    ["SHIPPED", "DELIVERED"],
  ]) {
    assert.equal(isAllowedMarketplaceOrderTransition(current, next), true);
  }
  for (const [current, next] of [
    ["SENT", "DELIVERED"],
    ["ACCEPTED", "SHIPPED"],
    ["SHIPPED", "CANCELLED"],
    ["DELIVERED", "CANCELLED"],
    ["CANCELLED", "ACCEPTED"],
  ]) {
    assert.equal(isAllowedMarketplaceOrderTransition(current, next), false);
  }
});

test("marketplace review validates rating before accessing the database", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("An invalid review must not be inserted.");
  });
  const response = createResponse();

  await createMarketplaceReview(
    {
      params: { orderId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
      body: { rating: 6, comment: "Not valid" },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "INVALID_RATING");
});

test("marketplace review insertion is restricted to delivered buyer orders", async (context) => {
  context.mock.method(pool, "query", async (statement, values) => {
    assert.match(statement, /orders\.buyer_id = \$2/);
    assert.match(statement, /orders\.status = 'DELIVERED'/);
    assert.match(statement, /ON CONFLICT \(order_id\) DO NOTHING/);
    assert.deepEqual(values, [
      "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
      "1b490a29-02dd-44ad-8c9f-81d9cadc0001",
      5,
      "Bien reçu",
    ]);
    return {
      rowCount: 1,
      rows: [{ id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003", rating: 5 }],
    };
  });
  const response = createResponse();

  await createMarketplaceReview(
    {
      params: { orderId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
      body: { rating: 5, comment: "Bien reçu" },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.review.rating, 5);
});
