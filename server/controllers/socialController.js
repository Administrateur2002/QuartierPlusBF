import { pool } from "../db/pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId = (value) =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const requestAlliance = async (request, response, next) => {
  const recipientId = request.params.userId;
  const requesterId = request.auth.userId;
  if (!validId(recipientId) || recipientId === requesterId) {
    return response.status(400).json({ error: "Profil invalide." });
  }
  try {
    const recipient = await pool.query("SELECT id FROM users WHERE id = $1", [
      recipientId,
    ]);
    if (!recipient.rowCount) {
      return response.status(404).json({ error: "Profil introuvable." });
    }
    const existing = await pool.query(
      `SELECT status FROM user_alliances
       WHERE requester_id = $1 AND recipient_id = $2`,
      [requesterId, recipientId],
    );
    if (existing.rowCount) {
      return response.status(200).json({ status: existing.rows[0].status });
    }
    const reciprocal = await pool.query(
      `SELECT status FROM user_alliances
       WHERE requester_id = $1 AND recipient_id = $2`,
      [recipientId, requesterId],
    );
    if (reciprocal.rows[0]?.status === "PENDING") {
      await pool.query(
        `UPDATE user_alliances SET status = 'ALLIED', updated_at = NOW()
         WHERE (requester_id = $1 AND recipient_id = $2)
            OR (requester_id = $2 AND recipient_id = $1)`,
        [requesterId, recipientId],
      );
      return response.status(200).json({ status: "ALLIED" });
    }
    await pool.query(
      `INSERT INTO user_alliances (requester_id, recipient_id)
       VALUES ($1, $2)
       ON CONFLICT (requester_id, recipient_id) DO NOTHING`,
      [requesterId, recipientId],
    );
    return response.status(201).json({ status: "PENDING" });
  } catch (error) {
    return next(error);
  }
};

export const acceptAlliance = async (request, response, next) => {
  const requesterId = request.params.userId;
  const recipientId = request.auth.userId;
  if (!validId(requesterId) || requesterId === recipientId) {
    return response.status(400).json({ error: "Profil invalide." });
  }
  try {
    const result = await pool.query(
      `UPDATE user_alliances SET status = 'ALLIED', updated_at = NOW()
       WHERE requester_id = $1 AND recipient_id = $2 AND status = 'PENDING'
       RETURNING requester_id`,
      [requesterId, recipientId],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "Demande d’alliance introuvable." });
    }
    await pool.query(
      `INSERT INTO user_alliances (requester_id, recipient_id, status)
       VALUES ($1, $2, 'ALLIED')
       ON CONFLICT (requester_id, recipient_id)
       DO UPDATE SET status = 'ALLIED', updated_at = NOW()`,
      [recipientId, requesterId],
    );
    return response.status(200).json({ status: "ALLIED" });
  } catch (error) {
    return next(error);
  }
};

export const listAllies = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT users.id, users.full_name AS name, MAX(alliance.updated_at) AS allied_at
       FROM user_alliances alliance
       JOIN users ON users.id = CASE
         WHEN alliance.requester_id = $1 THEN alliance.recipient_id
         ELSE alliance.requester_id END
       WHERE (alliance.requester_id = $1 OR alliance.recipient_id = $1)
         AND alliance.status = 'ALLIED'
       GROUP BY users.id, users.full_name
       ORDER BY users.full_name NULLS LAST`,
      [request.auth.userId],
    );
    return response.status(200).json({ allies: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const listBlockedUsers = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT users.id, users.full_name AS name, user_blocks.created_at AS blocked_at
       FROM user_blocks JOIN users ON users.id = user_blocks.blocked_id
       WHERE user_blocks.blocker_id = $1
       ORDER BY user_blocks.created_at DESC`,
      [request.auth.userId],
    );
    return response.status(200).json({ blocked_users: result.rows });
  } catch (error) {
    return next(error);
  }
};

export const blockUser = async (request, response, next) => {
  const blockedId = request.params.userId;
  if (!validId(blockedId) || blockedId === request.auth.userId) {
    return response.status(400).json({ error: "Profil à bloquer invalide." });
  }
  try {
    const user = await pool.query("SELECT id FROM users WHERE id = $1", [blockedId]);
    if (!user.rowCount) return response.status(404).json({ error: "Profil introuvable." });
    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [request.auth.userId, blockedId],
    );
    return response.status(200).json({ blocked: true });
  } catch (error) {
    return next(error);
  }
};

export const unblockUser = async (request, response, next) => {
  const blockedId = request.params.userId;
  if (!validId(blockedId) || blockedId === request.auth.userId) {
    return response.status(400).json({ error: "Profil à débloquer invalide." });
  }
  try {
    await pool.query(
      "DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
      [request.auth.userId, blockedId],
    );
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
};

export const removeAlliance = async (request, response, next) => {
  const otherId = request.params.userId;
  if (!validId(otherId) || otherId === request.auth.userId) {
    return response.status(400).json({ error: "Profil invalide." });
  }
  try {
    await pool.query(
      `DELETE FROM user_alliances
       WHERE (requester_id = $1 AND recipient_id = $2)
          OR (requester_id = $2 AND recipient_id = $1)`,
      [request.auth.userId, otherId],
    );
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
};

export const togglePostLike = async (request, response, next) => {
  const postId = request.params.postId;
  if (!validId(postId)) return response.status(400).json({ error: "Publication invalide." });
  try {
    const exists = await pool.query(
      "SELECT id FROM posts WHERE id = $1 AND status = 'ACTIVE'",
      [postId],
    );
    if (!exists.rowCount) return response.status(404).json({ error: "Publication introuvable." });
    const removed = await pool.query(
      "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING post_id",
      [postId, request.auth.userId],
    );
    if (!removed.rowCount) {
      await pool.query(
        "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [postId, request.auth.userId],
      );
    }
    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1",
      [postId],
    );
    return response.status(200).json({
      liked: !removed.rowCount,
      count: count.rows[0].count,
    });
  } catch (error) {
    return next(error);
  }
};

export const listPostComments = async (request, response, next) => {
  const postId = request.params.postId;
  const limit = Number(request.query?.limit ?? 30);
  const offset = Number(request.query?.offset ?? 0);
  if (
    !validId(postId) ||
    !Number.isInteger(limit) || limit < 1 || limit > 50 ||
    !Number.isInteger(offset) || offset < 0 || offset > 10000
  ) {
    return response.status(400).json({ error: "Paramètres des commentaires invalides." });
  }
  try {
    const result = await pool.query(
      `SELECT comment.id, comment.content, comment.created_at,
              comment.edited_at, comment.parent_comment_id,
              user_profile.id AS user_id, user_profile.full_name AS user_name,
              (SELECT COUNT(*)::int FROM post_comment_likes comment_like
               WHERE comment_like.comment_id = comment.id) AS likes_count,
              EXISTS (SELECT 1 FROM post_comment_likes own_like
                WHERE own_like.comment_id = comment.id AND own_like.user_id = $4) AS liked_by_me
       FROM post_comments comment JOIN users user_profile ON user_profile.id = comment.user_id
       WHERE comment.post_id = $1
       ORDER BY comment.created_at DESC, comment.id DESC
       LIMIT $2 OFFSET $3`,
            [postId, limit + 1, offset, request.auth.userId],
    );
    const hasMore = result.rows.length > limit;
    const comments = hasMore ? result.rows.slice(0, limit) : result.rows;
    return response.status(200).json({
      comments,
      has_more: hasMore,
      next_offset: offset + comments.length,
    });
  } catch (error) {
    return next(error);
  }
};

export const createPostComment = async (request, response, next) => {
  const postId = request.params.postId;
  const rawParentId = request.body?.parent_comment_id;
  const parentCommentId = rawParentId == null ? null : rawParentId;
  const content = typeof request.body?.content === "string"
    ? request.body.content.trim()
    : "";
  if (
    !validId(postId) || !content || content.length > 1000 ||
    (parentCommentId !== null && !validId(parentCommentId))
  ) {
    return response.status(400).json({ error: "Commentaire invalide (1 à 1 000 caractères)." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, content, parent_comment_id)
       SELECT post.id, $2, $3, $4 FROM posts post
       WHERE post.id = $1 AND post.status = 'ACTIVE'
         AND ($4::uuid IS NULL OR EXISTS (
           SELECT 1 FROM post_comments parent
           WHERE parent.id = $4 AND parent.post_id = post.id
         ))
       RETURNING id, post_id, user_id, content, parent_comment_id, created_at`,
      [postId, request.auth.userId, content, parentCommentId],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Publication ou commentaire parent introuvable." });
    return response.status(201).json({ comment: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const updatePostComment = async (request, response, next) => {
  const commentId = request.params.commentId;
  const content = typeof request.body?.content === "string"
    ? request.body.content.trim()
    : "";
  if (!validId(commentId) || !content || content.length > 1000) {
    return response.status(400).json({ error: "Commentaire invalide (1 à 1 000 caractères)." });
  }
  try {
    const result = await pool.query(
      `UPDATE post_comments SET content = $3, edited_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, content, edited_at`,
      [commentId, request.auth.userId, content],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Commentaire introuvable." });
    return response.status(200).json({ comment: result.rows[0] });
  } catch (error) {
    return next(error);
  }
};

export const deletePostComment = async (request, response, next) => {
  const commentId = request.params.commentId;
  if (!validId(commentId)) return response.status(400).json({ error: "Commentaire invalide." });
  try {
    const result = await pool.query(
      "DELETE FROM post_comments WHERE id = $1 AND user_id = $2 RETURNING id",
      [commentId, request.auth.userId],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Commentaire introuvable." });
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
};

export const togglePostCommentLike = async (request, response, next) => {
  const commentId = request.params.commentId;
  if (!validId(commentId)) return response.status(400).json({ error: "Commentaire invalide." });
  try {
    const comment = await pool.query(
      "SELECT id FROM post_comments WHERE id = $1",
      [commentId],
    );
    if (!comment.rowCount) return response.status(404).json({ error: "Commentaire introuvable." });
    const removed = await pool.query(
      "DELETE FROM post_comment_likes WHERE comment_id = $1 AND user_id = $2 RETURNING comment_id",
      [commentId, request.auth.userId],
    );
    if (!removed.rowCount) {
      await pool.query(
        "INSERT INTO post_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [commentId, request.auth.userId],
      );
    }
    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM post_comment_likes WHERE comment_id = $1",
      [commentId],
    );
    return response.status(200).json({ liked: !removed.rowCount, count: count.rows[0].count });
  } catch (error) {
    return next(error);
  }
};

export const updateLocationShare = async (request, response, next) => {
  const { mode, latitude, longitude, duration_hours: durationHours } =
    request.body ?? {};
  const selectedIds = request.body?.user_ids;
  if (
    !["PRIVATE", "ALLIES", "SELECTED"].includes(mode) ||
    !Number.isFinite(Number(latitude)) ||
    Math.abs(Number(latitude)) > 90 ||
    !Number.isFinite(Number(longitude)) ||
    Math.abs(Number(longitude)) > 180 ||
    !(durationHours === null || [1, 8, 24].includes(durationHours)) ||
    (mode === "SELECTED" &&
      (!Array.isArray(selectedIds) ||
        selectedIds.length < 1 ||
        selectedIds.length > 100 ||
        selectedIds.some((id) => !validId(id))))
  ) {
    return response.status(400).json({ error: "Paramètres de partage de position invalides." });
  }
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (mode === "SELECTED") {
        const allies = await client.query(
          `SELECT count(*)::int AS count FROM user_alliances
           WHERE status = 'ALLIED'
             AND (($1 = requester_id AND recipient_id = ANY($2::uuid[]))
               OR ($1 = recipient_id AND requester_id = ANY($2::uuid[])))`,
          [request.auth.userId, selectedIds],
        );
        if (allies.rows[0].count !== new Set(selectedIds).size) {
          await client.query("ROLLBACK");
          return response.status(403).json({ error: "Choisissez uniquement parmi vos alliés." });
        }
      }
      await client.query(
        `INSERT INTO user_location_shares (user_id, location, mode, expires_at, updated_at)
         VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4,
           CASE WHEN $5::int IS NULL THEN NULL
             ELSE NOW() + ($5::text || ' hours')::interval END, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           location = EXCLUDED.location, mode = EXCLUDED.mode,
           expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [request.auth.userId, Number(latitude), Number(longitude), mode, durationHours],
      );
      await client.query(
        "DELETE FROM user_location_share_recipients WHERE user_id = $1",
        [request.auth.userId],
      );
      if (mode === "SELECTED") {
        await client.query(
          `INSERT INTO user_location_share_recipients (user_id, recipient_id)
           SELECT $1, unnest($2::uuid[])`,
          [request.auth.userId, selectedIds],
        );
      }
      await client.query("COMMIT");
      return response.status(200).json({
        mode,
        expires_at: durationHours === null
          ? null
          : new Date(Date.now() + durationHours * 3_600_000).toISOString(),
      });
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

export const getLocationShare = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT mode, expires_at FROM user_location_shares
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [request.auth.userId],
    );
    const share = result.rows[0];
    if (!share) return response.status(200).json({ mode: "PRIVATE", user_ids: [] });
    const recipients = share.mode === "SELECTED"
      ? await pool.query(
          "SELECT recipient_id FROM user_location_share_recipients WHERE user_id = $1",
          [request.auth.userId],
        )
      : { rows: [] };
    return response.status(200).json({
      mode: share.mode,
      expires_at: share.expires_at,
      user_ids: recipients.rows.map((row) => row.recipient_id),
    });
  } catch (error) {
    return next(error);
  }
};

export const refreshLocationShare = async (request, response, next) => {
  const { latitude, longitude } = request.body ?? {};
  if (
    !Number.isFinite(Number(latitude)) ||
    Math.abs(Number(latitude)) > 90 ||
    !Number.isFinite(Number(longitude)) ||
    Math.abs(Number(longitude)) > 180
  ) {
    return response.status(400).json({ error: "Coordonnées de position invalides." });
  }
  try {
    const result = await pool.query(
      `UPDATE user_location_shares
       SET location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           updated_at = NOW()
       WHERE user_id = $3 AND mode <> 'PRIVATE'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING updated_at`,
      [Number(latitude), Number(longitude), request.auth.userId],
    );
    if (!result.rowCount) {
      return response.status(409).json({ error: "Le partage de position a expiré ou est arrêté." });
    }
    return response.status(200).json({ updated_at: result.rows[0].updated_at });
  } catch (error) {
    return next(error);
  }
};

export const listSharedLocations = async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT users.id, users.full_name AS name,
              ST_Y(share.location::geometry) AS latitude,
              ST_X(share.location::geometry) AS longitude,
              share.updated_at, share.expires_at
       FROM user_location_shares share
       JOIN users ON users.id = share.user_id
       WHERE share.user_id <> $1
         AND (share.expires_at IS NULL OR share.expires_at > NOW())
         AND (
           (share.mode = 'ALLIES' AND EXISTS (
             SELECT 1 FROM user_alliances alliance
             WHERE alliance.status = 'ALLIED'
               AND ((alliance.requester_id = share.user_id AND alliance.recipient_id = $1)
                 OR (alliance.recipient_id = share.user_id AND alliance.requester_id = $1))
           ))
           OR (share.mode = 'SELECTED' AND EXISTS (
             SELECT 1 FROM user_location_share_recipients recipient
             WHERE recipient.user_id = share.user_id AND recipient.recipient_id = $1
           ))
         )
       ORDER BY share.updated_at DESC`,
      [request.auth.userId],
    );
    return response.status(200).json({ locations: result.rows });
  } catch (error) {
    return next(error);
  }
};
