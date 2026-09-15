import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  IDENTIFIER_MAX_LENGTH,
  ISO_DATE_GLOB_PATTERN,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  R2_KEY_ALLOWED_CHARACTERS,
  R2_KEY_MAX_LENGTH,
  SORT_ORDER_MIN,
} from '../constants';
import {
  atLeast,
  betweenInclusive,
  consistsOf,
  isBooleanInteger,
  lengthAtMost,
  matchesGlob,
} from '../sql-helpers';
import { shops } from './shop';

/** 休業理由の上限。「年末年始」「設備点検」程度を想定 */
const CLOSURE_REASON_MAX_LENGTH = 100;
/** 写真キャプションの上限 */
const PHOTO_CAPTION_MAX_LENGTH = 200;
/** 並び順の既定値 */
const DEFAULT_SORT_ORDER = 0;

/**
 * 曜日ごとの営業時間。
 *
 * 時刻は「その日の 00:00 からの経過分」で持つ。日跨ぎ営業は 1440 を足した値で表す
 * （25:30 閉店 = 1530）。文字列の "25:30" を保存すると比較のたびに分解が必要になるため。
 *
 * 中休みのある店は同じ曜日に 2 行（昼・夜）を持つ。したがって (shop_id, day_of_week) は
 * **ユニークにしない**。
 */
export const shopHours = sqliteTable(
  'shop_hours',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // 0 = 日曜。JavaScript の Date#getDay() と揃えてある
    dayOfWeek: integer('day_of_week').notNull(),
    // 定休日（is_closed = 1）のときは NULL
    openMinute: integer('open_minute'),
    closeMinute: integer('close_minute'),
    isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // 「この店の月曜の営業時間」を引く唯一のアクセスパターン
    index('idx_shop_hours_shop_day').on(table.shopId, table.dayOfWeek),

    check('ck_shop_hours_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check(
      'ck_shop_hours_day_of_week',
      betweenInclusive(table.dayOfWeek, DAY_OF_WEEK_MIN, DAY_OF_WEEK_MAX),
    ),
    check(
      'ck_shop_hours_open_minute',
      betweenInclusive(table.openMinute, MINUTE_OF_DAY_MIN, MINUTE_OF_DAY_MAX),
    ),
    check(
      'ck_shop_hours_close_minute',
      betweenInclusive(table.closeMinute, MINUTE_OF_DAY_MIN, MINUTE_OF_DAY_MAX),
    ),
    check('ck_shop_hours_is_closed', isBooleanInteger(table.isClosed)),
    // 開店 = 閉店（営業時間 0 分）も無意味なので等号は含めない
    check('ck_shop_hours_open_before_close', sql`${table.openMinute} < ${table.closeMinute}`),
    /*
     * 「定休日なのに時刻が入っている」「営業日なのに時刻が NULL」という
     * 矛盾した行を DB レベルで止める。
     * 数値リテラルを書かずに済むよう、is_closed をそのまま真偽値として評価している。
     */
    check(
      'ck_shop_hours_closed_coherence',
      sql`(${table.isClosed} AND ${table.openMinute} IS NULL AND ${table.closeMinute} IS NULL) OR (NOT ${table.isClosed} AND ${table.openMinute} IS NOT NULL AND ${table.closeMinute} IS NOT NULL)`,
    ),
  ],
);

/**
 * 臨時休業日。曜日ベースの `shop_hours` では表せない「この日だけ休み」を持つ。
 * 営業判定は shop_hours を見たあとにこのテーブルで打ち消す（設計書 §6）。
 */
export const shopClosures = sqliteTable(
  'shop_closures',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // `YYYY-MM-DD`（JST での暦日）。時刻を持たないので TEXT で持つ
    date: text('date').notNull(),
    reason: text('reason'),
  },
  (table) => [
    // 同じ日を二重登録させない。索引としても「この店のこの日は休みか」に直接効く
    uniqueIndex('uq_shop_closures_shop_date').on(table.shopId, table.date),

    check('ck_shop_closures_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_shop_closures_date_format', matchesGlob(table.date, ISO_DATE_GLOB_PATTERN)),
    check('ck_shop_closures_reason_length', lengthAtMost(table.reason, CLOSURE_REASON_MAX_LENGTH)),
  ],
);

/**
 * 店舗写真。実体は R2 に置き、ここにはキーだけを持つ（設計書 §6）。
 * キーの形式は `shop-photos/<shop_id>/<uuid>.<ext>`（規約 §1.2）。
 */
export const shopPhotos = sqliteTable(
  'shop_photos',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
    isCover: integer('is_cover', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // ギャラリーの表示順
    index('idx_shop_photos_shop_sort').on(table.shopId, table.sortOrder),
    // 同じ R2 オブジェクトを 2 行から参照させない。削除時に実体を消してよいか判断できなくなるため
    uniqueIndex('uq_shop_photos_r2_key').on(table.r2Key),
    /*
     * カバー写真は 1 店舗 1 枚。部分ユニーク索引（is_cover が真の行だけを対象）で保証する。
     * 単なる (shop_id, is_cover) のユニークだと「非カバー写真も 1 枚まで」になってしまう。
     */
    uniqueIndex('uq_shop_photos_cover')
      .on(table.shopId)
      .where(sql`${table.isCover}`),

    check('ck_shop_photos_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_shop_photos_r2_key_length', lengthAtMost(table.r2Key, R2_KEY_MAX_LENGTH)),
    check('ck_shop_photos_r2_key', consistsOf(table.r2Key, R2_KEY_ALLOWED_CHARACTERS)),
    check('ck_shop_photos_caption_length', lengthAtMost(table.caption, PHOTO_CAPTION_MAX_LENGTH)),
    check('ck_shop_photos_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
    check('ck_shop_photos_is_cover', isBooleanInteger(table.isCover)),
  ],
);
