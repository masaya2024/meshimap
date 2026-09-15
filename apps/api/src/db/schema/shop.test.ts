import { cellsForRadius, coordinate, encodeGeohash, type Geohash } from '@meshimap/geo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHOP_GEOHASH_PRECISION } from '../constants';
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
    // バインド変数でも索引は効く。その実測は
    // 「第 1 段の近傍検索と shops.geohash の契約」の GLOB 系テストにある
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

describe('第 1 段の近傍検索と shops.geohash の契約', () => {
  /** 渋谷駅ちょうどに置いた 1 件。第 1 段の SQL がこれを拾えるかどうかを見る */
  const TARGET_ID = 'shp_geo_contract';
  const CENTER = coordinate(SHIBUYA.lat, SHIBUYA.lng);

  /** 精度 3 が必要になる広域検索まで含めた、設計上サポートする半径 */
  const SUPPORTED_RADII_M = [100, 600, 3000, 19000, 50000] as const;

  /**
   * 先頭の中心セルを取り出す。`cellsForRadius` は必ず 9 セルを返すが、
   * noUncheckedIndexedAccess の下では添字アクセスが `undefined` を含むため明示的に潰す。
   */
  function centerCellOf(cells: readonly Geohash[]): Geohash {
    const [center] = cells;
    if (center === undefined) {
      throw new Error('cellsForRadius が空配列を返した');
    }
    return center;
  }

  /**
   * 第 1 段の SQL を組み立てる。
   * 前方一致を `GLOB` ではなく範囲比較で書くのは、`GLOB ?` の索引利用がバインド値に
   * 依存する（NULL や先頭ワイルドカードで全表走査へ落ちる）ため。
   * 上限に足す `{` は base32 の最大文字 `z`（U+007A）の次の文字。
   */
  function prefixMatchSql(cells: readonly string[]): { sql: string; binds: string[] } {
    const condition = cells.map(() => '(geohash >= ? AND geohash < ?)').join(' OR ');
    return {
      sql: `SELECT id FROM shops WHERE id = ? AND (${condition})`,
      binds: cells.flatMap((cell) => [cell, `${cell}{`]),
    };
  }

  async function findTargetIdsBy(sql: string, binds: readonly string[]): Promise<string[]> {
    const rows = await local.d1
      .prepare(sql)
      .bind(TARGET_ID, ...binds)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  beforeAll(async () => {
    await insertShop({ id: TARGET_ID });
  });

  it('保存する geohash は SHOP_GEOHASH_PRECISION 桁で固定される', async () => {
    const stored = await local.d1
      .prepare('SELECT geohash FROM shops WHERE id = ?')
      .bind(TARGET_ID)
      .first<{ geohash: string }>();

    expect(stored?.geohash).toBe(SHIBUYA.geohash);
    expect(stored?.geohash).toHaveLength(SHOP_GEOHASH_PRECISION);
    expect(encodeGeohash(CENTER, SHOP_GEOHASH_PRECISION)).toBe(SHIBUYA.geohash);
  });

  it.each(SUPPORTED_RADII_M)(
    '半径 %i m のセルは保存 precision 以下なので、保存値の前方一致になれる',
    (radiusM) => {
      const cells = cellsForRadius(CENTER, radiusM);

      // セルが保存値より長いと前方一致の向きが逆転し、第 1 段が成立しなくなる
      for (const cell of cells) {
        expect(cell.length).toBeLessThanOrEqual(SHOP_GEOHASH_PRECISION);
      }
      // 中心セルは必ず保存値の接頭辞
      expect(SHIBUYA.geohash.startsWith(centerCellOf(cells))).toBe(true);
    },
  );

  it.each(SUPPORTED_RADII_M)('半径 %i m の範囲比較は中心の店舗を拾える', async (radiusM) => {
    const cells = cellsForRadius(CENTER, radiusM);
    const { sql, binds } = prefixMatchSql(cells);

    expect(await findTargetIdsBy(sql, binds)).toEqual([TARGET_ID]);
  });

  it('等値比較（IN）にすると半径 100 m 以外は 0 件になる（だから IN を使わない）', async () => {
    // これが「第 1 段は IN で書けばよい」という誤解を潰すための回帰テスト。
    // cellsForRadius は半径に応じて精度 3〜7 のセルを返すのに対し、
    // shops.geohash は精度 7 固定。桁が違えば等値は絶対に一致しない。
    for (const radiusM of SUPPORTED_RADII_M) {
      const cells = cellsForRadius(CENTER, radiusM);
      const placeholders = cells.map(() => '?').join(', ');
      const matched = await findTargetIdsBy(
        `SELECT id FROM shops WHERE id = ? AND geohash IN (${placeholders})`,
        cells,
      );

      // 精度 7 = SHOP_GEOHASH_PRECISION のときだけ、たまたま一致してしまう
      const expected = centerCellOf(cells).length === SHOP_GEOHASH_PRECISION ? [TARGET_ID] : [];
      expect(matched).toEqual(expected);
    }
  });

  it('範囲比較は GLOB のリテラル前方一致と同じ行を返す', async () => {
    const cell = centerCellOf(cellsForRadius(CENTER, 3000));

    const byRange = await findTargetIdsBy(
      'SELECT id FROM shops WHERE id = ? AND geohash >= ? AND geohash < ?',
      [cell, `${cell}{`],
    );
    const byGlob = await local.d1
      // cell は cellsForRadius が返す base32 文字列なので、リテラル埋め込みでも安全
      .prepare(`SELECT id FROM shops WHERE id = ? AND geohash GLOB '${cell}*'`)
      .bind(TARGET_ID)
      .all<{ id: string }>();

    expect(byRange).toEqual([TARGET_ID]);
    expect(byRange).toEqual(byGlob.results.map((row) => row.id));
  });

  it('GLOB はバインド引数でも索引を使う（プランは範囲比較と同じ形になる）', async () => {
    // SQLite の LIKE 最適化は、パターンが実行時に前方一致だと分かれば範囲制約へ書き換える。
    // プランに出る (geohash>? AND geohash<?) がその書き換えの跡。
    // つまり GLOB と範囲比較は速度では選べない
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash GLOB ?')
      .bind('xn76f*')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_geohash');
    expect(detail).toContain('geohash>? AND geohash<?');
  });

  it.each([
    ['NULL', null],
    ['先頭ワイルドカード', '*n76f*'],
  ])('GLOB はバインド値が %s だと索引が効かない（範囲比較を選ぶ理由）', async (_label, pattern) => {
    // 索引を使うかどうかが実行時の値に左右される。ここが範囲比較との唯一の差で、
    // 実装に範囲比較を選ぶ根拠そのもの。将来 SQLite 側が変わってここが落ちたら、
    // GLOB に寄せてよい合図になる
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash GLOB ?')
      .bind(pattern)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('SCAN shops');
  });

  it('範囲比較はバインド値に関係なく索引を使う', async () => {
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash >= ? AND geohash < ?')
      .bind('xn76f', 'xn76f{')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_geohash');
    expect(detail).not.toContain('SCAN shops');
  });
});
