/**
 * Stripe automation for the go-live sequence.
 *
 * 1. `ensureWebhookEndpoint` creates (or reuses) the webhook endpoint that points
 *    at /commercial-api/stripe-webhook and returns its signing secret.
 * 2. `runTestPurchase` performs a REAL test-mode purchase through the deployed
 *    stack without a browser: it creates a Supabase user through the site's own
 *    sign-up endpoint, attaches Stripe's `pm_card_visa` test payment method, and
 *    creates a subscription. Stripe then delivers genuine
 *    `customer.subscription.created` / `invoice.paid` events to the live webhook,
 *    and the harness polls the deployed /commercial-api/entitlements endpoint
 *    until the entitlement appears. `pm_card_visa` is the API equivalent of
 *    entering 4242 4242 4242 4242 in Checkout.
 *
 * Endpoints used: POST /v1/webhook_endpoints, GET /v1/webhook_endpoints,
 * POST /v1/customers, POST /v1/subscriptions, DELETE /v1/subscriptions/{id}.
 */

import { HttpClient, pickArray, pickId, poll } from "./providers.mjs";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed"
];

export class StripeClient {
  constructor({ secretKey, baseUrl = "https://api.stripe.com/v1", dryRun = false, log }) {
    this.http = new HttpClient({ provider: "stripe", baseUrl, token: secretKey, dryRun, log });
    this.log = log;
    this.live = String(secretKey || "").startsWith("sk_live_");
  }

  async listWebhookEndpoints() {
    return pickArray((await this.http.get("/webhook_endpoints", { query: { limit: 100 } })).data, ["data"]);
  }

  /**
   * Returns `{ id, secret }`. `secret` is only returned by Stripe on creation —
   * if the endpoint already existed, pass `fallbackSecret` (from the operator's
   * notes) or rotate it in the dashboard.
   */
  async ensureWebhookEndpoint({ url, events = WEBHOOK_EVENTS, description = "LearnForge Commercial", fallbackSecret = null }) {
    const existing = (await this.listWebhookEndpoints()).find((endpoint) => endpoint.url === url);
    if (existing) {
      this.log?.ok(`Stripe webhook endpoint already exists (${existing.id})`);
      const missing = events.filter((event) => !(existing.enabled_events || []).includes(event));
      if (missing.length) {
        await this.http.post(`/webhook_endpoints/${existing.id}`, { form: missing.reduce((acc, event, index) => ({ ...acc, [`enabled_events[${index}]`]: event }), {}) });
        this.log?.ok(`added missing events: ${missing.join(", ")}`);
      }
      if (!fallbackSecret) {
        this.log?.warn("Stripe only reveals a signing secret at creation time.");
        this.log?.warn("Copy it from Dashboard → Developers → Webhooks → your endpoint → Signing secret,");
        this.log?.warn("or delete the endpoint and re-run this command to have a fresh one created.");
      }
      return { id: existing.id, secret: fallbackSecret, created: false };
    }

    const created = await this.http.post("/webhook_endpoints", {
      form: {
        url,
        description,
        ...events.reduce((acc, event, index) => ({ ...acc, [`enabled_events[${index}]`]: event }), {})
      },
      // In dry-run the client returns `synthetic` instead of calling Stripe; the
      // placeholder lets the rest of the sequence (secret propagation, restart)
      // still be rehearsed end to end.
      synthetic: { url, secret: "whsec_dry_run_placeholder" }
    });
    const secret = created.data?.secret || null;
    const id = pickId(created.data) || null;
    if (secret) this.log?.ok(`created Stripe webhook endpoint (${id}) for ${url}`);
    else this.log?.warn(`created Stripe webhook endpoint (${id}) but no signing secret was returned`);
    return { id, secret, created: true };
  }

  async createTestCustomer({ email }) {
    const { data } = await this.http.post("/customers", {
      form: {
        email,
        payment_method: "pm_card_visa",
        "invoice_settings[default_payment_method]": "pm_card_visa",
        "metadata[learnforge_test_purchase]": "true"
      },
      synthetic: { email }
    });
    const id = pickId(data) || `dry-run-cus`;
    this.log?.ok(`created test customer ${id} with pm_card_visa attached`);
    return id;
  }

  async createSubscription({ customerId, priceId, authUserId, plan = "family", trial = false }) {
    const form = {
      customer: customerId,
      "items[0][price]": priceId,
      "metadata[learnforge_auth_user_id]": authUserId,
      "metadata[learnforge_plan]": plan,
      "expand[0]": "latest_invoice"
    };
    if (trial) form["trial_period_days"] = "14";
    const { data } = await this.http.post("/subscriptions", { form, synthetic: { customer: customerId } });
    const subscription = data?.data || data;
    this.log?.ok(`created test subscription ${subscription?.id || "(dry-run)"} with status ${subscription?.status || "simulated"}`);
    return subscription;
  }

  async cancelSubscription({ subscriptionId }) {
    await this.http.delete(`/subscriptions/${subscriptionId}`);
    this.log?.ok(`cancelled test subscription ${subscriptionId}`);
  }

  /**
   * Full test-mode purchase against the deployed stack.
   *
   * @returns {{ email: string, userId: string, subscriptionId: string, cookie: string, entitlements: object }}
   */
  async runTestPurchase({
    siteUrl,
    priceId,
    email,
    password,
    plan = "family",
    authUserId = null,
    cookie = null,
    expectedEntitlement = "learnforge.family",
    attempts = 30,
    intervalMs = 4_000
  }) {
    const base = siteUrl.replace(/\/$/, "");

    if (this.http.dryRun) {
      this.log?.info(`would sign up/in  POST ${base}/commercial-api/auth/signup (${email})`);
      this.log?.info(`would attach      pm_card_visa (the API equivalent of 4242 4242 4242 4242)`);
      this.log?.info(`would subscribe   ${priceId} for ${email}`);
      this.log?.info(`would poll        GET ${base}/commercial-api/entitlements until "${expectedEntitlement}" appears`);
      return { email, userId: "dry-run-user", subscriptionId: "dry-run-sub", cookie: "dry-run-cookie", entitlements: { entitlements: [{ entitlement_key: expectedEntitlement, enabled: true }] } };
    }

    let userCookie = cookie;
    let userId = authUserId;

    if (!userCookie) {
      // Prefer sign-in for an already-confirmed account; fall back to sign-up.
      if (password) {
        const signin = await fetch(`${base}/commercial-api/auth/signin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        if (signin.ok) {
          userCookie = (signin.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");
          userId = (await signin.json())?.user?.id || userId;
          this.log?.ok(`signed in as ${email}`);
        } else {
          this.log?.warn(`sign-in failed (${signin.status}); attempting sign-up`);
        }
      }
      if (!userCookie) {
        const signup = await fetch(`${base}/commercial-api/auth/signup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, displayName: "Stripe Test Purchase", role: "parent" })
        });
        const signupBody = await signup.json().catch(() => ({}));
        if (!signup.ok) throw new Error(`sign-up failed (${signup.status}): ${JSON.stringify(signupBody)}`);
        userId = signupBody?.user?.id || userId;
        userCookie = (signup.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");
        if (!userCookie) {
          throw new Error(
            "sign-up did not return a session (Supabase email confirmation is enabled). " +
            "Confirm the account, then re-run with --email/--password to sign in."
          );
        }
        this.log?.ok(`signed up as ${email}`);
      }
    }

    if (!userId) throw new Error("Could not determine the authenticated user id for the test purchase");

    // Bind the account row (also creates the commercial_accounts record).
    const account = await fetch(`${base}/commercial-api/account`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ displayName: "Stripe Test Purchase", role: "parent" })
    });
    if (!account.ok) throw new Error(`account sync failed (${account.status})`);

    const customerId = await this.createTestCustomer({ email });
    const subscription = await this.createSubscription({ customerId, priceId, authUserId: userId, plan });

    const entitlements = await poll({
      log: this.log,
      label: "entitlements (waiting for the Stripe webhook to land)",
      attempts,
      intervalMs,
      check: async () => {
        const response = await fetch(`${base}/commercial-api/entitlements`, { headers: { cookie: userCookie } });
        if (!response.ok) return { done: false, detail: `HTTP ${response.status}` };
        const body = await response.json();
        const granted = (body.entitlements || []).some((entry) => entry.entitlement_key === expectedEntitlement && entry.enabled);
        return {
          done: granted,
          detail: `entitlements=[${(body.entitlements || []).map((e) => e.entitlement_key).join(",")}]`,
          value: body
        };
      }
    });

    return { email, userId, subscriptionId: subscription?.id || null, cookie: userCookie, entitlements };
  }
}
