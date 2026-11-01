import { Router } from "express";
import {
  getCurrentUser,
  listMyAlertsAndReports,
  listMyMarketplaceItems,
  signProfilePhotoUpload,
  updateCurrentUserPhoto,
  updateCurrentUser,
} from "../controllers/userController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  registerPushToken,
  removePushToken,
} from "../controllers/pushTokenController.js";

const router = Router();

router.use(authMiddleware);
router.get("/me", getCurrentUser);
router.put("/me", updateCurrentUser);
router.post("/me/photo-signature", signProfilePhotoUpload);
router.put("/me/photo", updateCurrentUserPhoto);
router.get("/me/marketplace-items", listMyMarketplaceItems);
router.get("/me/activities", listMyAlertsAndReports);
router.post("/push-token", registerPushToken);
router.delete("/push-token", removePushToken);

export default router;
