import { Router } from "express";
import {
  getMediaStatus,
  getPublicConfig,
  listPublicMarketplace,
} from "../controllers/publicController.js";
import { optionalAuthMiddleware } from "../middlewares/optionalAuthMiddleware.js";

const router = Router();

router.get("/marketplace", optionalAuthMiddleware, listPublicMarketplace);
router.get("/config", getPublicConfig);
router.get("/media-status", getMediaStatus);

export default router;
