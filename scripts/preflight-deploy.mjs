#!/usr/bin/env node
/**
 * Go-live preflight.
 *
 * Runs the same checks you would run by hand before pointing a domain at a paid
 * product: configuration completeness, database connectivity, migration state,
 * expected schema, and optionally the live HTTP surface.
 *
 *   npm run preflight                              # config + database + schema
 *   npm run preflight -- --url https://site.tld    # also probes the live host
 *
 * Safe to run against production: it only reads (a single `SELECT 1`, the
 * migration ledger and the health endpoints).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installEnvShim } from "../runtime/env.mjs";
import { CONNECTION_ENV_KEYS, closeDatabase, getDatabase, resolveConnectionString, runMigrations } from "../runtime/database.mjs";
import { findMigrations } from "../runtime/migrate.mjs";

installEnvShim();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_CONFIG = [
  { key: "PUBLIC_SITE_URL", aliases: [], purpose: "Stripe redirect + auth email base URL" },
  { key: "SUPABASE_URL", aliases: [], purpose: "hosted authentication project URL" },
  { key: "SUPABASE_PUBLISHABLE_KEY", aliases: ["SUPABASE_ANON_KEY"], purpose: "hosted authentication public key" },
  { key: "STRIPE_SECRET_KEY", aliases: [], purpose: "checkout + billing portal" },
  { key: "STRIPE_WEBHOOK_SECRET", aliases: [], purpose: "webhook signature verification" },
  { key: "STRIPE_PRICE_FAMILY", aliases: [], purpose: "Family plan price id" },
  { key: "STRIPE_PRICE_TEACHER", aliases: [], purpose: "Teacher plan price id" }
];

const EXPECTED_TABLES = [
  "commercial_accounts",
  "commercial_subscriptions",
  "commercial_entitlements",
  "commercial_audit_events",
  "commercial_webhook_events"
];

let failures = 0;
const pass = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail = "") => {
  failures += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
};

async function checkHttp(baseUrl) {
  const target = baseUrl.replace(/\/$/, "");
  console.log(`\nLive host checks (${target})`);

  for (const [routePath, expectation] of [
    ["/_runtime/health", (body) => body.ok === true],
    ["/commercial-api/health", (body) => body.ok === true && body.database === "ready"]
  ]) {
    try {
      const response = await fetch(`${target}${routePath}`, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 200 && expectation(body)) pass(`GET ${routePath}`, JSON.stringify(body));
      else fail(`GET ${routePath}`, `HTTP ${response.status} ${JSON.stringify(body)}`);
    } catch (error) {
      fail(`GET ${routePath}`, error?.message || String(error));
    }
  }

  try {
    const response = await fetch(`${target}/`, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const html = await response.text();
    if (response.status === 200 && /LearnForge/.test(html)) pass("GET /", `${html.length} bytes`);
    else fail("GET /", `HTTP ${response.status}`);
  } catch (error) {
    fail("GET /", error?.message || String(error));
  }

  // The exposure guard: these must NOT be downloadable from the public origin.
  // Release archives are discovered from the working tree so this keeps working
  // after a version bump.
  const archives = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir).filter((name) => name.endsWith(".zip")).map((name) => `/${name}`)
    : [];
  for (const exposed of [
    ...archives,
    "/netlify/functions/commercial-health.mts",
    "/package.json"
  ]) {
    try {
      const response = await fetch(`${target}${exposed}`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (response.status === 404) pass(`${exposed} is not served`);
      else fail(`${exposed} is PUBLICLY SERVED`, `HTTP ${response.status} — add a deny rule (see netlify.toml)`);
    } catch (error) {
      fail(`${exposed} probe failed`, error?.message || String(error));
    }
  }
}

async function main() {
  const urlFlag = process.argv.indexOf("--url");
  const baseUrl = urlFlag !== -1 ? process.argv[urlFlag + 1] : process.env.PREFLIGHT_URL;

  console.log("=== LearnForge Commercial — deployment preflight ===\n");

  console.log("Configuration");
  for (const entry of REQUIRED_CONFIG) {
    const name = [entry.key, ...entry.aliases].find((candidate) => process.env[candidate]);
    if (name) pass(`${name} is set`, entry.purpose);
    else fail(`${entry.key} is missing`, entry.purpose);
  }

  console.log("\nDatabase");
  const resolved = resolveConnectionString();
  if (!resolved) {
    fail("No connection string", `set one of ${CONNECTION_ENV_KEYS.join(", ")}`);
  } else {
    pass(`${resolved.key} is set`, resolved.value.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"));
    try {
      const db = getDatabase();
      await db.sql`SELECT 1 AS ok`;
      pass("Connection established", `driver=${db.driver}`);

      const migrations = findMigrations();
      const results = await runMigrations(db, migrations, { dryRun: true });
      const pending = results.filter((result) => result.status === "pending");
      const drifted = results.filter((result) => result.status === "changed-after-apply");
      if (pending.length) fail(`${pending.length} migration(s) pending`, "run: npm run migrate");
      else pass(`All ${results.length} migrations applied`);

      if (drifted.length) fail(`${drifted.length} migration file(s) edited after apply`, drifted.map((row) => row.filename).join(", "));
      else pass("No migration drift detected");

      const tables = (await db.sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `).map((row) => row.table_name);
      const missingTables = EXPECTED_TABLES.filter((table) => !tables.includes(table));
      if (missingTables.length) fail("Schema incomplete", missingTables.join(", "));
      else pass(`All ${EXPECTED_TABLES.length} commercial tables present`);
    } catch (error) {
      fail("Database check failed", error?.message || String(error));
    }
  }

  if (baseUrl) await checkHttp(baseUrl);
  else console.log("\nLive host checks: skipped (pass --url https://your-domain to enable)");

  await closeDatabase().catch(() => {});

  console.log("");
  if (failures) {
    console.error(`PREFLIGHT FAILED: ${failures} problem(s) must be fixed before taking live payments.`);
    process.exit(1);
  }
  console.log("PREFLIGHT PASSED: configuration, database and schema are ready.");
}

main().catch(async (error) => {
  console.error("Preflight crashed:", error?.message || error);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
