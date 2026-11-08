import { Router } from "express";
import { createMarketplaceItem } from "../controllers/marketplaceController.js";
import {
  claimMarketplaceDelivery,
  confirmMarketplaceDelivery,
  createMarketplaceOpportunity,
  createMarketplaceOrder,
  createMarketplaceReview,
  getMarketplaceOrder,
  getMarketplaceShop,
  getMarketplaceCourier,
  getMyMarketplaceShop,
  listMarketplaceDeliveries,
  listMarketplaceOpportunities,
  listMarketplaceOrders,
  listMarketplaceShops,
  saveMarketplaceCourier,
  saveMyMarketplaceShop,
  updateMarketplaceOrderStatus,
} from "../controllers/marketplaceCommerceController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = Router();
router.post("/items", authMiddleware, createMarketplaceItem);
router.get("/shops/me", authMiddleware, getMyMarketplaceShop);
router.put("/shops/me", authMiddleware, saveMyMarketplaceShop);
router.get("/shops", listMarketplaceShops);
router.get("/shops/:sellerId", getMarketplaceShop);
router.get("/orders", authMiddleware, listMarketplaceOrders);
router.post("/orders", authMiddleware, createMarketplaceOrder);
router.get("/orders/:orderId", authMiddleware, getMarketplaceOrder);
router.patch("/orders/:orderId/status", authMiddleware, updateMarketplaceOrderStatus);
router.post("/orders/:orderId/confirm-delivery", authMiddleware, confirmMarketplaceDelivery);
router.post("/orders/:orderId/claim-delivery", authMiddleware, claimMarketplaceDelivery);
router.post("/orders/:orderId/reviews", authMiddleware, createMarketplaceReview);
router.put("/couriers/me", authMiddleware, saveMarketplaceCourier);
router.get("/couriers/me", authMiddleware, getMarketplaceCourier);
router.get("/deliveries/open", authMiddleware, listMarketplaceDeliveries);
router.get("/opportunities", listMarketplaceOpportunities);
router.post("/opportunities", authMiddleware, createMarketplaceOpportunity);

export default router;
