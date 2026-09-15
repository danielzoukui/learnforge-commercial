#!/usr/bin/env node
/**
 * Reports whether a Netlify-published repository root would expose internals.
 *
 * `netlify.toml` uses `publish = "."`, so every committed file is *eligible* for
 * static serving unless a forced [[redirects]] rule denies it. This script parses
 * those rules, classifies a set of sensitive paths with the same glob semantics,
 * and exits non-zero if any of them would be served.
 *
 *   node scripts/check-netlify-exposure.mjs               # audit the repo
 *   node scripts/check-netlify-exposure.mjs --path /x/y   # classify one path
 *
 * Glob support: Netlify's `*` splat (matches anything except `/`), `/**`, and
 * exact matches — which is all this configuration uses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Paths that must never be downloadable from the production origin. */
export const REQUIRED_DENIES = [
  "/netlify/functions/commercial-health.mts",
  "/netlify/functions/_shared/commercial-auth.ts",
  "/netlify/database/migrations/20260912140000_commercial_core/migration.sql",
  "/runtime/server.mjs",
  "/runtime/database.mjs",
  "/tests/test-commercial.mjs",
  "/scripts/package-release.mjs",
  "/deploy/.env.example",
  "/deploy/docker-compose.yml",
  "/.github/workflows/ci.yml",
  "/.git/config",
  "/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.0.zip",
  "/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.1.zip",
  "/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.2.zip",
  "/package.json",
  "/package-lock.json",
  "/netlify.toml",
  "/Dockerfile",
  "/.env",
  "/.env.production",
  "/.gitignore",
  "/.dockerignore",
  "/commercial-config.ts"
];

/** Paths that must stay reachable: a deny rule must not swallow the product. */
export const REQUIRED_ALLOWED = [
  "/",
  "/index.html",
  "/pricing.html",
  "/auth.html",
  "/support.html",
  "/privacy.html",
  "/terms.html",
  "/commercial-config.js"
];

function parseRedirects(toml) {
  const rules = [];
  const blocks = toml.split(/\[\[redirects\]\]/).slice(1);
  for (const block of blocks) {
    const body = block.split(/\[\[|\n\[/)[0];
    const from = /from\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const to = /to\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const status = Number(/status\s*=\s*(\d+)/.exec(body)?.[1] || 0);
    const force = /force\s*=\s*(true|false)/.exec(body)?.[1] === "true";
    if (from) rules.push({ from, to, status, force });
  }
  return rules;
}

function globToRegExp(glob) {
  // Netlify's `*` is a splat: it matches any characters *including* slashes, which
  // is why `/*` is used for SPA fallbacks and why `/netlify/*` also blocks
  // `/netlify/functions/x.mts`. Modelling it as `[^/]*` would under-report exposure.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Mirrors Netlify's precedence: forced rules apply before static assets, and the
 * most specific (longest) source match wins.
 */
export function classify(pathname, rules) {
  const matches = rules
    .filter((rule) => globToRegExp(rule.from).test(pathname))
    .sort((a, b) => b.from.length - a.from.length);

  if (!matches.length) return { served: true, rule: null };
  const rule = matches[0];
  return { served: rule.status === 200, rule, status: rule.status, to: rule.to };
}

function main() {
  const single = process.argv.indexOf("--path");
  const toml = fs.readFileSync(path.join(rootDir, "netlify.toml"), "utf8");
  const rules = parseRedirects(toml);
  const publish = /publish\s*=\s*"([^"]+)"/.exec(toml)?.[1];

  if (single !== -1) {
    // Single-path mode answers one question: "is this path exposed to the public?"
    // Exit code 1 therefore means EXPOSED (served), so it can gate a shell check:
    //   node scripts/check-netlify-exposure.mjs --path /some/file || echo leaked
    const target = process.argv[single + 1];
    const result = classify(target, rules);
    const verdict = result.served ? "EXPOSED (served)" : `BLOCKED (${result.status})`;
    console.log(`${target} → ${verdict} via ${result.rule?.from || "static file serving"}`);
    process.exit(result.served ? 1 : 0);
  }

  console.log("=== Netlify static exposure audit ===");
  console.log(`publish directory : ${publish}`);
  console.log(`forced 404 rules  : ${rules.filter((rule) => rule.status === 404 && rule.force).length} of ${rules.length}`);
  console.log("");

  let failures = 0;

  console.log("Must be blocked:");
  for (const target of REQUIRED_DENIES) {
    const result = classify(target, rules);
    const mark = result.served ? "✗ SERVED" : "✓ blocked";
    if (result.served) failures += 1;
    console.log(`  ${mark.padEnd(10)} ${target}${result.rule ? `  ← ${result.rule.from}` : ""}`);
  }

  console.log("\nMust stay reachable:");
  for (const target of REQUIRED_ALLOWED) {
    const result = classify(target, rules);
    const mark = result.served ? "✓ served" : `✗ BLOCKED (${result.status})`;
    if (!result.served) failures += 1;
    console.log(`  ${mark.padEnd(16)} ${target}${result.rule ? `  ← ${result.rule.from}` : ""}`);
  }

  console.log("");
  if (failures) {
    console.error(`EXPOSURE AUDIT FAILED: ${failures} path(s) mis-classified.`);
    process.exit(1);
  }
  console.log(`EXPOSURE AUDIT PASSED: all ${REQUIRED_DENIES.length} sensitive paths blocked, all ${REQUIRED_ALLOWED.length} product paths served.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
