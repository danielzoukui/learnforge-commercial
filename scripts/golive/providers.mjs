/**
 * Shared plumbing for the go-live automation.
 *
 * Design constraints:
 *  - Zero dependencies (runs before `npm install` anywhere, on any Node 22 host).
 *  - `--dry-run` prints every request instead of sending it, so the whole
 *    sequence can be rehearsed without credentials or side effects.
 *  - Every provider client takes an explicit `baseUrl`, which is what lets the
 *    test suite run the entire pipeline against a local mock of the provider API.
 *  - Secrets are redacted from all logging.
 */

const SECRET_PATTERNS = [
  /(sk_(?:live|test)_)[A-Za-z0-9]+/g,
  /(whsec_)[A-Za-z0-9]+/g,
  /(sbp_)[A-Za-z0-9]+/g,
  /(nfp_)[A-Za-z0-9]+/g,
  /(eyJ[A-Za-z0-9_-]{6})[A-Za-z0-9._-]+/g,
  /(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/g
];

export function redact(value) {
  if (typeof value !== "string") return redact(JSON.stringify(value));
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "$1***$2"), value);
}

export function createLogger({ quiet = false } = {}) {
  const write = (stream, prefix, message) => {
    // `quiet` gating lives in the individual methods below: outcome lines
    // (ok/warn/fail/raw) always print, commentary lines do not.
    const emit = stream === "err" ? console.error : console.log;
    emit(prefix ? `${prefix} ${redact(message)}` : redact(message));
  };
  return {
    // `quiet` hides the running commentary, never the outcome.
    ok: (message) => write("out", "  ✓", message),
    warn: (message) => write("err", "  !", message),
    fail: (message) => write("err", "  ✗", message),
    raw: (message) => write("out", "", message),
    step: (message) => {
      if (!quiet) write("out", "  →", message);
    },
    info: (message) => {
      if (!quiet) write("out", "  ·", message);
    },
    phase: (message) => {
      if (!quiet) console.log(`\n${message}`);
    }
  };
}

export class ProviderError extends Error {
  constructor(provider, method, url, status, body) {
    super(`${provider} ${method} ${url} → HTTP ${status}: ${redact(String(body).slice(0, 400))}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal JSON HTTP client with dry-run support.
 *
 * `dryRun` never performs the request; it returns `{ data: <synthetic> }` so the
 * caller can continue through the whole pipeline.
 */
export class HttpClient {
  constructor({ provider, baseUrl, token, dryRun = false, log, timeoutMs = 30_000 }) {
    this.provider = provider;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.dryRun = dryRun;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.calls = [];
  }

  url(path) {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }

  async request(method, path, { body, query, headers = {}, form, expect = [200, 201, 204], synthetic = {} } = {}) {
    const target = new URL(this.url(path));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
      }
    }

    const isForm = Boolean(form);
    const payload = isForm ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);

    this.calls.push({ provider: this.provider, method, url: target.toString(), body: body ?? form ?? null });

    if (this.dryRun) {
      this.log?.info(`[dry-run] ${method} ${target.toString()}${payload ? ` ${redact(payload).slice(0, 160)}` : ""}`);
      return { status: 200, data: { data: { id: `dry-run-${this.provider}-${method.toLowerCase()}`, ...synthetic } } };
    }

    const response = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(isForm ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" }),
        ...headers
      },
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!expect.includes(response.status)) {
      throw new ProviderError(this.provider, method, target.toString(), response.status, text);
    }
    return { status: response.status, data };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, options) {
    return this.request("POST", path, { expect: [200, 201, 202], ...options });
  }

  patch(path, options) {
    return this.request("PATCH", path, options);
  }

  put(path, options) {
    return this.request("PUT", path, options);
  }

  delete(path, options) {
    return this.request("DELETE", path, { expect: [200, 202, 204], ...options });
  }
}

/**
 * Response envelopes differ between providers and (potentially) between API
 * versions, so collections are located tolerantly: known keys first, then the
 * first array of objects that look like resources.
 */
export function pickArray(data, keys = []) {
  if (!data) return [];
  const roots = [data, data.data, data.result, data.items];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of keys) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const value of Object.values(root)) {
      if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) return value;
    }
  }
  return [];
}

export function pickId(data, keys = ["id"]) {
  const roots = [data, data?.data, data?.result];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of keys) {
      if (typeof root[key] === "string" && root[key]) return root[key];
    }
  }
  return null;
}

export async function poll({ log, label, attempts = 60, intervalMs = 10_000, check }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await check(attempt);
    if (result?.done) return result.value;
    log?.info(`${label}: ${result?.detail || "waiting"} (${attempt}/${attempts})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out ${label}`);
}
