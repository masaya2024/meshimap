import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Better Auth が管理する認証テーブル群。
 *
 * 方針:
 * カラム名・型は Better Auth 1.7.5 の定義（`@better-auth/core` の getAuthTables と
 * `@better-auth/drizzle-adapter` の SQLite 型対応）に厳密に合わせる。
 * **CHECK 制約を付けない**のは、Better Auth が自前で INSERT/UPDATE を発行するため、
 * こちらが値を縛るとライブラリ更新時に認証が丸ごと壊れるから。
 * アプリ固有の制約は profiles 以降のテーブルで掛ける。
 */

/**
 * 作成日時・更新日時の既定値。
 * Better Auth の drizzle-adapter が生成するのと同じ式にそろえてある。
 * `unixepoch('subsecond')` は小数秒を含む秒を返すため、1000 倍してミリ秒にする。
 */
export const CREATED_AT_DEFAULT = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Better Auth がサインイン時に email で引くため一意制約が必須
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(CREATED_AT_DEFAULT),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(CREATED_AT_DEFAULT),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    // Cookie に載る値。毎リクエストここで引くため一意制約と索引が要る
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      // 退会時にセッションを残すと「消えたユーザーのトークンが生きている」状態になる
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_session_user_id').on(table.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    // プロバイダ側のユーザー識別子。メール認証では email がそのまま入る
    accountId: text('account_id').notNull(),
    // 'credential'（メール+パスワード）や 'google' などの識別子
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    // メール+パスワード認証のハッシュ。OAuth のときは NULL
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    index('idx_account_user_id').on(table.userId),
    // (provider_id, account_id) を一意にしたくなるが、Better Auth は一意を前提にしていない。
    // 一意制約を足すとアカウント連携の経路で予期せぬ失敗が起きるため索引のみに留める。
    index('idx_account_provider').on(table.providerId, table.accountId),
  ],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    // メールアドレスやトークンの持ち主を表す文字列。ここで検索する
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)],
);
