/**
 * Verifies the go-live automation end to end, without any real credentials.
 *
 * Topology:
 *   mock provider API  ←  scripts/golive.mjs (the code under test)
 *        │  (Northflank + Stripe + Supabase endpoints, all implemented here)
 *        │
 *        └─ delivers a real, HMAC-signed Stripe webhook →
 *              the real portable runtime (runtime/server.mjs)
 *                    └─ real PostgreSQL (DATABASE_URL)
 *
 * So the pipeline's own logic — ordering, idempotency, secret propagation, the
 * test-purchase assertions — is exercised against genuine handlers, a genuine
 * database and genuine signature verification. Only the three vendor APIs are
 * simulated, at their documented paths.
 *
 *   npm run test:golive                     # skips when DATABASE_URL is unset
 *   DATABASE_URL=… node tests/test-golive-pipeline.mjs --require-database
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireDatabase = process.argv.includes("--require-database");

if (!process.env.DATABASE_URL) {
  if (requireDatabase) {
    console.error("FAIL: --require-database was passed but DATABASE_URL is not set.");
    process.exit(1);
  }
  console.log("--- Go-Live Pipeline Suite: SKIP (set DATABASE_URL to run) ---");
  process.exit(0);
}

const WEBHOOK_SECRET = "whsec_golive_pipeline_test_0123456789";
const PROJECT = "learnforge-commercial";
const AUTH_USER_ID = `golive-user-${Date.now()}`;
const ACCESS_TOKEN = "golive-access-token";
const REFRESH_TOKEN = "golive-refresh-token";
const EMAIL = `golive+${Date.now()}@example.com`;
const PASSWORD = "correct-horse-battery-staple";
// Every provider object id is run-unique. Fixed ids would collide with rows left
// in the database by an earlier run and be discarded as webhook replays.
const RUN = Date.now().toString(36);

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`✓ ${label}`);
};

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Mock of the three vendor APIs at their documented paths, plus a Supabase Auth
 * stand-in. Records every call for later assertions and relays Stripe webhook
 * events to the running application.
 */
async function startMockProviders({ siteUrl }) {
  const state = {
    calls: [],
    project: null,
    addons: [],
    secrets: [],
    services: [],
    subscriptions: new Map(),
    webhookEndpoints: [],
    createdPrices: [],
    products: [],
    supabaseAuth: { site_url: null, uri_allow_list: "" },
    webhookSecret: WEBHOOK_SECRET
  };

  const sign = (payload) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", state.webhookSecret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
    return `t=${timestamp},v1=${signature}`;
  };

  const deliver = async (event) => {
    const payload = JSON.stringify(event);
    await fetch(`${siteUrl}/commercial-api/stripe-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sign(payload) },
      body: payload
    }).catch(() => null);
  };

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw)); // Stripe uses form encoding
    }
    state.calls.push({ method: req.method, path: url.pathname, query: url.search, body, headers: req.headers });

    const p = url.pathname;

    // ---- Supabase Auth stand-in -------------------------------------------
    if (p === "/auth/v1/signup") {
      return json(res, 200, { user: { id: AUTH_USER_ID, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" }, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 });
    }
    if (p === "/auth/v1/user" && req.method === "GET") {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (bearer === ACCESS_TOKEN) return json(res, 200, { id: AUTH_USER_ID, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" });
      return json(res, 401, { msg: "invalid token" });
    }
    if (p.startsWith("/auth/v1/token")) {
      return json(res, 400, { error_description: "Invalid login credentials" }); // forces the sign-up path
    }
    if (p === "/auth/v1/logout") return json(res, 204, {});

    // ---- Supabase Management API ------------------------------------------
    if (p.endsWith("/config/auth") && req.method === "GET") return json(res, 200, state.supabaseAuth);
    if (p.endsWith("/config/auth") && req.method === "PATCH") {
      state.supabaseAuth = { ...state.supabaseAuth, ...body };
      return json(res, 200, state.supabaseAuth);
    }
    if (p.endsWith("/api-keys")) return json(res, 200, [{ name: "anon", api_key: "mock-anon-key" }]);

    // ---- Northflank --------------------------------------------------------
    if (p === "/v1/projects" && req.method === "GET") return json(res, 200, { data: { projects: state.project ? [state.project] : [] } });
    if (p === "/v1/projects" && req.method === "POST") {
      state.project = { id: body.name, name: body.name, region: body.region };
      return json(res, 201, { data: state.project });
    }
    if (p === `/v1/projects/${PROJECT}/addons` && req.method === "GET") return json(res, 200, { data: { addons: state.addons } });
    if (p === `/v1/projects/${PROJECT}/addons` && req.method === "POST") {
      const addon = { id: `${body.name}-id`, name: body.name, type: body.type, version: body.version, status: "ready" };
      state.addons.push(addon);
      return json(res, 201, { data: addon });
    }
    if (p.startsWith(`/v1/projects/${PROJECT}/addons/`) && req.method === "GET") return json(res, 200, { data: state.addons[0] });
    if (p === `/v1/projects/${PROJECT}/secrets` && req.method === "GET") return json(res, 200, { data: { secrets: state.secrets } });
    if (p === `/v1/projects/${PROJECT}/secrets` && req.method === "POST") {
      const secret = { id: "learnforge-secrets-id", name: body.name, variables: body.secrets?.variables || {}, addonDependencies: body.addonDependencies || [] };
      state.secrets.push(secret);
      return json(res, 201, { data: secret });
    }
    if (p.startsWith(`/v1/projects/${PROJECT}/secrets/`) && req.method === "PATCH") {
      const secret = state.secrets[0];
      if (!secret) return json(res, 404, { error: "not found" });
      secret.variables = { ...secret.variables, ...(body.secrets?.variables || {}) };
      return json(res, 200, { data: secret });
    }
    if (p === `/v1/projects/${PROJECT}/services` && req.method === "GET") return json(res, 200, { data: { services: state.services } });
    if (p === `/v1/projects/${PROJECT}/services/combined` && req.method === "POST") {
      const service = { id: body.name, name: body.name, status: "running", ports: [{ internalPort: body.ports?.[0]?.internalPort, dns: "learnforge-mock.code.run", public: true }] };
      state.services.push(service);
      return json(res, 201, { data: service });
    }
    if (p.startsWith(`/v1/projects/${PROJECT}/services/`) && p.endsWith("/build") && req.method === "POST") return json(res, 201, { data: { id: "build-1", status: "queued" } });
    if (p.startsWith(`/v1/projects/${PROJECT}/services/`) && p.endsWith("/restart") && req.method === "POST") return json(res, 200, { data: { status: "restarting" } });
    if (p.startsWith(`/v1/projects/${PROJECT}/services/`) && req.method === "GET") return json(res, 200, { data: state.services[0] });

    // ---- Stripe ------------------------------------------------------------
    if (p === "/v1/webhook_endpoints" && req.method === "GET") return json(res, 200, { data: state.webhookEndpoints });
    if (p === "/v1/webhook_endpoints" && req.method === "POST") {
      const endpoint = { id: "we_mock_1", url: body.url, enabled_events: Object.keys(body).filter((k) => k.startsWith("enabled_events")).map((k) => body[k]) };
      state.webhookEndpoints.push(endpoint);
      return json(res, 200, { ...endpoint, secret: WEBHOOK_SECRET });
    }
    if (p.startsWith("/v1/webhook_endpoints/") && req.method === "POST") return json(res, 200, { id: p.split("/").pop() });
    if (p === "/v1/balance" && req.method === "GET") return json(res, 200, { livemode: false, available: [] });
    if (p === "/v1/account" && req.method === "GET") return json(res, 200, { id: "acct_mock", country: "US", email: EMAIL });
    if (p === "/v1/teams" && req.method === "GET") return json(res, 200, [{ id: "team_mock", name: "LearnForge Sandbox" }]);
    if (p === "/v1/projects/mockref" && req.method === "GET") return json(res, 200, { id: "mockref", name: "learnforge-supabase", region: "us-east-1", status: "ACTIVE_HEALTHY" });
    if (p.startsWith("/v1/prices/") && req.method === "GET") {
      const id = p.split("/").pop();
      // Any price named *live* belongs to live mode, mirroring the ids baked into
      // the repository's documentation; everything else is a test-mode price.
      return json(res, 200, { id, livemode: id.toLowerCase().includes("live"), unit_amount: 300, currency: "usd", product: "prod_mock_live", metadata: {} });
    }
    if (p === "/v1/products" && req.method === "POST") {
      const product = { id: `prod_test_${RUN}`, name: body.name, metadata: body["metadata[learnforge_plan]"] ? { learnforge_plan: body["metadata[learnforge_plan]"] } : {} };
      state.products.push(product);
      return json(res, 200, product);
    }
    if (p === "/v1/prices" && req.method === "POST") {
      state.createdPrices.push(body);
      return json(res, 200, {
        id: `price_test_${RUN}`,
        livemode: false,
        unit_amount: Number(body.unit_amount),
        currency: body.currency,
        product: body.product,
        metadata: body["metadata[learnforge_plan]"] ? { learnforge_plan: body["metadata[learnforge_plan]"] } : {}
      });
    }
    if (p.startsWith("/v1/products/") && req.method === "GET") {
      const id = p.split("/").pop();
      const product = state.products.find((entry) => entry.id === id) || { id, metadata: {} };
      return json(res, 200, product);
    }
    if (p === "/v1/customers" && req.method === "POST") {
      return json(res, 200, { id: `cus_mock_${RUN}`, email: body.email });
    }
    if (p === "/v1/subscriptions" && req.method === "POST") {
      const authUserId = body["metadata[learnforge_auth_user_id]"];
      const plan = body["metadata[learnforge_plan]"] || "family";
      const subscriptionId = `sub_mock_${RUN}_${state.subscriptions.size + 1}`;
      const subscription = {
        id: subscriptionId,
        customer: body.customer,
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        metadata: { learnforge_auth_user_id: authUserId, learnforge_plan: plan }
      };
      state.subscriptions.set(subscriptionId, subscription);
      // Stripe delivers the event asynchronously; mirror that.
      setTimeout(() => deliver({ id: `evt_created_${subscriptionId}`, type: "customer.subscription.created", data: { object: subscription } }), 50);
      return json(res, 200, subscription);
    }
    if (p.startsWith("/v1/subscriptions/") && req.method === "GET") {
      const id = p.split("/").pop();
      return state.subscriptions.has(id) ? json(res, 200, state.subscriptions.get(id)) : json(res, 404, { error: { message: "not found" } });
    }
    if (p.startsWith("/v1/subscriptions/") && req.method === "DELETE") {
      const id = p.split("/").pop();
      const subscription = state.subscriptions.get(id) || { id, customer: `cus_mock_${RUN}`, metadata: {} };
      state.subscriptions.set(id, { ...subscription, status: "canceled" });
      setTimeout(() => deliver({ id: `evt_deleted_${id}`, type: "customer.subscription.deleted", data: { object: { ...subscription, status: "canceled" } } }), 50);
      return json(res, 200, { ...subscription, status: "canceled" });
    }

    return json(res, 404, { error: `mock has no route for ${req.method} ${p}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

async function startApp({ databaseUrl, supabaseUrl, port }) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(rootDir, "runtime", "server.mjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: databaseUrl,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: "mock-anon-key",
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_FAMILY: "price_mock_family",
      STRIPE_PRICE_TEACHER: "price_mock_teacher",
      PUBLIC_SITE_URL: `http://127.0.0.1:${port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_runtime/health`);
      if (response.ok) return { child, log: () => output };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`app did not start:\n${output}`);
}

function runBootstrap(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(rootDir, "scripts", "golive", "bootstrap.mjs")], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function runGolive(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(rootDir, "scripts", "golive.mjs"), ...args], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function main() {
  console.log("--- Starting Go-Live Pipeline Suite (mock providers + real app + real PostgreSQL) ---");

  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const providers = await startMockProviders({ siteUrl: appUrl });
  const app = await startApp({ databaseUrl: process.env.DATABASE_URL, supabaseUrl: providers.url, port: appPort });

  let appLog = app.log;

  const goliveEnv = {
    NORTHFLANK_API_TOKEN: "nfp_test_token",
    NORTHFLANK_API_BASE: `${providers.url}/v1`,
    STRIPE_API_BASE: `${providers.url}/v1`,
    SUPABASE_API_BASE: `${providers.url}/v1`,
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_PRICE_FAMILY: "price_mock_family",
    STRIPE_PRICE_TEACHER: "price_mock_teacher",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token",
    SUPABASE_URL: `https://mockref.supabase.co`,
    SUPABASE_PUBLISHABLE_KEY: "mock-anon-key",
    SITE_URL: appUrl,
    TEST_PURCHASE_EMAIL: EMAIL,
    TEST_PURCHASE_PASSWORD: PASSWORD
  };

  try {
    // 1. Dry run: prints requests, changes nothing.
    const before = providers.state.calls.length;
    const dry = await runGolive(["--dry-run", "--quiet"], goliveEnv);
    assert.equal(dry.code, 0, `dry run should exit 0:\n${dry.output}`);
    assert.match(dry.output, /DRY RUN/);
    assert.equal(providers.state.calls.length, before, "dry run must not call any provider API");
    assert.equal(providers.state.project, null, "dry run must not create resources");
    ok("--dry-run rehearses every phase without touching a provider API");

    // 2. Real run against the mocks.
    const run = await runGolive([], goliveEnv);
    assert.equal(run.code, 0, `go-live run should exit 0:\n${run.output}`);

    const paths = providers.state.calls.map((call) => `${call.method} ${call.path}`);
    for (const expected of [
      "POST /v1/projects",
      `POST /v1/projects/${PROJECT}/addons`,
      `POST /v1/projects/${PROJECT}/secrets`,
      `POST /v1/projects/${PROJECT}/services/combined`,
      `POST /v1/projects/${PROJECT}/services/learnforge/build`,
      "POST /v1/webhook_endpoints",
      "PATCH /v1/projects/mockref/config/auth"
    ]) {
      assert.ok(paths.includes(expected), `expected call missing: ${expected}\nactual: ${paths.join("\n")}`);
    }
    ok(`pipeline issued the full resource graph (${paths.length} provider calls)`);

    // 3. Resource payloads match the production contract.
    const addon = providers.state.addons[0];
    assert.equal(addon.type, "postgresql");
    assert.equal(addon.version, "16");
    const secretCall = providers.state.calls.find((call) => call.method === "POST" && call.path.endsWith("/secrets"));
    assert.deepEqual(secretCall.body.addonDependencies[0].keys, [{ keyName: "POSTGRES_URI", aliases: ["DATABASE_URL"] }]);
    assert.equal(secretCall.body.secrets.variables.RUN_MIGRATIONS_ON_BOOT, "true");
    assert.equal(secretCall.body.secrets.variables.PUBLIC_SITE_URL, appUrl);
    const serviceCall = providers.state.calls.find((call) => call.path.endsWith("/services/combined"));
    assert.equal(serviceCall.body.ports[0].internalPort, 8080);
    assert.equal(serviceCall.body.healthChecks[0].path, "/_runtime/health");
    assert.equal(serviceCall.body.healthChecks[0].type, "livenessProbe");
    assert.equal(serviceCall.body.buildSettings.dockerfile.dockerFilePath, "/Dockerfile");
    assert.equal(serviceCall.body.vcsData.projectBranch, "main");
    ok("addon, secret group, service port, health check and Dockerfile payloads are correct");

    // 4. The webhook signing secret was written back into the secret group.
    const patch = providers.state.calls.find((call) => call.method === "PATCH" && call.path.includes("/secrets/"));
    assert.ok(patch, "expected the webhook secret to be pushed into the secret group");
    assert.equal(patch.body.secrets.variables.STRIPE_WEBHOOK_SECRET, WEBHOOK_SECRET);
    assert.ok(paths.includes(`POST /v1/projects/${PROJECT}/services/learnforge/restart`), "service should restart to pick up the secret");
    ok("Stripe signing secret propagated to the service and the service was restarted");

    // 5. Supabase redirect URLs configured for the deployed origin.
    assert.equal(providers.state.supabaseAuth.site_url, appUrl);
    assert.match(providers.state.supabaseAuth.uri_allow_list, new RegExp(`${appUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\*\\*`));
    ok("Supabase site_url and allowed redirect URLs point at the deployed origin");

    // 6. The test purchase ran for real, through the real webhook.
    assert.match(run.output, /test purchase granted learnforge\.family/);
    assert.match(run.output, /cancellation revoked the entitlement/);
    assert.ok(providers.state.subscriptions.size >= 1, "a test subscription should have been created");
    ok("test-mode purchase granted the entitlement and cancellation revoked it");

    // 7. Idempotency: re-running creates nothing new.
    const afterFirst = {
      addons: providers.state.addons.length,
      secrets: providers.state.secrets.length,
      services: providers.state.services.length,
      endpoints: providers.state.webhookEndpoints.length
    };
    const second = await runGolive(["--phase=infra", "--quiet"], goliveEnv);
    assert.equal(second.code, 0, `second infra run should exit 0:\n${second.output}`);
    assert.ok(!/Supabase auth redirect/.test(second.output), "--phase=infra must not run the Supabase phase");
    assert.ok(!/Stripe webhook endpoint/.test(second.output), "--phase=infra must not run the Stripe phase");
    assert.deepEqual(
      {
        addons: providers.state.addons.length,
        secrets: providers.state.secrets.length,
        services: providers.state.services.length,
        endpoints: providers.state.webhookEndpoints.length
      },
      afterFirst,
      "a second run must not duplicate resources"
    );
    assert.match(second.output, /already exists/);
    ok("re-running the pipeline is idempotent (no duplicate resources)");

    // 8. Re-running the Stripe phase: honest guidance when the signing secret is
    //    unavailable, success once it is supplied.
    const stripeOnly = await runGolive(["--phase=stripe", "--quiet"], { ...goliveEnv, SITE_URL: appUrl });
    assert.equal(stripeOnly.code, 1, "stripe phase should report the manual step when the secret cannot be recovered");
    assert.match(stripeOnly.output, /copy its signing secret|STRIPE_WEBHOOK_SECRET=whsec_/i);

    const stripeWithSecret = await runGolive(["--phase=stripe", "--quiet"], { ...goliveEnv, SITE_URL: appUrl, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    assert.equal(stripeWithSecret.code, 0, `stripe phase should succeed with a supplied secret:\n${stripeWithSecret.output}`);
    const secretPatches = providers.state.calls.filter((call) => call.method === "PATCH" && call.path.includes("/secrets/"));
    assert.equal(secretPatches.at(-1).body.secrets.variables.STRIPE_WEBHOOK_SECRET, WEBHOOK_SECRET);
    assert.ok(!stripeWithSecret.output.includes(WEBHOOK_SECRET), "the supplied secret must stay redacted");
    ok("existing webhook endpoint is adopted when its signing secret is supplied");

    // 9. A live price id with a test key: Stripe keeps the two modes separate, so
    //    the automation creates a matching test price, tags the plan, points the
    //    deployment at it, and still completes the purchase.
    const beforePriceCalls = providers.state.createdPrices.length;
    const livePrice = await runGolive(["--phase=verify", "--quiet"], {
      ...goliveEnv,
      SITE_URL: appUrl,
      STRIPE_PRICE_FAMILY: "price_LIVE_family"
    });
    assert.equal(livePrice.code, 0, `verify should handle the live/test price split:\n${livePrice.output}`);
    assert.match(livePrice.output, /is a LIVE price and this key is TEST mode/);
    assert.equal(providers.state.createdPrices.length, beforePriceCalls + 1, "a test-mode price should have been created");
    const createdPrice = providers.state.createdPrices.at(-1);
    assert.equal(createdPrice["recurring[interval]"], "month");
    assert.equal(createdPrice["metadata[learnforge_plan]"], "family");
    const repointed = providers.state.calls.filter((call) => call.method === "PATCH" && call.path.includes("/secrets/")).at(-1);
    assert.match(repointed.body.secrets.variables.STRIPE_PRICE_FAMILY, new RegExp(`price_test_${RUN}`), "the deployment should be repointed at the test price");
    assert.match(livePrice.output, /test purchase granted learnforge\.family/);
    ok("live price + test key: creates a plan-tagged test price, repoints the deployment, purchase still passes");

    // 10. A live key is refused outright rather than charged.
    const liveKey = await runGolive(["--phase=verify", "--quiet"], {
      ...goliveEnv,
      SITE_URL: appUrl,
      STRIPE_SECRET_KEY: "sk_live_not_a_rehearsal",
      STRIPE_PRICE_FAMILY: "price_LIVE_family"
    });
    assert.equal(liveKey.code, 1, "a live key must not run a test purchase");
    assert.match(liveKey.output, /refusing to run a test purchase/);
    ok("live key is refused before any charge is attempted");

    // 11. The readiness checker validates real credentials end to end.
    const cleanEnv = { ...process.env };
    for (const key of ["NORTHFLANK_API_TOKEN", "STRIPE_SECRET_KEY", "SUPABASE_ACCESS_TOKEN", "SUPABASE_URL", "STRIPE_PRICE_FAMILY", "STRIPE_PRICE_TEACHER", "SITE_URL", "PUBLIC_SITE_URL"]) {
      delete cleanEnv[key];
    }

    // Credentials absent but the APIs answer → exit 1, one line per missing piece.
    const bare = await runBootstrap({
      ...cleanEnv,
      NORTHFLANK_API_BASE: `${providers.url}/v1`,
      STRIPE_API_BASE: `${providers.url}/v1`,
      SUPABASE_API_BASE: `${providers.url}/v1`
    });
    assert.equal(bare.code, 1, `the checker should fail when credentials are absent:\n${bare.output}`);
    for (const expected of ["NORTHFLANK_API_TOKEN is not set", "STRIPE_SECRET_KEY is not set", "SUPABASE_URL is not set"]) {
      assert.ok(bare.output.includes(expected), `expected the checker to report: ${expected}\n${bare.output}`);
    }
    assert.ok(bare.output.includes("↳"), "every failure should carry a fix instruction");
    ok("readiness checker names every missing credential with a fix instruction");

    // APIs unreachable (this sandbox, a corporate proxy) → exit 2, distinct from a
    // credential mistake, with the reason stated plainly.
    const offline = await runBootstrap({ ...cleanEnv, NORTHFLANK_API_BASE: "http://127.0.0.1:9/v1" });
    assert.equal(offline.code, 2, `unreachable APIs should exit 2:\n${offline.output}`);
    assert.match(offline.output, /unreachable/);
    assert.match(offline.output, /Run this on your own machine/);
    ok("unreachable provider APIs exit 2 with the reason stated (not confused with a bad token)");

    const ready = await runBootstrap({
      ...cleanEnv,
      NORTHFLANK_API_TOKEN: "nfp_test_token",
      NORTHFLANK_API_BASE: `${providers.url}/v1`,
      STRIPE_API_BASE: `${providers.url}/v1`,
      SUPABASE_API_BASE: `${providers.url}/v1`,
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_PRICE_FAMILY: "price_test_family",
      STRIPE_PRICE_TEACHER: "price_test_teacher",
      SUPABASE_ACCESS_TOKEN: "sbp_test_token",
      SUPABASE_URL: "https://mockref.supabase.co"
    });
    assert.equal(ready.code, 0, `the checker should pass with working credentials:\n${ready.output}`);
    for (const expected of ["Token accepted", "test mode", "Management token accepted", "exists"]) {
      assert.ok(ready.output.includes(expected), `expected the checker to confirm: ${expected}\n${ready.output}`);
    }
    assert.match(ready.output, /Teams visible to this token: LearnForge Sandbox/);
    assert.ok(ready.output.includes("npm run golive"), "a passing check should print the next command");
    ok("readiness checker passes with working credentials and prints the next command");

    // A live price with a test key is called out before the run gets that far.
    const livePriceCheck = await runBootstrap({
      ...cleanEnv,
      NORTHFLANK_API_TOKEN: "nfp_test_token",
      NORTHFLANK_API_BASE: `${providers.url}/v1`,
      STRIPE_API_BASE: `${providers.url}/v1`,
      SUPABASE_API_BASE: `${providers.url}/v1`,
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_PRICE_FAMILY: "price_LIVE_family",
      STRIPE_PRICE_TEACHER: "price_LIVE_teacher",
      SUPABASE_ACCESS_TOKEN: "sbp_test_token",
      SUPABASE_URL: "https://mockref.supabase.co"
    });
    assert.equal(livePriceCheck.code, 0, `mode reporting should not be a failure:\n${livePriceCheck.output}`);
    assert.match(livePriceCheck.output, /LIVE price/);
    ok("readiness checker reports the mode of each configured price");

    // 12. Secrets are never printed in clear text.
    assert.ok(!run.output.includes(WEBHOOK_SECRET), "the webhook secret must not appear in logs");
    assert.ok(!run.output.includes("sk_test_mock"), "the Stripe key must not appear in logs");
    ok("provider secrets are redacted from all pipeline output");

    console.log(`\nGO-LIVE PIPELINE SUITE PASSED (${passed} checks)\n`);
  } catch (error) {
    console.error("\n--- application log (last 60 lines) ---");
    console.error(appLog().split("\n").slice(-60).join("\n"));
    throw error;
  } finally {
    app.child.kill("SIGTERM");
    providers.server.close();
  }
}

main().catch((error) => {
  console.error("\nGO-LIVE PIPELINE FAILURE:\n", error);
  process.exit(1);
});
