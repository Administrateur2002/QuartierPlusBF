import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.GRIN_MODERATION_ENABLED = "true";
process.env.AWS_REKOGNITION_ENABLED = "true";
process.env.GRIN_MODERATION_WEBHOOK_SECRET =
  "test-grin-moderation-webhook-secret-with-more-than-32-characters";
process.env.GRIN_MODERATOR_IDS = "7b490a29-02dd-44ad-8c9f-81d9cadc0007";
process.env.TEXT_MODERATION_ENABLED = "true";
process.env.CONFLICT_PROTECTION_ENABLED = "true";
process.env.SUPPORT_NOTIFY_EMAIL = "support@example.test";
process.env.EMAIL_PROVIDER = "resend";
process.env.EMAIL_API_KEY = "test-resend-key";
process.env.MAIL_FROM = "QuartierPlus <noreply@example.test>";

const { createReport } = await import("../controllers/reportController.js");
const { pool } = await import("../db/pool.js");

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

test("three distinct reports on public content create a review conflict without storing report text", async (context) => {
  context.mock.method(globalThis, "fetch", async () => ({ ok: true }));
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    if (statement.includes("SELECT id, author_id AS owner_id FROM posts")) {
      return {
        rowCount: 1,
        rows: [{ id: values[0], owner_id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" }],
      };
    }
    if (statement.includes("INSERT INTO reports")) {
      return { rowCount: 1, rows: [{ id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003" }] };
    }
    if (statement.includes("COUNT(DISTINCT reporter_id)")) {
      return { rowCount: 1, rows: [{ count: 3 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const result = response();
  await createReport(
    {
      body: {
        target_type: "post",
        target_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
        reason: "Harcèlement",
      },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 201);
  assert.ok(statements.some((item) => item.statement.includes("COUNT(DISTINCT reporter_id)")));
  const conflictInsert = statements.at(-1);
  assert.match(conflictInsert.statement, /'REPEATED_REPORTS'/);
  assert.deepEqual(conflictInsert.values, [
    "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
    "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
  ]);
});
