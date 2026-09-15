import type { Config, Context } from "@netlify/functions";
import { authProviderConfig, sessionCookieHeaders } from "./_shared/commercial-auth";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  const accessToken = String(body.access_token || "");
  const refreshToken = String(body.refresh_token || "");
  const expiresIn = Math.max(60, Number(body.expires_in || 3600));
  if (!accessToken || !refreshToken) return Response.json({ error: "Missing session tokens" }, { status: 400 });

  const { url, key } = authProviderConfig();
  const verify = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${accessToken}` }
  });
  if (!verify.ok) return Response.json({ error: "Invalid or expired authentication session" }, { status: 401 });
  const user = await verify.json();
  const session = { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
  return new Response(JSON.stringify({ ok: true, user: { id: user?.id, email: user?.email } }), {
    status: 200,
    headers: sessionCookieHeaders(session)
  });
};

export const config: Config = { path: "/commercial-api/auth/adopt-session" };
