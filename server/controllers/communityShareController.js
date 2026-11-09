import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const destinationType = (value) => {
  if (value === "alliance") return "ALLIANCE";
  if (value === "group") return "GROUP";
  return null;
};

const pageValue = (value, fallback, maximum) => {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum
    ? parsed
    : null;
};

export const listShareDestinations = async (request, response, next) => {
  const type = destinationType(request.params.type);
  if (!type) {
    return response.status(400).json({ error: "Type de destination invalide." });
  }

  try {
    if (type === "ALLIANCE") {
      const result = await pool.query(
        `SELECT alliance.id, alliance.title AS name, alliance.description,
                alliance.status, alliance.participant_count,
                'ALLIANCE' AS destination_type
         FROM community_alliance_members membership
         JOIN community_alliances alliance ON alliance.id = membership.alliance_id
         WHERE membership.user_id = $1
           AND alliance.status NOT IN ('CANCELLED', 'DISPUTED')
         ORDER BY alliance.updated_at DESC, alliance.created_at DESC`,
        [request.auth.userId],
      );
      return response.status(200).json({ destinations: result.rows });
    }

    const result = await pool.query(
      `SELECT community_group.id, community_group.name,
              community_group.description, community_group.visibility,
              community_group.created_at, 'GROUP' AS destination_type
       FROM community_group_members membership
       JOIN community_groups community_group ON community_group.id = membership.group_id
       WHERE membership.user_id = $1 AND community_group.status = 'ACTIVE'
       ORDER BY community_group.name`,
      [request.auth.userId],
    );
    return response.status(200).json({ destinations: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listDiscoverableGroups = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT community_group.id, community_group.name,
              community_group.description, community_group.created_at,
              COUNT(membership.user_id)::int AS member_count
       FROM community_groups community_group
       LEFT JOIN community_group_members membership
         ON membership.group_id = community_group.id
       WHERE community_group.visibility = 'PUBLIC'
         AND community_group.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM community_group_members current_membership
           WHERE current_membership.group_id = community_group.id
             AND current_membership.user_id = $1
         )
       GROUP BY community_group.id
       ORDER BY community_group.created_at DESC
       LIMIT 100`,
      [request.auth.userId],
    );
    return response.status(200).json({ groups: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const createCommunityGroup = async (request, response, next) => {
  const payload = request.body ?? {};
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const description =
    typeof payload.description === "string" ? payload.description.trim() : "";
  const visibility =
    typeof payload.visibility === "string"
      ? payload.visibility.trim().toUpperCase()
      : "PRIVATE";

  if (!name || name.length > 100 || description.length > 500) {
    return response.status(400).json({
      error: "Le nom du groupe (100 caractères maximum) est obligatoire; la description est limitée à 500 caractères.",
    });
  }
  if (!["PUBLIC", "PRIVATE"].includes(visibility)) {
    return response.status(400).json({ error: "Visibilité de groupe invalide." });
  }

  try {
    const result = await pool.query(
      `WITH created_group AS (
         INSERT INTO community_groups (created_by, name, description, visibility)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, visibility, created_at
       ), owner_membership AS (
         INSERT INTO community_group_members (group_id, user_id, role)
         SELECT id, $1, 'OWNER' FROM created_group
         RETURNING group_id
       )
       SELECT created_group.*
       FROM created_group
       JOIN owner_membership ON owner_membership.group_id = created_group.id`,
      [request.auth.userId, name, description, visibility],
    );
    return response.status(201).json({ group: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const joinCommunityGroup = async (request, response, next) => {
  const groupId = request.params.groupId;
  if (!validId(groupId)) {
    return response.status(400).json({ error: "Identifiant de groupe invalide." });
  }

  try {
    const group = await pool.query(
      `SELECT id FROM community_groups
       WHERE id = $1 AND visibility = 'PUBLIC' AND status = 'ACTIVE'`,
      [groupId],
    );
    if (!group.rowCount) {
      return response.status(404).json({ error: "Groupe public introuvable." });
    }
    await pool.query(
      `INSERT INTO community_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'MEMBER')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, request.auth.userId],
    );
    return response.status(200).json({ joined: true });
  } catch (error) {
    return next(error);
  }
};

export const createPostShare = async (request, response, next) => {
  const postId = request.params.postId;
  const payload = request.body ?? {};
  const type = destinationType(payload.destination_type);
  const targetId = payload.destination_id;
  const comment =
    typeof payload.comment === "string" ? payload.comment.trim() || null : null;

  if (!validId(postId) || !validId(targetId) || !type) {
    return response.status(400).json({ error: "Publication ou destination invalide." });
  }
  if (typeof payload.comment === "string" && payload.comment.trim().length > 1000) {
    return response.status(400).json({ error: "Le commentaire est limité à 1 000 caractères." });
  }
  if (payload.comment !== undefined && typeof payload.comment !== "string") {
    return response.status(400).json({ error: "Le commentaire de partage est invalide." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO community_post_shares (
         post_id, shared_by, target_type, alliance_id, group_id, comment
       )
       SELECT post.id, $2, $3,
              CASE WHEN $3 = 'ALLIANCE' THEN $4::uuid END,
              CASE WHEN $3 = 'GROUP' THEN $4::uuid END,
              $5
       FROM posts post
       WHERE post.id = $1
         AND post.status = 'ACTIVE'
         AND post.media_type IN ('image', 'video')
         AND post.media_url IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_id = post.author_id
         )
         AND (
           NOT $6::boolean OR NOT EXISTS (
             SELECT 1 FROM user_mutes muted
             WHERE muted.muter_id = $2 AND muted.muted_id = post.author_id
           )
         )
         AND (
           ($3 = 'ALLIANCE' AND EXISTS (
             SELECT 1 FROM community_alliance_members membership
             JOIN community_alliances alliance ON alliance.id = membership.alliance_id
             WHERE membership.alliance_id = $4
               AND membership.user_id = $2
               AND alliance.status NOT IN ('CANCELLED', 'DISPUTED')
           ))
           OR ($3 = 'GROUP' AND EXISTS (
             SELECT 1 FROM community_group_members membership
             JOIN community_groups community_group ON community_group.id = membership.group_id
             WHERE membership.group_id = $4
               AND membership.user_id = $2
               AND community_group.status = 'ACTIVE'
           ))
         )
       RETURNING id, target_type, alliance_id, group_id, comment, created_at`,
      [
        postId,
        request.auth.userId,
        type,
        targetId,
        comment,
        env.conflictProtectionEnabled,
      ],
    );
    if (!result.rowCount) {
      return response.status(404).json({
        error: "Publication média ou destination introuvable, ou accès non autorisé.",
      });
    }
    return response.status(201).json({ share: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const listCommunitySharedPosts = async (request, response, next) => {
  const type = destinationType(request.params.type);
  const targetId = request.params.destinationId;
  const limit = pageValue(request.query.limit, 30, 100);
  const offset = pageValue(request.query.offset, 0, 100_000);
  if (!type || !validId(targetId)) {
    return response.status(400).json({ error: "Destination invalide." });
  }
  if (limit === null || limit < 1 || offset === null) {
    return response.status(400).json({ error: "Pagination invalide." });
  }

  try {
    const access = await pool.query(
      type === "ALLIANCE"
        ? `SELECT 1 FROM community_alliance_members membership
           JOIN community_alliances alliance ON alliance.id = membership.alliance_id
           WHERE membership.alliance_id = $1 AND membership.user_id = $2
             AND alliance.status NOT IN ('CANCELLED', 'DISPUTED')`
        : `SELECT 1 FROM community_group_members membership
           JOIN community_groups community_group ON community_group.id = membership.group_id
           WHERE membership.group_id = $1 AND membership.user_id = $2
             AND community_group.status = 'ACTIVE'`,
      [targetId, request.auth.userId],
    );
    if (!access.rowCount) {
      return response.status(404).json({ error: "Fil introuvable ou accès non autorisé." });
    }

    const result = await pool.query(
      `SELECT share.id, share.comment, share.created_at AS shared_at,
              post.id AS post_id, post.caption, post.media_url, post.media_type,
              post.created_at AS post_created_at, post.author_id,
              author.full_name AS author_name,
              author.profile_photo_url AS author_photo_url,
              sharer.full_name AS shared_by_name,
              COALESCE((
                SELECT json_agg(media.media_url ORDER BY media.position)
                FROM post_media_items media
                WHERE media.post_id = post.id
              ), '[]'::json) AS additional_media
       FROM community_post_shares share
       JOIN posts post ON post.id = share.post_id
       JOIN users author ON author.id = post.author_id
       JOIN users sharer ON sharer.id = share.shared_by
       WHERE share.target_type = $1
         AND CASE WHEN $1 = 'ALLIANCE' THEN share.alliance_id = $2
                  ELSE share.group_id = $2 END
         AND post.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_id = post.author_id
         )
         AND (
           NOT $6::boolean OR NOT EXISTS (
             SELECT 1 FROM user_mutes muted
             WHERE muted.muter_id = $3 AND muted.muted_id = post.author_id
           )
         )
       ORDER BY share.created_at DESC
       LIMIT $4 OFFSET $5`,
      [
        type,
        targetId,
        request.auth.userId,
        limit,
        offset,
        env.conflictProtectionEnabled,
      ],
    );
    return response.status(200).json({ posts: result.rows });
  } catch (error) {
    return next(error);
  }
};
