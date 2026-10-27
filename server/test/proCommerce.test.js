import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://localhost/quartierplus_test";
process.env.JWT_SECRET ??=
  "unit-test-secret-that-is-longer-than-thirty-two-characters";

const {
  canAccessProOrder,
  doesHandoffCodeMatch,
  isAllowedOrderTransition,
  isDeliveryTrackingActive,
  isValidHandoffCode,
} = await import("../controllers/proCommerceController.js");
const { env } = await import("../config/env.js");

test("QuartierPlus Pro orders are visible only to participants with the right role", () => {
  const order = {
    buyer_id: "buyer",
    wholesaler_owner_id: "wholesaler",
    deliverer_id: null,
    member_role: null,
    status: "RECEIVED",
  };
  assert.equal(canAccessProOrder("buyer", order), true);
  assert.equal(canAccessProOrder("wholesaler", order), true);
  assert.equal(canAccessProOrder("stranger", order), false);
  assert.equal(canAccessProOrder("manager", { ...order, member_role: "MANAGER" }), true);
  assert.equal(canAccessProOrder("staff", { ...order, member_role: "DELIVERER" }), false);
  assert.equal(
    canAccessProOrder("staff", { ...order, status: "PREPARED", member_role: "DELIVERER" }),
    true,
  );
  assert.equal(
    canAccessProOrder("staff", { ...order, status: "DELIVERED", member_role: "DELIVERER" }),
    false,
  );
  assert.equal(
    canAccessProOrder("staff", { ...order, status: "DELIVERED", deliverer_id: "staff" }),
    true,
  );
});

test("order status transitions follow the preparation and delivery workflow", () => {
  assert.equal(isAllowedOrderTransition("RECEIVED", "ACCEPTED"), true);
  assert.equal(isAllowedOrderTransition("RECEIVED", "CANCELLED"), true);
  assert.equal(isAllowedOrderTransition("ACCEPTED", "PREPARED"), true);
  assert.equal(isAllowedOrderTransition("PREPARED", "IN_TRANSIT"), true);
  assert.equal(isAllowedOrderTransition("IN_TRANSIT", "DELIVERED"), false);
  assert.equal(isAllowedOrderTransition("DELIVERED", "CANCELLED"), false);
});

test("handoff code validation accepts only six digits and checks the order-bound digest", () => {
  const orderId = "2e7f64d0-7766-47cb-b294-24feec5bed11";
  const code = "042681";
  const storedHash = createHmac("sha256", env.jwtSecret)
    .update(`pro-handoff:${orderId}:${code}`)
    .digest("hex");
  assert.equal(isValidHandoffCode(code), true);
  assert.equal(isValidHandoffCode("42681"), false);
  assert.equal(isValidHandoffCode("04268x"), false);
  assert.equal(doesHandoffCodeMatch(orderId, code, storedHash), true);
  assert.equal(doesHandoffCodeMatch(orderId, "000000", storedHash), false);
  assert.equal(doesHandoffCodeMatch("different-order", code, storedHash), false);
});

test("delivery tracking is active only while an order is in transit", () => {
  assert.equal(isDeliveryTrackingActive("IN_TRANSIT"), true);
  for (const status of ["RECEIVED", "ACCEPTED", "PREPARED", "DELIVERED", "CANCELLED"]) {
    assert.equal(isDeliveryTrackingActive(status), false, `${status} must stop tracking`);
  }
});