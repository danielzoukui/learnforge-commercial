import type { Config, Context } from "@netlify/functions";
import { proxyAuth } from "./_shared/commercial-auth";
export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "A valid email is required" }, { status: 400 });
  const siteUrl = Netlify.env.get("PUBLIC_SITE_URL") || new URL(req.url).origin;
  const res = await proxyAuth("recover", { method: "POST", body: JSON.stringify({ email, redirect_to: `${siteUrl}/auth.html?recovery=1` }) });
  if (!res.ok) return Response.json({ error: "Recovery request could not be sent" }, { status: 400 });
  return Response.json({ ok: true });
};
export const config: Config = { path: "/commercial-api/auth/recover" };
