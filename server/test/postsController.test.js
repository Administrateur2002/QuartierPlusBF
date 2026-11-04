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
  createPost,
  logMediaUploadFailure,
  listFeed,
  reportPost,
  roundCoordinatesTo200mGrid,
  signMediaUpload,
  deletePost,
} = await import("../controllers/postsController.js");
const { pool } = await import("../db/pool.js");

const USER_ID = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const POST_ID = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const VERIFIED_USER = {
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
  end() {
    this.ended = true;
    return this;
  },
});

const createTransactionClient = (overrides = {}) => ({
  queries: [],
  async query(statement, values) {
    this.queries.push({ statement, values });
    if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }
    if (statement.includes("FOR UPDATE") && statement.includes("FROM users")) {
      return { rowCount: 1, rows: [VERIFIED_USER] };
    }
    if (/COUNT\(\*\)::int AS count[\s\S]+FROM posts/.test(statement)) {
      const overridden = overrides.query?.(statement, values);
      return Number.isInteger(overridden?.rows?.[0]?.count)
        ? overridden
        : { rowCount: 1, rows: [{ count: 0 }] };
    }
    if (statement.includes("INSERT INTO posts")) {
      const overridden = overrides.query?.(statement, values);
      if (overridden?.rows?.[0]) return overridden;
      return {
        rowCount: 1,
        rows: [
          {
            id: POST_ID,
            caption: "Bonjour",
            scope: "neighborhood",
            media_url: "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
          },
        ],
      };
    }
    return overrides.query?.(statement, values) ?? { rowCount: 0, rows: [] };
  },
  release() {},
});

const mockCloudinaryUpload = (context, values = {}) => {
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        public_id: `${USER_ID}_photo`,
        secure_url:
          "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
        format: "jpg",
        bytes: 120_000,
        resource_type: "image",
        ...values,
      };
    },
  }));
};

test("location rounding stores a nearby 200 m grid point instead of the exact coordinate", () => {
  const exact = { latitude: 12.345678, longitude: -1.234567 };
  const rounded = roundCoordinatesTo200mGrid(exact);

  assert.notDeepEqual(rounded, exact);
  assert.ok(Math.abs(rounded.latitude - exact.latitude) < 0.002);
  assert.ok(Math.abs(rounded.longitude - exact.longitude) < 0.002);
});

test("upload signing is denied until the account has a verified phone", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ ...VERIFIED_USER, phone_verified_at: null }],
  }));
  const response = createResponse();

  await signMediaUpload(
    { auth: { userId: USER_ID }, body: { media_type: "image" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 403);
  assert.match(response.payload.error, /Vérifiez votre numéro/);
});

test("video signatures include timestamp, folder and public ID without exposing the API secret", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const response = createResponse();

  await signMediaUpload(
    { auth: { userId: USER_ID }, body: { media_type: "video" } },
    response,
    (error) => {
      throw error;
    },
  );

  const { folder, public_id: publicId, timestamp, signature } = response.payload;
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.resource_type, "video");
  assert.equal(response.payload.max_duration_seconds, 420);
  assert.equal(response.payload.max_bytes, 100 * 1024 * 1024);
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 1);
  assert.equal(
    signature,
    createHash("sha1")
      .update(
        `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}test-api-secret`,
      )
      .digest("hex"),
  );
  assert.equal("apiSecret" in response.payload, false);
  assert.equal(JSON.stringify(response.payload).includes("test-api-secret"), false);
});

test("video trim signatures bind the selected segment to the upload", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const response = createResponse();

  await signMediaUpload(
    {
      auth: { userId: USER_ID },
      body: { media_type: "video", trim_video: true },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.trim_video, true);
  assert.equal(response.payload.max_duration_seconds, null);
  assert.equal(response.payload.context, "trim_video=true");
  assert.equal(
    response.payload.signature,
    createHash("sha1")
      .update(
        `context=trim_video=true&folder=${response.payload.folder}&public_id=${response.payload.public_id}&timestamp=${response.payload.timestamp}test-api-secret`,
      )
      .digest("hex"),
  );
});

test("client Cloudinary failures are logged with status and bounded message", (context) => {
  const loggedErrors = [];
  context.mock.method(console, "error", (...args) => loggedErrors.push(args));
  const response = createResponse();

  logMediaUploadFailure(
    {
      auth: { userId: USER_ID },
      body: {
        media_type: "video",
        status: 400,
        message: "Invalid video\u0000format",
        expected_public_id: `${USER_ID}_expected`,
        received_public_id: `quartierplus/posts/${USER_ID}_received`,
      },
    },
    response,
  );

  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.deepEqual(loggedErrors, [
    [
      "Cloudinary client upload failed:",
      {
        userId: USER_ID,
        resourceType: "video",
        status: 400,
        message: "Invalid video format",
        expectedPublicId: `${USER_ID}_expected`,
        receivedPublicId: `quartierplus/posts/${USER_ID}_received`,
      },
    ],
  ]);
});

test("photo publication verifies Cloudinary metadata and stores only rounded coordinates", async (context) => {
  let insertValues;
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const transaction = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO posts")) insertValues = values;
      return { rowCount: 0, rows: [] };
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  mockCloudinaryUpload(context);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "neighborhood",
        media_type: "image",
        media_public_id: `${USER_ID}_photo`,
        caption: "Bonjour",
        latitude: 12.345678,
        longitude: -1.234567,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  const rounded = roundCoordinatesTo200mGrid({
    latitude: 12.345678,
    longitude: -1.234567,
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(insertValues.slice(3, 5), [
    rounded.latitude,
    rounded.longitude,
  ]);
  assert.notEqual(insertValues[3], 12.345678);
  assert.notEqual(insertValues[4], -1.234567);
});

test("photo publication stores the returned folder-prefixed public ID and secure URL", async (context) => {
  let insertValues;
  const publicId = `quartierplus/posts/${USER_ID}_photo`;
  const secureUrl =
    "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg";
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const transaction = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO posts")) insertValues = values;
      return { rowCount: 0, rows: [] };
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  mockCloudinaryUpload(context, { public_id: publicId, secure_url: secureUrl });
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: publicId,
        caption: "Bonjour",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(insertValues[6], publicId);
  assert.equal(insertValues[7], secureUrl);
});

test("photo publication verifies and stores additional carousel photos", async (context) => {
  const primaryPublicId = `${USER_ID}_primary`;
  const secondPublicId = `${USER_ID}_second`;
  const insertedItems = [];
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  context.mock.method(globalThis, "fetch", async (input) => {
    const publicId = decodeURIComponent(new URL(input).pathname.split("/").at(-1));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          public_id: publicId,
          secure_url: `https://res.cloudinary.com/quartierplus-test/image/upload/${publicId}.jpg`,
          format: "jpg",
          bytes: 120_000,
          resource_type: "image",
        };
      },
    };
  });
  const transaction = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO post_media_items")) {
        insertedItems.push(values);
      }
      return undefined;
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: primaryPublicId,
        additional_media: [secondPublicId],
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(insertedItems, [
    [
      POST_ID,
      2,
      secondPublicId,
      `https://res.cloudinary.com/quartierplus-test/image/upload/${secondPublicId}.jpg`,
      "jpg",
      120_000,
    ],
  ]);
});

test("server rejects additional carousel photos on video posts", async () => {
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "video",
        media_public_id: `${USER_ID}_video`,
        additional_media: [`${USER_ID}_photo`],
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /carrousel/);
});

test("text-only publication stores null media fields when upload is unavailable", async (context) => {
  let insertValues;
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const transaction = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO posts")) insertValues = values;
      return { rowCount: 0, rows: [] };
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: null,
        caption: "Publication sans photo",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(insertValues.slice(6), [
    null,
    null,
    null,
    null,
    null,
    null,
    "ACTIVE",
  ]);
});

test("server rejects oversized photos and videos that exceed the configured duration", async (context) => {
  let asset = {
    public_id: `${USER_ID}_photo`,
    secure_url:
      "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
    format: "jpg",
    bytes: 10 * 1024 * 1024 + 1,
    resource_type: "image",
  };
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    async json() {
      return asset;
    },
  }));
  context.mock.method(pool, "connect", async () => {
    throw new Error("Rejected media must not be inserted.");
  });

  const photoResponse = createResponse();
  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: `${USER_ID}_photo`,
      },
    },
    photoResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(photoResponse.statusCode, 400);
  assert.match(photoResponse.payload.error, /taille/);

  asset = {
    public_id: `${USER_ID}_video`,
    secure_url:
      "https://res.cloudinary.com/quartierplus-test/video/upload/video.mp4",
    format: "mp4",
    bytes: 1000,
    resource_type: "video",
    duration: 421,
  };
  const videoResponse = createResponse();
  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "video",
        media_public_id: `${USER_ID}_video`,
      },
    },
    videoResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(videoResponse.statusCode, 400);
  assert.match(videoResponse.payload.error, /420 secondes/);
});

test("server accepts and stores a seven-minute video within the default upload limit", async (context) => {
  let insertedValues;
  const asset = {
    public_id: `${USER_ID}_seven_minutes`,
    secure_url:
      "https://res.cloudinary.com/quartierplus-test/video/upload/seven-minutes.mp4",
    format: "mp4",
    bytes: 80 * 1024 * 1024,
    resource_type: "video",
    duration: 420,
  };
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    async json() {
      return asset;
    },
  }));
  const transaction = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO posts")) insertedValues = values;
      return undefined;
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "video",
        media_public_id: asset.public_id,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(insertedValues[10], 80 * 1024 * 1024);
  assert.equal(insertedValues[11], 420);
});

test("server publishes only the first 420 seconds when an overlong video has a signed trim request", async (context) => {
  const asset = {
    public_id: `${USER_ID}_video`,
    secure_url:
      "https://res.cloudinary.com/quartierplus-test/video/upload/video.mp4",
    format: "mp4",
    bytes: 1000,
    resource_type: "video",
    duration: 421,
    context: { custom: { trim_video: "true" } },
  };
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    async json() {
      return asset;
    },
  }));
  const client = createTransactionClient({
    query(statement, values) {
      if (statement.includes("INSERT INTO posts")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: POST_ID,
              caption: "Vidéo découpée",
              scope: "country",
              media_url: values[7],
            },
          ],
        };
      }
      return undefined;
    },
  });
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "video",
        media_public_id: `${USER_ID}_video`,
        trim_video: true,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  const insert = client.queries.find(({ statement }) =>
    statement.includes("INSERT INTO posts"),
  );
  assert.equal(response.statusCode, 201);
  assert.match(insert.values[7], /\/video\/upload\/so_0,du_420\//);
  assert.equal(insert.values[11], 420);
});

test("photo uploads with GPS metadata are deleted from Cloudinary and rejected", async (context) => {
  const requests = [];
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), method: options?.method ?? "GET" });
    if (options?.method === "DELETE") {
      return { ok: true, status: 200 };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          public_id: `${USER_ID}_gps`,
          secure_url:
            "https://res.cloudinary.com/quartierplus-test/image/upload/gps.jpg",
          format: "jpg",
          bytes: 1000,
          image_metadata: { GPSLatitude: "12/1, 30/1" },
        };
      },
    };
  });
  context.mock.method(pool, "connect", async () => {
    throw new Error("A GPS-tagged photo must not be published.");
  });
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: `${USER_ID}_gps`,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /coordonnées GPS/);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "DELETE"],
  );
});

test("daily publication limit is enforced before inserting a post", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [VERIFIED_USER],
  }));
  const transaction = createTransactionClient({
    query(statement) {
      if (/COUNT\(\*\)::int AS count[\s\S]+FROM posts/.test(statement)) {
        return { rowCount: 1, rows: [{ count: 10 }] };
      }
    },
  });
  context.mock.method(pool, "connect", async () => transaction);
  mockCloudinaryUpload(context);
  const response = createResponse();

  await createPost(
    {
      auth: { userId: USER_ID },
      body: {
        scope: "country",
        media_type: "image",
        media_public_id: `${USER_ID}_photo`,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 429);
  assert.match(response.payload.error, /10 publications par jour/);
  assert.equal(
    transaction.queries.some(({ statement }) =>
      statement.includes("INSERT INTO posts"),
    ),
    false,
  );
});

test("post deletion is restricted to its author", async (context) => {
  const calls = [];
  context.mock.method(pool, "query", async (statement, values) => {
    calls.push({ statement, values });
    return values[1] === USER_ID
      ? { rowCount: 1, rows: [{ id: POST_ID }] }
      : { rowCount: 0, rows: [] };
  });
  const authorResponse = createResponse();

  await deletePost(
    { params: { id: POST_ID }, auth: { userId: USER_ID } },
    authorResponse,
    (error) => {
      throw error;
    },
  );

  assert.equal(authorResponse.statusCode, 204);
  assert.equal(authorResponse.ended, true);
  assert.match(calls[0].statement, /author_id = \$2/);
  assert.deepEqual(calls[0].values, [POST_ID, USER_ID]);

  const otherUserResponse = createResponse();
  await deletePost(
    {
      params: { id: POST_ID },
      auth: { userId: "3b490a29-02dd-44ad-8c9f-81d9cadc0003" },
    },
    otherUserResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(otherUserResponse.statusCode, 404);
});

test("feed requires a position for location-based scopes and never returns exact coordinates", async (context) => {
  let queryValues;
  context.mock.method(pool, "query", async (_statement, values) => {
    queryValues = values;
    return {
      rowCount: 1,
      rows: [
        {
          id: POST_ID,
          caption: "Bonjour",
          scope: "neighborhood",
          media_url:
            "https://res.cloudinary.com/quartierplus-test/image/upload/photo.jpg",
        },
      ],
    };
  });
  const response = createResponse();

  await listFeed(
    {
      query: {
        scope: "neighborhood",
        country_code: "BF",
        latitude: "12.3",
        longitude: "-1.5",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(queryValues, ["neighborhood", "BF", 12.3, -1.5, null, 0, false]);
  assert.equal("latitude" in response.payload.posts[0], false);
  assert.equal("longitude" in response.payload.posts[0], false);
});

test("feed rejects invalid pagination offsets without querying", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("An invalid page must not query the database.");
  });
  const response = createResponse();

  await listFeed(
    { query: { scope: "country", country_code: "BF", offset: "-1" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /page/i);
});

test("three pending reports hide a post until moderation", async (context) => {
  const transaction = {
    async query(statement) {
      if (
        statement === "BEGIN" ||
        statement === "COMMIT" ||
        statement === "ROLLBACK"
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("SELECT id FROM posts")) {
        return { rowCount: 1, rows: [{ id: POST_ID }] };
      }
      if (statement.includes("SELECT id FROM reports")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("COUNT(*)::int AS count FROM reports")) {
        return { rowCount: 1, rows: [{ count: 3 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => transaction);
  const response = createResponse();

  await reportPost(
    { params: { id: POST_ID }, auth: { userId: USER_ID }, body: {} },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.payload, {
    reported: true,
    hidden_pending_moderation: true,
  });
});
