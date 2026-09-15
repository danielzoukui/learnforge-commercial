/**
 * End-to-end verification of the portable runtime.
 *
 * Boots `runtime/server.mjs` exactly as a host would, against a stub Supabase
 * Auth service, and drives the real HTTP surface:
 *
 *   - static pages, header parity with netlify.toml, gzip, allow-listing
 *   - every declared /commercial-api/* route is mounted (parity with the
 *     Netlify function declarations)
 *   - session cookies, sign-in/sign-out/refresh flows
 *   - Stripe webhook signature verification over the real HMAC path
 *   - the "not configured yet" 503 behaviour for billing/auth
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockDatabase, runMigrations } from "../runtime/database.mjs";
import { findMigrations } from "../runtime/migrate.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, "runtime");
const functionsDir = path.join(rootDir, "netlify", "functions");

const ACCESS_TOKEN = "stub-access-token";
const REFRESH_TOKEN = "stub-refresh-token";
const USER = { id: "11111111-2222-3333-4444-555555555555", email: "parent@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const WEBHOOK_SECRET = "whsec_test_secret_key_1234567890abcdef";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`✓ ${label}`);
}

function freePort() {
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

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Minimal Supabase Auth stand-in: only the routes the handlers call. */
async function startStubAuth() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const body = await readJson(req);

    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      if (body.email === USER.email && body.password === "correct-horse-battery-staple") {
        return json(res, 200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, user: USER });
      }
      return json(res, 400, { error_description: "Invalid login credentials" });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (body.refresh_token === REFRESH_TOKEN) {
        return json(res, 200, { access_token: `${ACCESS_TOKEN}-rotated`, refresh_token: `${REFRESH_TOKEN}-rotated`, expires_in: 3600 });
      }
      return json(res, 400, { error_description: "Invalid Refresh Token" });
    }
    if (url.pathname === "/auth/v1/user" && req.method === "GET") {
      if (bearer === ACCESS_TOKEN || bearer === `${ACCESS_TOKEN}-rotated`) return json(res, 200, USER);
      return json(res, 401, { msg: "invalid claim" });
    }
    if (url.pathname === "/auth/v1/user" && req.method === "PUT") return json(res, 200, { ok: true });
    if (url.pathname === "/auth/v1/signup") return json(res, 200, { user: { ...USER, email: body.email } });
    if (url.pathname === "/auth/v1/recover") return json(res, 200, {});
    if (url.pathname === "/auth/v1/logout") return json(res, 204, {});
    return json(res, 404, { msg: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

async function startRuntime(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(runtimeDir, "server.mjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LEARNFORGE_DB_DRIVER: "mock",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited early (${child.exitCode}):\n${output}`);
    try {
      // Readiness is "accepts connections", never "printed a banner".
      const probe = await fetch(`${base}/_runtime/health`);
      if (probe.ok) return { child, base, log: () => output };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`runtime did not start in time:\n${output}`);
}

async function stopRuntime(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  const exited = new Promise((resolve) => instance.child.once("exit", resolve));
  instance.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
}

async function main() {
  console.log("--- Starting Portable Runtime Test Suite ---");

  // 1. Every runtime module must be syntactically valid for the deployed Node.
  for (const file of fs.readdirSync(runtimeDir).filter((name) => name.endsWith(".mjs")).sort()) {
    execFileSync(process.execPath, ["--check", path.join(runtimeDir, file)]);
  }
  ok(`Runtime modules pass \`node --check\` (${fs.readdirSync(runtimeDir).filter((n) => n.endsWith(".mjs")).length} files)`);

  // 2. Route parity with the Netlify function declarations.
  const declaredRoutes = fs.readdirSync(functionsDir)
    .filter((name) => name.endsWith(".mts"))
    .map((name) => /path:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(functionsDir, name), "utf8"))?.[1])
    .filter(Boolean);
  assert.equal(declaredRoutes.length, 15, "Expected 15 declared commercial API routes");

  const stub = await startStubAuth();
  const runtime = await startRuntime({
    SUPABASE_URL: stub.url,
    SUPABASE_PUBLISHABLE_KEY: "stub-anon-key"
  });

  try {
    const health = await fetch(`${runtime.base}/_runtime/health`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.routes, declaredRoutes.length, "runtime must mount every declared route");
    ok(`Portable runtime boots with all ${healthBody.routes} API routes mounted`);

    for (const route of declaredRoutes) {
      const response = await fetch(`${runtime.base}${route}`);
      assert.notEqual(response.status, 404, `${route} must be mounted`);
    }
    ok("Every /commercial-api route declared by netlify/functions is reachable");

    // 3. Static delivery parity with netlify.toml.
    const index = await fetch(`${runtime.base}/`, { headers: { "accept-encoding": "gzip" } });
    const indexHtml = await index.text();
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.equal(index.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(index.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(index.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
    assert.equal(index.headers.get("content-encoding"), "gzip");
    assert.match(index.headers.get("vary"), /accept-encoding/i);
    assert.match(indexHtml, /LearnForge/);
    ok("Static index.html served with netlify.toml header and cache parity (gzip enabled)");

    const extensionless = await fetch(`${runtime.base}/auth`);
    assert.equal(extensionless.status, 200);
    assert.match(await extensionless.text(), /LearnForge|Sign/i);
    ok("Extensionless routes resolve to the .html page (/auth → auth.html)");

    for (const blocked of [
      "/netlify/functions/commercial-health.mts",
      "/package.json",
      "/runtime/server.mjs",
      "/tests/test-commercial.mjs",
      "/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.0.zip"
    ]) {
      const response = await fetch(`${runtime.base}${blocked}`);
      assert.equal(response.status, 404, `${blocked} must not be publicly served`);
    }
    ok("Source files, CI config and release archives are not publicly served");

    const traversal = await fetch(`${runtime.base}/%2e%2e%2f%2e%2e%2fetc/passwd`);
    assert.equal(traversal.status, 404);
    ok("Directory traversal attempts are rejected");

    const missing = await fetch(`${runtime.base}/does-not-exist`);
    assert.equal(missing.status, 404);
    ok("Unknown static path returns 404");

    // 4. API behaviour.
    const apiHealth = await fetch(`${runtime.base}/commercial-api/health`);
    assert.equal(apiHealth.status, 200);
    assert.deepEqual(await apiHealth.json(), { ok: true, service: "learnforge-commercial", database: "ready" });
    ok("/commercial-api/health reaches the database through the portable driver");

    const unknownApi = await fetch(`${runtime.base}/commercial-api/nope`);
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(await unknownApi.json(), { error: "Endpoint not found" });
    ok("Unknown API route returns JSON 404");

    const anonSession = await fetch(`${runtime.base}/commercial-api/auth/session`);
    assert.equal(anonSession.status, 401);
    assert.deepEqual(await anonSession.json(), { error: "Authentication required" });
    ok("Anonymous session lookup returns 401 (thrown-Response convention preserved)");

    const wrongMethod = await fetch(`${runtime.base}/commercial-api/account`);
    assert.equal(wrongMethod.status, 405);
    ok("Method mismatch returns 405");

    const badSignup = await fetch(`${runtime.base}/commercial-api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" })
    });
    assert.equal(badSignup.status, 400);
    ok("Sign-up validation rejects malformed input");

    const wrongPassword = await fetch(`${runtime.base}/commercial-api/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: USER.email, password: "wrong-password" })
    });
    assert.equal(wrongPassword.status, 401);
    ok("Sign-in with invalid credentials returns 401");

    const signin = await fetch(`${runtime.base}/commercial-api/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: USER.email, password: "correct-horse-battery-staple" })
    });
    assert.equal(signin.status, 200);
    const cookies = signin.headers.getSetCookie();
    assert.equal(cookies.length, 2, "sign-in must set access and refresh cookies");
    const accessCookie = cookies.find((value) => value.startsWith("lf_access_token="));
    const refreshCookie = cookies.find((value) => value.startsWith("lf_refresh_token="));
    assert.match(accessCookie, /HttpOnly/);
    assert.match(accessCookie, /SameSite=Lax/);
    assert.match(accessCookie, /Secure/);
    ok("Sign-in sets Secure HttpOnly session cookies through the portable runtime");

    const cookieHeader = `${accessCookie.split(";")[0]}; ${refreshCookie.split(";")[0]}`;

    const session = await fetch(`${runtime.base}/commercial-api/auth/session`, { headers: { cookie: cookieHeader } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.user.email, USER.email);
    ok("Authenticated session lookup verifies the token against the auth provider");

    const entitlements = await fetch(`${runtime.base}/commercial-api/entitlements`, { headers: { cookie: cookieHeader } });
    assert.equal(entitlements.status, 200);
    assert.deepEqual(await entitlements.json(), { account: null, subscription: null, entitlements: [] });
    ok("Entitlements query runs through the portable PostgreSQL shim");

    const refresh = await fetch(`${runtime.base}/commercial-api/auth/refresh`, { method: "POST", headers: { cookie: refreshCookie } });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.headers.getSetCookie().length, 2);
    ok("Token refresh rotates both cookies");

    const signout = await fetch(`${runtime.base}/commercial-api/auth/signout`, { method: "POST", headers: { cookie: cookieHeader } });
    assert.equal(signout.status, 200);
    for (const cleared of signout.headers.getSetCookie()) {
      assert.match(cleared, /Max-Age=0/);
    }
    ok("Sign-out clears the session cookies");

    // Billing handlers check Stripe configuration before authentication, so an
    // unconfigured deployment fails closed with 503 rather than leaking an
    // ownership error. Auth enforcement is asserted further down with keys set.
    const checkoutUnconfigured = await fetch(`${runtime.base}/commercial-api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "family" })
    });
    assert.equal(checkoutUnconfigured.status, 503);
    assert.deepEqual(await checkoutUnconfigured.json(), { error: "Billing is not configured yet" });
    ok("Checkout fails closed with 503 while Stripe is unconfigured");

    const portalAnon = await fetch(`${runtime.base}/commercial-api/portal`, { method: "POST" });
    assert.equal(portalAnon.status, 503);
    assert.deepEqual(await portalAnon.json(), { error: "Billing is not configured yet" });
    ok("Billing endpoints report 503 (not 500) while Stripe keys are unset");

    const webhookUnconfigured = await fetch(`${runtime.base}/commercial-api/stripe-webhook`, { method: "POST", body: "{}" });
    assert.equal(webhookUnconfigured.status, 503);
    ok("Stripe webhook reports 503 while the signing secret is unset");

    const authUnconfiguredRuntime = await startRuntime({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", STRIPE_WEBHOOK_SECRET: "" });
    try {
      const response = await fetch(`${authUnconfiguredRuntime.base}/commercial-api/auth/signin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: USER.email, password: "correct-horse-battery-staple" })
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.match(body.error, /not configured/i);
      assert.match(body.hint, /SUPABASE_URL/);
      ok("Missing auth configuration returns an actionable 503 instead of a 500");
    } finally {
      await stopRuntime(authUnconfiguredRuntime);
    }

    // 5. Stripe webhook over the real signature path.
    const stripeRuntime = await startRuntime({
      SUPABASE_URL: stub.url,
      SUPABASE_PUBLISHABLE_KEY: "stub-anon-key",
      STRIPE_SECRET_KEY: "sk_test_stub",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET
    });
    try {
      const checkoutAnon = await fetch(`${stripeRuntime.base}/commercial-api/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "family" })
      });
      assert.equal(checkoutAnon.status, 401);
      assert.deepEqual(await checkoutAnon.json(), { error: "Authentication required" });

      const portalAnon = await fetch(`${stripeRuntime.base}/commercial-api/portal`, { method: "POST" });
      assert.equal(portalAnon.status, 401);
      ok("With Stripe configured, checkout and portal require an authenticated session first");

      const event = JSON.stringify({
        id: "evt_portable_test_001",
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_1", metadata: { learnforge_auth_user_id: USER.id, learnforge_plan: "family" } } }
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${event}`, "utf8").digest("hex");

      const unsigned = await fetch(`${stripeRuntime.base}/commercial-api/stripe-webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=deadbeef` },
        body: event
      });
      assert.equal(unsigned.status, 400);
      assert.deepEqual(await unsigned.json(), { error: "Invalid Stripe signature" });
      ok("Stripe webhook rejects a tampered signature");

      const verified = await fetch(`${stripeRuntime.base}/commercial-api/stripe-webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: event
      });
      assert.equal(verified.status, 200);
      assert.deepEqual(await verified.json(), { received: true });
      ok("Stripe webhook verifies HMAC and processes the event end-to-end");
    } finally {
      await stopRuntime(stripeRuntime);
    }

    await stopRuntime(runtime);
  } finally {
    await stopRuntime(runtime);
    stub.server.close();
  }

  // 6. Migration engine: discovery order, tracking table, idempotency.
  const migrations = findMigrations();
  assert.equal(migrations.length, 3, "Expected the three commercial migrations");
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [...migrations.map((migration) => migration.version)].sort(),
    "Migrations must be applied in version order"
  );
  for (const migration of migrations) {
    assert.ok(migration.sql.trim().length > 0, `${migration.filename} must not be empty`);
    assert.ok(!/DROP\s+TABLE/i.test(migration.sql), `${migration.filename} must not drop tables`);
  }
  ok(`Migration discovery finds ${migrations.length} versioned files in order`);

  const migrationDb = createMockDatabase();
  const firstRun = await runMigrations(migrationDb, migrations);
  assert.ok(firstRun.every((result) => result.status === "applied"), "First run applies every migration");
  assert.ok(
    migrationDb.queries.some((query) => /CREATE TABLE IF NOT EXISTS commercial_schema_migrations/.test(query.text)),
    "The tracking table is created"
  );

  const secondRun = await runMigrations(migrationDb, migrations);
  assert.ok(secondRun.every((result) => result.status === "already-applied"), "Re-running is a no-op");
  ok("Migrations are tracked and applied exactly once (idempotent re-runs)");

  const statusRun = await runMigrations(createMockDatabase(), migrations, { dryRun: true });
  assert.ok(statusRun.every((result) => result.status === "pending"), "--status reports pending work");
  ok("`--status` reports pending migrations without changing the schema");

  const tampered = migrations.map((migration, index) =>
    index === 0 ? { ...migration, sql: `${migration.sql}\n-- edited after apply` } : migration
  );
  const driftRun = await runMigrations(migrationDb, tampered);
  assert.equal(driftRun[0].status, "changed-after-apply");
  ok("Editing an already-applied migration is detected instead of silently skipped");

  console.log(`\nALL PORTABLE RUNTIME TESTS PASSED (${passed} checks)!\n`);
}

main().catch((error) => {
  console.error("\nPORTABLE RUNTIME TEST FAILURE:\n", error);
  process.exit(1);
});
