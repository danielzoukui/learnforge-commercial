import assert from "node:assert";
import { createHmac, timingSafeEqual } from "node:crypto";

console.log("--- Starting Stripe Webhook Security & Signature Test Suite ---");

const secret = "whsec_test_secret_key_1234567890abcdef";

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody, header, webhookSecret) {
  const pairs = header.split(",").map((p) => p.trim().split("=", 2));
  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v).filter(Boolean);
  if (!timestamp || !signatures.length) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((sig) => safeEqualHex(expected, sig));
}

function generateStripeHeader(rawBody, webhookSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

// Test 1: Valid checkout.session.completed event signature
const checkoutEvent = JSON.stringify({
  id: "evt_test_checkout_001",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_session_123",
      customer: "cus_test_cust_456",
      subscription: "sub_test_sub_789",
      metadata: {
        learnforge_plan: "family",
        learnforge_auth_user_id: "usr_abc123"
      }
    }
  }
});

const validHeader = generateStripeHeader(checkoutEvent, secret);
assert(verifyStripeSignature(checkoutEvent, validHeader, secret), "Valid signature must pass");
console.log("✓ Valid checkout.session.completed signature passes");

// Test 2: Tampered body must be rejected
const tamperedEvent = checkoutEvent.replace("family", "teacher");
assert(!verifyStripeSignature(tamperedEvent, validHeader, secret), "Tampered payload must be rejected");
console.log("✓ Tampered payload is rejected");

// Test 3: Wrong webhook secret must be rejected
const wrongSecret = "whsec_completely_wrong_secret";
assert(!verifyStripeSignature(checkoutEvent, validHeader, wrongSecret), "Wrong secret must be rejected");
console.log("✓ Wrong secret is rejected");

// Test 4: Stale timestamp (> 300 seconds ago) must be rejected for replay protection
const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
const staleHeader = generateStripeHeader(checkoutEvent, secret, staleTimestamp);
assert(!verifyStripeSignature(checkoutEvent, staleHeader, secret), "Stale signature must be rejected");
console.log("✓ Stale timestamp (>300s) is rejected for replay defense");

// Test 5: Subscription lifecycle payload validation
const subscriptionEvents = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed"
];

for (const eventType of subscriptionEvents) {
  const subPayload = JSON.stringify({
    id: `evt_test_${eventType.replace(/\./g, "_")}`,
    type: eventType,
    data: {
      object: {
        id: "sub_test_sub_789",
        customer: "cus_test_cust_456",
        status: eventType === "customer.subscription.deleted" ? "canceled" : "active",
        metadata: { learnforge_plan: "teacher", learnforge_auth_user_id: "usr_teacher_99" }
      }
    }
  });
  const header = generateStripeHeader(subPayload, secret);
  assert(verifyStripeSignature(subPayload, header, secret), `${eventType} signature must be valid`);
}
console.log("✓ All 5 subscription lifecycle event payloads verified");

console.log("\nALL STRIPE WEBHOOK SECURITY TESTS PASSED!");
