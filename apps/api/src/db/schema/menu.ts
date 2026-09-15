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
  IDENTIFIER_MAX_LENGTH,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  PRICE_YEN_MAX,
  PRICE_YEN_MIN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  isBooleanInteger,
  lengthAtMost,
} from '../sql-helpers';
import { shops } from './shop';

/** カテゴリ名の上限（「ラーメン」「サイドメニュー」程度） */
const MENU_CATEGORY_NAME_MAX_LENGTH = 50;
/** メニュー名の上限 */
const MENU_ITEM_NAME_MAX_LENGTH = 100;
/** メニュー説明の上限 */
const MENU_ITEM_DESCRIPTION_MAX_LENGTH = 500;
/** 並び順の既定値 */
const DEFAULT_SORT_ORDER = 0;
/** 予約 1 枠の既定の長さ（分）。一般的なディナーの滞在時間 */
const DEFAULT_SLOT_MINUTES = 90;
/** 同時に受け付ける予約枠数の既定値。まずは 1 組ずつから始める */
const DEFAULT_MAX_PARALLEL = 1;

/**
 * メニューのカテゴリ。「ラーメン」「トッピング」など。
 *
 * `(shop_id, id)` にユニーク索引を張っているのは、`menu_items` から
 * 複合外部キーで参照するため（SQLite は参照先がユニークであることを要求する）。
 */
export const menuCategories = sqliteTable(
  'menu_categories',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
  },
  (table) => [
    // 店舗詳細のメニュー表示順
    index('idx_menu_categories_shop_sort').on(table.shopId, table.sortOrder),
    // menu_items の複合外部キーの参照先。これが無いと実行時に foreign key mismatch になる
    uniqueIndex('uq_menu_categories_shop_id').on(table.shopId, table.id),

    check('ck_menu_categories_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check(
      'ck_menu_categories_name_length',
      lengthAtMost(table.name, MENU_CATEGORY_NAME_MAX_LENGTH),
    ),
    check('ck_menu_categories_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
  ],
);

/**
 * メニュー項目。
 *
 * `category_id` は NULL 可（まだ分類していない品）。
 * ただしカテゴリを指定する場合は**同じ店舗のカテゴリ**でなければならない。
 * これを `(shop_id, category_id)` → `menu_categories(shop_id, id)` の複合外部キーで縛る。
 * 片方が NULL なら制約は成立する（SQLite の既定は MATCH SIMPLE）ので、
 * 未分類の品はそのまま登録できる。
 */
export const menuItems = sqliteTable(
  'menu_items',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    categoryId: text('category_id'),
    name: text('name').notNull(),
    // 円。税込表示価格
    price: integer('price').notNull(),
    description: text('description'),
    r2Key: text('r2_key'),
    isRecommended: integer('is_recommended', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // カテゴリごとのメニュー一覧
    index('idx_menu_items_shop_category').on(table.shopId, table.categoryId),
    // 店舗詳細の「おすすめ」セクション
    index('idx_menu_items_shop_recommended').on(table.shopId, table.isRecommended),

    /*
     * 他店のカテゴリにぶら下がるのを防ぐ複合外部キー。
     * カテゴリを消したらその配下の品も消す（未分類の品は category_id が NULL なので残る）。
     * 注: drizzle-kit は SQLite の外部キーに名前を出力しないため、
     *     違反時のエラーは `FOREIGN KEY constraint failed` になる。
     */
    foreignKey({
      columns: [table.shopId, table.categoryId],
      foreignColumns: [menuCategories.shopId, menuCategories.id],
    }).onDelete('cascade'),

    check('ck_menu_items_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_menu_items_name_length', lengthAtMost(table.name, MENU_ITEM_NAME_MAX_LENGTH)),
    check(
      'ck_menu_items_description_length',
      lengthAtMost(table.description, MENU_ITEM_DESCRIPTION_MAX_LENGTH),
    ),
    check('ck_menu_items_price', betweenInclusive(table.price, PRICE_YEN_MIN, PRICE_YEN_MAX)),
    check('ck_menu_items_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
    check('ck_menu_items_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
    check('ck_menu_items_is_recommended', isBooleanInteger(table.isRecommended)),
  ],
);

/**
 * 席と予約の設定。1 店舗 1 行なので shop_id をそのまま主キーにする。
 * Phase 7 の予約枠計算（`slot_minutes` 刻みで `max_parallel` 組まで）の入力になる。
 */
export const seatSettings = sqliteTable(
  'seat_settings',
  {
    shopId: text('shop_id')
      .primaryKey()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // 総席数
    capacity: integer('capacity').notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(DEFAULT_SLOT_MINUTES),
    maxParallel: integer('max_parallel').notNull().default(DEFAULT_MAX_PARALLEL),
    // 既定は false。オーナーが明示的に有効化するまで予約導線を出さない
    acceptsReservation: integer('accepts_reservation', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    check(
      'ck_seat_settings_capacity',
      betweenInclusive(table.capacity, SEAT_CAPACITY_MIN, SEAT_CAPACITY_MAX),
    ),
    check(
      'ck_seat_settings_slot_minutes',
      betweenInclusive(table.slotMinutes, SLOT_MINUTES_MIN, SLOT_MINUTES_MAX),
    ),
    check(
      'ck_seat_settings_max_parallel',
      betweenInclusive(table.maxParallel, MAX_PARALLEL_MIN, MAX_PARALLEL_MAX),
    ),
    check('ck_seat_settings_accepts_reservation', isBooleanInteger(table.acceptsReservation)),
  ],
);
