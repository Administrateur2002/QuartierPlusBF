import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt";
process.env.MODERATION_UPLOADS_ENABLED = "true";
process.env.MODERATION_SERVICE_URL = "https://moderator.example.test";
process.env.GRIN_MODERATION_WEBHOOK_SECRET =
  "test-grin-moderation-webhook-secret-long-enough";
process.env.SUPPORT_NOTIFY_EMAIL = "support@example.test";
process.env.EMAIL_PROVIDER = "resend";
process.env.EMAIL_API_KEY = "test-email-api-key";
process.env.EMAIL_FROM = "QuartierPlus <noreply@example.test>";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { analyzeUploadedMedia, ModerationCapacityError } = await import(
  "../services/uploadModeration.js"
);
const { pool } = await import("../db/pool.js");

test("upload analysis sends only the verified media URL and validates the worker result", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 1, rows: [] }));
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(
      url,
      "https://moderator.example.test/v1/analyze-upload",
    );
    assert.equal(
      options.headers["X-Grin-Moderation-Token"],
      process.env.GRIN_MODERATION_WEBHOOK_SECRET,
    );
    assert.deepEqual(JSON.parse(options.body), {
      url: "https://res.cloudinary.com/test/video/upload/sample.mp4",
      media_type: "video",
      duration: 420,
    });
    return {
      ok: true,
      async json() {
        return { score: 82.4, minorDetected: false };
      },
    };
  });

  const analysis = await analyzeUploadedMedia({
      url: "https://res.cloudinary.com/test/video/upload/sample.mp4",
      mediaType: "video",
      duration: 420,
    });
  assert.deepEqual(analysis, {
    enabled: true,
    score: 82.4,
    minorDetected: false,
  });
});

test("daily analysis cap prevents contacting the worker", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("The worker must not be called after the cap.");
  });

  await assert.rejects(
    analyzeUploadedMedia({
      url: "https://res.cloudinary.com/test/image/upload/sample.jpg",
      mediaType: "image",
    }),
    ModerationCapacityError,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("invalid worker responses are surfaced to the caller", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 1, rows: [] }));
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    async json() {
      return { score: "high", minorDetected: false };
    },
  }));

  await assert.rejects(
    analyzeUploadedMedia({
      url: "https://res.cloudinary.com/test/image/upload/sample.jpg",
      mediaType: "image",
    }),
    /réponse du service de modération est invalide/i,
  );
});
