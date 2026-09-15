import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = 8080;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm"
};

const server = http.createServer(async (req, res) => {
  // Common security headers matching netlify.toml
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Commercial API mock responses for local preview environment
  if (pathname.startsWith("/commercial-api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (pathname === "/commercial-api/health") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, service: "learnforge-commercial", environment: "preview-local" }));
      return;
    }
    if (pathname === "/commercial-api/auth/session") {
      res.statusCode = 200;
      res.end(JSON.stringify({ authenticated: false, message: "Preview mode: hosted Supabase Auth connects in Netlify deployment" }));
      return;
    }
    if (pathname === "/commercial-api/entitlements") {
      res.statusCode = 200;
      res.end(JSON.stringify({ account: null, subscription: null, entitlements: [] }));
      return;
    }
    if (pathname === "/commercial-api/account") {
      res.statusCode = 200;
      res.end(JSON.stringify({ account: null, message: "Account sync requires hosted session in production" }));
      return;
    }
    if (pathname === "/commercial-api/checkout" || pathname === "/commercial-api/portal" || pathname === "/commercial-api/checkout-sync") {
      res.statusCode = 503;
      res.end(JSON.stringify({
        error: "Billing operations require Netlify production environment with STRIPE_SECRET_KEY, STRIPE_PRICE_FAMILY, and STRIPE_PRICE_TEACHER configured."
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Endpoint not found" }));
    return;
  }

  // Static file resolution
  let filePath = path.join(rootDir, pathname === "/" ? "index.html" : pathname);

  if (!fs.existsSync(filePath) && fs.existsSync(filePath + ".html")) {
    filePath += ".html";
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
    if (ext === ".html") {
      res.setHeader("Cache-Control", "no-cache");
    }
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LearnForge Commercial Preview Server listening on http://0.0.0.0:${port}`);
});
