import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  API_CONTRACT_VERSION,
  SERVER_STARTED_AT,
  getHealthPayload,
  handleHealth,
} from "../health.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("health payload exposes the deployed commit and mobile contract version", async () => {
  process.env.RENDER_GIT_COMMIT = "test-commit";
  assert.deepEqual(getHealthPayload(), {
    status: "ok",
    commit: "test-commit",
    contractVersion: API_CONTRACT_VERSION,
    startedAt: SERVER_STARTED_AT,
    lastMigration: null,
  });

  const mobileContract = await readFile(
    join(serverRoot, "../mobile/src/services/serverContract.ts"),
    "utf8",
  );
  assert.match(
    mobileContract,
    new RegExp(`EXPECTED_API_CONTRACT_VERSION = ${API_CONTRACT_VERSION}`),
  );
  const serverEntry = await readFile(join(serverRoot, "index.js"), "utf8");
  assert.match(serverEntry, /app\.get\(\["\/health", "\/v1\/health"\]/);
});

test("health handler returns safe diagnostics when migration registry is unavailable", async (context) => {
  process.env.NODE_ENV ??= "test";
  process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
  process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
  const { pool } = await import("../db/pool.js");
  context.mock.method(pool, "query", async () => {
    throw new Error("database unavailable");
  });
  const response = {
    code: 0,
    payload: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  await handleHealth({}, response);
  assert.equal(response.code, 200);
  assert.equal(response.payload.status, "ok");
  assert.equal(response.payload.commit, "test-commit");
  assert.equal(response.payload.startedAt, SERVER_STARTED_AT);
  assert.equal(response.payload.lastMigration, null);
});

test("health handler reports the latest recorded migration", async (context) => {
  const { pool } = await import("../db/pool.js");
  const latestMigration = {
    version: "029_post_media_carousel.sql",
    applied_at: "2026-11-01T10:00:00.000Z",
  };
  context.mock.method(pool, "query", async () => ({ rows: [latestMigration] }));
  const response = {
    code: 0,
    payload: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await handleHealth({}, response);

  assert.equal(response.code, 200);
  assert.deepEqual(response.payload.lastMigration, latestMigration);
});
