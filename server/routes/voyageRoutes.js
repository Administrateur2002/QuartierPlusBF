import { Router } from "express";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  addVoyageAgent,
  bookVoyageSeat,
  confirmVoyageStationPayment,
  createVoyageCompany,
  createVoyageParcel,
  createVoyageRoute,
  createVoyageTrip,
  downloadVoyagePassengerManifestPdf,
  getVoyageConfig,
  getMyVoyageAgentTrips,
  getMyVoyageCompany,
  listVoyagePassengers,
  listVoyageTickets,
  listVoyageTrips,
  scanVoyage,
} from "../controllers/voyageController.js";
import { env } from "../config/env.js";
import { proRoleGuard } from "../middlewares/proRoleGuard.js";

const router = Router();
const transportCompanyGuard = proRoleGuard("TRANSPORT_COMPANY");

router.get("/config", getVoyageConfig);
router.use((_request, response, next) => {
  if (!env.voyageEnabled) return response.status(404).json({ error: "QuartierPlus Voyage est désactivé." });
  return next();
});
router.get("/trips", listVoyageTrips);
router.get("/companies/mine", authMiddleware, transportCompanyGuard, getMyVoyageCompany);
router.post("/companies", authMiddleware, transportCompanyGuard, createVoyageCompany);
router.post("/routes", authMiddleware, transportCompanyGuard, createVoyageRoute);
router.post("/trips", authMiddleware, transportCompanyGuard, createVoyageTrip);
router.post("/trips/:id/book", authMiddleware, bookVoyageSeat);
router.get("/tickets/mine", authMiddleware, listVoyageTickets);
router.get("/trips/:id/passengers", authMiddleware, listVoyagePassengers);
router.get("/trips/:id/passengers.pdf", authMiddleware, downloadVoyagePassengerManifestPdf);
router.post("/tickets/:id/confirm-station-payment", authMiddleware, confirmVoyageStationPayment);
router.get("/agents/mine", authMiddleware, getMyVoyageAgentTrips);
router.post("/agents", authMiddleware, transportCompanyGuard, addVoyageAgent);
router.post("/scan", authMiddleware, scanVoyage);
router.post("/parcels", authMiddleware, createVoyageParcel);

export default router;