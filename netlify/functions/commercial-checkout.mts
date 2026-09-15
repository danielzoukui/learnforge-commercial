import type { Context, Config } from "@netlify/functions";
import { verifyCommercialUser } from "./_shared/commercial-auth";

const priceEnv: Record<string, string> = {
  family: "STRIPE_PRICE_FAMILY",
  teacher: "STRIPE_PRICE_TEACHER"
};

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Netlify.env.get("STRIPE_SECRET_KEY");
  const siteUrl = Netlify.env.get("PUBLIC_SITE_URL") || new URL(req.url).origin;
  if (!secret) return Response.json({ error: "Billing is not configured yet" }, { status: 503 });
  let user;
  try { user = await verifyCommercialUser(req); } catch (e) { if (e instanceof Response) return e; throw e; }
  const body = await req.json().catch(() => ({}));
  const plan = String(body.plan || "").toLowerCase();
  const email = user.email;
  const envName = priceEnv[plan];
  const price = envName ? Netlify.env.get(envName) : null;
  if (!price) return Response.json({ error: "That plan is not configured yet" }, { status: 400 });

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("customer_email", email);
  form.set("line_items[0][price]", price);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${siteUrl}/pricing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${siteUrl}/pricing.html?checkout=cancelled`);
  form.set("allow_promotion_codes", "true");
  form.set("metadata[learnforge_plan]", plan);
  form.set("metadata[learnforge_auth_user_id]", user.id);
  form.set("subscription_data[metadata][learnforge_plan]", plan);
  form.set("subscription_data[metadata][learnforge_auth_user_id]", user.id);

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  const data = await stripeRes.json();
  if (!stripeRes.ok) return Response.json({ error: data?.error?.message || "Checkout could not be created" }, { status: 502 });
  return Response.json({ url: data.url, id: data.id });
};

export const config: Config = { path: "/commercial-api/checkout" };
