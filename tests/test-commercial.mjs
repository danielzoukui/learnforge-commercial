import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("--- Starting LearnForge Commercial Test Suite ---");

// 1. Verify required files exist
const requiredFiles = [
  "index.html",
  "pricing.html",
  "auth.html",
  "support.html",
  "privacy.html",
  "terms.html",
  "commercial-config.js",
  "netlify.toml",
  "package.json",
  "COMMERCIALIZATION_README.md"
];

for (const file of requiredFiles) {
  assert(fs.existsSync(file), `Expected ${file} to exist`);
  const content = fs.readFileSync(file, "utf8");
  assert(content.length > 0, `Expected ${file} to have content`);
}
console.log("✓ Core project files exist and are non-empty");

// 2. Verify commercial-config.js
const configContent = fs.readFileSync("commercial-config.js", "utf8");
assert(configContent.includes("lf_prod_privacy_url"), "Should configure privacy URL");
assert(configContent.includes("lf_prod_terms_url"), "Should configure terms URL");
assert(configContent.includes("lf_prod_pricing_url"), "Should configure pricing URL");
assert(configContent.includes("/commercial-api/checkout"), "Should reference checkout API");
assert(configContent.includes("/commercial-api/portal"), "Should reference portal API");
assert(configContent.includes("/commercial-api/checkout-sync"), "Should reference checkout-sync API");
console.log("✓ commercial-config.js contains all required routes and storage keys");

// 3. Verify pricing.html
const pricingHtml = fs.readFileSync("pricing.html", "utf8");
assert(pricingHtml.includes("Family"), "Should contain Family plan");
assert(pricingHtml.includes("Teacher"), "Should contain Teacher plan");
assert(pricingHtml.includes("$3"), "Should specify $3 for Family");
assert(pricingHtml.includes("$5"), "Should specify $5 for Teacher");
assert(pricingHtml.includes("/commercial-api/portal"), "Should support portal");
assert(pricingHtml.includes("/commercial-api/checkout-sync"), "Should support checkout-sync");
console.log("✓ pricing.html properly presents commercial tiers and billing actions");

// 4. Verify index.html maintains integrity and commercial enhancements
const indexHtml = fs.readFileSync("index.html", "utf8");
assert(indexHtml.includes("lf-commercial-runtime"), "Runtime script must be present");
assert(indexHtml.includes("lf-commercial-footer"), "Footer script must be present");
assert(indexHtml.includes("/pricing.html"), "Should link to pricing page");
assert(indexHtml.includes("/commercial-config.js"), "Should load commercial config");
console.log("✓ index.html preserves monolith and integrates commercial footer and runtime");

// 5. Verify netlify.toml headers
const netlifyToml = fs.readFileSync("netlify.toml", "utf8");
assert(netlifyToml.includes("directory = \"netlify/functions\""), "Should point to functions dir");
assert(netlifyToml.includes("X-Content-Type-Options = \"nosniff\""), "Should have nosniff header");
console.log("✓ netlify.toml is properly configured");

// 6. Verify functions structure
const functionsDir = "netlify/functions";
const functionFiles = fs.readdirSync(functionsDir).filter(f => f.endsWith(".mts"));

const expectedRoutes = [
  { file: "commercial-account.mts", path: "/commercial-api/account" },
  { file: "commercial-auth-adopt-session.mts", path: "/commercial-api/auth/adopt-session" },
  { file: "commercial-auth-recover.mts", path: "/commercial-api/auth/recover" },
  { file: "commercial-auth-refresh.mts", path: "/commercial-api/auth/refresh" },
  { file: "commercial-auth-session.mts", path: "/commercial-api/auth/session" },
  { file: "commercial-auth-signin.mts", path: "/commercial-api/auth/signin" },
  { file: "commercial-auth-signout.mts", path: "/commercial-api/auth/signout" },
  { file: "commercial-auth-signup.mts", path: "/commercial-api/auth/signup" },
  { file: "commercial-auth-update-password.mts", path: "/commercial-api/auth/update-password" },
  { file: "commercial-checkout.mts", path: "/commercial-api/checkout" },
  { file: "commercial-checkout-sync.mts", path: "/commercial-api/checkout-sync" },
  { file: "commercial-portal.mts", path: "/commercial-api/portal" },
  { file: "commercial-entitlements.mts", path: "/commercial-api/entitlements" },
  { file: "commercial-health.mts", path: "/commercial-api/health" },
  { file: "commercial-stripe-webhook.mts", path: "/commercial-api/stripe-webhook" }
];

for (const expected of expectedRoutes) {
  assert(functionFiles.includes(expected.file), `Expected ${expected.file} to exist in ${functionsDir}`);
  const content = fs.readFileSync(path.join(functionsDir, expected.file), "utf8");
  assert(content.includes(`path: "${expected.path}"`), `Expected ${expected.file} to declare path ${expected.path}`);
  assert(content.includes("export default async"), `Expected ${expected.file} to export default async handler`);
}
console.log(`✓ All ${expectedRoutes.length} Netlify commercial functions verified with valid route declarations`);

// 7. Verify migrations
const migrationsDir = "netlify/database/migrations";
const migrationDirs = fs.readdirSync(migrationsDir);
assert(migrationDirs.some(d => d.includes("commercial_core")), "Core migration must exist");
assert(migrationDirs.some(d => d.includes("auth_identity")), "Auth identity migration must exist");
assert(migrationDirs.some(d => d.includes("stripe_webhook")), "Stripe webhook migration must exist");
console.log("✓ Database migrations verified");

console.log("\nALL COMMERCIAL VERIFICATION TESTS PASSED SUCCESSFULLY!");
