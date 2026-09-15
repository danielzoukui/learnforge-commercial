/**
 * Module resolution hook used only on non-Netlify hosts.
 *
 * Two Netlify/bundler conveniences are emulated for plain Node ESM:
 *
 *  1. `@netlify/database` is mapped onto `runtime/database.mjs`, a portable
 *     PostgreSQL implementation of the SDK's `db.sql` tagged template.
 *  2. Extensionless relative imports (`./_shared/commercial-auth`) resolve to
 *     the TypeScript source, which Node 22.18+ executes natively via type
 *     stripping.
 *
 * Nothing in `netlify/functions/**` is modified or rewritten: the same source
 * files are deployed to Netlify and to every other supported host.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const OVERRIDES = new Map([
  ["@netlify/database", new URL("./database.mjs", import.meta.url).href]
]);

const RESOLUTION_EXTENSIONS = [".ts", ".mts", ".mjs", ".js", ".json", ".tsx"];

export async function resolve(specifier, context, nextResolve) {
  const override = OVERRIDES.get(specifier);
  if (override) {
    return { url: override, shortCircuit: true };
  }

  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (!isRelative) {
    return nextResolve(specifier, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;

    const base = new URL(specifier, context.parentURL);
    const candidates = [
      ...RESOLUTION_EXTENSIONS.map((extension) => new URL(`${base.href}${extension}`)),
      ...RESOLUTION_EXTENSIONS.map((extension) => new URL(`${base.href}/index${extension}`))
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }

    throw error;
  }
}
