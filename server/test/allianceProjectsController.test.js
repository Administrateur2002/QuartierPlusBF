import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  confirmCommunityAllianceCompletion,
  getCommunityAlliance,
  getCommunityAllianceInvitationCounter,
  inviteCommunityAllianceMember,
  joinCommunityAlliance,
  listCommunityAllianceInvitations,
  listCommunityAllianceParticipants,
  listCommunityAlliances,
  listMyCommunityAlliances,
  respondToCommunityAllianceInvitation,
} = await import("../controllers/allianceProjectsController.js");
const { pool } = await import("../db/pool.js");

const userId = "1b490a29-02dd-44ad-8c9f-81d9cadc0001";
const otherUserId = "2b490a29-02dd-44ad-8c9f-81d9cadc0002";
const allianceId = "3b490a29-02dd-44ad-8c9f-81d9cadc0003";
const invitationId = "4b490a29-02dd-44ad-8c9f-81d9cadc0004";

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

test("available and participating project lists use normalized memberships", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    return { rowCount: 0, rows: [] };
  });
  const availableResponse = createResponse();
  await listCommunityAlliances(
    { auth: { userId } },
    availableResponse,
    (error) => { throw error; },
  );
  const mineResponse = createResponse();
  await listMyCommunityAlliances(
    { auth: { userId } },
    mineResponse,
    (error) => { throw error; },
  );

  assert.deepEqual(availableResponse.payload, { alliances: [] });
  assert.deepEqual(mineResponse.payload, { alliances: [] });
  assert.match(statements[0].statement, /community_alliance_members/);
  assert.match(statements[1].statement, /current_membership\.user_id = \$1/);
  assert.deepEqual(statements.map((item) => item.values), [[userId], [userId]]);
});

test("project detail validates UUIDs and returns the viewer membership state", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 1, rows: [{ id: allianceId, is_member: false }] };
  });
  const response = createResponse();
  await getCommunityAlliance(
    { params: { allianceId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.alliance.is_member, false);
  assert.match(statement, /has_confirmed_completion/);
  assert.match(statement, /community_alliance_completion_confirmations/);
});

test("participants cannot be listed unless the current user is a member", async (context) => {
  let calls = 0;
  context.mock.method(pool, "query", async () => {
    calls += 1;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();
  await listCommunityAllianceParticipants(
    { params: { allianceId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 404);
  assert.equal(calls, 1);
});

test("joining a project writes membership, participant count and block checks atomically", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 1, rows: [{ id: allianceId, participant_count: 2 }] };
  });
  const response = createResponse();
  await joinCommunityAlliance(
    { params: { allianceId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(values, [allianceId, userId]);
  assert.match(statement, /status IN \('PENDING', 'ACCEPTED', 'IN_PROGRESS'\)/);
  assert.match(statement, /INSERT INTO community_alliance_members/);
  assert.match(statement, /participant_count = alliance\.participant_count \+ 1/);
  assert.match(statement, /user_blocks/);
});

test("project join rejects unavailable projects without revealing membership data", async (context) => {
  let calls = 0;
  context.mock.method(pool, "query", async () => {
    calls += 1;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();
  await joinCommunityAlliance(
    { params: { allianceId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 404);
  assert.equal(calls, 2);
});

test("inviting requires an existing project membership and an allied recipient", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 1, rows: [{ id: invitationId, status: "PENDING" }] };
  });
  const response = createResponse();
  await inviteCommunityAllianceMember(
    {
      params: { allianceId },
      body: { user_id: otherUserId },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(values, [allianceId, userId, otherUserId]);
  assert.match(statement, /community_alliance_members/);
  assert.match(statement, /relationship\.status = 'ALLIED'/);
  assert.match(statement, /user_blocks/);
  assert.match(statement, /DO NOTHING/);
});

test("an invitation cannot be sent to a malformed or self user ID", async (context) => {
  context.mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });
  const response = createResponse();
  await inviteCommunityAllianceMember(
    {
      params: { allianceId },
      body: { user_id: userId },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 400);
});

test("received invitations are pending and sent invitations retain their response status", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement) => {
    statements.push(statement);
    return { rowCount: 0, rows: [] };
  });
  const received = createResponse();
  await listCommunityAllianceInvitations(
    { params: { direction: "received" }, auth: { userId } },
    received,
    (error) => { throw error; },
  );
  const sent = createResponse();
  await listCommunityAllianceInvitations(
    { params: { direction: "sent" }, auth: { userId } },
    sent,
    (error) => { throw error; },
  );

  assert.deepEqual(received.payload, { invitations: [] });
  assert.deepEqual(sent.payload, { invitations: [] });
  assert.match(statements[0], /invitation\.status = 'PENDING'/);
  assert.doesNotMatch(statements[1], /invitation\.status = 'PENDING'/);
});

test("accepting or declining an invitation changes membership only for its invitee", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 1, rows: [{ id: invitationId, status: "ACCEPTED" }] };
  });
  const response = createResponse();
  await respondToCommunityAllianceInvitation(
    {
      params: { invitationId },
      body: { decision: "accepted" },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(values, [invitationId, userId, "ACCEPTED"]);
  assert.match(statement, /invitation\.invitee_id = \$2/);
  assert.match(statement, /INSERT INTO community_alliance_members/);
  assert.match(statement, /participant_count = alliance\.participant_count \+ 1/);
});

test("a missing or already handled invitation cannot be accepted", async (context) => {
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  const response = createResponse();
  await respondToCommunityAllianceInvitation(
    {
      params: { invitationId },
      body: { decision: "ACCEPTED" },
      auth: { userId },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 404);
});

test("project invitation counters return received and sent pending counts", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 1, rows: [{ received_invitations: 2, pending_invitations: 1 }] };
  });
  const response = createResponse();
  await getCommunityAllianceInvitationCounter(
    { auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.deepEqual(response.payload.counters, { received_invitations: 2, pending_invitations: 1 });
  assert.match(statement, /status = 'PENDING'/);
});

test("completion can only be confirmed by another member with submitted proof", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();
  await confirmCommunityAllianceCompletion(
    { params: { allianceId }, auth: { userId } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 409);
  assert.match(statement, /alliance\.creator_id <> \$2/);
  assert.match(statement, /validation_note IS NOT NULL/);
  assert.match(statement, /proof_url IS NOT NULL/);
  assert.match(statement, /ON CONFLICT \(alliance_id, user_id\) DO NOTHING/);
});
