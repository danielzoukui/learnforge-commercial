/**
 * `@netlify/database` compatibility layer for non-Netlify hosts.
 *
 * The commercial handlers only use one primitive from the Netlify Database SDK:
 *
 *     const db = getDatabase();
 *     const rows = await db.sql`SELECT ... ${value}`;
 *
 * `runtime/loader.mjs` rewrites the `@netlify/database` import specifier to this
 * module when the app runs outside Netlify, so the function sources stay
 * byte-for-byte identical for both deployment targets.
 *
 * Supported drivers:
 *   - postgres (default): real PostgreSQL via `pg` — the same server the
 *     `netlify/database/migrations/<version>/migration.sql` files target.
 *   - mock: in-memory, query-logging stub used by the test suite only
 *     (`LEARNFORGE_DB_DRIVER=mock`). Never use it to serve real traffic.
 */

import crypto from "node:crypto";

/**
 * Connection strings are looked up in this order so one build works on
 * Netlify (NETLIFY_DATABASE_URL), Northflank (POSTGRES_URI), Neon/Supabase/
 * Render/Railway (DATABASE_URL) and a self-hosted PostgreSQL.
 */
export const CONNECTION_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URI",
  "NETLIFY_DATABASE_URL",
  "POSTGRES_URL",
  "PG_CONNECTION_STRING"
];

export function resolveConnectionString(env = process.env) {
  for (const key of CONNECTION_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

/**
 * Most managed PostgreSQL providers terminate TLS with a chain that is absent
 * from a slim container's CA store, so `sslmode=require` maps to an encrypted
 * but unverified connection. Use `sslmode=verify-full` (or DATABASE_SSL=verify-full)
 * to enforce CA verification.
 */
export function sslConfig(connectionString, env = process.env) {
  const forced = String(env.DATABASE_SSL || "").trim().toLowerCase();
  if (["0", "false", "disable", "off"].includes(forced)) return false;
  if (["1", "true", "require", "on"].includes(forced)) return { rejectUnauthorized: false };
  if (forced === "verify-full") return { rejectUnauthorized: true };

  const mode = /[?&]sslmode=([a-z-]+)/i.exec(connectionString || "")?.[1]?.toLowerCase();
  if (mode === "disable") return false;
  if (mode === "require" || mode === "prefer" || mode === "allow") return { rejectUnauthorized: false };
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  return undefined; // Let pg decide.
}

/**
 * Builds the `db.sql` tagged template on top of any `execute(text, values)`.
 *
 * Interpolations become real bind parameters ($1, $2, ...) exactly like the
 * Netlify SDK, so handler SQL is parameterized identically on both targets.
 */
export function buildSql(execute) {
  return function sql(strings, ...values) {
    let text = "";
    for (let i = 0; i < strings.length; i += 1) {
      text += strings[i];
      if (i < values.length) text += `$${i + 1}`;
    }
    return execute(text, values);
  };
}

/**
 * node-postgres switches to the extended query protocol whenever `values` is an
 * array — even an empty one — which rejects multi-statement SQL. Migration files
 * contain several statements, so parameterless queries must go through the
 * simple protocol.
 */
async function queryOn(client, text, values) {
  const result = Array.isArray(values) && values.length > 0
    ? await client.query(text, values)
    : await client.query(text);
  return result.rows;
}

export function createMockDatabase() {
  const queries = [];
  // Minimal state for the migration tracking table, so idempotency is testable.
  const appliedMigrations = new Map();

  const sql = buildSql(async (text, values) => {
    queries.push({ text, values });
    if (/SELECT\s+1\s+AS\s+ok/i.test(text)) return [{ ok: 1 }];
    if (/RETURNING id, email, display_name, role, status, created_at/i.test(text)) {
      return [{
        id: 1,
        email: "mock@example.com",
        display_name: "Mock Account",
        role: "parent",
        status: "active",
        created_at: new Date(0).toISOString()
      }];
    }
    if (/SELECT id FROM commercial_accounts/i.test(text)) return [{ id: 1 }];
    if (/SELECT filename, checksum FROM commercial_schema_migrations/i.test(text)) {
      return [...appliedMigrations].map(([filename, checksum]) => ({ filename, checksum }));
    }
    if (/INSERT INTO commercial_schema_migrations/i.test(text)) {
      appliedMigrations.set(values[0], values[1]);
      return [];
    }
    return [];
  });

  return {
    driver: "mock",
    sql,
    queries,
    appliedMigrations,
    async transaction(fn) {
      return fn({ sql });
    },
    async end() {}
  };
}

export function createPostgresDatabase({ connectionString, ssl, poolMax = 5 }) {
  let poolPromise = null;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = import("pg").then(({ default: pg }) => {
        const instance = new pg.Pool({
          connectionString,
          ssl,
          max: poolMax,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          statement_timeout: 15_000,
          application_name: "learnforge-commercial"
        });
        // A dropped idle connection must never take the process down.
        instance.on("error", (error) => {
          console.error("[database] idle client error:", error?.message || error);
        });
        return instance;
      });
    }
    return poolPromise;
  }

  const sql = buildSql(async (text, values) => {
    const client = await getPool();
    return queryOn(client, text, values);
  });

  return {
    driver: "postgres",
    sql,
    /**
     * Runs `fn` against a single dedicated client inside a transaction. Required
     * for migrations: BEGIN/COMMIT must not be spread across pooled connections.
     */
    async transaction(fn) {
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = { sql: buildSql((text, values) => queryOn(client, text, values)) };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async end() {
      if (!poolPromise) return;
      const pool = await poolPromise;
      await pool.end();
    }
  };
}

let cachedDatabase = null;

/**
 * Netlify-compatible `getDatabase()`.
 *
 * Matches the SDK contract the handlers rely on: a synchronous function whose
 * result exposes an awaitable tagged template (`db.sql`). Missing configuration
 * throws, so callers surface a 503 instead of hanging.
 */
export function getDatabase() {
  if (cachedDatabase) return cachedDatabase;

  const mode = String(process.env.LEARNFORGE_DB_DRIVER || "postgres").trim().toLowerCase();
  if (mode === "mock") {
    cachedDatabase = createMockDatabase();
    return cachedDatabase;
  }

  const resolved = resolveConnectionString();
  if (!resolved) {
    throw new Error(
      `Database is not configured. Set one of ${CONNECTION_ENV_KEYS.join(", ")} to a PostgreSQL connection string.`
    );
  }

  const useSsl = sslConfig(resolved.value);
  cachedDatabase = createPostgresDatabase({ connectionString: resolved.value, ssl: useSsl });
  console.log(`[database] driver=postgres connection=${resolved.key} ssl=${useSsl ? "on" : "off"}`);
  return cachedDatabase;
}

/** Boot-time connectivity probe. Never throws. */
export async function verifyDatabase() {
  try {
    const db = getDatabase();
    await db.sql`SELECT 1 AS ok`;
    return { ok: true, driver: db.driver };
  } catch (error) {
    return { ok: false, driver: "unavailable", error: error?.message || String(error) };
  }
}

export async function closeDatabase() {
  if (!cachedDatabase) return;
  const db = cachedDatabase;
  cachedDatabase = null;
  await db.end?.();
}

/**
 * Applies every pending migration exactly once, tracked in
 * `commercial_schema_migrations`. PostgreSQL DDL is transactional, so a failing
 * migration leaves the schema untouched.
 */
export async function runMigrations(db, migrations, { dryRun = false } = {}) {
  await db.sql`
    CREATE TABLE IF NOT EXISTS commercial_schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied = new Map();
  for (const row of await db.sql`SELECT filename, checksum FROM commercial_schema_migrations`) {
    applied.set(row.filename, row.checksum);
  }

  const results = [];
  for (const migration of migrations) {
    const checksum = crypto.createHash("sha256").update(migration.sql, "utf8").digest("hex");
    const previous = applied.get(migration.filename);

    if (previous === checksum) {
      results.push({ filename: migration.filename, status: "already-applied" });
      continue;
    }
    if (previous && previous !== checksum) {
      results.push({ filename: migration.filename, status: "changed-after-apply" });
      continue;
    }
    if (dryRun) {
      results.push({ filename: migration.filename, status: "pending" });
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.sql([migration.sql]);
      await tx.sql`
        INSERT INTO commercial_schema_migrations (filename, checksum)
        VALUES (${migration.filename}, ${checksum})
        ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()
      `;
    });
    results.push({ filename: migration.filename, status: "applied" });
  }

  return results;
}
