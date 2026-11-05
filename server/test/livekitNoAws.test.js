import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDispatchClient, TokenVerifier } from "livekit-server-sdk";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET = "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.LIVEKIT_API_KEY = "APITestUnitKey12345";
process.env.LIVEKIT_API_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LIVEKIT_URL = "wss://quartierplus.livekit.cloud";
process.env.GRIN_MODERATION_ENABLED = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
delete process.env.AWS_REKOGNITION_ENABLED;
delete process.env.AWS_TRANSCRIBE_ENABLED;
delete process.env.GRIN_MODERATION_WEBHOOK_SECRET;
delete process.env.GRIN_MODERATOR_IDS;

const { createLiveKitToken } = await import(
  "../controllers/livekitController.js"
);
const verifier = new TokenVerifier(
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

test("Grin remains usable with manual reports when AWS moderation is disabled", async (context) => {
  const dispatch = context.mock.method(
    AgentDispatchClient.prototype,
    "listDispatch",
    async () => {
      throw new Error("AWS moderation must not dispatch without its feature flag.");
    },
  );
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

  await createLiveKitToken(
    {
      body: { roomName: "grin", moderationConsent: true },
      user: { id: "user-123" },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(dispatch.mock.callCount(), 0);
  const claims = await verifier.verify(response.payload.token);
  assert.equal(claims.video?.canPublish, true);
  assert.deepEqual(claims.video?.canPublishSources, ["microphone", "camera"]);
  assert.equal(claims.attributes?.grin_moderation_consent, "false");
});
