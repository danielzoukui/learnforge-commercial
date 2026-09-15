import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { verifyCommercialUser } from "./_shared/commercial-auth";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Netlify.env.get("STRIPE_SECRET_KEY");
  const siteUrl = Netlify.env.get("PUBLIC_SITE_URL") || new URL(req.url).origin;
  if (!secret) return Response.json({ error: "Billing is not configured yet" }, { status: 503 });

  let user;
  try {
    user = await verifyCommercialUser(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const db = getDatabase();
  let customerId: string | null = null;
  try {
    const rows = await db.sql`
      SELECT cs.provider_customer_id
      FROM commercial_subscriptions cs
      JOIN commercial_accounts ca ON cs.account_id = ca.id
      WHERE ca.auth_user_id = ${user.id} AND cs.provider = 'stripe' AND cs.provider_customer_id IS NOT NULL
      ORDER BY cs.updated_at DESC LIMIT 1
    `;
    if (rows.length && rows[0].provider_customer_id) {
      customerId = String(rows[0].provider_customer_id);
    }
  } catch (e) {
    console.error("Database lookup failed in portal", e);
  }

  // If customer ID not found in database, check Stripe customer by email
  if (!customerId) {
    try {
      const searchRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(user.email)}&limit=1`, {
        headers: { Authorization: `Bearer ${secret}` }
      });
      const searchData = await searchRes.json();
      if (searchData?.data?.length) {
        customerId = String(searchData.data[0].id);
      }
    } catch (e) {
      console.error("Stripe customer search failed in portal", e);
    }
  }

  if (!customerId) {
    return Response.json({ error: "No active billing customer found for your account. Please select a plan first." }, { status: 404 });
  }

  const form = new URLSearchParams();
  form.set("customer", customerId);
  form.set("return_url", `${siteUrl}/pricing.html`);

  const portalRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const portalData = await portalRes.json();
  if (!portalRes.ok) {
    return Response.json({ error: portalData?.error?.message || "Billing portal unavailable" }, { status: 502 });
  }

  return Response.json({ url: portalData.url });
};

export const config: Config = { path: "/commercial-api/portal" };
