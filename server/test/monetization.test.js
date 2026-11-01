import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.IS_PROMO_FREE_ACCESS = "true";

const { pool } = await import("../db/pool.js");
const { proRoleGuard } = await import("../middlewares/proRoleGuard.js");
const { getMySubscription } = await import("../controllers/proController.js");

test("promo mode does not bypass an expired or missing Pro entitlement", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [], rowCount: 0 });
  try {
    for (const plan of ["ALLIANCE_PRO", "SYNDIC", "TOWN_HALL", "SECURITY_AGENT"]) {
      const response = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        },
      };
      const request = { auth: { userId: "citizen-1" } };
      let nextCalled = false;
      await proRoleGuard(plan)(
        request,
        response,
        () => {
          nextCalled = true;
        },
      );
      assert.equal(nextCalled, false);
      assert.equal(response.statusCode, 403);
    }
  } finally {
    pool.query = originalQuery;
  }
});

test("promo subscription endpoint reports no space before an offer is activated", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [], rowCount: 0 });
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  try {
    await getMySubscription(
      { auth: { userId: "citizen-1" } },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.payload.promo_free_access, true);
    assert.equal(response.payload.subscription, null);
    assert.deepEqual(response.payload.active_spaces, []);
  } finally {
    pool.query = originalQuery;
  }
});

test("active subscriptions and sponsored pins are returned as separate spaces", async () => {
  const originalQuery = pool.query;
  pool.query = async (query) => query.includes("sponsored_pins")
    ? { rows: [{ active: true }], rowCount: 1 }
    : {
        rows: [
          { plan_type: "WHOLESALER", status: "ACTIVE" },
          { plan_type: "TRANSPORT_COMPANY", status: "ACTIVE" },
        ],
        rowCount: 2,
      };
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  try {
    await getMySubscription(
      { auth: { userId: "citizen-1" } },
      response,
      (error) => { throw error; },
    );
    assert.deepEqual(response.payload.active_spaces, [
      "WHOLESALER",
      "TRANSPORT_COMPANY",
      "SPONSORED_PIN",
    ]);
  } finally {
    pool.query = originalQuery;
  }
});
