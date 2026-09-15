import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1, readMigrationSql } from '../testing/local-d1';
import * as schema from './index';

/**
 * CHECK 制約の境界値テストと、その網羅を機械的に保証するメタテスト。
 *
 * 個々の CHECK は「この値は通る / この値は弾かれる」だけなので、
 * `it` を制約の数だけ書くとコピペの貼り違いで
 * 「別の制約を 2 回テストしている」事故が起きる。表にして `it.each` で回す。
 *
 * `accepted` には必ず上限ちょうど・下限ちょうどを置く。
 * 上限 200 文字に対して 199 文字を置くと `<= 200` を `< 200` に書き換えても落ちず、
 * 境界を守れていないテストになる。
 */

/** vitest の ESM 変換下でも `__dirname` は使える（ここが動いている事実がその証拠） */
const SCHEMA_DIR = __dirname;

const MIGRATION_PATH = join(SCHEMA_DIR, '../../../migrations/0000_init.sql');

/** 自分自身。ソースを grep して網羅を数える対象からは外す */
const SELF_FILE_NAME = 'check-constraints.test.ts';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 全ケースが共有するジャンルとエリア。shops の FK を満たすためだけに使う */
const GENRE_ID = 'gnr_ck';
const AREA_ID = 'area_ck';

/** 予約日時・対応日時の基準値（2026-09-16 相当のエポックミリ秒） */
const BASE_TIMESTAMP_MS = 1_789_500_000_000;

/** D1 に渡せる値。テストで使うのは文字列・数値・NULL だけ */
type SqlValue = string | number | null;

type Row = Readonly<Record<string, SqlValue>>;

/** 長さ上限の境界をそのまま書けるようにする。`length()` は文字数を返すので ASCII で十分 */
function chars(count: number): string {
  return 'a'.repeat(count);
}

/**
 * ケースごとに 1 つずつ用意する親行の ID。
 * 親を共有すると UNIQUE 制約や部分ユニーク索引に引っかかり、
 * CHECK 違反ではなく別の理由で落ちるテストになってしまう。
 */
const fixtureUserId = (index: number): string => `usr_ck_${index}`;
const fixtureShopId = (index: number): string => `shp_ck_${index}`;
const fixtureReviewId = (index: number): string => `rvw_ck_${index}`;
const fixtureListId = (index: number): string => `lst_ck_${index}`;

/**
 * テーブルごとの「すべての CHECK を満たす行」。
 * ケースはこの行の 1 列だけを差し替えて INSERT する。
 * 一意列にはケース番号を混ぜ、同じテーブルの別ケースと衝突させない。
 */
const BASE_ROWS = {
  areas: (index: number): Row => ({
    id: `area_case_${index}`,
    name: 'テストエリア',
    prefecture: '東京都',
  }),
  genres: (index: number): Row => ({
    id: `gnr_case_${index}`,
    name: 'テストジャンル',
    slug: `genre-case-${index}`,
  }),
  profiles: (index: number): Row => ({
    user_id: fixtureUserId(index),
    display_name: '表示名',
    bio: null,
  }),
  shops: (index: number): Row => ({
    id: `shp_case_${index}`,
    name: 'テスト店',
    name_kana: null,
    genre_id: GENRE_ID,
    area_id: AREA_ID,
    description: null,
    address: '東京都渋谷区',
    lat: SHIBUYA.lat,
    lng: SHIBUYA.lng,
    geohash: SHIBUYA.geohash,
    phone: null,
    website: null,
    budget_lunch_min: null,
    budget_lunch_max: null,
    budget_dinner_min: null,
    budget_dinner_max: null,
    view_count: 0,
  }),
  shop_closures: (index: number): Row => ({
    id: `scl_case_${index}`,
    shop_id: fixtureShopId(index),
    date: '2026-01-01',
    reason: null,
  }),
  shop_hours: (index: number): Row => ({
    id: `shr_case_${index}`,
    shop_id: fixtureShopId(index),
    day_of_week: 1,
    open_minute: 600,
    close_minute: 1320,
    is_closed: 0,
  }),
  shop_photos: (index: number): Row => ({
    id: `sph_case_${index}`,
    shop_id: fixtureShopId(index),
    r2_key: `shop-photos/case-${index}.webp`,
    caption: null,
    sort_order: 0,
    is_cover: 0,
  }),
  menu_categories: (index: number): Row => ({
    id: `mct_case_${index}`,
    shop_id: fixtureShopId(index),
    name: 'カテゴリ',
    sort_order: 0,
  }),
  menu_items: (index: number): Row => ({
    id: `mit_case_${index}`,
    shop_id: fixtureShopId(index),
    // 複合外部キーは片方が NULL なら成立する。カテゴリを作らずに済ませる
    category_id: null,
    name: '醤油ラーメン',
    price: 900,
    description: null,
    r2_key: null,
    is_recommended: 0,
  }),
  seat_settings: (index: number): Row => ({
    shop_id: fixtureShopId(index),
    capacity: 10,
    slot_minutes: 90,
    max_parallel: 1,
    accepts_reservation: 0,
  }),
  reviews: (index: number): Row => ({
    id: `rvw_case_${index}`,
    shop_id: fixtureShopId(index),
    user_id: fixtureUserId(index),
    rating: 3,
    body: 'おいしかった',
    budget: null,
  }),
  review_photos: (index: number): Row => ({
    id: `rvp_case_${index}`,
    review_id: fixtureReviewId(index),
    r2_key: `review-photos/case-${index}.webp`,
    sort_order: 0,
  }),
  review_replies: (index: number): Row => ({
    review_id: fixtureReviewId(index),
    shop_id: fixtureShopId(index),
    body: 'ご来店ありがとうございます',
  }),
  reservations: (index: number): Row => ({
    id: `rsv_case_${index}`,
    shop_id: fixtureShopId(index),
    user_id: fixtureUserId(index),
    reserved_at: BASE_TIMESTAMP_MS,
    party_size: 2,
    note: null,
  }),
  lists: (index: number): Row => ({
    id: `lst_case_${index}`,
    user_id: fixtureUserId(index),
    name: '行きたい店',
    description: null,
    is_public: 0,
    share_token: null,
  }),
  list_items: (index: number): Row => ({
    list_id: fixtureListId(index),
    shop_id: fixtureShopId(index),
    note: null,
    sort_order: 0,
  }),
  audit_logs: (index: number): Row => ({
    id: `adt_case_${index}`,
    actor_id: null,
    action: 'shop.update',
    target_type: 'shop',
    target_id: fixtureShopId(index),
    diff: null,
  }),
  notifications: (index: number): Row => ({
    id: `ntf_case_${index}`,
    user_id: fixtureUserId(index),
    type: 'announcement',
    title: 'お知らせ',
    body: 'メンテナンスのお知らせ',
    data: null,
  }),
  reports: (index: number): Row => ({
    id: `rpt_case_${index}`,
    reporter_id: fixtureUserId(index),
    target_type: 'shop',
    target_id: fixtureShopId(index),
    reason: '閉店しているのに掲載されている',
    detail: null,
    status: 'open',
    handled_by: null,
    // ck_reports_closed_requires_time を満たすため、status を差し替えても困らない値を入れておく
    handled_at: BASE_TIMESTAMP_MS,
  }),
  shop_applications: (index: number): Row => ({
    id: `sap_case_${index}`,
    applicant_id: fixtureUserId(index),
    shop_id: fixtureShopId(index),
    documents: '[]',
    // 既定値の pending のままだと uq_shop_applications_shop_pending に触れる。
    // ケースごとに店舗を分けてはいるが、既定は当たりの弱い値にしておく
    status: 'approved',
    reviewed_by: null,
    review_note: null,
  }),
};

type TableName = keyof typeof BASE_ROWS;

/** 1 つの CHECK 制約について、通る値と弾かれる値を 1 行で表す */
interface ConstraintCase {
  /** CHECK 制約名。メタテストが照合するキーでもある */
  readonly name: string;
  /** 制約の付いたテーブル */
  readonly table: TableName;
  /** 制約の付いた列 */
  readonly column: string;
  /** その列に入れる、弾かれるべき値 */
  readonly rejected: SqlValue;
  /** 同じ列に入れる、通るべき値。境界ちょうどを置く */
  readonly accepted: SqlValue;
  /** 複数列にまたがる制約で、相方の列を固定するための上書き */
  readonly extra?: Row;
}

/**
 * 既存の schema/*.test.ts が名指ししていない CHECK 制約の表。
 * 上限ちょうど・下限ちょうどを `accepted` に、その 1 つ外を `rejected` に置く。
 * 上下両端を持つ制約は 2 行に分ける。
 */
const CONSTRAINT_CASES: readonly ConstraintCase[] = [
  // --- areas ---
  {
    name: 'ck_areas_id_length',
    table: 'areas',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_areas_name_length',
    table: 'areas',
    column: 'name',
    accepted: chars(50),
    rejected: chars(51),
  },
  {
    name: 'ck_areas_prefecture_length',
    table: 'areas',
    column: 'prefecture',
    accepted: chars(20),
    rejected: chars(21),
  },

  // --- genres ---
  {
    name: 'ck_genres_id_length',
    table: 'genres',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_genres_name_length',
    table: 'genres',
    column: 'name',
    accepted: chars(50),
    rejected: chars(51),
  },

  // --- profiles ---
  {
    name: 'ck_profiles_display_name_length',
    table: 'profiles',
    column: 'display_name',
    accepted: chars(50),
    rejected: chars(51),
  },
  {
    name: 'ck_profiles_bio_length',
    table: 'profiles',
    column: 'bio',
    accepted: chars(500),
    rejected: chars(501),
  },

  // --- shops ---
  {
    name: 'ck_shops_id_length',
    table: 'shops',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_shops_name_kana_length',
    table: 'shops',
    column: 'name_kana',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    name: 'ck_shops_description_length',
    table: 'shops',
    column: 'description',
    accepted: chars(2000),
    rejected: chars(2001),
  },
  {
    name: 'ck_shops_address_length',
    table: 'shops',
    column: 'address',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    name: 'ck_shops_phone_length',
    table: 'shops',
    column: 'phone',
    accepted: chars(20),
    rejected: chars(21),
  },
  {
    name: 'ck_shops_website_length',
    table: 'shops',
    column: 'website',
    accepted: chars(500),
    rejected: chars(501),
  },
  { name: 'ck_shops_view_count', table: 'shops', column: 'view_count', accepted: 0, rejected: -1 },
  {
    // 下限側。相方の max を 0 に固定しないと budget_lunch_order にも触れる
    name: 'ck_shops_budget_lunch_range',
    table: 'shops',
    column: 'budget_lunch_min',
    accepted: 0,
    rejected: -1,
    extra: { budget_lunch_max: 0 },
  },
  {
    // 上限側。min を上限に固定し、max だけを 1 円はみ出させる
    name: 'ck_shops_budget_lunch_range',
    table: 'shops',
    column: 'budget_lunch_max',
    accepted: 1_000_000,
    rejected: 1_000_001,
    extra: { budget_lunch_min: 1_000_000 },
  },
  {
    // min <= max の境界は「ちょうど等しい」。1 円超えたら弾かれる
    name: 'ck_shops_budget_dinner_order',
    table: 'shops',
    column: 'budget_dinner_min',
    accepted: 3000,
    rejected: 3001,
    extra: { budget_dinner_max: 3000 },
  },

  // --- shop_closures ---
  {
    name: 'ck_shop_closures_id_length',
    table: 'shop_closures',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_shop_closures_reason_length',
    table: 'shop_closures',
    column: 'reason',
    accepted: chars(100),
    rejected: chars(101),
  },

  // --- shop_hours ---
  {
    name: 'ck_shop_hours_id_length',
    table: 'shop_hours',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    // 下限側だけを見る。上限 2879 は ck_shop_hours_open_before_close が
    // close > open を要求するため（close の上限も 2879）、通る行を作れない
    name: 'ck_shop_hours_open_minute',
    table: 'shop_hours',
    column: 'open_minute',
    accepted: 0,
    rejected: -1,
  },

  // --- shop_photos ---
  {
    name: 'ck_shop_photos_id_length',
    table: 'shop_photos',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_shop_photos_r2_key_length',
    table: 'shop_photos',
    column: 'r2_key',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    name: 'ck_shop_photos_caption_length',
    table: 'shop_photos',
    column: 'caption',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    name: 'ck_shop_photos_is_cover',
    table: 'shop_photos',
    column: 'is_cover',
    accepted: 1,
    rejected: 2,
  },

  // --- menu_categories ---
  {
    name: 'ck_menu_categories_id_length',
    table: 'menu_categories',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_menu_categories_name_length',
    table: 'menu_categories',
    column: 'name',
    accepted: chars(50),
    rejected: chars(51),
  },
  {
    name: 'ck_menu_categories_sort_order',
    table: 'menu_categories',
    column: 'sort_order',
    accepted: 0,
    rejected: -1,
  },

  // --- menu_items ---
  {
    name: 'ck_menu_items_id_length',
    table: 'menu_items',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_menu_items_name_length',
    table: 'menu_items',
    column: 'name',
    accepted: chars(100),
    rejected: chars(101),
  },
  {
    name: 'ck_menu_items_description_length',
    table: 'menu_items',
    column: 'description',
    accepted: chars(500),
    rejected: chars(501),
  },
  {
    name: 'ck_menu_items_r2_key_length',
    table: 'menu_items',
    column: 'r2_key',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    name: 'ck_menu_items_is_recommended',
    table: 'menu_items',
    column: 'is_recommended',
    accepted: 1,
    rejected: 2,
  },

  // --- seat_settings ---
  {
    name: 'ck_seat_settings_max_parallel',
    table: 'seat_settings',
    column: 'max_parallel',
    accepted: 1,
    rejected: 0,
  },
  {
    name: 'ck_seat_settings_max_parallel',
    table: 'seat_settings',
    column: 'max_parallel',
    accepted: 100,
    rejected: 101,
  },
  {
    name: 'ck_seat_settings_accepts_reservation',
    table: 'seat_settings',
    column: 'accepts_reservation',
    accepted: 1,
    rejected: 2,
  },

  // --- reviews ---
  {
    name: 'ck_reviews_id_length',
    table: 'reviews',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_reviews_body_length',
    table: 'reviews',
    column: 'body',
    accepted: chars(2000),
    rejected: chars(2001),
  },
  { name: 'ck_reviews_budget', table: 'reviews', column: 'budget', accepted: 0, rejected: -1 },
  {
    name: 'ck_reviews_budget',
    table: 'reviews',
    column: 'budget',
    accepted: 1_000_000,
    rejected: 1_000_001,
  },

  // --- review_photos ---
  {
    name: 'ck_review_photos_id_length',
    table: 'review_photos',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_review_photos_r2_key_length',
    table: 'review_photos',
    column: 'r2_key',
    accepted: chars(200),
    rejected: chars(201),
  },
  {
    // 使える文字は a-z0-9/._- だけ。大文字が混ざったら弾く
    name: 'ck_review_photos_r2_key',
    table: 'review_photos',
    column: 'r2_key',
    accepted: 'review-photos/rvp-lower/a1b2.webp',
    rejected: 'review-photos/A.webp',
  },
  {
    // 空文字は GLOB を素通りするので `<> ''` が要る。その半分をここで守る
    name: 'ck_review_photos_r2_key',
    table: 'review_photos',
    column: 'r2_key',
    accepted: 'review-photos/rvp-empty/c3d4.webp',
    rejected: '',
  },

  // --- review_replies ---
  {
    name: 'ck_review_replies_body_length',
    table: 'review_replies',
    column: 'body',
    accepted: chars(1000),
    rejected: chars(1001),
  },

  // --- reservations ---
  {
    name: 'ck_reservations_id_length',
    table: 'reservations',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_reservations_note_length',
    table: 'reservations',
    column: 'note',
    accepted: chars(500),
    rejected: chars(501),
  },

  // --- lists ---
  {
    name: 'ck_lists_id_length',
    table: 'lists',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_lists_name_length',
    table: 'lists',
    column: 'name',
    accepted: chars(100),
    rejected: chars(101),
  },
  {
    name: 'ck_lists_description_length',
    table: 'lists',
    column: 'description',
    accepted: chars(1000),
    rejected: chars(1001),
  },
  { name: 'ck_lists_is_public', table: 'lists', column: 'is_public', accepted: 1, rejected: 2 },

  // --- list_items ---
  {
    name: 'ck_list_items_note_length',
    table: 'list_items',
    column: 'note',
    accepted: chars(500),
    rejected: chars(501),
  },

  // --- audit_logs ---
  {
    name: 'ck_audit_logs_id_length',
    table: 'audit_logs',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_audit_logs_target_type_length',
    table: 'audit_logs',
    column: 'target_type',
    accepted: chars(32),
    rejected: chars(33),
  },
  {
    name: 'ck_audit_logs_diff_json',
    table: 'audit_logs',
    column: 'diff',
    accepted: '{"name":["旧","新"]}',
    rejected: '{"name":',
  },
  {
    // `IS NULL OR json_valid(...)` の NULL 側。差分を残さない操作もある
    name: 'ck_audit_logs_diff_json',
    table: 'audit_logs',
    column: 'diff',
    accepted: null,
    rejected: 'not json',
  },

  // --- notifications ---
  {
    name: 'ck_notifications_id_length',
    table: 'notifications',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_notifications_title_length',
    table: 'notifications',
    column: 'title',
    accepted: chars(100),
    rejected: chars(101),
  },
  {
    name: 'ck_notifications_body_length',
    table: 'notifications',
    column: 'body',
    accepted: chars(500),
    rejected: chars(501),
  },

  // --- reports ---
  {
    name: 'ck_reports_id_length',
    table: 'reports',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_reports_reason_length',
    table: 'reports',
    column: 'reason',
    accepted: chars(100),
    rejected: chars(101),
  },
  {
    name: 'ck_reports_detail_length',
    table: 'reports',
    column: 'detail',
    accepted: chars(1000),
    rejected: chars(1001),
  },
  {
    name: 'ck_reports_status',
    table: 'reports',
    column: 'status',
    accepted: 'open',
    rejected: 'closed',
  },
  {
    name: 'ck_reports_status',
    table: 'reports',
    column: 'status',
    accepted: 'in_review',
    rejected: 'closed',
  },
  {
    name: 'ck_reports_status',
    table: 'reports',
    column: 'status',
    accepted: 'resolved',
    rejected: 'closed',
  },
  {
    name: 'ck_reports_status',
    table: 'reports',
    column: 'status',
    accepted: 'rejected',
    rejected: 'closed',
  },

  // --- shop_applications ---
  {
    name: 'ck_shop_applications_id_length',
    table: 'shop_applications',
    column: 'id',
    accepted: chars(64),
    rejected: chars(65),
  },
  {
    name: 'ck_shop_applications_review_note_length',
    table: 'shop_applications',
    column: 'review_note',
    accepted: chars(1000),
    rejected: chars(1001),
  },
  {
    name: 'ck_shop_applications_status',
    table: 'shop_applications',
    column: 'status',
    accepted: 'pending',
    rejected: 'cancelled',
  },
  {
    name: 'ck_shop_applications_status',
    table: 'shop_applications',
    column: 'status',
    accepted: 'approved',
    rejected: 'cancelled',
  },
  {
    name: 'ck_shop_applications_status',
    table: 'shop_applications',
    column: 'status',
    accepted: 'rejected',
    rejected: 'cancelled',
  },
  {
    name: 'ck_shop_applications_status',
    table: 'shop_applications',
    column: 'status',
    accepted: 'returned',
    rejected: 'cancelled',
  },
];

/** テスト名にそのまま埋めると 2000 文字の行が並ぶので、長い値は文字数で示す */
const INLINE_VALUE_MAX_LENGTH = 20;

function describeValue(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return value.length > INLINE_VALUE_MAX_LENGTH ? `${value.length} 文字` : `'${value}'`;
}

/** ケース番号と読めるテスト名を足した表。番号は親行の割り当てに使う */
const NUMBERED_CASES = CONSTRAINT_CASES.map((constraintCase, index) => ({
  ...constraintCase,
  index,
  title: `${constraintCase.name}: ${describeValue(constraintCase.accepted)} は通り ${describeValue(
    constraintCase.rejected,
  )} は弾かれる`,
}));

/** 親レビューを必要とするテーブル */
const TABLES_NEEDING_REVIEW: ReadonlySet<TableName> = new Set<TableName>([
  'review_photos',
  'review_replies',
]);

let local: LocalD1;

async function insertRow(table: string, row: Row): Promise<D1Result> {
  const columns = Object.keys(row);
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  return local.d1
    .prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`)
    .bind(...Object.values(row))
    .run();
}

/**
 * CHECK 違反のエラーメッセージから制約名だけを取り出す。
 *
 * `toThrow(/CHECK constraint failed: ck_shop_photos_r2_key/)` のような部分一致で書くと、
 * 実際に落ちたのが `ck_shop_photos_r2_key_length` でもテストが通ってしまう。
 * 名前を取り出して完全一致で比べる。
 */
function failedConstraintName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /CHECK constraint failed: (ck_[a-z0-9_]+)/.exec(message)?.[1] ?? null;
}

beforeAll(async () => {
  local = await createMigratedD1();

  const parents = [
    local.d1
      .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
      .bind(GENRE_ID, 'ラーメン', 'ramen-ck'),
    local.d1
      .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
      .bind(AREA_ID, '渋谷', '東京都'),
  ];
  for (const { index } of NUMBERED_CASES) {
    parents.push(
      local.d1
        .prepare('INSERT INTO user (id, name, email) VALUES (?, ?, ?)')
        .bind(fixtureUserId(index), 'CHECK テスト', `ck-${index}@example.com`),
      local.d1
        .prepare(
          'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          fixtureShopId(index),
          'CHECK テスト店',
          GENRE_ID,
          AREA_ID,
          '東京都渋谷区',
          SHIBUYA.lat,
          SHIBUYA.lng,
          SHIBUYA.geohash,
        ),
    );
  }
  // miniflare の D1 は 1 文ずつだと往復が積み上がるのでまとめて流す
  await local.d1.batch(parents);

  // レビューとリストは店舗・利用者が出来てからでないと作れない
  const children = [];
  for (const { index, table } of NUMBERED_CASES) {
    if (TABLES_NEEDING_REVIEW.has(table)) {
      children.push(
        local.d1
          .prepare(
            'INSERT INTO reviews (id, shop_id, user_id, rating, body) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            fixtureReviewId(index),
            fixtureShopId(index),
            fixtureUserId(index),
            3,
            '親レビュー',
          ),
      );
    }
    if (table === 'list_items') {
      children.push(
        local.d1
          .prepare('INSERT INTO lists (id, user_id, name) VALUES (?, ?, ?)')
          .bind(fixtureListId(index), fixtureUserId(index), '親リスト'),
      );
    }
  }
  if (children.length > 0) await local.d1.batch(children);
});

afterAll(async () => {
  await local.dispose();
});

describe('CHECK 制約の境界値', () => {
  it.each(NUMBERED_CASES)(
    '$title',
    async ({ name, table, column, accepted, rejected, extra, index }) => {
      const base: Row = { ...BASE_ROWS[table](index), ...extra };

      let caught: unknown = null;
      try {
        await insertRow(table, { ...base, [column]: rejected });
      } catch (error) {
        caught = error;
      }
      // 通ってしまったら制約が無い。別の制約名で落ちたなら境界の作り方が間違っている
      expect(
        caught,
        `${name}: ${column} に ${describeValue(rejected)} が入ってしまった`,
      ).not.toBeNull();
      expect(failedConstraintName(caught)).toBe(name);

      // 境界ちょうどは通る。ここが落ちるなら `<=` が `<` になっている
      const result = await insertRow(table, { ...base, [column]: accepted });
      expect(result.success).toBe(true);
    },
  );
});

/** マイグレーションに実際に書き出された CHECK 制約名 */
function constraintNamesInMigration(): readonly string[] {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  // drizzle-kit は CHECK 制約を `CONSTRAINT "ck_xxx" CHECK (...)` の形で出力する
  const matches = sql.matchAll(/CONSTRAINT "(ck_[a-z0-9_]+)"/g);
  return [...new Set([...matches].map((match) => match[1] ?? ''))].sort();
}

/** 同じディレクトリの他のテストファイルに名前が現れる CHECK 制約名 */
function constraintNamesInOtherTests(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const fileName of readdirSync(SCHEMA_DIR)) {
    // 自分自身をソースとして数えると、名前を書くだけで網羅したことになってしまう。
    // このファイルの分は下で CONSTRAINT_CASES（実際に INSERT を試す表）から数える
    if (!fileName.endsWith('.test.ts') || fileName === SELF_FILE_NAME) continue;
    const source = readFileSync(join(SCHEMA_DIR, fileName), 'utf8');
    for (const match of source.matchAll(/ck_[a-z0-9_]+/g)) names.add(match[0]);
  }
  return names;
}

describe('CHECK 制約のテスト網羅', () => {
  it('マイグレーション上の CHECK 制約はすべてどこかのテストで名指しされている', () => {
    const tested = new Set([
      ...constraintNamesInOtherTests(),
      ...CONSTRAINT_CASES.map((constraintCase) => constraintCase.name),
    ]);
    const untested = constraintNamesInMigration().filter((name) => !tested.has(name));
    // 差分をそのまま出す。落ちたとき「どれを書けばいいか」が一目で分かる
    expect(untested).toEqual([]);
  });

  it('表に載っている制約名はすべてマイグレーションに実在する', () => {
    const declared = new Set(constraintNamesInMigration());
    const unknownNames = [
      ...new Set(CONSTRAINT_CASES.map((constraintCase) => constraintCase.name)),
    ].filter((name) => !declared.has(name));
    // 名前を打ち間違えると、本物の制約が未テストのまま網羅だけ増える
    expect(unknownNames).toEqual([]);
  });
});

/**
 * 部分索引は `WHERE` を外してもほとんどのテストが緑のまま通る。
 * EXPLAIN QUERY PLAN が返す索引名は変わらないためで、
 * 索引名の一致だけを見るテストでは部分索引が部分索引であることを保証できない。
 * sqlite_master に格納された DDL を直接見る。
 */
const PARTIAL_INDEXES = [
  { name: 'uq_shop_photos_cover', where: 'WHERE "shop_photos"."is_cover"' },
  { name: 'idx_notifications_user_unread', where: 'WHERE "notifications"."read_at" IS NULL' },
  {
    name: 'uq_shop_applications_shop_pending',
    where: `WHERE "shop_applications"."status" = 'pending'`,
  },
] as const;

describe('部分索引の WHERE 句', () => {
  it.each(PARTIAL_INDEXES)('$name は WHERE 付きの部分索引である', async ({ name, where }) => {
    const row = await local.d1
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .bind('index', name)
      .first<{ sql: string }>();
    // 索引そのものが無ければ null。名前の打ち間違いをここで弾く
    expect(row).not.toBeNull();
    expect(row?.sql).toContain(where);
  });

  it('マイグレーション上の部分索引はすべて表に載っている', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // drizzle-kit は部分索引を `CREATE [UNIQUE] INDEX `名前` ON ... WHERE ...` で出力する
    const declared = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX `([a-z0-9_]+)`[^;]*WHERE/g)].map(
      (match) => match[1] ?? '',
    );
    const listed = PARTIAL_INDEXES.map((partialIndex) => partialIndex.name);
    expect(declared.sort()).toEqual([...listed].sort());
  });
});

// ──────────── Drizzle スキーマとマイグレーションの CHECK 定義の一致 ────────────

/**
 * Drizzle の CHECK 式を drizzle-kit と同じ文字列へ描画するための dialect。
 * 生成済みの DDL を読み解くのではなく、生成に使われる実装そのものを通す。
 */
const SQLITE_DIALECT = new SQLiteSyncDialect();

/** マイグレーション全文。テーブルごとに何度も照合するので 1 回だけ読んで使い回す */
const MIGRATION_SQL = readMigrationSql();

/** Drizzle 側の CHECK 制約 1 件を、マイグレーションの 1 行と同じ形へ描画したもの */
type RenderedCheck = {
  readonly tableName: string;
  readonly name: string;
  /** `CONSTRAINT "ck_xxx" CHECK(...)`。マイグレーション中の記述と完全一致する */
  readonly ddl: string;
};

/** テーブル 1 つ分の描画結果。it.each に渡してテーブル単位で落とす */
type TableChecks = {
  readonly tableName: string;
  readonly checks: readonly RenderedCheck[];
};

/**
 * schema/index.ts が再エクスポートしている全テーブルの CHECK 制約を描画して集める。
 * テーブルを手書きで並べないので、スキーマに足したテーブルは自動でこの検査に乗る。
 */
function collectDrizzleChecks(): readonly RenderedCheck[] {
  return Object.values(schema)
    .filter((exported) => is(exported, SQLiteTable))
    .flatMap((table) => {
      const { name: tableName, checks } = getTableConfig(table);
      return checks.map((check) => ({
        tableName,
        name: check.name,
        ddl: `CONSTRAINT "${check.name}" CHECK(${SQLITE_DIALECT.sqlToQuery(check.value).sql})`,
      }));
    });
}

function groupChecksByTable(checks: readonly RenderedCheck[]): readonly TableChecks[] {
  const grouped = new Map<string, RenderedCheck[]>();
  for (const check of checks) {
    const tableChecks = grouped.get(check.tableName);
    if (tableChecks) tableChecks.push(check);
    else grouped.set(check.tableName, [check]);
  }
  return [...grouped].map(([tableName, tableChecks]) => ({ tableName, checks: tableChecks }));
}

const DRIZZLE_CHECKS = collectDrizzleChecks();
const DRIZZLE_CHECKS_BY_TABLE = groupChecksByTable(DRIZZLE_CHECKS);

/** マイグレーションに書き出された CHECK 制約の個数。同名の制約は無いので出現数がそのまま個数 */
function countChecksInMigration(): number {
  return [...MIGRATION_SQL.matchAll(/CONSTRAINT "ck_[a-z0-9_]+" CHECK\(/g)].length;
}

/**
 * Drizzle のスキーマ定義とマイグレーション SQL の CHECK 制約がそろっていることを見る。
 *
 * DB を使うテストは静的な migrations/*.sql を流して作った D1 を相手にしている。
 * つまり `check()` に渡す式や、そこへ埋めている src/db/constants.ts の定数
 * （LATITUDE_MIN, LONGITUDE_MIN, R2_KEY_ALLOWED_CHARACTERS など）を書き換えても、
 * マイグレーションを再生成しない限りどのテストも落ちなかった。
 * スキーマ定義とマイグレーションがズレたまま気づけない穴が空いていたということ。
 *
 * ここでは drizzle-kit が DDL を書き出すときと同じ SQLiteSyncDialect で
 * Drizzle 側の CHECK 式を描画し、その文字列がマイグレーションに現れるかを照合する。
 * 定数を 1 文字でも変えれば描画結果が変わり、このテストが落ちる。
 */
describe('Drizzle スキーマとマイグレーションの CHECK 定義', () => {
  it.each(DRIZZLE_CHECKS_BY_TABLE)(
    '$tableName の CHECK 定義はマイグレーションの記述と一致する',
    ({ checks }) => {
      // 一致しなかったものだけを並べる。落ちたときにどの制約がズレたかがそのまま読める
      const mismatched = checks
        .filter((check) => !MIGRATION_SQL.includes(check.ddl))
        .map((check) => check.ddl);

      expect(mismatched).toEqual([]);
    },
  );

  // 上の照合は「Drizzle 側にある制約」しか見ない。Drizzle から制約を消すと
  // 照合する対象も消えて全部緑になってしまうので、個数でも縛る
  it('Drizzle 側の CHECK 制約の総数がマイグレーションの CHECK の数と一致する', () => {
    expect(DRIZZLE_CHECKS.length).toBe(countChecksInMigration());
  });

  it('Drizzle 側の CHECK 制約名がマイグレーションと過不足なく一致する', () => {
    // 個数が合っていても名前が入れ替わっていれば落ちる。差分は制約名で読める
    expect(DRIZZLE_CHECKS.map((check) => check.name).sort()).toEqual(constraintNamesInMigration());
  });
});
