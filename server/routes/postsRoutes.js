import { Router } from "express";
import {
  createPost,
  deletePost,
  logMediaUploadFailure,
  listFeed,
  reportPost,
  signMediaUpload,
} from "../controllers/postsController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { optionalAuthMiddleware } from "../middlewares/optionalAuthMiddleware.js";

const router = Router();

router.get("/feed", optionalAuthMiddleware, listFeed);
router.post("/media/sign", authMiddleware, signMediaUpload);
router.post("/media/upload-error", authMiddleware, logMediaUploadFailure);
router.post("/posts", authMiddleware, createPost);
router.delete("/posts/:id", authMiddleware, deletePost);
router.post("/posts/:id/report", authMiddleware, reportPost);

export default router;
