import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createCommunityGroup,
  createPostShare,
  joinCommunityGroup,
  listCommunitySharedPosts,
  listDiscoverableGroups,
  listShareDestinations,
} = await import("../controllers/communityShareController.js");
const { pool } = await import("../db/pool.js");

const userId = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const groupId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const postId = "3b490a29-02dd-44ad-8c9f-81d9cadc0003";

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

test("share destination listing only queries supported destination types", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await listShareDestinations(
    { params: { type: "group" }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { destinations: [] });
  assert.match(statement, /community_group_members/);
  assert.deepEqual(values, [userId]);
});

test("invalid share destination types are rejected before database access", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await listShareDestinations(
    { params: { type: "private-message" }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test("group creation validates visibility and inserts the creator as owner atomically", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 1, rows: [{ id: groupId, name: "Quartier", visibility: "PRIVATE" }] };
  });
  const response = createResponse();

  await createCommunityGroup(
    {
      auth: { userId },
      body: { name: " Quartier ", description: " Échanges locaux ", visibility: "private" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.group.id, groupId);
  assert.match(statement, /INSERT INTO community_group_members/);
  assert.match(statement, /'OWNER'/);
  assert.deepEqual(values, [userId, "Quartier", "Échanges locaux", "PRIVATE"]);
});

test("group creation rejects invalid visibility before database access", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await createCommunityGroup(
    { auth: { userId }, body: { name: "Quartier", visibility: "ALL" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test("group joining requires a discoverable public group", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    return statements.length === 1
      ? { rowCount: 1, rows: [{ id: groupId }] }
      : { rowCount: 1, rows: [] };
  });
  const response = createResponse();

  await joinCommunityGroup(
    { params: { groupId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { joined: true });
  assert.match(statements[0], /visibility = 'PUBLIC'/);
  assert.match(statements[1], /ON CONFLICT \(group_id, user_id\) DO NOTHING/);
});

test("sharing rejects non-media posts and checks membership and privacy in SQL", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await createPostShare(
    {
      params: { postId },
      body: {
        destination_type: "group",
        destination_id: groupId,
        comment: "  À voir  ",
      },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 404);
  assert.match(statement, /post\.media_type IN \('image', 'video'\)/);
  assert.match(statement, /community_group_members/);
  assert.match(statement, /user_blocks/);
  assert.deepEqual(values.slice(0, 5), [postId, userId, "GROUP", groupId, "À voir"]);
});

test("share rejects invalid comments before database access", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();

  await createPostShare(
    {
      params: { postId },
      body: {
        destination_type: "alliance",
        destination_id: groupId,
        comment: "x".repeat(1001),
      },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
});

test("shared destination feed checks membership before returning the feed", async (context) => {
  const statements = [];
  const feed = [{ id: "share-1", post_id: postId, media_type: "video" }];
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    return statements.length === 1
      ? { rowCount: 1, rows: [{ "?column?": 1 }] }
      : { rowCount: 1, rows: feed };
  });
  const response = createResponse();

  await listCommunitySharedPosts(
    {
      params: { type: "group", destinationId: groupId },
      query: { limit: "10", offset: "0" },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { posts: feed });
  assert.equal(statements.length, 2);
  assert.match(statements[0], /community_group_members/);
  assert.match(statements[1], /community_post_shares/);
});

test("discoverable group results exclude current members", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await listDiscoverableGroups(
    { auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.match(statement, /visibility = 'PUBLIC'/);
  assert.match(statement, /NOT EXISTS/);
});
