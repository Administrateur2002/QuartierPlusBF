import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { listChannelMessages, createChannelMessage } = await import(
  "../controllers/channelController.js"
);
const { listConversations } = await import("../controllers/conversationController.js");
const { assistSosAlert, reportSosAlert } = await import(
  "../controllers/sosController.js"
);
const { pool } = await import("../db/pool.js");

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

test("channel history resolves the public alias and returns it to the mobile client", async (context) => {
  context.mock.method(pool, "query", async (statement) =>
    statement.includes("SELECT channel.id, channel.name, channel.kind")
      ? {
          rows: [{
            id: "channel-uuid",
            name: "URGENCES",
            kind: "EMERGENCY",
            geography_scope: "country",
            communication_area_id: null,
            country_code: null,
          }],
        }
      : {
          rows: [
            {
              id: "message-uuid",
              channel_id: "channel-uuid",
              body: "Besoin d'aide",
            },
          ],
        },
  );
  const response = createResponse();

  await listChannelMessages(
    { params: { channelId: "emergency" }, auth: { userId: "user-uuid" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.messages[0].channel_id, "emergency");
});

test("channel message creation accepts text and returns the mobile channel alias", async (context) => {
  context.mock.method(pool, "query", async (statement) =>
    statement.includes("SELECT channel.id, channel.name, channel.kind")
      ? {
          rows: [{
            id: "channel-uuid",
            name: "URGENCES",
            kind: "EMERGENCY",
            geography_scope: "country",
            communication_area_id: null,
            country_code: null,
          }],
        }
      : { rows: [] },
  );
  const client = {
    async query(statement) {
      if (statement.includes("INSERT INTO messages")) {
        return {
          rows: [{
            id: "message-uuid",
            channel_id: "channel-uuid",
            sender_id: "user-uuid",
            body: "Besoin d'aide",
            information_type: "COMMUNITY",
          }],
        };
      }
      if (statement.includes("SELECT full_name")) {
        return { rows: [{ full_name: "Voisin" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();

  await createChannelMessage(
    {
      params: { channelId: "emergency" },
      auth: { userId: "user-uuid" },
      body: { content: " Besoin d'aide " },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.message.channel_id, "emergency");
  assert.equal(response.payload.message.content, "Besoin d'aide");
});

test("channel message creation rejects a media ID not owned by the sender", async (context) => {
  let queries = 0;
  context.mock.method(pool, "query", async (statement) => {
    queries += 1;
    assert.match(statement, /SELECT channel\.id, channel\.name, channel\.kind/);
    return {
      rows: [{
        id: "channel-uuid",
        name: "URGENCES",
        kind: "EMERGENCY",
        geography_scope: "country",
        communication_area_id: null,
        country_code: null,
      }],
    };
  });
  const response = createResponse();

  await createChannelMessage(
    {
      params: { channelId: "emergency" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
      body: {
        content: "",
        media_url: "https://res.cloudinary.com/test/image/upload/photo.webp",
        media_type: "image",
        media_public_id: "someone-else_photo",
      },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, { error: "Le média ne vous appartient pas." });
  assert.equal(queries, 1);
});

test("empty public channel history is a successful empty list", async (context) => {
  context.mock.method(pool, "query", async (statement) =>
    statement.includes("SELECT channel.id, channel.name, channel.kind")
      ? {
          rows: [{
            id: "channel-uuid",
            name: "URGENCES",
            kind: "EMERGENCY",
            geography_scope: "country",
            communication_area_id: null,
            country_code: null,
          }],
        }
      : { rows: [] },
  );
  const response = createResponse();

  await listChannelMessages(
    { params: { channelId: "emergency" }, auth: { userId: "user-uuid" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { messages: [] });
});

test("an account without private conversations receives a successful empty list", async (context) => {
  context.mock.method(pool, "query", async () => ({ rows: [] }));
  const response = createResponse();

  await listConversations(
    { auth: { userId: "user-uuid" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { conversations: [] });
});

test("SOS assistance is persisted for an active alert", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 1, rows: [{}] }));
  const response = createResponse();

  await assistSosAlert(
    {
      params: { id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.payload, { ok: true });
});

test("SOS false-alert reports are recorded against active alerts", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ id: "report-uuid" }],
  }));
  const response = createResponse();

  await reportSosAlert(
    {
      params: { id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      auth: { userId: "1b490a29-02dd-44ad-8c9f-81d9cadc0001" },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.report_id, "report-uuid");
});
