import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  acceptAlliance,
  blockUser,
  createPostComment,
  deletePostComment,
  getLocationShare,
  listAllies,
  listBlockedUsers,
  listPostComments,
  listSharedLocations,
  removeAlliance,
  requestAlliance,
  refreshLocationShare,
  togglePostLike,
  togglePostCommentLike,
  unblockUser,
  updatePostComment,
  updateLocationShare,
} from "../controllers/socialController.js";

const router = Router();
const commentCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: (request) => request.auth?.userId ?? request.ip,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de commentaires. Réessayez dans une minute." },
});

router.use(authMiddleware);
router.get("/blocked-users", listBlockedUsers);
router.post("/users/:userId/block", blockUser);
router.delete("/users/:userId/block", unblockUser);
router.get("/allies", listAllies);
router.post("/alliance/:userId", requestAlliance);
router.post("/alliance/:userId/accept", acceptAlliance);
router.delete("/alliance/:userId", removeAlliance);
router.post("/posts/:postId/like", togglePostLike);
router.get("/posts/:postId/comments", listPostComments);
router.post("/posts/:postId/comments", commentCreationLimiter, createPostComment);
router.post("/comments/:commentId/like", togglePostCommentLike);
router.put("/comments/:commentId", updatePostComment);
router.delete("/comments/:commentId", deletePostComment);
router.put("/location-sharing", updateLocationShare);
router.get("/location-sharing", getLocationShare);
router.patch("/location-sharing/location", refreshLocationShare);
router.get("/shared-locations", listSharedLocations);

export default router;
