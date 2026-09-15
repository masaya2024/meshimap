import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFtsMatchQuery, escapeFtsToken } from './fts';
import { createMigratedD1, type LocalD1 } from './testing/local-d1';

let local: LocalD1;

const RAMEN_SHOP_ID = 'shp_fts_ramen';
const SUSHI_SHOP_ID = 'shp_fts_sushi';
const ITALIAN_SHOP_ID = 'shp_fts_italian';

/** beforeAll で投入する全店舗。件数を直書きしないための一覧 */
const ALL_SHOP_IDS = [RAMEN_SHOP_ID, SUSHI_SHOP_ID, ITALIAN_SHOP_ID] as const;

/** 3 店すべての住所に含まれる語。索引を端から端まで舐めるための当たり語として使う */
const ALL_SHOPS_MATCH_QUERY = '"東京都"';

/**
 * FTS5 の `integrity-check` に渡す rank の値。
 *
 * 1 を渡すと索引を content 表（shops）の本文と突き合わせる。
 * 0（および引数を省略した形）は索引の内部整合性しか見ないため、
 * 外部コンテンツ表ではトリガーの列順ミスを検知できない（実測）。
 */
const FTS_INTEGRITY_CHECK_AGAINST_CONTENT = 1;

async function insertShop(
  shopId: string,
  name: string,
  nameKana: string,
  description: string,
  address: string,
): Promise<void> {
  await local.d1
    .prepare(
      'INSERT INTO shops (id, name, name_kana, description, genre_id, area_id, address, lat, lng, geohash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      shopId,
      name,
      nameKana,
      description,
      'gnr_fts',
      'area_fts',
      address,
      35.658034,
      139.701636,
      'xn76fgr',
    )
    .run();
}

/** FTS を引いて店舗 ID の配列を返す */
async function searchShopIds(matchQuery: string): Promise<readonly string[]> {
  const result = await local.d1
    .prepare(
      'SELECT s.id AS id FROM shops_fts f JOIN shops s ON s.rowid = f.rowid WHERE shops_fts MATCH ? ORDER BY bm25(shops_fts)',
    )
    .bind(matchQuery)
    .all<{ id: string }>();

  return result.results.map((row) => row.id);
}

/**
 * 索引そのもののヒット件数を数える。
 *
 * `SELECT count(*) FROM shops_fts` は使えない。外部コンテンツ表の全件走査は
 * 索引ではなく `shops` を読むため、トリガーが 1 つも無くても `shops` の行数が返る
 * （実測）。MATCH を通すと索引だけを見るので、同期の失敗をここで捕まえられる。
 *
 * shops を JOIN しないのも意図的。JOIN すると削除済み行に残ったゴミ索引が
 * 結合で落ちて見えなくなる。
 */
async function countIndexHits(matchQuery: string): Promise<number> {
  const row = await local.d1
    .prepare('SELECT count(*) AS hits FROM shops_fts WHERE shops_fts MATCH ?')
    .bind(matchQuery)
    .first<{ hits: number }>();

  return row?.hits ?? 0;
}

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind('gnr_fts', 'ラーメン', 'ramen-fts')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind('area_fts', '渋谷', '東京都')
    .run();
  await insertShop(
    RAMEN_SHOP_ID,
    '麺屋 こうじ',
    'メンヤコウジ',
    '濃厚な豚骨ラーメンが看板メニュー',
    '東京都渋谷区道玄坂1-2-3',
  );
  await insertShop(
    SUSHI_SHOP_ID,
    '寿司処 たなか',
    'スシドコロタナカ',
    '江戸前寿司のカウンター 8 席',
    '東京都渋谷区神南1-2-3',
  );
  await insertShop(
    ITALIAN_SHOP_ID,
    'Trattoria Aoi',
    'トラットリアアオイ',
    '薪窯で焼くナポリピッツァ',
    '東京都目黒区青葉台1-2-3',
  );
});

afterAll(async () => {
  await local.dispose();
});

describe('shops_fts（仮想テーブル）', () => {
  it('マイグレーション適用後に仮想テーブルとトリガーが存在する', async () => {
    const result = await local.d1
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'shops_fts%' ORDER BY name")
      .all<{ name: string }>();
    const names = result.results.map((row) => row.name);

    // FTS5 は本体 + 影テーブル（config / data / docsize / idx）を作る。
    // content='shops' なので shops_fts_content は作られない
    expect(names).toEqual([
      'shops_fts',
      'shops_fts_after_delete',
      'shops_fts_after_insert',
      'shops_fts_after_update',
      'shops_fts_config',
      'shops_fts_data',
      'shops_fts_docsize',
      'shops_fts_idx',
    ]);
  });

  it('INSERT トリガーで索引に入る', async () => {
    expect(await countIndexHits(ALL_SHOPS_MATCH_QUERY)).toBe(ALL_SHOP_IDS.length);
  });

  it('店名で引ける', async () => {
    expect(await searchShopIds('"こうじ"')).toEqual([RAMEN_SHOP_ID]);
  });

  it('説明文の途中でも引ける（trigram の部分一致）', async () => {
    expect(await searchShopIds('"ラーメン"')).toEqual([RAMEN_SHOP_ID]);
  });

  it('カナ読みで引ける', async () => {
    expect(await searchShopIds('"トラットリア"')).toEqual([ITALIAN_SHOP_ID]);
  });

  it('住所で引ける（複数店がヒットする）', async () => {
    const shopIds = await searchShopIds('"渋谷区"');

    expect([...shopIds].sort()).toEqual([RAMEN_SHOP_ID, SUSHI_SHOP_ID].sort());
  });

  it('英字は大小を区別しない', async () => {
    expect(await searchShopIds('"aoi"')).toEqual([ITALIAN_SHOP_ID]);
    expect(await searchShopIds('"AOI"')).toEqual([ITALIAN_SHOP_ID]);
  });

  it('2 文字の検索語はヒットしない（trigram の仕様）', async () => {
    // Phase 6 の検索 API はこのケースを LIKE にフォールバックさせる
    expect(await searchShopIds('"寿司"')).toEqual([]);
  });

  it('UPDATE トリガーで古い語が消え、新しい語が入る', async () => {
    await local.d1
      .prepare('UPDATE shops SET description = ? WHERE id = ?')
      .bind('あっさり醤油ラーメンが看板メニュー', RAMEN_SHOP_ID)
      .run();

    expect(await searchShopIds('"あっさり"')).toEqual([RAMEN_SHOP_ID]);
    // 「濃厚な」は古い本文にしかない。トリガーの delete 側が動いていないと残る
    expect(await searchShopIds('"濃厚な"')).toEqual([]);
  });

  it('DELETE トリガーで索引から消える', async () => {
    await local.d1.prepare('DELETE FROM shops WHERE id = ?').bind(SUSHI_SHOP_ID).run();

    const remainingShopIds = ALL_SHOP_IDS.filter((shopId) => shopId !== SUSHI_SHOP_ID);

    expect(await countIndexHits(ALL_SHOPS_MATCH_QUERY)).toBe(remainingShopIds.length);
    expect(await searchShopIds('"神南"')).toEqual([]);
  });

  it('整合性チェックが通る（本体と索引が食い違っていない）', async () => {
    // 食い違っていると SQLITE_CORRUPT_VTAB が投げられる。
    // トリガーの列順ミスをここで検知できる。
    //
    // rank = 1 が必須。引数なし（および rank = 0）は外部コンテンツ表では
    // 索引の内部整合性しか見ず、content 表と突き合わせないため、
    // トリガーの列を入れ替えても「通ってしまう」ことを実測で確認した。
    await local.d1
      .prepare("INSERT INTO shops_fts(shops_fts, rank) VALUES('integrity-check', ?)")
      .bind(FTS_INTEGRITY_CHECK_AGAINST_CONTENT)
      .run();
  });
});

describe('escapeFtsToken', () => {
  it('語を二重引用符で包む', () => {
    expect(escapeFtsToken('ラーメン')).toBe('"ラーメン"');
  });

  it('語に含まれる二重引用符は 2 つ重ねて打ち消す', () => {
    expect(escapeFtsToken('い"ち')).toBe('"い""ち"');
  });

  it('FTS5 の演算子を語として無害化する', () => {
    // 包まないと fts5 の構文解析に食われる
    expect(escapeFtsToken('OR')).toBe('"OR"');
    expect(escapeFtsToken('ラーメン*')).toBe('"ラーメン*"');
    expect(escapeFtsToken('(')).toBe('"("');
  });

  it('ハイフンを含む語を壊さない', () => {
    expect(escapeFtsToken('道玄坂1-2-3')).toBe('"道玄坂1-2-3"');
  });
});

describe('buildFtsMatchQuery', () => {
  it('1 語ならそのまま引用する', () => {
    expect(buildFtsMatchQuery('ラーメン')).toBe('"ラーメン"');
  });

  it('空白区切りの複数語は AND でつなぐ', () => {
    expect(buildFtsMatchQuery('ラーメン 渋谷区')).toBe('"ラーメン" AND "渋谷区"');
  });

  it('全角スペースでも区切る', () => {
    expect(buildFtsMatchQuery('ラーメン　渋谷区')).toBe('"ラーメン" AND "渋谷区"');
  });

  it('連続した空白は 1 つの区切りとして扱う', () => {
    // 区切りの正規表現から `\s+` の `+` が落ちると、連続空白のあいだに空文字の語が生まれる。
    // 空の語が式に混ざると `"ラーメン" AND "" AND "渋谷区"` のような式になり、
    // 意図しない絞り込みになる。半角の連続・タブ混在・全角の連続をまとめて固定しておく。
    expect(buildFtsMatchQuery('ラーメン  渋谷区')).toBe('"ラーメン" AND "渋谷区"');
    expect(buildFtsMatchQuery('ラーメン\t 渋谷区')).toBe('"ラーメン" AND "渋谷区"');
    expect(buildFtsMatchQuery('ラーメン　　渋谷区')).toBe('"ラーメン" AND "渋谷区"');
  });

  it('前後の空白は式に残らない', () => {
    expect(buildFtsMatchQuery('  ラーメン 渋谷区  ')).toBe('"ラーメン" AND "渋谷区"');
  });

  it('3 文字未満の語は落とす（trigram ではヒットしないため）', () => {
    expect(buildFtsMatchQuery('ラーメン 寿司')).toBe('"ラーメン"');
  });

  it('全部の語が 3 文字未満なら null を返す', () => {
    // 呼び出し側は null を見て LIKE 検索へフォールバックする
    expect(buildFtsMatchQuery('寿司 蕎麦')).toBeNull();
  });

  it('空文字と空白だけの入力は null を返す', () => {
    expect(buildFtsMatchQuery('')).toBeNull();
    expect(buildFtsMatchQuery('   ')).toBeNull();
  });

  it('演算子を含む入力でも例外にならない式を作る', async () => {
    const matchQuery = buildFtsMatchQuery('道玄坂1-2-3');

    expect(matchQuery).toBe('"道玄坂1-2-3"');
    // 実際に D1 に投げても落ちないことまで確認する
    await expect(searchShopIds(matchQuery ?? '')).resolves.toEqual([RAMEN_SHOP_ID]);
  });

  it('生成した式で実際に検索できる', async () => {
    const matchQuery = buildFtsMatchQuery('ラーメン 渋谷区');

    await expect(searchShopIds(matchQuery ?? '')).resolves.toEqual([RAMEN_SHOP_ID]);
  });
});
