import { Router } from "express";
import { getMySubscription, getProDashboard } from "../controllers/proController.js";
import {
  alertNeighborResponders,
  createFlashSale,
  createOfficialNews,
  createSyndicVote,
  createSyndicWallPost,
  createTownHallConsultation,
  getSecurityIntervention,
  updateSecurityIntervention,
  getSyndicCraftsmen,
  getSyndicVotes,
  getSyndicWall,
  getTownHallContent,
  getTownHallGroupedReports,
  listActiveSos,
  listSyndicResidences,
  listTownHallMunicipalities,
  participateInSyndicVote,
} from "../controllers/proFeatureController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { proRoleGuard } from "../middlewares/proRoleGuard.js";
import { activateFreeOffer } from "../controllers/proOfferController.js";

const router = Router();

router.use((_request, response, next) => {
  response.set("Cache-Control", "no-store");
  return next();
});
router.use(authMiddleware);
router.post("/offers/activate", activateFreeOffer);
router.get("/me/subscription", getMySubscription);
router.get(
  "/merchant/dashboard",
  proRoleGuard("ALLIANCE_PRO"),
  getProDashboard,
);
router.post(
  "/merchant/flash-sale",
  proRoleGuard("ALLIANCE_PRO"),
  createFlashSale,
);
router.get("/townhall/dashboard", proRoleGuard("TOWN_HALL"), getProDashboard);
router.get(
  "/townhall/municipalities",
  proRoleGuard("TOWN_HALL"),
  listTownHallMunicipalities,
);
router.get(
  "/townhall/grouped-reports",
  proRoleGuard("TOWN_HALL"),
  getTownHallGroupedReports,
);
router.get(
  "/townhall/content",
  proRoleGuard("TOWN_HALL"),
  getTownHallContent,
);
router.post(
  "/townhall/consultations",
  proRoleGuard("TOWN_HALL"),
  createTownHallConsultation,
);
router.post(
  "/townhall/official-news",
  proRoleGuard("TOWN_HALL"),
  createOfficialNews,
);
router.get("/syndic/dashboard", proRoleGuard("SYNDIC"), getProDashboard);
router.get(
  "/syndic/residences",
  proRoleGuard("SYNDIC"),
  listSyndicResidences,
);
router.get("/syndic/wall", proRoleGuard("SYNDIC"), getSyndicWall);
router.post("/syndic/wall", proRoleGuard("SYNDIC"), createSyndicWallPost);
router.get("/syndic/votes", proRoleGuard("SYNDIC"), getSyndicVotes);
router.post("/syndic/votes", proRoleGuard("SYNDIC"), createSyndicVote);
router.post(
  "/syndic/votes/:voteId/participate",
  proRoleGuard("SYNDIC"),
  participateInSyndicVote,
);
router.get(
  "/syndic/craftsmen",
  proRoleGuard("SYNDIC"),
  getSyndicCraftsmen,
);
router.get(
  "/security-agent/dashboard",
  proRoleGuard("SECURITY_AGENT"),
  getProDashboard,
);
router.get(
  "/security/active-sos",
  proRoleGuard("SECURITY_AGENT"),
  listActiveSos,
);
router.post(
  "/security/interventions/:sos_id",
  proRoleGuard("SECURITY_AGENT"),
  getSecurityIntervention,
);
router.patch(
  "/security/interventions/:sos_id",
  proRoleGuard("SECURITY_AGENT"),
  updateSecurityIntervention,
);
router.post(
  "/security/alert-neighbors",
  proRoleGuard("SECURITY_AGENT"),
  alertNeighborResponders,
);

export default router;
