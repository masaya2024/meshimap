import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const SHOP_ID = 'shp_detail';
const OTHER_SHOP_ID = 'shp_detail_other';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 曜日番号。0 = 日曜（設計書 §6 の day_of_week は 0-6） */
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

/** 分単位の時刻。11:00 = 660、14:00 = 840、18:00 = 1080、25:30 = 1530 */
const MINUTE_11_00 = 660;
const MINUTE_14_00 = 840;
const MINUTE_18_00 = 1080;
const MINUTE_25_30 = 1530;

/** 翌 47:59。日跨ぎ営業として表現できる上限（constants.ts の MINUTE_OF_DAY_MAX） */
const MINUTE_47_59 = 2879;
/** 上限を 1 分だけ超えた値 */
const MINUTE_OVER_MAX = 2880;

type InsertParams = readonly (string | number | null)[];

async function insertHours(values: InsertParams): Promise<void> {
  await local.d1
    .prepare(
      'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(...values)
    .run();
}

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_detail', 'ラーメン', 'ramen-detail')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_detail', '渋谷', '東京都')
    .run();
  for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        '詳細テスト店',
        'gnr_detail',
        'area_detail',
        '東京都渋谷区',
        SHIBUYA.lat,
        SHIBUYA.lng,
        SHIBUYA.geohash,
      )
      .run();
  }
});

afterAll(async () => {
  await local.dispose();
});

describe('shop_hours', () => {
  it('通常の営業時間を保存できる', async () => {
    await insertHours(['sh_normal', SHOP_ID, MONDAY, MINUTE_11_00, MINUTE_14_00, 0]);
  });

  it('日跨ぎ営業（18:00-25:30）を close_minute > 1440 で表せる', async () => {
    // 文字列の "25:30" ではなく分の整数で持つので、比較もソートも SQL でそのまま書ける
    await insertHours(['sh_overnight', SHOP_ID, MONDAY, MINUTE_18_00, MINUTE_25_30, 0]);
  });

  it('同じ曜日に複数行を置ける（中休みのある店の昼営業・夜営業）', async () => {
    const row = await local.d1
      .prepare(
        'SELECT count(*) AS slot_count FROM shop_hours WHERE shop_id = ? AND day_of_week = ?',
      )
      .bind(SHOP_ID, MONDAY)
      .first<{ slot_count: number }>();

    expect(row?.slot_count).toBe(2);
  });

  it('定休日は is_closed = 1 かつ時刻 NULL で保存する', async () => {
    await insertHours(['sh_closed', SHOP_ID, TUESDAY, null, null, 1]);
  });

  it('定休日なのに時刻が入っていたら拒否する', async () => {
    await expect(
      insertHours(['sh_ng_closed', SHOP_ID, WEDNESDAY, MINUTE_11_00, MINUTE_14_00, 1]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_closed_coherence/);
  });

  it('営業日なのに時刻が NULL なら拒否する', async () => {
    await expect(insertHours(['sh_ng_open', SHOP_ID, WEDNESDAY, null, null, 0])).rejects.toThrow(
      /CHECK constraint failed: ck_shop_hours_closed_coherence/,
    );
  });

  it('曜日が 7 なら拒否する', async () => {
    await expect(
      insertHours(['sh_ng_dow', SHOP_ID, 7, MINUTE_11_00, MINUTE_14_00, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_day_of_week/);
  });

  it('曜日 0（日曜）は受け付ける（境界値）', async () => {
    await insertHours(['sh_sunday', SHOP_ID, 0, MINUTE_11_00, MINUTE_14_00, 0]);
  });

  it('close_minute 2879（翌 47:59）は受け付ける（境界値）', async () => {
    await insertHours(['sh_late_max', SHOP_ID, THURSDAY, MINUTE_18_00, MINUTE_47_59, 0]);
  });

  it('close_minute 2880 は拒否する（2 日分を超える営業は表現しない）', async () => {
    await expect(
      insertHours(['sh_ng_late', SHOP_ID, THURSDAY, MINUTE_18_00, MINUTE_OVER_MAX, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_close_minute/);
  });

  it('開店時刻が閉店時刻以上なら拒否する', async () => {
    await expect(
      insertHours(['sh_ng_order', SHOP_ID, FRIDAY, MINUTE_14_00, MINUTE_11_00, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_hours_open_before_close/);
  });

  it('is_closed に 0 / 1 以外を入れたら拒否する', async () => {
    await expect(insertHours(['sh_ng_bool', SHOP_ID, FRIDAY, null, null, 2])).rejects.toThrow(
      /CHECK constraint failed: ck_shop_hours_is_closed/,
    );
  });

  it('is_closed を省略すると営業日（0）になる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('sh_default', SHOP_ID, SATURDAY, MINUTE_11_00, MINUTE_14_00)
      .run();

    const row = await local.d1
      .prepare('SELECT is_closed FROM shop_hours WHERE id = ?')
      .bind('sh_default')
      .first<{ is_closed: number }>();

    expect(row?.is_closed).toBe(0);
  });

  it('店舗 + 曜日の絞り込みは索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM shop_hours WHERE shop_id = 'shp_detail' AND day_of_week = 1",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shop_hours_shop_day');
    expect(detail).not.toContain('SCAN shop_hours');
  });
});

describe('shop_closures', () => {
  it('臨時休業日を保存できる', async () => {
    await local.d1
      .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
      .bind('cls_newyear', SHOP_ID, '2026-01-01', '元日')
      .run();
  });

  it('同じ店の同じ日を二重に登録できない', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
        .bind('cls_dup', SHOP_ID, '2026-01-01', '重複')
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: shop_closures\.shop_id, shop_closures\.date/);
  });

  it('別の店なら同じ日を登録できる', async () => {
    await local.d1
      .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
      .bind('cls_other', OTHER_SHOP_ID, '2026-01-01', '元日')
      .run();
  });

  it('日付が YYYY-MM-DD 形式でなければ拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
        .bind('cls_ng', SHOP_ID, '20260101', null)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_closures_date_format/);
  });

  it('理由なしの休業日を登録できる', async () => {
    await local.d1
      .prepare('INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)')
      .bind('cls_no_reason', SHOP_ID, '2026-01-02', null)
      .run();
  });
});

describe('shop_photos', () => {
  async function insertPhoto(values: InsertParams): Promise<void> {
    await local.d1
      .prepare(
        'INSERT INTO shop_photos (id, shop_id, r2_key, caption, sort_order, is_cover) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(...values)
      .run();
  }

  it('カバー写真と通常写真を保存できる', async () => {
    await insertPhoto(['pht_cover', SHOP_ID, 'shop-photos/shp_detail/a1b2.webp', '外観', 0, 1]);
    await insertPhoto(['pht_second', SHOP_ID, 'shop-photos/shp_detail/c3d4.webp', '内観', 1, 0]);
    await insertPhoto(['pht_third', SHOP_ID, 'shop-photos/shp_detail/e5f6.webp', null, 2, 0]);
  });

  it('1 店舗にカバー写真は 1 枚しか置けない（部分ユニーク索引）', async () => {
    await expect(
      insertPhoto(['pht_ng_cover', SHOP_ID, 'shop-photos/shp_detail/g7h8.webp', null, 3, 1]),
    ).rejects.toThrow(/UNIQUE constraint failed: shop_photos\.shop_id/);
  });

  it('別の店ならカバー写真を持てる（部分索引が店舗単位で効いている）', async () => {
    await insertPhoto([
      'pht_other_cover',
      OTHER_SHOP_ID,
      'shop-photos/shp_other/i9j0.webp',
      null,
      0,
      1,
    ]);
  });

  it('同じ R2 キーを 2 行で使えない', async () => {
    await expect(
      insertPhoto(['pht_dup_key', OTHER_SHOP_ID, 'shop-photos/shp_detail/a1b2.webp', null, 1, 0]),
    ).rejects.toThrow(/UNIQUE constraint failed: shop_photos\.r2_key/);
  });

  it('R2 キーに大文字が混ざったら拒否する', async () => {
    await expect(
      insertPhoto(['pht_ng_upper', OTHER_SHOP_ID, 'shop-photos/shp_other/ABC.webp', null, 2, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_r2_key/);
  });

  it('R2 キーに空白が混ざったら拒否する', async () => {
    await expect(
      insertPhoto(['pht_ng_space', OTHER_SHOP_ID, 'shop-photos/shp_other/a b.webp', null, 3, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_r2_key/);
  });

  it('sort_order が負なら拒否する', async () => {
    await expect(
      insertPhoto(['pht_ng_sort', OTHER_SHOP_ID, 'shop-photos/shp_other/k1l2.webp', null, -1, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_shop_photos_sort_order/);
  });

  it('存在しない shop_id は拒否する', async () => {
    await expect(
      insertPhoto(['pht_ng_shop', 'shp_missing', 'shop-photos/missing/m3n4.webp', null, 0, 0]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('店舗削除時の連鎖', () => {
  it('店舗を消すと営業時間・休業日・写真もまとめて消える', async () => {
    await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

    for (const tableName of ['shop_hours', 'shop_closures', 'shop_photos'] as const) {
      const row = await local.d1
        .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE shop_id = ?`)
        .bind(SHOP_ID)
        .first<{ remaining: number }>();

      // 店舗の付属データは単独では意味を持たないため CASCADE。孤児行を残さない
      expect(row?.remaining).toBe(0);
    }
  });
});
