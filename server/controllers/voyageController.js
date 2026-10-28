import { createHash, randomInt, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { makeShortCode, parseVoyageQr, serializeVoyageQr, signVoyageTicket } from "../services/voyageTickets.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && uuidPattern.test(value);
const lastFour = (value) => {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
};
const sendError = (response, status, error, code) =>
  response.status(status).json({ error, ...(code ? { code } : {}) });

const companyForUser = async (userId) => {
  const result = await pool.query(
    `SELECT company.id, agent.id AS agent_id, company.owner_id
     FROM voy_companies company
     LEFT JOIN voy_agents agent ON agent.company_id = company.id
     WHERE company.owner_id = $1 OR agent.user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
};

export const getVoyageConfig = (_request, response) =>
  response.status(200).json({ enabled: env.voyageEnabled });

export const createVoyageCompany = async (request, response, next) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  if (!name || name.length > 160) return sendError(response, 400, "Nom de compagnie invalide.");
  try {
    const saved = await pool.query(
      `INSERT INTO voy_companies
         (owner_id, name, logo_url, rccm_last4, ifu_last4, license_last4)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, owner_id, name, logo_url, rccm_status, ifu_status, license_status`,
      [request.auth.userId, name, request.body.logo_url ?? null, lastFour(request.body.rccm), lastFour(request.body.ifu), lastFour(request.body.license)],
    );
    return response.status(201).json({ company: saved.rows[0] });
  } catch (error) {
    if (error.code === "23505") return sendError(response, 409, "Une compagnie est déjà liée à ce compte.");
    return next(error);
  }
};

export const createVoyageRoute = async (request, response, next) => {
  const departure = typeof request.body?.departure === "string" ? request.body.departure.trim() : "";
  const arrival = typeof request.body?.arrival === "string" ? request.body.arrival.trim() : "";
  if (!departure || !arrival || departure === arrival || departure.length > 160 || arrival.length > 160) {
    return sendError(response, 400, "Départ ou arrivée invalide.");
  }
  try {
    const company = await companyForUser(request.auth.userId);
    if (!company || company.owner_id !== request.auth.userId) return sendError(response, 403, "Droit propriétaire requis.");
    const saved = await pool.query(
      `INSERT INTO voy_routes (company_id, departure, arrival)
       VALUES ($1, $2, $3) RETURNING id, departure, arrival, is_active`,
      [company.id, departure, arrival],
    );
    return response.status(201).json({ route: saved.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const createVoyageTrip = async (request, response, next) => {
  const { route_id: routeId, departure_at: departureAt, arrival_at: arrivalAt, vehicle } = request.body ?? {};
  const seatCount = request.body?.seat_count;
  const price = request.body?.price;
  if (!isUuid(routeId) || !Number.isFinite(Date.parse(departureAt)) || !Number.isFinite(Date.parse(arrivalAt)) || Date.parse(departureAt) <= Date.now() || Date.parse(arrivalAt) <= Date.parse(departureAt) || typeof vehicle !== "string" || !vehicle.trim() || vehicle.length > 120 || !Number.isInteger(seatCount) || seatCount < 1 || seatCount > 500 || !Number.isSafeInteger(price) || price < 0) {
    return sendError(response, 400, "Informations du départ invalides.");
  }
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const owned = await connection.query(
      `SELECT route.id FROM voy_routes route JOIN voy_companies company ON company.id = route.company_id
       WHERE route.id = $1 AND company.owner_id = $2 FOR UPDATE`,
      [routeId, request.auth.userId],
    );
    if (!owned.rowCount) {
      await connection.query("ROLLBACK");
      return sendError(response, 403, "Cette ligne ne vous appartient pas.");
    }
    const trip = await connection.query(
      `INSERT INTO voy_trips (route_id, departure_at, arrival_at, vehicle, seat_count, price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [routeId, new Date(departureAt).toISOString(), new Date(arrivalAt).toISOString(), vehicle.trim(), seatCount, price],
    );
    for (let seatNumber = 1; seatNumber <= seatCount; seatNumber += 1) {
      await connection.query("INSERT INTO voy_seats (trip_id, seat_number) VALUES ($1, $2)", [trip.rows[0].id, String(seatNumber)]);
    }
    await connection.query("COMMIT");
    return response.status(201).json({ trip_id: trip.rows[0].id });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    connection.release();
  }
};

export const listVoyageTrips = async (request, response, next) => {
  const departure = typeof request.query.departure === "string" ? request.query.departure.trim() : "";
  const arrival = typeof request.query.arrival === "string" ? request.query.arrival.trim() : "";
  const date = typeof request.query.date === "string" ? request.query.date : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(response, 400, "Date invalide.");
  try {
    const trips = await pool.query(
      `SELECT trip.id, route.departure, route.arrival, trip.departure_at, trip.arrival_at,
              trip.vehicle, trip.seat_count, trip.price, company.name AS company_name,
              COUNT(seat.id) FILTER (WHERE seat.status = 'AVAILABLE')::int AS seats_available,
              COALESCE(jsonb_agg(
                jsonb_build_object('id', seat.id, 'seat_number', seat.seat_number)
                ORDER BY seat.seat_number
              ) FILTER (WHERE seat.status = 'AVAILABLE'), '[]'::jsonb) AS seats
       FROM voy_trips trip JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       LEFT JOIN voy_seats seat ON seat.trip_id = trip.id
       WHERE route.is_active = TRUE AND trip.departure_at > NOW()
         AND ($1 = '' OR LOWER(route.departure) = LOWER($1))
         AND ($2 = '' OR LOWER(route.arrival) = LOWER($2))
         AND ($3 = '' OR trip.departure_at::date = $3::date)
       GROUP BY trip.id, route.id, company.id ORDER BY trip.departure_at LIMIT 100`,
      [departure, arrival, date],
    );
    return response.status(200).json({ trips: trips.rows });
  } catch (error) {
    return next(error);
  }
};

export const bookVoyageSeat = async (request, response, next) => {
  const tripId = request.params.id;
  const seatId = request.body?.seat_id;
  if (!isUuid(tripId) || !isUuid(seatId)) return sendError(response, 400, "Départ ou siège invalide.");
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const selected = await connection.query(
      `SELECT trip.id, trip.price, trip.departure_at, seat.id AS seat_id
       FROM voy_trips trip JOIN voy_seats seat ON seat.trip_id = trip.id
       WHERE trip.id = $1 AND seat.id = $2 AND seat.status = 'AVAILABLE' FOR UPDATE OF seat`,
      [tripId, seatId],
    );
    const trip = selected.rows[0];
    if (!trip) {
      await connection.query("ROLLBACK");
      return sendError(response, 409, "Cette place n’est plus disponible.");
    }
    if (new Date(trip.departure_at).getTime() <= Date.now()) {
      await connection.query("ROLLBACK");
      return sendError(response, 409, "Ce départ est passé.");
    }
    if (Number(trip.price) > 0) {
      await connection.query("ROLLBACK");
      return sendError(response, 503, "Paiement suspendu : FedaPay n’est pas configuré pour reverser les fonds à la compagnie; aucun paiement n’a été créé.", "SELLER_PAYOUT_UNAVAILABLE");
    }
    const ticketId = randomUUID();
    const code = makeShortCode();
    const inserted = await connection.query(
      `INSERT INTO voy_tickets (id, trip_id, seat_id, traveler_id, expires_at, signature, kid, short_code)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id, trip_id, seat_id, traveler_id, expires_at`,
      [ticketId, tripId, seatId, request.auth.userId, trip.departure_at, env.ticketSigningKid, code],
    );
    const qrPayload = signVoyageTicket(inserted.rows[0]);
    await connection.query("UPDATE voy_tickets SET signature = $2 WHERE id = $1", [ticketId, qrPayload.signature]);
    await connection.query("UPDATE voy_seats SET status = 'SOLD' WHERE id = $1 AND status = 'AVAILABLE'", [seatId]);
    await connection.query("COMMIT");
    return response.status(201).json({ ticket: { ...inserted.rows[0], short_code: code, qr_payload: serializeVoyageQr(qrPayload) }, commission_rate: 0.03, commission_amount: 0 });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    connection.release();
  }
};

export const listVoyageTickets = async (request, response, next) => {
  try {
    const tickets = await pool.query(
      `SELECT ticket.id, ticket.trip_id, ticket.status, ticket.expires_at, ticket.signature,
              ticket.kid, ticket.short_code, seat.seat_number, trip.departure_at,
              trip.arrival_at, trip.price, route.departure, route.arrival,
              company.name AS company_name, traveler.full_name AS traveler_name
       FROM voy_tickets ticket JOIN voy_seats seat ON seat.id = ticket.seat_id
       JOIN voy_trips trip ON trip.id = ticket.trip_id JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       JOIN users traveler ON traveler.id = ticket.traveler_id
       WHERE ticket.traveler_id = $1 ORDER BY trip.departure_at`,
      [request.auth.userId],
    );
    return response.status(200).json({ tickets: tickets.rows.map((ticket) => ({
      ...ticket,
      status: ticket.status === "VALID" && new Date(ticket.expires_at) <= new Date() ? "EXPIRED" : ticket.status,
      qr_payload: serializeVoyageQr({ ticket_id: ticket.id, trip_id: ticket.trip_id, expires_at: ticket.expires_at, kid: ticket.kid, signature: ticket.signature }),
    })) });
  } catch (error) {
    return next(error);
  }
};

export const listVoyagePassengers = async (request, response, next) => {
  if (!isUuid(request.params.id)) return sendError(response, 400, "Départ invalide.");
  try {
    const authorized = await pool.query(
      `SELECT company.id FROM voy_trips trip JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       LEFT JOIN voy_agents agent ON agent.company_id = company.id
       WHERE trip.id = $1 AND (company.owner_id = $2 OR agent.user_id = $2) LIMIT 1`,
      [request.params.id, request.auth.userId],
    );
    if (!authorized.rowCount) return sendError(response, 403, "Droit agent ou propriétaire requis.");
    const passengers = await pool.query(
      `SELECT ticket.id AS ticket_id, ticket.trip_id, ticket.expires_at, ticket.signature,
              ticket.kid, ticket.status, seat.seat_number, traveler.full_name AS traveler_name
       FROM voy_tickets ticket JOIN voy_seats seat ON seat.id = ticket.seat_id
       JOIN users traveler ON traveler.id = ticket.traveler_id
       WHERE ticket.trip_id = $1 ORDER BY seat.seat_number`,
      [request.params.id],
    );
    return response.status(200).json({ passengers: passengers.rows.map((item) => ({
      ...item,
      qr_payload: serializeVoyageQr({ ticket_id: item.ticket_id, trip_id: item.trip_id, expires_at: item.expires_at, kid: item.kid, signature: item.signature }),
    })) });
  } catch (error) {
    return next(error);
  }
};

export const addVoyageAgent = async (request, response, next) => {
  const userId = request.body?.user_id;
  if (!isUuid(userId)) return sendError(response, 400, "Identifiant agent invalide.");
  try {
    const company = await pool.query("SELECT id FROM voy_companies WHERE owner_id = $1", [request.auth.userId]);
    if (!company.rowCount) return sendError(response, 403, "Droit propriétaire requis.");
    const saved = await pool.query("INSERT INTO voy_agents (company_id, user_id) VALUES ($1, $2) RETURNING id, user_id", [company.rows[0].id, userId]);
    return response.status(201).json({ agent: saved.rows[0] });
  } catch (error) {
    if (error.code === "23505") return sendError(response, 409, "Cet utilisateur est déjà lié à une compagnie.");
    return next(error);
  }
};

export const scanVoyage = async (request, response, next) => {
  const payload = typeof request.body?.qr_payload === "string" ? parseVoyageQr(request.body.qr_payload) : null;
  if (!payload || !isUuid(payload.ticket_id) || !isUuid(payload.trip_id)) return response.status(200).json({ status: "INVALID", reason: "QR invalide" });
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const found = await connection.query(
      `SELECT ticket.id, ticket.trip_id, ticket.status, ticket.expires_at, ticket.signature,
              ticket.kid, ticket.traveler_id, seat.seat_number,
              traveler.full_name AS traveler_name, trip.departure_at,
              company.id AS company_id, agent.id AS agent_id, company.owner_id
       FROM voy_tickets ticket JOIN voy_seats seat ON seat.id = ticket.seat_id
       JOIN voy_trips trip ON trip.id = ticket.trip_id JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       JOIN users traveler ON traveler.id = ticket.traveler_id
       LEFT JOIN voy_agents agent ON agent.company_id = company.id AND agent.user_id = $3
       WHERE ticket.id = $1 AND ticket.trip_id = $2 AND (company.owner_id = $3 OR agent.id IS NOT NULL)
       FOR UPDATE OF ticket`,
      [payload.ticket_id, payload.trip_id, request.auth.userId],
    );
    const ticket = found.rows[0];
    if (!ticket) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "INVALID", reason: "autre compagnie" });
    }
    if (payload.signature !== ticket.signature || payload.kid !== ticket.kid || new Date(payload.expires_at).getTime() !== new Date(ticket.expires_at).getTime()) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "INVALID", reason: "signature invalide" });
    }
    if (ticket.status === "USED") {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "ALREADY_USED", reason: "déjà utilisé", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    if (new Date(ticket.expires_at).getTime() <= Date.now()) {
      await connection.query("UPDATE voy_tickets SET status = 'EXPIRED' WHERE id = $1 AND status = 'VALID'", [ticket.id]);
      await connection.query("INSERT INTO voy_scan_logs (company_id, agent_id, ticket_id, action, result) VALUES ($1, $2, $3, 'ticket_boarding', 'EXPIRED')", [ticket.company_id, ticket.agent_id, ticket.id]);
      await connection.query("COMMIT");
      return response.status(200).json({ status: "EXPIRED", reason: "départ expiré", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    if (new Date(ticket.departure_at).toDateString() !== new Date().toDateString()) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "WRONG_DATE", reason: "autre date", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    const updated = await connection.query("UPDATE voy_tickets SET status = 'USED' WHERE id = $1 AND status = 'VALID' AND expires_at > NOW() RETURNING id", [ticket.id]);
    if (!updated.rowCount) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "ALREADY_USED", reason: "déjà utilisé", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    await connection.query("INSERT INTO voy_scan_logs (company_id, agent_id, ticket_id, action, result) VALUES ($1, $2, $3, 'ticket_boarding', 'USED')", [ticket.company_id, ticket.agent_id, ticket.id]);
    await connection.query("COMMIT");
    return response.status(200).json({ status: "SUCCESS", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    connection.release();
  }
};

export const createVoyageParcel = async (request, response, next) => {
  const { trip_id: tripId, declared_contents: contents, weight_kg: weight, recipient_name: recipientName, recipient_phone: recipientPhone } = request.body ?? {};
  const phoneLast4 = lastFour(recipientPhone);
  if (!isUuid(tripId) || typeof contents !== "string" || !contents.trim() || contents.length > 300 || !Number.isFinite(weight) || weight <= 0 || typeof recipientName !== "string" || !recipientName.trim() || recipientName.length > 160 || !phoneLast4) {
    return sendError(response, 400, "Informations du colis invalides.");
  }
  try {
    const company = await pool.query("SELECT company.id FROM voy_trips trip JOIN voy_routes route ON route.id = trip.route_id JOIN voy_companies company ON company.id = route.company_id WHERE trip.id = $1", [tripId]);
    if (!company.rowCount) return sendError(response, 404, "Départ introuvable.");
    const pickupCode = String(randomInt(10000000, 99999999));
    const saved = await pool.query(
      `INSERT INTO voy_parcels (company_id, trip_id, sender_id, declared_contents, weight_kg, recipient_name, recipient_phone_last4, pickup_code_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, trip_id, status, created_at`,
      [company.rows[0].id, tripId, request.auth.userId, contents.trim(), weight, recipientName.trim(), phoneLast4, createHash("sha256").update(pickupCode).digest("hex")],
    );
    return response.status(201).json({ parcel: saved.rows[0], pickup_code: pickupCode, qr_payload: serializeVoyageQr({ parcel_id: saved.rows[0].id, trip_id: tripId, kind: "parcel" }) });
  } catch (error) {
    return next(error);
  }
};