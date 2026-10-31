import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { createReport } = await import("../controllers/reportController.js");
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

test("comment and profile reports are stored for moderation", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    return statements.length === 1
      ? { rowCount: 1, rows: [{ id: values[0] }] }
      : { rowCount: 1, rows: [{ id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003" }] };
  });

  for (const [targetType, targetId, targetTable] of [
    ["comment", "2b490a29-02dd-44ad-8c9f-81d9cadc0002", "post_comments"],
    ["profile", "4b490a29-02dd-44ad-8c9f-81d9cadc0004", "users"],
    ["message", "5b490a29-02dd-44ad-8c9f-81d9cadc0005", "messages"],
  ]) {
    const response = createResponse();
    await createReport(
      {
        body: { target_type: targetType, target_id: targetId, reason: "Harcèlement" },
        auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
      },
      response,
      (error) => { throw error; },
    );

    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.reported, true);
    assert.match(statements.at(-2).statement, new RegExp(`FROM ${targetTable}`));
    assert.equal(statements.at(-1).values[1], targetType.toUpperCase());
  }
});

test("report creation rejects an unsupported reason before database access", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await createReport(
    {
      body: {
        target_type: "post",
        target_id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
        reason: "something else",
      },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test("report creation does not store a missing target", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  const response = createResponse();

  await createReport(
    {
      body: {
        target_type: "comment",
        target_id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
        reason: "Spam",
      },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 404);
});