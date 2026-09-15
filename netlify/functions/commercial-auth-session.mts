import type { Config, Context } from "@netlify/functions";
import { verifyCommercialUser } from "./_shared/commercial-auth";
export default async (req: Request, _context: Context) => {
  try {
    const user = await verifyCommercialUser(req);
    return Response.json({ authenticated: true, user: { id: user.id, email: user.email, emailConfirmed: user.emailConfirmed } });
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ authenticated: false, error: "Authentication unavailable" }, { status: 503 });
  }
};
export const config: Config = { path: "/commercial-api/auth/session" };
