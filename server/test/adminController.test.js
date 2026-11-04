import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-jwt";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const {
  actOnReport,
  createFlash,
  deliverFlashBroadcast,
  getAdminDashboard,
  appealReport,
  resolvePostModerationEvent,
} = await import("../controllers/adminController.js");
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

test("admin dashboard fetches reports, live and upload moderation queues, and counts", async (context) => {
  const statements = [];
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    if (statement.includes("FROM reports AS report")) {
      return { rows: [{ id: "report-id", severity: "ÉLEVÉ" }] };
    }
    if (statement.includes("FROM grin_moderation_events")) {
      return { rows: [{ id: "event-id", category: "Explicit Nudity" }] };
    }
    if (statement.includes("FROM post_moderation_events")) {
      return { rows: [{ id: "upload-event-id", status: "PENDING_REVIEW" }] };
    }
    return { rows: [{ status: "PENDING", count: 1 }] };
  });
  const response = createResponse();
  await getAdminDashboard({ query: { status: "ALL" } }, response, (error) => {
    throw error;
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.reports[0].id, "report-id");
  assert.equal(response.payload.live_events[0].id, "event-id");
  assert.equal(response.payload.upload_moderation_events[0].id, "upload-event-id");
  assert.equal(response.payload.counts.PENDING, 1);
  assert.equal(statements[0].values[0], "ALL");
  assert.match(statements[0].statement, /private_messages/);
  assert.match(statements[0].statement, /sos_alerts/);
});

test("an admin can approve a reviewed upload and publish it only after other pending checks clear", async (context) => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.includes("SELECT event.id")) {
        return {
          rowCount: 1,
          rows: [{
            id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
            post_id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003",
            author_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
            media_type: "image",
            media_id: "media-id",
            score: "60",
            status: "PENDING_REVIEW",
            available_post_id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003",
          }],
        };
      }
      if (statement.includes("SELECT 1 FROM post_moderation_events")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();

  await resolvePostModerationEvent(
    {
      params: { eventId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      body: { action: "approve" },
      auth: { userId: "5b490a29-02dd-44ad-8c9f-81d9cadc0005" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.ok(statements.some(({ statement }) => statement.includes("UPDATE posts SET status = 'ACTIVE'")));
  assert.ok(statements.some(({ statement }) => statement.includes("INSERT INTO admin_audit_log")));
  assert.equal(statements.at(-1).statement, "COMMIT");
});

test("report actions update content, preserve the affected account, and write an audit entry", async (context) => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.includes("SELECT report.id")) {
        return {
          rowCount: 1,
          rows: [{
            id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
            target_type: "POST",
            target_id: "3b490a29-02dd-44ad-8c9f-81d9cadc0003",
            target_user_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
            status: "PENDING",
          }],
        };
      }
      if (statement.includes("UPDATE reports")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();

  await actOnReport(
    {
      params: { reportId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      body: { action: "hide", note: "Masquage temporaire" },
      auth: { userId: "5b490a29-02dd-44ad-8c9f-81d9cadc0005" },
    },
    response,
    (error) => { throw error; },
  );

  assert.equal(response.statusCode, 200);
  assert.ok(statements.some(({ statement }) => statement.includes("UPDATE posts SET status = 'HIDDEN'")));
  const reportUpdate = statements.find(({ statement }) => statement.includes("UPDATE reports"));
  assert.equal(reportUpdate.values[4], "4b490a29-02dd-44ad-8c9f-81d9cadc0004");
  assert.ok(statements.some(({ statement }) => statement.includes("INSERT INTO admin_audit_log")));
  assert.equal(statements.at(-1).statement, "COMMIT");
});

test("the affected user can appeal a resolved moderation decision and the appeal is audited atomically", async (context) => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.includes("WHERE report.id = $1 AND report.status = 'RESOLVED'")) {
        return {
          rowCount: 1,
          rows: [{
            id: "2b490a29-02dd-44ad-8c9f-81d9cadc0002",
            target_user_id: "4b490a29-02dd-44ad-8c9f-81d9cadc0004",
          }],
        };
      }
      if (statement.includes("UPDATE reports")) {
        return { rowCount: 1, rows: [{ id: values[0], status: "APPEALED" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();
  await appealReport(
    {
      params: { reportId: "2b490a29-02dd-44ad-8c9f-81d9cadc0002" },
      body: { reason: "Cette décision ne correspond pas au contexte de la publication." },
      auth: { userId: "4b490a29-02dd-44ad-8c9f-81d9cadc0004" },
    },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.appealed, true);
  assert.ok(statements.some(({ statement }) => statement.includes("INSERT INTO admin_audit_log")));
  assert.equal(statements.at(-1).statement, "COMMIT");
});

test("flash broadcasts require a real target and store future sends for scheduling", async (context) => {
  const statements = [];
  const client = {
    async query(statement, values) {
      statements.push({ statement, values });
      if (statement.includes("INSERT INTO admin_flash_broadcasts")) {
        return {
          rowCount: 1,
          rows: [{
            id: "6b490a29-02dd-44ad-8c9f-81d9cadc0006",
            title: values[2],
            body: values[3],
            target_type: values[4],
            status: "SCHEDULED",
            scheduled_at: values[6],
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  context.mock.method(pool, "connect", async () => client);
  const response = createResponse();
  await createFlash(
    {
      body: {
        title: "Alerte",
        body: "Évitez le secteur pendant l'intervention.",
        target_type: "REGION",
        target: { latitude: 12.3, longitude: -1.5, radius_km: 15 },
        scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      auth: { userId: "7b490a29-02dd-44ad-8c9f-81d9cadc0007" },
    },
    response,
    (error) => { throw error; },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.broadcast.status, "SCHEDULED");
  assert.ok(statements.some(({ statement }) => statement.includes("admin_audit_log")));

  const invalidResponse = createResponse();
  await createFlash(
    {
      body: { title: "Alerte", body: "Texte", target_type: "REGION", target: {} },
      auth: { userId: "7b490a29-02dd-44ad-8c9f-81d9cadc0007" },
    },
    invalidResponse,
    (error) => { throw error; },
  );
  assert.equal(invalidResponse.statusCode, 400);
});

test("flash delivery sends push notifications to registered recipients and records tickets", async (context) => {
  const statements = [];
  const id = "6b490a29-02dd-44ad-8c9f-81d9cadc0006";
  context.mock.method(pool, "query", async (statement, values) => {
    statements.push({ statement, values });
    if (statement.includes("UPDATE admin_flash_broadcasts") && statement.includes("RETURNING *")) {
      return {
        rowCount: 1,
        rows: [{
          id,
          title: "Urgence",
          body: "Message de sécurité",
          target_type: "COUNTRY",
          target: { country_code: "BF" },
          actor_id: "7b490a29-02dd-44ad-8c9f-81d9cadc0007",
        }],
      };
    }
    if (statement.includes("SELECT DISTINCT token")) {
      return {
        rowCount: 2,
        rows: [
          { token: "ExpoPushToken[first]" },
          { token: "ExpoPushToken[second]" },
        ],
      };
    }
    if (statement.includes("SET status = $5")) {
      return {
        rowCount: 1,
        rows: [{ id, status: "SENT", recipient_count: 2, accepted_count: 2, failed_count: 0 }],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.length, 2);
    assert.equal(body[0].title, "Urgence");
    return new Response(JSON.stringify({ data: [{ status: "ok" }, { status: "ok" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const broadcast = await deliverFlashBroadcast(id);
  assert.equal(broadcast.status, "SENT");
  assert.equal(broadcast.accepted_count, 2);
  assert.ok(statements.some(({ statement }) => statement.includes("account.country_code")));
  assert.ok(statements.some(({ statement }) => statement.includes("admin_audit_log")));
});
