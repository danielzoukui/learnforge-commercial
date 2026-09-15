import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { verifyCommercialUser } from "./_shared/commercial-auth";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const ENTITLEMENT_BY_PLAN: Record<string, string[]> = {
  family: ["learnforge.family"],
  teacher: ["learnforge.teacher"]
};

function normalizeId(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.id) return String(value.id);
  return null;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!secret) return Response.json({ error: "Billing is not configured yet" }, { status: 503 });

  let user;
  try {
    user = await verifyCommercialUser(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const body = await req.json().catch(() => ({}));
  const sessionId = String(body.session_id || "").trim();
  if (!sessionId) return Response.json({ error: "Missing session_id" }, { status: 400 });

  const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const session = await sessionRes.json();
  if (!sessionRes.ok) {
    return Response.json({ error: session?.error?.message || "Could not retrieve checkout session" }, { status: 404 });
  }

  // Verify this checkout session belongs to the authenticated user
  const authUserId = String(session?.metadata?.learnforge_auth_user_id || session?.client_reference_id || "");
  const customerEmail = String(session?.customer_details?.email || session?.customer_email || "").toLowerCase();
  if (authUserId && authUserId !== user.id && customerEmail && customerEmail !== user.email.toLowerCase()) {
    return Response.json({ error: "Unauthorized checkout session" }, { status: 403 });
  }

  const db = getDatabase();
  const accounts = await db.sql`SELECT id FROM commercial_accounts WHERE auth_user_id = ${user.id} LIMIT 1`;
  if (!accounts.length) {
    return Response.json({ error: "Account not found" }, { status: 404 });
  }
  const accountId = accounts[0].id;
  const plan = String(session?.metadata?.learnforge_plan || "").toLowerCase() || "family";
  const customerId = normalizeId(session?.customer);
  const subscription = session?.subscription;
  const subscriptionId = normalizeId(subscription);

  // `expand[]=subscription` normally returns the object, but a different Stripe
  // API version or a retried request can return only the id. Resolve it the same
  // way the webhook does so a paying customer is entitled immediately instead of
  // waiting for webhook delivery.
  let subscriptionDetails = subscription && typeof subscription === "object" ? subscription : null;
  if (!subscriptionDetails && subscriptionId) {
    try {
      const subscriptionRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        headers: { Authorization: `Bearer ${secret}` }
      });
      if (subscriptionRes.ok) subscriptionDetails = await subscriptionRes.json();
    } catch (e) {
      console.error("Subscription lookup failed during checkout sync", e);
    }
  }

  if (subscriptionDetails) {
    const status = String(subscriptionDetails.status || "active");
    const currentPeriodEnd = subscriptionDetails.current_period_end
      ? new Date(Number(subscriptionDetails.current_period_end) * 1000).toISOString()
      : null;

    if (subscriptionId) {
      await db.sql`
        INSERT INTO commercial_subscriptions
          (account_id, provider, provider_customer_id, provider_subscription_id, plan, status, current_period_end, updated_at)
        VALUES
          (${accountId}, 'stripe', ${customerId}, ${subscriptionId}, ${plan}, ${status}, ${currentPeriodEnd}, NOW())
        ON CONFLICT (provider_subscription_id) DO UPDATE SET
          provider_customer_id = EXCLUDED.provider_customer_id,
          plan = EXCLUDED.plan,
          status = EXCLUDED.status,
          current_period_end = EXCLUDED.current_period_end,
          updated_at = NOW()
      `;
    }

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
      VALUES (${accountId}, 'stripe.checkout.sync_completed', ${JSON.stringify({ sessionId, plan, status, subscriptionId })}::jsonb)
    `;

    return Response.json({ success: true, plan, status });
  }

  return Response.json({ success: true, plan, status: "pending" });
};

export const config: Config = { path: "/commercial-api/checkout-sync" };
