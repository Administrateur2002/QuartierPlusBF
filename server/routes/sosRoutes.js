import { Router } from "express";
import {
	assistSosAlert,
	reportSosAlert,
} from "../controllers/sosController.js";
import { listNearbyAlerts } from "../controllers/publicController.js";
import { authMiddlewareAllowSuspended } from "../middlewares/authMiddleware.js";

const router = Router();

router.get("/alerts", authMiddlewareAllowSuspended, listNearbyAlerts);
router.post("/:id/assist", authMiddlewareAllowSuspended, assistSosAlert);
router.post("/:id/report-fake", authMiddlewareAllowSuspended, reportSosAlert);

export default router;
