import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";

const { pool } = await import("../db/pool.js");
const { proRoleGuard } = await import("../middlewares/proRoleGuard.js");

const invokeGuard = async (plan, subscription) => {
  const originalQuery = pool.query;
  pool.query = async (_sql, params) => {
    assert.deepEqual(params, ["user-1", plan]);
    return { rows: subscription ? [subscription] : [] };
  };
  const response = {
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
  };
  let nextCalled = false;
  try {
    await proRoleGuard(plan)(
      { auth: { userId: "user-1" } },
      response,
      (error) => {
        if (error) throw error;
        nextCalled = true;
      },
    );
  } finally {
    pool.query = originalQuery;
  }
  return { response, nextCalled };
};

test("Pro role guards allow only a matching active plan", async () => {
  for (const plan of ["ALLIANCE_PRO", "SYNDIC", "TOWN_HALL", "SECURITY_AGENT"]) {
    const subscription = {
      plan_type: plan,
      status: "ACTIVE",
      starts_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 60_000),
    };
    const result = await invokeGuard(plan, subscription);
    assert.equal(result.nextCalled, true, `${plan} should be allowed`);
    assert.equal(result.response.statusCode, 200);
  }
});

test("Pro role guards reject missing or mismatched subscriptions", async () => {
  const missing = await invokeGuard("SYNDIC", null);
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.response.statusCode, 403);

  const mismatched = await invokeGuard("SYNDIC", {
    plan_type: "ALLIANCE_PRO",
    status: "ACTIVE",
    starts_at: new Date(Date.now() - 60_000),
    expires_at: new Date(Date.now() + 60_000),
  });
  assert.equal(mismatched.nextCalled, false);
  assert.equal(mismatched.response.statusCode, 403);
});

test("Pro role guards reject subscriptions before start or after expiry", async () => {
  for (const subscription of [
    {
      plan_type: "WHOLESALER",
      status: "ACTIVE",
      starts_at: new Date(Date.now() + 60_000),
      expires_at: new Date(Date.now() + 120_000),
    },
    {
      plan_type: "WHOLESALER",
      status: "ACTIVE",
      starts_at: new Date(Date.now() - 120_000),
      expires_at: new Date(Date.now() - 60_000),
    },
  ]) {
    const result = await invokeGuard("WHOLESALER", subscription);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 403);
  }
});
