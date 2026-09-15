import type { Config, Context } from "@netlify/functions";
import { authProviderConfig, getAccessToken, verifyCommercialUser } from "./_shared/commercial-auth";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let user;
  try { user = await verifyCommercialUser(req); } catch (e) { if (e instanceof Response) return e; throw e; }
  const body = await req.json().catch(() => ({}));
  const password = String(body.password || "");
  if (password.length < 10) return Response.json({ error: "Use a password with at least 10 characters" }, { status: 400 });
  const token = getAccessToken(req);
  if (!token) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { url, key } = authProviderConfig();
  const res = await fetch(`${url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return Response.json({ error: data?.msg || data?.message || "Password could not be updated" }, { status: res.status });
  return Response.json({ ok: true, user: { id: user.id, email: user.email } });
};

export const config: Config = { path: "/commercial-api/auth/update-password" };
