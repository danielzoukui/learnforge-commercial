#!/usr/bin/env node
/**
 * LearnForge Commercial — one-command go-live.
 *
 * Runs the credential-gated deployment sequence that cannot be performed for you:
 *
 *   phase infra     → Northflank project, PostgreSQL addon, secret group with
 *                     DATABASE_URL linked, combined service, build, wait for ready
 *   phase supabase  → allowed auth redirect URLs for the deployed origin
 *   phase stripe    → webhook endpoint for /commercial-api/stripe-webhook, signing
 *                     secret written back into the Northflank secret group,
 *                     service restarted
 *   phase verify    → preflight + a real test-mode purchase (pm_card_visa instead
 *                     of typing 4242…), asserting the entitlement appears via the
 *                     live webhook and disappears after cancellation
 *
 *   npm run golive -- --dry-run                 # rehearse: prints every request
 *   npm run golive                              # infra + supabase + stripe + verify
 *   npm run golive -- --phase=verify --url https://learnforge.example.com
 *   npm run golive -- --phase=stripe --url https://… --email you@example.com --password '…'
 *
 * Required environment per phase (missing pieces are reported, never guessed):
 *   infra     NORTHFLANK_API_TOKEN
 *   supabase  SUPABASE_ACCESS_TOKEN, SUPABASE_URL
 *   stripe    STRIPE_SECRET_KEY, STRIPE_PRICE_FAMILY
 *   verify    --url (or SITE_URL) and, for a purchase, --email/--password
 *
 * Every step is idempotent: re-running after a failure picks up where it stopped.
 */

import { createLogger, redact } from "./golive/providers.mjs";
import { DEFAULT_REGION, NorthflankClient } from "./golive/northflank.mjs";
import { StripeClient } from "./golive/stripe.mjs";
import { SupabaseClient, projectRefFromUrl } from "./golive/supabase.mjs";

const args = process.argv.slice(2);
const LOOSE_FLAGS = new Set(["dry-run", "quiet", "skip-purchase", "help"]);
const flag = (name, fallback = null) => {
  const token = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (token === undefined) return fallback;
  if (token.includes("=")) {
    const value = token.slice(token.indexOf("=") + 1);
    return value === "" ? true : value;
  }
  const next = args[args.indexOf(token) + 1];
  return LOOSE_FLAGS.has(name) || !next || next.startsWith("--") ? true : next;
};

const dryRun = Boolean(flag("dry-run", false));
const quiet = Boolean(flag("quiet", false));
const phase = String(flag("phase", "all"));
const log = createLogger({ quiet });

// Base URLs are overridable so the whole pipeline can run against a local mock
// (tests/test-golive-pipeline.mjs) or an egress proxy.
const bases = {
  northflank: process.env.NORTHFLANK_API_BASE || "https://api.northflank.com/v1",
  stripe: process.env.STRIPE_API_BASE || "https://api.stripe.com/v1",
  supabase: process.env.SUPABASE_API_BASE || "https://api.supabase.com/v1"
};

const config = {
  siteUrl: String(flag("url", process.env.SITE_URL || process.env.PUBLIC_SITE_URL || "")).replace(/\/$/, ""),
  project: String(flag("project", process.env.NORTHFLANK_PROJECT || "learnforge-commercial")),
  region: String(flag("region", process.env.NORTHFLANK_REGION || DEFAULT_REGION)),
  branch: String(flag("branch", process.env.LEARNFORGE_BRANCH || "main")),
  email: flag("email", process.env.TEST_PURCHASE_EMAIL),
  webhookSecret: flag("webhook-secret", process.env.STRIPE_WEBHOOK_SECRET || null),
  createTestPrice: !process.argv.includes("--no-create-test-price"),
  password: flag("password", process.env.TEST_PURCHASE_PASSWORD),
  migrationsOnBoot: String(process.env.GOLIVE_RUN_MIGRATIONS_ON_BOOT || "true") !== "false",
  northflankToken: process.env.NORTHFLANK_API_TOKEN,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  stripePriceFamily: process.env.STRIPE_PRICE_FAMILY,
  stripePriceTeacher: process.env.STRIPE_PRICE_TEACHER,
  supabaseToken: process.env.SUPABASE_ACCESS_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
  skipPurchase: Boolean(flag("skip-purchase", false))
};

const results = { phases: {}, created: [], warnings: [] };
let context = null;
const needs = (condition, phaseName, message) => {
  if (condition) return true;
  log.fail(`[${phaseName}] ${message}`);
  results.phases[phaseName] = "blocked";
  return false;
};

async function phaseInfra() {
  log.phase("① Northflank infrastructure");
  if (!needs(config.northflankToken || dryRun, "infra", "NORTHFLANK_API_TOKEN is not set (Northflank → Account settings → API tokens)")) return;

  const client = new NorthflankClient({ token: config.northflankToken, baseUrl: bases.northflank, dryRun, log });
  const projectId = await client.ensureProject({ name: config.project, region: config.region });
  const addonId = await client.ensurePostgresAddon({ projectId });
  if (!dryRun) await client.waitForAddon({ projectId, addonId });

  const variables = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "8080",
    ...(config.siteUrl ? { PUBLIC_SITE_URL: config.siteUrl } : {}),
    ...(config.supabaseUrl ? { SUPABASE_URL: config.supabaseUrl } : {}),
    ...(config.supabaseKey ? { SUPABASE_PUBLISHABLE_KEY: config.supabaseKey } : {}),
    ...(config.stripeKey ? { STRIPE_SECRET_KEY: config.stripeKey } : {}),
    ...(config.stripePriceFamily ? { STRIPE_PRICE_FAMILY: config.stripePriceFamily } : {}),
    ...(config.stripePriceTeacher ? { STRIPE_PRICE_TEACHER: config.stripePriceTeacher } : {}),
    ...(config.migrationsOnBoot ? { RUN_MIGRATIONS_ON_BOOT: "true" } : {})
  };
  const { id: secretId } = await client.ensureSecretGroup({ projectId, addonId, variables });

  const serviceId = await client.ensureCombinedService({ projectId, branch: config.branch });
  await client.startBuild({ projectId, serviceId, branch: config.branch });

  if (!dryRun) {
    const { dns } = await client.waitForService({ projectId, serviceId });
    if (dns) {
      const deployed = `https://${dns}`;
      log.ok(`service is live at ${deployed}`);
      if (!config.siteUrl) {
        config.siteUrl = deployed;
        log.info(`using ${deployed} as the site URL for later phases`);
      }
    }
  }

  results.phases.infra = "ok";
  results.northflank = { projectId, addonId, secretId, serviceId };
  if (config.migrationsOnBoot) log.info("RUN_MIGRATIONS_ON_BOOT=true — the service applies the 3 migrations on first boot");
}

async function phaseSupabase() {
  log.phase("② Supabase auth redirect URLs");
  const ref = projectRefFromUrl(config.supabaseUrl);
  if (!needs(config.supabaseUrl, "supabase", "SUPABASE_URL is not set")) return;
  if (!needs(ref, "supabase", `SUPABASE_URL does not look like a project URL (${config.supabaseUrl})`)) return;
  if (!needs(config.supabaseToken || dryRun, "supabase", "SUPABASE_ACCESS_TOKEN is not set (supabase.com/dashboard/account/tokens)")) return;
  if (!needs(config.siteUrl, "supabase", "no site URL yet — pass --url https://your-domain")) return;

  const client = new SupabaseClient({ accessToken: config.supabaseToken, baseUrl: bases.supabase, dryRun, log });
  await client.configureAuthRedirects({ ref, siteUrl: config.siteUrl });

  if (!config.supabaseKey) {
    const key = await client.fetchAnonKey(ref);
    if (key) {
      config.supabaseKey = key;
      log.ok("fetched the publishable key automatically");
    } else {
      results.warnings.push("SUPABASE_PUBLISHABLE_KEY is not set — add it (Supabase → Project Settings → API) and restart the service");
    }
  }
  results.phases.supabase = "ok";
}

/**
 * Locates the project, secret group and service by name so partial runs
 * (`--phase=stripe`, `--phase=verify`) can still write secrets without
 * re-creating infrastructure. Never creates anything, and caches its result.
 */
async function ensureContext() {
  if (context) return context;
  if (results.northflank?.projectId && results.northflank?.secretId) {
    context = { ...results.northflank };
    return context;
  }
  if (!config.northflankToken) return { projectId: null, secretId: null, serviceId: null };
  const client = new NorthflankClient({ token: config.northflankToken, baseUrl: bases.northflank, dryRun, log });
  const { projectId, secretId } = await client.resolveContext({ projectName: config.project, secretName: "learnforge-secrets" });
  let serviceId = null;
  if (projectId) {
    serviceId = (await client.listServices(projectId)).find((service) => service.name === "learnforge")?.id || null;
  }
  context = { projectId, secretId, serviceId };
  return context;
}

async function phaseStripe() {
  log.phase("③ Stripe webhook endpoint");
  if (!needs(config.stripeKey, "stripe", "STRIPE_SECRET_KEY is not set (use sk_test_… for the first pass)")) return;
  if (!needs(config.siteUrl, "stripe", "no site URL yet — pass --url https://your-domain")) return;

  const { projectId, secretId } = await ensureContext();

  const stripe = new StripeClient({ secretKey: config.stripeKey, baseUrl: bases.stripe, dryRun, log });
  const webhookUrl = `${config.siteUrl}/commercial-api/stripe-webhook`;
  const { secret, created } = await stripe.ensureWebhookEndpoint({ url: webhookUrl, fallbackSecret: config.webhookSecret });
  if (!created && config.webhookSecret) log.ok("using the STRIPE_WEBHOOK_SECRET already in your environment");

  if (secret && projectId && secretId && config.northflankToken) {
    const client = new NorthflankClient({ token: config.northflankToken, baseUrl: bases.northflank, dryRun, log });
    await client.syncSecretVariables({ projectId, secretId, variables: { STRIPE_WEBHOOK_SECRET: secret } });
    const { serviceId } = await ensureContext();
    if (serviceId) await client.restartService({ projectId, serviceId });
    results.created.push("STRIPE_WEBHOOK_SECRET written to the secret group");
  } else if (secret) {
    results.warnings.push("Set STRIPE_WEBHOOK_SECRET on the service in the Northflank UI (secret group → learnforge-secrets) and restart it");
  } else if (!created) {
    results.warnings.push(
      "The webhook endpoint already exists, so Stripe will not show its signing secret again. " +
      "Either re-run with STRIPE_WEBHOOK_SECRET=whsec_… (or --webhook-secret whsec_…), or delete the " +
      "endpoint in the Stripe dashboard and re-run to have a fresh one created."
    );
  }

  if (stripe.live) {
    log.warn("STRIPE_SECRET_KEY is a LIVE key — make sure the test purchase has already passed with sk_test_…");
  }
  results.phases.stripe = secret || dryRun ? "ok" : "partial";
}

async function phaseVerify() {
  log.phase("④ Verification");
  if (!needs(config.siteUrl, "verify", "no site URL — pass --url https://your-domain")) return;

  if (dryRun) {
    log.info(`would probe    GET ${config.siteUrl}/commercial-api/health`);
    log.info(`would probe    GET ${config.siteUrl}/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.2.zip (expect 404)`);
    if (config.email && config.password && config.stripeKey) {
      const stripe = new StripeClient({ secretKey: config.stripeKey, baseUrl: bases.stripe, dryRun, log });
      await stripe.runTestPurchase({
        siteUrl: config.siteUrl,
        priceId: config.stripePriceFamily,
        email: String(config.email),
        password: String(config.password)
      });
    } else {
      log.info("would run      a Stripe test-mode purchase (needs --email/--password)");
    }
    results.phases.verify = "ok";
    return;
  }

  const health = await fetch(`${config.siteUrl}/commercial-api/health`).catch((error) => ({ status: 0, error }));
  const healthBody = health.status ? await health.json().catch(() => ({})) : {};
  if (health.status === 200 && healthBody.database === "ready") {
    log.ok(`/commercial-api/health → ${JSON.stringify(healthBody)}`);
  } else {
    log.fail(`/commercial-api/health → HTTP ${health.status} ${JSON.stringify(healthBody)}`);
    results.warnings.push("Health check is not ready: confirm DATABASE_URL is linked and migrations have run");
  }

  const exposure = await fetch(`${config.siteUrl}/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.2.zip`).catch(() => ({ status: 0 }));
  if (exposure.status === 404) log.ok("release archive is not publicly downloadable");
  else log.warn(`archive probe returned HTTP ${exposure.status} — check the deny rules (netlify.toml / runtime allow-list)`);

  if (config.skipPurchase) {
    log.info("test purchase skipped (--skip-purchase)");
  } else if (!config.email || !config.password) {
    // If the project confirms email addresses, sign-up cannot return a session — say
    // so now rather than half-way through a purchase attempt.
    let confirmationsOn = false;
    try {
      const supabaseRef = projectRefFromUrl(config.supabaseUrl);
      if (supabaseRef && config.supabaseToken) {
        const auth = await new SupabaseClient({ accessToken: config.supabaseToken, baseUrl: bases.supabase, dryRun, log }).getAuthConfig(supabaseRef);
        confirmationsOn = auth?.mailer_autoconfirm === false || auth?.disable_signup === true;
      }
    } catch {
      // The setting is a nicety, not a requirement: fall through to the generic advice.
    }
    log.warn("test purchase needs --email and --password for an account on this deployment");
    if (confirmationsOn) {
      log.warn("this Supabase project confirms email addresses, so the automated sign-up cannot get a session:");
      log.warn(`create the account first — ${config.supabaseUrl} → Authentication → Users → Add user (tick "Auto Confirm User")`);
      log.warn("then pass those credentials:");
    }
    log.warn(`  npm run golive -- --phase=verify --url ${config.siteUrl} --email you@example.com --password '…'`);
    results.warnings.push("Run the recovery command above to complete the purchase step, or re-run with --email/--password.");
  } else if (!config.stripeKey || !config.stripePriceFamily) {
    log.warn("test purchase needs STRIPE_SECRET_KEY and STRIPE_PRICE_FAMILY");
  } else {
    const stripe = new StripeClient({ secretKey: config.stripeKey, baseUrl: bases.stripe, dryRun, log });
    let priceId = config.stripePriceFamily;

    if (stripe.live) {
      results.phases.verify = "failed";
      log.fail("STRIPE_SECRET_KEY is a LIVE key — refusing to run a test purchase.");
      log.fail("Stripe rejects test payment methods live, and a live charge is not a rehearsal.");
      log.fail("Re-run with an sk_test_… key (the live key belongs on the service, not in this shell).");
      results.warnings.push("Test purchase skipped: use sk_test_… for the rehearsal, then flip the service to live keys.");
      return;
    }

    // Stripe keeps test and live data separate: a live price id cannot be used with
    // a test key (it answers "No such price"). Reconcile the two before paying.
    const price = await stripe.resolvePrice({ priceId });
    if (price?.livemode) {
      log.warn(`STRIPE_PRICE_FAMILY (${priceId}) is a LIVE price and this key is TEST mode.`);
      if (!config.createTestPrice) {
        results.phases.verify = "failed";
        log.fail("Create the matching price in test mode, or drop --no-create-test-price to create it automatically:");
        log.fail(`    curl https://api.stripe.com/v1/prices -u "${config.stripeKey}:\${STRIPE_SECRET_KEY}" -d product=prod_… -d currency=usd -d unit_amount=300 -d recurring[interval]=month`);
        return;
      }
      const created = await stripe.ensureTestPriceForPlan({ plan: "family", unitAmount: price.unit_amount ?? 300, currency: price.currency ?? "usd" });
      priceId = created.priceId;
      // Keep the deployment's checkout working in test mode too, by pointing the
      // service at the test price for the duration of the rehearsal.
      const { projectId, secretId, serviceId } = await ensureContext();
      if (projectId && secretId && config.northflankToken) {
        const client = new NorthflankClient({ token: config.northflankToken, baseUrl: bases.northflank, dryRun, log });
        await client.syncSecretVariables({ projectId, secretId, variables: { STRIPE_PRICE_FAMILY: priceId } });
        if (serviceId) await client.restartService({ projectId, serviceId });
      } else {
        log.warn(`set STRIPE_PRICE_FAMILY=${priceId} on the service so the browser checkout also works in test mode`);
      }
    }

    const plan = (await stripe.planForPrice({ priceId, familyPrice: config.stripePriceFamily, teacherPrice: config.stripePriceTeacher })) || "family";
    log.info(`test purchase will use price ${priceId} → plan "${plan}"`);

    const run = await stripe.runTestPurchase({
      siteUrl: config.siteUrl,
      priceId,
      plan,
      email: String(config.email),
      password: String(config.password)
    });
    log.ok(`test purchase granted ${run.entitlements.entitlements.map((entry) => entry.entitlement_key).join(", ")}`);
    log.info("when you flip the service to live keys, restore STRIPE_PRICE_FAMILY (and STRIPE_PRICE_TEACHER) to the live price ids");

    log.info("cancelling the test subscription to prove revocation…");
    await stripe.cancelSubscription({ subscriptionId: run.subscriptionId });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const after = await fetch(`${config.siteUrl}/commercial-api/entitlements`, { headers: { cookie: run.cookie } }).then((r) => r.json()).catch(() => ({}));
    if ((after.entitlements || []).length === 0) log.ok("cancellation revoked the entitlement");
    else log.warn(`entitlements still present after cancellation: ${JSON.stringify(after)}`);
  }

  results.phases.verify = "ok";
}

async function main() {
  log.raw(`LearnForge Commercial — go-live automation${dryRun ? " (DRY RUN — no requests will be sent)" : ""}`);
  log.raw(`project=${config.project} region=${config.region} url=${config.siteUrl || "(auto)"} phase=${phase}`);

  const order = [
    ["infra", phaseInfra],
    ["supabase", phaseSupabase],
    ["stripe", phaseStripe],
    ["verify", phaseVerify]
  ];

  for (const [name, fn] of order) {
    if (phase !== "all" && phase !== name) continue;
    try {
      await fn();
    } catch (error) {
      results.phases[name] = "failed";
      log.fail(`[${name}] ${error?.message || error}`);
      if (dryRun) break;
    }
  }

  log.raw("\n=== Summary ===");
  for (const [name, status] of Object.entries(results.phases)) log.raw(`  ${status === "ok" ? "✓" : "✗"} ${name}: ${status}`);
  for (const warning of results.warnings) log.raw(`  ! ${redact(warning)}`);

  const failed = Object.values(results.phases).some((status) => status !== "ok");
  log.raw(failed ? "\nSome phases need attention — re-run after fixing; every step is idempotent.\n" : "\nAll requested phases completed.\n");
  process.exit(failed && !dryRun ? 1 : 0);
}

main().catch((error) => {
  log.fail(`golive crashed: ${error?.message || error}`);
  process.exit(1);
});
