import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt";
process.env.GRIN_MODERATION_ENABLED = "true";
process.env.MODERATION_UPLOADS_ENABLED = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
delete process.env.AWS_REKOGNITION_ENABLED;
delete process.env.AWS_TRANSCRIBE_ENABLED;
delete process.env.GRIN_MODERATION_WEBHOOK_SECRET;
delete process.env.GRIN_MODERATOR_IDS;
delete process.env.MODERATION_SERVICE_URL;

const { analyzeUploadedMedia } = await import(
  "../services/uploadModeration.js"
);
const { env } = await import("../config/env.js");

test("upload moderation falls back to normal publishing without AWS configuration", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("AWS moderation must not call a worker while disabled.");
  });

  assert.equal(env.moderationUploadsEnabled, false);
  assert.deepEqual(
    await analyzeUploadedMedia({
      url: "https://res.cloudinary.com/test/image/upload/sample.jpg",
      mediaType: "image",
    }),
    { enabled: false },
  );
  assert.equal(fetch.mock.callCount(), 0);
});
