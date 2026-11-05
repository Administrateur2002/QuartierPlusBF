import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { compareVersions, createRuntimeGate } = await import(
  "../middlewares/runtimeGate.js"
);

const invoke = (gate, version) => {
  const result = { statusCode: null, body: null, continued: false };
  const response = {
    status(statusCode) {
      result.statusCode = statusCode;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  gate(
    { get: () => version },
    response,
    () => {
      result.continued = true;
    },
  );
  return result;
};

test("runtime version comparison rejects malformed versions", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2", "1.2.3"), null);
});

test("runtime gate blocks maintenance and clients below the configured minimum", () => {
  const maintenance = createRuntimeGate({
    maintenanceMode: true,
    minimumAppVersion: "1.2.0",
  });
  assert.equal(invoke(maintenance, "99.0.0").statusCode, 503);

  const minimum = createRuntimeGate({
    maintenanceMode: false,
    minimumAppVersion: "1.2.0",
  });
  assert.equal(invoke(minimum, undefined).statusCode, 426);
  assert.equal(invoke(minimum, "1.1.9").statusCode, 426);
  assert.equal(invoke(minimum, "1.2.0").continued, true);
  assert.equal(invoke(minimum, "1.3.0").continued, true);
});
