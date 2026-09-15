import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { verifyCommercialUser } from "./_shared/commercial-auth";

export default async (req: Request, _context: Context) => {
  try {
    const user = await verifyCommercialUser(req);
    const db = getDatabase();
    const accounts = await db.sql`SELECT id, email, role, status FROM commercial_accounts WHERE auth_user_id = ${user.id}`;
    if (!accounts.length) return Response.json({ account: null, subscription: null, entitlements: [] });
    const account = accounts[0];
    const subs = await db.sql`
      SELECT plan, status, current_period_end
      FROM commercial_subscriptions
      WHERE account_id = ${account.id}
      ORDER BY updated_at DESC LIMIT 1
    `;
    const entitlements = await db.sql`
      SELECT entitlement_key, enabled
      FROM commercial_entitlements
      WHERE account_id = ${account.id} AND enabled = TRUE
      ORDER BY entitlement_key
    `;
    return Response.json({ account, subscription: subs[0] || null, entitlements });
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ error: "Entitlements unavailable" }, { status: 503 });
  }
};

export const config: Config = { path: "/commercial-api/entitlements" };
