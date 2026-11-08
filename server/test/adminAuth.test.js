import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.ADMIN_EMAIL = "administrateurquartierplus@gmail.com";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { adminAuthMiddleware } = await import("../middlewares/adminAuthMiddleware.js");
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

test("verified database admins can open the dashboard with SMS, email, or Google sessions", async (context) => {
  context.mock.method(pool, "query", async (_query, values) => {
    assert.equal(values[1], "administrateurquartierplus@gmail.com");
    const query = _query;
    assert.match(query, /LOWER\(role\) = 'admin'/);
    assert.match(query, /LOWER\(email\) = LOWER\(\$2\)/);
    assert.match(query, /email_verified_at IS NOT NULL/);
    assert.match(query, /is_verified = TRUE/);
    assert.match(query, /phone_verified_at IS NOT NULL/);
    return { rowCount: 1, rows: [{}] };
  });
  for (const authMethod of ["sms_otp", "email_otp", "google_oauth"]) {
    const response = createResponse();
    let continued = false;
    await adminAuthMiddleware(
      { auth: { userId: "admin-user", authMethod } },
      response,
      () => {
        continued = true;
      },
    );
    assert.equal(continued, true);
  }
});

test("an account without the database admin role is denied", async (context) => {
  context.mock.method(pool, "query", async (query) => {
    assert.match(query, /LOWER\(role\) = 'admin'/);
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();
  let continued = false;
  await adminAuthMiddleware(
    { auth: { userId: "ordinary-user", authMethod: "sms_otp" } },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
});
