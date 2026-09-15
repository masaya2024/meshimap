import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  applySeed,
  createLocalD1,
  type LocalD1,
  toExecutableStatements,
} from './local-d1';

/**
 * `exec()` の呼び出しだけを記録する最小の D1 スタブ。
 *
 * 本物の D1 を使うと「何回往復したか」が観測できない。ここで見たいのは
 * 結果ではなく往復回数そのものなので、記録だけするスタブを当てる。
 * `D1Database` は実装しないメンバが多いため、テスト内でだけ型を潰す。
 */
function createExecRecordingD1(): { readonly d1: D1Database; readonly calls: string[] } {
  const calls: string[] = [];
  const d1 = {
    exec: (sql: string) => {
      calls.push(sql);
      return Promise.resolve({ count: sql.split('\n').length, duration: 0 });
    },
  } as unknown as D1Database;

  return { d1, calls };
}

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

/**
 * D1 への往復回数を固定する。
 *
 * miniflare の D1 は workerd への loopback HTTP なので、`exec()` 1 回が TCP 接続 1 本になる。
 * 1 文ずつ流していた頃は 1 回のテスト実行で数千本の接続が立ち、
 * テストを 4 並列で走らせると macOS の一時ポートが尽きて
 * `connect EADDRNOTAVAIL 127.0.0.1:xxxxx` で beforeAll ごと落ちた（2026-09-15 実測）。
 * Stryker は終了コードしか見ないため、この失敗が「変異を殺した」と誤記録され、
 * ミューテーションスコアが実力より高く出ていた。
 *
 * 件数ではなく往復回数を見るのは、件数のテストでは 1 文ずつの実装へ戻しても気づけないため。
 */
describe('D1 への往復回数', () => {
  it('applyMigrations は往復 1 回で全文を流す', async () => {
    const { d1, calls } = createExecRecordingD1();

    const executedStatementCount = await applyMigrations(d1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.split('\n')).toHaveLength(executedStatementCount);
  });

  it('applySeed は往復 1 回で全文を流す', async () => {
    const { d1, calls } = createExecRecordingD1();

    const executedStatementCount = await applySeed(d1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.split('\n')).toHaveLength(executedStatementCount);
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
