import { Router } from "express";
import { env } from "../config/env.js";
import { createLiveKitToken } from "../controllers/livekitController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = Router();

router.get("/moderation/config", (_request, response) =>
  response.status(200).json({
    automatedModerationAvailable: env.grinModerationEnabled,
  }),
);
router.post("/token", authMiddleware, createLiveKitToken);

export default router;
