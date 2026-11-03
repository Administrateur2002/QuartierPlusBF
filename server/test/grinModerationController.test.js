import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomServiceClient } from "livekit-server-sdk";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.LIVEKIT_API_KEY = "APITestUnitKey12345";
process.env.LIVEKIT_API_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_URL = "wss://quartierplus.livekit.cloud";
process.env.GRIN_MODERATION_ENABLED = "true";
process.env.GRIN_MODERATION_WEBHOOK_SECRET =
  "unit-test-moderation-webhook-secret-over-32-characters";
process.env.GRIN_MODERATOR_IDS = "7b490a29-02dd-44ad-8c9f-81d9cadc0007";

const { pool } = await import("../db/pool.js");
const {
  appealModerationEvent,
  listModerationQueue,
  receiveModerationEvent,
  resolveModerationEvent,
} = await import("../controllers/grinModerationController.js");

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

const baseEvent = {
  id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
  roomName: "grin",
  participantId: "3b490a29-02dd-44ad-8c9f-81d9cadc0003",
  trackSid: "TR_video_track_123",
  mediaType: "VIDEO",
};

const invokeAgent = (body) => ({
  body,
  get(name) {
    return name === "x-grin-moderation-token"
      ? process.env.GRIN_MODERATION_WEBHOOK_SECRET
      : undefined;
  },
});

const mockConsentedParticipant = (context) => {
  context.mock.method(
    RoomServiceClient.prototype,
    "listParticipants",
    async () => [{
      identity: baseEvent.participantId,
      attributes: { grin_moderation_consent: "true" },
      tracks: [{ sid: baseEvent.trackSid }],
    }],
  );
};

test("high-confidence explicit nudity is paused and queued, without storing media", async (context) => {
  let inserted;
  const muted = [];
  const packets = [];
  mockConsentedParticipant(context);
  context.mock.method(pool, "query", async (query, values) => {
    if (query.includes("INSERT INTO grin_moderation_events")) {
      inserted = { query, values };
      return {
        rowCount: 1,
        rows: [{ id: values[0], status: values[7] }],
      };
    }
    throw new Error(`Unexpected moderation query: ${query}`);
  });
  context.mock.method(
    RoomServiceClient.prototype,
    "mutePublishedTrack",
    async (...args) => {
      muted.push(args);
      return {};
    },
  );
  context.mock.method(RoomServiceClient.prototype, "sendData", async (...args) => {
    packets.push(args);
  });
  const result = response();

  await receiveModerationEvent(
    invokeAgent({
      ...baseEvent,
      category: "Explicit Nudity",
      confidence: 98.5,
    }),
    result,
    (error) => { throw error; },
  );

  assert.equal(result.statusCode, 202);
  assert.equal(result.payload.status, "PAUSED_PENDING_REVIEW");
  assert.equal(inserted.values[7], "PAUSED_PENDING_REVIEW");
  assert.equal(inserted.query.includes("frame"), false);
  assert.deepEqual(muted[0], [
    "grin",
    baseEvent.participantId,
    baseEvent.trackSid,
    true,
  ]);
  assert.equal(packets.length, 1);
});

test("ambiguous moderation scores are queued without pausing a participant", async (context) => {
  let status;
  let muteCalls = 0;
  mockConsentedParticipant(context);
  context.mock.method(pool, "query", async (_query, values) => {
    status = values[7];
    return { rowCount: 1, rows: [{ id: values[0], status }] };
  });
  context.mock.method(
    RoomServiceClient.prototype,
    "mutePublishedTrack",
    async () => { muteCalls += 1; },
  );
  context.mock.method(RoomServiceClient.prototype, "sendData", async () => {});
  const result = response();

  await receiveModerationEvent(
    invokeAgent({
      ...baseEvent,
      category: "Suggestive",
      confidence: 78,
    }),
    result,
    (error) => { throw error; },
  );

  assert.equal(result.statusCode, 202);
  assert.equal(status, "PENDING_REVIEW");
  assert.equal(muteCalls, 0);
});

test("the webhook cannot analyze a non-consenting participant", async (context) => {
  let queries = 0;
  context.mock.method(
    RoomServiceClient.prototype,
    "listParticipants",
    async () => [{
      identity: baseEvent.participantId,
      attributes: { grin_moderation_consent: "false" },
      tracks: [{ sid: baseEvent.trackSid }],
    }],
  );
  context.mock.method(pool, "query", async () => {
    queries += 1;
    return { rowCount: 0, rows: [] };
  });
  const result = response();
  await receiveModerationEvent(
    invokeAgent({
      ...baseEvent,
      category: "Explicit Nudity",
      confidence: 99,
    }),
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 403);
  assert.equal(queries, 0);
});

test("only allowlisted moderators can read the review queue", async () => {
  const result = response();
  await listModerationQueue(
    { auth: { userId: "8b490a29-02dd-44ad-8c9f-81d9cadc0008" } },
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 403);
});

test("appeals require a reason and are scoped to the participant", async (context) => {
  let queryValues;
  context.mock.method(pool, "query", async (_query, values) => {
    queryValues = values;
    return { rowCount: 1, rows: [{ id: values[0], status: "APPEALED" }] };
  });
  const result = response();
  await appealModerationEvent(
    {
      params: { eventId: baseEvent.id },
      body: { reason: "Je conteste la détection et demande une revue." },
      auth: { userId: baseEvent.participantId },
    },
    result,
    (error) => { throw error; },
  );
  assert.equal(result.statusCode, 200);
  assert.equal(queryValues[1], baseEvent.participantId);
  assert.equal(queryValues[2], "Je conteste la détection et demande une revue.");
});

test("a failed unmute restores the prior review status", async (context) => {
  const queries = [];
  context.mock.method(pool, "query", async (query, values) => {
    queries.push({ query, values });
    if (query.includes("SELECT status")) {
      return { rowCount: 1, rows: [{ status: "PAUSED_PENDING_REVIEW" }] };
    }
    if (query.includes("RETURNING id, room_name")) {
      return {
        rowCount: 1,
        rows: [{
          id: baseEvent.id,
          room_name: "grin",
          participant_id: baseEvent.participantId,
          track_sid: baseEvent.trackSid,
          status: "CLEARED",
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(
    RoomServiceClient.prototype,
    "listParticipants",
    async () => [{
      identity: baseEvent.participantId,
      tracks: [{ sid: baseEvent.trackSid }],
    }],
  );
  context.mock.method(
    RoomServiceClient.prototype,
    "mutePublishedTrack",
    async () => { throw new Error("LiveKit unavailable"); },
  );
  let forwardedError;
  await resolveModerationEvent(
    {
      params: { eventId: baseEvent.id },
      body: { outcome: "clear" },
      auth: { userId: process.env.GRIN_MODERATOR_IDS },
    },
    response(),
    (error) => { forwardedError = error; },
  );

  assert.equal(forwardedError?.message, "LiveKit unavailable");
  assert.equal(queries.length, 3);
  assert.equal(queries[2].values[1], "PAUSED_PENDING_REVIEW");
});
