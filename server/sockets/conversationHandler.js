import { pool } from "../db/pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const emitError = (socket, acknowledgement, error) => {
  const result = { error };
  if (typeof acknowledgement === "function") acknowledgement(result);
  socket.emit("private:error", result);
};

export const registerConversationHandlers = (socket) => {
  socket.on("join_conversation", async (payload, acknowledgement) => {
    const conversationId =
      typeof payload?.conversation_id === "string"
        ? payload.conversation_id
        : "";
    if (!UUID_PATTERN.test(conversationId)) {
      emitError(socket, acknowledgement, "Identifiant de conversation invalide.");
      return;
    }
    try {
      const membership = await pool.query(
        `SELECT 1
         FROM conversation_participants own
         WHERE own.conversation_id = $1 AND own.user_id = $2
           AND NOT EXISTS (
             SELECT 1
             FROM conversation_participants other
             JOIN user_blocks blocked
               ON (blocked.blocker_id = $2 AND blocked.blocked_id = other.user_id)
               OR (blocked.blocker_id = other.user_id AND blocked.blocked_id = $2)
             WHERE other.conversation_id = own.conversation_id
               AND other.user_id <> $2
           )`,
        [conversationId, socket.data.user.id],
      );
      if (!membership.rowCount) {
        emitError(socket, acknowledgement, "Conversation introuvable ou inaccessible.");
        return;
      }
      await socket.join(`private-conversation:${conversationId}`);
      if (typeof acknowledgement === "function") {
        acknowledgement({ ok: true, conversation_id: conversationId });
      }
    } catch (error) {
      emitError(socket, acknowledgement, "Impossible de rejoindre cette conversation.");
      console.error("Unable to authorize private conversation socket room:", error);
    }
  });

  socket.on("leave_conversation", (payload) => {
    const conversationId =
      typeof payload?.conversation_id === "string"
        ? payload.conversation_id
        : "";
    if (UUID_PATTERN.test(conversationId)) {
      void socket.leave(`private-conversation:${conversationId}`);
    }
  });
};
