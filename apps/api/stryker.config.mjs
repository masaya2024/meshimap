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
  // src/db/schema/design-doc-sync.test.ts だけ除外する。このテストは
  // docs/superpowers/specs/2026-09-15-meshimap-design.md を readFileSync するが、
  // Stryker のサンドボックスは stryker.config.mjs のあるディレクトリ（= apps/api）
  // 配下しかコピーしないので、5 階層上の docs/ が無く ENOENT で初回実行ごと落ちる。
  //
  // 以前は同じ理由で src/db/schema/index.test.ts をファイルごと除外していた。
  // 設計書を読むのはその中の 1 テストだけなのに、同じファイルに同居していた
  // 「CREATE VIRTUAL TABLE shops_fts が DDL にある」という主張まで一緒に消えて、
  // src/db/fts.ts の SHOPS_FTS_TABLE_NAME を '' にする変異が生き残っていた。
  // だから設計書を読む 1 テストだけを design-doc-sync.test.ts へ切り出し、
  // 除外の粒度をそのファイルに合わせた。
  //
  // 点数を甘くする除外ではない。上の mutate が src/db/schema/** を対象外にしている
  // うえ、テストを減らす操作は変異を殺す側を減らすので score は下がるほうに働く。
  // 除外を増やすときは「サンドボックス外を読むから」以外の理由を認めないこと。
  // その場合も、まず「サンドボックス外を読む部分だけ別ファイルに切り出せないか」を先に試すこと。
  vitestArgs: ["--exclude 'src/db/schema/design-doc-sync.test.ts'"],
  // タイムアウトは既定（../../stryker.base.mjs の 10 秒）のままでよい。
  //
  // 以前はこのスイートが 1 回 22 秒かかり、20 秒の上乗せを指定していた。
  // 遅さの正体は D1 の 1 文ごとの loopback HTTP で、
  // src/db/testing/local-d1.ts を「1 往復でまとめて流す」に直したら 18 秒になった。
  //
  // 18 秒でも既定の 10 秒で足りる。timeoutMS は 1 回の上限ではなく**上乗せ分**で、
  // 実際の打ち切りは `timeoutFactor * netTime + timeoutMS + timeOverheadMS`
  // （@stryker-mutator/core/dist/src/mutants/mutant-test-planner.js:124、timeoutFactor 既定 1.5）。
  // ここでは `1.5 × 18.4 + 10 ≈ 37.6 秒`で、素の 18 秒の 2 倍の猶予がある。
  //
  // 計測は必ず `--no-file-parallelism` 付きで採ること。Stryker が実際に打つのは
  // この引数付きのコマンド（../../stryker.base.mjs）なので、素の `npx vitest run` で
  // 測った値は netTime と一致しない（同じ 414 件が 3.7 秒 対 18.0 秒。約 5 倍ずれる）。
  // 2026-09-15 実測: ドライラン net 18366ms / `npx vitest run --silent --no-file-parallelism` real 17.96s。
  //
  // 同じ往復の多さが、より悪い形でも表に出ていた。
  // 1 文ずつ流していた頃は 1 回の実行で数千本の TCP 接続が立ち、
  // Stryker が並列に走らせると macOS の一時ポートが尽きて
  // `connect EADDRNOTAVAIL 127.0.0.1:xxxxx` で beforeAll ごと落ちた。
  // command ランナーは終了コードしか見ないため、
  // **変異と無関係なポート枯渇が「その変異を殺した」と記録される**。
  // 実際 129 変異すべての出力に EADDRNOTAVAIL が出ており、
  // 出力を変えないはずの変異（段 2 の枝刈りの削除）まで Killed になっていた。
  // 「測れていない 100%」だったということ。
  // 再発の検知は local-d1.test.ts の「D1 への往復回数」が担う。
});
