import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { env } = await import("../config/env.js");
const { pool } = await import("../db/pool.js");
const {
  acceptLegalDocuments,
  getLegalDocuments,
  getMyLegalAcceptances,
} = await import("../controllers/legalController.js");

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  headers: {},
  status(code) {
    this.statusCode = code;
    return this;
  },
  set(name, value) {
    this.headers[name] = value;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const currentAcceptances = () =>
  Object.entries(env.legalDocumentVersions).map(([document_id, version]) => ({
    document_id,
    version,
  }));

test("public legal documents expose the configured version for all required documents", () => {
  const response = createResponse();
  getLegalDocuments({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(
    response.payload.documents.map(({ id }) => id).sort(),
    Object.keys(env.legalDocumentVersions).sort(),
  );
  assert.equal(
    response.payload.documents.find(({ id }) => id === "privacy").version,
    env.legalDocumentVersions.privacy,
  );
});

test("latest legal acceptances are compared with the configured document versions", async (context) => {
  context.mock.method(pool, "query", async () => ({
    rows: [
      { document_id: "terms", version: env.legalDocumentVersions.terms },
    ],
  }));
  const response = createResponse();
  await getMyLegalAcceptances(
    { auth: { userId: "user-1" } },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.documents.find(({ id }) => id === "terms").accepted_version, env.legalDocumentVersions.terms);
  assert.equal(response.payload.documents.find(({ id }) => id === "privacy").accepted_version, null);
});

test("acceptance requires every current version and an explicit age confirmation", async (context) => {
  let queryCount = 0;
  context.mock.method(pool, "query", async () => {
    queryCount += 1;
    return { rowCount: currentAcceptances().length, rows: [] };
  });
  const staleResponse = createResponse();
  await acceptLegalDocuments(
    {
      auth: { userId: "user-1" },
      body: {
        acceptances: [
          ...currentAcceptances().slice(1),
          { document_id: "terms", version: "older" },
        ],
        age_16_or_older: true,
        app_version: "1.0.0",
      },
    },
    staleResponse,
    (error) => { throw error; },
  );
  assert.equal(staleResponse.statusCode, 409);

  const underageResponse = createResponse();
  await acceptLegalDocuments(
    {
      auth: { userId: "user-1" },
      body: {
        acceptances: currentAcceptances(),
        age_16_or_older: false,
        app_version: "1.0.0",
      },
    },
    underageResponse,
    (error) => { throw error; },
  );
  assert.equal(underageResponse.statusCode, 400);
  assert.equal(queryCount, 0);

  const acceptedResponse = createResponse();
  await acceptLegalDocuments(
    {
      auth: { userId: "user-1" },
      body: {
        acceptances: currentAcceptances(),
        age_16_or_older: true,
        app_version: "1.0.0",
      },
    },
    acceptedResponse,
    (error) => { throw error; },
  );
  assert.equal(acceptedResponse.statusCode, 201);
  assert.equal(acceptedResponse.payload.accepted, true);
  assert.equal(queryCount, 1);
});
