import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createPrivateConnectionRequest,
  getPrivateContactProfile,
  respondToPrivateConnectionRequest,
  searchPrivateContacts,
} = await import("../controllers/conversationController.js");
const { pool } = await import("../db/pool.js");

const requesterId = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const recipientId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const requestId = "3b490a29-02dd-44ad-8c9f-81d9cadc0003";

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

test("private contact profile exposes a stable handle derived from the account ID", async (context) => {
  let queryValues;
  context.mock.method(pool, "query", async (_statement, values) => {
    queryValues = values;
    return {
      rowCount: 1,
      rows: [{ id: requesterId, name: "Awa", public_handle: `qp-${requesterId.replaceAll("-", "")}` }],
    };
  });
  const response = createResponse();

  await getPrivateContactProfile(
    { auth: { userId: requesterId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.profile.public_handle, `qp-${requesterId.replaceAll("-", "")}`);
  assert.deepEqual(queryValues, [requesterId]);
});

test("private contact search rejects too-short queries before querying the database", async (context) => {
  let queried = false;
  context.mock.method(pool, "query", async () => {
    queried = true;
    return { rows: [] };
  });
  const response = createResponse();

  await searchPrivateContacts(
    { query: { query: "a" }, auth: { userId: requesterId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(queried, false);
});

test("private contact search filters blocked accounts and matches stable public handles", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, args) => {
    statement = sql;
    values = args;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await searchPrivateContacts(
    { query: { query: "qp-ab" }, auth: { userId: requesterId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.match(statement, /private_connections/);
  assert.match(statement, /user_blocks/);
  assert.match(statement, /replace\(person\.id::text, '-', ''\)/);
  assert.deepEqual(values, [requesterId, "%qp-ab%", "qp-ab%"]);
});

test("a user cannot create a private connection request to themselves", async (context) => {
  let queried = false;
  context.mock.method(pool, "query", async () => {
    queried = true;
    return { rows: [] };
  });
  const response = createResponse();

  await createPrivateConnectionRequest(
    {
      auth: { userId: requesterId },
      body: { recipient_id: requesterId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(queried, false);
});

test("accepting a private connection creates one authorized two-person conversation", async (context) => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.includes("SELECT id, sender_id, recipient_id, status")) {
        return {
          rowCount: 1,
          rows: [{
            id: requestId,
            sender_id: requesterId,
            recipient_id: recipientId,
            status: "PENDING",
            conversation_id: null,
          }],
        };
      }
      if (statement.includes("SELECT 1 FROM user_blocks")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("SELECT conversation_id FROM private_connections")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("INSERT INTO conversations")) {
        return { rowCount: 1, rows: [{ id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004" }] };
      }
      if (statement.includes("UPDATE private_connection_requests")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  const response = createResponse();

  await respondToPrivateConnectionRequest(
    {
      params: { requestId },
      auth: { userId: recipientId },
      body: { decision: "ACCEPT" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    status: "ACCEPTED",
    conversation_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
  });
  assert.ok(statements.some(({ statement }) => statement === "BEGIN"));
  assert.ok(statements.some(({ statement }) => statement.includes("INSERT INTO conversation_participants")));
  assert.ok(statements.some(({ statement }) => statement.includes("INSERT INTO private_connections")));
  assert.ok(statements.some(({ statement }) => statement === "COMMIT"));
});

test("declining a private connection request does not create a conversation", async (context) => {
  const statements = [];
  const client = {
    async query(statement) {
      statements.push(statement);
      if (statement.includes("SELECT id, sender_id, recipient_id, status")) {
        return {
          rowCount: 1,
          rows: [{
            id: requestId,
            sender_id: requesterId,
            recipient_id: recipientId,
            status: "PENDING",
            conversation_id: null,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();

  await respondToPrivateConnectionRequest(
    {
      params: { requestId },
      auth: { userId: recipientId },
      body: { decision: "DECLINE" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { status: "DECLINED" });
  assert.ok(statements.some((statement) => statement.includes("SET status = 'DECLINED'")));
  assert.ok(!statements.some((statement) => statement.includes("INSERT INTO conversations")));
});
