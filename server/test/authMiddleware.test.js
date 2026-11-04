import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.ADMIN_USER_IDS = "7b490a29-02dd-44ad-8c9f-81d9cadc0007";
process.env.OTP_TEST_MODE = "false";

const { authMiddleware } = await import("../middlewares/authMiddleware.js");
const { pool } = await import("../db/pool.js");
const secret = process.env.JWT_SECRET;

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

test("authMiddleware accepts a valid application JWT for an active account", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ suspended_until: null }],
  }));
  const request = {
    get: () =>
      `Bearer ${jwt.sign({}, secret, {
        algorithm: "HS256",
        subject: "user-123",
      })}`,
  };
  const response = createResponse();
  let continued = false;

  await authMiddleware(request, response, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.deepEqual(request.auth, { userId: "user-123" });
  assert.deepEqual(request.user, { id: "user-123" });
});

test("authMiddleware rejects missing, invalid, and expired tokens", async () => {
  for (const authorization of [
    undefined,
    "Basic abc",
    "Bearer not-a-token",
    `Bearer ${jwt.sign({}, secret, {
      algorithm: "HS256",
      subject: "user-123",
      expiresIn: -1,
    })}`,
  ]) {
    const request = {
      get: () => authorization,
    };
    const response = createResponse();
    let continued = false;

    await authMiddleware(request, response, () => {
      continued = true;
    });

    assert.equal(continued, false);
    assert.equal(response.statusCode, 401);
    assert.ok(response.payload.error);
  }
});

test("authMiddleware blocks suspended accounts but permits appeal-only access", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ suspended_until: new Date(Date.now() + 60_000) }],
  }));
  const authorization = `Bearer ${jwt.sign({}, secret, {
    algorithm: "HS256",
    subject: "user-123",
  })}`;
  const createRequest = () => ({ get: () => authorization });

  const blocked = createResponse();
  let blockedNext = false;
  await authMiddleware(createRequest(), blocked, () => {
    blockedNext = true;
  });
  assert.equal(blockedNext, false);
  assert.equal(blocked.statusCode, 403);

  const { authMiddlewareAllowSuspended } = await import("../middlewares/authMiddleware.js");
  const appeal = createResponse();
  let appealNext = false;
  await authMiddlewareAllowSuspended(createRequest(), appeal, () => {
    appealNext = true;
  });
  assert.equal(appealNext, true);
});
