import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentDispatchClient,
  RoomServiceClient,
  TokenVerifier,
} from "livekit-server-sdk";

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

const { createLiveKitToken } = await import(
  "../controllers/livekitController.js"
);
const verifier = new TokenVerifier(
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

const invokeController = async (body, userId = "user-123") => {
  const response = {
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
  };
  await createLiveKitToken({ body, user: userId ? { id: userId } : undefined }, response);
  return response;
};

test("LiveKit token is scoped to a room, user, and audio-only publishing", async () => {
  const response = await invokeController({ roomName: "channel_abc-123" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.url, process.env.LIVEKIT_URL);
  assert.equal(response.payload.roomName, "channel_abc-123");
  const claims = await verifier.verify(response.payload.token);
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.video?.room, "channel_abc-123");
  assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.video?.canSubscribe, true);
  assert.deepEqual(claims.video?.canPublishSources, ["microphone"]);
  assert.equal(claims.video?.canPublishData, false);
});

test("Grin publishing requires consent and an active moderation agent", async (context) => {
  context.mock.method(
    RoomServiceClient.prototype,
    "listRooms",
    async () => [{ name: "grin" }],
  );
  context.mock.method(
    AgentDispatchClient.prototype,
    "listDispatch",
    async () => [{ agentName: "grin-moderator" }],
  );
  const response = await invokeController({
    roomName: "grin",
    moderationConsent: true,
  });

  assert.equal(response.statusCode, 200);
  const claims = await verifier.verify(response.payload.token);
  assert.equal(claims.video?.room, "grin");
  assert.deepEqual(claims.video?.canPublishSources, ["microphone", "camera"]);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.attributes?.grin_moderation_consent, "true");
  assert.equal(claims.roomConfig?.name, "grin");
  assert.equal(claims.roomConfig?.maxParticipants, 6);
});

test("Grin viewers who decline moderation cannot publish audio or video", async () => {
  const response = await invokeController({
    roomName: "grin",
    moderationConsent: false,
  });
  assert.equal(response.statusCode, 200);
  const claims = await verifier.verify(response.payload.token);
  assert.equal(claims.video?.canPublish, false);
  assert.deepEqual(claims.video?.canPublishSources, []);
  assert.equal(claims.video?.canSubscribe, true);
  assert.equal(claims.attributes?.grin_moderation_consent, "false");
});

test("LiveKit token route rejects unauthenticated or arbitrary room names", async () => {
  const unauthenticated = await invokeController(
    { roomName: "emergency" },
    null,
  );
  assert.equal(unauthenticated.statusCode, 401);

  const invalidRoom = await invokeController({ roomName: "admin" });
  assert.equal(invalidRoom.statusCode, 400);
});
