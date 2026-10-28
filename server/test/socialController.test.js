import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { requestAlliance } = await import("../controllers/socialController.js");
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
