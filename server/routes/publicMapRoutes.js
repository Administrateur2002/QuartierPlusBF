import { Router } from "express";
import { listMapMarkers } from "../controllers/mapController.js";
import { listPublicProfessionals } from "../controllers/proController.js";
import { optionalAuthMiddleware } from "../middlewares/optionalAuthMiddleware.js";

const router = Router();
router.get("/markers", listMapMarkers);
router.get("/professionals", optionalAuthMiddleware, listPublicProfessionals);

export default router;
