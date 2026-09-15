import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import {
  IDENTIFIER_MAX_LENGTH,
  PROFILE_STATUS_ACTIVE,
  PROFILE_STATUSES,
  ROLE_USER,
  ROLES,
  SORT_ORDER_MIN,
} from '../constants';
import { atLeast, consistsOf, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';

/** 表示名の上限。長すぎるとレビュー一覧のレイアウトが崩れる */
const DISPLAY_NAME_MAX_LENGTH = 50;
/** 自己紹介文の上限 */
const BIO_MAX_LENGTH = 500;
/** ジャンル名・エリア名の上限 */
const MASTER_NAME_MAX_LENGTH = 50;
/** 都道府県名の上限（「神奈川県」など最長 4 文字だが余裕を持たせる） */
const PREFECTURE_MAX_LENGTH = 20;
/** slug に使える文字。URL とフィルタのクエリ文字列にそのまま出るため小文字英数字とハイフンのみ */
const SLUG_ALLOWED_CHARACTERS = 'a-z0-9-';

/**
 * アプリ側のユーザー情報。Better Auth の `user` は認証に必要な項目しか持たないため、
 * ロールや表示名はこちらに分けている。
 * 主キーを user_id にして 1 対 1 を DB レベルで保証する。
 */
export const profiles = sqliteTable(
  'profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    // 設計書 §4 より 1 アカウント 1 ロール。既定は利用者
    role: text('role', { enum: ROLES }).notNull().default(ROLE_USER),
    displayName: text('display_name').notNull(),
    // R2 のオブジェクトキー（`avatars/<user_id>/<uuid>.webp`）。未設定なら NULL
    avatarKey: text('avatar_key'),
    bio: text('bio'),
    status: text('status', { enum: PROFILE_STATUSES }).notNull().default(PROFILE_STATUS_ACTIVE),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // 管理画面のユーザー一覧をロールで絞り込む
    index('idx_profiles_role').on(table.role),
    // text(..., { enum }) は型の話でしかなく SQL には出ないため、DB 側でも縛る
    check('ck_profiles_role', inValues(table.role, ROLES)),
    check('ck_profiles_status', inValues(table.status, PROFILE_STATUSES)),
    check(
      'ck_profiles_display_name_length',
      lengthAtMost(table.displayName, DISPLAY_NAME_MAX_LENGTH),
    ),
    // bio は NULL 可だが、SQLite では length(NULL) <= 500 が NULL に評価され
    // CHECK は NULL を違反としないため、NULL 可のままこの式を掛けてよい
    check('ck_profiles_bio_length', lengthAtMost(table.bio, BIO_MAX_LENGTH)),
  ],
);

/**
 * 料理ジャンルのマスタ。管理者が CRUD する（設計書 5.1 `masters/genres.tsx`）。
 */
export const genres = sqliteTable(
  'genres',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // URL とフィルタのクエリに出るため、小文字英数字とハイフンのみに限定する
    slug: text('slug').notNull().unique(),
    // R2 ではなくバンドル同梱のアイコン名（`genre-icons/ramen.svg`）
    iconKey: text('icon_key'),
    sortOrder: integer('sort_order').notNull().default(SORT_ORDER_MIN),
  },
  (table) => [
    // ジャンル一覧は常に sort_order 順で出す
    index('idx_genres_sort_order').on(table.sortOrder),
    check('ck_genres_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_genres_name_length', lengthAtMost(table.name, MASTER_NAME_MAX_LENGTH)),
    check('ck_genres_slug_format', consistsOf(table.slug, SLUG_ALLOWED_CHARACTERS)),
    check('ck_genres_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
  ],
);

/**
 * エリアのマスタ。2 階層（区 → 街）で使う。
 * parent_id は自己参照。TypeScript の型推論が無限再帰するため
 * `AnySQLiteColumn` の戻り値型注釈を明示する必要がある。
 */
export const areas = sqliteTable(
  'areas',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // 親を消しても子（街）を残せるように set null。子ごと消すと店舗が宙に浮く
    parentId: text('parent_id').references((): AnySQLiteColumn => areas.id, {
      onDelete: 'set null',
    }),
    prefecture: text('prefecture').notNull(),
  },
  (table) => [
    // 親エリアから子エリアを引く（エリア絞り込みの階層展開）
    index('idx_areas_parent_id').on(table.parentId),
    check('ck_areas_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_areas_name_length', lengthAtMost(table.name, MASTER_NAME_MAX_LENGTH)),
    check('ck_areas_prefecture_length', lengthAtMost(table.prefecture, PREFECTURE_MAX_LENGTH)),
  ],
);
