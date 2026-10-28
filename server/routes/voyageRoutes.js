import { Router } from "express";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  addVoyageAgent,
  bookVoyageSeat,
  createVoyageCompany,
  createVoyageParcel,
  createVoyageRoute,
  createVoyageTrip,
  getVoyageConfig,
  listVoyagePassengers,
  listVoyageTickets,
  listVoyageTrips,
  scanVoyage,
} from "../controllers/voyageController.js";
import { env } from "../config/env.js";

const router = Router();

router.get("/config", getVoyageConfig);
router.use((_request, response, next) => {
  if (!env.voyageEnabled) return response.status(404).json({ error: "QuartierPlus Voyage est désactivé." });
  return next();
});
router.get("/trips", listVoyageTrips);
router.post("/companies", authMiddleware, createVoyageCompany);
router.post("/routes", authMiddleware, createVoyageRoute);
router.post("/trips", authMiddleware, createVoyageTrip);
router.post("/trips/:id/book", authMiddleware, bookVoyageSeat);
router.get("/tickets/mine", authMiddleware, listVoyageTickets);
router.get("/trips/:id/passengers", authMiddleware, listVoyagePassengers);
router.post("/agents", authMiddleware, addVoyageAgent);
router.post("/scan", authMiddleware, scanVoyage);
router.post("/parcels", authMiddleware, createVoyageParcel);

export default router;