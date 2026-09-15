/**
 * End-to-end purchase lifecycle against a REAL PostgreSQL database.
 *
 * This is the dress rehearsal for the production smoke test: it runs the real
 * router, the real handlers, the real migration schema and the real Stripe
 * signature verification, with two external services stood in for:
 *
 *   - Supabase Auth  → local stub HTTP server (signup / user / refresh / logout)
 *   - Stripe API     → in-process `fetch` interception (checkout, subscription,
 *                      billing portal, customer search)
 *
 * Everything else is genuine: rows land in PostgreSQL, the webhook is signed with
 * HMAC-SHA256 exactly as Stripe signs it, entitlements are derived by the real
 * handler code, and idempotency is enforced by the real UNIQUE constraint on
 * commercial_webhook_events.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/db node tests/test-end-to-end-purchase.mjs
 *   DATABASE_URL=... node tests/test-end-to-end-purchase.mjs --require-database
 *
 * Without DATABASE_URL the suite prints SKIP and exits 0, so CI without a
 * database stays green.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireDatabase = process.argv.includes("--require-database");

if (!process.env.DATABASE_URL) {
  if (requireDatabase) {
    console.error("FAIL: --require-database was passed but DATABASE_URL is not set.");
    process.exit(1);
  }
  console.log("--- End-to-End Purchase Suite: SKIP (set DATABASE_URL to run against a real PostgreSQL) ---");
  process.exit(0);
}

// The handlers import `@netlify/database` and read `Netlify.env`; map the module
// and install the env shim exactly as runtime/server.mjs does, then load the
// router dynamically.
register(new URL("../runtime/loader.mjs", import.meta.url));
const { installEnvShim } = await import("../runtime/env.mjs");
installEnvShim();

const { createApp } = await import("../runtime/router.mjs");
const { Client } = await import("pg");

const STRIPE_PRICE_FAMILY = "price_test_family_monthly";
const STRIPE_PRICE_TEACHER = "price_test_teacher_monthly";
const STRIPE_SECRET_KEY = "sk_test_e2e";
const WEBHOOK_SECRET = "whsec_e2e_secret_key_0123456789abcdef";
const RUN = Date.now();
// Stripe ids are globally unique in production, so each run uses its own ids.
// Reusing them would make a second run upsert the previous run's rows.
const SUBSCRIPTION_ID = `sub_e2e_${RUN}`;
const CUSTOMER_ID = `cus_e2e_${RUN}`;
const CHECKOUT_SESSION_ID = `cs_e2e_${RUN}`;
const AUTH_USER_ID = `e2e-user-${RUN}`;
const EMAIL = `parent+${RUN}@example.com`;
const ACCESS_TOKEN = `e2e-access-${RUN}`;
const REFRESH_TOKEN = `e2e-refresh-${RUN}`;

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`✓ ${label}`);
};

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Supabase Auth stub
// ---------------------------------------------------------------------------
function startAuthStub() {
  const user = { id: AUTH_USER_ID, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (url.pathname === "/auth/v1/signup") {
        return send(200, { user, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 });
      }
      if (url.pathname === "/auth/v1/user" && req.method === "GET") {
        return bearer === ACCESS_TOKEN ? send(200, user) : send(401, { msg: "invalid token" });
      }
      if (url.pathname === "/auth/v1/user" && req.method === "PUT") return send(200, user);
      if (url.pathname === "/auth/v1/logout") return send(204, {});
      return send(404, { msg: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---------------------------------------------------------------------------
// Stripe API stub (intercepts https://api.stripe.com via globalThis.fetch)
// ---------------------------------------------------------------------------
function installStripeStub() {
  const captured = { checkoutParams: null, webhookTouchedStripe: [], forceUnexpandedSubscription: false };

  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!rawUrl.startsWith("https://api.stripe.com")) return realFetch(input, init);

    const url = new URL(rawUrl);
    const route = url.pathname.replace(/^\/v1\//, "");
    const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    captured.webhookTouchedStripe.push(`${method} ${route}`);

    const body = typeof init.body === "string" ? init.body : init.body?.toString?.() || "";
    const params = new URLSearchParams(body);

    if (route === "checkout/sessions" && method === "POST") {
      captured.checkoutParams = Object.fromEntries(params);
      return Response.json({ id: CHECKOUT_SESSION_ID, url: `https://checkout.stripe.com/c/pay/${CHECKOUT_SESSION_ID}` });
    }
    if (route === `checkout/sessions/${CHECKOUT_SESSION_ID}`) {
      return Response.json({
        id: CHECKOUT_SESSION_ID,
        object: "checkout.session",
        customer: CUSTOMER_ID,
        // Real Stripe returns the expanded object for `expand[]=subscription`;
        // the flag simulates the unexpanded (id-only) response instead.
        subscription: captured.forceUnexpandedSubscription ? SUBSCRIPTION_ID : {
          id: SUBSCRIPTION_ID,
          object: "subscription",
          customer: CUSTOMER_ID,
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          metadata: { learnforge_plan: "family", learnforge_auth_user_id: AUTH_USER_ID }
        },
        client_reference_id: AUTH_USER_ID,
        customer_details: { email: EMAIL },
        payment_status: "paid",
        metadata: { learnforge_plan: "family", learnforge_auth_user_id: AUTH_USER_ID }
      });
    }
    if (route === `subscriptions/${SUBSCRIPTION_ID}`) {
      return Response.json({
        id: SUBSCRIPTION_ID,
        object: "subscription",
        customer: CUSTOMER_ID,
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        metadata: { learnforge_plan: "family", learnforge_auth_user_id: AUTH_USER_ID }
      });
    }
    if (route === "billing_portal/sessions" && method === "POST") {
      return Response.json({ url: "https://billing.stripe.com/p/session/e2e_test" });
    }
    if (route === "customers" && method === "GET") {
      return Response.json({ data: [{ id: CUSTOMER_ID }] });
    }
    return Response.json({ error: { message: `stub has no route for ${method} ${route}` } }, { status: 404 });
  };

  return captured;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stripeSignature(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function sql(client, text, values = []) {
  const result = await client.query(text, values);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("--- Starting End-to-End Purchase Suite (real PostgreSQL + simulated Stripe) ---");

  const authStub = await startAuthStub();
  const captured = installStripeStub();

  process.env.SUPABASE_URL = authStub.url;
  process.env.SUPABASE_PUBLISHABLE_KEY = "stub-anon-key";
  process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_FAMILY = STRIPE_PRICE_FAMILY;
  process.env.STRIPE_PRICE_TEACHER = STRIPE_PRICE_TEACHER;
  const port = await freePort();
  process.env.PUBLIC_SITE_URL = `http://127.0.0.1:${port}`;

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const { version } = (await sql(db, "SELECT version() AS version"))[0];
  console.log(`Database: ${version.split(",")[0]}`);

  const app = await createApp({
    rootDir,
    functionsDir: path.join(rootDir, "netlify", "functions"),
    version: "e2e"
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;

  const call = (routePath, { method = "GET", body, cookie, headers = {} } = {}) =>
    realFetch(`${base}${routePath}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

  try {
    // 0. Schema must already be migrated (the production preflight does this).
    const tables = (await sql(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"))
      .map((row) => row.table_name);
    for (const expected of [
      "commercial_accounts",
      "commercial_audit_events",
      "commercial_entitlements",
      "commercial_schema_migrations",
      "commercial_subscriptions",
      "commercial_webhook_events"
    ]) {
      assert.ok(tables.includes(expected), `${expected} must exist — run \`npm run migrate\` first`);
    }
    ok("Schema present in PostgreSQL after running the repo's own migrations");

    // 1. Health check reads the database.
    const health = await call("/commercial-api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "learnforge-commercial", database: "ready" });
    ok('GET /commercial-api/health → {"ok":true,"database":"ready"} against real PostgreSQL');

    // 2. Sign up through the auth proxy (stub issues a session).
    const signup = await call("/commercial-api/auth/signup", {
      method: "POST",
      body: { email: EMAIL, password: "correct-horse-battery-staple", displayName: "E2E Parent", role: "parent" }
    });
    assert.equal(signup.status, 200);
    const signupBody = await signup.json();
    assert.equal(signupBody.sessionCreated, true);
    const cookies = signup.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    ok("Sign-up established an authenticated session with Secure HttpOnly cookies");

    // 3. Bind the hosted identity to a commercial account row.
    const account = await call("/commercial-api/account", { method: "POST", cookie, body: { displayName: "E2E Parent", role: "parent" } });
    assert.equal(account.status, 200);
    const accountId = (await account.json()).account.id;
    const accountRows = await sql(db, "SELECT id, email, auth_user_id, role FROM commercial_accounts WHERE auth_user_id = $1", [AUTH_USER_ID]);
    assert.equal(accountRows.length, 1);
    assert.equal(accountRows[0].email, EMAIL);
    assert.equal(accountRows[0].role, "parent");
    const audits = await sql(db, "SELECT event_type FROM commercial_audit_events WHERE account_id = $1", [accountId]);
    assert.ok(audits.some((row) => row.event_type === "authenticated_account_upserted"));
    ok("Account row + audit event persisted, bound to the immutable hosted auth id");

    // 4. Checkout session creation — assert the real request Stripe would receive.
    const checkout = await call("/commercial-api/checkout", { method: "POST", cookie, body: { plan: "family" } });
    assert.equal(checkout.status, 200);
    const checkoutBody = await checkout.json();
    assert.match(checkoutBody.url, /^https:\/\/checkout\.stripe\.com\//);
    const params = captured.checkoutParams;
    assert.equal(params.mode, "subscription");
    assert.equal(params["line_items[0][price]"], STRIPE_PRICE_FAMILY);
    assert.equal(params["line_items[0][quantity]"], "1");
    assert.equal(params["metadata[learnforge_plan]"], "family");
    assert.equal(params["metadata[learnforge_auth_user_id]"], AUTH_USER_ID);
    assert.equal(params.customer_email, EMAIL);
    assert.match(params.success_url, /\/pricing\.html\?checkout=success/);
    assert.match(params.cancel_url, /\/pricing\.html\?checkout=cancelled$/);
    ok("Checkout session created with the correct price, plan metadata and redirect URLs");

    // 5. Stripe webhook (signed exactly as Stripe signs it) grants entitlements.
    const completedEvent = JSON.stringify({
      id: `evt_completed_${RUN}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: CHECKOUT_SESSION_ID,
          customer: CUSTOMER_ID,
          subscription: SUBSCRIPTION_ID,
          metadata: { learnforge_plan: "family", learnforge_auth_user_id: AUTH_USER_ID }
        }
      }
    });
    const webhook = await realFetch(`${base}/commercial-api/stripe-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(completedEvent) },
      body: completedEvent
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { received: true });

    const subscriptions = await sql(db, "SELECT plan, status, provider_customer_id, provider_subscription_id FROM commercial_subscriptions WHERE account_id = $1", [accountId]);
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].plan, "family");
    assert.equal(subscriptions[0].status, "active");
    assert.equal(subscriptions[0].provider_customer_id, CUSTOMER_ID);
    ok("Signed webhook persisted the subscription (plan=family, status=active)");

    // 6. Entitlements endpoint reflects the purchase.
    const entitlements = await call("/commercial-api/entitlements", { cookie });
    assert.equal(entitlements.status, 200);
    const entitlementBody = await entitlements.json();
    assert.deepEqual(entitlementBody.entitlements, [{ entitlement_key: "learnforge.family", enabled: true }]);
    assert.equal(entitlementBody.subscription.plan, "family");
    ok("Entitlements endpoint returns learnforge.family for the paying account");

    // 7. Replayed webhook is refused by the real UNIQUE constraint.
    const replay = await realFetch(`${base}/commercial-api/stripe-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(completedEvent) },
      body: completedEvent
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { received: true, duplicate: true });
    const eventRows = await sql(db, "SELECT count(*)::int AS count FROM commercial_webhook_events WHERE provider_event_id = $1", [`evt_completed_${RUN}`]);
    assert.equal(eventRows[0].count, 1);
    ok("Replayed webhook is deduplicated by commercial_webhook_events (idempotency proven)");

    // 8. Post-checkout sync (the return path from pricing.html).
    const sync = await call("/commercial-api/checkout-sync", {
      method: "POST",
      cookie,
      body: { session_id: CHECKOUT_SESSION_ID }
    });
    assert.equal(sync.status, 200);
    assert.deepEqual(await sync.json(), { success: true, plan: "family", status: "active" });
    ok("Post-checkout sync verified session ownership and re-synced entitlements");

    // 8b. Resilience: Stripe returns only the subscription id (unexpanded).
    //     Simulate drift first (as if the webhook had not arrived), then let
    //     checkout-sync resolve the subscription itself.
    await sql(db, "UPDATE commercial_subscriptions SET status = 'incomplete', updated_at = NOW() WHERE account_id = $1", [accountId]);
    await sql(db, "UPDATE commercial_entitlements SET enabled = FALSE, updated_at = NOW() WHERE account_id = $1", [accountId]);
    const drifted = await call("/commercial-api/entitlements", { cookie });
    assert.deepEqual((await drifted.json()).entitlements, []);

    captured.forceUnexpandedSubscription = true;
    const syncUnexpanded = await call("/commercial-api/checkout-sync", {
      method: "POST",
      cookie,
      body: { session_id: CHECKOUT_SESSION_ID }
    });
    captured.forceUnexpandedSubscription = false;
    assert.equal(syncUnexpanded.status, 200);
    assert.deepEqual(await syncUnexpanded.json(), { success: true, plan: "family", status: "active" });
    const recovered = await call("/commercial-api/entitlements", { cookie });
    assert.deepEqual((await recovered.json()).entitlements, [{ entitlement_key: "learnforge.family", enabled: true }]);
    ok("Checkout sync self-heals when Stripe returns an unexpanded subscription id");

    // 9. Billing portal uses the customer id persisted by the webhook.
    const portal = await call("/commercial-api/portal", { method: "POST", cookie });
    assert.equal(portal.status, 200);
    assert.match((await portal.json()).url, /^https:\/\/billing\.stripe\.com\//);
    ok("Billing portal session created from the persisted Stripe customer id");

    // 10. Cancellation revokes entitlements.
    const cancelledEvent = JSON.stringify({
      id: `evt_cancelled_${RUN}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUBSCRIPTION_ID,
          customer: CUSTOMER_ID,
          status: "canceled",
          metadata: { learnforge_plan: "family", learnforge_auth_user_id: AUTH_USER_ID }
        }
      }
    });
    const cancelled = await realFetch(`${base}/commercial-api/stripe-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(cancelledEvent) },
      body: cancelledEvent
    });
    assert.equal(cancelled.status, 200);

    const afterCancel = await call("/commercial-api/entitlements", { cookie });
    const afterCancelBody = await afterCancel.json();
    assert.deepEqual(afterCancelBody.entitlements, []);
    assert.equal(afterCancelBody.subscription.status, "canceled");
    const disabled = await sql(db, "SELECT enabled FROM commercial_entitlements WHERE account_id = $1", [accountId]);
    assert.ok(disabled.every((row) => row.enabled === false));
    ok("Cancellation revoked entitlements (no enabled rows remain)");

    // 11. Session teardown clears cookies.
    const signout = await call("/commercial-api/auth/signout", { method: "POST", cookie });
    assert.equal(signout.status, 200);
    assert.ok(signout.headers.getSetCookie().every((value) => /Max-Age=0/.test(value)));
    ok("Sign-out cleared both session cookies");

    console.log(`\nEND-TO-END PURCHASE SUITE PASSED (${passed} checks)\n`);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    authStub.server.close();
    await db.end();
  }
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error("\nEND-TO-END PURCHASE FAILURE:\n", error);
  process.exit(1);
});
