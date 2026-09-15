import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  IDENTIFIER_MAX_LENGTH,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUSES,
} from '../constants';
import { betweenInclusive, inValues, lengthAtMost } from '../sql-helpers';
import { CREATED_AT_DEFAULT, user } from './auth';
import { shops } from './shop';

/**
 * 予約。
 *
 * 「同じ枠に何組まで入れるか」は `seat_settings.slot_minutes` と `max_parallel` に依存し、
 * SQL の制約では表せない。二重予約の防止は Durable Object `ReservationLock`（Phase 7）の責務とし、
 * ここでは値の妥当性だけを縛る。
 */
export const reservations = sqliteTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // 来店日時。エポックミリ秒で持ち、表示のタイムゾーン変換はアプリ側で行う
    reservedAt: integer('reserved_at', { mode: 'timestamp_ms' }).notNull(),
    partySize: integer('party_size').notNull(),
    note: text('note'),
    status: text('status', { enum: RESERVATION_STATUSES })
      .notNull()
      .default(RESERVATION_STATUS_PENDING),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(CREATED_AT_DEFAULT),
  },
  (table) => [
    // 設計書 §6 のインデックス方針「reservations(shop_id, reserved_at)」。オーナーの予約カレンダー
    index('idx_reservations_shop_reserved').on(table.shopId, table.reservedAt),
    // Phase 7 の空席計算「この時間帯で席を埋めている予約」を引く形
    index('idx_reservations_shop_status_reserved').on(table.shopId, table.status, table.reservedAt),
    // マイページの「予約履歴」。直近が先頭に来るよう降順で定義する
    index('idx_reservations_user_reserved').on(table.userId, sql`${table.reservedAt} desc`),

    check('ck_reservations_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    // 21 人以上の団体は電話で受ける運用にして、席計算の複雑さを持ち込まない
    check(
      'ck_reservations_party_size',
      betweenInclusive(table.partySize, PARTY_SIZE_MIN, PARTY_SIZE_MAX),
    ),
    check('ck_reservations_status', inValues(table.status, RESERVATION_STATUSES)),
    check('ck_reservations_note_length', lengthAtMost(table.note, RESERVATION_NOTE_MAX_LENGTH)),
  ],
);
