import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.ADMIN_USER_IDS = "7b490a29-02dd-44ad-8c9f-81d9cadc0007";
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

test("administrator authorization requires an allowlisted UUID and verified account factors", async (context) => {
  let queryCount = 0;
  context.mock.method(pool, "query", async (_query, values) => {
    queryCount += 1;
    assert.equal(values[1], "administrateurquartierplus@gmail.com");
    const query = _query;
    assert.match(query, /email_verified_at IS NOT NULL/);
    assert.match(query, /is_verified = TRUE/);
    assert.match(query, /phone_verified_at IS NOT NULL/);
    return { rowCount: 1, rows: [{}] };
  });
  const response = createResponse();
  let continued = false;
  await adminAuthMiddleware(
    { auth: { userId: "7b490a29-02dd-44ad-8c9f-81d9cadc0007", authMethod: "sms_otp" } },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, true);
  assert.equal(queryCount, 1);
});

test("knowing the administrator email does not grant administrator access", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("The database must not be queried for a non-allowlisted identity.");
  });
  const response = createResponse();
  let continued = false;
  await adminAuthMiddleware(
    { auth: { userId: "8b490a29-02dd-44ad-8c9f-81d9cadc0008" } },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
});

test("Google-only administrator sessions require SMS step-up authentication", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("SMS authentication must be checked before accessing the database.");
  });
  const response = createResponse();
  let continued = false;
  await adminAuthMiddleware(
    {
      auth: {
        userId: "7b490a29-02dd-44ad-8c9f-81d9cadc0007",
        authMethod: "google_oauth",
      },
    },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.payload.error, /SMS/);
});

test("an allowlisted but incompletely verified account is refused", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  const response = createResponse();
  let continued = false;
  await adminAuthMiddleware(
    { auth: { userId: "7b490a29-02dd-44ad-8c9f-81d9cadc0007", authMethod: "sms_otp" } },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
});
