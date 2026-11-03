import { Router } from "express";
import {
  createPost,
  deletePost,
  listPostShareTargets,
  listSharedPosts,
  logMediaUploadFailure,
  listFeed,
  reportPost,
  signMediaUpload,
  sharePost,
} from "../controllers/postsController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { optionalAuthMiddleware } from "../middlewares/optionalAuthMiddleware.js";

const router = Router();

router.get("/feed", optionalAuthMiddleware, listFeed);
router.get("/posts/share-targets", authMiddleware, listPostShareTargets);
router.get("/posts/shared", authMiddleware, listSharedPosts);
router.post("/posts/media/sign", authMiddleware, signMediaUpload);
router.post("/media/sign", authMiddleware, signMediaUpload);
router.post("/media/upload-error", authMiddleware, logMediaUploadFailure);
router.post("/posts", authMiddleware, createPost);
router.post("/posts/:id/share", authMiddleware, sharePost);
router.delete("/posts/:id", authMiddleware, deletePost);
router.post("/posts/:id/report", authMiddleware, reportPost);

export default router;
