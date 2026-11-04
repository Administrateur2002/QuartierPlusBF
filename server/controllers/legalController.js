import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

const DOCUMENT_TITLES = Object.freeze({
  terms: "Conditions générales d’utilisation",
  privacy: "Politique de confidentialité",
  golden_rules: "Règles d’or",
  pro_terms: "Conditions Pro",
  sos_safety: "Conditions SOS et sécurité",
  automated_moderation: "Information sur la modération automatisée",
});

export const getLegalDocuments = (_request, response) => {
  response.set("Cache-Control", "no-store");
  return response.status(200).json({
    documents: Object.entries(env.legalDocumentVersions).map(
      ([id, version]) => ({ id, title: DOCUMENT_TITLES[id], version }),
    ),
  });
};

export const getMyLegalAcceptances = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT document_id, version, accepted_at, app_version
       FROM legal_document_acceptances
       WHERE user_id = $1
       ORDER BY accepted_at DESC`,
      [request.auth.userId],
    );
    const latestByDocument = new Map();
    for (const acceptance of result.rows) {
      if (!latestByDocument.has(acceptance.document_id)) {
        latestByDocument.set(acceptance.document_id, acceptance);
      }
    }
    response.set("Cache-Control", "no-store");
    return response.status(200).json({
      documents: Object.entries(env.legalDocumentVersions).map(
        ([id, version]) => {
          const acceptance = latestByDocument.get(id);
          return {
            id,
            title: DOCUMENT_TITLES[id],
            version,
            accepted_version: acceptance?.version ?? null,
            accepted_at: acceptance?.accepted_at ?? null,
          };
        },
      ),
    });
  } catch (error) {
    return next(error);
  }
};

export const acceptLegalDocuments = async (request, response, next) => {
  const { acceptances, age_16_or_older: ageConfirmed, app_version: appVersion } =
    request.body ?? {};
  const requiredIds = Object.keys(env.legalDocumentVersions).sort();
  if (
    ageConfirmed !== true ||
    typeof appVersion !== "string" ||
    !/^[0-9A-Za-z.+_-]{1,40}$/.test(appVersion) ||
    !Array.isArray(acceptances)
  ) {
    return response.status(400).json({
      error: "Confirmez l’âge minimum et l’acceptation de tous les documents.",
    });
  }

  const submitted = new Map();
  for (const item of acceptances) {
    if (
      !item ||
      typeof item.document_id !== "string" ||
      typeof item.version !== "string" ||
      submitted.has(item.document_id)
    ) {
      return response.status(400).json({ error: "Liste de consentements invalide." });
    }
    submitted.set(item.document_id, item.version);
  }
  if (
    submitted.size !== requiredIds.length ||
    requiredIds.some(
      (id) => submitted.get(id) !== env.legalDocumentVersions[id],
    )
  ) {
    return response.status(409).json({
      error: "Les documents ont changé. Actualisez-les avant de les accepter.",
      code: "LEGAL_VERSION_CHANGED",
    });
  }

  try {
    await pool.query(
      `INSERT INTO legal_document_acceptances
         (user_id, document_id, version, app_version, age_16_or_older)
       SELECT $1, item.document_id, item.version, $3, $4
       FROM jsonb_to_recordset($2::jsonb)
         AS item(document_id text, version text)
       ON CONFLICT (user_id, document_id, version) DO NOTHING`,
      [
        request.auth.userId,
        JSON.stringify(
          [...submitted].map(([document_id, version]) => ({
            document_id,
            version,
          })),
        ),
        appVersion,
        ageConfirmed,
      ],
    );
    return response.status(201).json({ accepted: true });
  } catch (error) {
    return next(error);
  }
};
