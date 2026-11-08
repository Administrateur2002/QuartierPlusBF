import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createCommunicationMessage,
  listCommunicationChannels,
} = await import("../controllers/communicationController.js");
const { pool } = await import("../db/pool.js");

const USER_ID = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const INSTITUTION_ID = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const CHANNEL_ID = "3b490a29-02dd-44ad-8c9f-81d9cadc0003";

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

test("official messages require an active verified institutional membership", async (context) => {
  let connectionRequested = false;
  context.mock.method(pool, "query", async (statement) =>
    statement.includes("FROM channels AS channel")
      ? {
          rows: [{
            id: CHANNEL_ID,
            name: "Région · Annonces officielles",
            kind: "ANNOUNCEMENTS",
            geography_scope: "region",
            communication_area_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
            country_code: "BF",
          }],
        }
      : { rows: [] },
  );
  context.mock.method(pool, "connect", async () => {
    connectionRequested = true;
    throw new Error("Un membre non autorisé ne doit pas ouvrir une transaction.");
  });
  const response = createResponse();

  await createCommunicationMessage(
    {
      params: { channelId: CHANNEL_ID },
      auth: { userId: USER_ID },
      body: {
        content: "Fermeture administrative",
        information_type: "OFFICIAL",
        institution_id: INSTITUTION_ID,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(connectionRequested, false);
});

test("verified institutional publication is audited and broadcast to the channel", async (context) => {
  const clientStatements = [];
  let broadcast = null;
  context.mock.method(pool, "query", async (statement) => {
    if (statement.includes("FROM channels AS channel")) {
      return {
        rows: [{
          id: CHANNEL_ID,
          name: "Région · Annonces officielles",
          kind: "ANNOUNCEMENTS",
          geography_scope: "region",
          communication_area_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
          country_code: "BF",
        }],
      };
    }
    if (statement.includes("FROM institutions AS institution")) {
      return { rows: [{ id: INSTITUTION_ID, name: "Mairie vérifiée" }] };
    }
    return { rows: [] };
  });
  context.mock.method(pool, "connect", async () => ({
    async query(statement) {
      clientStatements.push(statement);
      if (statement.includes("FROM institutions AS institution")) {
        return { rows: [{ id: INSTITUTION_ID, name: "Mairie vérifiée" }] };
      }
      if (statement.includes("INSERT INTO messages")) {
        return {
          rows: [{
            id: "5b490a29-02dd-44ad-8c9f-81d9cadc0005",
            channel_id: CHANNEL_ID,
            sender_id: USER_ID,
            body: "Fermeture administrative",
            information_type: "OFFICIAL",
            institution_id: INSTITUTION_ID,
            created_at: "2026-11-08T10:00:00.000Z",
          }],
        };
      }
      if (statement.includes("SELECT full_name")) {
        return { rows: [{ full_name: "Agent habilité" }] };
      }
      if (statement.includes("SELECT name FROM institutions")) {
        return { rows: [{ name: "Mairie vérifiée" }] };
      }
      return { rows: [] };
    },
    release() {},
  }));
  const response = createResponse();

  await createCommunicationMessage(
    {
      params: { channelId: CHANNEL_ID },
      auth: { userId: USER_ID },
      body: {
        content: " Fermeture administrative ",
        information_type: "OFFICIAL",
        institution_id: INSTITUTION_ID,
      },
      app: {
        get: () => ({
          to: (room) => ({
            emit: (event, message) => {
              broadcast = { room, event, message };
            },
          }),
        }),
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.message.information_type, "OFFICIAL");
  assert.equal(response.payload.message.institution_name, "Mairie vérifiée");
  assert.equal(response.payload.message.channel_id, CHANNEL_ID);
  assert.ok(clientStatements.some((statement) =>
    statement.includes("INSERT INTO official_message_history"),
  ));
  assert.deepEqual(broadcast, {
    room: `channel:${CHANNEL_ID}`,
    event: "channel:new_message",
    message: response.payload.message,
  });
});

test("channel scopes reject invalid filters before querying the database", async (context) => {
  let queries = 0;
  context.mock.method(pool, "query", async () => {
    queries += 1;
    return { rows: [] };
  });
  const response = createResponse();

  await listCommunicationChannels(
    {
      auth: { userId: USER_ID },
      query: { scope: "unverified-location" },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(queries, 0);
});
