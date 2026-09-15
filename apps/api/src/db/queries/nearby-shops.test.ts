import { and, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  boundingBox,
  cellsForRadius,
  coordinate,
  distanceMeters,
  isWithinBounds,
} from '@meshimap/geo';
import { createDatabase, type Database } from '../client';
import { shops } from '../schema/shop';
import { applySeed, createMigratedD1, type LocalD1 } from '../testing/local-d1';
import { findNearbyShops, geohashPrefixCondition } from './nearby-shops';

/**
 * 段 2・段 3 の入口になる 2 関数を vi.fn で包み、呼ばれた回数だけを記録する。
 * importOriginal で本物の実装をそのまま渡しているので、返る値は一切変わらない。
 *
 * なぜ出力ではなく回数を見るのか:
 * 段 2 の矩形は円に **外接** するため、半径内の店は必ず矩形の内側にいる。
 * つまり段 2 を丸ごと消しても findNearbyShops の返り値は 1 件も変わらない。
 * 段 1 の geohash 前方一致も同じで、消せば SQL は公開中の全店を返すが、
 * 段 2・段 3 が正しく絞るので最終出力はやはり変わらない。
 * この 2 つの段の存在理由は返り値ではなく「Haversine を呼ぶ回数を減らすこと」
 * そのものなので、出力を見るテストでは原理的に消えたことを検知できない。
 * だから「段の効き目 = 次の段に渡る件数」を呼び出し回数として直接縛る。
 */
vi.mock('@meshimap/geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meshimap/geo')>();

  return {
    ...actual,
    isWithinBounds: vi.fn(actual.isWithinBounds),
    distanceMeters: vi.fn(actual.distanceMeters),
  };
});

let local: LocalD1;
let db: Database;

/** 渋谷駅の座標。シードの shp_001 がちょうどこの位置にいる */
const SHIBUYA_STATION = coordinate(35.658034, 139.701636);

/** 件数を数えるだけのテストで使う、実質無制限の上限 */
const NO_LIMIT = 1000;

beforeAll(async () => {
  local = await createMigratedD1();
  await applySeed(local.d1);
  db = createDatabase(local.d1);
}, 120_000);

afterAll(async () => {
  await local.dispose();
});

/** 段 1 だけを実行して候補件数を返す */
async function countStage1(radiusM: number): Promise<number> {
  const cells = cellsForRadius(SHIBUYA_STATION, radiusM);
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(
      and(eq(shops.status, 'published'), or(...cells.map((cell) => geohashPrefixCondition(cell)))),
    );

  return rows.length;
}

/** 段 1 → 段 2 まで実行して候補件数を返す */
async function countStage2(radiusM: number): Promise<number> {
  const cells = cellsForRadius(SHIBUYA_STATION, radiusM);
  const bounds = boundingBox(SHIBUYA_STATION, radiusM);
  const rows = await db
    .select({ id: shops.id, latitude: shops.lat, longitude: shops.lng })
    .from(shops)
    .where(
      and(eq(shops.status, 'published'), or(...cells.map((cell) => geohashPrefixCondition(cell)))),
    );

  return rows.filter((row) => isWithinBounds(coordinate(row.latitude, row.longitude), bounds))
    .length;
}

async function countStage3(radiusM: number): Promise<number> {
  const rows = await findNearbyShops(db, {
    center: SHIBUYA_STATION,
    radiusM,
    limit: NO_LIMIT,
    genreId: null,
  });

  return rows.length;
}

/** 半径を無視した公開中の全店舗数。段 1 が本当に絞れているかの比較対象 */
async function countPublishedShops(): Promise<number> {
  const rows = await db.select({ id: shops.id }).from(shops).where(eq(shops.status, 'published'));

  return rows.length;
}

describe('3 段階の絞り込み（渋谷駅起点・60 店舗）', () => {
  // 半径 → [セル数, 段 1, 段 2, 段 3]
  //
  // 期待値は seeds/seed.sql を直接パースし、@meshimap/geo の
  // cellsForRadius / boundingBox / isWithinBounds / distanceMeters を使って
  // 全 60 店舗を総当たりした実測値。findNearbyShops の出力は参照していない。
  // 計画（docs/superpowers/plans/2026-09-15-phase-3-database.md）の表と全項目一致した。
  const EXPECTATIONS: readonly (readonly [number, number, number, number, number])[] = [
    [200, 9, 5, 5, 5],
    [500, 9, 5, 5, 5],
    [1000, 9, 35, 5, 5],
    [2000, 9, 35, 15, 15],
    [3000, 9, 35, 20, 20],
    [5000, 9, 60, 28, 25],
  ];

  for (const [radiusM, cellCount, stage1, stage2, stage3] of EXPECTATIONS) {
    it(`半径 ${String(radiusM)}m: セル ${String(cellCount)} 個 → ${String(stage1)} → ${String(stage2)} → ${String(stage3)} 件`, async () => {
      expect(cellsForRadius(SHIBUYA_STATION, radiusM)).toHaveLength(cellCount);
      expect(await countStage1(radiusM)).toBe(stage1);
      expect(await countStage2(radiusM)).toBe(stage2);
      expect(await countStage3(radiusM)).toBe(stage3);
    });
  }

  it('半径 5000m では矩形と厳密判定で件数が変わる（Haversine が効いている）', async () => {
    // 28 → 25。矩形の四隅にいる 3 店が円の外に落ちる。
    // ここが同じ数になったら、段 3 が素通しになっている疑いがある
    expect(await countStage2(5000)).toBe(28);
    expect(await countStage3(5000)).toBe(25);
  });

  it('半径 1000m は段 1 で 35 件まで広がるが段 2 で 5 件に落ちる', async () => {
    // 精度 5 のセルは約 4.9km 四方なので、隣接 9 セルは半径 1km より遥かに広い。
    // 「geohash だけでは絞り切れない」ことを数字で示すケース
    expect(await countStage1(1000)).toBe(35);
    expect(await countStage2(1000)).toBe(5);
  });

  it('半径 190m は段 2 で 5 件残るが段 3 で 1 件に落ちる', async () => {
    // 渋谷の 5 店は shp_001（0m）と 190.18m の 4 店から成る。
    // 190m の矩形は 190.18m の 4 店を通してしまい、Haversine だけが落とせる。
    // 半径 5000m のケースより「段 3 でしか落ちない」ことがはっきり出る
    expect(await countStage2(190)).toBe(5);
    expect(await countStage3(190)).toBe(1);
  });
});

describe('段 1・段 2 の枝刈り（出力ではなく呼び出し回数で確かめる）', () => {
  /**
   * 段 1 と段 2 の両方が「本当に候補を減らす」半径。
   *
   * 1000m は 公開中の全店 → 段 1 → 段 2 が 60 → 35 → 5 と 2 段とも落ちる。
   * 5000m だと段 1 が 60 件（= 公開中の全店）になり、
   * 段 1 の前方一致を消しても回数が変わらず変異を見逃す。
   * 200m / 500m は段 1 と段 2 がどちらも 5 件で並ぶので同じ理由で使えない
   */
  const PRUNING_RADIUS_M = 1000;

  /** 呼び出し回数を数えるテストで毎回渡す検索条件 */
  const PRUNING_SEARCH = {
    center: SHIBUYA_STATION,
    radiusM: PRUNING_RADIUS_M,
    limit: NO_LIMIT,
    genreId: null,
  } as const;

  it('この半径では段 1 も段 2 も実際に候補を減らしている（回数テストの前提）', async () => {
    const publishedCount = await countPublishedShops();
    const stage1Count = await countStage1(PRUNING_RADIUS_M);
    const stage2Count = await countStage2(PRUNING_RADIUS_M);

    // どちらかの不等号が崩れると、下の 2 件は「枝刈りを消しても同じ回数」になり
    // テストとして意味を失う。シードが変わったときにまずここが落ちて気づける
    expect(stage1Count).toBeLessThan(publishedCount);
    expect(stage2Count).toBeLessThan(stage1Count);
  });

  it('isWithinBounds の呼び出し回数は段 1 が返した候補数と一致する', async () => {
    // 期待値は実装の返り値ではなく、seeds を総当たりする countStage1 から導く
    const stage1Count = await countStage1(PRUNING_RADIUS_M);

    // countStage1 / 前の describe の findNearbyShops がすでに geo を呼んでいる。
    // 計測したいのは「この 1 回の findNearbyShops」だけなので直前に必ず消す
    vi.mocked(isWithinBounds).mockClear();

    await findNearbyShops(db, PRUNING_SEARCH);

    // 段 1 の geohash 前方一致が消えると候補が公開中の全店まで膨らみ、回数が増える
    expect(vi.mocked(isWithinBounds)).toHaveBeenCalledTimes(stage1Count);
  });

  it('distanceMeters の呼び出し回数は段 2 を通過した件数と一致する', async () => {
    // 期待値は実装の返り値ではなく、矩形を実装と独立に当てる countStage2 から導く
    const stage2Count = await countStage2(PRUNING_RADIUS_M);

    // countStage2 は isWithinBounds を呼ぶだけだが、
    // distanceMeters には前の describe の呼び出しが溜まっているので同様に消す
    vi.mocked(distanceMeters).mockClear();

    await findNearbyShops(db, PRUNING_SEARCH);

    // 段 2 の矩形フィルタが消えると段 1 の候補数ぶん呼ばれてしまい、回数が増える
    expect(vi.mocked(distanceMeters)).toHaveBeenCalledTimes(stage2Count);
  });
});

describe('findNearbyShops の返し方', () => {
  it('距離の昇順で返る', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 5000,
      limit: NO_LIMIT,
      genreId: null,
    });

    const distances = rows.map((row) => row.distanceM);

    expect(distances).toEqual([...distances].sort((left, right) => left - right));
  });

  it('渋谷駅直上の店が先頭で、距離は 0m', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 200,
      limit: NO_LIMIT,
      genreId: null,
    });

    expect(rows[0]?.id).toBe('shp_001');
    expect(rows[0]?.distanceM).toBe(0);
  });

  it('半径 200m の 5 件が距離の昇順で並ぶ', async () => {
    // 総当たりで求めた距離（m）:
    //   shp_001 = 0
    //   shp_002 = 190.18482375249062
    //   shp_004 = 190.18482375432035
    //   shp_003 = 190.18627483588895
    //   shp_005 = 190.18627483771871
    // 「190m の 4 店」は同距離に見えるが、経度差の浮動小数点表現が
    // 東西で非対称なため実際には 4 店とも異なる値になる
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 200,
      limit: NO_LIMIT,
      genreId: null,
    });

    expect(rows.map((row) => row.id)).toEqual([
      'shp_001',
      'shp_002',
      'shp_004',
      'shp_003',
      'shp_005',
    ]);
  });

  it('limit で件数を切る（切ったあとも近い順のまま）', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 5000,
      limit: 3,
      genreId: null,
    });

    expect(rows.map((row) => row.id)).toEqual(['shp_001', 'shp_002', 'shp_004']);
  });

  it('ジャンルで絞り込める', async () => {
    const ramen = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 5000,
      limit: NO_LIMIT,
      genreId: 'gnr_ramen',
    });
    const sushi = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 5000,
      limit: NO_LIMIT,
      genreId: 'gnr_sushi',
    });

    expect(ramen.map((row) => row.id)).toEqual(['shp_001', 'shp_013', 'shp_025']);
    expect(sushi.map((row) => row.id)).toEqual(['shp_002', 'shp_014']);
  });

  it('店が 1 軒も無い場所では空配列を返す（例外にしない）', async () => {
    const sapporo = coordinate(43.06417, 141.34694);

    const rows = await findNearbyShops(db, {
      center: sapporo,
      radiusM: 5000,
      limit: NO_LIMIT,
      genreId: null,
    });

    expect(rows).toEqual([]);
  });

  it('評価値も一緒に返る（一覧表示で N+1 を作らないため）', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 200,
      limit: 1,
      genreId: null,
    });

    expect(rows[0]).toMatchObject({
      id: 'shp_001',
      areaId: 'area_shibuya',
      genreId: 'gnr_ramen',
      latitude: 35.658034,
      longitude: 139.701636,
    });
    expect(typeof rows[0]?.ratingAvg).toBe('number');
    expect(typeof rows[0]?.ratingCount).toBe('number');
  });
});

describe('半径の境界（距離 = 半径ちょうど）', () => {
  /** shp_002 の座標。半径をこの店までの距離ちょうどに合わせて境界を突く */
  const SHOP_002_COORDINATE = coordinate(35.659234, 139.703136);

  it('距離が半径にちょうど等しい店は含まれる（閉区間）', async () => {
    // 段 3 の判定を `<= radiusM` ではなく `< radiusM` に書き間違えると、
    // ここだけが落ちる。シードには「半径 200m / 190m でちょうど境界に来る店」が
    // いないため、半径を実測距離そのものにして境界を作り出している。
    // shp_004 は 190.18482375432035m で shp_002 の 190.18482375249062m より
    // わずかに遠いので、この半径では入らない
    const exactRadiusM = distanceMeters(SHIBUYA_STATION, SHOP_002_COORDINATE);

    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: exactRadiusM,
      limit: NO_LIMIT,
      genreId: null,
    });

    expect(rows.map((row) => row.id)).toEqual(['shp_001', 'shp_002']);
    expect(rows[1]?.distanceM).toBe(exactRadiusM);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ここから下の describe は shops に行を足す。
// 上の件数・並び順のテストが崩れるため、必ずこの位置より後ろに置くこと。
// ─────────────────────────────────────────────────────────────────────────────

/** 検証用の店舗を 1 件入れる。列の並びをテスト内で繰り返さないためのヘルパ */
async function insertShop(
  id: string,
  geohash: string,
  latitude: number,
  longitude: number,
  status: string,
): Promise<void> {
  await local.d1
    .prepare(
      "INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash, status) VALUES (?, '境界テスト', 'gnr_ramen', 'area_shibuya', '東京都', ?, ?, ?, ?)",
    )
    .bind(id, latitude, longitude, geohash, status)
    .run();
}

describe('geohashPrefixCondition の境界', () => {
  /** セル直後が base32 の最大・最小文字になる geohash を手で作って確かめる */
  const EDGE_SHOPS: readonly (readonly [string, string])[] = [
    ['edge_z', 'xn76fzz'],
    ['edge_0', 'xn76f00'],
    ['edge_next', 'xn76g00'],
  ];

  beforeAll(async () => {
    for (const [id, geohash] of EDGE_SHOPS) {
      // 渋谷駅から 263.89m。半径 200m のテストには入らない位置を選んである
      await insertShop(id, geohash, 35.66, 139.7, 'published');
    }
  });

  it('セル直後が z の店も 0 の店も拾い、隣のセルは拾わない', async () => {
    const rows = await db
      .select({ id: shops.id, geohash: shops.geohash })
      .from(shops)
      .where(and(eq(shops.status, 'published'), geohashPrefixCondition('xn76f')));

    const ids = rows.map((row) => row.id);

    // xn76fzz は上限が '{' でないと範囲から落ちる
    expect(ids).toContain('edge_z');
    expect(ids).toContain('edge_0');
    // xn76g00 は隣のセル。'{' より大きいので入らない
    expect(ids).not.toContain('edge_next');
    // 取りこぼしも取りすぎも無いことを、前方一致そのもので二重に確かめる
    expect(rows.every((row) => row.geohash.startsWith('xn76f'))).toBe(true);
    // シードの xn76f* が 8 件（shp_001/004/005/011/012/013/014/015）＋ edge_z / edge_0
    expect(rows).toHaveLength(10);
  });
});

describe('距離が完全に同じ店の並び順', () => {
  /** 渋谷駅と同じ座標に置く 2 軒。距離が 1 ビットも違わないので id が決め手になる */
  const TIE_SHOP_IDS = ['shp_tie_b', 'shp_tie_a'] as const;

  beforeAll(async () => {
    // id の降順で INSERT する。並べ替えの第 2 キーが無いと
    // SQL の返却順（= rowid 順）がそのまま出てしまい、b が先に来る
    for (const id of TIE_SHOP_IDS) {
      await insertShop(id, 'xn76fgr', 35.658034, 139.701636, 'published');
    }
  });

  it('距離が同値なら id の昇順で安定する', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 200,
      limit: NO_LIMIT,
      genreId: null,
    });

    expect(rows.map((row) => row.id)).toEqual([
      'shp_001',
      'shp_tie_a',
      'shp_tie_b',
      'shp_002',
      'shp_004',
      'shp_003',
      'shp_005',
    ]);
  });
});

describe('公開状態の絞り込み', () => {
  /** 渋谷駅直上に置く下書きの店。距離 0m なので、素通しなら必ず先頭に現れる */
  const DRAFT_SHOP_ID = 'shp_draft_shibuya';

  beforeAll(async () => {
    await insertShop(DRAFT_SHOP_ID, 'xn76fgr', 35.658034, 139.701636, 'draft');
  });

  it('draft の店は返さない（シードは全件 published なので明示的に入れて確かめる）', async () => {
    const rows = await findNearbyShops(db, {
      center: SHIBUYA_STATION,
      radiusM: 200,
      limit: NO_LIMIT,
      genreId: null,
    });

    const ids = rows.map((row) => row.id);

    expect(ids).not.toContain(DRAFT_SHOP_ID);
    // 直前の describe と同じ 7 件のまま変わらないこと
    expect(ids).toEqual([
      'shp_001',
      'shp_tie_a',
      'shp_tie_b',
      'shp_002',
      'shp_004',
      'shp_003',
      'shp_005',
    ]);
  });
});

describe('段 1 のクエリが索引を使う', () => {
  it('9 セルの OR が MULTI-INDEX OR で 9 本とも idx_shops_status_geohash を使う', async () => {
    const cells = cellsForRadius(SHIBUYA_STATION, 1000);
    const compiled = db
      .select({ id: shops.id })
      .from(shops)
      .where(
        and(
          eq(shops.status, 'published'),
          or(...cells.map((cell) => geohashPrefixCondition(cell))),
        ),
      )
      .toSQL();

    const plan = await local.d1
      .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
      .bind(...compiled.params)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('MULTI-INDEX OR');
    expect(detail.match(/idx_shops_status_geohash/g)).toHaveLength(9);
    expect(detail).not.toContain('SCAN shops');
  });

  it('GLOB はバインド値が前方一致パターンなら索引を使う（範囲比較と同じプランになる）', async () => {
    // 「GLOB はバインド変数だと索引が効かない」は誤り。SQLite の LIKE 最適化は
    // パターンが実行時に前方一致だと分かれば範囲制約へ書き換える。
    // だから GLOB と範囲比較は等価で、選択理由は速度ではなく下の 2 件にある
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = ? AND geohash GLOB ?')
      .bind('published', 'xn76f*')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_shops_status_geohash');
    expect(detail).toContain('geohash>? AND geohash<?');
  });

  it('GLOB は先頭ワイルドカードを渡されると全表走査へ落ちる（範囲比較を選ぶ理由）', async () => {
    // 索引が効くかどうかが実行時のバインド値に左右される。
    // 範囲比較は値に関係なく必ず索引を使うので、こちらを実装に採用する
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE status = ? AND geohash GLOB ?')
      .bind('published', '*n76f*')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).not.toContain('geohash>? AND geohash<?');
  });

  it('LIKE は索引が効かない（case_sensitive_like が既定で OFF だから）', async () => {
    const plan = await local.d1
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM shops WHERE geohash LIKE ?')
      .bind('xn76f%')
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' ');

    expect(detail).toContain('SCAN shops');
  });

  it('D1 は 6 項以上の UNION を受け付けない（だから OR で並べる）', async () => {
    const sixTerms = Array.from({ length: 6 }, () => 'SELECT 1 AS v').join(' UNION ALL ');

    await expect(local.d1.prepare(sixTerms).all()).rejects.toThrow(
      /too many terms in compound SELECT/,
    );
  });
});
