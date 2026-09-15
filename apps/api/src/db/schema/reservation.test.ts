import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const SHOP_ID = 'shp_reserve';
const USER_ID = 'usr_reserve';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 2026-09-16 19:00 JST 相当のエポックミリ秒。テストの基準時刻 */
const RESERVED_AT_MS = 1_789_500_000_000;
/** 1 日のミリ秒 */
const ONE_DAY_MS = 86_400_000;

async function insertReservation(
  id: string,
  partySize: number,
  reservedAtMs = RESERVED_AT_MS,
  status: string | null = null,
): Promise<void> {
  if (status === null) {
    await local.d1
      .prepare(
        'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, SHOP_ID, USER_ID, reservedAtMs, partySize)
      .run();
    return;
  }
  await local.d1
    .prepare(
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, SHOP_ID, USER_ID, reservedAtMs, partySize, status)
    .run();
}

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
    .bind(USER_ID, '予約者', 'reserve@example.com')
    .run();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_reserve', 'ラーメン', 'ramen-reserve')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_reserve', '渋谷', '東京都')
    .run();
  await local.d1
    .prepare(
      'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      SHOP_ID,
      '予約テスト店',
      'gnr_reserve',
      'area_reserve',
      '東京都渋谷区',
      SHIBUYA.lat,
      SHIBUYA.lng,
      SHIBUYA.geohash,
    )
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe('reservations', () => {
  it('予約を保存でき、status は pending から始まる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('rsv_first', SHOP_ID, USER_ID, RESERVED_AT_MS, 2, '窓際希望')
      .run();

    const row = await local.d1
      .prepare('SELECT status, created_at FROM reservations WHERE id = ?')
      .bind('rsv_first')
      .first<{ status: string; created_at: number }>();

    // オーナーが承認するまでは pending。承認前に席は確保しない
    expect(row?.status).toBe('pending');
    expect(row?.created_at).toBeGreaterThan(0);
  });

  it('同じユーザーが同じ店に複数の予約を持てる（日時が違えば別の予約）', async () => {
    await insertReservation('rsv_second', 4, RESERVED_AT_MS + ONE_DAY_MS);
  });

  it('人数 1 と 20 は受け付ける（境界値）', async () => {
    await insertReservation('rsv_min', 1, RESERVED_AT_MS + ONE_DAY_MS * 2);
    await insertReservation('rsv_max', 20, RESERVED_AT_MS + ONE_DAY_MS * 3);
  });

  it('人数 0 は拒否する', async () => {
    await expect(insertReservation('rsv_ng_zero', 0)).rejects.toThrow(
      /CHECK constraint failed: ck_reservations_party_size/,
    );
  });

  it('人数 21 は拒否する（団体は電話で受ける運用）', async () => {
    await expect(insertReservation('rsv_ng_many', 21)).rejects.toThrow(
      /CHECK constraint failed: ck_reservations_party_size/,
    );
  });

  it('定義にない status は拒否する', async () => {
    await expect(insertReservation('rsv_ng_status', 2, RESERVED_AT_MS, 'done')).rejects.toThrow(
      /CHECK constraint failed: ck_reservations_status/,
    );
  });

  it('6 つの status すべてを保存できる', async () => {
    const statuses = [
      'pending',
      'confirmed',
      'rejected',
      'cancelled',
      'completed',
      'no_show',
    ] as const;
    for (const [index, status] of statuses.entries()) {
      await insertReservation(
        `rsv_status_${status}`,
        2,
        RESERVED_AT_MS + ONE_DAY_MS * (10 + index),
        status,
      );
    }

    const row = await local.d1
      .prepare("SELECT count(*) AS stored FROM reservations WHERE id LIKE 'rsv_status_%'")
      .first<{ stored: number }>();

    expect(row?.stored).toBe(statuses.length);
  });

  it('店舗の予約カレンダー（日時範囲）は索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM reservations WHERE shop_id = '${SHOP_ID}' AND reserved_at BETWEEN ${String(RESERVED_AT_MS)} AND ${String(RESERVED_AT_MS + ONE_DAY_MS)}`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    // 設計書 §6 のインデックス方針「reservations(shop_id, reserved_at)」
    expect(detail).toContain('idx_reservations_shop_reserved');
    expect(detail).not.toContain('SCAN reservations');
  });

  it('確定済みだけを日時範囲で引く場合も索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM reservations WHERE shop_id = '${SHOP_ID}' AND status = 'confirmed' AND reserved_at BETWEEN ${String(RESERVED_AT_MS)} AND ${String(RESERVED_AT_MS + ONE_DAY_MS)}`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    // Phase 7 の空席計算はこの形。席を埋めている予約だけを数える
    expect(detail).toContain('idx_reservations_shop_status_reserved');
    expect(detail).not.toContain('SCAN reservations');
  });

  it('店舗を消すと予約も消える', async () => {
    await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

    const row = await local.d1
      .prepare('SELECT count(*) AS remaining FROM reservations WHERE shop_id = ?')
      .bind(SHOP_ID)
      .first<{ remaining: number }>();

    expect(row?.remaining).toBe(0);
  });
});
