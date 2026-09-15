/**
 * Portable HTTP application for LearnForge Commercial.
 *
 * Responsibilities:
 *   - Load every API handler from `netlify/functions/*.mts` and route it on the
 *     exact path declared in its `export const config = { path: ... }`, so the
 *     front end needs zero changes between Netlify and any other host.
 *   - Serve the static product pages with the same security and cache headers
 *     declared in `netlify.toml`.
 *
 * Handlers are plain Web `Request`/`Response` functions, so they are invoked
 * through the platform-agnostic WinterCG contract rather than any host-specific
 * event shape.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const API_PREFIX = "/commercial-api/";
export const MAX_API_BODY_BYTES = 1024 * 1024;

/** Mirrors the [[headers]] block in netlify.toml so parity is verifiable. */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "SAMEORIGIN"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".map": "application/json; charset=utf-8"
};

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/;

/**
 * Static files are allow-listed. The repository root contains release archives,
 * function sources, tests and CI configuration that must never be downloadable
 * from the public origin.
 */
export const PUBLIC_EXTENSIONS = new Set(Object.keys(MIME_TYPES));
export const DENIED_SEGMENTS = new Set([
  "node_modules",
  "netlify",
  "runtime",
  "scripts",
  "tests",
  "deploy",
  "docs",
  ".git",
  ".github",
  ".netlify",
  ".vscode",
  ".idea"
]);
export const DENIED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "netlify.toml",
  "dockerfile",
  ".dockerignore",
  ".gitignore",
  ".env"
]);

export function isPublicPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return false;

  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith(".")) return false;
    if (DENIED_SEGMENTS.has(segment.toLowerCase())) return false;
  }

  const basename = segments[segments.length - 1]?.toLowerCase() || "";
  if (DENIED_FILES.has(basename)) return false;
  if (basename.endsWith(".zip") || basename.endsWith(".ts") || basename.endsWith(".mts")) return false;
  if (!PUBLIC_EXTENSIONS.has(path.extname(basename))) return false;

  return true;
}

/** Resolves a request path to an on-disk file, or null when it is not servable. */
export function resolveStaticFile(rootDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const withIndex = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  const candidates = [withIndex];
  if (!path.extname(withIndex)) {
    candidates.push(`${withIndex}.html`, `${withIndex}/index.html`);
  }

  for (const candidate of candidates) {
    const relative = candidate.replace(/^\/+/, "");
    if (!isPublicPath(relative)) continue;

    const absolute = path.resolve(rootDir, relative);
    // Defence in depth: never serve outside the repository root.
    if (absolute !== rootDir && !absolute.startsWith(rootDir + path.sep)) continue;

    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile()) return { absolute, relative, size: stat.size, mtimeMs: stat.mtimeMs };
      if (stat.isDirectory()) {
        const indexFile = path.join(absolute, "index.html");
        const indexStat = fs.statSync(indexFile);
        if (indexStat.isFile()) {
          return { absolute: indexFile, relative: `${relative}/index.html`, size: indexStat.size, mtimeMs: indexStat.mtimeMs };
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export async function loadApiRoutes(functionsDir) {
  const entries = await fsp.readdir(functionsDir, { withFileTypes: true });
  const routes = new Map();
  const files = entries
    .filter((entry) => entry.isFile() && /\.(mts|ts|mjs|js)$/.test(entry.name) && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const module = await import(pathToFileURL(path.join(functionsDir, file)).href);
    const handler = module.default;
    const route = module.config?.path;
    if (typeof handler !== "function") {
      throw new TypeError(`${file} must export a default async handler`);
    }
    if (typeof route !== "string" || !route.startsWith("/")) {
      throw new TypeError(`${file} must declare its route via \`export const config = { path: "..." }\``);
    }
    if (routes.has(route)) {
      throw new TypeError(`Duplicate API route ${route} (${file} and ${routes.get(route).file})`);
    }
    routes.set(route, { handler, file });
  }

  return routes;
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_API_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(req, url, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  const init = { method: req.method, headers };
  if (body && body.byteLength > 0) init.body = body;
  return new Request(url.href, init);
}

async function writeWebResponse(res, response, method) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (cookies.length) res.setHeader("set-cookie", cookies);

  if (method === "HEAD" || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader("Content-Length", String(buffer.byteLength));
  res.end(buffer);
}

function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.hasHeader(key)) res.setHeader(key, value);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(body);
}

/**
 * @param {{ rootDir: string, functionsDir: string, version?: string }} options
 */
export async function createApp({ rootDir, functionsDir, version = "17.0.0" }) {
  const routes = await loadApiRoutes(functionsDir);
  const startedAt = Date.now();

  async function handleApi(req, res, url) {
    const route = routes.get(url.pathname);
    if (!route) return sendJson(res, 404, { error: "Endpoint not found" });

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await readRawBody(req);
    }

    let response;
    try {
      response = await route.handler(toWebRequest(req, url, body), {});
    } catch (error) {
      // The handlers use the WinterCG convention of throwing a `Response` for
      // expected auth/configuration failures (see _shared/commercial-auth.ts).
      if (error instanceof Response) {
        applySecurityHeaders(res);
        return writeWebResponse(res, error, req.method);
      }
      console.error(`[api] Unhandled error in ${route.file}:`, error);
      return sendJson(res, 500, { error: "Internal server error" });
    }

    if (!(response instanceof Response)) {
      console.error(`[api] ${route.file} returned a non-Response value`);
      return sendJson(res, 500, { error: "Internal server error" });
    }

    applySecurityHeaders(res);
    return writeWebResponse(res, response, req.method);
  }

  async function handleStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    const file = resolveStaticFile(rootDir, url.pathname);
    if (!file) {
      applySecurityHeaders(res);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not found");
      return;
    }

    const etag = `W/"${file.size.toString(16)}-${Math.round(file.mtimeMs).toString(16)}"`;
    applySecurityHeaders(res);

    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    const extension = path.extname(file.absolute).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", new Date(file.mtimeMs).toUTCString());

    // Parity with netlify.toml cache rules.
    const basename = path.basename(file.absolute).toLowerCase();
    if (basename === "index.html") res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    else if (extension === ".html") res.setHeader("Cache-Control", "no-cache");

    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    if (acceptsGzip && file.size >= 1024 && COMPRESSIBLE.test(contentType)) {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.end();
        return;
      }
      res.statusCode = 200;
      await pipeline(fs.createReadStream(file.absolute), zlib.createGzip({ level: 6 }), res);
      return;
    }

    res.statusCode = 200;
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(file.size));
      res.end();
      return;
    }
    res.setHeader("Content-Length", String(file.size));
    await pipeline(fs.createReadStream(file.absolute), res);
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // Liveness probe for container platforms: never touches the database.
      if (url.pathname === "/_runtime/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "learnforge-commercial",
          runtime: "portable",
          version,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          routes: routes.size
        });
      }

      if (url.pathname.startsWith(API_PREFIX)) {
        return await handleApi(req, res, url);
      }
      return await handleStatic(req, res, url);
    } catch (error) {
      if (error?.statusCode === 413) return sendJson(res, 413, { error: "Request body too large" });
      if (error instanceof Response) {
        applySecurityHeaders(res);
        return writeWebResponse(res, error, req.method);
      }
      console.error("[runtime] Unhandled request error:", error);
      if (!res.headersSent) return sendJson(res, 500, { error: "Internal server error" });
      res.end();
    }
  }

  return { handle, routes, hash: crypto.createHash("sha256").update([...routes.keys()].sort().join("\n")).digest("hex").slice(0, 12) };
}
