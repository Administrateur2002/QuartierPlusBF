import { Router } from "express";
import {
  appealModerationEvent,
  listModerationQueue,
  listMyModerationEvents,
  receiveModerationEvent,
  resolveModerationEvent,
} from "../controllers/grinModerationController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = Router();

router.post("/events", receiveModerationEvent);
router.get("/events/mine", authMiddleware, listMyModerationEvents);
router.post("/events/:eventId/appeal", authMiddleware, appealModerationEvent);
router.get("/review-queue", authMiddleware, listModerationQueue);
router.post(
  "/events/:eventId/resolve",
  authMiddleware,
  resolveModerationEvent,
);

export default router;
