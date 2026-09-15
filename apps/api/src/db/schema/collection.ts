import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { IDENTIFIER_MAX_LENGTH, SORT_ORDER_MIN } from '../constants';
import { atLeast, consistsOf, isBooleanInteger, lengthAtMost, lengthIs } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

/**
 * 共有リンクのトークン長。
 * 小文字英数字 36 種 × 32 文字 ≒ 165 ビットで、総当たりで当てられる長さではない。
 */
export const SHARE_TOKEN_LENGTH = 32;
/** 共有トークンに使える文字。URL にそのまま載るので小文字英数字のみ */
const SHARE_TOKEN_ALLOWED_CHARACTERS = 'a-z0-9';
/** リスト名の上限 */
const LIST_NAME_MAX_LENGTH = 100;
/** リスト説明の上限 */
const LIST_DESCRIPTION_MAX_LENGTH = 1000;
/** リスト項目のメモの上限 */
const LIST_ITEM_NOTE_MAX_LENGTH = 500;
/** 並び順の既定値 */
const DEFAULT_SORT_ORDER = 0;

/**
 * お気に入り。ユーザーと店舗の組み合わせがそのまま主キー。
 * 代理キーを置かないので「二重登録できない」が主キーだけで保証される。
 */
export const favorites = sqliteTable(
  'favorites',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.shopId] }),
    // マイページの「お気に入り」を新着順で出す
    index('idx_favorites_user_created').on(table.userId, sql`${table.createdAt} desc`),
    // 店舗側から「何人がお気に入りにしているか」を数える
    index('idx_favorites_shop').on(table.shopId),
  ],
);

/**
 * ユーザーが作る店舗リスト（「行きたい店」など）。
 *
 * `share_token` は共有リンク用の秘密の文字列。NULL なら未共有。
 * SQLite のユニーク索引は NULL を重複とみなさないので、未共有のリストは何件でも作れる。
 */
export const lists = sqliteTable(
  'lists',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // 既定は非公開。共有は明示的な操作に限る
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    shareToken: text('share_token'),
  },
  (table) => [
    index('idx_lists_user').on(table.userId),
    // 共有リンクからの引き当てに使う。同じトークンが 2 つあると別人のリストが見えてしまう
    uniqueIndex('uq_lists_share_token').on(table.shareToken),

    check('ck_lists_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_lists_name_length', lengthAtMost(table.name, LIST_NAME_MAX_LENGTH)),
    check(
      'ck_lists_description_length',
      lengthAtMost(table.description, LIST_DESCRIPTION_MAX_LENGTH),
    ),
    check('ck_lists_is_public', isBooleanInteger(table.isPublic)),
    // 短いトークンを発行してしまう実装ミスを DB で止める
    check('ck_lists_share_token_length', lengthIs(table.shareToken, SHARE_TOKEN_LENGTH)),
    check(
      'ck_lists_share_token_alphabet',
      consistsOf(table.shareToken, SHARE_TOKEN_ALLOWED_CHARACTERS),
    ),
  ],
);

/** リストに入っている店舗。リストと店舗の組み合わせがそのまま主キー。 */
export const listItems = sqliteTable(
  'list_items',
  {
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    note: text('note'),
    sortOrder: integer('sort_order').notNull().default(DEFAULT_SORT_ORDER),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.shopId] }),
    index('idx_list_items_list_sort').on(table.listId, table.sortOrder),

    check('ck_list_items_note_length', lengthAtMost(table.note, LIST_ITEM_NOTE_MAX_LENGTH)),
    check('ck_list_items_sort_order', atLeast(table.sortOrder, SORT_ORDER_MIN)),
  ],
);
