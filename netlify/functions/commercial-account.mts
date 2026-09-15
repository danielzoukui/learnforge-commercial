import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { verifyCommercialUser } from "./_shared/commercial-auth";

const cleanName = (v: unknown) => String(v || "").trim().slice(0, 120);
const selfServiceRoles = new Set(["parent", "teacher"]);

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const user = await verifyCommercialUser(req);
    const body = await req.json().catch(() => ({}));
    const displayName = cleanName(body.displayName);
    const requestedRole = selfServiceRoles.has(String(body.role)) ? String(body.role) : "parent";
    const providerRole = selfServiceRoles.has(String(user.raw?.user_metadata?.learnforge_role)) ? String(user.raw.user_metadata.learnforge_role) : requestedRole;
    const db = getDatabase();
    const [account] = await db.sql`
      INSERT INTO commercial_accounts (auth_user_id, email, display_name, role)
      VALUES (${user.id}, ${user.email}, ${displayName || user.raw?.user_metadata?.display_name || null}, ${providerRole})
      ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, commercial_accounts.display_name),
        updated_at = NOW()
      RETURNING id, email, display_name, role, status, created_at
    `;
    await db.sql`
      INSERT INTO commercial_audit_events (account_id, event_type, metadata)
      VALUES (${account.id}, 'authenticated_account_upserted', ${{ authUserId: user.id, emailConfirmed: user.emailConfirmed }})
    `;
    return Response.json({ account });
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ error: "Account service unavailable" }, { status: 503 });
  }
};

export const config: Config = { path: "/commercial-api/account" };
