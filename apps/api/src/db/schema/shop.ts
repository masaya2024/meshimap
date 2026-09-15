import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  COUNT_MIN,
  IDENTIFIER_MAX_LENGTH,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
  RATING_AVG_MAX,
  RATING_AVG_MIN,
  SHOP_ADDRESS_MAX_LENGTH,
  SHOP_DESCRIPTION_MAX_LENGTH,
  SHOP_GEOHASH_PRECISION,
  SHOP_NAME_KANA_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
  SHOP_STATUS_DRAFT,
  SHOP_STATUSES,
} from '../constants';
import {
  atLeast,
  atMostColumn,
  betweenInclusive,
  consistsOf,
  inValues,
  lengthAtMost,
  lengthIs,
  matchesGlob,
} from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { areas, genres } from './master';

/**
 * geohash の base32 で使える文字。`a` `i` `l` `o` を含まない（見間違い防止のため除外された文字）。
 * GLOB の文字クラスとして使うので、範囲表記（`0-9`）と個別文字を並べた形にしてある。
 */
export const GEOHASH_ALPHABET_CHARACTER_CLASS = '0-9bcdefghjkmnpqrstuvwxyz';

/** 日本の郵便番号（NNN-NNNN）を表す GLOB パターン */
const POSTAL_CODE_GLOB_PATTERN = '[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]';

/** 電話番号の上限。ハイフン込みの国内番号で十分収まる */
const PHONE_MAX_LENGTH = 20;
/** URL の上限 */
const WEBSITE_MAX_LENGTH = 500;
/** カウンタ（レビュー数・閲覧数）の初期値 */
const INITIAL_COUNT = 0;
/** 平均評価の初期値。レビュー 0 件のうちは 0 で表示する */
const INITIAL_RATING_AVG = 0;

/**
 * 店舗。アプリの中心テーブル。
 *
 * 地理空間検索（設計書 §3.1）のために、緯度経度に加えて geohash（precision 7）を冗長に持つ。
 * D1 には R*Tree も三角関数もないため、
 *   段 1: geohash の前方一致（範囲比較で書く。GLOB でも索引は効くがバインド値次第で落ちる）
 *   段 2: lat / lng の範囲比較（索引が効く）
 *   段 3: Worker 上の Haversine
 * の 3 段で絞る。段 1・2 に必要な索引をこのテーブルで定義する。
 */
export const shops = sqliteTable(
  'shops',
  {
    id: text('id').primaryKey(),
    // 申請前やオーナー付け替え中は NULL。ユーザーを消しても店舗は残す
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    // 五十音順ソートと読み仮名検索のため。任意入力
    nameKana: text('name_kana'),
    // マスタが消えて店舗が宙に浮かないよう restrict。削除したいなら先に店舗を移す
    genreId: text('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'restrict' }),
    areaId: text('area_id')
      .notNull()
      .references(() => areas.id, { onDelete: 'restrict' }),
    description: text('description'),
    postalCode: text('postal_code'),
    address: text('address').notNull(),
    // 地図のピンと段 2 の境界ボックス判定に使う
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    // 段 1 の前方一致に使う。precision 7 ≒ 152m 四方（設計書 §3.1）
    geohash: text('geohash').notNull(),
    phone: text('phone'),
    website: text('website'),
    budgetLunchMin: integer('budget_lunch_min'),
    budgetLunchMax: integer('budget_lunch_max'),
    budgetDinnerMin: integer('budget_dinner_min'),
    budgetDinnerMax: integer('budget_dinner_max'),
    status: text('status', { enum: SHOP_STATUSES }).notNull().default(SHOP_STATUS_DRAFT),
    // レビューの集計結果を非正規化して持つ。一覧のソートで毎回 JOIN したくないため
    ratingAvg: real('rating_avg').notNull().default(INITIAL_RATING_AVG),
    ratingCount: integer('rating_count').notNull().default(INITIAL_COUNT),
    viewCount: integer('view_count').notNull().default(INITIAL_COUNT),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    // $onUpdateFn は Drizzle 経由の UPDATE でのみ働く。生 SQL で更新する場合は明示的に入れる
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT)
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    // ── 索引（設計書 §6 のインデックス方針）──
    // 段 1。公開・非公開を問わない管理画面用
    index('idx_shops_geohash').on(table.geohash),
    // 段 1。利用者向けの検索は必ず status = 'published' が付くため複合で持つ。
    // これがないとプランナが status 側の索引を選び、geohash の絞り込みが効かない
    index('idx_shops_status_geohash').on(table.status, table.geohash),
    // 段 2
    index('idx_shops_lat_lng').on(table.lat, table.lng),
    // 一覧の絞り込み
    index('idx_shops_genre_status').on(table.genreId, table.status),
    index('idx_shops_area_status').on(table.areaId, table.status),
    // オーナーの管理画面「自分の店舗」
    index('idx_shops_owner_id').on(table.ownerId),
    // 評価順ランキング。SQLite の索引列に .desc() はないので SQL 片で書く
    index('idx_shops_status_rating').on(table.status, sql`${table.ratingAvg} desc`),

    // ── CHECK 制約 ──
    check('ck_shops_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_shops_status', inValues(table.status, SHOP_STATUSES)),
    check('ck_shops_name_length', lengthAtMost(table.name, SHOP_NAME_MAX_LENGTH)),
    check('ck_shops_name_kana_length', lengthAtMost(table.nameKana, SHOP_NAME_KANA_MAX_LENGTH)),
    check(
      'ck_shops_description_length',
      lengthAtMost(table.description, SHOP_DESCRIPTION_MAX_LENGTH),
    ),
    check('ck_shops_address_length', lengthAtMost(table.address, SHOP_ADDRESS_MAX_LENGTH)),
    check('ck_shops_phone_length', lengthAtMost(table.phone, PHONE_MAX_LENGTH)),
    check('ck_shops_website_length', lengthAtMost(table.website, WEBSITE_MAX_LENGTH)),
    check('ck_shops_postal_code_format', matchesGlob(table.postalCode, POSTAL_CODE_GLOB_PATTERN)),
    check('ck_shops_lat', betweenInclusive(table.lat, LATITUDE_MIN, LATITUDE_MAX)),
    check('ck_shops_lng', betweenInclusive(table.lng, LONGITUDE_MIN, LONGITUDE_MAX)),
    // 長さと文字種を分けて縛る。どちらが壊れたかエラー名で分かるようにするため
    check('ck_shops_geohash_length', lengthIs(table.geohash, SHOP_GEOHASH_PRECISION)),
    check('ck_shops_geohash_alphabet', consistsOf(table.geohash, GEOHASH_ALPHABET_CHARACTER_CLASS)),
    check(
      'ck_shops_budget_lunch_range',
      sql`${betweenInclusive(table.budgetLunchMin, BUDGET_YEN_MIN, BUDGET_YEN_MAX)} AND ${betweenInclusive(table.budgetLunchMax, BUDGET_YEN_MIN, BUDGET_YEN_MAX)}`,
    ),
    check(
      'ck_shops_budget_dinner_range',
      sql`${betweenInclusive(table.budgetDinnerMin, BUDGET_YEN_MIN, BUDGET_YEN_MAX)} AND ${betweenInclusive(table.budgetDinnerMax, BUDGET_YEN_MIN, BUDGET_YEN_MAX)}`,
    ),
    // 片側だけの指定（「1000 円〜」）を許すため、NULL なら式全体が NULL になって CHECK を通る
    check('ck_shops_budget_lunch_order', atMostColumn(table.budgetLunchMin, table.budgetLunchMax)),
    check(
      'ck_shops_budget_dinner_order',
      atMostColumn(table.budgetDinnerMin, table.budgetDinnerMax),
    ),
    check('ck_shops_rating_avg', betweenInclusive(table.ratingAvg, RATING_AVG_MIN, RATING_AVG_MAX)),
    check('ck_shops_rating_count', atLeast(table.ratingCount, COUNT_MIN)),
    check('ck_shops_view_count', atLeast(table.viewCount, COUNT_MIN)),
  ],
);
