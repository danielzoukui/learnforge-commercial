export type CommercialUser = {
  id: string;
  email: string;
  emailConfirmed: boolean;
  raw: any;
};

const cookieName = "lf_access_token";
const refreshCookieName = "lf_refresh_token";

function parseCookies(req: Request): Record<string,string> {
  const out: Record<string,string> = {};
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function getAccessToken(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim() || null;
  return parseCookies(req)[cookieName] || null;
}

export function getRefreshToken(req: Request): string | null {
  return parseCookies(req)[refreshCookieName] || null;
}

export function authProviderConfig() {
  const url = (Netlify.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || Netlify.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !key) {
    // Thrown as a Response so every host reports a clear 503 (configuration)
    // instead of an opaque 500 (unhandled exception).
    throw new Response(
      JSON.stringify({
        error: "Hosted authentication is not configured yet",
        hint: "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)."
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  return { url, key };
}

export async function verifyCommercialUser(req: Request): Promise<CommercialUser> {
  const token = getAccessToken(req);
  if (!token) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: { "content-type": "application/json" } });
  const { url, key } = authProviderConfig();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Response(JSON.stringify({ error: "Session expired or invalid" }), { status: 401, headers: { "content-type": "application/json" } });
  const user = await res.json();
  const email = String(user?.email || "").trim().toLowerCase();
  if (!user?.id || !email) throw new Response(JSON.stringify({ error: "Authenticated user is missing an email" }), { status: 401, headers: { "content-type": "application/json" } });
  return { id: String(user.id), email, emailConfirmed: Boolean(user.email_confirmed_at), raw: user };
}

function cookie(value: string, name: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function sessionCookieHeaders(session: any): Headers {
  const h = new Headers({ "content-type": "application/json" });
  const expires = Math.max(60, Number(session?.expires_in || 3600));
  if (session?.access_token) h.append("set-cookie", cookie(String(session.access_token), cookieName, expires));
  if (session?.refresh_token) h.append("set-cookie", cookie(String(session.refresh_token), refreshCookieName, 60 * 60 * 24 * 30));
  return h;
}

export function clearSessionCookieHeaders(): Headers {
  const h = new Headers({ "content-type": "application/json" });
  h.append("set-cookie", `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  h.append("set-cookie", `${refreshCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return h;
}

export async function proxyAuth(path: string, init: RequestInit) {
  const { url, key } = authProviderConfig();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", key);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${url}/auth/v1/${path}`, { ...init, headers });
}
