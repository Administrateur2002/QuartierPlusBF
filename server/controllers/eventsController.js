import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { createFedaPayTransaction } from "../services/fedapay.js";
import {
  isValidTicketSignature,
  issueTicket,
} from "../services/tickets.service.js";

const validCoordinates = (latitude, longitude) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 &&
  Math.abs(longitude) <= 180;

const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const readEventInput = (body) => {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  const locationName =
    typeof body?.location_name === "string" ? body.location_name.trim() : "";
  const eventDate = Date.parse(body?.event_date);
  const ticketPrice = body?.ticket_price;
  const totalCapacity = body?.total_capacity;
  const hasCoordinates =
    body?.latitude !== undefined || body?.longitude !== undefined;
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  if (
    !title ||
    title.length > 200 ||
    description.length > 10_000 ||
    !locationName ||
    locationName.length > 200 ||
    !Number.isFinite(eventDate) ||
    eventDate <= Date.now() ||
    !Number.isSafeInteger(ticketPrice) ||
    ticketPrice < 0 ||
    !Number.isSafeInteger(totalCapacity) ||
    totalCapacity < 1 ||
    totalCapacity > 1_000_000 ||
    (hasCoordinates && !validCoordinates(latitude, longitude))
  ) {
    return null;
  }
  return {
    title,
    description,
    locationName,
    eventDate: new Date(eventDate).toISOString(),
    ticketPrice,
    totalCapacity,
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
  };
};

const eventSelect = `SELECT e.id, e.organizer_id, e.title, e.description,
                            e.location_name, e.event_date, e.ticket_price,
                            e.total_capacity, e.tickets_sold, e.is_published,
                            ST_Y(e.location_coords::geometry) AS latitude,
                            ST_X(e.location_coords::geometry) AS longitude
                     FROM events e`;

export const listEvents = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `${eventSelect}
       WHERE e.is_published = TRUE AND e.event_date > NOW()
       ORDER BY e.event_date
       LIMIT 100`,
    );
    return response.status(200).json({ events: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listOrganizerEvents = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.title, e.location_name, e.event_date, e.total_capacity,
              e.tickets_sold, e.is_published,
              COUNT(t.id) FILTER (WHERE t.status = 'USED')::int AS checked_in_count
       FROM events e
       LEFT JOIN tickets t ON t.event_id = e.id
       WHERE e.organizer_id = $1
       GROUP BY e.id
       ORDER BY e.event_date DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ events: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getEvent = async (request, response, next) => {
  if (!isUuid(request.params.id)) {
    return response.status(400).json({ error: "Identifiant d'événement invalide." });
  }
  try {
    const result = await pool.query(
      `${eventSelect}
       WHERE e.id = $1 AND (e.is_published = TRUE OR e.organizer_id = $2)`,
      [request.params.id, request.auth?.userId ?? null],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Événement introuvable." });
    }
    return response.status(200).json({ event: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const createEvent = async (request, response, next) => {
  const event = readEventInput(request.body);
  if (!event) {
    return response.status(400).json({ error: "Les informations de l'événement sont invalides." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO events
         (organizer_id, title, description, location_name, location_coords,
          event_date, ticket_price, total_capacity, is_published)
       VALUES (
         $1, $2, $3, $4,
         CASE WHEN $5::double precision IS NULL THEN NULL
              ELSE ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography END,
         $7, $8, $9, TRUE
       )
       RETURNING id, organizer_id, title, description, location_name, event_date,
                 ticket_price, total_capacity, tickets_sold, is_published`,
      [
        request.auth.userId,
        event.title,
        event.description,
        event.locationName,
        event.latitude,
        event.longitude,
        event.eventDate,
        event.ticketPrice,
        event.totalCapacity,
      ],
    );
    return response.status(201).json({ event: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

const normalizePhone = (phone, prefix) => {
  let normalized = phone?.replace(/\D/g, "") ?? "";
  const nationalPrefix = prefix?.replace(/\D/g, "") ?? "";
  if (nationalPrefix && normalized.startsWith(nationalPrefix)) {
    normalized = normalized.slice(nationalPrefix.length);
  }
  return normalized;
};

const customerFromUser = (user) => {
  const phoneNumber = normalizePhone(user.phone_number, user.phone_prefix);
  if (!phoneNumber || !user.country_code || !user.phone_prefix) {
    return null;
  }
  return {
    firstname: user.full_name?.trim().split(/\s+/)[0] || "Utilisateur",
    lastname:
      user.full_name?.trim().split(/\s+/).slice(1).join(" ") || "QuartierPlus",
    phone_number: {
      number: Number(phoneNumber),
      country: user.country_code,
    },
    ...(user.email ? { email: user.email } : {}),
  };
};

export const buyEventTicket = async (request, response, next) => {
  const eventId = request.params.id;
  const userId = request.auth.userId;
  if (!isUuid(eventId)) {
    return response.status(400).json({ error: "Identifiant d'événement invalide." });
  }
  const connection = await pool.connect();
  let reservation;
  let event;
  try {
    await connection.query("BEGIN");
    const eventResult = await connection.query(
      `SELECT id, title, event_date, ticket_price, total_capacity, tickets_sold
       FROM events WHERE id = $1 AND is_published = TRUE FOR UPDATE`,
      [eventId],
    );
    event = eventResult.rows[0];
    if (!event) {
      await connection.query("ROLLBACK");
      return response.status(404).json({ error: "Événement introuvable." });
    }
    const existingTicket = await connection.query(
      `SELECT id, event_id, user_id, qr_code_signature, status, purchased_at
       FROM tickets
       WHERE event_id = $1 AND user_id = $2 AND status = 'VALID'
       LIMIT 1`,
      [eventId, userId],
    );
    if (existingTicket.rowCount) {
      await connection.query("COMMIT");
      const ticket = existingTicket.rows[0];
      return response.status(200).json({
        ticket: { ...ticket, qr_payload: `${ticket.id}.${ticket.qr_code_signature}` },
        already_owned: true,
      });
    }
    if (new Date(event.event_date).getTime() <= Date.now()) {
      await connection.query("ROLLBACK");
      return response.status(409).json({ error: "La billetterie de cet événement est fermée." });
    }
    const ownPending = await connection.query(
      `SELECT id FROM event_ticket_reservations
       WHERE event_id = $1 AND user_id = $2 AND status = 'PENDING'
       LIMIT 1`,
      [eventId, userId],
    );
    if (ownPending.rowCount) {
      await connection.query("ROLLBACK");
      return response.status(409).json({
        error: "Un paiement de billet est déjà en cours pour cet événement.",
      });
    }
    const pendingReservations = await connection.query(
      `SELECT COUNT(*)::int AS count FROM event_ticket_reservations
       WHERE event_id = $1 AND status = 'PENDING'`,
      [eventId],
    );
    if (
      Number(event.tickets_sold) + Number(pendingReservations.rows[0].count) >=
      Number(event.total_capacity)
    ) {
      await connection.query("ROLLBACK");
      return response.status(409).json({ error: "Cet événement affiche complet." });
    }
    if (Number(event.ticket_price) === 0) {
      const ticket = await issueTicket(connection, eventId, userId);
      await connection.query("COMMIT");
      return response.status(201).json({
        ticket: { ...ticket, qr_payload: `${ticket.id}.${ticket.qr_code_signature}` },
      });
    }

    const reserved = await connection.query(
      `INSERT INTO event_ticket_reservations (event_id, user_id)
       VALUES ($1, $2)
       RETURNING id`,
      [eventId, userId],
    );
    reservation = reserved.rows[0];
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK").catch((rollbackError) => {
      console.error("Failed to roll back ticket purchase:", rollbackError);
    });
    return next(error);
  } finally {
    if (connection) connection.release();
  }

  try {
    const userResult = await pool.query(
      `SELECT u.full_name, u.email, u.phone_number, u.country_code, c.phone_prefix
       FROM users u LEFT JOIN country_config c ON c.code = u.country_code
       WHERE u.id = $1`,
      [userId],
    );
    const user = userResult.rows[0];
    const customer = user && customerFromUser(user);
    if (!customer) {
      await pool.query(
        "UPDATE event_ticket_reservations SET status = 'CANCELLED' WHERE id = $1",
        [reservation.id],
      );
      return response.status(400).json({
        error: "Un numéro de téléphone vérifié et son pays sont requis pour payer.",
      });
    }
    const { transaction, paymentUrl } = await createFedaPayTransaction({
      amount: Number(event.ticket_price),
      description: `Billet - ${event.title}`,
      customer,
    });
    const saved = await pool.connect();
    let localTransaction;
    try {
      await saved.query("BEGIN");
      const transactionResult = await saved.query(
        `INSERT INTO transactions
           (user_id, fedapay_tx_id, amount, currency, payment_type, metadata)
         VALUES ($1, $2, $3, 'XOF', 'TICKET', $4)
         RETURNING id, status`,
        [
          userId,
          String(transaction.id),
          Number(event.ticket_price),
          JSON.stringify({
            event_id: eventId,
            reservation_id: reservation.id,
          }),
        ],
      );
      localTransaction = transactionResult.rows[0];
      const linkedReservation = await saved.query(
        `UPDATE event_ticket_reservations
         SET transaction_id = $1
         WHERE id = $2 AND status = 'PENDING'
         RETURNING id`,
        [localTransaction.id, reservation.id],
      );
      if (!linkedReservation.rowCount) {
        throw new Error("La réservation du billet n'est plus disponible.");
      }
      await saved.query("COMMIT");
    } catch (saveError) {
      await saved.query("ROLLBACK").catch((rollbackError) =>
        console.error("Failed to roll back ticket transaction:", rollbackError),
      );
      throw saveError;
    } finally {
      saved.release();
    }
    return response.status(201).json({
      status: localTransaction.status,
      payment_url: paymentUrl,
      transaction_id: localTransaction.id,
    });
  } catch (error) {
    await pool.query(
      "UPDATE event_ticket_reservations SET status = 'CANCELLED' WHERE id = $1 AND status = 'PENDING'",
      [reservation.id],
    );
    return next(error);
  }
};

export const getMonetizationConfig = (_request, response) =>
  response.status(200).json({
    is_promo_free_access: env.isPromoFreeAccess,
    promo_banner: env.isPromoFreeAccess
      ? "🎉 Période découverte : Fonctionnalité offerte !"
      : null,
  });

export const listMyTickets = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.event_id, t.qr_code_signature, t.status,
              t.purchased_at, t.scanned_at, e.title AS event_title,
              e.location_name, e.event_date,
              ticket_owner.profile_photo_url AS ticket_owner_photo_url,
              ticket_owner.badge AS ticket_owner_badge
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       JOIN users ticket_owner ON ticket_owner.id = t.user_id
       WHERE t.user_id = $1
       ORDER BY e.event_date, t.purchased_at DESC
       LIMIT 200`,
      [request.auth.userId],
    );
    return response.status(200).json({
      tickets: result.rows.map((ticket) => ({
        ...ticket,
        qr_payload: `${ticket.id}.${ticket.qr_code_signature}`,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

export const scanTicket = async (request, response, next) => {
  const eventId = request.body?.event_id;
  const qrPayload =
    typeof request.body?.qr_payload === "string"
      ? request.body.qr_payload
      : `${request.body?.ticket_id ?? ""}.${request.body?.signature ?? ""}`;
  const [ticketId, signature, extra] = qrPayload.split(".");
  if (
    extra !== undefined ||
    !isUuid(ticketId) ||
    (eventId !== undefined && !isUuid(eventId))
  ) {
    return response.status(200).json({ status: "INVALID_TICKET" });
  }

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await connection.query(
      `SELECT t.id, t.event_id, t.user_id, t.status, t.qr_code_signature
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.id = $1 AND e.organizer_id = $2
         AND ($3::uuid IS NULL OR e.id = $3)
       FOR UPDATE OF t`,
      [ticketId, request.auth.userId, eventId ?? null],
    );
    const ticket = result.rows[0];
    if (!ticket || !isValidTicketSignature(ticket.id, ticket.user_id, signature)) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "INVALID_TICKET" });
    }
    if (ticket.qr_code_signature !== signature || ticket.status === "CANCELLED") {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "INVALID_TICKET" });
    }
    if (ticket.status === "USED") {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "ALREADY_USED" });
    }
    const updated = await connection.query(
      `UPDATE tickets SET status = 'USED', scanned_at = NOW()
       WHERE id = $1 AND status = 'VALID'
       RETURNING id, scanned_at`,
      [ticketId],
    );
    if (!updated.rowCount) {
      await connection.query("ROLLBACK");
      return response.status(200).json({ status: "ALREADY_USED" });
    }
    const entryCount = await connection.query(
      `SELECT COUNT(*)::int AS checked_in_count, e.total_capacity, e.title
       FROM events e
       LEFT JOIN tickets t ON t.event_id = e.id AND t.status = 'USED'
       WHERE e.id = $1 AND e.organizer_id = $2
       GROUP BY e.id`,
      [ticket.event_id, request.auth.userId],
    );
    await connection.query("COMMIT");
    return response.status(200).json({
      status: "SUCCESS",
      ticket_id: updated.rows[0].id,
      scanned_at: updated.rows[0].scanned_at,
      checked_in_count: entryCount.rows[0]?.checked_in_count ?? 0,
      total_capacity: entryCount.rows[0]?.total_capacity ?? 0,
      event_title: entryCount.rows[0]?.title ?? "",
    });
  } catch (error) {
    await connection.query("ROLLBACK");
    return next(error);
  } finally {
    connection.release();
  }
};
