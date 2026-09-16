import type { ReviewCreateInput, ReviewId, ShopId } from '@meshimap/core';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isAdminActor } from '../auth/actor';
import type { AdminActor, UserActor, Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { REVIEW_STATUS_DELETED, REVIEW_STATUS_PUBLISHED } from '../db/constants';
import { reviews } from '../db/schema';

export type ReviewRow = typeof reviews.$inferSelect;

/**
 * hidden は通報対応で admin が伏せた状態。
 * 投稿者本人にも見せない（本人にだけ見えると「伏せられた」と分かり、通報の有無が漏れる）。
 * deleted は利用者が消したもの。admin にも見せない（消したはずが運営には残っている、を避ける）。
 */
function reviewVisibilityCondition(viewer: Viewer): SQL {
  if (isAdminActor(viewer)) {
    return ne(reviews.status, REVIEW_STATUS_DELETED);
  }
  return eq(reviews.status, REVIEW_STATUS_PUBLISHED);
}

export async function listVisibleReviews(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
): Promise<ReviewRow[]> {
  return await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.shopId, shopId), reviewVisibilityCondition(viewer)))
    .orderBy(desc(reviews.createdAt));
}

/**
 * 投稿者 ID は **引数で受け取らず** actor から取る。
 * 引数で受け取れる形にすると、ルート側がリクエストボディの userId を渡してなりすませる。
 * 同じ理由で店舗 ID も input.shopId ではなく、URL 由来で可視性チェックを通した引数を使う。
 *
 * 1 ユーザー 1 店舗 1 レビューは `uq_reviews_shop_user` が DB 側で保証する。
 * 事前に SELECT して重複を弾く実装にしない（確認と INSERT の間に別リクエストが差し込める）。
 */
export async function createReviewAsUser(
  db: Database,
  actor: UserActor,
  shopId: ShopId,
  reviewId: ReviewId,
  input: ReviewCreateInput,
  now: Date,
): Promise<ReviewRow> {
  const inserted = await db
    .insert(reviews)
    .values({
      id: reviewId,
      shopId,
      userId: actor.userId,
      rating: input.rating,
      body: input.body,
      visitedOn: input.visitedOn,
      budget: input.budgetYen,
      status: REVIEW_STATUS_PUBLISHED,
      createdAt: now,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    // INSERT ... RETURNING が 0 件を返すのは D1 側の異常。握り潰さない
    throw new Error('レビューの作成に失敗した');
  }
  return row;
}

/** 投稿者本人だけが消せる。投稿者チェックは `WHERE user_id = ?` として表現する */
export async function deleteReviewAsAuthor(
  db: Database,
  actor: UserActor,
  reviewId: ReviewId,
): Promise<boolean> {
  const deleted = await db
    .delete(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.userId, actor.userId)))
    .returning({ id: reviews.id });
  return deleted.length > 0;
}

/** 通報対応。admin は投稿者を問わず消せる */
export async function deleteReviewAsAdmin(
  db: Database,
  _actor: AdminActor,
  reviewId: ReviewId,
): Promise<boolean> {
  const deleted = await db
    .delete(reviews)
    .where(eq(reviews.id, reviewId))
    .returning({ id: reviews.id });
  return deleted.length > 0;
}
