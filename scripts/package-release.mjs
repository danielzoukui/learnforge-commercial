import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

console.log("=== Packaging LearnForge Commercial Release ===");

const zipName = "LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.1.zip";
const zipPath = path.resolve(zipName);

// Remove prior archive if present
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Files and folders to include in the release.
// v17.1 adds the host-portable runtime, deployment runbooks and container build.
const includes = [
  "index.html",
  "pricing.html",
  "auth.html",
  "support.html",
  "privacy.html",
  "terms.html",
  "commercial-config.js",
  "netlify.toml",
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMERCIALIZATION_README.md",
  "HOSTING_OPTIONS.md",
  ".gitignore",
  ".github",
  "netlify",
  "runtime",
  "deploy",
  "scripts",
  "tests"
];

const excluded = [
  "node_modules/*",
  ".git/*",
  "*.zip",
  "*.log",
  ".env",
  ".env.*",
  "*.DS_Store"
];

const cmd = `zip -r "${zipName}" ${includes.join(" ")} -x ${excluded.map((item) => `"${item}"`).join(" ")}`;
console.log("Executing:", cmd);
execSync(cmd, { stdio: "inherit" });

const stats = fs.statSync(zipPath);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
const entries = execSync(`unzip -Z1 "${zipName}"`).toString().trim().split("\n").filter((line) => line && !line.endsWith("/"));

console.log(`\nSuccessfully created package: ${zipName}`);
console.log(`Package size : ${(stats.size / 1024 / 1024).toFixed(2)} MB (${stats.size} bytes)`);
console.log(`Files        : ${entries.length}`);
console.log(`SHA-256      : ${sha256}`);
console.log("\n=== Packaging Complete ===");
