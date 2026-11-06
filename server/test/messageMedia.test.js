import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.CLOUDINARY_CLOUD_NAME = "quartierplus-test";
process.env.CLOUDINARY_API_KEY = "test-api-key";
process.env.CLOUDINARY_API_SECRET = "test-api-secret";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { verifyMessageMedia } = await import("../services/messageMedia.js");

const USER_ID = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const MEDIA_PUBLIC_ID = `${USER_ID}_video`;
const MEDIA_URL =
  "https://res.cloudinary.com/quartierplus-test/video/upload/video.mp4";

const mockVideoAsset = (context, duration) => {
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_id: MEDIA_PUBLIC_ID,
        secure_url: MEDIA_URL,
        format: "mp4",
        bytes: 1000,
        resource_type: "video",
        duration,
      };
    },
  }));
};

test("private messages accept videos lasting only a few seconds", async (context) => {
  mockVideoAsset(context, 3);

  assert.deepEqual(
    await verifyMessageMedia({
      userId: USER_ID,
      mediaUrl: MEDIA_URL,
      mediaType: "video",
      mediaPublicId: MEDIA_PUBLIC_ID,
    }),
    { mediaUrl: MEDIA_URL, mediaType: "video" },
  );
});

test("private messages reject videos longer than the configured maximum", async (context) => {
  mockVideoAsset(context, 421);

  const result = await verifyMessageMedia({
    userId: USER_ID,
    mediaUrl: MEDIA_URL,
    mediaType: "video",
    mediaPublicId: MEDIA_PUBLIC_ID,
  });

  assert.match(result.error, /invalide ou dépasse les limites/);
});
