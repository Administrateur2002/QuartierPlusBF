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
  ADMIN_EMAIL: "verified-admin@example.com",
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

test("production environment refuses the fixed test OTP mode", () => {
  const result = loadProductionConfig({ OTP_TEST_MODE: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OTP_TEST_MODE must not be enabled in production/);
});

test("administrator email is normalized and validated", () => {
  const valid = loadProductionConfig({
    ADMIN_EMAIL: "AdministrateurQuartierPlus@gmail.com",
  });
  assert.equal(valid.status, 0, valid.stderr);

  const malformed = loadProductionConfig({ ADMIN_EMAIL: "not-an-email" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /ADMIN_EMAIL/);
});

test("production environment requires an explicitly configured admin email", () => {
  const missing = loadProductionConfig({ ADMIN_EMAIL: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ADMIN_EMAIL is required in production/);
});

test("live Grin moderation requires a strong webhook secret when enabled", () => {
  const enabled = loadProductionConfig({
    GRIN_MODERATION_ENABLED: "true",
    AWS_REKOGNITION_ENABLED: "true",
    GRIN_MODERATION_WEBHOOK_SECRET:
      "production-grin-moderation-webhook-secret-over-32-characters",
    GRIN_MODERATOR_IDS: "7b490a29-02dd-44ad-8c9f-81d9cadc0007",
  });
  assert.equal(enabled.status, 0, enabled.stderr);

  const weakSecret = loadProductionConfig({
    GRIN_MODERATION_ENABLED: "true",
    AWS_REKOGNITION_ENABLED: "true",
    GRIN_MODERATION_WEBHOOK_SECRET: "short",
  });
  assert.notEqual(weakSecret.status, 0);
  assert.match(weakSecret.stderr, /GRIN_MODERATION_WEBHOOK_SECRET/);
});

test("live Grin moderation requires at least one valid moderator UUID", () => {
  const enabled = {
    GRIN_MODERATION_ENABLED: "true",
    AWS_REKOGNITION_ENABLED: "true",
    GRIN_MODERATION_WEBHOOK_SECRET:
      "production-grin-moderation-webhook-secret-over-32-characters",
  };
  const missing = loadProductionConfig(enabled);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /GRIN_MODERATOR_IDS/);

  const malformed = loadProductionConfig({
    ...enabled,
    GRIN_MODERATOR_IDS: "not-a-uuid",
  });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /GRIN_MODERATOR_IDS/);
});

test("video limits default to 420 seconds and 100 MiB and can be configured", () => {
  const loadLimits = (overrides = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { env } from './config/env.js'; console.log(JSON.stringify([env.postMaxVideoSeconds, env.postMaxVideoBytes]))",
      ],
      {
        cwd: serverDirectory,
        env: {
          ...productionEnv,
          ...overrides,
          DOTENV_CONFIG_PATH: "/dev/null",
        },
        encoding: "utf8",
      },
    );

  const defaultLimit = loadLimits();
  assert.equal(defaultLimit.status, 0, defaultLimit.stderr);
  assert.deepEqual(JSON.parse(defaultLimit.stdout.trim()), [420, 104857600]);

  const configuredLimit = loadLimits({
    POST_MAX_VIDEO_SECONDS: "240",
    POST_MAX_VIDEO_BYTES: "50000000",
  });
  assert.equal(configuredLimit.status, 0, configuredLimit.stderr);
  assert.deepEqual(JSON.parse(configuredLimit.stdout.trim()), [240, 50000000]);
});

test("upload moderation is disabled by default and requires worker and email configuration", () => {
  const loadModeration = (overrides = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { env } from './config/env.js'; console.log(JSON.stringify([env.moderationUploadsEnabled, env.moderationDailyAnalysisLimit]))",
      ],
      {
        cwd: serverDirectory,
        env: {
          ...productionEnv,
          ...overrides,
          DOTENV_CONFIG_PATH: "/dev/null",
        },
        encoding: "utf8",
      },
    );

  const disabled = loadModeration();
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout.trim()), [false, 100]);

  const enabled = loadModeration({
    MODERATION_UPLOADS_ENABLED: "true",
    AWS_REKOGNITION_ENABLED: "true",
    MODERATION_SERVICE_URL: "https://moderator.example.test",
    MODERATION_DAILY_ANALYSIS_LIMIT: "25",
    GRIN_MODERATION_WEBHOOK_SECRET:
      "production-grin-moderation-webhook-secret-over-32-characters",
    SUPPORT_NOTIFY_EMAIL: "support@example.test",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_USER: "support",
    SMTP_PASS: "test-password",
    MAIL_FROM: "QuartierPlus <noreply@example.test>",
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout.trim()), [true, 25]);

  const incomplete = loadModeration({
    MODERATION_UPLOADS_ENABLED: "true",
    AWS_REKOGNITION_ENABLED: "true",
  });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /MODERATION_SERVICE_URL/);
});

test("AWS moderation flags default off and requested services degrade to manual review", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { env } from './config/env.js'; console.log(JSON.stringify([env.awsRekognitionEnabled, env.awsTranscribeEnabled, env.grinModerationEnabled, env.moderationUploadsEnabled]))",
    ],
    {
      cwd: serverDirectory,
      env: {
        ...productionEnv,
        GRIN_MODERATION_ENABLED: "true",
        MODERATION_UPLOADS_ENABLED: "true",
        DOTENV_CONFIG_PATH: "/dev/null",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [false, false, false, false]);
});

test("public text moderation and conflict protection remain opt-in with explicit dependencies", () => {
  const loadTextModeration = (overrides = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { env } from './config/env.js'; console.log(JSON.stringify([env.textModerationEnabled, env.conflictProtectionEnabled]))",
      ],
      {
        cwd: serverDirectory,
        env: {
          ...productionEnv,
          ...overrides,
          DOTENV_CONFIG_PATH: "/dev/null",
        },
        encoding: "utf8",
      },
    );

  const disabled = loadTextModeration();
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(disabled.stdout.trim()), [false, false]);

  const missingLiveReview = loadTextModeration({
    TEXT_MODERATION_ENABLED: "true",
  });
  assert.notEqual(missingLiveReview.status, 0);
  assert.match(missingLiveReview.stderr, /GRIN_MODERATION_ENABLED/);

  const enabled = loadTextModeration({
    GRIN_MODERATION_ENABLED: "true",
    GRIN_MODERATION_WEBHOOK_SECRET:
      "production-grin-moderation-webhook-secret-over-32-characters",
    GRIN_MODERATOR_IDS: "7b490a29-02dd-44ad-8c9f-81d9cadc0007",
    TEXT_MODERATION_ENABLED: "true",
    CONFLICT_PROTECTION_ENABLED: "true",
    SUPPORT_NOTIFY_EMAIL: "support@example.test",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "587",
    SMTP_USER: "support",
    SMTP_PASS: "test-password",
    MAIL_FROM: "QuartierPlus <noreply@example.test>",
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout.trim()), [true, true]);

  const incomplete = loadTextModeration({
    CONFLICT_PROTECTION_ENABLED: "true",
  });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /TEXT_MODERATION_ENABLED/);
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