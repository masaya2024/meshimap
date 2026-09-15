import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  IDENTIFIER_MAX_LENGTH,
  ISO_DATE_GLOB_PATTERN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  RATING_MAX,
  RATING_MIN,
  REVIEW_BODY_MAX_LENGTH,
  REVIEW_STATUS_PUBLISHED,
  REVIEW_STATUSES,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  inValues,
  lengthAtMost,
  matchesGlob,
} from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

/** オーナー返信の上限。レビュー本文より短くして、返信が主役にならないようにする */
const REVIEW_REPLY_BODY_MAX_LENGTH = 1000;
/** 並び順の既定値 */
const DEFAULT_SORT_ORDER = 0;

/**
 * レビュー。
 *
 * 1 ユーザーにつき 1 店舗 1 件。再訪したら編集してもらう運用にして、
 * 同一人物による評価の水増しを防ぐ（`uq_reviews_shop_user`）。
 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // 1〜5 の星
    rating: integer('rating').notNull(),
    body: text('body').notNull(),
    // 訪問日（YYYY-MM-DD）。覚えていない場合があるので NULL 可
    visitedOn: text('visited_on'),
    // 実際に使った金額（円）。NULL 可
    budget: integer('budget'),
    status: text('status', { enum: REVIEW_STATUSES }).notNull().default(REVIEW_STATUS_PUBLISHED),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    /*
     * 設計書 §6 のインデックス方針「reviews(shop_id, created_at DESC)」をそのまま写したもの。
     * 実測では SQLite は昇順索引を逆走査できるため desc の有無で実行計画は変わらないが、
     * 「新着順で引く列だ」という意図を残すために設計書どおり desc で定義する。
     */
    index('idx_reviews_shop_created').on(table.shopId, sql`${table.createdAt} desc`),
    // 利用者向けは status = 'published' が必ず付くので複合でも持つ
    index('idx_reviews_shop_status_created').on(
      table.shopId,
      table.status,
      sql`${table.createdAt} desc`,
    ),
    // マイページの「投稿したレビュー」
    index('idx_reviews_user_created').on(table.userId, sql`${table.createdAt} desc`),
    // 1 ユーザー 1 店舗 1 レビュー
    uniqueIndex('uq_reviews_shop_user').on(table.shopId, table.userId),
    // review_replies の複合外部キーの参照先（SQLite は参照先のユニーク索引を要求する）
    uniqueIndex('uq_reviews_id_shop').on(table.id, table.shopId),

    check('ck_reviews_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_reviews_rating', betweenInclusive(table.rating, RATING_MIN, RATING_MAX)),
    check('ck_reviews_body_length', lengthAtMost(table.body, REVIEW_BODY_MAX_LENGTH)),
    check('ck_reviews_status', inValues(table.status, REVIEW_STATUSES)),
    check('ck_reviews_visited_on_format', matchesGlob(table.visitedOn, ISO_DATE_GLOB_PATTERN)),
    check('ck_reviews_budget', betweenInclusive(table.budget, BUDGET_YEN_MIN, BUDGET_YEN_MAX)),
  ],
);

/** レビューに添付する写真。実体は R2。 */
export const reviewPhotos = sqliteTable(
  'review_photos',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
  },
  (table) => [
    index('idx_review_photos_review_sort').on(table.reviewId, table.sortOrder),
    // 同じ R2 オブジェクトを 2 行から参照させない
    uniqueIndex('uq_review_photos_r2_key').on(table.r2Key),

    check('ck_review_photos_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_review_photos_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
    check('ck_review_photos_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
    check('ck_review_photos_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
  ],
);

/**
 * オーナーからの返信。1 レビューにつき 1 件なので review_id をそのまま主キーにする。
 *
 * `shop_id` を冗長に持つのは、権限チェック（「この店のオーナーか」）を
 * reviews を JOIN せずに行えるようにするため。
 * 冗長な分だけ「他店の shop_id を入れて返信を偽装する」余地が生まれるので、
 * `(review_id, shop_id)` → `reviews(id, shop_id)` の複合外部キーで封じる。
 */
export const reviewReplies = sqliteTable(
  'review_replies',
  {
    reviewId: text('review_id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // オーナー管理画面の「返信済みレビュー一覧」
    index('idx_review_replies_shop').on(table.shopId),

    foreignKey({
      columns: [table.reviewId, table.shopId],
      foreignColumns: [reviews.id, reviews.shopId],
    }).onDelete('cascade'),

    check('ck_review_replies_body_length', lengthAtMost(table.body, REVIEW_REPLY_BODY_MAX_LENGTH)),
  ],
);
