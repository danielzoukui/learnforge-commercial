#!/usr/bin/env node
/**
 * Applies the Netlify Database migrations to any PostgreSQL server.
 *
 *     DATABASE_URL=postgres://user:pass@host:5432/db node runtime/migrate.mjs --status
 *     DATABASE_URL=postgres://user:pass@host:5432/db node runtime/migrate.mjs
 *
 * The same `netlify/database/migrations/<version>/migration.sql` files are used,
 * in version order, so the schema is identical whether the app runs on Netlify
 * (which applies them at build time) or on an external PostgreSQL instance.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase, runMigrations, resolveConnectionString } from "./database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const defaultMigrationsDir = path.join(rootDir, "netlify", "database", "migrations");

export function findMigrations(migrationsDir = defaultMigrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];

  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((version) => {
      const file = path.join(migrationsDir, version, "migration.sql");
      if (!fs.existsSync(file)) return null;
      return {
        version,
        filename: `${version}/migration.sql`,
        sql: fs.readFileSync(file, "utf8")
      };
    })
    .filter(Boolean);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--status") || args.has("--dry-run");

  const connection = resolveConnectionString();
  if (!connection) {
    console.error("No PostgreSQL connection string found. Set DATABASE_URL (or POSTGRES_URI).");
    process.exit(1);
  }

  const migrations = findMigrations();
  if (!migrations.length) {
    console.error(`No migrations found in ${defaultMigrationsDir}`);
    process.exit(1);
  }

  console.log(`Connection     : ${connection.key}`);
  console.log(`Migrations dir : ${defaultMigrationsDir}`);
  console.log(`Found          : ${migrations.length} migration(s)${dryRun ? " (status only)" : ""}`);

  const db = getDatabase();
  const results = await runMigrations(db, migrations, { dryRun });

  for (const result of results) {
    const marker = result.status === "applied" ? "✓" : result.status === "changed-after-apply" ? "!" : "·";
    console.log(`  ${marker} ${result.filename} — ${result.status}`);
  }

  if (results.some((result) => result.status === "changed-after-apply")) {
    console.warn("\nWarning: a migration file changed after it was applied. Add a new migration instead of editing history.");
  }

  const pending = results.filter((result) => result.status === "pending").length;
  console.log(dryRun ? `\n${pending} migration(s) pending.` : "\nSchema is up to date.");
  await closeDatabase();
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(async (error) => {
    console.error(`Migration failed: ${error?.message || error}`);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
}
