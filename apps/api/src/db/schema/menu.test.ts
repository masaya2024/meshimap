import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const SHOP_ID = 'shp_menu';
const OTHER_SHOP_ID = 'shp_menu_other';
/**
 * seat_settings の CHECK 制約を試すためだけの店舗。
 * 存在しない shop_id を使うと FK 違反と CHECK 違反のどちらで落ちたのか区別できず、
 * SQLite がどちらを先に評価するかにテストが依存してしまうため、実在する行を用意する。
 * CHECK で弾かれた INSERT は行を残さないので、この 1 行を複数のテストで使い回せる。
 */
const CHECK_SHOP_ID = 'shp_menu_check';
const CATEGORY_ID = 'mct_ramen';
const OTHER_CATEGORY_ID = 'mct_other_side';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 醤油ラーメンの価格（円）。テストで使う代表値 */
const PRICE_SHOYU_YEN = 900;

type InsertParams = readonly (string | number | null)[];

async function insertItem(values: InsertParams): Promise<void> {
  await local.d1
    .prepare(
      'INSERT INTO menu_items (id, shop_id, category_id, name, price, description, r2_key, is_recommended) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(...values)
    .run();
}

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_menu', 'ラーメン', 'ramen-menu')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_menu', '渋谷', '東京都')
    .run();
  for (const shopId of [SHOP_ID, OTHER_SHOP_ID, CHECK_SHOP_ID]) {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        'メニューテスト店',
        'gnr_menu',
        'area_menu',
        '東京都渋谷区',
        SHIBUYA.lat,
        SHIBUYA.lng,
        SHIBUYA.geohash,
      )
      .run();
  }
  await local.d1
    .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .bind(CATEGORY_ID, SHOP_ID, 'ラーメン', 0)
    .run();
  await local.d1
    .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
    .bind(OTHER_CATEGORY_ID, OTHER_SHOP_ID, 'サイドメニュー', 0)
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe('menu_items と menu_categories の整合', () => {
  it('自分の店のカテゴリにメニューを登録できる', async () => {
    await insertItem([
      'mit_shoyu',
      SHOP_ID,
      CATEGORY_ID,
      '醤油ラーメン',
      PRICE_SHOYU_YEN,
      'あっさり',
      'menu-items/mit_shoyu/a1b2.webp',
      1,
    ]);
  });

  it('カテゴリ未設定（NULL）のメニューを登録できる', async () => {
    // 複合外部キーは片方が NULL なら成立する（SQLite の MATCH SIMPLE 既定）。
    // 「まだ分類していない品」を登録できるのはこの性質のおかげ
    await insertItem(['mit_secret', SHOP_ID, null, '裏メニュー', 1200, null, null, 0]);
  });

  it('他店のカテゴリにメニューをぶら下げられない', async () => {
    await expect(
      insertItem(['mit_ng_cross', SHOP_ID, OTHER_CATEGORY_ID, '混線', 800, null, null, 0]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('存在しないカテゴリは拒否する', async () => {
    await expect(
      insertItem(['mit_ng_missing', SHOP_ID, 'mct_missing', '無い', 800, null, null, 0]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('カテゴリを消すと、そのカテゴリのメニューも消える（未分類の品は残る）', async () => {
    await local.d1.prepare('DELETE FROM menu_categories WHERE id = ?').bind(CATEGORY_ID).run();

    const rows = await local.d1
      .prepare('SELECT id FROM menu_items WHERE shop_id = ? ORDER BY id')
      .bind(SHOP_ID)
      .all<{ id: string }>();

    expect(rows.results.map((row) => row.id)).toEqual(['mit_secret']);
  });
});

describe('menu_items の CHECK 制約', () => {
  it('価格 0 円（サービス品）は受け付ける（境界値）', async () => {
    await local.d1
      .prepare('INSERT INTO menu_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .bind('mct_free', SHOP_ID, '無料', 1)
      .run();
    await insertItem(['mit_water', SHOP_ID, 'mct_free', 'お冷や', 0, null, null, 0]);
  });

  it('価格が負なら拒否する', async () => {
    await expect(
      insertItem(['mit_ng_price', SHOP_ID, 'mct_free', 'マイナス', -1, null, null, 0]),
    ).rejects.toThrow(/CHECK constraint failed: ck_menu_items_price/);
  });

  it('is_recommended を省略すると 0 になる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO menu_items (id, shop_id, category_id, name, price) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('mit_default', SHOP_ID, 'mct_free', '塩ラーメン', PRICE_SHOYU_YEN)
      .run();

    const row = await local.d1
      .prepare('SELECT is_recommended FROM menu_items WHERE id = ?')
      .bind('mit_default')
      .first<{ is_recommended: number }>();

    expect(row?.is_recommended).toBe(0);
  });

  it('R2 キーに大文字が混ざったら拒否する', async () => {
    await expect(
      insertItem([
        'mit_ng_key',
        SHOP_ID,
        'mct_free',
        '写真付き',
        800,
        null,
        'menu-items/X/A.webp',
        0,
      ]),
    ).rejects.toThrow(/CHECK constraint failed: ck_menu_items_r2_key/);
  });

  it('店舗 + おすすめの絞り込みは索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM menu_items WHERE shop_id = 'shp_menu' AND is_recommended = 1",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_menu_items_shop_recommended');
    expect(detail).not.toContain('SCAN menu_items');
  });
});

describe('seat_settings', () => {
  it('1 店舗 1 行しか持てない（shop_id が主キー）', async () => {
    await local.d1
      .prepare(
        'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(SHOP_ID, 20, 90, 2, 1)
      .run();

    await expect(
      local.d1
        .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
        .bind(SHOP_ID, 10)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: seat_settings\.shop_id/);
  });

  it('capacity だけ指定すれば残りは既定値になる', async () => {
    await local.d1
      .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
      .bind(OTHER_SHOP_ID, 10)
      .run();

    const row = await local.d1
      .prepare(
        'SELECT slot_minutes, max_parallel, accepts_reservation FROM seat_settings WHERE shop_id = ?',
      )
      .bind(OTHER_SHOP_ID)
      .first<{ slot_minutes: number; max_parallel: number; accepts_reservation: number }>();

    // 予約は既定で受け付けない。オーナーが明示的に有効化するまで予約導線を出さない
    expect(row?.slot_minutes).toBe(90);
    expect(row?.max_parallel).toBe(1);
    expect(row?.accepts_reservation).toBe(0);
  });

  it('capacity 0 は拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO seat_settings (shop_id, capacity) VALUES (?, ?)')
        .bind(CHECK_SHOP_ID, 0)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_seat_settings_capacity/);
  });

  it('slot_minutes が 15 未満なら拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO seat_settings (shop_id, capacity, slot_minutes) VALUES (?, ?, ?)')
        .bind(CHECK_SHOP_ID, 10, 14)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_seat_settings_slot_minutes/);
  });
});

describe('店舗削除時の連鎖', () => {
  it('店舗を消すとカテゴリ・メニュー・席設定がすべて消える', async () => {
    await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SHOP_ID).run();

    for (const tableName of ['menu_categories', 'menu_items', 'seat_settings'] as const) {
      const row = await local.d1
        .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE shop_id = ?`)
        .bind(SHOP_ID)
        .first<{ remaining: number }>();

      // shops → menu_categories → menu_items と shops → menu_items の 2 経路の CASCADE が
      // 同時に走るが、SQLite はどちらでも問題なく削除する
      expect(row?.remaining).toBe(0);
    }
  });
});
