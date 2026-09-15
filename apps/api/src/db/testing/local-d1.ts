import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

/** wrangler.jsonc の compatibility_date と一致させる。ずれると D1 の挙動が変わりうる */
const COMPATIBILITY_DATE = '2026-09-01';

/** drizzle-kit が生成する SQL の文区切り。手書きマイグレーションでも同じ区切りを使う */
const STATEMENT_SEPARATOR = '--> statement-breakpoint';

/** テスト用の D1 バインディング名。wrangler.jsonc の binding と同じにしておく */
const D1_BINDING_NAME = 'DB';

/** miniflare を起動するためだけの最小 Worker。fetch は使わないが modules 形式には必須 */
const DUMMY_WORKER_SCRIPT = 'export default { fetch() { return new Response("ok"); } };';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** src/db/testing/ から apps/api/migrations/ までの相対位置 */
const MIGRATIONS_DIR = join(CURRENT_DIR, '..', '..', '..', 'migrations');

export type LocalD1 = {
  readonly d1: D1Database;
  readonly dispose: () => Promise<void>;
};

/**
 * miniflare 上にインメモリの D1 を 1 つ起動する。
 * better-sqlite3 は未導入であり、また「本物の D1（workerd の SQLite）で検証する」ことに
 * 意味があるため、SQLite を直接叩くのではなく miniflare を使う。
 */
export async function createLocalD1(): Promise<LocalD1> {
  // miniflare 5 は v5 形式のオプションを要求する。V4 形式の素のオブジェクトを渡すと
  // ERR_VALIDATION になるため、公式の変換関数を必ず通す。
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: DUMMY_WORKER_SCRIPT,
      compatibilityDate: COMPATIBILITY_DATE,
      d1Databases: { [D1_BINDING_NAME]: ':memory:' },
    }),
  );

  const d1 = await miniflare.getD1Database(D1_BINDING_NAME);

  return {
    d1,
    dispose: async () => {
      await miniflare.dispose();
    },
  };
}

/**
 * 起動してマイグレーションまで済ませた D1 を返す。
 * スキーマのテストは全部この状態から始まるためまとめてある。
 */
export async function createMigratedD1(): Promise<LocalD1> {
  const local = await createLocalD1();
  await applyMigrations(local.d1);
  return local;
}

/**
 * migrations/ 配下の .sql をファイル名順に連結して返す。
 * D1 へ適用せずに DDL そのものを検査したいテスト（schema/index.test.ts）からも使うため、
 * 「どこを読むか」の知識をこのファイルに閉じ込めておく。
 */
export function readMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()
    .map((fileName) => readFileSync(join(MIGRATIONS_DIR, fileName), 'utf8'))
    .join(`\n${STATEMENT_SEPARATOR}\n`);
}

/**
 * 行全体が `--` の行コメントである行。字下げは許すが、行頭から始まるものだけを対象にする。
 *
 * `SELECT '--'` のように文字列リテラルへ `--` が現れることがあるため、
 * 行の途中に現れる `--` は落とさない。手書きマイグレーションでは
 * 行末コメント（`SELECT 1; -- 説明`）を使わないこと。
 */
const FULL_LINE_COMMENT_PATTERN = /^[^\S\n]*--.*$/gm;

/**
 * マイグレーション SQL を D1 の `exec()` に渡せる文の配列へ分解する。
 *
 * `exec()` の制約が 2 つあるため、素の SQL をそのまま渡すことはできない。
 *
 * 1. 複数行を受け付けない（改行があると構文解析に失敗する）。
 *    SQL の意味は改行の有無で変わらないので空白へ潰す。
 * 2. 文が 1 つも無いと「SQL code did not contain a statement」で失敗する。
 *    `drizzle-kit generate --custom` が置くヘッダ行だけの塊がこれに当たるので捨てる。
 *
 * 行コメントを先に落とすのは、1 の改行潰しがコメントを「以降すべてがコメント」に
 * 変えてしまい、手書きマイグレーションの本体が丸ごと消えるため。
 *
 * トリガー本体の `;` では分割しない。分割の基準は `--> statement-breakpoint` だけであり、
 * `CREATE TRIGGER … BEGIN … END;` は 1 文のまま渡る。
 */
export function toExecutableStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split(STATEMENT_SEPARATOR)
    .map((rawStatement) =>
      rawStatement.replaceAll(FULL_LINE_COMMENT_PATTERN, '').replaceAll('\n', ' ').trim(),
    )
    .filter((statement) => statement.length > 0);
}

/**
 * migrations/ 配下の .sql をファイル名順に全部流し込み、実行した文の数を返す。
 * wrangler の d1_migrations テーブルは作らない（テストでは常にまっさらから作るため不要）。
 */
export async function applyMigrations(d1: D1Database): Promise<number> {
  const statements = toExecutableStatements(readMigrationSql());

  for (const statement of statements) {
    await d1.exec(statement);
  }

  return statements.length;
}
