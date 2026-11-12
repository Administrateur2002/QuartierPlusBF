import { Server } from "socket.io";
import { env } from "../config/env.js";
import { authenticateSocket } from "./authSocket.js";
import { registerChannelHandlers } from "./channelHandler.js";
import { registerSosHandlers } from "./sosHandler.js";
import { registerProCommerceHandlers } from "./proCommerceHandler.js";
import { registerConversationHandlers } from "./conversationHandler.js";

export const attachSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: env.socketCorsOrigins.length ? env.socketCorsOrigins : false,
    },
    transports: ["websocket", "polling"],
  });

  io.use(authenticateSocket);
  io.on("connection", (socket) => {
    registerSosHandlers(io, socket);
    registerChannelHandlers(io, socket);
    registerConversationHandlers(socket);
    registerProCommerceHandlers(socket);
    socket.on("disconnect", () => {
      socket.data.presenceLocation = null;
    });
  });

  return io;
};
