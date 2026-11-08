import { Router } from "express";
import {
  createCommunicationArea,
  createCommunicationMessage,
  acceptInstitutionInvitation,
  correctOfficialMessage,
  followCommunicationChannel,
  inviteInstitutionPublisher,
  listCommunicationChannels,
  listCommunicationMessages,
  listOfficialMessageHistory,
  listInstitutionVerificationRequests,
  listMyInstitutions,
  requestInstitutionVerification,
  reviewInstitutionVerification,
  revokeInstitutionPublisher,
  searchCommunicationChannels,
  unfollowCommunicationChannel,
  updateCommunicationArea,
  withdrawOfficialMessage,
} from "../controllers/communicationController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { adminAuthMiddleware } from "../middlewares/adminAuthMiddleware.js";

const router = Router();

router.get("/", authMiddleware, listCommunicationChannels);
router.get("/catalog", authMiddleware, searchCommunicationChannels);
router.get("/institutions/mine", authMiddleware, listMyInstitutions);
router.post("/institutions", authMiddleware, requestInstitutionVerification);
router.post(
  "/institutions/:institutionId/members",
  authMiddleware,
  inviteInstitutionPublisher,
);
router.post(
  "/institutions/:institutionId/accept",
  authMiddleware,
  acceptInstitutionInvitation,
);
router.delete(
  "/institutions/:institutionId/members/:userId",
  authMiddleware,
  revokeInstitutionPublisher,
);
router.post("/:channelId/follow", authMiddleware, followCommunicationChannel);
router.delete("/:channelId/follow", authMiddleware, unfollowCommunicationChannel);
router.get("/:channelId/messages", authMiddleware, listCommunicationMessages);
router.post("/:channelId/messages", authMiddleware, createCommunicationMessage);
router.patch(
  "/official-messages/:messageId",
  authMiddleware,
  correctOfficialMessage,
);
router.get(
  "/official-messages/:messageId/history",
  authMiddleware,
  listOfficialMessageHistory,
);
router.delete(
  "/official-messages/:messageId",
  authMiddleware,
  withdrawOfficialMessage,
);
router.post(
  "/admin/areas",
  authMiddleware,
  adminAuthMiddleware,
  createCommunicationArea,
);
router.patch(
  "/admin/areas/:areaId",
  authMiddleware,
  adminAuthMiddleware,
  updateCommunicationArea,
);
router.get(
  "/admin/institutions",
  authMiddleware,
  adminAuthMiddleware,
  listInstitutionVerificationRequests,
);
router.patch(
  "/admin/institutions/:institutionId",
  authMiddleware,
  adminAuthMiddleware,
  reviewInstitutionVerification,
);

export default router;