import { ROLE_ADMIN, ROLE_USER } from '@meshimap/core';
import { Hono } from 'hono';
import { isAdminActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { notFound } from '../lib/http-error';
import { parseReviewId } from '../lib/parse-id';
import { requireAdminActor, requireUserActor, roleGuard } from '../middleware/role-guard';
import { deleteReviewAsAdmin, deleteReviewAsAuthor } from '../repositories/review-repository';

export const reviewRoutes = new Hono<AppEnv>().delete(
  '/:reviewId',
  // owner はレビューを消せない。ロールだけで決まるのでここは 403 でよい
  roleGuard(ROLE_USER, ROLE_ADMIN),
  async (c) => {
    const db = createDatabase(c.env.DB);
    const reviewId = parseReviewId(c.req.param('reviewId'));
    const viewer = c.get('viewer');
    const isDeleted = isAdminActor(viewer)
      ? await deleteReviewAsAdmin(db, requireAdminActor(c), reviewId)
      : await deleteReviewAsAuthor(db, requireUserActor(c), reviewId);
    if (!isDeleted) {
      // 他人のレビューも存在しないレビューも同じ 404
      throw notFound();
    }
    return c.body(null, 204);
  },
);
