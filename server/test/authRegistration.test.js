import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.GOOGLE_CLIENT_ID ??= "test-web-client-id";
process.env.OTP_TEST_MODE = "true";
process.env.OTP_TEST_ALLOWLIST = "+22670000000";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { googleAuth, requestOtp, verifyOtp } = await import("../controllers/authController.js");
const { OAuth2Client } = await import("google-auth-library");
const { pool } = await import("../db/pool.js");
const phoneNumber = "+22670000000";
const jwtSecret = process.env.JWT_SECRET;

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

const createClient = (query) => ({
  query,
  release() {},
});

test("registration is rejected unless the user confirms the 16-year minimum", async (context) => {
  let databaseAccessed = false;
  context.mock.method(pool, "query", async () => {
    databaseAccessed = true;
    throw new Error("Invalid age confirmation must be rejected before database access.");
  });
  const response = createResponse();
  await requestOtp(
    {
      body: {
        flow: "register",
        first_name: "Awa",
        last_name: "Traoré",
        country_code: "BF",
        phone_number: phoneNumber,
        email: "awa@example.com",
        terms_accepted: true,
        age_16_or_older: false,
      },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /16 ans/);
  assert.equal(databaseAccessed, false);
});

test("registration OTP stores the validated details and creates the account after verification", async (context) => {
  const registration = {
    first_name: "Awa",
    last_name: "Traoré",
    full_name: "Awa Traoré",
    email: "awa@example.com",
    country_code: "BF",
  };
  const requestCalls = [];
  const requestClient = createClient(async (statement, values = []) => {
    requestCalls.push({ statement, values });
    if (statement.includes("SELECT 1")) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  const verificationCalls = [];
  const verificationClient = createClient(async (statement, values = []) => {
    verificationCalls.push({ statement, values });
    if (statement.includes("SELECT code_hash")) {
      return {
        rowCount: 1,
        rows: [{
          code_hash: createHmac("sha256", jwtSecret)
            .update(`${phoneNumber}:123456`)
            .digest("hex"),
          attempts: 0,
          channel: "sms",
          registration_data: registration,
        }],
      };
    }
    if (statement.includes("INSERT INTO users")) {
      return {
        rowCount: 1,
        rows: [{
          id: "registered-user",
          phone_number: phoneNumber,
          email: registration.email,
          full_name: registration.full_name,
          country_code: registration.country_code,
          is_verified: true,
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  let connectionCount = 0;

  context.mock.method(pool, "query", async (statement) => {
    if (statement.includes("FROM country_config")) {
      return { rowCount: 1, rows: [{ code: "BF", phone_prefix: "+226" }] };
    }
    if (statement.includes("FROM users")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected pool query: ${statement}`);
  });
  context.mock.method(pool, "connect", async () => {
    connectionCount += 1;
    return connectionCount === 1 ? requestClient : verificationClient;
  });

  const requestResponse = createResponse();
  await requestOtp(
    {
      body: {
        flow: "register",
        first_name: "Awa",
        last_name: "Traoré",
        country_code: "BF",
        phone_number: phoneNumber,
        email: registration.email,
        terms_accepted: true,
        age_16_or_older: true,
      },
    },
    requestResponse,
    (error) => {
      throw error;
    },
  );

  assert.equal(requestResponse.statusCode, 200);
  assert.equal(requestResponse.payload.test_code, "123456");
  const otpInsert = requestCalls.find(({ statement }) =>
    statement.includes("INSERT INTO otp_verifications"),
  );
  assert.ok(otpInsert);
  assert.match(otpInsert.statement, /registration_data/);
  assert.equal(otpInsert.values[3], "sms");
  assert.deepEqual(JSON.parse(otpInsert.values[2]), registration);

  const verifyResponse = createResponse();
  await verifyOtp(
    { body: { identifier: phoneNumber, code: "123456" } },
    verifyResponse,
    (error) => {
      throw error;
    },
  );

  assert.equal(verifyResponse.statusCode, 200);
  assert.equal(verifyResponse.payload.user.id, "registered-user");
  assert.equal(verifyResponse.payload.user.name, "Awa Traoré");
  assert.ok(verifyResponse.payload.token);
  const userInsert = verificationCalls.find(({ statement }) =>
    statement.includes("INSERT INTO users"),
  );
  assert.ok(userInsert);
  assert.match(userInsert.statement, /terms_accepted_at/);
  assert.match(userInsert.statement, /CASE WHEN \$7 = 'sms' THEN NOW\(\)/);
  assert.match(userInsert.statement, /CASE WHEN \$7 = 'email' THEN NOW\(\)/);
  assert.deepEqual(userInsert.values, [
    phoneNumber,
    registration.email,
    registration.full_name,
    registration.first_name,
    registration.last_name,
    registration.country_code,
    "sms",
  ]);
});

test("unknown phone login offers account creation without issuing an OTP", async (context) => {
  let connectCalled = false;
  context.mock.method(pool, "query", async () => ({ rowCount: 0, rows: [] }));
  context.mock.method(pool, "connect", async () => {
    connectCalled = true;
    throw new Error("OTP should not be created for an unknown account.");
  });

  const response = createResponse();
  await requestOtp(
    { body: { flow: "login", identifier: phoneNumber } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 404);
  assert.match(response.payload.error, /Créer un compte/);
  assert.equal(connectCalled, false);
});

test("phone login normalizes formatted input and stored phone values to E.164", async (context) => {
  let insertedOtpValues;
  const client = createClient(async (statement, values = []) => {
    if (statement.includes("SELECT 1")) return { rowCount: 0, rows: [] };
    if (statement.includes("INSERT INTO otp_verifications")) {
      insertedOtpValues = values;
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(pool, "query", async (statement, values) => {
    assert.match(statement, /regexp_replace\(COALESCE\(phone_e164, phone_number\)/);
    assert.match(statement, /is_verified = TRUE OR phone_verified_at IS NOT NULL/);
    assert.equal(values[0], phoneNumber);
    return {
      rowCount: 1,
      rows: [{ phone_number: "+226 70 00 00 00", phone_e164: phoneNumber, email: "admin@example.com" }],
    };
  });
  context.mock.method(pool, "connect", async () => client);

  const response = createResponse();
  await requestOtp(
    { body: { flow: "login", identifier: "+226 70 00 00 00" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(insertedOtpValues[0], phoneNumber);
  assert.equal(response.payload.test_code, "123456");
});

test("email login sends and verifies the OTP against the account phone", async (context) => {
  const email = "awa@example.com";
  const user = {
    id: "existing-user",
    phone_number: phoneNumber,
    email,
    full_name: "Awa Traoré",
    country_code: "BF",
    is_verified: true,
  };
  const verificationCalls = [];
  const client = createClient(async (statement, values = []) => {
    verificationCalls.push({ statement, values });
    if (statement.includes("SELECT 1")) return { rowCount: 0, rows: [] };
    if (statement.includes("SELECT COALESCE(phone_e164, phone_number) AS phone_number FROM users")) {
      return { rowCount: 1, rows: [{ phone_number: phoneNumber }] };
    }
    if (statement.includes("SELECT phone_number FROM otp_verifications")) {
      return { rowCount: 0, rows: [] };
    }
    if (statement.includes("SELECT code_hash")) {
      return {
        rowCount: 1,
        rows: [{
          code_hash: createHmac("sha256", jwtSecret)
            .update(`${phoneNumber}:123456`)
            .digest("hex"),
          attempts: 0,
          channel: "email",
          registration_data: null,
        }],
      };
    }
    if (statement.includes("UPDATE users")) {
      return { rowCount: 1, rows: [user] };
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(pool, "query", async (statement) => {
    if (statement.includes("LOWER(email) = $1")) {
      return { rowCount: 1, rows: [{ phone_number: phoneNumber }] };
    }
    throw new Error(`Unexpected pool query: ${statement}`);
  });
  context.mock.method(pool, "connect", async () => client);

  const requestResponse = createResponse();
  await requestOtp(
    { body: { flow: "login", identifier: email, channel: "email" } },
    requestResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(requestResponse.statusCode, 200);
  assert.equal(requestResponse.payload.test_code, "123456");

  const verifyResponse = createResponse();
  await verifyOtp(
    { body: { identifier: email, code: "123456", channel: "email" } },
    verifyResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(verifyResponse.statusCode, 200);
  assert.equal(verifyResponse.payload.user.phone_number, phoneNumber);
  assert.equal(verifyResponse.payload.user.email, email);
  const verificationUpdate = verificationCalls.find(({ statement }) =>
    statement.includes("UPDATE users"),
  );
  assert.ok(verificationUpdate);
  assert.match(verificationUpdate.statement, /email_verified_at = CASE WHEN \$3 = 'email'/);
  assert.equal(verificationUpdate.values[2], "email");
});

test("Google login links a case-insensitive email to the existing admin account", async (context) => {
  const queries = [];
  const adminUser = {
    id: "existing-admin",
    phone_number: phoneNumber,
    email: "admin@example.com",
    google_id: "google-subject",
    full_name: "Admin",
    role: "admin",
    is_verified: true,
    phone_verified_at: "2026-01-01T00:00:00.000Z",
  };
  const client = createClient(async (statement, values = []) => {
    queries.push({ statement, values });
    if (statement.includes("SELECT id, google_id")) {
      return { rowCount: 1, rows: [{ id: adminUser.id, google_id: null }] };
    }
    if (statement.includes("UPDATE users")) {
      return { rowCount: 1, rows: [adminUser] };
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => ({
      sub: "google-subject",
      email: "Admin@Example.com",
      email_verified: true,
      name: "Admin",
    }),
  }));
  context.mock.method(pool, "connect", async () => client);

  const response = createResponse();
  await googleAuth(
    { body: { id_token: "header.payload.signature" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.user.id, adminUser.id);
  assert.equal(response.payload.user.role, "admin");
  assert.equal(response.payload.user.phone_number, phoneNumber);
  const lookup = queries.find(({ statement }) => statement.includes("SELECT id, google_id"));
  assert.match(lookup.statement, /LOWER\(email\) = \$2/);
  assert.equal(lookup.values[1], "admin@example.com");
});

test("an OTP issued for email cannot be verified as SMS", async (context) => {
  let userUpdateAttempted = false;
  const client = createClient(async (statement) => {
    if (statement.includes("SELECT code_hash")) {
      return {
        rowCount: 1,
        rows: [{
          code_hash: createHmac("sha256", jwtSecret)
            .update(`${phoneNumber}:123456`)
            .digest("hex"),
          attempts: 0,
          channel: "email",
          registration_data: null,
        }],
      };
    }
    if (statement.includes("UPDATE users")) userUpdateAttempted = true;
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(pool, "connect", async () => client);

  const response = createResponse();
  await verifyOtp(
    { body: { identifier: phoneNumber, code: "123456", channel: "sms" } },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 401);
  assert.equal(userUpdateAttempted, false);
});

test("email OTP explains that SMS should be chosen until a provider is configured", async (context) => {
  const unlistedPhone = "+22656119567";
  let connectCalled = false;
  context.mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ phone_number: unlistedPhone, email: "awa@example.com" }],
  }));
  context.mock.method(pool, "connect", async () => {
    connectCalled = true;
    throw new Error("OTP must not be stored when email is not configured.");
  });

  const response = createResponse();
  await requestOtp(
    {
      body: {
        flow: "login",
        identifier: unlistedPhone,
        channel: "email",
      },
    },
    response,
    (error) => {
      throw error;
    },
  );

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.payload.error,
    "L'envoi par e-mail n'est pas encore configuré, choisissez SMS.",
  );
  assert.equal(connectCalled, false);
});
