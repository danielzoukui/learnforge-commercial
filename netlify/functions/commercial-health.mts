import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";

export default async (_req: Request, _context: Context) => {
  try {
    const db = getDatabase();
    await db.sql`SELECT 1 AS ok`;
    return Response.json({ ok: true, service: "learnforge-commercial", database: "ready" });
  } catch (error) {
    return Response.json({ ok: false, service: "learnforge-commercial", database: "unavailable" }, { status: 503 });
  }
};

export const config: Config = { path: "/commercial-api/health" };
