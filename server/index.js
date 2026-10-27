import express from "express";
import { env } from "./config/env.js";
import { getMonetizationConfig } from "./controllers/eventsController.js";
import { pool } from "./db/pool.js";
import authRoutes from "./routes/authRoutes.js";
import channelRoutes from "./routes/channelRoutes.js";
import conversationRoutes from "./routes/conversationRoutes.js";
import eventsRoutes from "./routes/eventsRoutes.js";
import livekitRoutes from "./routes/livekitRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import mapRoutes from "./routes/mapRoutes.js";
import marketplaceRoutes from "./routes/marketplaceRoutes.js";
import postsRoutes from "./routes/postsRoutes.js";
import proRoutes from "./routes/proRoutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import publicMapRoutes from "./routes/publicMapRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import restSosRoutes from "./routes/restSosRoutes.js";
import sosRoutes from "./routes/sosRoutes.js";
import ticketsRoutes from "./routes/ticketsRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import proCommerceRoutes from "./routes/proCommerceRoutes.js";
import { createServer } from "node:http";
import { attachSocketServer } from "./sockets/index.js";
import { handleHealth } from "./health.js";
import { ensureDefaultChannels } from "./services/defaultChannels.js";
import { verifySmtpTransport } from "./services/email.js";
import { captureFedaPayRawBody } from "./middlewares/fedapayRawBody.js";
import { scheduleProDeliveryLocationCleanup } from "./services/proCommerceCleanup.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  express.json({
    limit: "32kb",
    verify: captureFedaPayRawBody,
  }),
);
app.get("/health", handleHealth);
app.get(
  ["/api/v1/monetization/config", "/v1/monetization/config"],
  getMonetizationConfig,
);
app.use(["/api/v1/public", "/v1/public"], publicRoutes);
app.use(["/api/v1/public/map", "/v1/public/map"], publicMapRoutes);
app.use(["/api/v1", "/v1"], postsRoutes);
app.use(["/api/v1/sos", "/v1/sos"], sosRoutes);
app.use(["/api/v1/sos", "/v1/sos"], restSosRoutes);
app.use(["/api/v1/auth", "/v1/auth"], authRoutes);
app.use(["/api/v1/channels", "/v1/channels"], channelRoutes);
app.use(["/api/v1/conversations", "/v1/conversations"], conversationRoutes);
app.use(["/api/v1/map", "/v1/map"], mapRoutes);
app.use(["/api/v1/marketplace", "/v1/marketplace"], marketplaceRoutes);
app.use(["/api/v1/reports", "/v1/reports"], reportRoutes);
app.use(["/api/v1/events", "/v1/events"], eventsRoutes);
app.use(["/api/v1/livekit", "/v1/livekit"], livekitRoutes);
app.use(["/api/v1/payments", "/v1/payments"], paymentRoutes);
app.use(["/api/v1/pro", "/v1/pro"], proRoutes);
app.use(["/api/v1/pro-commerce", "/v1/pro-commerce"], proCommerceRoutes);
app.use(["/api/v1/tickets", "/v1/tickets"], ticketsRoutes);
app.use(["/api/v1/users", "/v1/users"], userRoutes);
app.use(["/api/v1/admin", "/v1/admin"], adminRoutes);
app.use((error, _request, response, _next) => {
  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
  const code =
    typeof error.code === "string"
      ? error.code
      : `HTTP_${status}`;
  const reason =
    typeof error.reason === "string"
      ? error.reason
      : status === 500
        ? "Une erreur interne est survenue."
        : `${error.message} (code ${code}).`;
  const redact = (value) => {
    let safe = value;
    for (const secret of [
      env.jwtSecret,
      env.databaseUrl,
      env.ticketQrSecret,
      env.smsDeliveryToken,
      env.smtpPass,
      env.emailApiKey,
      env.adminTestEmailToken,
      env.fedapaySecretKey,
      env.fedapayPublicKey,
      env.fedapayWebhookSecret,
      env.cloudinaryApiKey,
      env.cloudinaryApiSecret,
      env.livekitApiKey,
      env.livekitApiSecret,
    ]) {
      if (secret) safe = safe.replaceAll(secret, "[masqué]");
    }
    return safe;
  };
  console.error("Unhandled API error:", {
    status,
    code,
    reason: redact(reason),
  });
  return response.status(status).json({
    error:
      status === 500
        ? "Une erreur interne est survenue."
        : redact(error.message),
    code,
    reason: redact(reason),
  });
});

const server = createServer(app);
const io = attachSocketServer(server);
app.set("io", io);
scheduleProDeliveryLocationCleanup();

void verifySmtpTransport();

server.listen(env.port, () => {
  console.log(`QuartierPlus API listening on port ${env.port}`);
});

void ensureDefaultChannels().catch((error) => {
  console.error("Unable to initialize default public channels:", error);
});

const shutdown = (signal) => {
  console.log(`${signal} received; closing API server.`);
  io.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
