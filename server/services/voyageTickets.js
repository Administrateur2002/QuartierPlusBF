import { createHash, createPrivateKey, randomBytes, sign, verify } from "node:crypto";
import { env } from "../config/env.js";

const canonicalPayload = ({ ticket_id, trip_id, expires_at, kid }) =>
  `${ticket_id}.${trip_id}.${new Date(expires_at).toISOString()}.${kid}`;

const getPrivateKey = () => {
  try {
    const pem = Buffer.from(env.ticketSigningPrivateKeyB64, "base64").toString("utf8");
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong key type");
    return key;
  } catch {
    const error = new Error("TICKET_SIGNING_PRIVATE_KEY_B64 doit contenir une clé privée Ed25519 PEM valide.");
    error.status = 503;
    throw error;
  }
};

export const signVoyageTicket = (ticket) => {
  const payload = {
    ticket_id: ticket.id,
    trip_id: ticket.trip_id,
    expires_at: new Date(ticket.expires_at).toISOString(),
    kid: env.ticketSigningKid,
  };
  const signature = sign(null, Buffer.from(canonicalPayload(payload)), getPrivateKey()).toString("base64url");
  return { ...payload, signature };
};

export const verifyVoyageTicket = (payload, publicKeyPem) => {
  if (!payload || typeof payload.signature !== "string") return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalPayload(payload)),
      publicKeyPem,
      Buffer.from(payload.signature, "base64url"),
    );
  } catch {
    return false;
  }
};

export const makeShortCode = () =>
  createHash("sha256").update(randomBytes(24)).digest("hex").slice(0, 8).toUpperCase();

export const serializeVoyageQr = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");

export const parseVoyageQr = (value) => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.ticket_id !== "string" ||
      typeof parsed.trip_id !== "string" ||
      typeof parsed.expires_at !== "string" ||
      typeof parsed.kid !== "string" ||
      typeof parsed.signature !== "string"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};