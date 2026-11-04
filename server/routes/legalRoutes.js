import { Router } from "express";
import {
  acceptLegalDocuments,
  getLegalDocuments,
  getMyLegalAcceptances,
} from "../controllers/legalController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = Router();

router.get("/documents", getLegalDocuments);
router.get("/me", authMiddleware, getMyLegalAcceptances);
router.post("/acceptances", authMiddleware, acceptLegalDocuments);

export default router;
