import type { Config, Context } from "@netlify/functions";
import { proxyAuth, sessionCookieHeaders } from "./_shared/commercial-auth";

const roles = new Set(["parent", "teacher"]);
export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const displayName = String(body.displayName || "").trim().slice(0,120);
  const role = roles.has(String(body.role)) ? String(body.role) : "parent";
  if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "A valid email is required" }, { status: 400 });
  if (password.length < 10) return Response.json({ error: "Use a password with at least 10 characters" }, { status: 400 });
  const siteUrl = Netlify.env.get("PUBLIC_SITE_URL") || new URL(req.url).origin;
  const res = await proxyAuth("signup", { method: "POST", body: JSON.stringify({ email, password, data: { display_name: displayName, learnforge_role: role }, email_redirect_to: `${siteUrl}/auth.html?verified=1` }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return Response.json({ error: data?.msg || data?.message || "Sign-up failed" }, { status: res.status });
  const session = data?.access_token ? data : data?.session;
  return new Response(JSON.stringify({ user: data?.user || null, sessionCreated: Boolean(session?.access_token), requiresEmailConfirmation: !session?.access_token }), { status: 200, headers: session ? sessionCookieHeaders(session) : { "content-type":"application/json" } });
};
export const config: Config = { path: "/commercial-api/auth/signup" };
