import { availableParallelism } from 'node:os';

/**
 * 全パッケージ共通の Stryker 設定を組み立てる。
 *
 * packages/core・packages/geo・apps/api の 3 つが同じ設定を持つため、
 * 各パッケージの stryker.config.mjs はこの関数を呼ぶだけにしてある。
 * 特に「なぜこの実行方法なのか」は 3 箇所に書き写すと必ずずれるので、
 * 根拠はすべてここに集約する。
 */

/**
 * 1 つの変異につき Stryker が起こすプロセス数。
 * `--no-file-parallelism` を付けた vitest は「親 + ワーカー 1」の 2 プロセスで動く。
 */
const PROCESSES_PER_MUTANT = 2;

/**
 * 変異 1 件あたりのタイムアウトの既定値。テストスイートの実測時間に応じて呼び出し側が上書きする。
 *
 * ここで指定するのは「1 回のテスト実行にかけてよい上限」ではなく**上乗せ分**であることに注意。
 * Stryker の実際の打ち切りは
 * `timeoutFactor * netTime + timeoutMS + timeOverheadMS`
 * （`@stryker-mutator/core/dist/src/mutants/mutant-test-planner.js:124`）で、
 * `netTime` は初回のドライランで測った素のテスト時間、`timeoutFactor` は既定の 1.5。
 * つまり素の実行が 22 秒かかるスイートでも、timeoutMS が 20 秒なら
 * 打ち切りは 1.5 * 22 + 20 ≈ 53 秒になる。
 *
 * だから timeoutMS は「素の実行時間」ではなく「変異が入ったときに許すブレ幅」で決める。
 * 大きくしすぎると無限ループの検出が遅れるだけで、スコアは変わらない。
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ミューテーションスコアの下限。
 *
 * 下回ったらテストが変異を殺せていないということなので、
 * ここを下げて通すのではなくテストを足すこと。
 */
const THRESHOLDS = { high: 95, low: 85, break: 85 };

/** 論理コアを PROCESSES_PER_MUTANT で割った同時実行数。最低 1 は確保する */
const CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / PROCESSES_PER_MUTANT));

/**
 * @param {object} options
 * @param {string[]} options.mutate 変異を入れる対象の glob
 * @param {string[]} [options.vitestArgs] vitest に足す引数
 * @param {number} [options.timeoutMS] 変異 1 件あたりのタイムアウト
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function createStrykerConfig({ mutate, vitestArgs = [], timeoutMS = DEFAULT_TIMEOUT_MS }) {
  return {
    packageManager: 'npm',

    // vitest ランナー（@stryker-mutator/vitest-runner）は使えない。
    // vitest 5.0.0 との組み合わせで「実行時変異」が一切有効にならない。
    // 実測（2026-09-15, apps/api の fts.ts を対象）:
    //   static=true の 4 変異 → 全部 Killed
    //   static=false の 16 変異 → 全部 Survived
    // サンドボックス内で `__STRYKER_ACTIVE_MUTANT__=5` を手で立てて同じテストを
    // 流すと 10 件落ちるので、テストは変異を殺せている。有効化されていないだけ。
    // 原因は stryker-setup.js が実行時変異を `beforeAll` 内の `inject('activeMutant')`
    // で渡していること（静的変異はトップレベルで渡すので効く）。
    //
    // command ランナーは 1 変異 1 プロセスで、変異 ID を環境変数
    // `__STRYKER_ACTIVE_MUTANT__` で渡す（command-test-runner.js:62）。
    // 計装コードはこれを直接読むので、上の不具合の影響を受けない。
    testRunner: 'command',
    commandRunner: {
      // `--no-file-parallelism` は必須。これが無いと Stryker が起こす
      // 論理コア数ぶんのプロセスの各々がさらに vitest ワーカーを十数個起こし、
      // 24 コアの機械で 300 プロセス超になる。実測ではその状態で apps/api の
      // 98 変異中 94 が Timeout 判定になり、Stryker は Timeout を Killed と同じ
      // 「殺せた」に数えるので score だけ 100% と出た。
      // テストの強さを測れていない 100% だったということ。
      //
      // この指定にはもう 1 つ効能がある。ファイルを直列に流すので、
      // 1 プロセスあたりの D1 ループバック接続の**発生レート**が下がる。
      // miniflare の D1 は workerd への loopback HTTP で、1 クエリが TCP 接続 1 本。
      // macOS の一時ポートは 49152〜65535 の 16,384 個、TIME_WAIT は 2×MSL = 30 秒
      // （`sysctl net.inet.ip.portrange.first/last net.inet.tcp.msl`）なので、
      // 毎秒 546 接続を超えると枯渇し、workerd が
      // `::bind(...): Can't assign requested address; 127.0.0.1:0` で起動に失敗する。
      //
      // 2026-09-16 実測（apps/api・774 件・24 コア）。決め手は並列数ではなくこの指定:
      //   素の `npx vitest run` を 4 並列 → 12 回すべて緑
      //   素の `npx vitest run` を 8 並列 → 16 回すべて赤（113〜122 件失敗・TIME_WAIT 最大 16,203）
      //   この command をそのまま 12 並列 → 12 回すべて緑（TIME_WAIT 最大 14,872）
      // つまり Stryker の concurrency 12 は安全側にある。
      //
      // 逆に、ミューテーション実行中に素の `npx vitest run` を別に走らせてはいけない。
      // command ランナーは終了コードしか見ないので、ポート枯渇による失敗が
      // 「その変異を殺した」と誤記録され、スコアが実力より高く出る。
      //
      // 同じ理由で、実行中に `pkill -f vitest` を打ってはいけない。この command が
      // 起こす子プロセスの argv に `vitest` が入っているため全部巻き添えになり、
      // 強制終了ぶんがそのまま Killed として記録される。
      // 2026-09-16 実測: 進捗が 577 → 589 と concurrency ぴったりの 12 件だけ一瞬で飛んだ。
      // 停止したいときはプロセス名ではなく Stryker の PID を落とすこと。
      //
      // macOS では `caffeinate -i` を噛ませること。スリープ中は全プロセスが凍るが、
      // Stryker のタイムアウトは実時間で判定するので、復帰した瞬間に実行中の変異が
      // concurrency ぶんまとめて Timeout になる（= 上の理由で Killed に数えられる）。
      // 2026-09-17 実測（apps/api・659 変異）: 285 分のうち 138 分がスリープ
      // （`pmset -g log` の Sleep→DarkWake 11 回・うち 8 回は約 16 分）で、
      // Timeout が 0 件から 133 件に増えスコアが 86.95% → 88.92% と**上に**ずれた。
      // 偽 Timeout であることの決め手は、同じ変異が前回 Survived だったこと
      // （テストが通って終わる変異が、本質的にタイムアウトすることはない）:
      //   src/lib/logger.ts    前回 Survived 2 件 → 今回 Timeout 2 件
      //   src/lib/validate.ts  前回 Killed   7 件 → 今回 Timeout 7 件
      //   src/lib/parse-id.ts  前回 Killed 9・Survived 1 → 今回 Timeout 10 件
      command: ['npx vitest run --silent --no-file-parallelism', ...vitestArgs].join(' '),
    },
    concurrency: CONCURRENCY,

    // Timeout は Killed と同じ扱いになってしまうため、ここは厚めに取る。
    // 誤 Timeout は「殺せていない変異を殺したことにする」方向に効く。
    timeoutMS,

    // json は機械可読な生データ。「タイムアウトの正体は何か」を後から
    // 検証できるようにするために入れている（clear-text の合計だけでは判別できない）。
    reporters: ['html', 'json', 'clear-text', 'progress'],
    mutate,
    // command ランナーは coverageAnalysis に off しか対応しない
    coverageAnalysis: 'off',
    htmlReporter: { fileName: 'reports/mutation/index.html' },
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    thresholds: THRESHOLDS,
  };
}
