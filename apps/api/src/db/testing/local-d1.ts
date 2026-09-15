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
 * migrations/ 配下の .sql をファイル名順に全部流し込み、実行した文の数を返す。
 * wrangler の d1_migrations テーブルは作らない（テストでは常にまっさらから作るため不要）。
 */
export async function applyMigrations(d1: D1Database): Promise<number> {
  const migrationFileNames = readdirSync(MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  let executedStatementCount = 0;

  for (const fileName of migrationFileNames) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, fileName), 'utf8');

    for (const rawStatement of sqlText.split(STATEMENT_SEPARATOR)) {
      const statement = rawStatement.trim();
      if (statement.length === 0) {
        continue;
      }
      // D1 の exec() は複数行の SQL を受け付けない（改行があると構文解析に失敗する）。
      // SQL の意味は改行の有無で変わらないため、空白へ潰して 1 行にしてから渡す。
      await d1.exec(statement.replaceAll('\n', ' '));
      executedStatementCount += 1;
    }
  }

  return executedStatementCount;
}
