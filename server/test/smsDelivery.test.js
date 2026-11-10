import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ADMIN_EMAIL = "verified-admin@example.com";
process.env.OTP_TEST_MODE = "false";
process.env.OTP_TEST_ALLOWLIST = "";
process.env.SMS_DELIVERY_URL = "https://sms.example.invalid/send";
process.env.SMS_DELIVERY_TOKEN = "test-sms-token";

const { requestOtp } = await import("../controllers/authController.js");
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

const createRequestClient = () => ({
  async query(statement) {
    if (statement.includes("SELECT 1")) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  },
  release() {},
});

const requestRegistrationOtp = async (context, fetchImplementation, smsQuota = 1) => {
  context.mock.method(pool, "query", async (statement) => {
    if (statement.includes("FROM country_config")) {
      return { rowCount: 1, rows: [{ code: "BF", phone_prefix: "+226" }] };
    }
    if (statement.includes("FROM users")) return { rowCount: 0, rows: [] };
    if (statement.includes("sms_daily_usage")) {
      return { rowCount: smsQuota, rows: smsQuota ? [{ sent_count: 1 }] : [] };
    }
    return { rowCount: 0, rows: [] };
  });
  context.mock.method(pool, "connect", async () => createRequestClient());
  context.mock.method(globalThis, "fetch", fetchImplementation);

  const response = createResponse();
  await requestOtp(
    {
      body: {
        flow: "register",
        first_name: "Awa",
        last_name: "Traoré",
        country_code: "BF",
        phone_number: "+22671234567",
        email: "awa@example.com",
        terms_accepted: true,
        age_16_or_older: true,
      },
    },
    response,
    (error) => {
      throw error;
    },
  );
  return response;
};

test("SMS recipient rejection is reported as a country or number issue", async (context) => {
  const response = await requestRegistrationOtp(context, async () => ({
    ok: false,
    status: 422,
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "SMS_RECIPIENT_REJECTED");
  assert.match(response.payload.error, /numéro ou ce pays/);
});

test("SMS provider throttling is reported separately from delivery failures", async (context) => {
  const response = await requestRegistrationOtp(context, async () => ({
    ok: false,
    status: 429,
  }));
  assert.equal(response.statusCode, 429);
  assert.equal(response.payload.code, "SMS_PROVIDER_RATE_LIMITED");
});

test("SMS daily quota exhaustion is reported before contacting the provider", async (context) => {
  const response = await requestRegistrationOtp(context, async () => {
    throw new Error("The provider should not be called after quota exhaustion.");
  }, 0);
  assert.equal(response.statusCode, 429);
  assert.equal(response.payload.code, "SMS_DAILY_LIMIT_REACHED");
});

test("SMS network timeouts have a distinct retryable explanation", async (context) => {
  const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const response = await requestRegistrationOtp(context, async () => {
    throw timeout;
  });
  assert.equal(response.statusCode, 504);
  assert.equal(response.payload.code, "SMS_DELIVERY_TIMEOUT");
});

test("SMS credential rejection is reported as a provider configuration error", async (context) => {
  const response = await requestRegistrationOtp(context, async () => ({
    ok: false,
    status: 401,
  }));
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.code, "SMS_PROVIDER_CONFIGURATION_ERROR");
});
