import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  createSeries,
  createSeason,
  createEpisode,
  getEpisodePoll,
  getEpisodePollResults,
  getResume,
  publishSeries,
  voteOnEpisodePoll,
} = await import("../controllers/seriesController.js");
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

const next = (error) => {
  if (error) throw error;
};

test("series creation persists validated creator and international metadata", async (context) => {
  let query;
  context.mock.method(pool, "query", async (statement, values) => {
    query = { statement, values };
    return { rowCount: 1, rows: [{ id: "series-id", status: "DRAFT" }] };
  });
  const response = createResponse();

  await createSeries({
    auth: { userId: "creator-id" },
    body: {
      title: "Histoires du quartier",
      language_code: "fr",
      country_code: "BF",
      culture_tags: ["burkinabe"],
      credits: [{ name: "Awa", role: "WRITER" }],
    },
  }, response, next);

  assert.equal(response.statusCode, 201);
  assert.equal(query.values[0], "creator-id");
  assert.equal(query.values[4], "BF");
  assert.equal(query.values[6][0], "burkinabe");
  assert.deepEqual(JSON.parse(query.values[7]), [{ name: "Awa", role: "WRITER" }]);
});

test("series creation rejects invalid language and credit roles without querying", async (context) => {
  const query = context.mock.method(pool, "query", async () => ({ rows: [] }));
  const response = createResponse();

  await createSeries({
    auth: { userId: "creator-id" },
    body: { title: "Série", language_code: "not a locale", credits: [{ name: "Awa", role: "FAN" }] },
  }, response, next);

  assert.equal(response.statusCode, 400);
  assert.equal(query.mock.callCount(), 0);
});

test("episode creation rejects invalid media URLs before touching the database", async (context) => {
  const query = context.mock.method(pool, "query", async () => ({ rows: [] }));
  const response = createResponse();

  await createEpisode({
    params: { seasonId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "creator-id" },
    body: { episode_number: 1, title: "Pilote", video_url: "https://" },
  }, response, next);

  assert.equal(response.statusCode, 400);
  assert.equal(query.mock.callCount(), 0);

  await createEpisode({
    params: { seasonId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "creator-id" },
    body: { episode_number: 1, title: "Pilote", is_published: true },
  }, response, next);

  assert.equal(response.statusCode, 400);
  assert.equal(query.mock.callCount(), 0);
});

test("season creation scopes inserts to the authenticated series creator", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await createSeason({
    params: { seriesId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "creator-id" },
    body: { season_number: 1, title: "Saison 1" },
  }, response, next);

  assert.equal(response.statusCode, 404);
  assert.match(statement, /creator_id = \$2/);
  assert.equal(values[1], "creator-id");
});

test("vote writes are constrained by open episode poll and unique voter key", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await voteOnEpisodePoll({
    params: { episodeId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "viewer-id" },
    body: { option_id: "22222222-2222-4222-8222-222222222222" },
  }, response, next);

  assert.equal(response.statusCode, 409);
  assert.match(statement, /p\.closes_at > NOW\(\)/);
  assert.match(statement, /s\.creator_id <> \$3/);
  assert.match(statement, /ON CONFLICT \(poll_id, user_id\) DO NOTHING/);
});

test("poll results are scoped to the series creator", async (context) => {
  let statement;
  let values;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await getEpisodePollResults({
    params: { episodeId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "not-the-creator" },
  }, response, next);

  assert.equal(response.statusCode, 404);
  assert.match(statement, /s\.creator_id = \$2/);
  assert.equal(values[1], "not-the-creator");
});

test("resume returns only the latest incomplete published episode", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await getResume({ auth: { userId: "viewer-id" } }, response, next);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.resume, null);
  assert.match(statement, /p\.completed = FALSE/);
  assert.match(statement, /s\.status = 'PUBLISHED'/);
  assert.match(statement, /ORDER BY p\.updated_at DESC LIMIT 1/);
});

test("series publication requires a published HTTPS episode owned by the creator", async (context) => {
  let statement;
  context.mock.method(pool, "query", async (sql) => {
    statement = sql;
    return { rowCount: 0, rows: [] };
  });
  const response = createResponse();

  await publishSeries({
    params: { seriesId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "creator-id" },
  }, response, next);

  assert.equal(response.statusCode, 409);
  assert.match(statement, /s\.creator_id = \$2/);
  assert.match(statement, /e\.is_published = TRUE/);
  assert.match(statement, /e\.video_url LIKE 'https:\/\/%'/);
});

test("public poll reads report whether the authenticated viewer already voted", async (context) => {
  let values;
  let statement;
  context.mock.method(pool, "query", async (sql, params) => {
    statement = sql;
    values = params;
    return {
      rowCount: 1,
      rows: [{ id: "poll-id", closes_at: new Date(Date.now() + 60_000), has_voted: true }],
    };
  });
  const response = createResponse();

  await getEpisodePoll({
    params: { episodeId: "11111111-1111-4111-8111-111111111111" },
    auth: { userId: "viewer-id" },
  }, response, next);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.poll.has_voted, true);
  assert.match(statement, /v\.user_id = \$2/);
  assert.equal(values[1], "viewer-id");
});