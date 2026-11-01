import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??= "unit-test-secret-that-is-longer-than-thirty-two-characters";
process.env.VOYAGE_ENABLED = "true";
process.env.VOYAGE_DEMO_DATA = "true";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.TICKET_SIGNING_PRIVATE_KEY_B64 = Buffer.from(
  privateKey.export({ type: "pkcs8", format: "pem" }),
).toString("base64");

const { pool } = await import("../db/pool.js");
const {
  bookVoyageSeat,
  confirmVoyageStationPayment,
  downloadVoyagePassengerManifestPdf,
  getVoyageConfig,
  listVoyagePassengers,
  listVoyageTrips,
  scanVoyage,
} = await import("../controllers/voyageController.js");
const { signVoyageTicket, verifyVoyageTicket } = await import("../services/voyageTickets.js");

const ids = {
  ticket: "18e33442-289d-42f1-b8af-e9bdf1e3ee5a",
  trip: "953b2d12-0638-48d2-98ec-4b8921c5dc3d",
  seat: "8ad35c27-1508-4a1c-9560-f45e0a18c64c",
  traveler: "f1c8b311-e38a-43fd-a9d5-b45ad99ce466",
  company: "2a2a3cb8-9899-4c70-9fb5-697ab4396063",
  agent: "bc9d0a25-fc72-4d61-90c7-f1c310d31c38",
};

const response = () => ({
  statusCode: 200,
  payload: null,
  headers: {},
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; },
  setHeader(name, value) { this.headers[name] = value; return this; },
  send(body) { this.body = body; return this; },
});

test("Voyage ticket uses a verifiable Ed25519 signature and rejects tampering", () => {
  const signed = signVoyageTicket({ id: ids.ticket, trip_id: ids.trip, expires_at: new Date(Date.now() + 60_000) });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyVoyageTicket(signed, pem), true);
  assert.equal(verifyVoyageTicket({ ...signed, trip_id: ids.seat }, pem), false);
});

test("Voyage config exposes the enabled Burkina demo data flag", () => {
  const result = response();
  getVoyageConfig({}, result);
  assert.deepEqual(result.payload, { enabled: true, demo_data_enabled: true });
});

test("Voyage trip search rejects invalid city and calendar date before querying", async () => {
  const originalQuery = pool.query;
  pool.query = async () => { throw new Error("The database should not be queried."); };
  try {
    const invalidCity = response();
    await listVoyageTrips({ query: { departure: "Abidjan", arrival: "Ouagadougou" } }, invalidCity, (error) => { throw error; });
    assert.equal(invalidCity.statusCode, 400);
    const invalidDate = response();
    await listVoyageTrips({ query: { date: "2025-02-31" } }, invalidDate, (error) => { throw error; });
    assert.equal(invalidDate.statusCode, 400);
  } finally {
    pool.query = originalQuery;
  }
});

test("Voyage seat can be reserved for payment at the station", async () => {
  const originalConnect = pool.connect;
  const executed = [];
  const connection = {
    async query(sql, params = []) {
      executed.push({ sql, params });
      if (sql.includes("SELECT trip.id, trip.price")) {
        return { rowCount: 1, rows: [{ id: ids.trip, price: "6500", departure_at: new Date(Date.now() + 60_000), seat_id: ids.seat }] };
      }
      if (sql.includes("INSERT INTO voy_tickets")) {
        return { rowCount: 1, rows: [{
          id: params[0], trip_id: params[1], seat_id: params[2], traveler_id: params[3],
          status: params[4], payment_method: params[5], payment_status: params[6], expires_at: params[7],
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => connection;
  try {
    const result = response();
    await bookVoyageSeat({
      params: { id: ids.trip },
      body: { seat_id: ids.seat, payment_method: "PAY_AT_STATION" },
      auth: { userId: ids.traveler },
    }, result, (error) => { throw error; });
    assert.equal(result.statusCode, 201);
    assert.equal(result.payload.ticket.status, "RESERVED");
    assert.equal(result.payload.ticket.payment_status, "PENDING");
    const seatUpdate = executed.find(({ sql }) => sql.includes("UPDATE voy_seats"));
    assert.equal(seatUpdate.params[1], "RESERVED");
  } finally {
    pool.connect = originalConnect;
  }
});

test("Voyage scanner consumes a ticket once and reports a duplicate", async () => {
  const originalConnect = pool.connect;
  const signed = signVoyageTicket({ id: ids.ticket, trip_id: ids.trip, expires_at: new Date(Date.now() + 60_000) });
  let status = "VALID";
  const connection = {
    async query(sql) {
      if (sql.includes("SELECT ticket.id, ticket.trip_id")) return { rowCount: 1, rows: [{
        id: ids.ticket, trip_id: ids.trip, status, expires_at: signed.expires_at,
        signature: signed.signature, kid: signed.kid, traveler_id: ids.traveler,
        seat_number: "4", traveler_name: "Awa Traoré", departure_at: new Date(),
        company_id: ids.company, agent_id: ids.agent, owner_id: "owner",
      }] };
      if (sql.includes("UPDATE voy_tickets SET status = 'USED'")) {
        if (status !== "VALID") return { rowCount: 0, rows: [] };
        status = "USED";
        return { rowCount: 1, rows: [{ id: ids.ticket }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => connection;
  try {
    const request = { auth: { userId: ids.agent }, body: { qr_payload: Buffer.from(JSON.stringify(signed)).toString("base64url") } };
    const first = response();
    await scanVoyage(request, first, (error) => { throw error; });
    assert.equal(first.payload.status, "SUCCESS");
    assert.equal(first.payload.traveler_name, "Awa Traoré");

    const second = response();
    await scanVoyage(request, second, (error) => { throw error; });
    assert.equal(second.payload.status, "ALREADY_USED");
  } finally {
    pool.connect = originalConnect;
  }
});

test("Voyage scanner marks an expired ticket and refuses a different date", async () => {
  const originalConnect = pool.connect;
  const signed = signVoyageTicket({ id: ids.ticket, trip_id: ids.trip, expires_at: new Date(Date.now() - 60_000) });
  let ticketStatus = "VALID";
  const connection = {
    async query(sql) {
      if (sql.includes("SELECT ticket.id, ticket.trip_id")) return { rowCount: 1, rows: [{
        id: ids.ticket, trip_id: ids.trip, status: ticketStatus, expires_at: signed.expires_at,
        signature: signed.signature, kid: signed.kid, traveler_name: "Awa", seat_number: "4",
        company_id: ids.company, agent_id: ids.agent, departure_at: new Date(),
      }] };
      if (sql.includes("SET status = 'EXPIRED'")) ticketStatus = "EXPIRED";
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => connection;
  try {
    const result = response();
    await scanVoyage({ auth: { userId: ids.agent }, body: { qr_payload: Buffer.from(JSON.stringify(signed)).toString("base64url") } }, result, (error) => { throw error; });
    assert.equal(result.payload.status, "EXPIRED");
    assert.equal(ticketStatus, "EXPIRED");
  } finally {
    pool.connect = originalConnect;
  }
});

test("Voyage scanner requires station payment before boarding", async () => {
  const originalConnect = pool.connect;
  const signed = signVoyageTicket({ id: ids.ticket, trip_id: ids.trip, expires_at: new Date(Date.now() + 60_000) });
  const connection = {
    async query(sql) {
      if (sql.includes("SELECT ticket.id, ticket.trip_id")) return { rowCount: 1, rows: [{
        id: ids.ticket, trip_id: ids.trip, status: "RESERVED", expires_at: signed.expires_at,
        signature: signed.signature, kid: signed.kid, traveler_name: "Awa", seat_number: "4",
        company_id: ids.company, agent_id: ids.agent, payment_status: "PENDING",
        company_owner_id: "owner", departure_at: new Date(),
      }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => connection;
  try {
    const result = response();
    await scanVoyage({
      auth: { userId: ids.agent },
      body: { qr_payload: Buffer.from(JSON.stringify(signed)).toString("base64url") },
    }, result, (error) => { throw error; });
    assert.equal(result.payload.status, "PAYMENT_REQUIRED");
    assert.equal(result.payload.ticket_id, ids.ticket);
  } finally {
    pool.connect = originalConnect;
  }
});

test("Voyage agent can confirm a reserved ticket payment in station", async () => {
  const originalConnect = pool.connect;
  const executed = [];
  const connection = {
    async query(sql) {
      executed.push(sql);
      if (sql.includes("SELECT ticket.id, ticket.trip_id, ticket.seat_id")) {
        return { rowCount: 1, rows: [{
          id: ids.ticket, trip_id: ids.trip, seat_id: ids.seat, status: "RESERVED",
          payment_method: "PAY_AT_STATION", payment_status: "PENDING",
          departure_at: new Date(Date.now() + 60_000), company_id: ids.company, agent_id: ids.agent,
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  pool.connect = async () => connection;
  try {
    const result = response();
    await confirmVoyageStationPayment({ params: { id: ids.ticket }, auth: { userId: ids.agent } }, result, (error) => { throw error; });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.status, "PAID");
    assert.ok(executed.some((sql) => sql.includes("payment_status = 'PAID'")));
    assert.ok(executed.some((sql) => sql.includes("UPDATE voy_seats SET status = 'SOLD'")));
  } finally {
    pool.connect = originalConnect;
  }
});

test("Voyage passenger manifest downloads as a PDF for a company agent", async () => {
  const originalQuery = pool.query;
  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) {
      return { rowCount: 1, rows: [{
        company_name: "Cars du Faso", departure: "Ouagadougou", arrival: "Bobo-Dioulasso",
        departure_at: new Date("2030-01-01T08:00:00Z"), vehicle: "Car 1",
      }] };
    }
    return { rowCount: 1, rows: [{
      seat_number: "4", traveler_name: "Awa Traoré", short_code: "ABCD1234",
      status: "VALID", payment_status: "PAID",
    }] };
  };
  try {
    const result = response();
    await downloadVoyagePassengerManifestPdf(
      { params: { id: ids.trip }, auth: { userId: ids.agent } },
      result,
      (error) => { throw error; },
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Content-Type"], "application/pdf");
    assert.match(result.body.toString("ascii"), /^%PDF-1\.4/);
    assert.match(result.body.toString("ascii"), /%%EOF$/);
  } finally {
    pool.query = originalQuery;
  }
});

test("Voyage passenger manifest requires a company owner or agent", async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rowCount: 0, rows: [] });
  try {
    const result = response();
    await listVoyagePassengers({ params: { id: ids.trip }, auth: { userId: ids.traveler } }, result, (error) => { throw error; });
    assert.equal(result.statusCode, 403);
  } finally {
    pool.query = originalQuery;
  }
});