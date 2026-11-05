import { Router } from "express";
import {
  addFavorite,
  addWholesalerMember,
  cancelOrder,
  createOrder,
  createProduct,
  createRecurringList,
  createWholesaler,
  deliverOrder,
  getFavorites,
  getOrder,
  getOrderReceipt,
  getOrders,
  getOwnWholesaler,
  getManageableProducts,
  getProduct,
  getProducts,
  getRecurringLists,
  getWholesaler,
  updatePaymentStatus,
  getWholesalers,
  recordDeliveryLocation,
  removeFavorite,
  reorder,
  signProductPhotoUpload,
  updateOrderStatus,
  updateProduct,
} from "../controllers/proCommerceController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { proRoleGuard } from "../middlewares/proRoleGuard.js";
import { env } from "../config/env.js";
import { timingSafeEqual } from "node:crypto";
import { updateWholesalerVerification } from "../controllers/proCommerceController.js";
import { mediaSignatureRateLimit } from "../middlewares/sensitiveRateLimits.js";

const router = Router();
const proAdminGuard = (request, response, next) => {
  if (!env.proAdminToken) {
    return response.status(503).json({
      error: "La vérification administrative Pro n’est pas configurée.",
      code: "PRO_ADMIN_TOKEN_MISSING",
      reason: "Définissez PRO_ADMIN_TOKEN côté serveur pour gérer les vérifications RCCM/IFU.",
    });
  }
  const supplied = Buffer.from(
    (request.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
  );
  const expected = Buffer.from(env.proAdminToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return response.status(401).json({ error: "Jeton administrateur QuartierPlus Pro invalide." });
  }
  return next();
};

router.get("/config", (_request, response) =>
  response.json({ enabled: env.proEnabled }),
);
router.use((request, response, next) => {
  if (!env.proEnabled) {
    return response.status(404).json({
      error: "QuartierPlus Pro est désactivé. Définissez PRO_ENABLED=true côté serveur.",
      code: "PRO_DISABLED",
    });
  }
  return next();
});
router.patch("/admin/wholesalers/:wholesalerId/verification", proAdminGuard, updateWholesalerVerification);

router.get("/wholesalers", getWholesalers);
router.get("/wholesalers/me", authMiddleware, getOwnWholesaler);
router.get("/wholesalers/:wholesalerId", getWholesaler);
router.get("/wholesalers/:wholesalerId/manage-products", authMiddleware, proRoleGuard("WHOLESALER"), getManageableProducts);
router.get("/products", getProducts);
router.get("/products/:productId", getProduct);
router.post("/wholesalers", authMiddleware, proRoleGuard("WHOLESALER"), createWholesaler);
router.post("/wholesalers/:wholesalerId/products", authMiddleware, proRoleGuard("WHOLESALER"), createProduct);
router.post("/products/photo-signature", authMiddleware, mediaSignatureRateLimit, proRoleGuard("WHOLESALER"), signProductPhotoUpload);
router.patch("/products/:productId", authMiddleware, proRoleGuard("WHOLESALER"), updateProduct);
router.post("/wholesalers/:wholesalerId/members", authMiddleware, proRoleGuard("WHOLESALER"), addWholesalerMember);
router.get("/favorites", authMiddleware, getFavorites);
router.post("/favorites/:wholesalerId", authMiddleware, addFavorite);
router.delete("/favorites/:wholesalerId", authMiddleware, removeFavorite);
router.get("/orders", authMiddleware, getOrders);
router.post("/orders", authMiddleware, createOrder);
router.get("/orders/:orderId", authMiddleware, getOrder);
router.post("/orders/:orderId/cancel", authMiddleware, cancelOrder);
router.post("/orders/:orderId/reorder", authMiddleware, reorder);
router.patch("/orders/:orderId/status", authMiddleware, updateOrderStatus);
router.patch("/orders/:orderId/payment-status", authMiddleware, updatePaymentStatus);
router.post("/orders/:orderId/deliver", authMiddleware, deliverOrder);
router.post("/orders/:orderId/location", authMiddleware, recordDeliveryLocation);
router.get("/orders/:orderId/receipt.pdf", authMiddleware, getOrderReceipt);
router.get("/recurring-lists", authMiddleware, getRecurringLists);
router.post("/recurring-lists", authMiddleware, createRecurringList);

export default router;