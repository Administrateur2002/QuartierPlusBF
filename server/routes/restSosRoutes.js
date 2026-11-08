import { Router } from "express";
import {
  createSosAlert,
  resolveSosAlert,
} from "../controllers/restSosController.js";
import { authMiddlewareAllowSuspended } from "../middlewares/authMiddleware.js";

const router = Router();
router.post("/", authMiddlewareAllowSuspended, createSosAlert);
router.post("/:id/resolve", authMiddlewareAllowSuspended, resolveSosAlert);

export default router;
