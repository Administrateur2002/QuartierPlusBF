import { pool } from "../db/pool.js";
import { sendExpoPushNotifications } from "../services/pushNotifications.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validUuid = (value) =>
  typeof value === "string" && UUID_PATTERN.test(value);

const readOptions = (value) =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.length <= 10 &&
  value.every(
    (option) =>
      typeof option === "string" &&
      option.trim().length > 0 &&
      option.trim().length <= 150,
  )
    ? value.map((option) => option.trim())
    : null;

const getAuthorizedGroup = async (
  table,
  idColumn,
  request,
  requestedId,
) => {
  if (requestedId !== undefined && !validUuid(requestedId)) {
    return { error: "Identifiant de groupe invalide." };
  }
  const result = await pool.query(
    `SELECT groups.${idColumn} AS id
     FROM ${table} groups
     JOIN ${table === "residences" ? "residence_members" : "municipality_members"} members
       ON members.${idColumn} = groups.${idColumn}
     WHERE members.user_id = $1
       AND ($2::uuid IS NULL OR groups.${idColumn} = $2)
     ORDER BY groups.name`,
    [request.auth.userId, requestedId ?? null],
  );
  if (result.rowCount === 0) {
    return { error: "Aucun rattachement Pro autorisé n'a été trouvé.", status: 403 };
  }
  if (result.rowCount > 1) {
    return {
      error: "Plusieurs rattachements existent; sélectionnez celui à utiliser.",
      status: 409,
    };
  }
  return { id: result.rows[0].id };
};

const readResidence = (request, suppliedId) =>
  getAuthorizedGroup(
    "residences",
    "id",
    request,
    suppliedId ?? request.query.residence_id,
  );

const readMunicipality = (request, suppliedId) =>
  getAuthorizedGroup(
    "municipalities",
    "id",
    request,
    suppliedId ?? request.query.municipality_id,
  );

export const listSyndicResidences = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name
       FROM residences r
       JOIN residence_members rm ON rm.residence_id = r.id
       WHERE rm.user_id = $1
       ORDER BY r.name`,
      [request.auth.userId],
    );
    return response.status(200).json({ residences: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getSyndicWall = async (request, response, next) => {
  try {
    const residence = await readResidence(request);
    if (residence.error) {
      return response.status(residence.status ?? 400).json({ error: residence.error });
    }
    const result = await pool.query(
      `SELECT p.id, p.residence_id, p.author_id, u.full_name AS author_name,
              p.content, p.created_at
       FROM residence_posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.residence_id = $1
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [residence.id],
    );
    return response.status(200).json({ posts: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createSyndicWallPost = async (request, response, next) => {
  const content =
    typeof request.body?.content === "string" ? request.body.content.trim() : "";
  if (!content || content.length > 5000) {
    return response.status(400).json({ error: "Le message doit contenir 1 à 5000 caractères." });
  }
  try {
    const residence = await readResidence(request, request.body?.residence_id);
    if (residence.error) {
      return response.status(residence.status ?? 400).json({ error: residence.error });
    }
    const result = await pool.query(
      `INSERT INTO residence_posts (residence_id, author_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, residence_id, author_id, content, created_at`,
      [residence.id, request.auth.userId, content],
    );
    return response.status(201).json({ post: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const getSyndicVotes = async (request, response, next) => {
  try {
    const residence = await readResidence(request);
    if (residence.error) {
      return response.status(residence.status ?? 400).json({ error: residence.error });
    }
    const result = await pool.query(
      `SELECT v.id, v.title, v.options, v.status, v.created_at,
              COUNT(r.user_id)::int AS response_count
       FROM residence_votes v
       LEFT JOIN residence_vote_responses r ON r.vote_id = v.id
       WHERE v.residence_id = $1
       GROUP BY v.id
       ORDER BY v.created_at DESC
       LIMIT 100`,
      [residence.id],
    );
    return response.status(200).json({ votes: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createSyndicVote = async (request, response, next) => {
  const title =
    typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const options = readOptions(request.body?.options);
  if (!title || title.length > 250 || !options) {
    return response.status(400).json({ error: "Un titre et 2 à 10 options valides sont requis." });
  }
  try {
    const residence = await readResidence(request, request.body?.residence_id);
    if (residence.error) {
      return response.status(residence.status ?? 400).json({ error: residence.error });
    }
    const result = await pool.query(
      `INSERT INTO residence_votes (residence_id, author_id, title, options)
       VALUES ($1, $2, $3, $4)
       RETURNING id, residence_id, title, options, status, created_at`,
      [residence.id, request.auth.userId, title, JSON.stringify(options)],
    );
    return response.status(201).json({ vote: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const participateInSyndicVote = async (request, response, next) => {
  const optionIndex = request.body?.option_index;
  if (!validUuid(request.params.voteId) || !Number.isInteger(optionIndex) || optionIndex < 0) {
    return response.status(400).json({ error: "Vote ou option invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO residence_vote_responses (vote_id, user_id, option_index)
       SELECT v.id, $2, $3
       FROM residence_votes v
       JOIN residence_members rm ON rm.residence_id = v.residence_id
       WHERE v.id = $1 AND rm.user_id = $2 AND v.status = 'OPEN'
         AND $3 < jsonb_array_length(v.options)
       ON CONFLICT (vote_id, user_id) DO NOTHING
       RETURNING vote_id`,
      [request.params.voteId, request.auth.userId, optionIndex],
    );
    if (!result.rowCount) {
      return response.status(409).json({
        error: "Ce vote est fermé, invalide, inaccessible ou vous y avez déjà participé.",
      });
    }
    return response.status(201).json({ vote_id: result.rows[0].vote_id });
  } catch (error) {
    return next(error);
  }
};

export const getSyndicCraftsmen = async (request, response, next) => {
  try {
    const residence = await readResidence(request);
    if (residence.error) {
      return response.status(residence.status ?? 400).json({ error: residence.error });
    }
    const result = await pool.query(
      `SELECT id, name, trade, phone, rating
       FROM craftsmen
       WHERE residence_id = $1
       ORDER BY rating DESC, name
       LIMIT 200`,
      [residence.id],
    );
    return response.status(200).json({ craftsmen: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createFlashSale = async (request, response, next) => {
  const title =
    typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const discountPercent = request.body?.discount_percent;
  const latitude = Number(request.body?.latitude);
  const longitude = Number(request.body?.longitude);
  const durationHours = Number(request.body?.duration_hours ?? 24);
  if (
    !title ||
    title.length > 150 ||
    !Number.isInteger(discountPercent) ||
    discountPercent < 1 ||
    discountPercent > 100 ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(durationHours) ||
    durationHours <= 0 ||
    durationHours > 168
  ) {
    return response.status(400).json({ error: "Informations de vente flash invalides." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO flash_sales
         (merchant_id, title, discount_percent, expires_at, location)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 hour'),
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography)
       RETURNING id, title, discount_percent, expires_at, radius_km`,
      [request.auth.userId, title, discountPercent, durationHours, longitude, latitude],
    );
    const audience = await pool.query(
      `SELECT DISTINCT pt.token
       FROM users u
       JOIN push_tokens pt ON pt.user_id = u.id
       WHERE u.id <> $1 AND u.last_location IS NOT NULL
         AND ST_DWithin(
           u.last_location::geography,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           800
         )`,
      [request.auth.userId, longitude, latitude],
    );
    await sendExpoPushNotifications(
      audience.rows.map((row) => row.token),
      {
        title: "Vente flash à proximité",
        body: `${title} · ${discountPercent}% de réduction`,
        channelId: "messages",
        data: { type: "flash_sale", flashSaleId: result.rows[0].id },
      },
    );
    return response.status(201).json({
      flash_sale: result.rows[0],
      notified_count: audience.rowCount,
    });
  } catch (error) {
    return next(error);
  }
};

export const listTownHallMunicipalities = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.name
       FROM municipalities m
       JOIN municipality_members mm ON mm.municipality_id = m.id
       WHERE mm.user_id = $1
       ORDER BY m.name`,
      [request.auth.userId],
    );
    return response.status(200).json({ municipalities: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getTownHallGroupedReports = async (request, response, next) => {
  try {
    const municipality = await readMunicipality(request);
    if (municipality.error) {
      return response.status(municipality.status ?? 400).json({ error: municipality.error });
    }
    const center = await pool.query(
      "SELECT center_location IS NOT NULL AS configured FROM municipalities WHERE id = $1",
      [municipality.id],
    );
    if (!center.rows[0]?.configured) {
      return response.status(409).json({
        error: "Le centre géographique de cette municipalité doit être configuré.",
      });
    }
    await pool.query(
      `WITH scoped_alerts AS MATERIALIZED (
         SELECT s.emergency_type AS category,
                s.location,
                ST_SnapToGrid(s.location, 0.01) AS grid
         FROM sos_alerts s
         JOIN municipalities m ON m.id = $1
         WHERE s.status = 'ACTIVE'
           AND s.created_at >= NOW() - INTERVAL '7 days'
           AND ST_DWithin(
             s.location::geography, m.center_location, m.radius_km * 1000
           )
       ),
       grouped AS MATERIALIZED (
         SELECT category, grid, ST_Centroid(ST_Collect(location)) AS centroid,
                COUNT(*)::int AS report_count
         FROM scoped_alerts
         GROUP BY category, grid
       ),
       keyed AS MATERIALIZED (
         SELECT grouped.*,
                $1::text || ':' || grouped.category || ':' ||
                  ST_X(grouped.grid)::text || ':' ||
                  ST_Y(grouped.grid)::text AS grid_key
         FROM grouped
       ),
       stale AS (
         DELETE FROM smart_report_groups previous
         WHERE previous.grid_key LIKE $1::text || ':%'
           AND NOT EXISTS (
             SELECT 1 FROM keyed active_group
             WHERE active_group.grid_key = previous.grid_key
           )
         RETURNING previous.id
       )
       INSERT INTO smart_report_groups
         (category, centroid_location, report_count, status, grid_key, updated_at)
       SELECT current_group.category,
              current_group.centroid::geography,
              current_group.report_count,
              'OPEN',
              current_group.grid_key,
              NOW()
       FROM keyed current_group
       ON CONFLICT (grid_key) DO UPDATE SET
         centroid_location = EXCLUDED.centroid_location,
         report_count = EXCLUDED.report_count,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [municipality.id],
    );
    const result = await pool.query(
      `SELECT id, category, report_count, status,
              ST_Y(centroid_location::geometry) AS latitude,
              ST_X(centroid_location::geometry) AS longitude,
              updated_at
       FROM smart_report_groups
       WHERE grid_key LIKE $1 || ':%'
       ORDER BY report_count DESC`,
      [municipality.id],
    );
    return response.status(200).json({ groups: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createTownHallConsultation = async (request, response, next) => {
  const question =
    typeof request.body?.question === "string" ? request.body.question.trim() : "";
  const options = readOptions(request.body?.options);
  const endsAt = Date.parse(request.body?.ends_at);
  if (
    !question ||
    question.length > 500 ||
    !options ||
    !Number.isFinite(endsAt) ||
    endsAt <= Date.now() ||
    endsAt > Date.now() + 90 * 24 * 60 * 60 * 1000
  ) {
    return response.status(400).json({ error: "Question, options ou date de clôture invalides." });
  }
  try {
    const municipality = await readMunicipality(request, request.body?.municipality_id);
    if (municipality.error) {
      return response.status(municipality.status ?? 400).json({ error: municipality.error });
    }
    const result = await pool.query(
      `INSERT INTO citizen_consultations
         (municipality_id, author_id, question, options, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, municipality_id, question, options, ends_at, created_at`,
      [
        municipality.id,
        request.auth.userId,
        question,
        JSON.stringify(options),
        new Date(endsAt).toISOString(),
      ],
    );
    return response.status(201).json({ consultation: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const getTownHallContent = async (request, response, next) => {
  try {
    const municipality = await readMunicipality(request);
    if (municipality.error) {
      return response.status(municipality.status ?? 400).json({ error: municipality.error });
    }
    const [consultations, news] = await Promise.all([
      pool.query(
        `SELECT id, question, options, ends_at, created_at
         FROM citizen_consultations
         WHERE municipality_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [municipality.id],
      ),
      pool.query(
        `SELECT news.id, news.title, news.body,
                (institution.status = 'VERIFIED') AS is_certified,
                news.created_at
         FROM official_news AS news
         JOIN institutions AS institution
           ON institution.id = news.institution_id
         WHERE news.municipality_id = $1
           AND institution.status = 'VERIFIED'
         ORDER BY news.created_at DESC LIMIT 50`,
        [municipality.id],
      ),
    ]);
    return response.status(200).json({
      consultations: consultations.rows,
      official_news: news.rows,
    });
  } catch (error) {
    return next(error);
  }
};

export const createOfficialNews = async (request, response, next) => {
  const title =
    typeof request.body?.title === "string" ? request.body.title.trim() : "";
  const body =
    typeof request.body?.body === "string" ? request.body.body.trim() : "";
  if (!title || title.length > 250 || !body || body.length > 10000) {
    return response.status(400).json({ error: "Titre ou contenu du communiqué invalide." });
  }
  try {
    const municipality = await readMunicipality(request, request.body?.municipality_id);
    if (municipality.error) {
      return response.status(municipality.status ?? 400).json({ error: municipality.error });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const publisher = await client.query(
        `SELECT institution.id
         FROM institutions AS institution
         JOIN institution_memberships AS membership
           ON membership.institution_id = institution.id
         WHERE institution.municipality_id = $1
           AND institution.status = 'VERIFIED'
           AND membership.user_id = $2
           AND membership.status = 'ACTIVE'
         FOR SHARE OF institution, membership`,
        [municipality.id, request.auth.userId],
      );
      if (!publisher.rowCount) {
        await client.query("ROLLBACK");
        return response.status(403).json({
          error: "Une institution municipale vérifiée et une autorisation de publication sont requises.",
        });
      }
      const result = await client.query(
        `INSERT INTO official_news
           (municipality_id, author_id, title, body, is_certified, institution_id)
         VALUES ($1, $2, $3, $4, TRUE, $5)
         RETURNING id, title, body, is_certified, created_at`,
        [municipality.id, request.auth.userId, title, body, publisher.rows[0].id],
      );
      await client.query(
        `INSERT INTO official_news_history
           (official_news_id, institution_id, actor_id, action, new_body)
         VALUES ($1, $2, $3, 'PUBLISHED', $4)`,
        [
          result.rows[0].id,
          publisher.rows[0].id,
          request.auth.userId,
          body,
        ],
      );
      await client.query("COMMIT");
      return response.status(201).json({ official_news: result.rows[0] });
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

export const listActiveSos = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, emergency_type, emergency_image_url, emergency_audio_url, created_at,
              ST_Y(location) AS latitude, ST_X(location) AS longitude
       FROM sos_alerts
       WHERE status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    return response.status(200).json({ alerts: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getSecurityIntervention = async (request, response, next) => {
  const sosId = request.params.sos_id;
  if (!validUuid(sosId)) {
    return response.status(400).json({ error: "Identifiant SOS invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO interventions
         (sos_id, agent_id, patient_medical_summary, status, route_coordinates)
       SELECT s.id, $2, COALESCE(ep.medical_summary, '{}'::jsonb), 'ACCEPTED',
              jsonb_build_array(jsonb_build_object(
                'latitude', ST_Y(s.location), 'longitude', ST_X(s.location)
              ))
       FROM sos_alerts s
       LEFT JOIN emergency_profiles ep ON ep.user_id = s.user_id
       WHERE s.id = $1 AND s.status = 'ACTIVE'
       ON CONFLICT (sos_id) DO NOTHING
       RETURNING id, sos_id, agent_id, patient_medical_summary, status,
                 route_coordinates, created_at, updated_at`,
      [sosId, request.auth.userId],
    );
    let intervention = result.rows[0];
    if (!intervention) {
      const existing = await pool.query(
        `SELECT i.id, i.sos_id, i.agent_id, i.patient_medical_summary, i.status,
                i.route_coordinates, i.created_at, i.updated_at,
                s.id AS alert_id, s.emergency_type, s.emergency_image_url,
                s.emergency_audio_url, s.created_at AS alert_created_at,
                ST_Y(s.location) AS latitude, ST_X(s.location) AS longitude
         FROM interventions i
         JOIN sos_alerts s ON s.id = i.sos_id
         WHERE i.sos_id = $1 AND s.status = 'ACTIVE'`,
        [sosId],
      );
      if (!existing.rowCount) {
        return response.status(404).json({ error: "Aucune alerte SOS active trouvée." });
      }
      if (existing.rows[0].agent_id !== request.auth.userId) {
        return response.status(409).json({
          error: "Cette alerte est déjà prise en charge par un autre agent.",
        });
      }
      const row = existing.rows[0];
      intervention = row;
      return response.status(200).json({
        intervention,
        sos: {
          id: row.alert_id,
          emergency_type: row.emergency_type,
          emergency_image_url: row.emergency_image_url,
          emergency_audio_url: row.emergency_audio_url,
          created_at: row.alert_created_at,
          latitude: row.latitude,
          longitude: row.longitude,
        },
      });
    }
    const alert = await pool.query(
      `SELECT id, emergency_type, emergency_image_url, emergency_audio_url, created_at,
              ST_Y(location) AS latitude, ST_X(location) AS longitude
       FROM sos_alerts WHERE id = $1`,
      [sosId],
    );
    return response.status(200).json({
      intervention,
      sos: alert.rows[0],
    });
  } catch (error) {
    return next(error);
  }
};

const INTERVENTION_PREVIOUS_STATUS = {
  EN_ROUTE: "ACCEPTED",
  ON_SCENE: "EN_ROUTE",
  COMPLETED: "ON_SCENE",
};

export const updateSecurityIntervention = async (request, response, next) => {
  const sosId = request.params.sos_id;
  const status = request.body?.status;
  if (!validUuid(sosId)) {
    return response.status(400).json({ error: "Identifiant SOS invalide." });
  }
  if (!Object.hasOwn(INTERVENTION_PREVIOUS_STATUS, status)) {
    return response.status(400).json({ error: "Statut d’intervention invalide." });
  }
  try {
    const result = await pool.query(
      `UPDATE interventions
       SET status = $2, updated_at = NOW()
       WHERE sos_id = $1 AND agent_id = $3
         AND (status = $2 OR status = $4)
       RETURNING id, sos_id, agent_id, patient_medical_summary, status,
                 route_coordinates, created_at, updated_at`,
      [sosId, status, request.auth.userId, INTERVENTION_PREVIOUS_STATUS[status]],
    );
    if (result.rowCount) {
      return response.status(200).json({ intervention: result.rows[0] });
    }

    const existing = await pool.query(
      "SELECT status FROM interventions WHERE sos_id = $1 AND agent_id = $2",
      [sosId, request.auth.userId],
    );
    if (!existing.rowCount) {
      return response.status(404).json({
        error: "Intervention introuvable pour cet agent.",
      });
    }
    return response.status(409).json({
      error: "Transition d’intervention invalide.",
      current_status: existing.rows[0].status,
    });
  } catch (error) {
    return next(error);
  }
};

export const alertNeighborResponders = async (request, response, next) => {
  const sosId = request.body?.sos_id;
  if (!validUuid(sosId)) {
    return response.status(400).json({ error: "Identifiant SOS invalide." });
  }
  try {
    const result = await pool.query(
      `SELECT DISTINCT pt.token
       FROM sos_alerts s
       JOIN neighbor_responders nr
         ON nr.is_certified_first_aider = TRUE
       JOIN users u ON u.id = nr.user_id AND u.id <> $2
       JOIN push_tokens pt ON pt.user_id = u.id
       WHERE s.id = $1 AND s.status = 'ACTIVE'
         AND u.last_location IS NOT NULL
         AND ST_DWithin(
           u.last_location::geography, s.location::geography, nr.radius_coverage_m
         )`,
      [sosId, request.auth.userId],
    );
    if (!result.rowCount) {
      const sos = await pool.query(
        "SELECT id FROM sos_alerts WHERE id = $1 AND status = 'ACTIVE'",
        [sosId],
      );
      if (!sos.rowCount) {
        return response.status(404).json({ error: "Aucune alerte SOS active trouvée." });
      }
    }
    await sendExpoPushNotifications(
      result.rows.map((row) => row.token),
      {
        title: "Secouriste de proximité sollicité",
        body: "Une alerte SOS est active près de vous. Ouvrez QuartierPlus pour intervenir.",
        channelId: "sos",
        data: { type: "neighbor_responder", alertId: sosId },
      },
    );
    return response.status(200).json({ notified_count: result.rowCount });
  } catch (error) {
    return next(error);
  }
};
