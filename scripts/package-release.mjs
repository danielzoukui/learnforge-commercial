import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

console.log("=== Packaging LearnForge Commercial Release ===");

const zipName = "LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.0.zip";
const zipPath = path.resolve(zipName);

// Remove prior archive if present
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Files and folders to include in the release
const includes = [
  "index.html",
  "pricing.html",
  "auth.html",
  "support.html",
  "privacy.html",
  "terms.html",
  "commercial-config.js",
  "netlify.toml",
  "package.json",
  "package-lock.json",
  "README.md",
  "COMMERCIALIZATION_README.md",
  ".gitignore",
  ".github",
  "netlify",
  "scripts",
  "tests"
];

const cmd = `zip -r "${zipName}" ${includes.join(" ")} -x "node_modules/*" ".git/*" "*.DS_Store"`;
console.log("Executing:", cmd);
execSync(cmd, { stdio: "inherit" });

const stats = fs.statSync(zipPath);
console.log(`\nSuccessfully created package: ${zipName}`);
console.log(`Package size: ${(stats.size / 1024 / 1024).toFixed(2)} MB (${stats.size} bytes)`);

// Verify zip listing
const listOutput = execSync(`unzip -l "${zipName}"`).toString();
const fileCount = (listOutput.match(/\n/g) || []).length - 5;
console.log(`Total archived entries: ${fileCount}`);
console.log("=== Packaging Complete ===");
