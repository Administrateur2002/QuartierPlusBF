import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.CLOUDINARY_CLOUD_NAME = "quartierplus-test";
process.env.CLOUDINARY_API_KEY = "test-api-key";
process.env.CLOUDINARY_API_SECRET = "test-api-secret";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createCloudinaryUploadSignature,
  getCloudinaryAsset,
  getCloudinaryAssetReference,
  hasGpsMetadata,
  isCloudinaryPublicIdOwnedByUser,
} = await import("../services/cloudinary.js");

test("Cloudinary upload signatures sort params and never return the secret", () => {
  const parameters = {
    timestamp: 123,
    public_id: "user-123_asset",
    folder: "quartierplus/posts",
  };
  const result = createCloudinaryUploadSignature(parameters);
  const expected = createHash("sha1")
    .update(
      "folder=quartierplus/posts&public_id=user-123_asset&timestamp=123test-api-secret",
    )
    .digest("hex");

  assert.equal(result.signature, expected);
  assert.equal(result.apiKey, "test-api-key");
  assert.equal(result.cloudName, "quartierplus-test");
  assert.equal("apiSecret" in result, false);
  assert.equal(JSON.stringify(result).includes("test-api-secret"), false);
});

test("Cloudinary official upload example signs timestamp and public_id only", () => {
  const parameters = {
    timestamp: 1315060510,
    public_id: "sample_image",
    file: "ignored-file-content",
    api_key: "ignored-api-key",
    resource_type: "video",
  };
  const result = createCloudinaryUploadSignature(parameters);
  const expected = createHash("sha1")
    .update("public_id=sample_image&timestamp=1315060510test-api-secret")
    .digest("hex");

  assert.equal(result.signature, expected);
});

test("GPS EXIF metadata is detected for post-upload deletion", () => {
  assert.equal(
    hasGpsMetadata({ Make: "Camera", GPSLatitude: "12/1, 34/1" }),
    true,
  );
  assert.equal(hasGpsMetadata({ Make: "Camera", Orientation: 1 }), false);
});

test("Cloudinary public IDs may use dynamic folders but must retain the user's ID prefix", () => {
  assert.equal(isCloudinaryPublicIdOwnedByUser("user-123", "user-123_asset"), true);
  assert.equal(
    isCloudinaryPublicIdOwnedByUser(
      "user-123",
      "quartierplus/posts/user-123_asset",
    ),
    true,
  );
  assert.equal(isCloudinaryPublicIdOwnedByUser("user-123", "dynamic-folder/user-123_asset"), true);
  assert.equal(isCloudinaryPublicIdOwnedByUser("user-123", "dynamic-folder/other_asset"), false);
  assert.equal(isCloudinaryPublicIdOwnedByUser("user-123", "other_asset"), false);
});

test("Cloudinary asset URLs are reduced to upload resource and owned public ID", () => {
  assert.deepEqual(
    getCloudinaryAssetReference(
      "https://res.cloudinary.com/quartierplus-test/image/upload/v123/quartierplus/posts/user-123_photo.webp",
    ),
    {
      resourceType: "image",
      publicId: "quartierplus/posts/user-123_photo",
    },
  );
  assert.deepEqual(
    getCloudinaryAssetReference(
      "https://res.cloudinary.com/quartierplus-test/video/upload/f_auto/v456/quartierplus/sos/user-123_audio.m4a",
    ),
    {
      resourceType: "video",
      publicId: "quartierplus/sos/user-123_audio",
    },
  );
  assert.equal(
    getCloudinaryAssetReference("https://example.com/user-123_photo.webp"),
    null,
  );
});

test("Cloudinary refusals are logged and returned with their exact reason", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const loggedErrors = [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
    });
  console.error = (...args) => loggedErrors.push(args);

  try {
    await assert.rejects(
      getCloudinaryAsset("image", "user-123_asset"),
      (error) => {
        assert.equal(error.status, 502);
        assert.match(error.message, /HTTP 401.*Invalid API key/);
        return true;
      },
    );
    assert.deepEqual(loggedErrors, [
      [
        "Cloudinary API refused a media request:",
        { status: 401, message: "Invalid API key" },
      ],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
