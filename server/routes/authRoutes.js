import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  googleAuth,
  listCountries,
  requestOtp,
  requestPhoneChangeOtp,
  verifyOtp,
  verifyPhoneChangeOtp,
} from "../controllers/authController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { firebaseAuth } from "../controllers/firebaseAuthController.js";

const router = Router();
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de demandes. Réessayez dans quelques minutes." },
});
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes." },
});

router.get("/countries", listCountries);
router.post("/request-otp", otpRequestLimiter, requestOtp);
router.post("/verify-otp", credentialLimiter, verifyOtp);
router.post("/google", credentialLimiter, googleAuth);
router.post("/firebase", credentialLimiter, firebaseAuth);
router.post(
  "/change-phone/request-otp",
  authMiddleware,
  otpRequestLimiter,
  requestPhoneChangeOtp,
);
router.post(
  "/change-phone/verify-otp",
  authMiddleware,
  credentialLimiter,
  verifyPhoneChangeOtp,
);

export default router;
