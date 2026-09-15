import type { Config, Context } from "@netlify/functions";
import { getRefreshToken, proxyAuth, sessionCookieHeaders } from "./_shared/commercial-auth";
export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const refreshToken = getRefreshToken(req);
  if (!refreshToken) return Response.json({ error: "No refresh session" }, { status: 401 });
  const res = await proxyAuth("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return Response.json({ error: "Session could not be refreshed" }, { status: 401 });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: sessionCookieHeaders(data) });
};
export const config: Config = { path: "/commercial-api/auth/refresh" };
