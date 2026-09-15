#!/usr/bin/env node
/**
 * Portable LearnForge Commercial server.
 *
 * Serves the static product pages and every `/commercial-api/*` handler from
 * `netlify/functions/*.mts` on any Node 22+ host:
 *
 *     PORT=8080 DATABASE_URL=postgres://... node runtime/server.mjs
 *
 * Deployment targets: Northflank, Render, Fly, Railway, Koyeb, Docker, or any
 * VM with Node installed. The same source tree still deploys to Netlify unchanged.
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { installEnvShim } from "./env.mjs";
import { closeDatabase, verifyDatabase } from "./database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const functionsDir = path.join(rootDir, "netlify", "functions");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "17.0.0";

if (installEnvShim()) {
  console.log("[runtime] Netlify.env shim installed (read-only view of process.env)");
}

// Must run before the handlers are imported: it maps `@netlify/database` onto
// the portable PostgreSQL implementation.
register(new URL("./loader.mjs", import.meta.url));

async function loadApp(attempt = 1) {
  try {
    const { createApp } = await import("./router.mjs");
    return await createApp({ rootDir, functionsDir, version: VERSION });
  } catch (error) {
    const hooksRace = error?.code === "ERR_MODULE_NOT_FOUND"
      && String(error.message).includes("@netlify/database");
    if (hooksRace && attempt < 5) {
      // The customization-hooks thread can still be warming up on the first import.
      await new Promise((resolve) => setTimeout(resolve, 75 * attempt));
      return loadApp(attempt + 1);
    }
    if (hooksRace) {
      console.error(
        "\nCould not map `@netlify/database` to the portable driver.\n" +
        "Start the server with one of:\n" +
        "  npm start                                  (recommended)\n" +
        "  node --disable-warning=ExperimentalWarning runtime/server.mjs\n" +
        "Node 22.18+ is required for native TypeScript handling of netlify/functions/*.mts\n"
      );
    }
    throw error;
  }
}

const app = await loadApp();

/**
 * Configuration preflight. Netlify surfaces these as site settings; on a
 * portable host they are plain environment variables, so report what is missing
 * at boot instead of at the first customer checkout.
 */
const CONFIGURATION = [
  { key: "PUBLIC_SITE_URL", aliases: [], purpose: "absolute URL used in Stripe redirects and auth emails" },
  { key: "SUPABASE_URL", aliases: [], purpose: "hosted authentication project URL" },
  { key: "SUPABASE_PUBLISHABLE_KEY", aliases: ["SUPABASE_ANON_KEY"], purpose: "hosted authentication public key" },
  { key: "STRIPE_SECRET_KEY", aliases: [], purpose: "checkout, billing portal" },
  { key: "STRIPE_WEBHOOK_SECRET", aliases: [], purpose: "Stripe webhook signature verification" },
  { key: "STRIPE_PRICE_FAMILY", aliases: [], purpose: "Family plan price id" },
  { key: "STRIPE_PRICE_TEACHER", aliases: [], purpose: "Teacher plan price id" }
];

const missingConfiguration = CONFIGURATION.filter(
  (entry) => !entry.aliases.concat(entry.key).some((name) => process.env[name])
);

const server = http.createServer((req, res) => {
  app.handle(req, res).catch((error) => {
    console.error("[runtime] request failed:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      res.end();
    }
  });
});

server.on("error", (error) => {
  console.error(`[runtime] fatal server error: ${error?.message || error}`);
  process.exit(1);
});

// Bind first so health checks and rolling deploys succeed immediately, then
// report database/config readiness. A missing database must not delay serving
// the static product pages.
server.listen(PORT, HOST, async () => {
  console.log("LearnForge Commercial — portable runtime");
  console.log(`  node         : ${process.version}`);
  console.log(`  static root  : ${rootDir}`);
  console.log(`  api routes   : ${app.routes.size} (build ${app.hash})`);
  console.log(`  listening on : http://${HOST}:${PORT}`);

  const db = await verifyDatabase();
  if (db.ok) {
    console.log(`[database] ready (driver=${db.driver})`);
  } else {
    console.warn(`[database] NOT ready: ${db.error || "connection failed"}`);
    console.warn("[database] /commercial-api/health returns 503 until PostgreSQL is configured.");
  }

  if (missingConfiguration.length) {
    console.warn(`[config] ${missingConfiguration.length} of ${CONFIGURATION.length} environment variables are not set:`);
    for (const entry of missingConfiguration) {
      console.warn(`[config]   ${entry.key.padEnd(26)} ${entry.purpose}`);
    }
    console.warn("[config] Billing, auth and entitlement endpoints stay disabled until these are set.");
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[runtime] ${signal} received, shutting down`);
    server.close(async () => {
      await closeDatabase().catch(() => {});
      process.exit(0);
    });
    // Never hang a platform scale-down waiting on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

export { server };
