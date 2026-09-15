/**
 * Guards the Netlify publish-root exposure.
 *
 * `netlify.toml` publishes the repository root (`publish = "."`), so every
 * committed file is eligible for static serving unless a forced [[redirects]]
 * rule denies it. This suite fails the build if a sensitive path becomes
 * reachable, and it also checks that the portable runtime's own allow-list
 * (runtime/router.mjs) blocks the same paths — keeping both hosts consistent.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_ALLOWED, REQUIRED_DENIES, classify } from "../scripts/check-netlify-exposure.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

console.log("--- Starting Netlify Exposure Test Suite ---");

const toml = fs.readFileSync(path.join(rootDir, "netlify.toml"), "utf8");
const publish = /publish\s*=\s*"([^"]+)"/.exec(toml)?.[1];
const rules = toml.split(/\[\[redirects\]\]/).slice(1).map((block) => {
  const body = block.split(/\[\[|\n\[/)[0];
  return {
    from: /from\s*=\s*"([^"]+)"/.exec(body)?.[1],
    to: /to\s*=\s*"([^"]+)"/.exec(body)?.[1],
    status: Number(/status\s*=\s*(\d+)/.exec(body)?.[1] || 0),
    force: /force\s*=\s*(true|false)/.exec(body)?.[1] === "true"
  };
}).filter((rule) => rule.from);

assert.equal(publish, ".", "publish = \".\" is the documented configuration this guard protects");
assert.ok(rules.length >= REQUIRED_DENIES.length / 2, "Expected a deny rule per sensitive category");

// 1. Every deny rule must be a forced 404 so it outranks static asset serving.
for (const rule of rules) {
  assert.equal(rule.status, 404, `${rule.from} must rewrite to 404, not ${rule.status}`);
  assert.equal(rule.force, true, `${rule.from} must set force = true to take precedence over static assets`);
  assert.ok(rule.to.startsWith("/commercial-api/"), `${rule.from} should target an internal 404 responder`);
  assert.ok(!/^https?:/.test(rule.to), `${rule.from} must not redirect off-site`);
}
console.log(`✓ All ${rules.length} deny rules are forced 404 rewrites to an internal responder`);

// 2. The 404 responder must not be a real product route (otherwise it would be a leak surface).
const declaredRoutes = new Set(
  fs.readdirSync(path.join(rootDir, "netlify", "functions"))
    .filter((name) => name.endsWith(".mts"))
    .map((name) => /path:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(rootDir, "netlify", "functions", name), "utf8"))?.[1])
);
for (const rule of rules) {
  assert.ok(!declaredRoutes.has(rule.to.split("?")[0]), `${rule.to} must not be a declared API route`);
}
console.log(`✓ The internal 404 responder is not one of the ${declaredRoutes.size} declared API routes`);

// 3. Nothing sensitive may be servable.
for (const target of REQUIRED_DENIES) {
  const result = classify(target, rules);
  assert.equal(result.served, false, `${target} is still publicly served`);
  assert.equal(result.status, 404, `${target} should resolve to 404`);
}
console.log(`✓ All ${REQUIRED_DENIES.length} sensitive paths (sources, migrations, archives, env, CI) are blocked`);

// 4. The product must still be reachable.
for (const target of REQUIRED_ALLOWED) {
  const result = classify(target, rules);
  assert.equal(result.served, true, `${target} must remain reachable`);
}
console.log(`✓ All ${REQUIRED_ALLOWED.length} product paths remain reachable`);

// 5. The audit script must agree (it runs in CI as `npm run test:exposure`).
const audit = execFileSync(process.execPath, ["scripts/check-netlify-exposure.mjs"], { cwd: rootDir }).toString();
assert.match(audit, /EXPOSURE AUDIT PASSED/);
console.log("✓ scripts/check-netlify-exposure.mjs reports a clean audit");

// 6. The portable runtime enforces the same boundary at request time.
const { isPublicPath } = await import("../runtime/router.mjs");
for (const target of REQUIRED_DENIES) {
  assert.equal(isPublicPath(target.replace(/^\//, "")), false, `portable runtime must not serve ${target}`);
}
for (const target of REQUIRED_ALLOWED.filter((value) => value !== "/")) {
  assert.equal(isPublicPath(target.replace(/^\//, "")), true, `portable runtime must serve ${target}`);
}
console.log("✓ Portable runtime allow-list blocks the same paths and still serves the product pages");

// 7. The archives referenced by the deny rules must exist (so the rule is not dead code).
const archives = fs.readdirSync(rootDir).filter((name) => name.endsWith(".zip"));
assert.ok(archives.length > 0, "Expected the committed release archives that motivated the deny rules");
for (const archive of archives) {
  assert.equal(classify(`/${archive}`, rules).served, false, `${archive} must be blocked`);
}
console.log(`✓ All ${archives.length} committed release archive(s) resolve to blocked`);

console.log("\nNETLIFY EXPOSURE TESTS PASSED!\n");
