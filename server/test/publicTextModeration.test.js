import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.GRIN_MODERATION_ENABLED = "true";
process.env.GRIN_MODERATION_WEBHOOK_SECRET =
  "test-grin-moderation-webhook-secret-with-more-than-32-characters";
process.env.GRIN_MODERATOR_IDS = "7b490a29-02dd-44ad-8c9f-81d9cadc0007";
process.env.TEXT_MODERATION_ENABLED = "true";
process.env.CONFLICT_PROTECTION_ENABLED = "true";
process.env.SUPPORT_NOTIFY_EMAIL = "support@example.test";
process.env.EMAIL_PROVIDER = "smtp";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "support";
process.env.SMTP_PASS = "test-password";
process.env.MAIL_FROM = "QuartierPlus <noreply@example.test>";

const { evaluatePublicText, inspectPublicText } = await import(
  "../services/publicTextModeration.js"
);
const { pool } = await import("../db/pool.js");

const userId = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const targetUserId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";

test("public text lexicon matching is accent-insensitive and warns without storing text", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    if (statement.includes("user_moderation_pauses")) return { rows: [] };
    return { rows: [{ term: "imbécile", category: "INSULT" }] };
  });
  const inspection = await inspectPublicText({
    userId,
    text: "Tu es un IMBECILE !",
  });
  assert.equal(inspection.hostile, true);
  assert.equal(inspection.category, "INSULT");
  assert.match(inspection.warning, /Relisez-le/);
  assert.equal(statements.length, 2);
  assert.equal(statements.some((statement) => /INSERT|UPDATE/i.test(statement)), false);
});

test("a confirmed hostile message triggers a 15-minute pause after repeated incidents", async (context) => {
  const statements = [];
  const pauseUntil = "2030-01-01T00:15:00.000Z";
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    if (statement.includes("user_moderation_pauses")) return { rows: [] };
    return { rows: [{ term: "je vais te tuer", category: "THREAT" }] };
  });
  const client = {
    async query(statement) {
      statements.push(statement);
      if (statement.includes("COUNT(*)")) return { rows: [{ count: 2 }] };
      if (statement.includes("INSERT INTO moderation_conflicts")) {
        return { rows: [{ id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003" }] };
      }
      if (statement.includes("INSERT INTO user_moderation_pauses")) {
        return { rows: [{ paused_until: pauseUntil }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);

  const result = await evaluatePublicText({
    userId,
    targetUserId,
    targetType: "COMMENT",
    text: "Je vais te tuer",
    confirmed: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 429);
  assert.equal(result.pause_until, pauseUntil);
  assert.equal(result.category, "THREAT");
  assert.ok(statements.some((statement) => statement.includes("INTERVAL '15 minutes'")));
});

test("hostile public text is not stored before the user confirms the warning", async (context) => {
  context.mock.method(pool, "query", async (statement) =>
    statement.includes("user_moderation_pauses")
      ? { rows: [] }
      : { rows: [{ term: "salaud", category: "INSULT" }] },
  );
  const connect = context.mock.method(pool, "connect", async () => {
    throw new Error("A warning must not create a moderation event.");
  });
  const result = await evaluatePublicText({
    userId,
    targetUserId,
    targetType: "COMMENT",
    text: "salaud",
    confirmed: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "HOSTILE_TEXT_WARNING");
  assert.equal(connect.mock.callCount(), 0);
});
