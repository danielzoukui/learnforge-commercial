import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHmac, timingSafeEqual } from "node:crypto";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const ENTITLEMENT_BY_PLAN: Record<string, string[]> = {
  family: ["learnforge.family"],
  teacher: ["learnforge.teacher"]
};

function safeEqualHex(a: string, b: string) {
  try {
    const aa = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody: string, header: string, secret: string) {
  const pairs = header.split(",").map((p) => p.trim().split("=", 2));
  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v).filter(Boolean);
  if (!timestamp || !signatures.length) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((sig) => safeEqualHex(expected, sig));
}

async function stripeGet(path: string, secret: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Stripe lookup failed");
  return data;
}

function normalizeId(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.id) return String(value.id);
  return null;
}

async function syncSubscription(subscription: any, stripeSecret: string) {
  const db = getDatabase();
  const subscriptionId = String(subscription?.id || "");
  if (!subscriptionId) return;

  const customerId = normalizeId(subscription?.customer);
  let authUserId = String(subscription?.metadata?.learnforge_auth_user_id || "");
  let plan = String(subscription?.metadata?.learnforge_plan || "").toLowerCase();

  if ((!authUserId || !plan) && customerId) {
    try {
      const customer = await stripeGet(`customers/${encodeURIComponent(customerId)}`, stripeSecret);
      authUserId ||= String(customer?.metadata?.learnforge_auth_user_id || "");
      plan ||= String(customer?.metadata?.learnforge_plan || "").toLowerCase();
    } catch {}
  }

  if (!authUserId) return;
  const accounts = await db.sql`SELECT id FROM commercial_accounts WHERE auth_user_id = ${authUserId} LIMIT 1`;
  if (!accounts.length) return;
  const accountId = accounts[0].id;

  const status = String(subscription?.status || "inactive");
  const currentPeriodEnd = subscription?.current_period_end
    ? new Date(Number(subscription.current_period_end) * 1000).toISOString()
    : null;

  await db.sql`
    INSERT INTO commercial_subscriptions
      (account_id, provider, provider_customer_id, provider_subscription_id, plan, status, current_period_end, updated_at)
    VALUES
      (${accountId}, 'stripe', ${customerId}, ${subscriptionId}, ${plan || 'free'}, ${status}, ${currentPeriodEnd}, NOW())
    ON CONFLICT (provider_subscription_id) DO UPDATE SET
      provider_customer_id = EXCLUDED.provider_customer_id,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = NOW()
  `;

  await db.sql`
    UPDATE commercial_entitlements
    SET enabled = FALSE, updated_at = NOW()
    WHERE account_id = ${accountId} AND source = 'subscription'
  `;

  if (ACTIVE_STATUSES.has(status)) {
    for (const entitlement of ENTITLEMENT_BY_PLAN[plan] || []) {
      await db.sql`
        INSERT INTO commercial_entitlements (account_id, entitlement_key, enabled, source, updated_at)
        VALUES (${accountId}, ${entitlement}, TRUE, 'subscription', NOW())
        ON CONFLICT (account_id, entitlement_key) DO UPDATE SET
          enabled = TRUE,
          source = 'subscription',
          updated_at = NOW()
      `;
    }
  }

  await db.sql`
    INSERT INTO commercial_audit_events (account_id, event_type, metadata)
    VALUES (${accountId}, 'stripe.subscription.sync', ${JSON.stringify({ subscriptionId, customerId, plan, status })}::jsonb)
  `;
}

async function handleCheckoutSession(session: any, stripeSecret: string) {
  const db = getDatabase();
  const authUserId = String(session?.metadata?.learnforge_auth_user_id || "");
  const plan = String(session?.metadata?.learnforge_plan || "").toLowerCase();
  const customerId = normalizeId(session?.customer);
  const subscriptionId = normalizeId(session?.subscription);
  if (!authUserId) return;

  const accounts = await db.sql`SELECT id FROM commercial_accounts WHERE auth_user_id = ${authUserId} LIMIT 1`;
  if (!accounts.length) return;
  const accountId = accounts[0].id;

  if (subscriptionId) {
    const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`, stripeSecret);
    await syncSubscription(subscription, stripeSecret);
  } else {
    await db.sql`
      INSERT INTO commercial_audit_events (account_id, event_type, metadata)
      VALUES (${accountId}, 'stripe.checkout.completed', ${JSON.stringify({ customerId, plan, sessionId: session?.id || null })}::jsonb)
    `;
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const webhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const stripeSecret = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!webhookSecret || !stripeSecret) {
    return Response.json({ error: "Stripe webhook is not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();
  if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
    return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(rawBody); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const eventId = String(event?.id || "");
  const eventType = String(event?.type || "");
  if (!eventId || !eventType) return Response.json({ error: "Malformed Stripe event" }, { status: 400 });

  const db = getDatabase();
  const prior = await db.sql`
    SELECT 1 FROM commercial_webhook_events
    WHERE provider = 'stripe' AND provider_event_id = ${eventId}
    LIMIT 1
  `;
  if (prior.length) return Response.json({ received: true, duplicate: true });

  const object = event?.data?.object || {};
  try {
    if (eventType === "checkout.session.completed") {
      await handleCheckoutSession(object, stripeSecret);
    } else if (
      eventType === "customer.subscription.created" ||
      eventType === "customer.subscription.updated" ||
      eventType === "customer.subscription.deleted"
    ) {
      await syncSubscription(object, stripeSecret);
    } else if (eventType === "invoice.payment_failed" || eventType === "invoice.paid") {
      const subscriptionId = normalizeId(object?.subscription);
      if (subscriptionId) {
        const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`, stripeSecret);
        await syncSubscription(subscription, stripeSecret);
      }
    }

    await db.sql`
      INSERT INTO commercial_webhook_events (provider, provider_event_id, event_type)
      VALUES ('stripe', ${eventId}, ${eventType})
      ON CONFLICT (provider, provider_event_id) DO NOTHING
    `;
    return Response.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
};

export const config: Config = { path: "/commercial-api/stripe-webhook" };
