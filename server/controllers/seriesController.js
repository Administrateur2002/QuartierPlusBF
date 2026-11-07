import { pool } from "../db/pool.js";

const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const text = (value, maxLength) =>
  typeof value === "string" && value.trim().length <= maxLength
    ? value.trim()
    : null;

const isHttpsUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const getCreateSeriesInput = (body) => {
  const title = text(body?.title, 160);
  const description = text(body?.description ?? "", 10_000);
  const posterUrl = body?.poster_url == null ? null : text(body.poster_url, 2_000);
  const countryCode = body?.country_code == null ? null : text(body.country_code, 3);
  const languageCode = text(body?.language_code ?? "fr", 12);
  const cultureTags = body?.culture_tags ?? [];
  const credits = body?.credits ?? [];
  if (
    !title || description === null || !languageCode ||
    (body?.poster_url != null && (!posterUrl || !isHttpsUrl(posterUrl))) ||
    (body?.country_code != null && !countryCode) ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(languageCode) ||
    !Array.isArray(cultureTags) || cultureTags.length > 10 ||
    cultureTags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 48) ||
    !Array.isArray(credits) || credits.length > 30 ||
    credits.some((credit) =>
      !credit || typeof credit.name !== "string" || !credit.name.trim() ||
      credit.name.length > 100 ||
      !["ACTOR", "DIRECTOR", "WRITER", "EDITOR", "TRANSLATOR", "OTHER"].includes(credit.role)
    )
  ) return null;
  return { title, description, posterUrl, countryCode, languageCode, cultureTags, credits };
};

export const listSeries = async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.creator_id, s.title, s.description, s.poster_url,
              s.country_code, s.language_code, s.culture_tags, s.credits,
              s.created_at,
              COUNT(e.id)::int AS episode_count
       FROM series s
       LEFT JOIN series_seasons season ON season.series_id = s.id
       LEFT JOIN series_episodes e ON e.season_id = season.id AND e.is_published = TRUE
       WHERE s.status = 'PUBLISHED'
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT 100`,
    );
    return response.status(200).json({ series: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listMySeries = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.title, s.description, s.poster_url, s.country_code,
              s.language_code, s.culture_tags, s.credits, s.status, s.created_at
       FROM series s WHERE s.creator_id = $1 ORDER BY s.updated_at DESC LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ series: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const getSeries = async (request, response, next) => {
  if (!isUuid(request.params.seriesId)) return response.status(400).json({ error: "Identifiant de série invalide." });
  try {
    const result = await pool.query(
      `SELECT s.id, s.creator_id, s.title, s.description, s.poster_url,
              s.country_code, s.language_code, s.culture_tags, s.credits, s.status,
              season.id AS season_id, season.season_number, season.title AS season_title,
              e.id AS episode_id, e.episode_number, e.title AS episode_title,
              e.description AS episode_description, e.video_url, e.duration_seconds,
              e.subtitles, e.release_at, p.position_seconds, p.completed
       FROM series s
       LEFT JOIN series_seasons season ON season.series_id = s.id
       LEFT JOIN series_episodes e ON e.season_id = season.id AND e.is_published = TRUE
       LEFT JOIN series_episode_progress p ON p.episode_id = e.id AND p.user_id = $2
       WHERE s.id = $1 AND (s.status = 'PUBLISHED' OR s.creator_id = $2)
       ORDER BY season.season_number, e.episode_number`,
      [request.params.seriesId, request.auth?.userId ?? null],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Série introuvable." });
    const first = result.rows[0];
    const seasons = new Map();
    for (const row of result.rows) {
      if (!row.season_id) continue;
      if (!seasons.has(row.season_id)) {
        seasons.set(row.season_id, {
          id: row.season_id,
          season_number: row.season_number,
          title: row.season_title,
          episodes: [],
        });
      }
      if (row.episode_id) {
        seasons.get(row.season_id).episodes.push({
          id: row.episode_id,
          episode_number: row.episode_number,
          title: row.episode_title,
          description: row.episode_description,
          video_url: row.video_url,
          duration_seconds: row.duration_seconds,
          subtitles: row.subtitles,
          release_at: row.release_at,
          progress_seconds: row.position_seconds ?? 0,
          completed: row.completed ?? false,
        });
      }
    }
    return response.status(200).json({
      series: {
        id: first.id,
        creator_id: first.creator_id,
        title: first.title,
        description: first.description,
        poster_url: first.poster_url,
        country_code: first.country_code,
        language_code: first.language_code,
        culture_tags: first.culture_tags,
        credits: first.credits,
        status: first.status,
        seasons: [...seasons.values()],
      },
    });
  } catch (error) {
    return next(error);
  }
};

export const getResume = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id AS series_id, s.title AS series_title, e.id AS episode_id,
              e.title AS episode_title, e.video_url, e.duration_seconds,
              p.position_seconds, p.updated_at
       FROM series_episode_progress p
       JOIN series_episodes e ON e.id = p.episode_id
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id
       WHERE p.user_id = $1 AND p.completed = FALSE AND p.position_seconds > 0
         AND e.is_published = TRUE AND s.status = 'PUBLISHED' AND e.video_url IS NOT NULL
       ORDER BY p.updated_at DESC LIMIT 1`,
      [request.auth.userId],
    );
    return response.status(200).json({ resume: result.rows[0] ?? null });
  } catch (error) {
    return next(error);
  }
};

export const publishSeries = async (request, response, next) => {
  if (!isUuid(request.params.seriesId)) return response.status(400).json({ error: "Identifiant de série invalide." });
  try {
    const result = await pool.query(
      `UPDATE series s SET status = 'PUBLISHED', updated_at = NOW()
       WHERE s.id = $1 AND s.creator_id = $2 AND s.status <> 'ARCHIVED'
         AND EXISTS (
           SELECT 1 FROM series_seasons season
           JOIN series_episodes e ON e.season_id = season.id
           WHERE season.series_id = s.id AND e.is_published = TRUE
             AND e.video_url LIKE 'https://%'
         )
       RETURNING id, title, status`,
      [request.params.seriesId, request.auth.userId],
    );
    if (!result.rowCount) return response.status(409).json({ error: "Série inaccessible ou aucun épisode vidéo HTTPS publié." });
    return response.status(200).json({ series: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const createSeries = async (request, response, next) => {
  const input = getCreateSeriesInput(request.body);
  if (!input) return response.status(400).json({ error: "Informations de série invalides." });
  try {
    const result = await pool.query(
      `INSERT INTO series
         (creator_id, title, description, poster_url, country_code,
          language_code, culture_tags, credits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id, creator_id, title, description, poster_url, country_code,
                 language_code, culture_tags, credits, status, created_at`,
      [request.auth.userId, input.title, input.description, input.posterUrl,
        input.countryCode, input.languageCode, input.cultureTags,
        JSON.stringify(input.credits)],
    );
    return response.status(201).json({ series: result.rows[0] });
  } catch (error) {
    if (error.code === "23503") return response.status(400).json({ error: "Pays introuvable." });
    return next(error);
  }
};

export const createSeason = async (request, response, next) => {
  const title = text(request.body?.title, 160);
  const description = text(request.body?.description ?? "", 10_000);
  const seasonNumber = request.body?.season_number;
  if (!isUuid(request.params.seriesId) || !title || description === null ||
      !Number.isSafeInteger(seasonNumber) || seasonNumber < 1 || seasonNumber > 100) {
    return response.status(400).json({ error: "Informations de saison invalides." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO series_seasons (series_id, season_number, title, description)
       SELECT id, $3, $4, $5 FROM series
       WHERE id = $1 AND creator_id = $2 AND status <> 'ARCHIVED'
       RETURNING id, series_id, season_number, title, description`,
      [request.params.seriesId, request.auth.userId, seasonNumber, title, description],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Série introuvable ou accès refusé." });
    return response.status(201).json({ season: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return response.status(409).json({ error: "Cette saison existe déjà." });
    return next(error);
  }
};

export const createEpisode = async (request, response, next) => {
  const title = text(request.body?.title, 160);
  const description = text(request.body?.description ?? "", 10_000);
  const videoUrl = request.body?.video_url == null ? null : text(request.body.video_url, 2_000);
  const subtitles = request.body?.subtitles ?? [];
  const episodeNumber = request.body?.episode_number;
  const duration = request.body?.duration_seconds ?? null;
  if (!isUuid(request.params.seasonId) || !title || description === null ||
      (request.body?.video_url != null && (!videoUrl || !isHttpsUrl(videoUrl))) ||
      (request.body?.is_published === true && !videoUrl) ||
      !Number.isSafeInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 1000 ||
      (duration !== null && (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400)) ||
      !Array.isArray(subtitles) || subtitles.length > 20 ||
      subtitles.some((item) => !item || typeof item.language_code !== "string" ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(item.language_code) ||
        typeof item.url !== "string" || !isHttpsUrl(item.url) || item.url.length > 2_000)) {
    return response.status(400).json({ error: "Informations d'épisode invalides." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO series_episodes
         (season_id, episode_number, title, description, video_url,
          duration_seconds, subtitles, is_published)
       SELECT season.id, $3, $4, $5, $6, $7, $8::jsonb, $9
       FROM series_seasons season JOIN series s ON s.id = season.series_id
       WHERE season.id = $1 AND s.creator_id = $2 AND s.status <> 'ARCHIVED'
       RETURNING id, season_id, episode_number, title, description, video_url,
                 duration_seconds, subtitles, is_published`,
      [request.params.seasonId, request.auth.userId, episodeNumber, title, description,
        videoUrl, duration, JSON.stringify(subtitles), request.body?.is_published === true],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Saison introuvable ou accès refusé." });
    return response.status(201).json({ episode: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return response.status(409).json({ error: "Cet épisode existe déjà." });
    return next(error);
  }
};

export const saveEpisodeProgress = async (request, response, next) => {
  const position = request.body?.position_seconds;
  const completed = request.body?.completed === true;
  if (!isUuid(request.params.episodeId) || !Number.isSafeInteger(position) || position < 0 || position > 86_400) {
    return response.status(400).json({ error: "Progression invalide." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO series_episode_progress (user_id, episode_id, position_seconds, completed)
       SELECT $1, e.id, $3, $4 FROM series_episodes e
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id
       WHERE e.id = $2 AND e.is_published = TRUE AND s.status = 'PUBLISHED'
       ON CONFLICT (user_id, episode_id) DO UPDATE SET
         position_seconds = EXCLUDED.position_seconds,
         completed = series_episode_progress.completed OR EXCLUDED.completed,
         updated_at = NOW()
       RETURNING episode_id, position_seconds, completed, updated_at`,
      [request.auth.userId, request.params.episodeId, position, completed],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Épisode publié introuvable." });
    return response.status(200).json({ progress: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const createEpisodePoll = async (request, response, next) => {
  const question = text(request.body?.question ?? "Que doit-il se passer dans le prochain épisode ?", 240);
  const options = request.body?.options;
  const closesAt = Date.parse(request.body?.closes_at);
  if (!isUuid(request.params.episodeId) || !question || !Array.isArray(options) ||
      options.length < 2 || options.length > 6 ||
      options.some((option) => typeof option !== "string" || !option.trim() || option.trim().length > 240) ||
      new Set(options.map((option) => option.trim().toLocaleLowerCase())).size !== options.length ||
      !Number.isFinite(closesAt) || closesAt <= Date.now() || closesAt > Date.now() + 90 * 86_400_000) {
    return response.status(400).json({ error: "Question, choix ou date de clôture invalides." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const episode = await client.query(
      `SELECT e.id FROM series_episodes e
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id
       WHERE e.id = $1 AND s.creator_id = $2 AND e.is_published = TRUE`,
      [request.params.episodeId, request.auth.userId],
    );
    if (!episode.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "Épisode introuvable ou accès refusé." });
    }
    const poll = await client.query(
      `INSERT INTO series_episode_polls (episode_id, question, closes_at)
       VALUES ($1, $2, $3) RETURNING id, episode_id, question, closes_at`,
      [request.params.episodeId, question, new Date(closesAt).toISOString()],
    );
    const choices = [];
    for (const [index, label] of options.entries()) {
      const option = await client.query(
        `INSERT INTO series_episode_poll_options (poll_id, label, sort_order)
         VALUES ($1, $2, $3) RETURNING id, label, sort_order`,
        [poll.rows[0].id, label.trim(), index + 1],
      );
      choices.push(option.rows[0]);
    }
    await client.query("COMMIT");
    return response.status(201).json({ poll: { ...poll.rows[0], options: choices } });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return response.status(409).json({ error: "Un vote existe déjà pour cet épisode." });
    return next(error);
  } finally {
    client.release();
  }
};

export const getEpisodePoll = async (request, response, next) => {
  if (!isUuid(request.params.episodeId)) return response.status(400).json({ error: "Identifiant d'épisode invalide." });
  try {
    const result = await pool.query(
      `SELECT p.id, p.episode_id, p.question, p.closes_at,
              json_agg(json_build_object('id', o.id, 'label', o.label, 'sort_order', o.sort_order)
                       ORDER BY o.sort_order) AS options,
              EXISTS (
                SELECT 1 FROM series_episode_votes v
                WHERE v.poll_id = p.id AND v.user_id = $2
              ) AS has_voted
       FROM series_episode_polls p
       JOIN series_episode_poll_options o ON o.poll_id = p.id
       JOIN series_episodes e ON e.id = p.episode_id
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id
       WHERE p.episode_id = $1 AND e.is_published = TRUE AND s.status = 'PUBLISHED'
       GROUP BY p.id`,
      [request.params.episodeId, request.auth?.userId ?? null],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Vote introuvable." });
    return response.status(200).json({ poll: result.rows[0], is_open: new Date(result.rows[0].closes_at) > new Date() });
  } catch (error) {
    return next(error);
  }
};

export const voteOnEpisodePoll = async (request, response, next) => {
  const { episodeId } = request.params;
  const optionId = request.body?.option_id;
  if (!isUuid(episodeId) || !isUuid(optionId)) return response.status(400).json({ error: "Choix de vote invalide." });
  try {
    const result = await pool.query(
      `INSERT INTO series_episode_votes (poll_id, option_id, user_id)
       SELECT p.id, o.id, $3 FROM series_episode_polls p
       JOIN series_episode_poll_options o ON o.poll_id = p.id
       JOIN series_episodes e ON e.id = p.episode_id
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id
       WHERE p.episode_id = $1 AND o.id = $2 AND p.closes_at > NOW()
         AND e.is_published = TRUE AND s.status = 'PUBLISHED' AND s.creator_id <> $3
       ON CONFLICT (poll_id, user_id) DO NOTHING
       RETURNING poll_id`,
      [episodeId, optionId, request.auth.userId],
    );
    if (!result.rowCount) return response.status(409).json({ error: "Vote clôturé, choix invalide, déjà compté ou non autorisé." });
    return response.status(201).json({ recorded: true });
  } catch (error) {
    return next(error);
  }
};

export const getEpisodePollResults = async (request, response, next) => {
  if (!isUuid(request.params.episodeId)) return response.status(400).json({ error: "Identifiant d'épisode invalide." });
  try {
    const result = await pool.query(
      `SELECT p.id, p.question, p.closes_at, o.id AS option_id, o.label,
              COUNT(v.user_id)::int AS votes
       FROM series_episode_polls p
       JOIN series_episodes e ON e.id = p.episode_id
       JOIN series_seasons season ON season.id = e.season_id
       JOIN series s ON s.id = season.series_id AND s.creator_id = $2
       JOIN series_episode_poll_options o ON o.poll_id = p.id
       LEFT JOIN series_episode_votes v ON v.option_id = o.id AND v.poll_id = p.id
       WHERE p.episode_id = $1
       GROUP BY p.id, o.id ORDER BY o.sort_order`,
      [request.params.episodeId, request.auth.userId],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Résultats introuvables ou accès réservé au créateur." });
    return response.status(200).json({ results: result.rows });
  } catch (error) {
    return next(error);
  }
};