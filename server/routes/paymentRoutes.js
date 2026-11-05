import { Router } from "express";
import {
  createTransaction,
  getTransactionStatus,
  handleFedaPayWebhook,
  listSponsoredPins,
} from "../controllers/paymentController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { paymentRateLimit } from "../middlewares/sensitiveRateLimits.js";

const router = Router();

router.post("/fedapay-webhook", handleFedaPayWebhook);
router.post("/transactions", authMiddleware, paymentRateLimit, createTransaction);
router.get("/transactions/:id", authMiddleware, getTransactionStatus);
router.get("/sponsored-pins", authMiddleware, listSponsoredPins);

export default router;
