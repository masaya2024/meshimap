import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';

let local: LocalD1;

const OWNER_ID = 'usr_shop_owner';
const GENRE_ID = 'gnr_ramen';
const AREA_ID = 'area_shibuya';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** 緯度の境界値と、同じ経度で算出した geohash（同じく encodeGeohash の実測値） */
const LATITUDE_MAX_GEOHASH = 'zpgrfzz';
const LATITUDE_MIN_GEOHASH = 'p0524bp';

type ShopOverrides = Readonly<Record<string, string | number | null>>;

/** 正常な shops 行をベースに、一部だけ差し替えて INSERT する */
async function insertShop(overrides: ShopOverrides): Promise<void> {
  const row: Record<string, string | number | null> = {
    id: 'shp_base',
    owner_id: OWNER_ID,
    name: '渋谷らーめん',
    genre_id: GENRE_ID,
    area_id: AREA_ID,
    address: '東京都渋谷区道玄坂1-1-1',
    lat: SHIBUYA.lat,
    lng: SHIBUYA.lng,
    geohash: SHIBUYA.geohash,
    postal_code: '150-0043',
    ...overrides,
  };
  const columnNames = Object.keys(row);
  const placeholders = columnNames.map(() => '?').join(', ');
  await local.d1
    .prepare(`INSERT INTO shops (${columnNames.join(', ')}) VALUES (${placeholders})`)
    .bind(...Object.values(row))
    .run();
}

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
    .bind(OWNER_ID, 'オーナー', 'shopowner@example.com')
    .run();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind(GENRE_ID, 'ラーメン', 'ramen')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind(AREA_ID, '渋谷', '東京都')
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe('shops の既定値', () => {
  it('status / rating_avg / rating_count / view_count は省略できる', async () => {
    await insertShop({ id: 'shp_default' });

    const row = await local.d1
      .prepare('SELECT status, rating_avg, rating_count, view_count FROM shops WHERE id = ?')
      .bind('shp_default')
      .first<{
        status: string;
        rating_avg: number;
        rating_count: number;
        view_count: number;
      }>();

    // 新規作成直後は下書き。オーナーが公開申請するまで検索に出さない
    expect(row?.status).toBe('draft');
    expect(row?.rating_avg).toBe(0);
    expect(row?.rating_count).toBe(0);
    expect(row?.view_count).toBe(0);
  });
});

describe('shops の外部キー', () => {
  it('存在しない genre_id は拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_genre', genre_id: 'gnr_missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('存在しない area_id は拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_area', area_id: 'area_missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('使われているジャンルは削除できない（ON DELETE restrict）', async () => {
    await insertShop({ id: 'shp_genre_lock' });
    await expect(
      local.d1.prepare('DELETE FROM genres WHERE id = ?').bind(GENRE_ID).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('owner_id は NULL を許す（申請前・オーナー付け替え中の店舗があるため）', async () => {
    await insertShop({ id: 'shp_no_owner', owner_id: null });

    const row = await local.d1
      .prepare('SELECT owner_id FROM shops WHERE id = ?')
      .bind('shp_no_owner')
      .first<{ owner_id: string | null }>();

    expect(row?.owner_id).toBeNull();
  });

  it('オーナーを削除しても店舗は残り、owner_id だけ NULL になる', async () => {
    await local.d1
      .prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 0)')
      .bind('usr_temp_owner', '一時', 'tempowner@example.com')
      .run();
    await insertShop({ id: 'shp_orphaned', owner_id: 'usr_temp_owner' });

    await local.d1.prepare('DELETE FROM user WHERE id = ?').bind('usr_temp_owner').run();

    const row = await local.d1
      .prepare('SELECT owner_id FROM shops WHERE id = ?')
      .bind('shp_orphaned')
      .first<{ owner_id: string | null }>();

    // 店舗ごと消すとレビューや予約の履歴まで失われる。オーナーだけ外して管理者が付け替える
    expect(row).not.toBeNull();
    expect(row?.owner_id).toBeNull();
  });
});

describe('shops の CHECK 制約', () => {
  it('定義にない status は拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_status', status: 'open' })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_status/,
    );
  });

  it('緯度が 90 を超えたら拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_lat', lat: 90.000001 })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_lat/,
    );
  });

  it('緯度ちょうど 90 / -90 は受け付ける（境界値）', async () => {
    await insertShop({ id: 'shp_lat_max', lat: 90, geohash: LATITUDE_MAX_GEOHASH });
    await insertShop({ id: 'shp_lat_min', lat: -90, geohash: LATITUDE_MIN_GEOHASH });
  });

  it('経度が -180 を下回ったら拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_lng', lng: -180.000001 })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_lng/,
    );
  });

  it('geohash の長さが precision 7 でなければ拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_gh6', geohash: 'xn76fg' })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_geohash_length/,
    );
    await expect(insertShop({ id: 'shp_ng_gh8', geohash: 'xn76fgrb' })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_geohash_length/,
    );
  });

  it('geohash に base32 外の文字（a / i / l / o）があれば拒否する', async () => {
    for (const [index, invalidGeohash] of ['xn76fga', 'xn76fgi', 'xn76fgl', 'xn76fgo'].entries()) {
      await expect(
        insertShop({ id: `shp_ng_alpha_${String(index)}`, geohash: invalidGeohash }),
      ).rejects.toThrow(/CHECK constraint failed: ck_shops_geohash_alphabet/);
    }
  });

  it('郵便番号は NNN-NNNN 形式でなければ拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_zip', postal_code: '1500043' })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_postal_code_format/,
    );
  });

  it('郵便番号は NULL を許す（未入力の下書きがあるため）', async () => {
    await insertShop({ id: 'shp_no_zip', postal_code: null });
  });

  it('予算の min が max を上回ったら拒否する', async () => {
    await expect(
      insertShop({ id: 'shp_ng_budget', budget_lunch_min: 3000, budget_lunch_max: 1000 }),
    ).rejects.toThrow(/CHECK constraint failed: ck_shops_budget_lunch_order/);
  });

  it('予算は片側だけの指定を許す（「1000 円〜」の表示に使う）', async () => {
    await insertShop({ id: 'shp_budget_min_only', budget_lunch_min: 1000 });
    await insertShop({ id: 'shp_budget_max_only', budget_dinner_max: 8000 });
  });

  it('予算が上限（100 万円）を超えたら拒否する', async () => {
    await expect(
      insertShop({ id: 'shp_ng_budget_max', budget_dinner_max: 1_000_001 }),
    ).rejects.toThrow(/CHECK constraint failed: ck_shops_budget_dinner_range/);
  });

  it('rating_avg が 5 を超えたら拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_rating', rating_avg: 5.1 })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_rating_avg/,
    );
  });

  it('rating_count が負なら拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_count', rating_count: -1 })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_rating_count/,
    );
  });

  it('店名が 100 文字を超えたら拒否する', async () => {
    await expect(insertShop({ id: 'shp_ng_name', name: 'あ'.repeat(101) })).rejects.toThrow(
      /CHECK constraint failed: ck_shops_name_length/,
    );
  });

  it('店名ちょうど 100 文字は受け付ける（境界値）', async () => {
    await insertShop({ id: 'shp_name_100', name: 'あ'.repeat(100) });
  });
});

describe('shops の索引', () => {
  it('設計書 §6 のインデックス方針どおりの索引が張られている', async () => {
    const rows = await local.d1
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shops'")
      .all<{ name: string }>();
    const indexNames = rows.results.map((row) => row.name);

    expect(indexNames).toContain('idx_shops_geohash');
    expect(indexNames).toContain('idx_shops_status_geohash');
    expect(indexNames).toContain('idx_shops_lat_lng');
    expect(indexNames).toContain('idx_shops_genre_status');
    expect(indexNames).toContain('idx_shops_area_status');
    expect(indexNames).toContain('idx_shops_owner_id');
  });

  it('geohash の前方一致は GLOB なら索引を使う', async () => {
    const plan = await local.d1
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash GLOB 'xn76f*'")
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_geohash');
    expect(detail).not.toContain('SCAN shops');
  });

  it('geohash の前方一致に LIKE を使うと索引が効かない（GLOB を使う根拠）', async () => {
    const plan = await local.d1
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash LIKE 'xn76f%'")
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    // SQLite の LIKE 最適化は case_sensitive_like が OFF（既定）だと働かない。
    // この事実が変わったら 3 段構えの前提を見直す必要があるため、回帰テストとして固定する
    expect(detail).toContain('SCAN shops');
  });

  it('status + geohash の複合条件は複合索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = 'published' AND geohash GLOB 'xn76f*'",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_status_geohash');
    expect(detail).not.toContain('SCAN shops');
  });

  it('境界ボックスの範囲比較は lat/lng の索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM shops WHERE lat BETWEEN 35.6 AND 35.7 AND lng BETWEEN 139.6 AND 139.8',
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_lat_lng');
    expect(detail).not.toContain('SCAN shops');
  });

  it('ジャンル + 公開状態の絞り込みは複合索引を使う', async () => {
    const plan = await local.d1
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM shops WHERE genre_id = 'gnr_ramen' AND status = 'published'",
      )
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_genre_status');
  });
});
