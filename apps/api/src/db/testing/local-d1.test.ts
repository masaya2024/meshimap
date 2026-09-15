import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createLocalD1, type LocalD1, toExecutableStatements } from './local-d1';

describe('createLocalD1', () => {
  let local: LocalD1;

  beforeAll(async () => {
    local = await createLocalD1();
  });

  afterAll(async () => {
    await local.dispose();
  });

  it('miniflare 上で D1 が起動し、単純なクエリが実行できる', async () => {
    const result = await local.d1.prepare('SELECT 1 AS one').first<{ one: number }>();
    expect(result?.one).toBe(1);
  });

  it('applyMigrations は migrations/ の SQL を 1 文以上適用する', async () => {
    const executedStatementCount = await applyMigrations(local.d1);
    expect(executedStatementCount).toBeGreaterThan(0);
  });
});

describe('toExecutableStatements', () => {
  it('statement-breakpoint で文を分ける', () => {
    expect(toExecutableStatements('SELECT 1;\n--> statement-breakpoint\nSELECT 2;')).toEqual([
      'SELECT 1;',
      'SELECT 2;',
    ]);
  });

  it('改行を空白へ潰して 1 行にする', () => {
    expect(toExecutableStatements('CREATE TABLE t (\na text\n);')).toEqual([
      'CREATE TABLE t ( a text );',
    ]);
  });

  it('行コメントを落とす', () => {
    // 落とさずに改行を潰すと、コメントが後続の SQL を丸ごと飲み込んで
    // 「SQL code did not contain a statement」になる
    expect(toExecutableStatements('-- 仮想テーブルの説明\nSELECT 1;')).toEqual(['SELECT 1;']);
  });

  it('コメントだけの文は捨てる', () => {
    // drizzle-kit generate --custom が置くヘッダ行がこれに当たる
    expect(toExecutableStatements('-- Custom SQL migration file, put your code below! --')).toEqual(
      [],
    );
  });

  it('空の文は捨てる', () => {
    expect(toExecutableStatements('\n\n')).toEqual([]);
  });

  it('文字列リテラルの中の -- は消さない', () => {
    // 行頭から始まるコメント行だけを対象にしているので、値の一部は壊れない
    expect(toExecutableStatements("SELECT '--' AS dashes;")).toEqual(["SELECT '--' AS dashes;"]);
  });

  it('BEGIN … END; の中に ; があっても 1 文として扱う', () => {
    // トリガー本体の ; で分割してしまうと CREATE TRIGGER が壊れる
    const trigger = 'CREATE TRIGGER t AFTER INSERT ON s BEGIN\nINSERT INTO u VALUES (1);\nEND;';

    expect(toExecutableStatements(trigger)).toEqual([
      'CREATE TRIGGER t AFTER INSERT ON s BEGIN INSERT INTO u VALUES (1); END;',
    ]);
  });
});
