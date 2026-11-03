import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { sharePost, listSharedPosts } = await import("../controllers/postsController.js");
const { pool } = await import("../db/pool.js");

const POST_ID = "00000000-0000-4000-8000-000000000001";
const SENDER_ID = "00000000-0000-4000-8000-000000000002";
const TARGET_ID = "00000000-0000-4000-8000-000000000003";

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

const request = (destinationType = "ALLY") => ({
  params: { id: POST_ID },
  auth: { userId: SENDER_ID },
  body: { destination_type: destinationType, destination_id: TARGET_ID },
});

test("internal post sharing rejects malformed destinations before database access", async (context) => {
  context.mock.method(pool, "connect", async () => {
    throw new Error("Invalid share input must not connect to the database.");
  });
  const result = response();
  await sharePost(
    { ...request(), params: { id: "invalid" } },
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 400);
});

test("a post can be shared with an eligible ally and stored as a durable share", async (context) => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM posts WHERE")) {
        return {
          rowCount: 1,
          rows: [{ id: POST_ID, scope: "international", country_code: "CI", latitude: null, longitude: null }],
        };
      }
      if (sql.includes("FROM users recipient")) return { rowCount: 1, rows: [{ id: TARGET_ID }] };
      if (sql.includes("INSERT INTO post_shares")) {
        return { rowCount: 1, rows: [{ id: "share-1", created_at: "2026-11-03T00:00:00Z" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const result = response();

  await sharePost(request(), result, (error) => { throw error; });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.shared, true);
  assert.equal(calls.some(({ sql }) => sql.includes("user_alliances")), true);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO post_shares")), true);
  assert.deepEqual(calls.at(-2).values, [POST_ID, SENDER_ID, "ALLY", TARGET_ID]);
});

test("sharing is denied when the destination is not authorized", async (context) => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM posts WHERE")) {
        return {
          rowCount: 1,
          rows: [{ id: POST_ID, scope: "international", country_code: "CI", latitude: null, longitude: null }],
        };
      }
      if (sql.includes("FROM users recipient")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const result = response();

  await sharePost(request(), result, (error) => { throw error; });

  assert.equal(result.statusCode, 403);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO post_shares")), false);
});

test("sharing to a community group requires sender membership", async (context) => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM posts WHERE")) {
        return {
          rowCount: 1,
          rows: [{ id: POST_ID, scope: "international", country_code: "CI", latitude: null, longitude: null }],
        };
      }
      if (sql.includes("FROM community_alliances alliance")) {
        return { rowCount: 1, rows: [{ id: TARGET_ID }] };
      }
      if (sql.includes("INSERT INTO post_shares")) {
        return { rowCount: 1, rows: [{ id: "group-share" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const result = response();

  await sharePost(request("GROUP"), result, (error) => { throw error; });

  assert.equal(result.statusCode, 201);
  assert.equal(statements.some((sql) => sql.includes("community_alliance_members")), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO post_shares")), true);
});

test("sharing to a public channel only allows audiences that match the post scope", async (context) => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM posts WHERE")) {
        return {
          rowCount: 1,
          rows: [{ id: POST_ID, scope: "country", country_code: "CI", latitude: null, longitude: null }],
        };
      }
      if (sql.includes("FROM channels channel")) {
        return { rowCount: 1, rows: [{ id: TARGET_ID }] };
      }
      if (sql.includes("INSERT INTO post_shares")) {
        return { rowCount: 1, rows: [{ id: "channel-share" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const result = response();

  await sharePost(request("CHANNEL"), result, (error) => { throw error; });

  assert.equal(result.statusCode, 201);
  assert.match(statements[2].sql, /channel\.country_code = \$4/);
  assert.deepEqual(statements[2].values, [
    TARGET_ID,
    SENDER_ID,
    "country",
    "CI",
  ]);
});

test("shared posts are fetched with destination membership, block, and scope checks", async (context) => {
  context.mock.method(pool, "query", async (sql, values) => {
    assert.match(sql, /community_alliance_members/);
    assert.match(sql, /user_blocks/);
    assert.match(sql, /post\.scope = 'international'/);
    assert.deepEqual(values, [SENDER_ID]);
    return { rowCount: 1, rows: [{ id: POST_ID, media_type: "video" }] };
  });
  const result = response();

  await listSharedPosts({ auth: { userId: SENDER_ID } }, result, (error) => { throw error; });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.posts[0].media_type, "video");
});
