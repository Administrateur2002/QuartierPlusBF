import { createHash, randomInt, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { makeShortCode, parseVoyageQr, serializeVoyageQr, signVoyageTicket } from "../services/voyageTickets.js";
import { normalizePhoneNumberE164 } from "../services/phoneNumber.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && uuidPattern.test(value);
const VOYAGE_CITIES = [
  "Banfora",
  "Bobo-Dioulasso",
  "Dédougou",
  "Fada N’Gourma",
  "Gaoua",
  "Kaya",
  "Koudougou",
  "Ouagadougou",
  "Ouahigouya",
  "Tenkodogo",
];
const normalizeCity = (city) =>
  city.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr");
const isVoyageCity = (city) =>
  typeof city === "string" &&
  VOYAGE_CITIES.some((knownCity) => normalizeCity(knownCity) === normalizeCity(city));
const lastFour = (value) => {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
};
const sendError = (response, status, error, code) =>
  response.status(status).json({ error, ...(code ? { code } : {}) });

const pdfEscape = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/([\\()])/g, "\\$1");

const createManifestPdf = (lines) => {
  const pages = [];
  for (let index = 0; index < lines.length; index += 42) pages.push(lines.slice(index, index + 42));
  if (!pages.length) pages.push([]);
  const objects = new Map();
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects.set(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((pageLines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const commands = ["BT", "/F1 10 Tf", "50 790 Td", "14 TL"];
    pageLines.forEach((line) => commands.push(`(${pdfEscape(line)}) Tj`, "T*"));
    commands.push("ET");
    const stream = commands.join("\n");
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.size + 1; id += 1) {
    offsets.push(Buffer.byteLength(document));
    document += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(document, "ascii");
};

const companyForUser = async (userId) => {
  const result = await pool.query(
    `SELECT id, owner_id FROM voy_companies WHERE owner_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
};

export const getVoyageConfig = (_request, response) =>
  response.status(200).json({
    enabled: env.voyageEnabled,
    demo_data_enabled: env.voyageDemoData,
  });

export const createVoyageCompany = async (request, response, next) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  if (!name || name.length > 160) return sendError(response, 400, "Nom de compagnie invalide.");
  const logoUrl = request.body?.logo_url;
  if (logoUrl !== undefined && logoUrl !== null && logoUrl !== "") {
    try {
      if (new URL(logoUrl).protocol !== "https:") throw new Error("invalid protocol");
    } catch {
      return sendError(response, 400, "Le logo doit être une URL HTTPS valide.");
    }
  }
  try {
    const saved = await pool.query(
      `INSERT INTO voy_companies
         (owner_id, name, logo_url, rccm_last4, ifu_last4, license_last4)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, owner_id, name, logo_url, rccm_status, ifu_status, license_status`,
      [request.auth.userId, name, logoUrl || null, lastFour(request.body.rccm), lastFour(request.body.ifu), lastFour(request.body.license)],
    );
    return response.status(201).json({ company: saved.rows[0] });
  } catch (error) {
    if (error.code === "23505") return sendError(response, 409, "Une compagnie est déjà liée à ce compte.");
    return next(error);
  }
};

export const getMyVoyageCompany = async (request, response, next) => {
  try {
    const companyResult = await pool.query(
      `SELECT company.id, company.owner_id, company.name, company.logo_url,
              company.rccm_status, company.ifu_status, company.license_status,
              owner.profile_photo_url AS owner_photo_url,
              owner.badge AS owner_badge
       FROM voy_companies company
       JOIN users owner ON owner.id = company.owner_id
       WHERE company.owner_id = $1`,
      [request.auth.userId],
    );
    const company = companyResult.rows[0] ?? null;
    if (!company) return response.status(200).json({ company: null, routes: [], trips: [] });
    const [routesResult, tripsResult] = await Promise.all([
      pool.query(
        `SELECT id, departure, arrival, is_active FROM voy_routes
         WHERE company_id = $1 ORDER BY created_at`,
        [company.id],
      ),
      pool.query(
        `SELECT trip.id, trip.route_id, route.departure, route.arrival,
                trip.departure_at, trip.arrival_at, trip.vehicle, trip.price,
                trip.seat_count,
                COUNT(seat.id) FILTER (WHERE seat.status = 'AVAILABLE')::int AS seats_available,
                COUNT(ticket.id) FILTER (WHERE ticket.payment_status = 'PAID')::int AS tickets_sold,
                COUNT(ticket.id) FILTER (WHERE ticket.payment_status = 'PENDING')::int AS tickets_pending,
                COALESCE(SUM(trip.price) FILTER (WHERE ticket.payment_status = 'PAID'), 0)::numeric AS sales_total
         FROM voy_trips trip
         JOIN voy_routes route ON route.id = trip.route_id
         LEFT JOIN voy_seats seat ON seat.trip_id = trip.id
         LEFT JOIN voy_tickets ticket ON ticket.seat_id = seat.id
         WHERE route.company_id = $1
         GROUP BY trip.id, route.id ORDER BY trip.departure_at DESC`,
        [company.id],
      ),
    ]);
    return response.status(200).json({
      company,
      routes: routesResult.rows,
      trips: tripsResult.rows,
    });
  } catch (error) {
    return next(error);
  }
};

export const createVoyageRoute = async (request, response, next) => {
  const departure = typeof request.body?.departure === "string" ? request.body.departure.trim() : "";
  const arrival = typeof request.body?.arrival === "string" ? request.body.arrival.trim() : "";
  if (!isVoyageCity(departure) || !isVoyageCity(arrival) || normalizeCity(departure) === normalizeCity(arrival)) {
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
  if (
    (departure && !isVoyageCity(departure)) ||
    (arrival && !isVoyageCity(arrival)) ||
    (departure && arrival && normalizeCity(departure) === normalizeCity(arrival))
  ) {
    return sendError(response, 400, "Ville de départ ou d’arrivée invalide.");
  }
  if (date) {
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00.000Z`)
      : null;
    if (
      !parsedDate ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      return sendError(response, 400, "Date invalide.");
    }
  }
  try {
    const trips = await pool.query(
      `SELECT trip.id, route.departure, route.arrival, trip.departure_at, trip.arrival_at,
              trip.vehicle, trip.seat_count, trip.price, company.name AS company_name,
              company.logo_url AS company_logo_url,
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
  if (
    request.body?.payment_method !== undefined &&
    request.body.payment_method !== "ONLINE" &&
    request.body.payment_method !== "PAY_AT_STATION"
  ) {
    return sendError(response, 400, "Mode de paiement invalide.");
  }
  const payAtStation = request.body?.payment_method === "PAY_AT_STATION";
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
      if (!payAtStation) {
        await connection.query("ROLLBACK");
        return sendError(response, 503, "Paiement suspendu : FedaPay n’est pas configuré pour reverser les fonds à la compagnie; aucun paiement n’a été créé.", "SELLER_PAYOUT_UNAVAILABLE");
      }
    }
    const ticketId = randomUUID();
    const code = makeShortCode();
    const inserted = await connection.query(
      `INSERT INTO voy_tickets
         (id, trip_id, seat_id, traveler_id, status, payment_method, payment_status, expires_at, signature, kid, short_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
       RETURNING id, trip_id, seat_id, traveler_id, status, payment_method, payment_status, expires_at`,
      [
        ticketId,
        tripId,
        seatId,
        request.auth.userId,
        payAtStation && Number(trip.price) > 0 ? "RESERVED" : "VALID",
        payAtStation && Number(trip.price) > 0 ? "PAY_AT_STATION" : Number(trip.price) > 0 ? "ONLINE" : "FREE",
        payAtStation && Number(trip.price) > 0 ? "PENDING" : "PAID",
        trip.departure_at,
        env.ticketSigningKid,
        code,
      ],
    );
    const qrPayload = signVoyageTicket(inserted.rows[0]);
    await connection.query("UPDATE voy_tickets SET signature = $2 WHERE id = $1", [ticketId, qrPayload.signature]);
    await connection.query(
      "UPDATE voy_seats SET status = $2 WHERE id = $1 AND status = 'AVAILABLE'",
      [seatId, payAtStation && Number(trip.price) > 0 ? "RESERVED" : "SOLD"],
    );
    await connection.query("COMMIT");
    return response.status(201).json({
      ticket: { ...inserted.rows[0], short_code: code, qr_payload: serializeVoyageQr(qrPayload) },
      commission_rate: 0.03,
      commission_amount: 0,
    });
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
              ticket.kid, ticket.short_code, ticket.payment_method, ticket.payment_status,
              seat.seat_number, trip.departure_at,
              trip.arrival_at, trip.price, route.departure, route.arrival,
              company.name AS company_name, traveler.full_name AS traveler_name,
              traveler.profile_photo_url AS traveler_photo_url,
              traveler.badge AS traveler_badge
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
       JOIN subscriptions subscription ON subscription.user_id = company.owner_id
         AND subscription.plan_type = 'TRANSPORT_COMPANY' AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW() AND subscription.expires_at > NOW()
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

export const downloadVoyagePassengerManifestPdf = async (request, response, next) => {
  if (!isUuid(request.params.id)) return sendError(response, 400, "Départ invalide.");
  try {
    const trip = await pool.query(
      `SELECT company.name AS company_name, route.departure, route.arrival,
              trip.departure_at, trip.vehicle
       FROM voy_trips trip
       JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       LEFT JOIN voy_agents agent ON agent.company_id = company.id
       JOIN subscriptions subscription ON subscription.user_id = company.owner_id
         AND subscription.plan_type = 'TRANSPORT_COMPANY' AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW() AND subscription.expires_at > NOW()
       WHERE trip.id = $1 AND (company.owner_id = $2 OR agent.user_id = $2)
       LIMIT 1`,
      [request.params.id, request.auth.userId],
    );
    if (!trip.rowCount) return sendError(response, 403, "Droit agent ou propriétaire requis.");
    const passengers = await pool.query(
      `SELECT seat.seat_number, traveler.full_name AS traveler_name,
              ticket.short_code, ticket.status, ticket.payment_status
       FROM voy_tickets ticket
       JOIN voy_seats seat ON seat.id = ticket.seat_id
       JOIN users traveler ON traveler.id = ticket.traveler_id
       WHERE ticket.trip_id = $1 AND ticket.status <> 'CANCELLED'
       ORDER BY seat.seat_number`,
      [request.params.id],
    );
    const departureAt = new Date(trip.rows[0].departure_at).toLocaleString("fr-FR");
    const lines = [
      `Manifeste passagers - ${trip.rows[0].company_name}`,
      `${trip.rows[0].departure} vers ${trip.rows[0].arrival}`,
      `Depart: ${departureAt} | Vehicule: ${trip.rows[0].vehicle}`,
      "",
      "Siege | Passager | Billet | Statut | Paiement",
      ...passengers.rows.map((passenger) =>
        `${passenger.seat_number} | ${passenger.traveler_name} | ${passenger.short_code} | ${passenger.status} | ${passenger.payment_status}`,
      ),
    ];
    const filename = `passagers-${trip.rows[0].departure}-${trip.rows[0].arrival}.pdf`
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "-");
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return response.status(200).send(createManifestPdf(lines));
  } catch (error) {
    return next(error);
  }
};

export const addVoyageAgent = async (request, response, next) => {
  let userId = request.body?.user_id;
  if (!userId && typeof request.body?.phone_number === "string") {
    const phoneNumber = normalizePhoneNumberE164(request.body.phone_number);
    if (!phoneNumber) return sendError(response, 400, "Numéro de téléphone invalide.");
    try {
      const user = await pool.query(
        "SELECT id FROM users WHERE phone_e164 = $1 OR phone_number = $1 LIMIT 1",
        [phoneNumber],
      );
      userId = user.rows[0]?.id;
      if (!userId) return sendError(response, 404, "Aucun compte QuartierPlus ne correspond à ce numéro.");
    } catch (error) {
      return next(error);
    }
  }
  if (!isUuid(userId)) return sendError(response, 400, "Identifiant agent ou numéro invalide.");
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

export const getMyVoyageAgentTrips = async (request, response, next) => {
  try {
    const trips = await pool.query(
      `SELECT trip.id, route.departure, route.arrival, trip.departure_at,
              trip.vehicle, company.name AS company_name, company.logo_url AS company_logo_url
       FROM voy_agents agent
       JOIN voy_companies company ON company.id = agent.company_id
       JOIN subscriptions subscription ON subscription.user_id = company.owner_id
         AND subscription.plan_type = 'TRANSPORT_COMPANY' AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW() AND subscription.expires_at > NOW()
       JOIN voy_routes route ON route.company_id = company.id AND route.is_active = TRUE
       JOIN voy_trips trip ON trip.route_id = route.id AND trip.departure_at > NOW()
       WHERE agent.user_id = $1
       ORDER BY trip.departure_at LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ trips: trips.rows });
  } catch (error) {
    return next(error);
  }
};

export const confirmVoyageStationPayment = async (request, response, next) => {
  const ticketId = request.params.id;
  if (!isUuid(ticketId)) return sendError(response, 400, "Billet invalide.");
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const selected = await connection.query(
      `SELECT ticket.id, ticket.trip_id, ticket.seat_id, ticket.status,
              ticket.payment_method, ticket.payment_status, trip.departure_at,
              company.id AS company_id, company.owner_id, agent.id AS agent_id
       FROM voy_tickets ticket
       JOIN voy_trips trip ON trip.id = ticket.trip_id
       JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       LEFT JOIN voy_agents agent ON agent.company_id = company.id AND agent.user_id = $2
       JOIN subscriptions subscription ON subscription.user_id = company.owner_id
         AND subscription.plan_type = 'TRANSPORT_COMPANY' AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW() AND subscription.expires_at > NOW()
       WHERE ticket.id = $1 AND (company.owner_id = $2 OR agent.id IS NOT NULL)
       FOR UPDATE OF ticket`,
      [ticketId, request.auth.userId],
    );
    const ticket = selected.rows[0];
    if (!ticket) {
      await connection.query("ROLLBACK");
      return sendError(response, 404, "Billet introuvable pour cette compagnie.");
    }
    if (ticket.payment_method !== "PAY_AT_STATION" || ticket.status !== "RESERVED" || ticket.payment_status !== "PENDING") {
      await connection.query("ROLLBACK");
      return sendError(response, 409, "Ce billet n’attend pas un paiement en gare.");
    }
    if (new Date(ticket.departure_at).getTime() <= Date.now()) {
      await connection.query("ROLLBACK");
      return sendError(response, 409, "Ce départ est passé.");
    }
    await connection.query(
      "UPDATE voy_tickets SET payment_status = 'PAID', status = 'VALID' WHERE id = $1",
      [ticketId],
    );
    await connection.query(
      "UPDATE voy_seats SET status = 'SOLD' WHERE id = $1 AND status = 'RESERVED'",
      [ticket.seat_id],
    );
    await connection.query(
      "INSERT INTO voy_scan_logs (company_id, agent_id, ticket_id, action, result) VALUES ($1, $2, $3, 'station_payment', 'PAID')",
      [ticket.company_id, ticket.agent_id, ticketId],
    );
    await connection.query("COMMIT");
    return response.status(200).json({ status: "PAID", ticket_id: ticketId });
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    connection.release();
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
              company.id AS company_id, agent.id AS agent_id, company.owner_id,
              ticket.payment_method, ticket.payment_status
       FROM voy_tickets ticket JOIN voy_seats seat ON seat.id = ticket.seat_id
       JOIN voy_trips trip ON trip.id = ticket.trip_id JOIN voy_routes route ON route.id = trip.route_id
       JOIN voy_companies company ON company.id = route.company_id
       JOIN users traveler ON traveler.id = ticket.traveler_id
       LEFT JOIN voy_agents agent ON agent.company_id = company.id AND agent.user_id = $3
       JOIN subscriptions subscription ON subscription.user_id = company.owner_id
         AND subscription.plan_type = 'TRANSPORT_COMPANY' AND subscription.status = 'ACTIVE'
         AND subscription.starts_at <= NOW() AND subscription.expires_at > NOW()
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
      await connection.query("UPDATE voy_tickets SET status = 'EXPIRED' WHERE id = $1 AND status IN ('VALID', 'RESERVED')", [ticket.id]);
      await connection.query("INSERT INTO voy_scan_logs (company_id, agent_id, ticket_id, action, result) VALUES ($1, $2, $3, 'ticket_boarding', 'EXPIRED')", [ticket.company_id, ticket.agent_id, ticket.id]);
      await connection.query("COMMIT");
      return response.status(200).json({ status: "EXPIRED", reason: "départ expiré", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    if (new Date(ticket.departure_at).toDateString() !== new Date().toDateString()) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "WRONG_DATE", reason: "autre date", traveler_name: ticket.traveler_name, seat_number: ticket.seat_number });
    }
    if (ticket.status === "RESERVED" && ticket.payment_status === "PENDING") {
      await connection.query("ROLLBACK");
      return response.status(200).json({
        status: "PAYMENT_REQUIRED",
        reason: "Confirmez le paiement en gare avant l’embarquement.",
        ticket_id: ticket.id,
        traveler_name: ticket.traveler_name,
        seat_number: ticket.seat_number,
      });
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