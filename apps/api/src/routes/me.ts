import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createDatabase } from '../db/client';
import { profiles } from '../db/schema';
import type { AppEnv } from '../lib/app-env';
import { ERROR_MESSAGE_INTERNAL } from '../lib/http-error';
import { requireActor } from '../middleware/role-guard';

export const meRoutes = new Hono<AppEnv>().get('/', async (c) => {
  // ロールを問わず「ログインしていること」だけを要求する。未認証は 401
  const actor = requireActor(c);
  const db = createDatabase(c.env.DB);
  const rows = await db
    .select({ userId: profiles.userId, role: profiles.role, displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.userId, actor.userId))
    .limit(1);

  const profile = rows[0];
  if (profile === undefined) {
    // authMiddleware が Actor を作れた以上プロフィールは必ずある。無いのは DB の不整合なので 500
    throw new HTTPException(500, { message: ERROR_MESSAGE_INTERNAL });
  }
  return c.json({ profile });
});
