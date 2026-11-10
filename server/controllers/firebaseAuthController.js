import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { verifyFirebaseIdToken } from "../services/firebaseAdmin.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

const issueToken = (user, provider) =>
  jwt.sign({ auth_method: `firebase_${provider}` }, env.jwtSecret, {
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

const registrationDetails = (body) => {
  const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
  const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
  if (
    firstName.length > 100 ||
    lastName.length > 100 ||
    `${firstName} ${lastName}`.trim().length > 100
  ) {
    return { error: "Le prénom et le nom ne doivent pas dépasser 100 caractères." };
  }
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim() || null,
  };
};

const pendingEmailResponse = (response) =>
  response.status(202).json({ email_verification_required: true });

export const createFirebaseAuthController = ({
  verifyToken = verifyFirebaseIdToken,
  database = pool,
} = {}) => async (request, response, next) => {
  const idToken = typeof request.body?.id_token === "string" ? request.body.id_token : "";
  if (!idToken || idToken.length > 16_384) {
    return response.status(400).json({ error: "Jeton Firebase manquant ou invalide." });
  }

  let identity;
  try {
    identity = await verifyToken(idToken);
  } catch (error) {
    if (error?.code === "FIREBASE_PROJECT_ID_MISSING" ||
        error?.code === "FIREBASE_CREDENTIALS_INVALID" ||
        error?.code === "FIREBASE_PROJECT_MISMATCH") {
      return response.status(503).json({
        error: "La vérification Firebase n’est pas configurée sur le serveur.",
        code: error.code,
      });
    }
    return response.status(401).json({ error: "Jeton Firebase invalide ou expiré." });
  }

  const provider = identity.firebase?.sign_in_provider;
  const supportedProviders = new Set(["google.com", "password", "phone"]);
  const uid = identity.uid;
  if (!uid || !supportedProviders.has(provider)) {
    return response.status(401).json({ error: "Ce fournisseur Firebase n’est pas autorisé." });
  }

  const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : null;
  const emailVerified = identity.email_verified === true;
  const phoneNumber = typeof identity.phone_number === "string" ? identity.phone_number : null;
  const validPhone = phoneNumber && E164_PATTERN.test(phoneNumber) ? phoneNumber : null;
  const googleId = typeof identity.firebase?.identities?.["google.com"]?.[0] === "string"
    ? identity.firebase.identities["google.com"][0]
    : null;
  if (email && !EMAIL_PATTERN.test(email)) {
    return response.status(401).json({ error: "L’adresse e-mail du compte Firebase est invalide." });
  }
  if (provider === "phone" && !validPhone) {
    return response.status(401).json({ error: "Firebase n’a pas confirmé un numéro international valide." });
  }
  const registration = registrationDetails(request.body ?? {});
  if (registration.error) return response.status(400).json({ error: registration.error });

  const requiresEmailVerification = provider === "password" && Boolean(email) && !emailVerified;
  const requiresRegistrationConsent =
    request.body?.terms_accepted !== true || request.body?.age_16_or_older !== true;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const matches = await client.query(
      `SELECT id, firebase_uid, google_id, phone_number, phone_e164, email,
              full_name, first_name, last_name, role, neighborhood, country_code,
              reputation_score, is_verified, phone_verified_at
       FROM users
       WHERE firebase_uid = $1
          OR ($2::text IS NOT NULL AND google_id = $2)
          OR ($3::text IS NOT NULL AND LOWER(email) = $3)
          OR ($4::text IS NOT NULL AND (
                phone_e164 = $4 OR
                regexp_replace(COALESCE(phone_e164, phone_number), '[^0-9]', '', 'g') = regexp_replace($4, '[^0-9]', '', 'g')
             ))
       FOR UPDATE`,
      [uid, googleId, email, validPhone],
    );
    const distinctUsers = new Map(matches.rows.map((user) => [user.id, user]));
    if (distinctUsers.size > 1) {
      await client.query("ROLLBACK");
      return response.status(409).json({
        error: "Ces identifiants correspondent à plusieurs comptes. Contactez l’assistance pour les associer sans perdre vos données.",
        code: "AUTH_ACCOUNT_LINK_CONFLICT",
      });
    }

    let user = [...distinctUsers.values()][0] ?? null;
    if (requiresEmailVerification) {
      if (!user && !requiresRegistrationConsent) {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "Acceptez les conditions et confirmez l’âge minimum pour créer un compte.",
          code: "AUTH_REGISTRATION_CONSENT_REQUIRED",
        });
      }
      if (!user) {
        const inserted = await client.query(
          `INSERT INTO users
             (firebase_uid, email, full_name, first_name, last_name, is_verified,
              terms_accepted_at)
           VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), FALSE,
                   CASE WHEN $6 THEN NOW() END)
           RETURNING id`,
          [uid, email, registration.fullName, registration.firstName, registration.lastName,
            request.body.terms_accepted === true && request.body.age_16_or_older === true],
        );
        user = { id: inserted.rows[0].id };
      }
      await client.query("COMMIT");
      return pendingEmailResponse(response);
    }

    if (!user && requiresRegistrationConsent) {
      await client.query("ROLLBACK");
      return response.status(400).json({
        error: "Acceptez les conditions et confirmez l’âge minimum pour créer un compte.",
        code: "AUTH_REGISTRATION_CONSENT_REQUIRED",
      });
    }

    const fullName =
      registration.fullName ??
      (typeof identity.name === "string" && identity.name.trim() ? identity.name.trim() : null);
    const commonValues = [
      uid,
      googleId,
      email,
      validPhone,
      fullName,
      registration.firstName,
      registration.lastName,
      emailVerified,
      Boolean(validPhone),
      request.body.terms_accepted === true && request.body.age_16_or_older === true,
    ];
    const saved = user
      ? await client.query(
          `UPDATE users
           SET firebase_uid = COALESCE(firebase_uid, $1),
               google_id = COALESCE(google_id, $2),
               email = CASE WHEN $8 THEN COALESCE($3, email) ELSE email END,
               email_verified_at = CASE WHEN $8 THEN COALESCE(email_verified_at, NOW()) ELSE email_verified_at END,
               phone_number = COALESCE(phone_number, $4),
               phone_e164 = COALESCE(phone_e164, $4),
               phone_verified_at = CASE WHEN $9 THEN COALESCE(phone_verified_at, NOW()) ELSE phone_verified_at END,
               full_name = COALESCE(full_name, $5),
               first_name = COALESCE(first_name, NULLIF($6, '')),
               last_name = COALESCE(last_name, NULLIF($7, '')),
               is_verified = CASE WHEN $8 OR $9 THEN TRUE ELSE is_verified END,
               terms_accepted_at = CASE WHEN $10 THEN COALESCE(terms_accepted_at, NOW()) ELSE terms_accepted_at END
           WHERE id = $11
           RETURNING id, phone_number, email, google_id, full_name, role,
                     neighborhood, country_code, reputation_score, is_verified,
                     phone_verified_at`,
          [...commonValues, user.id],
        )
      : await client.query(
          `INSERT INTO users
             (firebase_uid, google_id, email, phone_number, phone_e164, full_name,
              first_name, last_name, is_verified, phone_verified_at,
              email_verified_at, terms_accepted_at)
           VALUES ($1, $2, $3, $4, $4, $5, NULLIF($6, ''), NULLIF($7, ''),
                   ($8 OR $9), CASE WHEN $9 THEN NOW() END,
                   CASE WHEN $8 THEN NOW() END,
                   CASE WHEN $10 THEN NOW() END)
           RETURNING id, phone_number, email, google_id, full_name, role,
                     neighborhood, country_code, reputation_score, is_verified,
                     phone_verified_at`,
          commonValues,
        );
    user = saved.rows[0];
    await client.query("COMMIT");
    return response.status(200).json({
      token: issueToken(user, provider.replace(/[^a-z0-9_]/gi, "_")),
      user: userProfile(user),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return response.status(409).json({
        error: "Un fournisseur ou une coordonnée de connexion est déjà associé à un autre compte.",
        code: "AUTH_ACCOUNT_LINK_CONFLICT",
      });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const firebaseAuth = createFirebaseAuthController();