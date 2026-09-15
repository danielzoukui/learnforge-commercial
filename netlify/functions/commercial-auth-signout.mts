import type { Config, Context } from "@netlify/functions";
import { clearSessionCookieHeaders, getAccessToken, proxyAuth } from "./_shared/commercial-auth";
export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const token = getAccessToken(req);
  if (token) await proxyAuth("logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: clearSessionCookieHeaders() });
};
export const config: Config = { path: "/commercial-api/auth/signout" };
