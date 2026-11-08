import { pool } from "../db/pool.js";
import { verifyMessageMedia } from "../services/messageMedia.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA_SCOPES = new Set(["neighborhood", "commune", "region"]);
const CHANNEL_SCOPES = new Set([
  "nearby",
  "neighborhood",
  "commune",
  "region",
  "country",
  "international",
]);
const INSTITUTION_TYPES = new Set([
  "MUNICIPALITY",
  "PREFECTURE",
  "MINISTRY",
  "ADMINISTRATION",
  "PUBLIC_SERVICE",
]);

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const resolveChannel = async (channelId, userId) => {
  const alias = new Map([
    ["EMERGENCY", "EMERGENCY"],
    ["URGENCES", "EMERGENCY"],
    ["ANNOUNCEMENTS", "ANNOUNCEMENTS"],
    ["ANNONCES", "ANNOUNCEMENTS"],
  ]).get(channelId.toUpperCase());
  if (alias) {
    const result = await pool.query(
      `SELECT channel.id, channel.name, channel.kind,
              channel.geography_scope, channel.communication_area_id,
              channel.country_code
       FROM channels AS channel
       WHERE UPPER(channel.kind) = $1
         AND channel.communication_area_id IS NULL
         AND (channel.country_code IS NULL OR channel.country_code = (
           SELECT country_code FROM users WHERE id = $2
         ))
       ORDER BY CASE WHEN channel.country_code = (
         SELECT country_code FROM users WHERE id = $2
       ) THEN 0 ELSE 1 END
       LIMIT 1`,
      [alias, userId],
    );
    return result.rows[0] ?? null;
  }
  if (!isUuid(channelId)) return null;
  const result = await pool.query(
    `SELECT channel.id, channel.name, channel.kind,
            channel.geography_scope, channel.communication_area_id,
            channel.country_code
     FROM channels AS channel
     WHERE channel.id = $1
       AND (
         channel.geography_scope = 'international'
         OR (channel.communication_area_id IS NULL
           AND channel.country_code = (
             SELECT country_code FROM users WHERE id = $2
           ))
         OR EXISTS (
           SELECT 1 FROM user_geographic_channel_follows AS follow
           WHERE follow.channel_id = channel.id AND follow.user_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM communication_areas AS area
           JOIN users AS account ON account.id = $2
           WHERE area.id = channel.communication_area_id
             AND (
               (account.last_location IS NOT NULL
                 AND ST_Covers(area.boundary, account.last_location))
               OR (area.scope = 'neighborhood'
                 AND LOWER(area.name) = LOWER(COALESCE(account.neighborhood, '')))
             )
         )
         OR EXISTS (
           SELECT 1 FROM users AS account
           WHERE account.id = $2 AND account.last_location IS NOT NULL
             AND channel.center_location IS NOT NULL
             AND ST_DWithin(
               channel.center_location::geography,
               account.last_location::geography,
               COALESCE((
                 SELECT default_radius_m FROM country_config
                 WHERE code = account.country_code
               ), 5000)
             )
         )
       )`,
    [channelId, userId],
  );
  return result.rows[0] ?? null;
};

export const listCommunicationChannels = async (request, response, next) => {
  const scope =
    typeof request.query.scope === "string" ? request.query.scope : null;
  if (scope && !CHANNEL_SCOPES.has(scope)) {
    return response.status(400).json({ error: "La portée du canal est invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT channel.id, channel.name, channel.kind,
              channel.geography_scope AS scope, channel.country_code,
              channel.communication_area_id AS area_id,
              area.name AS area_name,
              EXISTS (
                SELECT 1 FROM user_geographic_channel_follows AS follow
                WHERE follow.user_id = account.id
                  AND follow.channel_id = channel.id
              ) AS is_following,
              EXISTS (
                SELECT 1
                FROM institution_memberships AS membership
                JOIN institutions AS institution
                  ON institution.id = membership.institution_id
                WHERE membership.user_id = account.id
                  AND membership.status = 'ACTIVE'
                  AND institution.status = 'VERIFIED'
                  AND (
                    (institution.communication_area_id IS NOT NULL
                      AND institution.communication_area_id = channel.communication_area_id)
                    OR (institution.communication_area_id IS NULL
                      AND channel.communication_area_id IS NULL
                      AND institution.country_code = channel.country_code)
                  )
              ) AS can_publish_official
       FROM users AS account
       JOIN channels AS channel ON (
         channel.geography_scope = 'international'
         OR (channel.communication_area_id IS NULL
           AND channel.country_code = account.country_code)
         OR EXISTS (
           SELECT 1 FROM user_geographic_channel_follows AS follow
           WHERE follow.user_id = account.id AND follow.channel_id = channel.id
         )
         OR EXISTS (
           SELECT 1 FROM communication_areas AS area
           WHERE area.id = channel.communication_area_id
             AND (
               (account.last_location IS NOT NULL
                 AND ST_Covers(area.boundary, account.last_location))
               OR (area.scope = 'neighborhood'
                 AND LOWER(area.name) = LOWER(COALESCE(account.neighborhood, '')))
             )
         )
         OR (
           account.last_location IS NOT NULL
           AND channel.center_location IS NOT NULL
           AND ST_DWithin(
             channel.center_location::geography,
             account.last_location::geography,
             COALESCE((
               SELECT default_radius_m FROM country_config
               WHERE code = account.country_code
             ), 5000)
           )
         )
       )
       LEFT JOIN communication_areas AS area
         ON area.id = channel.communication_area_id
       WHERE account.id = $1
         AND ($2::text IS NULL OR
           CASE WHEN $2 = 'nearby' THEN
             channel.communication_area_id IS NOT NULL
             AND account.last_location IS NOT NULL
             AND ST_DWithin(
               channel.center_location::geography,
               account.last_location::geography,
               COALESCE((
                 SELECT config.default_radius_m
                 FROM country_config AS config
                 WHERE config.code = account.country_code
               ), 5000)
             )
           WHEN $2 = 'neighborhood' THEN
             channel.geography_scope = 'neighborhood'
           WHEN $2 = 'commune' THEN channel.geography_scope = 'commune'
           WHEN $2 = 'region' THEN channel.geography_scope = 'region'
           WHEN $2 = 'country' THEN
             channel.geography_scope = 'country'
             AND channel.country_code = account.country_code
           WHEN $2 = 'international' THEN
             channel.geography_scope = 'international'
           ELSE TRUE END)
       ORDER BY channel.geography_scope, area.name NULLS FIRST, channel.kind`,
      [request.auth.userId, scope],
    );
    return response.status(200).json({ channels: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const searchCommunicationChannels = async (request, response, next) => {
  const scope =
    typeof request.query.scope === "string" ? request.query.scope : "";
  const search =
    typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
  const countryCode =
    typeof request.query.country_code === "string"
      ? request.query.country_code.trim().toUpperCase()
      : null;
  if (
    !CHANNEL_SCOPES.has(scope) ||
    (countryCode !== null && !/^[A-Z]{2,3}$/.test(countryCode))
  ) {
    return response.status(400).json({ error: "Les critères de recherche sont invalides." });
  }
  try {
    const result = await pool.query(
      `SELECT channel.id, channel.name, channel.kind,
              channel.geography_scope AS scope, channel.country_code,
              area.name AS area_name,
              EXISTS (
                SELECT 1 FROM user_geographic_channel_follows AS follow
                WHERE follow.user_id = $1 AND follow.channel_id = channel.id
              ) AS is_following
       FROM channels AS channel
       LEFT JOIN communication_areas AS area
         ON area.id = channel.communication_area_id
       WHERE (
           ($2 = 'nearby' AND channel.communication_area_id IS NOT NULL)
           OR channel.geography_scope = $2
         )
         AND ($3::text IS NULL OR channel.country_code = $3)
         AND ($4 = '' OR channel.name ILIKE '%' || $4 || '%'
           OR area.name ILIKE '%' || $4 || '%')
       ORDER BY channel.name
       LIMIT 50`,
      [request.auth.userId, scope, countryCode, search],
    );
    return response.status(200).json({ channels: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const followCommunicationChannel = async (request, response, next) => {
  if (!isUuid(request.params.channelId)) {
    return response.status(400).json({ error: "Identifiant de canal invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO user_geographic_channel_follows (user_id, channel_id)
       SELECT $1, channel.id
       FROM channels AS channel
       WHERE channel.id = $2
       ON CONFLICT (user_id, channel_id) DO NOTHING
       RETURNING channel_id`,
      [request.auth.userId, request.params.channelId],
    );
    if (!result.rowCount) {
      const exists = await pool.query(
        "SELECT 1 FROM channels WHERE id = $1",
        [request.params.channelId],
      );
      if (!exists.rowCount) {
        return response.status(404).json({ error: "Canal introuvable." });
      }
    }
    return response.status(200).json({ following: true });
  } catch (error) {
    return next(error);
  }
};

export const unfollowCommunicationChannel = async (request, response, next) => {
  if (!isUuid(request.params.channelId)) {
    return response.status(400).json({ error: "Identifiant de canal invalide." });
  }
  try {
    await pool.query(
      `DELETE FROM user_geographic_channel_follows
       WHERE user_id = $1 AND channel_id = $2`,
      [request.auth.userId, request.params.channelId],
    );
    return response.status(200).json({ following: false });
  } catch (error) {
    return next(error);
  }
};

export const listCommunicationMessages = async (request, response, next) => {
  try {
    const channel = await resolveChannel(
      request.params.channelId,
      request.auth.userId,
    );
    if (!channel) {
      return response.status(404).json({ error: "Canal public introuvable." });
    }
    const result = await pool.query(
      `SELECT message.id, message.channel_id, message.sender_id,
              profile.full_name AS sender_name,
              profile.profile_photo_url AS sender_photo_url,
              profile.badge AS sender_badge,
              FALSE AS sender_is_ally, message.body, message.media_url,
              message.media_type, message.information_type,
              message.created_at, message.edited_at,
              message.institution_id, institution.name AS institution_name,
              message.sender_id = $2 AS is_mine
       FROM messages AS message
       LEFT JOIN users AS profile ON profile.id = message.sender_id
       LEFT JOIN institutions AS institution
         ON institution.id = message.institution_id
       WHERE message.channel_id = $1
         AND message.removed_at IS NULL
         AND (
           (EXISTS (
             SELECT 1 FROM channels AS channel
             WHERE channel.id = message.channel_id
               AND channel.kind = 'ANNOUNCEMENTS'
           ) AND message.information_type = 'OFFICIAL')
           OR (NOT EXISTS (
             SELECT 1 FROM channels AS channel
             WHERE channel.id = message.channel_id
               AND channel.kind = 'ANNOUNCEMENTS'
           ) AND message.information_type = 'COMMUNITY')
         )
       ORDER BY message.created_at DESC
       LIMIT 100`,
      [channel.id, request.auth.userId],
    );
    return response.status(200).json({
      messages: result.rows
        .reverse()
        .map((message) => ({ ...message, channel_id: request.params.channelId })),
    });
  } catch (error) {
    return next(error);
  }
};

const authorizedInstitution = async (
  userId,
  institutionId,
  channel,
  executor = pool,
) => {
  const result = await executor.query(
    `SELECT institution.id, institution.name
     FROM institutions AS institution
     JOIN institution_memberships AS membership
       ON membership.institution_id = institution.id
     WHERE institution.id = $1
       AND membership.user_id = $2
       AND membership.status = 'ACTIVE'
       AND institution.status = 'VERIFIED'
       AND (
         (institution.communication_area_id IS NOT NULL
           AND institution.communication_area_id = $3)
         OR (institution.communication_area_id IS NULL
           AND $3::uuid IS NULL
           AND institution.country_code = $4)
       )
     FOR SHARE OF institution, membership`,
    [institutionId, userId, channel.communication_area_id, channel.country_code],
  );
  return result.rows[0] ?? null;
};

export const createCommunicationMessage = async (request, response, next) => {
  const body =
    typeof request.body?.content === "string"
      ? request.body.content.trim()
      : typeof request.body?.body === "string"
        ? request.body.body.trim()
        : "";
  const mediaUrl =
    typeof request.body?.media_url === "string" ? request.body.media_url.trim() : "";
  const mediaType = request.body?.media_type;
  const mediaPublicId =
    typeof request.body?.media_public_id === "string"
      ? request.body.media_public_id.trim()
      : "";
  const informationType =
    typeof request.body?.information_type === "string"
      ? request.body.information_type.toUpperCase()
      : "COMMUNITY";
  const institutionId = request.body?.institution_id;
  const hasMedia = Boolean(mediaUrl || mediaType || mediaPublicId);
  if (
    body.length > 5000 ||
    (!body && !hasMedia) ||
    !["COMMUNITY", "OFFICIAL"].includes(informationType) ||
    (hasMedia &&
      (!mediaUrl ||
        !mediaPublicId ||
        !["image", "video"].includes(mediaType))) ||
    (informationType === "OFFICIAL" && !isUuid(institutionId))
  ) {
    return response.status(400).json({ error: "Contenu ou catégorie du message invalide." });
  }
  try {
    const channel = await resolveChannel(
      request.params.channelId,
      request.auth.userId,
    );
    if (!channel) {
      return response.status(404).json({ error: "Canal public introuvable." });
    }
    if (informationType === "OFFICIAL") {
      const institution = await authorizedInstitution(
        request.auth.userId,
        institutionId,
        channel,
      );
      if (!institution || !["ANNOUNCEMENTS", "COMMUNITY"].includes(channel.kind)) {
        return response.status(403).json({
          error: "Seul un compte institutionnel vérifié et autorisé peut publier une annonce officielle dans cette zone.",
        });
      }
    } else if (channel.kind === "ANNOUNCEMENTS") {
      return response.status(403).json({
        error: "Le canal institutionnel est réservé aux publications officielles autorisées.",
      });
    } else if (!["COMMUNITY", "EMERGENCY"].includes(channel.kind)) {
      return response.status(403).json({ error: "La publication est interdite dans ce canal." });
    }
    if (hasMedia) {
      const verifiedMedia = await verifyMessageMedia({
        userId: request.auth.userId,
        mediaUrl,
        mediaType,
        mediaPublicId,
      });
      if (verifiedMedia.error) {
        return response.status(400).json({ error: verifiedMedia.error });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (informationType === "OFFICIAL") {
        const institution = await authorizedInstitution(
          request.auth.userId,
          institutionId,
          channel,
          client,
        );
        if (!institution) {
          await client.query("ROLLBACK");
          return response.status(403).json({
            error: "L'autorisation institutionnelle a été révoquée.",
          });
        }
      }
      const result = await client.query(
        `INSERT INTO messages (
           channel_id, sender_id, body, media_url, media_type,
           information_type, institution_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, channel_id, sender_id, body, media_url, media_type,
                   information_type, institution_id, created_at`,
        [
          channel.id,
          request.auth.userId,
          body || null,
          mediaUrl || null,
          mediaUrl ? mediaType : null,
          informationType,
          informationType === "OFFICIAL" ? institutionId : null,
        ],
      );
      const message = result.rows[0];
      if (informationType === "OFFICIAL") {
        await client.query(
          `INSERT INTO official_message_history
             (message_id, institution_id, actor_id, action, new_body)
           VALUES ($1, $2, $3, 'PUBLISHED', $4)`,
          [message.id, institutionId, request.auth.userId, body || null],
        );
      }
      const sender = await client.query(
        "SELECT full_name, profile_photo_url, badge FROM users WHERE id = $1",
        [request.auth.userId],
      );
      const institutionName =
        informationType === "OFFICIAL"
          ? (
              await client.query(
                "SELECT name FROM institutions WHERE id = $1",
                [institutionId],
              )
            ).rows[0]?.name ?? null
          : null;
      await client.query("COMMIT");
      const publicMessage = {
        ...message,
        channel_id: request.params.channelId,
        channel_name: channel.name,
        sender_name: sender.rows[0]?.full_name ?? "Voisin",
        sender_photo_url: sender.rows[0]?.profile_photo_url ?? null,
        sender_badge: sender.rows[0]?.badge ?? null,
        sender_is_ally: false,
        institution_name: institutionName,
        content: body,
        is_mine: true,
      };
      request.app?.get?.("io")?.to(`channel:${channel.id}`).emit(
        "channel:new_message",
        publicMessage,
      );
      return response.status(201).json({ message: publicMessage });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
};

const updateOfficialMessage = async (request, response, next, withdraw) => {
  if (!isUuid(request.params.messageId)) {
    return response.status(400).json({ error: "Identifiant de publication invalide." });
  }
  const body =
    typeof request.body?.content === "string" ? request.body.content.trim() : "";
  if (!withdraw && (!body || body.length > 5000)) {
    return response.status(400).json({ error: "Le texte de la correction est invalide." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT message.id, message.institution_id, message.body,
              message.channel_id, channel.country_code,
              channel.communication_area_id
       FROM messages AS message
       JOIN channels AS channel ON channel.id = message.channel_id
       WHERE message.id = $1
         AND message.information_type = 'OFFICIAL'
         AND message.removed_at IS NULL
       FOR UPDATE`,
      [request.params.messageId],
    );
    const existing = selected.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Annonce officielle introuvable." });
    }
    const permission = await client.query(
      `SELECT 1
       FROM institution_memberships AS membership
       JOIN institutions AS institution
         ON institution.id = membership.institution_id
       WHERE membership.institution_id = $1
         AND membership.user_id = $2
         AND membership.status = 'ACTIVE'
         AND institution.status = 'VERIFIED'
         AND (
           institution.communication_area_id = $3
           OR (institution.communication_area_id IS NULL
             AND $3::uuid IS NULL
             AND institution.country_code = $4)
         )
       FOR SHARE OF membership, institution`,
      [
        existing.institution_id,
        request.auth.userId,
        existing.communication_area_id,
        existing.country_code,
      ],
    );
    if (!permission.rowCount) {
      await client.query("ROLLBACK");
      return response.status(403).json({
        error: "Vous n'êtes pas autorisé à corriger cette annonce officielle.",
      });
    }
    if (withdraw) {
      await client.query(
        "UPDATE messages SET removed_at = CURRENT_TIMESTAMP WHERE id = $1",
        [existing.id],
      );
    } else {
      await client.query(
        "UPDATE messages SET body = $2, edited_at = CURRENT_TIMESTAMP WHERE id = $1",
        [existing.id, body],
      );
    }
    await client.query(
      `INSERT INTO official_message_history
         (message_id, institution_id, actor_id, action, previous_body, new_body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        existing.id,
        existing.institution_id,
        request.auth.userId,
        withdraw ? "WITHDRAWN" : "EDITED",
        existing.body,
        withdraw ? null : body,
      ],
    );
    await client.query("COMMIT");
    return response.status(200).json({
      message: { id: existing.id, withdrawn: withdraw, ...(withdraw ? {} : { content: body }) },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
};

export const correctOfficialMessage = (request, response, next) =>
  updateOfficialMessage(request, response, next, false);

export const withdrawOfficialMessage = (request, response, next) =>
  updateOfficialMessage(request, response, next, true);

export const listOfficialMessageHistory = async (request, response, next) => {
  if (!isUuid(request.params.messageId)) {
    return response.status(400).json({ error: "Identifiant de publication invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT history.action, history.previous_body, history.new_body,
              history.created_at, actor.full_name AS actor_name,
              institution.name AS institution_name
       FROM official_message_history AS history
       JOIN messages AS message ON message.id = history.message_id
       JOIN institutions AS institution
         ON institution.id = history.institution_id
       LEFT JOIN users AS actor ON actor.id = history.actor_id
       WHERE history.message_id = $1
         AND message.information_type = 'OFFICIAL'
       ORDER BY history.created_at`,
      [request.params.messageId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Historique officiel introuvable." });
    }
    return response.status(200).json({ history: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const requestInstitutionVerification = async (request, response, next) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const institutionType =
    typeof request.body?.institution_type === "string"
      ? request.body.institution_type.toUpperCase()
      : "";
  const countryCode =
    typeof request.body?.country_code === "string"
      ? request.body.country_code.trim().toUpperCase()
      : "";
  const areaId = request.body?.communication_area_id ?? null;
  const municipalityId = request.body?.municipality_id ?? null;
  const legalIdentifier =
    typeof request.body?.legal_identifier === "string"
      ? request.body.legal_identifier.trim()
      : "";
  const proofUrl =
    typeof request.body?.proof_url === "string" ? request.body.proof_url.trim() : "";
  let validProofUrl = false;
  try {
    const parsedUrl = new URL(proofUrl);
    validProofUrl = parsedUrl.protocol === "https:" && Boolean(parsedUrl.hostname);
  } catch {
    validProofUrl = false;
  }
  if (
    !name ||
    name.length > 150 ||
    !INSTITUTION_TYPES.has(institutionType) ||
    !/^[A-Z]{2,3}$/.test(countryCode) ||
    (areaId !== null && !isUuid(areaId)) ||
    (municipalityId !== null && !isUuid(municipalityId)) ||
    (institutionType === "MUNICIPALITY" &&
      municipalityId === null &&
      areaId === null) ||
    !legalIdentifier ||
    legalIdentifier.length > 100 ||
    !validProofUrl ||
    proofUrl.length > 2048
  ) {
    return response.status(400).json({
      error: "Les informations et le justificatif HTTPS de l'institution sont obligatoires.",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (areaId) {
      const area = await client.query(
        "SELECT 1 FROM communication_areas WHERE id = $1 AND country_code = $2",
        [areaId, countryCode],
      );
      if (!area.rowCount) {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "L'aire institutionnelle doit appartenir au pays indiqué.",
        });
      }
    }
    if (municipalityId) {
      const municipality = await client.query(
        "SELECT 1 FROM municipalities WHERE id = $1",
        [municipalityId],
      );
      if (!municipality.rowCount) {
        await client.query("ROLLBACK");
        return response.status(400).json({
          error: "La mairie doit correspondre à une commune enregistrée.",
        });
      }
    }
    const result = await client.query(
      `INSERT INTO institutions (
         name, institution_type, country_code, communication_area_id,
         municipality_id, legal_identifier, proof_url, submitted_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, institution_type, country_code,
                 communication_area_id, municipality_id, status, created_at`,
      [
        name,
        institutionType,
        countryCode,
        areaId,
        municipalityId,
        legalIdentifier,
        proofUrl,
        request.auth.userId,
      ],
    );
    const institution = result.rows[0];
    await client.query(
      `INSERT INTO institution_memberships (institution_id, user_id, role)
       VALUES ($1, $2, 'OWNER')`,
      [institution.id, request.auth.userId],
    );
    await client.query("COMMIT");
    return response.status(201).json({ institution });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return response.status(409).json({
        error: "Une demande existe déjà pour cet identifiant légal.",
      });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const createCommunicationArea = async (request, response, next) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const scope =
    typeof request.body?.scope === "string" ? request.body.scope.toLowerCase() : "";
  const countryCode =
    typeof request.body?.country_code === "string"
      ? request.body.country_code.trim().toUpperCase()
      : "";
  const parentAreaId = request.body?.parent_area_id ?? null;
  const boundary = request.body?.boundary;
  if (
    !AREA_SCOPES.has(scope) ||
    !name ||
    name.length > 150 ||
    !/^[A-Z]{2,3}$/.test(countryCode) ||
    (parentAreaId !== null && !isUuid(parentAreaId)) ||
    (scope === "region" && parentAreaId !== null) ||
    (scope !== "region" && parentAreaId === null) ||
    !boundary ||
    !["Polygon", "MultiPolygon"].includes(boundary.type) ||
    !Array.isArray(boundary.coordinates)
  ) {
    return response.status(400).json({
      error: "Portée, nom, pays, parent ou limite GeoJSON invalide.",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH geometry AS (
         SELECT ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)) AS boundary
       ), inserted AS (
         INSERT INTO communication_areas (
           scope, name, country_code, parent_area_id, boundary, created_by
         )
         SELECT $1, $2, $3, $4, geometry.boundary, $6
         FROM geometry
         WHERE ST_IsValid(geometry.boundary)
           AND NOT ST_IsEmpty(geometry.boundary)
           AND ST_Within(
             geometry.boundary,
             ST_MakeEnvelope(-180, -90, 180, 90, 4326)
           )
           AND (
             ($4::uuid IS NULL AND $1 = 'region')
             OR EXISTS (
               SELECT 1 FROM communication_areas AS parent
               WHERE parent.id = $4
                 AND parent.country_code = $3
                 AND parent.scope = CASE
                   WHEN $1 = 'commune' THEN 'region'
                   WHEN $1 = 'neighborhood' THEN 'commune'
                 END
             )
           )
         RETURNING id, scope, name, country_code, parent_area_id
       )
       SELECT * FROM inserted`,
      [
        scope,
        name,
        countryCode,
        parentAreaId,
        JSON.stringify(boundary),
        request.auth.userId,
      ],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "La limite GeoJSON n'est pas valide." });
    }
    const area = result.rows[0];
    await client.query(
      `INSERT INTO channels (
         name, kind, country_code, geography_scope, communication_area_id,
         center_location
       )
       SELECT $1 || ' · Communauté', 'COMMUNITY', $2, $3, $4,
              ST_Centroid(boundary)
       FROM communication_areas WHERE id = $4
       UNION ALL
       SELECT $1 || ' · Annonces officielles', 'ANNOUNCEMENTS', $2, $3, $4,
              ST_Centroid(boundary)
       FROM communication_areas WHERE id = $4
       ON CONFLICT (communication_area_id, kind)
         WHERE communication_area_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name`,
      [area.name, area.country_code, area.scope, area.id],
    );
    await client.query("COMMIT");
    return response.status(201).json({ area });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return response.status(409).json({ error: "Cette aire géographique existe déjà." });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const updateCommunicationArea = async (request, response, next) => {
  const areaId = request.params.areaId;
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const boundary = request.body?.boundary;
  if (
    !isUuid(areaId) ||
    !name ||
    name.length > 150 ||
    !boundary ||
    !["Polygon", "MultiPolygon"].includes(boundary.type) ||
    !Array.isArray(boundary.coordinates)
  ) {
    return response.status(400).json({ error: "Nom ou limite GeoJSON invalide." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT id, name, scope, country_code
       FROM communication_areas WHERE id = $1 FOR UPDATE`,
      [areaId],
    );
    if (!previous.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Aire géographique introuvable." });
    }
    const updated = await client.query(
      `UPDATE communication_areas
       SET name = $2,
           boundary = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND ST_IsValid(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))
         AND NOT ST_IsEmpty(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)))
         AND ST_Within(
           ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)),
           ST_MakeEnvelope(-180, -90, 180, 90, 4326)
         )
       RETURNING id, name, scope, country_code`,
      [areaId, name, JSON.stringify(boundary)],
    );
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "La limite GeoJSON n'est pas valide." });
    }
    await client.query(
      `UPDATE channels
       SET name = CASE kind
           WHEN 'COMMUNITY' THEN $2 || ' · Communauté'
           WHEN 'ANNOUNCEMENTS' THEN $2 || ' · Annonces officielles'
           ELSE name END,
           center_location = ST_Centroid((
             SELECT boundary FROM communication_areas WHERE id = $1
           ))
       WHERE communication_area_id = $1`,
      [areaId, name],
    );
    await client.query(
      `INSERT INTO admin_audit_log
         (actor_id, action, target_type, target_id, details)
       VALUES ($1, 'COMMUNICATION_AREA_UPDATED', 'COMMUNICATION_AREA', $2, $3::jsonb)`,
      [
        request.auth.userId,
        areaId,
        JSON.stringify({
          scope: previous.rows[0].scope,
          country_code: previous.rows[0].country_code,
          previous_name: previous.rows[0].name,
          name,
        }),
      ],
    );
    await client.query("COMMIT");
    return response.status(200).json({ area: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return response.status(409).json({ error: "Cette aire géographique existe déjà." });
    }
    return next(error);
  } finally {
    client.release();
  }
};

export const listInstitutionVerificationRequests = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT institution.id, institution.name, institution.institution_type,
              institution.country_code, institution.communication_area_id,
              institution.municipality_id,
              area.name AS area_name, institution.legal_identifier,
              institution.proof_url, institution.status,
              institution.submitted_by, submitter.full_name AS submitter_name,
              institution.created_at
       FROM institutions AS institution
       LEFT JOIN communication_areas AS area
         ON area.id = institution.communication_area_id
       LEFT JOIN users AS submitter ON submitter.id = institution.submitted_by
       WHERE institution.status = 'PENDING'
       ORDER BY institution.created_at
       LIMIT 100`,
    );
    return response.status(200).json({ institutions: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const reviewInstitutionVerification = async (request, response, next) => {
  const status =
    typeof request.body?.status === "string"
      ? request.body.status.toUpperCase()
      : "";
  const reviewNote =
    typeof request.body?.review_note === "string"
      ? request.body.review_note.trim()
      : "";
  if (
    !isUuid(request.params.institutionId) ||
    !["VERIFIED", "REJECTED", "SUSPENDED"].includes(status) ||
    reviewNote.length > 500
  ) {
    return response.status(400).json({ error: "La décision de vérification est invalide." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE institutions
       SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP,
           review_note = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('PENDING', 'VERIFIED', 'SUSPENDED')
       RETURNING id, status`,
      [
        request.params.institutionId,
        status,
        request.auth.userId,
        reviewNote || null,
      ],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Demande institutionnelle introuvable." });
    }
    if (status === "VERIFIED") {
      await client.query(
        `UPDATE institution_memberships
         SET status = 'ACTIVE', granted_by = $2
         WHERE institution_id = $1 AND role = 'OWNER' AND status = 'PENDING'`,
        [request.params.institutionId, request.auth.userId],
      );
    }
    await client.query(
      `INSERT INTO admin_audit_log
         (actor_id, action, target_type, target_id, details)
       VALUES ($1, 'INSTITUTION_REVIEWED', 'INSTITUTION', $2, $3::jsonb)`,
      [
        request.auth.userId,
        request.params.institutionId,
        JSON.stringify({ status, review_note: reviewNote || null }),
      ],
    );
    await client.query("COMMIT");
    return response.status(200).json({ institution: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
};

export const listMyInstitutions = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT institution.id, institution.name, institution.institution_type,
              institution.country_code, institution.communication_area_id,
              institution.status, membership.role, membership.status AS membership_status
       FROM institution_memberships AS membership
       JOIN institutions AS institution
         ON institution.id = membership.institution_id
       WHERE membership.user_id = $1
       ORDER BY institution.created_at DESC`,
      [request.auth.userId],
    );
    return response.status(200).json({ institutions: result.rows });
  } catch (error) {
    return next(error);
  }
};

const isVerifiedInstitutionOwner = async (institutionId, userId) => {
  const result = await pool.query(
    `SELECT 1
     FROM institutions AS institution
     JOIN institution_memberships AS membership
       ON membership.institution_id = institution.id
     WHERE institution.id = $1 AND institution.status = 'VERIFIED'
       AND membership.user_id = $2 AND membership.role = 'OWNER'
       AND membership.status = 'ACTIVE'`,
    [institutionId, userId],
  );
  return result.rowCount > 0;
};

export const inviteInstitutionPublisher = async (request, response, next) => {
  const userId = request.body?.user_id;
  if (!isUuid(request.params.institutionId) || !isUuid(userId)) {
    return response.status(400).json({ error: "Institution ou compte invalide." });
  }
  try {
    if (
      !(await isVerifiedInstitutionOwner(
        request.params.institutionId,
        request.auth.userId,
      ))
    ) {
      return response.status(403).json({
        error: "Seul un responsable d'institution vérifiée peut inviter un éditeur.",
      });
    }
    const user = await pool.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    if (!user.rowCount) {
      return response.status(404).json({ error: "Compte à inviter introuvable." });
    }
    const result = await pool.query(
      `INSERT INTO institution_memberships
         (institution_id, user_id, role, status, granted_by)
       VALUES ($1, $2, 'PUBLISHER', 'PENDING', $3)
       ON CONFLICT (institution_id, user_id)
       DO UPDATE SET role = 'PUBLISHER', status = 'PENDING',
                     granted_by = EXCLUDED.granted_by
       RETURNING institution_id, user_id, role, status`,
      [request.params.institutionId, userId, request.auth.userId],
    );
    return response.status(200).json({ invitation: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const acceptInstitutionInvitation = async (request, response, next) => {
  if (!isUuid(request.params.institutionId)) {
    return response.status(400).json({ error: "Identifiant d'institution invalide." });
  }
  try {
    const result = await pool.query(
      `UPDATE institution_memberships AS membership
       SET status = 'ACTIVE'
       FROM institutions AS institution
       WHERE membership.institution_id = institution.id
         AND membership.institution_id = $1
         AND membership.user_id = $2
         AND membership.status = 'PENDING'
         AND institution.status = 'VERIFIED'
       RETURNING membership.institution_id, membership.user_id`,
      [request.params.institutionId, request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({
        error: "Invitation introuvable ou institution non vérifiée.",
      });
    }
    return response.status(200).json({ accepted: true });
  } catch (error) {
    return next(error);
  }
};

export const revokeInstitutionPublisher = async (request, response, next) => {
  const userId = request.params.userId;
  if (
    !isUuid(request.params.institutionId) ||
    !isUuid(userId) ||
    userId === request.auth.userId
  ) {
    return response.status(400).json({ error: "Institution ou compte invalide." });
  }
  try {
    if (
      !(await isVerifiedInstitutionOwner(
        request.params.institutionId,
        request.auth.userId,
      ))
    ) {
      return response.status(403).json({
        error: "Seul un responsable d'institution vérifiée peut révoquer un éditeur.",
      });
    }
    const result = await pool.query(
      `UPDATE institution_memberships
       SET status = 'REVOKED'
       WHERE institution_id = $1 AND user_id = $2 AND role = 'PUBLISHER'
       RETURNING user_id`,
      [request.params.institutionId, userId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Éditeur institutionnel introuvable." });
    }
    return response.status(200).json({ revoked: true });
  } catch (error) {
    return next(error);
  }
};

export const verifyMessageMediaForCommunication = verifyMessageMedia;
