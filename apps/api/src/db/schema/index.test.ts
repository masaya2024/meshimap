/**
 * `index.ts` の再エクスポートと、マイグレーション DDL との対応を検証する。
 *
 * 設計書そのものとの突き合わせだけは design-doc-sync.test.ts に分けてある。
 * このファイルは apps/api の外を読まないので Stryker のサンドボックスでもそのまま動く。
 */
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

/**
 * index.ts が再エクスポートしているべき全テーブル名。
 * この一覧が設計書の列挙とずれていないことは design-doc-sync.test.ts が見る。
 */
const EXPECTED_TABLE_NAMES = [...BETTER_AUTH_TABLE_NAMES, ...DESIGN_DOC_TABLE_NAMES] as const;

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
