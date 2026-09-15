import { createStrykerConfig } from '../../stryker.base.mjs';

// 設定の根拠はすべて ../../stryker.base.mjs にある
export default createStrykerConfig({
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    // スキーマ定義は Drizzle の宣言そのもの。値の正しさはマイグレーション SQL と
    // 突き合わせるテストで見ており、変異を入れても意味のある差が出ない
    '!src/db/schema/**',
    // テスト専用のヘルパー。これ自体の壊れ方はテストの失敗として現れる
    '!src/db/testing/**',
  ],
  // src/db/schema/index.test.ts だけ除外する。このテストは
  // docs/superpowers/specs/2026-09-15-meshimap-design.md を readFileSync するが、
  // Stryker のサンドボックスは stryker.config.mjs のあるディレクトリ（= apps/api）
  // 配下しかコピーしないので、5 階層上の docs/ が無く ENOENT で初回実行ごと落ちる。
  //
  // 点数を甘くする除外ではない。上の mutate が src/db/schema/** を対象外にしている
  // うえ、テストを減らす操作は変異を殺す側を減らすので score は下がるほうに働く。
  // 除外を増やすときは「サンドボックス外を読むから」以外の理由を認めないこと。
  vitestArgs: ["--exclude 'src/db/schema/index.test.ts'"],
  // このスイートは素の状態で 1 回 22 秒かかる（2026-09-15 実測。miniflare の起動と
  // マイグレーション適用がほぼ全部で、`npx vitest run --silent --no-file-parallelism`
  // を単独で 2 回回して 21.99s / 21.92s）。packages/* の 10 秒では足りない。
  //
  // 20 秒は「上限」ではなく「上乗せ分」。実際の打ち切りは
  // 1.5 * 22s + 20s ≈ 53s になる（計算式は ../../stryker.base.mjs の
  // DEFAULT_TIMEOUT_MS のコメント）。98 変異すべて Timeout 0 で Killed になった。
  timeoutMS: 20_000,
});
