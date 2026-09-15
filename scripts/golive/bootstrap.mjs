#!/usr/bin/env node
/**
 * LearnForge Commercial — go-live readiness check.
 *
 * Run this immediately after creating your accounts. It verifies, with real API
 * calls, that every credential works and every id exists *before* the deployment
 * starts doing things — so a typo surfaces as one clear line instead of a failure
 * ten minutes into a Docker build.
 *
 *   npm run golive:check
 *
 * Exit codes: 0 = ready to deploy, 1 = something needs fixing, 2 = provider APIs
 * are not reachable from this machine (corporate proxy / offline / sandbox).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient, createLogger } from "./providers.mjs";
import { NorthflankClient } from "./northflank.mjs";
import { StripeClient } from "./stripe.mjs";
import { SupabaseClient, projectRefFromUrl } from "./supabase.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const argvValue = (name) => {
  const token = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (token === undefined) return null;
  if (token.includes("=")) return token.slice(token.indexOf("=") + 1) || null;
  const next = args[args.indexOf(token) + 1];
  return next && !next.startsWith("--") ? next : null;
};

const log = createLogger({});
const results = [];
const record = (level, label, detail, fix) => {
  results.push({ level, label, detail, fix });
  const line = `${label}${detail ? ` — ${detail}` : ""}`;
  if (level === "ok") log.ok(line);
  else if (level === "warn") log.warn(line);
  else if (level === "info") log.info(line);
  else log.fail(line);
  if (fix && level !== "ok") log.raw(`      ↳ ${fix}`);
};

const bases = {
  northflank: process.env.NORTHFLANK_API_BASE || "https://api.northflank.com/v1",
  stripe: process.env.STRIPE_API_BASE || "https://api.stripe.com/v1",
  supabase: process.env.SUPABASE_API_BASE || "https://api.supabase.com/v1"
};

const config = {
  northflankToken: process.env.NORTHFLANK_API_TOKEN,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  stripePriceFamily: process.env.STRIPE_PRICE_FAMILY || argvValue("family-price"),
  stripePriceTeacher: process.env.STRIPE_PRICE_TEACHER || argvValue("teacher-price"),
  supabaseToken: process.env.SUPABASE_ACCESS_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  siteUrl: (argvValue("url") || process.env.SITE_URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, ""),
  project: argvValue("project") || process.env.NORTHFLANK_PROJECT || "learnforge-commercial",
  branch: argvValue("branch") || process.env.LEARNFORGE_BRANCH || "main"
};

async function reachable(url, timeoutMs = 8000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error?.cause?.code || error?.name || String(error) };
  }
}

function checkLocal() {
  log.phase("① This machine and this checkout");
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  record(nodeOk ? "ok" : "fail", `Node ${process.versions.node}`, nodeOk ? "" : "needs Node 22.18 or newer (type stripping, native fetch)",
    "Install Node 22 LTS from nodejs.org, or use the Docker image.");

  const dockerfile = path.join(rootDir, "Dockerfile");
  const hasDockerfile = fs.existsSync(dockerfile);
  record(hasDockerfile ? "ok" : "fail", "Dockerfile present in this checkout",
    hasDockerfile ? "" : `not found at ${dockerfile}`,
    "You are on a branch that predates the container build. Merge pull request #2, or deploy the arena branch with --branch.");

  // The service builds a specific branch. If that branch is not what you have
  // checked out, the build can fail on files this checkout has but the branch does not.
  record("info", `Deployment branch set to "${config.branch}"`, "", null);
  return hasDockerfile;
}

async function checkConnectivity() {
  log.phase("② Provider APIs reachable");
  const hosts = [
    ["Northflank", `${bases.northflank}/projects`],
    ["Stripe", `${bases.stripe}/balance`],
    ["Supabase", `${bases.supabase}/projects`]
  ];
  const outcomes = {};
  for (const [name, url] of hosts) {
    const result = await reachable(url);
    outcomes[name.toLowerCase()] = result.ok;
    // 401/403 still proves the API answered, which is what matters here.
    record(result.ok ? "ok" : "fail", `${name} API responds`,
      result.ok ? `HTTP ${result.status}` : `unreachable (${result.error})`,
      result.ok ? null : "Run this on your own machine/network — some sandboxes and corporate proxies block these hosts.");
  }
  return outcomes;
}

async function checkNorthflank() {
  log.phase("③ Northflank token");
  if (!config.northflankToken) {
    record("fail", "NORTHFLANK_API_TOKEN is not set", "",
      "northflank.com → Account settings → API tokens → Create (project create/write), then: export NORTHFLANK_API_TOKEN=nfp_…");
    return false;
  }
  const client = new NorthflankClient({ token: config.northflankToken, baseUrl: bases.northflank, log: null });
  try {
    const projects = await client.listProjects();
    const match = projects.find((project) => project.name === config.project);
    record("ok", "Token accepted", `${projects.length} project(s) visible`);
    if (match) record("ok", `Project "${config.project}" already exists`, "the run will reuse it (idempotent)");
    else record("info", `Project "${config.project}" will be created`, "");
  } catch (error) {
    const hint = error?.status === 401 || error?.status === 403
      ? "The token is valid but lacks project permissions, or belongs to another team. Recreate it with project create/write on the Sandbox team."
      : "Check the token string and that the API is reachable from this network.";
    record("fail", `Northflank rejected the token (${error?.status || error?.message || error})`, "", hint);
    return false;
  }

  try {
    const { data } = await client.http.get("/teams");
    const teams = Array.isArray(data) ? data : data?.data || [];
    if (teams.length) record("info", `Teams visible to this token: ${teams.map((team) => team.name || team.id).join(", ")}`, "");
  } catch {
    // Team listing is optional; project listing above already proved the token works.
  }
  return true;
}

async function checkStripe() {
  log.phase("④ Stripe key and prices");
  if (!config.stripeKey) {
    record("fail", "STRIPE_SECRET_KEY is not set", "",
      "Stripe → Developers → API keys. Use sk_test_… for the first pass, then sk_live_… when you flip.");
    return false;
  }
  const stripe = new StripeClient({ secretKey: config.stripeKey, baseUrl: bases.stripe, log: null });
  const client = new HttpClient({ provider: "stripe", baseUrl: bases.stripe, token: config.stripeKey, log: null });

  try {
    const { data } = await client.get("/balance");
    const balance = data?.data || data;
    const live = Boolean(balance?.livemode);
    record("ok", `Key accepted — ${live ? "LIVE mode" : "test mode"}`,
      live ? "test payment methods will be refused; the rehearsal must use sk_test_…" : "safe for the rehearsal",
      live ? "Export an sk_test_… key for the test purchase; keep the live key for the service only." : null);
  } catch (error) {
    record("fail", `Stripe rejected the key (${error?.status || error?.message || error})`, "", "Copy the secret key again from Developers → API keys.");
    return false;
  }

  try {
    const { data } = await client.get("/account");
    const account = data?.data || data;
    if (account?.id) record("info", `Stripe account ${account.id}${account.country ? ` (${account.country})` : ""}`, "");
  } catch {
    // Some restricted keys cannot read the account; the balance call already proved auth.
  }

  for (const [label, priceId] of [["STRIPE_PRICE_FAMILY", config.stripePriceFamily], ["STRIPE_PRICE_TEACHER", config.stripePriceTeacher]]) {
    if (!priceId) {
      record("warn", `${label} is not set`, "", "The repository's live defaults are used. Set it explicitly if you created your own prices.");
      continue;
    }
    try {
      const price = await stripe.resolvePrice({ priceId });
      const amount = price?.unit_amount != null ? `${(price.unit_amount / 100).toFixed(2)} ${String(price.currency || "").toUpperCase()}` : "amount unknown";
      record("ok", `${label} exists`, `${priceId} — ${amount}${price?.livemode ? ", LIVE price" : ", test price"}`);
    } catch (error) {
      record("fail", `${label} not found (${priceId})`, `${error?.status || error?.message || error}`,
        "Either the id is from the other Stripe mode, or it was deleted. Dashboard → Products → your price → copy the id.");
    }
  }
  return true;
}

async function checkSupabase() {
  log.phase("⑤ Supabase project and auth redirect");
  if (!config.supabaseUrl) {
    record("fail", "SUPABASE_URL is not set", "",
      "Supabase → Project Settings → API → Project URL, then: export SUPABASE_URL=https://<ref>.supabase.co");
    return false;
  }
  const ref = projectRefFromUrl(config.supabaseUrl);
  if (!ref) {
    record("fail", `SUPABASE_URL does not look like a project URL`, config.supabaseUrl,
      "It must be https://<project-ref>.supabase.co (the dashboard URL is not the API URL).");
    return false;
  }
  record("ok", "Supabase project reference parsed", ref);

  if (!config.supabaseToken) {
    record("fail", "SUPABASE_ACCESS_TOKEN is not set", "",
      "supabase.com/dashboard/account/tokens → Generate new token, then: export SUPABASE_ACCESS_TOKEN=sbp_…");
    return false;
  }
  const client = new SupabaseClient({ accessToken: config.supabaseToken, baseUrl: bases.supabase, log: null });
  try {
    const { data } = await client.http.get(`/projects/${ref}`);
    const project = data?.data || data;
    record("ok", "Management token accepted", `${project?.name || ref}${project?.region ? ` (${project.region})` : ""}${project?.status ? ` — ${project.status}` : ""}`);
  } catch (error) {
    record("fail", `Supabase rejected the token (${error?.status || error?.message || error})`, "",
      "Regenerate at supabase.com/dashboard/account/tokens; it needs access to this project.");
    return false;
  }

  try {
    const auth = await client.getAuthConfig(ref);
    const existing = String(auth?.uri_allow_list || "").split(",").map((value) => value.trim()).filter(Boolean);
    record("ok", "Auth configuration readable",
      existing.length ? `${existing.length} redirect URL(s) already allowed` : "no redirect URLs configured yet");
  } catch (error) {
    record("warn", `Could not read the auth configuration (${error?.status || error?.message || error})`, "",
      "The token may be project-scoped without auth_config_write. The redirect step will report the same thing during the run.");
  }

  if (!config.siteUrl) {
    record("info", "Site URL will be discovered from the deployed service", "", null);
  }
  return true;
}

async function main() {
  log.raw("\nLearnForge Commercial — go-live readiness check\n");

  const dockerfileOk = checkLocal();
  const connectivity = await checkConnectivity();
  const apiUp = Object.values(connectivity).every(Boolean);

  const northflankOk = await checkNorthflank();
  const stripeOk = await checkStripe();
  const supabaseOk = await checkSupabase();

  const failures = results.filter((entry) => entry.level === "fail").length;
  const warnings = results.filter((entry) => entry.level === "warn").length;

  log.raw("\n=== Summary ===");
  log.raw(`  passed: ${results.filter((entry) => entry.level === "ok").length}   warnings: ${warnings}   failures: ${failures}`);

  if (!dockerfileOk || !northflankOk || !stripeOk || !supabaseOk || failures) {
    log.raw("\nMissing pieces are listed with a ↳ fix above. Re-run this check after each one.\n");
    process.exit(apiUp ? 1 : 2);
  }

  log.raw("\nEverything checks out. Next:");
  log.raw("  npm run golive -- --dry-run      # rehearse: prints every request, sends nothing");
  log.raw("  npm run golive                   # deploy, configure and verify\n");
  process.exit(0);
}

main().catch((error) => {
  log.fail(`readiness check crashed: ${error?.message || error}`);
  process.exit(1);
});
