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
process.env.EMAIL_PROVIDER = "smtp";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "support";
process.env.SMTP_PASS = "test-password";
process.env.MAIL_FROM = "QuartierPlus <noreply@example.test>";

const { listMutedUsers, muteUser, unmuteUser } = await import(
  "../controllers/socialController.js"
);
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
  end() {
    return this;
  },
});

test("muting is persistent, reversible, and returns only account metadata", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    if (statement.includes("SELECT id FROM users")) {
      return { rowCount: 1, rows: [{ id: values[0] }] };
    }
    if (statement.includes("SELECT users.id")) {
      return {
        rowCount: 1,
        rows: [{ id: values[0], name: "Compte", muted_at: "2030-01-01T00:00:00Z" }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  const auth = { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" };
  const mutedId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
  const listResponse = response();
  await listMutedUsers({ auth }, listResponse, (error) => { throw error; });
  assert.equal(listResponse.payload.enabled, true);
  assert.equal(listResponse.payload.muted_users[0].name, "Compte");

  const muteResponse = response();
  await muteUser({ auth, params: { userId: mutedId } }, muteResponse, (error) => { throw error; });
  assert.deepEqual(muteResponse.payload, { muted: true });

  const unmuteResponse = response();
  await unmuteUser({ auth, params: { userId: mutedId } }, unmuteResponse, (error) => { throw error; });
  assert.equal(unmuteResponse.statusCode, 204);
  assert.ok(statements.some((item) => item.statement.includes("INSERT INTO user_mutes")));
  assert.ok(statements.some((item) => item.statement.includes("DELETE FROM user_mutes")));
});
