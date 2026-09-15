import type { Config, Context } from "@netlify/functions";
import { proxyAuth, sessionCookieHeaders } from "./_shared/commercial-auth";
export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const res = await proxyAuth("token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return Response.json({ error: data?.error_description || data?.msg || data?.message || "Sign-in failed" }, { status: 401 });
  return new Response(JSON.stringify({ user: data?.user || null }), { status: 200, headers: sessionCookieHeaders(data) });
};
export const config: Config = { path: "/commercial-api/auth/signin" };
