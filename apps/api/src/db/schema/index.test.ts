import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SHOPS_FTS_TABLE_NAME } from '../fts';
import { readMigrationSql } from '../testing/local-d1';
import * as schema from './index';

/**
 * Better Auth が要求するテーブル（設計書 §4）。`auth.ts` で定義している。
 * 単数形なのは Better Auth 側の既定のテーブル名に合わせているため。
 */
const BETTER_AUTH_TABLE_NAMES = ['user', 'session', 'account', 'verification'] as const;

/** 設計書 §6「データモデル」に列挙されているアプリ側のテーブル */
const DESIGN_DOC_TABLE_NAMES = [
  // master.ts
  'profiles',
  'genres',
  'areas',
  // shop.ts
  'shops',
  // shop-detail.ts
  'shop_hours',
  'shop_closures',
  'shop_photos',
  // menu.ts
  'menu_categories',
  'menu_items',
  'seat_settings',
  // review.ts
  'reviews',
  'review_photos',
  'review_replies',
  // reservation.ts
  'reservations',
  // collection.ts
  'favorites',
  'lists',
  'list_items',
  // admin.ts
  'reports',
  'shop_applications',
  'notifications',
  'audit_logs',
] as const;

/** index.ts が再エクスポートしているべき全テーブル名 */
const EXPECTED_TABLE_NAMES = [...BETTER_AUTH_TABLE_NAMES, ...DESIGN_DOC_TABLE_NAMES] as const;

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** src/db/schema/ からリポジトリルートの設計書まで */
const DESIGN_DOC_PATH = join(
  CURRENT_DIR,
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'superpowers',
  'specs',
  '2026-09-15-meshimap-design.md',
);

/** 設計書 §6 のコードブロックで、テーブル名とカラム列挙を隔てている空白 */
const DESIGN_DOC_TABLE_PATTERN = /^([a-z_]+) {2,}/gm;

/**
 * 設計書 §6 のコードブロックに列挙されているテーブル名を読み出す。
 *
 * 上の 2 配列を「テストが勝手に決めた期待値」で終わらせないための仕掛け。
 * 設計書に書かずにテーブルを足した場合も、逆に設計書だけ直してスキーマを忘れた場合も、
 * 下の同期テストが落ちる。
 * 継続行は字下げされていて行頭に一致せず、`-- 認証` のようなコメント行も一致しない。
 */
function readDesignDocTableNames(): readonly string[] {
  const designDoc = readFileSync(DESIGN_DOC_PATH, 'utf8');
  const section = designDoc.slice(
    designDoc.indexOf('## 6. データモデル'),
    designDoc.indexOf('## 7. ディレクトリ構成'),
  );
  const codeBlock = section.slice(section.indexOf('```') + 3, section.lastIndexOf('```'));

  return [...codeBlock.matchAll(DESIGN_DOC_TABLE_PATTERN)].map((match) => match[1] ?? '');
}

/** drizzle-kit が生成する DDL のテーブル定義行。識別子はバッククォートで囲まれる */
const CREATE_TABLE_PATTERN = /CREATE TABLE `(?<tableName>[^`]+)`/g;

function collectExportedTableNames(): readonly string[] {
  return Object.values(schema)
    .filter((exported) => isTable(exported))
    .map((table) => getTableName(table))
    .sort();
}

/** migrations/ の DDL に実際に現れるテーブル名。CREATE VIRTUAL TABLE はこの正規表現に一致しない */
function collectMigrationTableNames(): readonly string[] {
  return [...readMigrationSql().matchAll(CREATE_TABLE_PATTERN)]
    .map((match) => match.groups?.tableName ?? '')
    .sort();
}

describe('schema/index.ts', () => {
  it('設計書 §6 と Better Auth の全テーブルを再エクスポートしている', () => {
    expect(collectExportedTableNames()).toEqual([...EXPECTED_TABLE_NAMES].sort());
  });

  it('テーブル名の重複がない', () => {
    const tableNames = collectExportedTableNames();

    expect(new Set(tableNames).size).toBe(tableNames.length);
  });

  it('期待値の一覧が設計書 §6 の列挙とそろっている', () => {
    // 並び順は比較しない。設計書は関連の近いテーブルを並べ、こちらはスキーマの
    // ファイル単位で並べていて、軸が違うだけの差を落とす意味がないため。
    expect([...EXPECTED_TABLE_NAMES].sort()).toEqual([...readDesignDocTableNames()].sort());
  });
});

describe('index.ts とマイグレーションの対応', () => {
  // drizzle.config.ts は index.ts だけを見る。ここに書き忘れたテーブルは DDL に出ず、
  // 実装時に no such table で初めて気づくことになる。それを機械的に検知する。
  it('再エクスポートしたテーブルがすべてマイグレーションの DDL に出ている', () => {
    expect(collectMigrationTableNames()).toEqual(collectExportedTableNames());
  });

  // shops_fts は Drizzle では表現できないため手書きマイグレーション（0001）で作る仮想テーブル。
  // 上の対応テストは CREATE_TABLE_PATTERN が `CREATE VIRTUAL TABLE` に一致しないことに
  // 暗黙に依存している。パターンを緩めると上のテストが「設計書にもスキーマにも無い名前が
  // DDL にある」という分かりにくい形で落ちるので、依存関係をここで明示しておく。
  it('手書きの FTS5 仮想テーブルは Drizzle 管理の一覧に混ざらない', () => {
    expect(readMigrationSql()).toContain(`CREATE VIRTUAL TABLE \`${SHOPS_FTS_TABLE_NAME}\``);
    expect(collectMigrationTableNames()).not.toContain(SHOPS_FTS_TABLE_NAME);
    expect(collectExportedTableNames()).not.toContain(SHOPS_FTS_TABLE_NAME);
  });
});
