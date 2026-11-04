import { timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { Router } from "express";
import {
  actOnReport,
  appealReport,
  appealPostModerationEvent,
  createFlash,
  getAdminDashboard,
  getAdminHistory,
  listAppealableReports,
  listFlashes,
  resolvePostModerationEvent,
} from "../controllers/adminController.js";
import { resolveModerationEvent } from "../controllers/grinModerationController.js";
import { env } from "../config/env.js";
import { authMiddleware, authMiddlewareAllowSuspended } from "../middlewares/authMiddleware.js";
import { adminAuthMiddleware } from "../middlewares/adminAuthMiddleware.js";
import { sendSmtpDiagnosticEmail } from "../services/email.js";
import {
  actOnConflict,
  appealConflict,
  createModerationLexiconEntry,
  deleteModerationLexiconEntry,
  listAdminConflicts,
  listModerationLexicon,
} from "../controllers/conflictController.js";

const router = Router();
const admin = [authMiddleware, adminAuthMiddleware];
const flashLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de messages flash. Réessayez plus tard." },
});

router.get("/me", ...admin, (_request, response) =>
  response.status(200).json({ authorized: true }),
);
router.get("/dashboard", ...admin, getAdminDashboard);
router.get("/history", ...admin, getAdminHistory);
router.get("/conflicts", ...admin, listAdminConflicts);
router.post("/conflicts/:conflictId/action", ...admin, actOnConflict);
router.post(
  "/conflicts/:conflictId/appeal",
  authMiddlewareAllowSuspended,
  appealConflict,
);
router.get("/moderation-lexicon", ...admin, listModerationLexicon);
router.post("/moderation-lexicon", ...admin, createModerationLexiconEntry);
router.delete("/moderation-lexicon/:entryId", ...admin, deleteModerationLexiconEntry);
router.post("/reports/:reportId/action", ...admin, actOnReport);
router.post(
  "/post-moderation-events/:eventId/action",
  ...admin,
  resolvePostModerationEvent,
);
router.post(
  "/post-moderation-events/:eventId/appeal",
  authMiddlewareAllowSuspended,
  appealPostModerationEvent,
);
router.post("/live-events/:eventId/action", ...admin, resolveModerationEvent);
router.post("/reports/:reportId/appeal", authMiddlewareAllowSuspended, appealReport);
router.get("/appealable-reports", authMiddlewareAllowSuspended, listAppealableReports);
router.get("/flashes", ...admin, listFlashes);
router.post("/flashes", ...admin, flashLimiter, createFlash);

router.post("/test-email", async (request, response) => {
  const configuredToken = env.adminTestEmailToken;
  const suppliedToken = request.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configuredToken) {
    return response.status(503).json({
      error: "Variable ADMIN_TEST_EMAIL_TOKEN manquante.",
    });
  }
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return response.status(401).json({ error: "Authentification admin requise." });
  }
  if (!env.smtpConfigured) {
    return response.status(503).json({
      error: "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS et MAIL_FROM sont requis.",
    });
  }
  try {
    await sendSmtpDiagnosticEmail(env.emailFrom);
    return response.status(200).json({ ok: true, provider: "smtp" });
  } catch (error) {
    console.error("Échec du test SMTP :", error.code || error.message);
    return response.status(502).json({
      error: `Échec de l'envoi SMTP (${error.code || "erreur transport"}).`,
    });
  }
});

export default router;