import { Router } from "express";
import { createSosAlert } from "../controllers/restSosController.js";
import { authMiddlewareAllowSuspended } from "../middlewares/authMiddleware.js";

const router = Router();
router.post("/", authMiddlewareAllowSuspended, createSosAlert);

export default router;
