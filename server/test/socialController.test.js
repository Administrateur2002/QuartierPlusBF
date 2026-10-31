import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { blockUser, listPostComments, requestAlliance } = await import("../controllers/socialController.js");
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

test("repeated alliance request preserves an existing allied status", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    if (statement.includes("SELECT id FROM users")) {
      return { rowCount: 1, rows: [{ id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" }] };
    }
    return { rowCount: 1, rows: [{ status: "ALLIED" }] };
  });
  const response = createResponse();

  await requestAlliance(
    {
      params: { userId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { status: "ALLIED" });
  assert.equal(statements.length, 2);
});

test("blocking validates the account and stores an idempotent block", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    return statements.length === 1
      ? { rowCount: 1, rows: [{ id: values[0] }] }
      : { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await blockUser(
    {
      params: { userId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { blocked: true });
  assert.match(statements[1].statement, /ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING/);
});

test("blocking rejects the current account", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await blockUser(
    {
      params: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test("comment listing returns one page and a continuation offset", async (context) => {
  const postId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
  const rows = Array.from({ length: 4 }, (_, index) => ({ id: `comment-${index}` }));
  let queryValues;
  context.mock.method(pool, "query", async (_statement, values) => {
    queryValues = values;
    return { rowCount: rows.length, rows };
  });
  const response = createResponse();

  await listPostComments(
    {
      params: { postId },
      query: { limit: "3", offset: "6" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    comments: rows.slice(0, 3),
    has_more: true,
    next_offset: 9,
  });
  assert.deepEqual(queryValues, [
    postId,
    4,
    6,
    "1b490a29-02dd-44ad-8c9f-81d9cadc0001",
  ]);
});

test("comment listing rejects invalid pagination parameters", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await listPostComments(
    {
      params: { postId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      query: { limit: "1000", offset: "0" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, { error: "Paramètres des commentaires invalides." });
});
