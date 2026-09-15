import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSql } from '../../scripts/generate-seed';
import { SEED_FILE_PATH, applySeed, createMigratedD1, type LocalD1 } from './testing/local-d1';

let local: LocalD1;

/** 生成される SQL 文の総数。文が増減したら期待値も更新する */
const EXPECTED_STATEMENT_COUNT = 1247;

beforeAll(async () => {
  local = await createMigratedD1();
  await applySeed(local.d1);
}, 120_000);

afterAll(async () => {
  await local.dispose();
});

async function countOf(tableName: string): Promise<number> {
  const row = await local.d1
    .prepare(`SELECT count(*) AS row_count FROM \`${tableName}\``)
    .first<{ row_count: number }>();
  if (row === null) {
    throw new Error(`件数を取得できませんでした: ${tableName}`);
  }
  return row.row_count;
}

describe('シードの件数', () => {
  it('SQL の文数が想定どおり', async () => {
    const executedCount = await applySeed(local.d1);

    expect(executedCount).toBe(EXPECTED_STATEMENT_COUNT);
  });

  it('店舗は 60 件（12 エリア × 5 件）', async () => {
    expect(await countOf('shops')).toBe(60);
  });

  it('ジャンルとエリアは 12 件ずつ', async () => {
    expect(await countOf('genres')).toBe(12);
    expect(await countOf('areas')).toBe(12);
  });

  it('利用者は 33 人（管理者 1 + オーナー 12 + 一般 20）で、全員に profiles がある', async () => {
    expect(await countOf('user')).toBe(33);
    expect(await countOf('profiles')).toBe(33);
  });

  it('営業時間は 60 店 × 7 曜日 = 420 行で、うち 60 行が定休日', async () => {
    expect(await countOf('shop_hours')).toBe(420);

    const closed = await local.d1
      .prepare('SELECT count(*) AS row_count FROM shop_hours WHERE is_closed = 1')
      .first<{ row_count: number }>();

    expect(closed?.row_count).toBe(60);
  });

  it('写真は 120 枚で、カバーは 1 店 1 枚', async () => {
    expect(await countOf('shop_photos')).toBe(120);

    const covers = await local.d1
      .prepare('SELECT count(*) AS row_count FROM shop_photos WHERE is_cover = 1')
      .first<{ row_count: number }>();

    expect(covers?.row_count).toBe(60);
  });

  it('メニューは 120 カテゴリ / 240 品、席設定は 60 件', async () => {
    expect(await countOf('menu_categories')).toBe(120);
    expect(await countOf('menu_items')).toBe(240);
    expect(await countOf('seat_settings')).toBe(60);
  });

  it('レビューは 109 件で、うち 46 店舗が評価を持つ', async () => {
    expect(await countOf('reviews')).toBe(109);

    const rated = await local.d1
      .prepare('SELECT count(*) AS row_count FROM shops WHERE rating_count > 0')
      .first<{ row_count: number }>();

    expect(rated?.row_count).toBe(46);
  });
});

describe('シードの中身', () => {
  it('ジャンルは 12 種類が 5 件ずつに散っている', async () => {
    const rows = await local.d1
      .prepare('SELECT genre_id, count(*) AS row_count FROM shops GROUP BY genre_id')
      .all<{ genre_id: string; row_count: number }>();

    expect(rows.results).toHaveLength(12);
    for (const row of rows.results) {
      expect(row.row_count).toBe(5);
    }
  });

  it('全店舗が published で、geohash は 7 文字', async () => {
    const row = await local.d1
      .prepare(
        "SELECT count(*) AS row_count FROM shops WHERE status = 'published' AND length(geohash) = 7",
      )
      .first<{ row_count: number }>();

    expect(row?.row_count).toBe(60);
  });

  it('渋谷 1 号店は渋谷駅の座標そのもので、geohash は xn76fgr', async () => {
    const row = await local.d1
      .prepare(
        'SELECT name, name_kana, lat, lng, geohash, address, postal_code FROM shops WHERE id = ?',
      )
      .bind('shp_001')
      .first<{
        name: string;
        name_kana: string;
        lat: number;
        lng: number;
        geohash: string;
        address: string;
        postal_code: string;
      }>();

    expect(row).toEqual({
      name: '麺屋 みどり',
      name_kana: 'メンヤ ミドリ',
      lat: 35.658034,
      lng: 139.701636,
      geohash: 'xn76fgr',
      address: '東京都渋谷区道玄坂1-1-1',
      postal_code: '150-0001',
    });
  });

  it('name_kana が NULL の店舗は無い（FTS のカナ検索が効く）', async () => {
    const row = await local.d1
      .prepare('SELECT count(*) AS row_count FROM shops WHERE name_kana IS NULL')
      .first<{ row_count: number }>();

    expect(row?.row_count).toBe(0);
  });

  it('rating_avg はレビューから再計算した値と一致する', async () => {
    const row = await local.d1
      .prepare(
        `SELECT count(*) AS mismatch_count
           FROM shops s
          WHERE s.rating_count <> (
                  SELECT count(*) FROM reviews r
                   WHERE r.shop_id = s.id AND r.status = 'published')
             OR s.rating_avg <> coalesce((
                  SELECT round(avg(r.rating), 2) FROM reviews r
                   WHERE r.shop_id = s.id AND r.status = 'published'), 0)`,
      )
      .first<{ mismatch_count: number }>();

    expect(row?.mismatch_count).toBe(0);
  });

  it('シードを流すと shops_fts も 60 件になる（トリガーが効いている）', async () => {
    expect(await countOf('shops_fts')).toBe(60);

    const hit = await local.d1
      .prepare('SELECT count(*) AS row_count FROM shops_fts WHERE shops_fts MATCH ?')
      .bind('"メンヤ"')
      .first<{ row_count: number }>();

    expect(hit?.row_count).toBe(2);
  });

  it('2 回流しても件数が変わらない（冪等）', async () => {
    await applySeed(local.d1);

    expect(await countOf('shops')).toBe(60);
    expect(await countOf('reviews')).toBe(109);
    expect(await countOf('shops_fts')).toBe(60);
  });
});

describe('seeds/seed.sql', () => {
  /**
   * `seeds/seed.sql` は `scripts/generate-seed.ts` の出力を git に入れたもの。
   * 生成側を直して `npm run db:seed:generate` を忘れても、あるいは seed.sql を
   * 手で書き換えても、他のテストは seed.sql しか見ていないので気づけない。
   * ここだけが両者のずれを捕まえる。落ちたら `npm run db:seed:generate` を流す。
   */
  it('scripts/generate-seed.ts の出力と 1 バイトも違わない', () => {
    expect(readFileSync(SEED_FILE_PATH, 'utf8')).toBe(seedSql);
  });

  /**
   * `applySeed()` は改行で文を割る。生成側が 1 文を複数行に分けた瞬間に
   * 壊れた SQL が D1 へ渡るので、その前提をここで固定する。
   */
  it('1 行 1 文で、空行もセミコロン抜けも無い', () => {
    const lines = seedSql.split('\n');

    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) {
      expect(line).not.toBe('');
      expect(line.endsWith(';')).toBe(true);
    }
    expect(lines).toHaveLength(EXPECTED_STATEMENT_COUNT + 1);
  });
});
