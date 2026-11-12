import { Router } from "express";
import {
  createPrivateConnectionRequest,
  createPrivateMessage,
  getPrivateContactProfile,
  listPrivateConnectionRequests,
  listConversations,
  listPrivateMessages,
  respondToPrivateConnectionRequest,
  searchPrivateContacts,
} from "../controllers/conversationController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { rateLimit } from "express-rate-limit";

const router = Router();
router.use(authMiddleware);
const contactSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (request) => request.auth?.userId ?? request.ip,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de recherches. Réessayez dans une minute." },
});
router.get("/contacts/me", getPrivateContactProfile);
router.get("/contacts", contactSearchLimiter, searchPrivateContacts);
router.get("/requests", listPrivateConnectionRequests);
router.post("/requests", createPrivateConnectionRequest);
router.post("/requests/:requestId/respond", respondToPrivateConnectionRequest);
router.get("/", listConversations);
router.get("/:conversationId/messages", listPrivateMessages);
router.post("/:conversationId/messages", createPrivateMessage);

export default router;
