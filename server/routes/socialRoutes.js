import { Router } from "express";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  acceptAlliance,
  createPostComment,
  getLocationShare,
  listAllies,
  listPostComments,
  listSharedLocations,
  removeAlliance,
  requestAlliance,
  refreshLocationShare,
  togglePostLike,
  updateLocationShare,
} from "../controllers/socialController.js";

const router = Router();

router.use(authMiddleware);
router.get("/allies", listAllies);
router.post("/alliance/:userId", requestAlliance);
router.post("/alliance/:userId/accept", acceptAlliance);
router.delete("/alliance/:userId", removeAlliance);
router.post("/posts/:postId/like", togglePostLike);
router.get("/posts/:postId/comments", listPostComments);
router.post("/posts/:postId/comments", createPostComment);
router.put("/location-sharing", updateLocationShare);
router.get("/location-sharing", getLocationShare);
router.patch("/location-sharing/location", refreshLocationShare);
router.get("/shared-locations", listSharedLocations);

export default router;
