import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUSES,
  IDENTIFIER_MAX_LENGTH,
  NOTIFICATION_TYPES,
  REPORT_STATUS_OPEN,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from '../constants';
import { consistsOf, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

/** 通報理由（定型文）の上限 */
const REPORT_REASON_MAX_LENGTH = 100;
/** 通報の自由記述の上限 */
const REPORT_DETAIL_MAX_LENGTH = 1000;
/** 差し戻し理由の上限 */
const REVIEW_NOTE_MAX_LENGTH = 1000;
/** 通知タイトルの上限。プッシュ通知の表示幅に合わせる */
const NOTIFICATION_TITLE_MAX_LENGTH = 100;
/** 通知本文の上限 */
const NOTIFICATION_BODY_MAX_LENGTH = 500;
/** 監査ログの `action` に使える文字。`shop.suspend` のようなドット区切りの固定語彙 */
const AUDIT_ACTION_ALLOWED_CHARACTERS = 'a-z0-9_.';
/** 監査ログの対象種別の上限 */
const AUDIT_TARGET_TYPE_MAX_LENGTH = 32;

/** 店舗申請に添付する書類 1 件。実体は R2 に置き、ここにはキーだけ持つ */
export type ApplicationDocument = {
  /** 書類の種類（営業許可証など） */
  readonly kind: string;
  /** R2 のオブジェクトキー */
  readonly r2Key: string;
};

/** 監査ログの差分。列名 → [変更前, 変更後] */
export type AuditLogDiff = Readonly<Record<string, readonly [unknown, unknown]>>;

/**
 * 通報。
 *
 * `target_id` には店舗 ID / レビュー ID / ユーザー ID のいずれかが入る。
 * SQLite に多相外部キーはないので参照整合性は張らず、`target_type` との組で解決する。
 * 対象が消えた通報は「対象なし」として管理画面に出す（Phase 9 Task 9-6 の通報キュー）。
 */
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    // 退会しても「通報があった事実」は消さない
    reporterId: text('reporter_id').references(() => user.id, { onDelete: 'set null' }),
    targetType: text('target_type', { enum: REPORT_TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    status: text('status', { enum: REPORT_STATUSES }).notNull().default(REPORT_STATUS_OPEN),
    handledBy: text('handled_by').references(() => user.id, { onDelete: 'set null' }),
    handledAt: integer('handled_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // 管理画面の未対応キュー（設計書 5.1 `(admin)/(tabs)/reports.tsx`）
    index('idx_reports_status_created').on(table.status, sql`${table.createdAt} desc`),
    // 「この店に何件の通報が来ているか」を対象側から引く
    index('idx_reports_target').on(table.targetType, table.targetId),
    index('idx_reports_reporter').on(table.reporterId),
    // 同じ人が同じ対象を連投できないようにする。
    // reporter_id が NULL（匿名通報）は SQLite のユニーク索引では重複扱いにならず、何件でも入る
    uniqueIndex('uq_reports_reporter_target').on(
      table.reporterId,
      table.targetType,
      table.targetId,
    ),

    check('ck_reports_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_reports_target_type', inValues(table.targetType, REPORT_TARGET_TYPES)),
    check('ck_reports_status', inValues(table.status, REPORT_STATUSES)),
    check('ck_reports_reason_length', lengthAtMost(table.reason, REPORT_REASON_MAX_LENGTH)),
    check('ck_reports_detail_length', lengthAtMost(table.detail, REPORT_DETAIL_MAX_LENGTH)),
    // 「対応者を書くなら日時も書く」。逆向き（日時だけある）は許す。
    // ON DELETE set null で handled_by だけが消えた行を残すため、双方向の等式にはしない
    check(
      'ck_reports_handler_requires_time',
      sql`${table.handledBy} IS NULL OR ${table.handledAt} IS NOT NULL`,
    ),
    // 決着済みなら必ず対応日時が入っている
    check(
      'ck_reports_closed_requires_time',
      sql`${table.status} IN ('open', 'in_review') OR ${table.handledAt} IS NOT NULL`,
    ),
  ],
);

/**
 * 店舗オーナー申請。
 *
 * `shop_id` は NOT NULL なので、申請行より先に店舗行が要る。したがって店舗は
 * 承認時ではなく**申請時**に下書き（`status = draft`・`owner_id` は NULL）として作る
 * （Phase 9 Task 9-25）。`shops.owner_id` が nullable なのはこのため。
 * 承認されると申請者のロールが `user` → `owner` に上がる（Phase 9 Task 9-5）。
 */
export const shopApplications = sqliteTable(
  'shop_applications',
  {
    id: text('id').primaryKey(),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // 添付書類の配列。実体は R2、ここはキーの一覧
    documents: text('documents', { mode: 'json' })
      .$type<readonly ApplicationDocument[]>()
      .notNull()
      .default([]),
    status: text('status', { enum: APPLICATION_STATUSES })
      .notNull()
      .default(APPLICATION_STATUS_PENDING),
    reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // 管理画面の審査待ちキュー
    index('idx_shop_applications_status_created').on(table.status, sql`${table.createdAt} desc`),
    index('idx_shop_applications_applicant').on(table.applicantId),
    // 同じ店に審査待ちが 2 件並ぶと、2 人のオーナーを承認してしまう事故が起きる。
    // 決着済み（approved / rejected / returned）は対象外なので再申請はできる
    uniqueIndex('uq_shop_applications_shop_pending')
      .on(table.shopId)
      .where(sql`${table.status} = 'pending'`),

    check('ck_shop_applications_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_shop_applications_status', inValues(table.status, APPLICATION_STATUSES)),
    // 壊れた JSON が入ると管理画面の json_extract が実行時に落ちる。書き込み時に止める
    check(
      'ck_shop_applications_documents_json',
      sql`json_valid(${table.documents}) AND json_type(${table.documents}) = 'array'`,
    ),
    check(
      'ck_shop_applications_review_note_length',
      lengthAtMost(table.reviewNote, REVIEW_NOTE_MAX_LENGTH),
    ),
  ],
);

/**
 * アプリ内通知。
 *
 * `data` には遷移先を決めるための識別子だけを入れる（例: `{"reservationId":"rsv_..."}`）。
 * 本文を再構成できるだけの情報を入れると、仕様変更のたびに過去の通知が壊れる。
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type', { enum: NOTIFICATION_TYPES }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: text('data', { mode: 'json' }).$type<Readonly<Record<string, string>>>(),
    // 未読なら NULL。既読の時刻を持つことで「いつ読んだか」も分かる
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    index('idx_notifications_user_created').on(table.userId, sql`${table.createdAt} desc`),
    // 未読バッジはアプリ起動のたびに走る。全件索引より小さい部分索引を当てる
    index('idx_notifications_user_unread')
      .on(table.userId, sql`${table.createdAt} desc`)
      .where(sql`${table.readAt} IS NULL`),

    check('ck_notifications_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_notifications_type', inValues(table.type, NOTIFICATION_TYPES)),
    check(
      'ck_notifications_title_length',
      lengthAtMost(table.title, NOTIFICATION_TITLE_MAX_LENGTH),
    ),
    check('ck_notifications_body_length', lengthAtMost(table.body, NOTIFICATION_BODY_MAX_LENGTH)),
    check('ck_notifications_data_json', sql`${table.data} IS NULL OR json_valid(${table.data})`),
  ],
);

/**
 * 監査ログ。「誰がいつ何をしたか」を追記専用で残す（設計書 5.1 `(admin)/audit-log.tsx`）。
 *
 * 実行者アカウントが消えても行は残す。消してしまうと処分の履歴が追えなくなる。
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    // `shop.suspend` のようなドット区切りの固定語彙
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    diff: text('diff', { mode: 'json' }).$type<AuditLogDiff>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // 管理画面の既定表示は「全体の新着順」。索引だけで並べ替えを済ませる
    index('idx_audit_logs_created').on(sql`${table.createdAt} desc`),
    index('idx_audit_logs_actor_created').on(table.actorId, sql`${table.createdAt} desc`),
    // 「この店に何がされたか」を追う
    index('idx_audit_logs_target').on(table.targetType, table.targetId),

    check('ck_audit_logs_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    // 大文字や空文字を弾く。表記ゆれが入ると action 別の集計ができなくなる
    check('ck_audit_logs_action', consistsOf(table.action, AUDIT_ACTION_ALLOWED_CHARACTERS)),
    check(
      'ck_audit_logs_target_type_length',
      lengthAtMost(table.targetType, AUDIT_TARGET_TYPE_MAX_LENGTH),
    ),
    check('ck_audit_logs_diff_json', sql`${table.diff} IS NULL OR json_valid(${table.diff})`),
  ],
);
