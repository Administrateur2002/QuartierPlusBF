import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt";
process.env.CLOUDINARY_CLOUD_NAME = "quartierplus-test";
process.env.CLOUDINARY_API_KEY = "test-api-key";
process.env.CLOUDINARY_API_SECRET = "test-api-secret";
process.env.MODERATION_UPLOADS_ENABLED = "true";
process.env.MODERATION_SERVICE_URL = "https://moderator.example.test";
process.env.GRIN_MODERATION_WEBHOOK_SECRET =
  "test-grin-moderation-webhook-secret-long-enough";
process.env.SUPPORT_NOTIFY_EMAIL = "support@example.test";
process.env.EMAIL_PROVIDER = "resend";
process.env.EMAIL_API_KEY = "test-email-api-key";
process.env.EMAIL_FROM = "QuartierPlus <noreply@example.test>";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { createPost } = await import("../controllers/postsController.js");
const { pool } = await import("../db/pool.js");

const USER_ID = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const POST_ID = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const MEDIA_ID = `${USER_ID}_moderated_photo`;
const USER = {
  id: USER_ID,
  phone_number: "+22670000000",
  phone_verified_at: "2026-01-01T00:00:00Z",
  country_code: "BF",
};

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

const createClient = (queries) => ({
  async query(statement, values) {
    queries.push({ statement, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
      return { rowCount: 0, rows: [] };
    }
    if (statement.includes("FOR UPDATE") && statement.includes("FROM users")) {
      return { rowCount: 1, rows: [USER] };
    }
    if (statement.includes("COUNT(*)::int AS count")) {
      return { rowCount: 1, rows: [{ count: 0 }] };
    }
    if (statement.includes("INSERT INTO posts")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: POST_ID,
            caption: "Publication test",
            scope: "country",
            media_url:
              "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
            media_type: "image",
            status: "PENDING_REVIEW",
          },
        ],
      };
    }
    return { rowCount: 1, rows: [] };
  },
  release() {},
});

const createMocks = (context, { score, minorDetected = false, workerOk = true }) => {
  const queries = [];
  const workerRequests = [];
  const cloudinaryDeletes = [];
  const supportEmails = [];
  context.mock.method(pool, "query", async (statement, values) => {
    queries.push({ statement, values });
    if (statement.includes("FROM users WHERE id = $1")) {
      return { rowCount: 1, rows: [USER] };
    }
    if (statement.includes("moderation_daily_usage")) {
      return { rowCount: 1, rows: [{ analysis_count: 1 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(pool, "connect", async () => createClient(queries));
  context.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = String(input);
    if (options.method === "DELETE") {
      cloudinaryDeletes.push(url);
      return { ok: true, status: 200 };
    }
    if (url.startsWith("https://api.resend.com/")) {
      supportEmails.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    }
    if (url.startsWith("https://api.cloudinary.com/")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            public_id: MEDIA_ID,
            secure_url:
              "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
            format: "jpg",
            bytes: 120_000,
            resource_type: "image",
          };
        },
      };
    }
    if (url.startsWith("https://moderator.example.test/")) {
      workerRequests.push(JSON.parse(options.body));
      return {
        ok: workerOk,
        status: workerOk ? 200 : 503,
        async json() {
          return { score, minorDetected };
        },
      };
    }
    throw new Error(`Unexpected request to ${url}`);
  });
  return { queries, workerRequests, cloudinaryDeletes, supportEmails };
};

const publish = async () => {
  const response = createResponse();
  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: MEDIA_ID,
        caption: "Publication test",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );
  return response;
};

test("low-risk uploads are published after media-only analysis", async (context) => {
  const mocks = createMocks(context, { score: 20 });
  const response = await publish();

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.post.status, "ACTIVE");
  assert.equal(response.payload.moderation_status, "APPROVED");
  assert.deepEqual(mocks.workerRequests, [
    {
      url: "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
      media_type: "image",
    },
  ]);
  const event = mocks.queries.find((query) =>
    query.statement.includes("INSERT INTO post_moderation_events"),
  );
  assert.deepEqual(event.values, [POST_ID, USER_ID, "image", MEDIA_ID, 20, "APPROVED"]);
});

test("medium-risk uploads remain private pending review", async (context) => {
  createMocks(context, { score: 75 });
  const response = await publish();

  assert.equal(response.payload.post.status, "PENDING_REVIEW");
  assert.equal(response.payload.moderation_status, "PENDING_REVIEW");
});

test("high-risk uploads are hidden and notified to support", async (context) => {
  const mocks = createMocks(context, { score: 95 });
  const response = await publish();

  assert.equal(response.payload.post.status, "HIDDEN");
  assert.equal(response.payload.moderation_status, "BLOCKED");
  assert.equal(mocks.supportEmails.length, 1);
  assert.match(mocks.supportEmails[0].text, /attend une revue administrateur/);
});

test("a possible minor blocks the post, deletes media and sends a priority alert", async (context) => {
  const mocks = createMocks(context, { score: 0, minorDetected: true });
  const response = await publish();

  assert.equal(response.payload.moderation_status, "CHILD_SAFETY_ALERT");
  assert.equal(response.payload.post.media_url, null);
  assert.ok(mocks.cloudinaryDeletes.length > 0);
  assert.ok(
    mocks.queries.some((query) => query.statement === "DELETE FROM posts WHERE id = $1"),
  );
  assert.match(mocks.supportEmails[0].text, /signaler aux autorités compétentes/);
  const event = mocks.queries.find((query) =>
    query.statement.includes("INSERT INTO post_moderation_events"),
  );
  assert.deepEqual(event.values, [
    POST_ID,
    USER_ID,
    "image",
    MEDIA_ID,
    0,
    "CHILD_SAFETY_ALERT",
  ]);
});

test("an unavailable worker keeps uploaded media pending without publishing it", async (context) => {
  const mocks = createMocks(context, { score: 0, workerOk: false });
  const loggedErrors = [];
  context.mock.method(console, "error", (...args) => loggedErrors.push(args));
  const response = await publish();

  assert.equal(response.payload.post.status, "PENDING_REVIEW");
  assert.equal(response.payload.moderation_status, "PENDING_REVIEW");
  assert.equal(mocks.workerRequests.length, 1);
  assert.equal(loggedErrors.length, 1);
});
