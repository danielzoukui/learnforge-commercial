/**
 * Supabase automation.
 *
 * Adds the deployed origin to the project's allowed auth redirect URLs so that
 * email confirmation and password recovery links return to the right place.
 * Merges with whatever is already configured instead of overwriting it.
 *
 * Endpoints: GET/PATCH /v1/projects/{ref}/config/auth
 *            GET /v1/projects/{ref}/api-keys (best effort, to fetch the anon key)
 */

import { HttpClient } from "./providers.mjs";

export function projectRefFromUrl(supabaseUrl) {
  const match = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in)/i.exec(String(supabaseUrl || "").trim());
  return match ? match[1] : null;
}

export class SupabaseClient {
  constructor({ accessToken, baseUrl = "https://api.supabase.com/v1", dryRun = false, log }) {
    this.http = new HttpClient({ provider: "supabase", baseUrl, token: accessToken, dryRun, log });
    this.log = log;
  }

  async getAuthConfig(ref) {
    const { data } = await this.http.get(`/projects/${ref}/config/auth`);
    return data?.data || data || {};
  }

  /** Best-effort retrieval of the publishable/anon key so it need not be copied by hand. */
  async fetchAnonKey(ref) {
    for (const query of [{ reveal: "true" }, undefined]) {
      try {
        const { data } = await this.http.get(`/projects/${ref}/api-keys`, { query });
        const keys = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
        const match = keys.find((key) => ["anon", "publishable"].includes(String(key.name || key.type || "").toLowerCase()));
        if (match?.api_key) return match.api_key;
      } catch (error) {
        this.log?.info(`could not read API keys automatically (${error?.status || error?.message || error})`);
        break;
      }
    }
    return null;
  }

  /**
   * @returns {{ siteUrl: string, allowList: string[], added: string[] }}
   */
  async configureAuthRedirects({ ref, siteUrl, extraRedirects = [] }) {
    const origin = siteUrl.replace(/\/$/, "");
    const desired = [`${origin}/**`, `${origin}/auth.html?verified=1`, ...extraRedirects];

    const current = await this.getAuthConfig(ref);
    const existing = String(current.uri_allow_list || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const added = desired.filter((value) => !existing.includes(value));
    const merged = [...existing, ...added];

    if (!added.length && current.site_url === origin) {
      this.log?.ok(`Supabase redirect URLs already cover ${origin}`);
      return { siteUrl: origin, allowList: merged, added: [] };
    }

    await this.http.patch(`/projects/${ref}/config/auth`, {
      body: { site_url: origin, uri_allow_list: merged.join(",") }
    });
    this.log?.ok(`Supabase site_url set to ${origin}`);
    if (added.length) this.log?.ok(`added ${added.length} redirect URL(s): ${added.join(", ")}`);
    return { siteUrl: origin, allowList: merged, added };
  }
}
