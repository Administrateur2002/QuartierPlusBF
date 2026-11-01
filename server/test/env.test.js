import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const productionEnv = {
  PATH: process.env.PATH,
  NODE_ENV: "production",
  DATABASE_URL: "postgres://localhost/quartierplus",
  JWT_SECRET: "production-jwt-secret-with-at-least-32-characters",
  TICKET_QR_SECRET: "production-ticket-secret-with-at-least-32-characters",
  OTP_TEST_MODE: "false",
  OTP_TEST_ALLOWLIST: "+22670000000",
  SMS_DELIVERY_URL: "https://sms.example.invalid/send",
  SMS_DELIVERY_TOKEN: "fake-sms-token",
  GOOGLE_CLIENT_ID: "fake-google-client-id",
  LIVEKIT_API_KEY: "APITestUnitKey12345",
  LIVEKIT_API_SECRET:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  LIVEKIT_URL: "wss://quartierplus.livekit.cloud",
  DOTENV_CONFIG_PATH: "/dev/null",
};

const loadProductionConfig = (overrides = {}) =>
  spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import './config/env.js'"],
    {
      cwd: serverDirectory,
      env: { ...productionEnv, ...overrides },
      encoding: "utf8",
    },
  );

test("production environment accepts a complete valid configuration", () => {
  const result = loadProductionConfig();
  assert.equal(result.status, 0, result.stderr);
});

test("video duration limit defaults to 180 seconds and can be configured", () => {
  const loadLimit = (value) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { env } from './config/env.js'; console.log(env.postMaxVideoSeconds)",
      ],
      {
        cwd: serverDirectory,
        env: {
          ...productionEnv,
          POST_MAX_VIDEO_SECONDS: value,
          DOTENV_CONFIG_PATH: "/dev/null",
        },
        encoding: "utf8",
      },
    );

  const defaultLimit = loadLimit("");
  assert.equal(defaultLimit.status, 0, defaultLimit.stderr);
  assert.equal(defaultLimit.stdout.trim(), "180");

  const configuredLimit = loadLimit("240");
  assert.equal(configuredLimit.status, 0, configuredLimit.stderr);
  assert.equal(configuredLimit.stdout.trim(), "240");
});

test("Cloudinary and LiveKit values are trimmed and unquoted", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify([env.cloudinaryCloudName, env.cloudinaryApiKey, env.cloudinaryApiSecret, env.livekitApiKey, env.livekitApiSecret, env.livekitUrl]))",
    ],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        CLOUDINARY_CLOUD_NAME: '  "quartierplus"  ',
        CLOUDINARY_API_KEY: " 'cloud-key' ",
        CLOUDINARY_API_SECRET: '"cloud-secret"',
        LIVEKIT_API_KEY: ' "APITestUnitKey12345" ',
        LIVEKIT_API_SECRET: ` "${productionEnv.LIVEKIT_API_SECRET}" `,
        LIVEKIT_URL: ' "wss://quartierplus.livekit.cloud" ',
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "quartierplus",
    "cloud-key",
    "cloud-secret",
    "APITestUnitKey12345",
    productionEnv.LIVEKIT_API_SECRET,
    "wss://quartierplus.livekit.cloud",
  ]);
});

test("production environment rejects missing required service credentials", () => {
  for (const name of ["SMS_DELIVERY_TOKEN", "GOOGLE_CLIENT_ID"]) {
    const result = loadProductionConfig({ [name]: "" });
    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(result.stderr, new RegExp(name));
  }
});

test("production environment remains available when LiveKit is misconfigured", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify({ usable: env.livekitConfigurationIsUsable, problems: env.livekitConfigurationProblems }))",
    ],
    {
      cwd: serverDirectory,
      env: { ...productionEnv, LIVEKIT_URL: "ws://invalid.example.invalid", DOTENV_CONFIG_PATH: "/dev/null" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"usable":false/);
  assert.match(result.stdout, /LIVEKIT_URL/);
});

test("production environment rejects test OTP mode even with an allowlisted number", () => {
  const result = loadProductionConfig({
    OTP_TEST_MODE: "true",
    OTP_TEST_ALLOWLIST: "+22670000000",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OTP_TEST_MODE must not be enabled in production/);
});

test("production environment rejects malformed OTP allowlist entries", () => {
  const result = loadProductionConfig({
    OTP_TEST_ALLOWLIST: "+22670000000,not-a-phone",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OTP_TEST_ALLOWLIST/);
});

test("production environment rejects malformed URLs and boolean variables", () => {
  for (const [name, value] of [
    ["PGSSL", "yes"],
    ["IS_PROMO_FREE_ACCESS", "sometimes"],
    ["BILLING_ENABLED", "sometimes"],
    ["PRO_ENABLED", "sometimes"],
    ["VOYAGE_DEMO_DATA", "sometimes"],
  ]) {
    const result = loadProductionConfig({ [name]: value });
    assert.notEqual(result.status, 0, `${name} should be validated`);
    assert.match(result.stderr, new RegExp(name));
  }
});

test("QuartierPlus Pro is disabled by default and can be explicitly enabled", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import { env } from './config/env.js'; console.log(env.proEnabled)"],
    {
      cwd: serverDirectory,
      env: { ...productionEnv, DOTENV_CONFIG_PATH: "/dev/null" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "false");
  const enabled = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import { env } from './config/env.js'; console.log(env.proEnabled)"],
    {
      cwd: serverDirectory,
      env: { ...productionEnv, PRO_ENABLED: "true", DOTENV_CONFIG_PATH: "/dev/null" },
      encoding: "utf8",
    },
  );
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stdout.trim(), "true");
});

test("production environment marks placeholder LiveKit credentials unavailable", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify({ usable: env.livekitConfigurationIsUsable, problems: env.livekitConfigurationProblems }))",
    ],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        LIVEKIT_API_KEY: "your-livekit-api-key",
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"usable":false/);
  assert.match(result.stdout, /LIVEKIT_API_KEY/);
});

test("LiveKit API key diagnostics identify format failures without exposing the key", () => {
  const invalidKey = "bad key";
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify(env.livekitConfigurationProblemDetails))",
    ],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        LIVEKIT_API_KEY: invalidKey,
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /must match \/\^API/);
  assert.equal(result.stdout.includes(invalidKey), false);
});

test("production environment accepts a trimmed and quoted API-prefixed LiveKit key", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify({ usable: env.livekitConfigurationIsUsable, key: env.livekitApiKey }))",
    ],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        LIVEKIT_API_KEY: '  "APITY2z_a-real-key"  ',
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    usable: true,
    key: "APITY2z_a-real-key",
  });
});

test("production environment remains available with partial Cloudinary settings", () => {
  const result = loadProductionConfig({
    CLOUDINARY_CLOUD_NAME: "quartierplus",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("media limits are configurable positive integers", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import './config/env.js'"],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        POST_MAX_PHOTO_BYTES: "0",
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POST_MAX_PHOTO_BYTES must be a positive integer/);
});