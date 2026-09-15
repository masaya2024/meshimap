import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const USER_ID = 'usr_collector';
const OTHER_USER_ID = 'usr_collector_other';
const SHOP_ID = 'shp_collect';
const OTHER_SHOP_ID = 'shp_collect_other';
const LIST_ID = 'lst_wishlist';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 32 文字の共有トークン。URL に載せるので小文字英数字のみ */
const VALID_SHARE_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

beforeAll(async () => {
  local = await createMigratedD1();
  for (const [userId, email] of [
    [USER_ID, 'collector@example.com'],
    [OTHER_USER_ID, 'collector2@example.com'],
  ] as const) {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind(userId, 'コレクター', email)
      .run();
  }
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_collect', 'ラーメン', 'ramen-collect')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_collect', '渋谷', '東京都')
    .run();
  for (const shopId of [SHOP_ID, OTHER_SHOP_ID]) {
    await local.d1
      .prepare(
        'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        shopId,
        'コレクションテスト店',
        'gnr_collect',
        'area_collect',
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

describe('favorites', () => {
  it('お気に入りに登録でき、created_at が自動で入る', async () => {
    await local.d1
      .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
      .bind(USER_ID, SHOP_ID)
      .run();

    const row = await local.d1
      .prepare('SELECT created_at FROM favorites WHERE user_id = ? AND shop_id = ?')
      .bind(USER_ID, SHOP_ID)
      .first<{ created_at: number }>();

    expect(row?.created_at).toBeGreaterThan(0);
  });

  it('同じユーザーが同じ店を二重登録できない（複合主キー）', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
        .bind(USER_ID, SHOP_ID)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: favorites\.user_id, favorites\.shop_id/);
  });

  it('別の店なら登録できる', async () => {
    await local.d1
      .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
      .bind(USER_ID, OTHER_SHOP_ID)
      .run();
  });

  it('別のユーザーなら同じ店を登録できる', async () => {
    await local.d1
      .prepare('INSERT INTO favorites (user_id, shop_id) VALUES (?, ?)')
      .bind(OTHER_USER_ID, SHOP_ID)
      .run();
  });

  it('お気に入り一覧（新着順）は索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM favorites WHERE user_id = '${USER_ID}' ORDER BY created_at DESC`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_favorites_user_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });
});

describe('lists', () => {
  it('非公開リストは share_token が NULL でよい', async () => {
    await local.d1
      .prepare('INSERT INTO lists (id, user_id, name, description) VALUES (?, ?, ?, ?)')
      .bind(LIST_ID, USER_ID, '行きたい店', '週末に回る候補')
      .run();

    const row = await local.d1
      .prepare('SELECT is_public, share_token FROM lists WHERE id = ?')
      .bind(LIST_ID)
      .first<{ is_public: number; share_token: string | null }>();

    // 既定は非公開。共有したくなったら token を発行する
    expect(row?.is_public).toBe(0);
    expect(row?.share_token).toBeNull();
  });

  it('share_token が NULL のリストは何件でも作れる（SQLite のユニーク索引は NULL を重複とみなさない）', async () => {
    await local.d1
      .prepare('INSERT INTO lists (id, user_id, name) VALUES (?, ?, ?)')
      .bind('lst_second', USER_ID, 'デート候補')
      .run();
  });

  it('共有トークン付きの公開リストを作れる', async () => {
    await local.d1
      .prepare(
        'INSERT INTO lists (id, user_id, name, is_public, share_token) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('lst_public', USER_ID, '公開リスト', 1, VALID_SHARE_TOKEN)
      .run();
  });

  it('同じ共有トークンを 2 つのリストで使えない', async () => {
    await expect(
      local.d1
        .prepare(
          'INSERT INTO lists (id, user_id, name, is_public, share_token) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('lst_dup', OTHER_USER_ID, '重複', 1, VALID_SHARE_TOKEN)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: lists\.share_token/);
  });

  it('共有トークンが 32 文字でなければ拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO lists (id, user_id, name, share_token) VALUES (?, ?, ?, ?)')
        .bind('lst_short', OTHER_USER_ID, '短い', VALID_SHARE_TOKEN.slice(0, -1))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_lists_share_token_length/);
  });

  it('共有トークンに大文字が混ざったら拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO lists (id, user_id, name, share_token) VALUES (?, ?, ?, ?)')
        .bind('lst_upper', OTHER_USER_ID, '大文字', VALID_SHARE_TOKEN.toUpperCase())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_lists_share_token_alphabet/);
  });
});

describe('list_items', () => {
  it('リストに店を追加できる', async () => {
    await local.d1
      .prepare('INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)')
      .bind(LIST_ID, SHOP_ID, '昼に行く', 0)
      .run();
  });

  it('同じリストに同じ店を二重追加できない（複合主キー）', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)')
        .bind(LIST_ID, SHOP_ID, '重複', 1)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: list_items\.list_id, list_items\.shop_id/);
  });

  it('sort_order が負なら拒否する', async () => {
    await expect(
      local.d1
        .prepare('INSERT INTO list_items (list_id, shop_id, note, sort_order) VALUES (?, ?, ?, ?)')
        .bind(LIST_ID, OTHER_SHOP_ID, null, -1)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: ck_list_items_sort_order/);
  });

  it('リスト内の並び順は索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM list_items WHERE list_id = '${LIST_ID}' ORDER BY sort_order`,
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_list_items_list_sort');
  });
});

describe('削除の連鎖', () => {
  it('リストを消すとリスト項目も消える', async () => {
    await local.d1.prepare('DELETE FROM lists WHERE id = ?').bind(LIST_ID).run();

    const row = await local.d1
      .prepare('SELECT count(*) AS remaining FROM list_items WHERE list_id = ?')
      .bind(LIST_ID)
      .first<{ remaining: number }>();

    expect(row?.remaining).toBe(0);
  });

  it('ユーザーを消すとお気に入りとリストも消える', async () => {
    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind(USER_ID).run();

    for (const tableName of ['favorites', 'lists'] as const) {
      const row = await local.d1
        .prepare(`SELECT count(*) AS remaining FROM ${tableName} WHERE user_id = ?`)
        .bind(USER_ID)
        .first<{ remaining: number }>();

      expect(row?.remaining).toBe(0);
    }
  });
});
