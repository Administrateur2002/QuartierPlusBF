import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import { isOtpTestPhone } from "../config/otp.js";
import { pool } from "../db/pool.js";
import { reserveDailySms } from "../services/usageLimits.js";
import { deliverVerificationEmail, isEmailDeliveryConfigured } from "../services/email.js";
import {
  detectPhoneCountry,
  normalizePhoneNumberE164,
} from "../services/phoneNumber.js";

const googleClient = new OAuth2Client(env.googleClientId || undefined);
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_CHANNELS = new Set(["sms", "email"]);

const hashOtp = (phoneNumber, code) =>
  createHmac("sha256", env.jwtSecret)
    .update(`${phoneNumber}:${code}`)
    .digest("hex");

const issueToken = (user, authMethod) =>
  jwt.sign({ auth_method: authMethod }, env.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: env.jwtExpiresIn,
  });

const userProfile = (user) => ({
  id: user.id,
  phone_number: user.phone_number,
  email: user.email,
  google_id: user.google_id,
  name: user.full_name,
  neighborhood: user.neighborhood,
  role: user.role,
  country_code: user.country_code,
  reputation_score: user.reputation_score,
  is_verified: user.is_verified,
  phone_verified_at: user.phone_verified_at,
});

const deliverOtp = async (phoneNumber, code) => {
  if (!(await reserveDailySms())) {
    throw Object.assign(
      new Error("La limite quotidienne de SMS est atteinte. Réessayez demain."),
      {
        status: 429,
        code: "SMS_DAILY_LIMIT_REACHED",
        reason: "La limite quotidienne de SMS est atteinte.",
      },
    );
  }
  if (!env.smsDeliveryUrl || !env.smsDeliveryToken) {
    throw new Error("Le service SMS n'est pas configuré.");
  }
  const response = await fetch(env.smsDeliveryUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.smsDeliveryToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: phoneNumber,
      message: `Votre code de vérification QuartierPlus est ${code}. Il expire dans ${OTP_TTL_MINUTES} minutes.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Échec de livraison SMS (${response.status}).`);
  }
};

const detectCountryCode = async (client, phoneNumber) => {
  const result = await client.query(
    `SELECT country_code AS code
     FROM country_phone_prefixes
     WHERE $1 LIKE phone_prefix || '%'
     ORDER BY length(phone_prefix) DESC, country_code
     LIMIT 1`,
    [phoneNumber],
  );
  return result.rows[0]?.code ?? null;
};

export const listCountries = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT code, name, phone_prefix
       FROM country_config
       WHERE is_active = TRUE
       ORDER BY name, code`,
    );
    return response.status(200).json({ countries: result.rows });
  } catch (error) {
    return next(error);
  }
};

const googleVerificationFailure = (error) => {
  const invalidCredential = error?.response?.status === 400;
  const code = invalidCredential
    ? "GOOGLE_TOKEN_INVALID"
    : "GOOGLE_VERIFICATION_FAILED";
  const message = invalidCredential
    ? "Google a refusé le jeton d'identité."
    : "Google n'a pas pu vérifier le jeton.";
  return Object.assign(new Error(message), {
    status: invalidCredential ? 401 : 502,
    code,
    reason: `${message} Vérifiez EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, GOOGLE_CLIENT_ID et les clients OAuth autorisés (code ${code}).`,
  });
};

export const requestOtp = async (request, response, next) => {
  const flow = request.body?.flow === "register" ? "register" : "login";
  const channel =
    typeof request.query?.channel === "string"
      ? request.query.channel
      : request.body?.channel ?? "sms";
  if (!OTP_CHANNELS.has(channel)) {
    return response.status(400).json({ error: "Canal de vérification invalide." });
  }
  let phoneNumber = "";
  let recipientEmail = "";
  let registrationData = null;

  if (flow === "register") {
    const firstName =
      typeof request.body?.first_name === "string"
        ? request.body.first_name.trim()
        : "";
    const lastName =
      typeof request.body?.last_name === "string"
        ? request.body.last_name.trim()
        : "";
    const email =
      typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
    const enteredPhone =
      typeof request.body?.phone_number === "string"
        ? request.body.phone_number.trim()
        : "";
    phoneNumber = normalizePhoneNumberE164(enteredPhone) ?? "";
    const requestedCountryCode =
      typeof request.body?.country_code === "string"
        ? request.body.country_code.trim().toUpperCase()
        : "";
    const countryCode = detectPhoneCountry(phoneNumber) ?? requestedCountryCode;

    if (
      !firstName ||
      !lastName ||
      firstName.length > 100 ||
      lastName.length > 100 ||
      `${firstName} ${lastName}`.length > 100
    ) {
      return response.status(400).json({
        error: "Saisissez un prénom et un nom valides (100 caractères maximum).",
      });
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 255) {
      return response.status(400).json({ error: "Saisissez une adresse e-mail valide." });
    }
    if (!phoneNumber) {
      return response.status(400).json({
        error: "Saisissez un numéro international valide, avec son indicatif.",
      });
    }
    if (request.body?.terms_accepted !== true) {
      return response.status(400).json({
        error: "Vous devez accepter les conditions d’utilisation et la politique de confidentialité.",
      });
    }
    if (request.body?.age_16_or_older !== true) {
      return response.status(400).json({
        error: "La création d’un compte est réservée aux personnes âgées d’au moins 16 ans.",
      });
    }

    try {
      const country = await pool.query(
        "SELECT code, phone_prefix FROM country_config WHERE code = $1",
        [countryCode],
      );
      if (
        country.rowCount === 0 ||
        !phoneNumber.startsWith(country.rows[0].phone_prefix)
      ) {
        return response.status(400).json({
          error: "Le numéro ne correspond pas au pays indiqué.",
        });
      }
      const existingAccount = await pool.query(
        `SELECT 1 FROM users
         WHERE phone_number = $1 OR phone_e164 = $1 OR LOWER(email) = $2
         LIMIT 1`,
        [phoneNumber, email],
      );
      if (existingAccount.rowCount > 0) {
        return response.status(409).json({
          error: "Un compte utilise déjà ce téléphone ou cette adresse e-mail. Connectez-vous.",
        });
      }
    } catch (error) {
      return next(error);
    }

    registrationData = {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`,
      email,
      country_code: countryCode,
    };
    recipientEmail = email;
  } else {
    const identifier =
      typeof request.body?.identifier === "string"
        ? request.body.identifier.trim()
        : typeof request.body?.phone_number === "string"
          ? request.body.phone_number.trim()
          : "";
    const normalizedPhone = normalizePhoneNumberE164(identifier);
    if (normalizedPhone) {
      phoneNumber = normalizedPhone;
      try {
        const account = await pool.query(
          `SELECT phone_number, phone_e164, email FROM users
            WHERE (regexp_replace(COALESCE(phone_e164, phone_number), '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
              OR regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g'))
             AND (is_verified = TRUE OR phone_verified_at IS NOT NULL OR email_verified_at IS NOT NULL)
           LIMIT 1`,
          [phoneNumber],
        );
        if (account.rowCount === 0) {
          return response.status(404).json({
            error: "Aucun compte vérifié ne correspond. Choisissez « Créer un compte ».",
          });
        }
        phoneNumber =
          normalizePhoneNumberE164(
            account.rows[0].phone_e164 ?? account.rows[0].phone_number,
          ) ?? phoneNumber;
        recipientEmail = account.rows[0].email ?? "";
      } catch (error) {
        return next(error);
      }
    } else if (EMAIL_PATTERN.test(identifier)) {
      try {
        const account = await pool.query(
          `SELECT phone_number, phone_e164, email FROM users
           WHERE LOWER(email) = $1
             AND COALESCE(phone_e164, phone_number) IS NOT NULL
             AND (is_verified = TRUE OR phone_verified_at IS NOT NULL OR email_verified_at IS NOT NULL)
           LIMIT 1`,
          [identifier.toLowerCase()],
        );
        if (account.rowCount === 0) {
          return response.status(404).json({
            error: "Aucun compte vérifié ne correspond. Choisissez « Créer un compte ».",
          });
        }
        phoneNumber =
          normalizePhoneNumberE164(
            account.rows[0].phone_e164 ?? account.rows[0].phone_number,
          ) ?? "";
        recipientEmail = account.rows[0].email ?? identifier.toLowerCase();
      } catch (error) {
        return next(error);
      }
    } else {
      return response.status(400).json({
        error: "Saisissez un téléphone avec indicatif ou une adresse e-mail valide.",
      });
    }
    if (!E164_PATTERN.test(phoneNumber)) {
      return response.status(400).json({
        error: "Ce compte ne possède pas de téléphone valide pour recevoir le code.",
      });
    }
  }

  const useTestOtp = isOtpTestPhone(phoneNumber, env);
  if (!useTestOtp && channel === "sms" && (!env.smsDeliveryUrl || !env.smsDeliveryToken)) {
    return response.status(503).json({ error: "Le service SMS est indisponible." });
  }
  if (!useTestOtp && channel === "email" && !isEmailDeliveryConfigured(env)) {
    return response.status(503).json({
      error: "L'envoi par e-mail n'est pas encore configuré, choisissez SMS.",
    });
  }
  if (channel === "email" && !recipientEmail) {
    return response.status(400).json({
      error: "Aucune adresse e-mail n’est associée à ce compte.",
    });
  }

  const code = useTestOtp
    ? "123456"
    : String(randomInt(0, 1_000_000)).padStart(6, "0");
  const client = await pool.connect();
  let otpStored = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [phoneNumber],
    );
    const recentRequest = await client.query(
      `SELECT 1
       FROM otp_verifications
       WHERE phone_number = $1
         AND created_at > NOW() - INTERVAL '60 seconds'
       FOR UPDATE`,
      [phoneNumber],
    );
    if (recentRequest.rowCount > 0) {
      await client.query("ROLLBACK");
      return response.status(429).json({
        error: "Un code a déjà été demandé récemment. Réessayez dans une minute.",
      });
    }
    await client.query(
      `INSERT INTO otp_verifications
         (phone_number, code_hash, expires_at, attempts, created_at, registration_data, channel)
       VALUES ($1, $2, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes', 0, NOW(), $3::jsonb, $4)
       ON CONFLICT (phone_number) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         created_at = NOW(),
         registration_data = EXCLUDED.registration_data,
         channel = EXCLUDED.channel`,
      [
        phoneNumber,
        hashOtp(phoneNumber, code),
        JSON.stringify(registrationData),
        channel,
      ],
    );
    await client.query("COMMIT");
    otpStored = true;
    if (!useTestOtp) {
      if (channel === "sms") await deliverOtp(phoneNumber, code);
      else await deliverVerificationEmail(env, recipientEmail, code, OTP_TTL_MINUTES);
    }
    return response.status(200).json({
      message: `Un code de vérification a été envoyé par ${channel === "sms" ? "SMS" : "e-mail"}.`,
      ...(channel === "email" ? { challenge_identifier: recipientEmail } : {}),
      ...(useTestOtp ? { test_code: "123456" } : {}),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await pool
      .query("DELETE FROM otp_verifications WHERE phone_number = $1", [
        phoneNumber,
      ])
      .catch((cleanupError) => {
        console.error("Failed to remove undelivered OTP:", cleanupError);
      });
    if (otpStored && !useTestOtp) {
      return response.status(503).json({
        error: `La livraison du code par ${channel === "sms" ? "SMS" : "e-mail"} a échoué. Réessayez plus tard.`,
      });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const requestPhoneChangeOtp = async (request, response, next) => {
  const phoneNumber =
    typeof request.body?.phone_number === "string"
      ? request.body.phone_number.trim()
      : "";
  if (!E164_PATTERN.test(phoneNumber)) {
    return response.status(400).json({
      error: "Le numéro de téléphone doit être au format international E.164.",
    });
  }
  const useTestOtp = isOtpTestPhone(phoneNumber, env);
  if (!useTestOtp && (!env.smsDeliveryUrl || !env.smsDeliveryToken)) {
    return response.status(503).json({ error: "Le service SMS est indisponible." });
  }

  const code = useTestOtp
    ? "123456"
    : String(randomInt(0, 1_000_000)).padStart(6, "0");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [phoneNumber],
    );
    const owner = await client.query(
      "SELECT id FROM users WHERE phone_number = $1 FOR UPDATE",
      [phoneNumber],
    );
    if (owner.rowCount > 0 && owner.rows[0].id !== request.auth.userId) {
      await client.query("ROLLBACK");
      return response.status(409).json({
        error: "Ce numéro est déjà associé à un autre compte.",
      });
    }
    const recentRequest = await client.query(
      `SELECT 1 FROM otp_verifications
       WHERE phone_number = $1
         AND created_at > NOW() - INTERVAL '60 seconds'
       FOR UPDATE`,
      [phoneNumber],
    );
    if (recentRequest.rowCount > 0) {
      await client.query("ROLLBACK");
      return response.status(429).json({
        error: "Un code a déjà été demandé récemment. Réessayez dans une minute.",
      });
    }
    await client.query(
      `INSERT INTO otp_verifications
         (phone_number, code_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '${OTP_TTL_MINUTES} minutes', 0, NOW())
       ON CONFLICT (phone_number) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         created_at = NOW()`,
      [phoneNumber, hashOtp(phoneNumber, code)],
    );
    await client.query("COMMIT");
    if (!useTestOtp) await deliverOtp(phoneNumber, code);
    return response.status(200).json({
      message: "Un code de vérification a été envoyé.",
      ...(useTestOtp ? { test_code: "123456" } : {}),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await pool
      .query("DELETE FROM otp_verifications WHERE phone_number = $1", [
        phoneNumber,
      ])
      .catch((cleanupError) => {
        console.error("Failed to remove undelivered phone-change OTP:", cleanupError);
      });
    return next(error);
  } finally {
    client.release();
  }
};

export const verifyPhoneChangeOtp = async (request, response, next) => {
  const phoneNumber =
    typeof request.body?.phone_number === "string"
      ? request.body.phone_number.trim()
      : "";
  const code = typeof request.body?.code === "string" ? request.body.code : "";
  if (!E164_PATTERN.test(phoneNumber) || !/^\d{6}$/.test(code)) {
    return response.status(400).json({ error: "Numéro ou code invalide." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const verification = await client.query(
      `SELECT code_hash, attempts
       FROM otp_verifications
       WHERE phone_number = $1 AND expires_at > NOW()
       FOR UPDATE`,
      [phoneNumber],
    );
    const entry = verification.rows[0];
    if (!entry || entry.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query("ROLLBACK");
      return response.status(401).json({ error: "Code invalide ou expiré." });
    }
    const expectedHash = Buffer.from(entry.code_hash, "hex");
    const actualHash = Buffer.from(hashOtp(phoneNumber, code), "hex");
    if (
      expectedHash.length !== actualHash.length ||
      !timingSafeEqual(expectedHash, actualHash)
    ) {
      await client.query(
        `UPDATE otp_verifications
         SET attempts = attempts + 1
         WHERE phone_number = $1`,
        [phoneNumber],
      );
      await client.query("COMMIT");
      return response.status(401).json({ error: "Code invalide ou expiré." });
    }

    const owner = await client.query(
      "SELECT id FROM users WHERE phone_number = $1 FOR UPDATE",
      [phoneNumber],
    );
    if (owner.rowCount > 0 && owner.rows[0].id !== request.auth.userId) {
      await client.query("ROLLBACK");
      return response.status(409).json({
        error: "Ce numéro est déjà associé à un autre compte.",
      });
    }
    const updated = await client.query(
      `UPDATE users SET phone_number = $1, is_verified = TRUE
       WHERE id = $2
       RETURNING id, phone_number`,
      [phoneNumber, request.auth.userId],
    );
    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Utilisateur introuvable." });
    }
    await client.query(
      "DELETE FROM otp_verifications WHERE phone_number = $1",
      [phoneNumber],
    );
    await client.query("COMMIT");
    return response.status(200).json({
      phone_number: updated.rows[0].phone_number,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return response.status(409).json({
        error: "Ce numéro est déjà associé à un autre compte.",
      });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const verifyOtp = async (request, response, next) => {
  const suppliedIdentifier =
    typeof request.body?.identifier === "string"
      ? request.body.identifier.trim()
      : typeof request.body?.phone_number === "string"
        ? request.body.phone_number.trim()
        : "";
  const phoneIdentifier = normalizePhoneNumberE164(suppliedIdentifier);
  const identifier = phoneIdentifier ?? suppliedIdentifier.toLowerCase();
  const channel = request.body?.channel ?? "sms";
  const code = typeof request.body?.code === "string" ? request.body.code : "";
  if (
    (!phoneIdentifier && !EMAIL_PATTERN.test(identifier)) ||
    !OTP_CHANNELS.has(channel) ||
    !/^\d{6}$/.test(code)
  ) {
    return response.status(400).json({ error: "Identifiant ou code invalide." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let phoneNumber = phoneIdentifier ?? "";
    if (!phoneIdentifier) {
      const account = await client.query(
        `SELECT COALESCE(phone_e164, phone_number) AS phone_number FROM users
         WHERE LOWER(email) = $1 AND COALESCE(phone_e164, phone_number) IS NOT NULL
         FOR UPDATE`,
        [identifier],
      );
      if (account.rowCount > 0) {
        phoneNumber =
          normalizePhoneNumberE164(account.rows[0].phone_number) ?? "";
      } else {
        const pendingRegistration = await client.query(
          `SELECT phone_number FROM otp_verifications
           WHERE LOWER(registration_data->>'email') = $1
             AND channel = 'email' AND expires_at > NOW()
           FOR UPDATE`,
          [identifier],
        );
        phoneNumber = pendingRegistration.rows[0]?.phone_number ?? "";
      }
      if (!phoneNumber) {
        await client.query("ROLLBACK");
        return response.status(401).json({ error: "Code invalide ou expiré." });
      }
    }
    const verification = await client.query(
      `SELECT code_hash, attempts, registration_data, channel
       FROM otp_verifications
       WHERE phone_number = $1 AND expires_at > NOW()
       FOR UPDATE`,
      [phoneNumber],
    );
    const entry = verification.rows[0];
    if (
      !entry ||
      entry.attempts >= OTP_MAX_ATTEMPTS ||
      (entry.channel ?? "sms") !== channel
    ) {
      await client.query("ROLLBACK");
      return response.status(401).json({ error: "Code invalide ou expiré." });
    }

    const candidateHash = hashOtp(phoneNumber, code);
    const expectedHash = Buffer.from(entry.code_hash, "hex");
    const actualHash = Buffer.from(candidateHash, "hex");
    if (
      expectedHash.length !== actualHash.length ||
      !timingSafeEqual(expectedHash, actualHash)
    ) {
      await client.query(
        `UPDATE otp_verifications
         SET attempts = attempts + 1
         WHERE phone_number = $1`,
        [phoneNumber],
      );
      await client.query("COMMIT");
      return response.status(401).json({ error: "Code invalide ou expiré." });
    }

    let result;
    if (entry.registration_data) {
      const registration = entry.registration_data;
      result = await client.query(
        `INSERT INTO users
           (phone_number, phone_e164, email, full_name, first_name, last_name,
            country_code, is_verified, phone_verified_at, email_verified_at, terms_accepted_at)
         VALUES ($1, $1, $2, $3, $4, $5, $6, TRUE,
                 CASE WHEN $7 = 'sms' THEN NOW() END,
                 CASE WHEN $7 = 'email' THEN NOW() END, NOW())
         RETURNING id, phone_number, email, google_id, full_name, role,
                   neighborhood, country_code, reputation_score, is_verified,
                   phone_verified_at`,
        [
          phoneNumber,
          registration.email,
          registration.full_name,
          registration.first_name,
          registration.last_name,
          registration.country_code,
          channel,
        ],
      );
    } else {
      result = await client.query(
        `UPDATE users
         SET phone_number = $1,
             phone_e164 = $1,
             is_verified = TRUE,
             phone_verified_at = CASE WHEN $3 = 'sms'
               THEN COALESCE(phone_verified_at, NOW()) ELSE phone_verified_at END,
             email_verified_at = CASE WHEN $3 = 'email'
               THEN COALESCE(email_verified_at, NOW()) ELSE email_verified_at END,
             country_code = COALESCE(country_code, $2)
         WHERE (regexp_replace(COALESCE(phone_e164, phone_number), '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
            OR regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g'))
           AND is_verified = TRUE
         RETURNING id, phone_number, email, google_id, full_name, role,
                   neighborhood, country_code, reputation_score, is_verified,
                   phone_verified_at`,
        [phoneNumber, await detectCountryCode(client, phoneNumber), channel],
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return response.status(401).json({ error: "Code invalide ou expiré." });
      }
    }
    await client.query(
      "DELETE FROM otp_verifications WHERE phone_number = $1",
      [phoneNumber],
    );
    await client.query("COMMIT");
    const user = result.rows[0];
    return response.status(200).json({
      token: issueToken(user, channel === "sms" ? "sms_otp" : "email_otp"),
      user: userProfile(user),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return response.status(409).json({
        error: "Un compte utilise déjà ce téléphone ou cette adresse e-mail. Connectez-vous.",
      });
    }
    return next(error);
  } finally {
    client.release();
  }
};

const verifyGoogleCredential = async (credential, tokenType) => {
  if (env.googleClientIds.length === 0) {
    throw Object.assign(new Error("La connexion Google n'est pas configurée."), {
      status: 503,
      code: "GOOGLE_CLIENT_ID_MISSING",
      reason: "GOOGLE_CLIENT_ID et GOOGLE_CLIENT_IDS sont absents (code GOOGLE_CLIENT_ID_MISSING).",
    });
  }
  if (tokenType !== "access_token" && credential.split(".").length === 3) {
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: env.googleClientIds,
      });
    } catch (error) {
      throw googleVerificationFailure(error);
    }
    const payload = ticket.getPayload();
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true
    ) {
      throw Object.assign(new Error("Le profil Google ne contient pas un e-mail vérifié."), {
        status: 401,
        code: "GOOGLE_PROFILE_INCOMPLETE",
        reason: "Google n'a pas fourni un identifiant et un e-mail vérifié (code GOOGLE_PROFILE_INCOMPLETE).",
      });
    }
    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name ?? null,
    };
  }

  let tokenInfo;
  try {
    tokenInfo = await googleClient.getTokenInfo(credential);
  } catch (error) {
    throw googleVerificationFailure(error);
  }
  if (!env.googleClientIds.includes(tokenInfo.aud)) {
    throw Object.assign(new Error("Jeton Google invalide."), {
      status: 401,
      code: "GOOGLE_AUDIENCE_MISMATCH",
      reason: "L'audience du jeton ne correspond pas à GOOGLE_CLIENT_ID/GOOGLE_CLIENT_IDS (code GOOGLE_AUDIENCE_MISMATCH).",
    });
  }
  const userInfoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${credential}` } },
  );
  if (!userInfoResponse.ok) {
    throw Object.assign(new Error("Jeton Google invalide."), {
      status: 401,
      code: "GOOGLE_USERINFO_REJECTED",
      reason: `L'API Google UserInfo a répondu HTTP ${userInfoResponse.status} (code GOOGLE_USERINFO_REJECTED).`,
    });
  }
  const userInfo = await userInfoResponse.json();
  if (
    typeof userInfo.sub !== "string" ||
    typeof userInfo.email !== "string" ||
    userInfo.email_verified !== true
  ) {
    throw Object.assign(new Error("Jeton Google invalide."), {
      status: 401,
      code: "GOOGLE_PROFILE_INCOMPLETE",
      reason: "Google UserInfo n'a pas renvoyé un identifiant et un e-mail vérifié (code GOOGLE_PROFILE_INCOMPLETE).",
    });
  }
  return {
    googleId: userInfo.sub,
    email: userInfo.email.toLowerCase(),
    name: typeof userInfo.name === "string" ? userInfo.name : null,
  };
};

export const googleAuth = async (request, response, next) => {
  const credential =
    typeof request.body?.credential === "string"
      ? request.body.credential
      : typeof request.body?.id_token === "string"
        ? request.body.id_token
        : typeof request.body?.access_token === "string"
          ? request.body.access_token
          : "";
  const credentialType =
    typeof request.body?.id_token === "string"
      ? "id_token"
      : typeof request.body?.access_token === "string"
        ? "access_token"
        : undefined;
  if (!credential || credential.length > 8192) {
    return response.status(400).json({
      error: "Jeton Google manquant ou invalide.",
      code: "GOOGLE_CREDENTIAL_INVALID",
      reason: "Aucun jeton Google valide n'a été reçu (code GOOGLE_CREDENTIAL_INVALID).",
    });
  }

  try {
    const identity = await verifyGoogleCredential(credential, credentialType);
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT id, google_id
         FROM users
         WHERE google_id = $1 OR LOWER(email) = $2
         FOR UPDATE`,
        [identity.googleId, identity.email],
      );
      if (existing.rows.length > 1) {
        throw Object.assign(
          new Error("Les identifiants Google correspondent à plusieurs comptes."),
          { status: 409 },
        );
      }
      const result =
        existing.rows.length === 1
          ? await client.query(
              `UPDATE users
               SET google_id = $1,
                   email = $2,
                   email_verified_at = COALESCE(email_verified_at, NOW()),
                   full_name = COALESCE($3, full_name),
                   is_verified = TRUE
               WHERE id = $4
               RETURNING id, phone_number, email, google_id, full_name, role,
                         neighborhood, country_code, reputation_score, is_verified,
                         phone_verified_at`,
              [
                identity.googleId,
                identity.email,
                identity.name,
                existing.rows[0].id,
              ],
            )
          : await client.query(
              `INSERT INTO users (
                 google_id, email, email_verified_at, full_name, is_verified
               )
               VALUES ($1, $2, NOW(), $3, TRUE)
               RETURNING id, phone_number, email, google_id, full_name, role,
                         neighborhood, country_code, reputation_score, is_verified,
                         phone_verified_at`,
              [identity.googleId, identity.email, identity.name],
            );
      user = result.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return response.status(200).json({
      token: issueToken(user, "google_oauth"),
      user: userProfile(user),
    });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({
        error: "Cette adresse e-mail est déjà associée à un autre compte.",
      });
    }
    return next(error);
  }
};
