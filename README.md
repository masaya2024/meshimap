# MeshiMap

地図を主役にしたグルメ発見・予約のネイティブアプリ。**利用者 / 店舗管理者 / システム管理者**の
3 ロールが 1 つのコードベースで共存する業務アプリ相当の設計を、Expo + Cloudflare Workers で実装する
ポートフォリオプロジェクトです。

> **現在の状況: 開発中（Phase 3 / 全 11 フェーズ中）。**
> 動くのは共有ロジック（`packages/geo` / `packages/core`）、モバイルの UI プリミティブ 8 種、
> API の D1 スキーマ・マイグレーション・ローカル D1 テストハーネスまでです。
> **画面と API エンドポイントは未実装で、`npm run api:dev` はまだ起動しません**
> （エントリポイント `apps/api/src/index.ts` が Phase 4 の成果物のため）。
> 何がどこまで動くかは [動くもの / まだ動かないもの](#動くもの--まだ動かないもの) を参照してください。
> スクリーンショットとデモは Phase 10 で用意します。

---

## 目次

- [3 分で見るなら](#3-分で見るなら)
- [このリポジトリで見てほしいところ](#このリポジトリで見てほしいところ)
- [技術スタック](#技術スタック)
- [アーキテクチャ](#アーキテクチャ)
- [品質への取り組み](#品質への取り組み)
- [CI](#ci)
- [開発の始め方](#開発の始め方)
- [動くもの / まだ動かないもの](#動くもの--まだ動かないもの)
- [スクリプト一覧](#スクリプト一覧)
- [ロードマップ](#ロードマップ)
- [ドキュメント](#ドキュメント)

---

## 3 分で見るなら

コードを全部読む必要はありません。この 4 つだけ見れば、このリポジトリで何をやっているかは伝わります。

| 見るもの                                                                 | 何が分かるか                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`packages/geo/src/search-cells.ts`](./packages/geo/src/search-cells.ts) | D1 に地理空間拡張がない制約を、geohash 精度の実測値で埋めている箇所                 |
| [`packages/core/src/identifier.ts`](./packages/core/src/identifier.ts)   | `unique symbol` ブランド型で、ID の取り違えをコンパイルエラーにしている箇所         |
| [`packages/core/src/open-status.ts`](./packages/core/src/open-status.ts) | 日跨ぎ営業時間（「18:00 - 翌 1:30」）を扱う営業中判定。テストが最も厚い部分         |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)                 | 何を CI で機械的に守っているか（カバレッジ 100% / ミューテーションスコア 85% 下限） |

数字の裏取りは [品質への取り組み § 実測値](#4-実測値2026-09-15-時点) にコマンドごと載せてあります。

---

## このリポジトリで見てほしいところ

設計書（`docs/superpowers/specs/2026-09-15-meshimap-design.md` §1）で掲げている主張は 4 点です。
このうち 2・3 は実装済み、1 は設計のみ、4 は未着手です。

| #   | 主張                                                                         | 現状                                                       |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | ロール別アクセス制御を、忘れようがない形で型に埋め込む                       | 設計済み / Phase 4 で実装                                  |
| 2   | 制約のある環境（D1）で地理空間検索を成立させる                               | **実装済み**（`packages/geo`）                             |
| 3   | テストが機能していることを機械的に証明する                                   | **実装済み**（下記 [品質への取り組み](#品質への取り組み)） |
| 4   | ネイティブ機能を使いこなす（位置情報 / 地図 / 画像 / 通知 / ディープリンク） | Phase 6 以降で実装                                         |

### D1 に地理空間拡張がないという制約への対処

Cloudflare D1 は R\*Tree / Geopoly を持たず、SQL 内の三角関数にも依存できません。
そこで半径検索を 3 段に分け、SQL 側では数学関数を一切使わない設計にしています。

| 段  | 使う関数         | 実行場所                                       | 役割                                   | 状態           |
| --- | ---------------- | ---------------------------------------------- | -------------------------------------- | -------------- |
| 1   | `cellsForRadius` | SQL（geohash の前方一致 `GLOB 'xn774c*'`）     | B-tree インデックスで数万件 → 数百件へ | 関数は実装済み |
| 2   | `boundingBox`    | SQL（`WHERE lat BETWEEN … AND lng BETWEEN …`） | 矩形で数百件 → 数十件へ                | 関数は実装済み |
| 3   | `distanceMeters` | Worker の TypeScript（Haversine）              | 正確な円内判定と距離順ソート           | 関数は実装済み |

`shops.geohash` は precision 7 固定（`SHOP_GEOHASH_PRECISION = 7`）で保持し、`cellsForRadius` は
半径に応じて precision 3〜7 のセルを返します。保存値より粗いセルで絞るため、第 1 段は等値比較ではなく
**前方一致**になります（設計書 §3.1 と `apps/api/src/db/schema/shop.ts` のコメントを参照）。

precision の閾値（p7=106m / p6=611m / p5=3395m / p4=19546m / p3=109202m）は、日本国内（緯度 24〜46 度）の
セル最小辺を実測して決めています。詳細は [`packages/geo/README.md`](./packages/geo/README.md) にあります。

> この 3 段を組み立てる**クエリ本体（`queries/nearby-shops.ts`）は Task 3-13 でまだ未実装**です。
> 現時点で存在するのは、3 段それぞれが使う純粋関数と、それらのテストです。

### RLS がないという制約への対処（Phase 4 で実装予定）

D1 に行レベルセキュリティはありません。権限チェックの書き忘れを**型で防ぐ**方針を採ります。

```ts
// 呼び出し側が権限チェックを忘れられる形は採らない
updateShop(shopId: string, data: ShopUpdate): Promise<Shop>

// 「誰として」操作するかを渡さないとコンパイルが通らない形にする
updateShopAsOwner(db: Db, actor: OwnerActor, shopId: ShopId, data: ShopUpdate): Promise<Shop>
//                           ^^^^^^^^^^^^^^ 認証ミドルウェア内でしか生成できないブランド型
```

---

## 技術スタック

バージョンは 2026-09-15 時点で `node_modules/<パッケージ>/package.json` から読んだ**実インストール値**です
（`package.json` の `^` / `~` 付き宣言値ではありません）。

### モバイル（`apps/mobile`）

| 領域             | 採用                                    | バージョン          | 選定理由                                                         |
| ---------------- | --------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| フレームワーク   | Expo（Dev Client + Prebuild）           | `57.0.22`           | 実機ネイティブ機能を使いつつ、ビルド環境の管理コストを下げるため |
| ランタイム       | React Native / React                    | `0.86.3` / `19.2.3` | —                                                                |
| ルーティング     | expo-router                             | `57.0.21`           | ファイルベースでロールごとのルートグループを表現できるため       |
| スタイル         | NativeWind / Tailwind CSS               | `4.2.7` / `3.4.19`  | デザイントークンを 1 箇所（`tailwind.config.js`）に集約するため  |
| 地図             | react-native-maps                       | `1.27.2`            | ネイティブ地図とカスタムマーカーを扱うため                       |
| ボトムシート     | @gorhom/bottom-sheet                    | `5.2.14`            | 地図画面の 3 段スナップシートに使うため                          |
| アニメーション   | react-native-reanimated                 | `4.5.1`             | 折りたたみヘッダー・シート連動を UI スレッドで動かすため         |
| 図形描画         | react-native-svg                        | `15.15.4`           | ダッシュボードの折れ線グラフを自前実装するため                   |
| サーバ状態       | TanStack Query                          | `5.102.8`           | キャッシュと楽観的更新を宣言的に扱うため                         |
| クライアント状態 | Zustand                                 | `5.0.15`            | 地図ビューポート・検索フィルタなどの局所状態用                   |
| フォーム         | React Hook Form / Zod                   | `7.88.0` / `4.6.5`  | バリデーションスキーマを `packages/core` と共有するため          |
| アイコン         | lucide-react-native                     | `1.46.0`            | —                                                                |
| フォント         | @expo-google-fonts/outfit, noto-sans-jp | `0.4.3`             | 見出し・数値と日本語本文でフォントを分けるため                   |

### バックエンド（`apps/api`）

| 領域           | 採用                              | バージョン           | 選定理由                                                            |
| -------------- | --------------------------------- | -------------------- | ------------------------------------------------------------------- |
| 実行環境       | Cloudflare Workers                | —                    | エッジ実行とゼロ運用コスト                                          |
| フレームワーク | Hono                              | `4.13.7`             | RPC 型（`hc<AppType>`）で API 型をモバイルへ直接流せるため          |
| DB             | Cloudflare D1（SQLite）           | —                    | Workers とバインディングで直結でき、無料枠で完結するため            |
| ORM            | Drizzle ORM / drizzle-kit         | `0.45.2` / `0.31.10` | スキーマ定義からマイグレーションを生成でき、型が素の SQL に近いため |
| 認証           | Better Auth / @better-auth/expo   | `1.7.5` / `1.7.5`    | Drizzle アダプタと Expo（SecureStore）を公式サポートするため        |
| ストレージ     | R2 / Workers KV / Durable Objects | —                    | 写真 / 集計キャッシュ / 予約枠の直列化（すべて Phase 7 以降）       |
| CLI            | Wrangler                          | `4.131.2`            | —                                                                   |
| ローカル D1    | miniflare                         | `5.20260911.1-alpha` | テストから実際の D1（SQLite）を起動して制約を検証するため           |

### 共有パッケージ・開発基盤

| 領域                       | 採用                                             | バージョン                          |
| -------------------------- | ------------------------------------------------ | ----------------------------------- |
| 言語                       | TypeScript                                       | `6.0.3`                             |
| モノレポ                   | npm workspaces                                   | Node `>=22.0.0`（`.nvmrc` 22.23.2） |
| テスト（パッケージ / API） | Vitest + @vitest/coverage-v8                     | `5.0.0` / `5.0.0`                   |
| テスト（モバイル）         | Jest + jest-expo + @testing-library/react-native | `30.5.1` / `57.0.5` / `14.0.1`      |
| ミューテーションテスト     | Stryker                                          | `10.0.0`                            |
| Lint                       | ESLint + eslint-config-expo                      | `apps/mobile` のみ                  |
| フォーマッタ               | Prettier + prettier-plugin-tailwindcss           | `3.9.6` / `0.8.1`                   |

---

## アーキテクチャ

### モノレポ構成

実在するファイルのみを載せています（2026-09-15 時点）。

```
meshimap/
├── apps/
│   ├── mobile/                    # Expo アプリ
│   │   ├── jest.config.js         # カバレッジしきい値 100%（src/app/ は除外）
│   │   ├── eslint.config.js       # リポジトリ内で唯一の ESLint 設定
│   │   └── src/
│   │       ├── app/               # 画面。現状は _layout / index / _dev/catalog のみ
│   │       ├── components/ui/     # 汎用プリミティブ 8 種（badge / button / card /
│   │       │                      #   empty-state / error-state / icon / input / skeleton）
│   │       ├── constants/         # api / auth / fonts / http / theme
│   │       ├── features/auth/     # 型のみ（実装は Phase 5）
│   │       ├── hooks/             # use-app-fonts
│   │       └── lib/               # logger
│   └── api/                       # Cloudflare Workers
│       ├── wrangler.jsonc         # D1 / R2 / KV / Durable Object のバインディング宣言
│       ├── drizzle.config.ts
│       ├── migrations/            # 0000_init.sql（25 テーブル）/ 0001_shops_fts.sql（FTS5 + トリガ 3 本）
│       ├── scripts/               # generate-seed.ts（決定的なシード SQL の生成）
│       ├── seeds/seed.sql         # 生成物。1 行 1 文で 1247 文（店舗 60 / レビュー 109）
│       └── src/db/
│           ├── constants.ts       # 列挙値・数値範囲
│           ├── sql-helpers.ts     # CHECK 式ヘルパ
│           ├── client.ts          # Drizzle クライアント
│           ├── fts.ts             # FTS5 クエリ文字列の組み立て
│           ├── schema/            # Drizzle スキーマ 9 ファイル + バレル（25 テーブル）
│           └── testing/           # miniflare によるローカル D1 ハーネス
├── packages/
│   ├── geo/                       # geohash / Haversine / 境界ボックス / クラスタリング（完了）
│   └── core/                      # ロール / 営業時間 / 予約枠 / 評価 / Zod スキーマ（完了）
├── .github/workflows/             # ci.yml（6 ジョブ）/ mutation.yml（週次・手動）
└── docs/
    ├── CODING_GUIDELINES.md
    └── superpowers/
        ├── specs/                 # 設計書
        └── plans/                 # フェーズ別の実装計画（Phase 0〜6 を作成済み）
```

`apps/api/src/index.ts`（Worker のエントリポイント）、`routes/`、`middleware/` は
**まだありません**。Phase 4 で作ります。

`packages/geo` と `packages/core` は **I/O を持たない純粋関数のみ**です。
`packages/geo` の `dependencies` は空、`packages/core` は `@meshimap/geo` と `zod` だけに依存します。
アプリの「判断」をここに集約し、Workers と React Native の両方から同じコードを呼びます。

### データフロー（Phase 4 以降で接続予定）

```
apps/mobile (Expo / React Native)
   │  Hono RPC クライアント（hc<AppType>）— API のレスポンス型を二重定義しない
   │  セッションは expo-secure-store に保存
   ▼
apps/api (Cloudflare Workers / Hono)
   ├─ middleware/  認証 → ロール検証 → Actor ブランド型を生成
   ├─ repositories/ 権限主体（OwnerActor 等）を引数に要求する DB アクセス
   │     │
   │     ├──▶ D1 (SQLite)   店舗 / レビュー / 予約 / 認証。geohash + lat/lng インデックス
   │     ├──▶ R2            店舗写真 / レビュー写真 / アバター
   │     ├──▶ Workers KV    集計キャッシュ（人気店ランキング等）
   │     └──▶ Durable Objects  予約枠の二重押さえ防止（店舗ごとに直列化）
   │
   └─ packages/geo, packages/core を直接 import（モバイルと同一コード）
```

この図のうち**現在存在するのは D1 のスキーマとマイグレーションだけ**です。
`middleware/` `repositories/` と R2 / KV / Durable Objects の利用は Phase 4 以降です。

---

## 品質への取り組み

このプロジェクトの主眼は「テストを書いた」ではなく「**テストが実際に間違いを捕まえられることを証明した**」
状態を作ることです。

### 1. TDD（Red → Green → Refactor）

全タスクを次の順で進めています。実装計画（`docs/superpowers/plans/`）自体が
このステップをチェックボックスとして持っています。

1. **Red** — 振る舞いのテストを書き、**実行して失敗することを確認する**
2. **Green** — 通す最小限の実装を書く
3. **Refactor** — 緑のまま整理する

### 2. 「テストをわざと壊して、落ちることを確認する」ステップ

Red の確認だけでは、テストが実装と無関係に通っている場合に気づけません。
そこで各タスクの末尾に **「実装コードを意図的に壊し、テストが検知することを確認する」ステップ**
を置いています。2026-09-15 時点の実装計画には合計 **119 箇所**このステップが埋め込まれています。

```bash
# 数え直す（チェックボックス形式の Step 行のうち「壊す」を含むもの）
grep -cE '^- \[[ x]\] \*\*Step [^*]*壊' docs/superpowers/plans/2026-09-15-phase-*.md
```

| Phase                    |   0 |   1 |   2 |   3 |   4 |   5 |   6 | 合計 |
| ------------------------ | --: | --: | --: | --: | --: | --: | --: | ---: |
| 明示的な Step として記載 |   1 |  11 |  13 |  17 |  14 |  23 |  40 |  119 |

Phase 0 だけ 1 件なのは、Task 0-8〜0-13（UI プリミティブ）が「Task 0-7 と同じ手順で進める」と
まとめて書かれており、破壊ステップを個別の行に展開していないためです（実施はしています）。

### 3. ミューテーションテスト（Stryker、しきい値 85%）

Stryker が実装コードを機械的に書き換え（`>` → `>=`、条件を `true` 固定、ブロックを空に、など）、
その改変版でテストが落ちるかを確認します。落ちなければ、そのテストはその挙動を検証できていません。

設定は [`stryker.base.mjs`](./stryker.base.mjs) に集約し、各ワークスペースの
`stryker.config.mjs` は対象ファイルの指定だけを渡します。`thresholds.break: 85` を
設定しているのでスコアが 85% を下回るとコマンドが失敗します（`high: 95` / `low: 85` も設定）。
対象は `src/**/*.ts` から `*.test.ts` と `index.ts`（再エクスポートのみのバレル）を除いたものです。

JSON ではなく `.mjs` にしているのは、**設定値の根拠をコメントで残すため**です。
「なぜ `vitest` ランナーではなく `command` ランナーなのか」「なぜ `--no-file-parallelism` が必須なのか」は
いずれも実測に基づく判断で、値だけ残しても後から検証できません。

> **`stryker.config.mjs` があるのは `packages/core` / `packages/geo` / `apps/api` の 3 つです。**
> `apps/mobile` にはスクリプトも設定もありません（Jest 側で実行しているため）。
>
> ```bash
> npm run test:mutation -w @meshimap/core -w @meshimap/geo -w @meshimap/api
> ```

#### 並列度を絞っている理由（誤ったスコアを 1 度出しているため）

`command` ランナーは 1 変異ごとに `npx vitest run` を新しいプロセスで起動します。
この子プロセスがさらにワーカーを張ると、24 コアの機械では
「Stryker 23 プロセス × vitest ワーカー約 15」で 300 プロセスを超え、全体が停滞します。

最初の `apps/api` の計測はこの状態で走り、**98 変異中 94 件が Timeout**になりました。
Stryker は Timeout を Killed として数えるため、スコアは「100%」と表示されます。
つまり**テストが 1 件も走っていないのに満点が出ていました**。

対策として `stryker.base.mjs` で次の 3 つを固定しています。

| 設定                                   | 理由                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `npx vitest run --no-file-parallelism` | 子プロセスのワーカー分裂を止め、1 変異 = 2 プロセスに固定                  |
| `concurrency = コア数 / 2`             | 上の 2 プロセスぶんを見込んでコア数に収める                                |
| `timeoutMS`（api は 20 秒）            | api は素の 1 回が実測 22 秒（miniflare 起動 + マイグレーション）と重いため |

`timeoutMS` は「1 回の実行にかけてよい上限」ではなく**上乗せ分**です。
実際の打ち切りは `timeoutFactor * netTime + timeoutMS + timeOverheadMS`
（`@stryker-mutator/core/dist/src/mutants/mutant-test-planner.js:124`、`timeoutFactor` の既定は 1.5）で、
`netTime` は初回のドライランで測った素の実行時間です。
api なら `1.5 × 22 秒 + 20 秒 ≈ 53 秒`。ここを素の実行時間と取り違えると、
「22 秒かかるのに 20 秒で打ち切られるのでは」という誤読になります。

#### 残る Timeout は無限ループで、Killed 扱いが正しい

上の対策後も `packages/core` に 9 件、`packages/geo` に 8 件の Timeout が残ります。
これは並列度の問題ではなく、**変異そのものが無限ループを作る**ケースです。
JSON レポートで内訳を確認しました。

| 変異                                                      | なぜ止まらないか                                                |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `geohash.ts:63` `bitCount += 1` → `-=`                    | `bitCount` が `BITS_PER_CHARACTER` に到達せず `hash` が伸びない |
| `geohash.ts:65` 文字追加の `if` を `false` / 空ブロックに | 同上。`while (hash.length < precision)` が終わらない            |
| `geohash.ts:54` `characterIndex * 2 + 1` → `- 1`          | 添字が負になり `charAt` が空文字を返すので `hash` が伸びない    |
| `constants.ts:15` `GEOHASH_BASE32` → `''`                 | 同上。`''.charAt(n)` は常に空文字                               |
| `geohash.ts:124` `bitPosition -= 1` → `+=`                | デコード側の `for` が終わらない                                 |
| `reservation-slot.ts:32-37,71` 引数検証を無効化           | `slotMinutes` が 0 でも通り、`start += 0` が終わらない          |

無限ループを止める手段はタイムアウトしか無いので、これらを Killed と数えるのは正しい判定です。
`stryker.base.mjs` で `json` レポーターを有効にしているのは、この内訳を後から検証できるようにするためです。

対策の効きは `apps/api` の再計測で確認できます。同じ 98 変異が **Killed 98 / Timeout 0** になり、
`Ran 1.00 tests per mutant on average`（対策前は `0.04`）と出ました。
変異あたり 1 件のテストが実際に走った、という意味です。

### 4. 実測値（2026-09-15 時点）

以下は 2026-09-15 に Node 22.23.2（macOS）でローカル実行した結果です。
再現コマンドは表の下にまとめてあります。

| ワークスペース  | テスト                   | カバレッジ                                                                               | ミューテーションスコア                                    |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/core` | 13 ファイル / **326 件** | Stmts 100% (226/226) / Branch 100% (129/129) / Funcs 100% (49/49) / Lines 100% (219/219) | **100%**（609 変異: Killed 600 / Timeout 9 / Survived 0） |
| `packages/geo`  | 9 ファイル / **205 件**  | Stmts 100% (182/182) / Branch 100% (84/84) / Funcs 100% (22/22) / Lines 100% (181/181)   | **100%**（360 変異: Killed 352 / Timeout 8 / Survived 0） |
| `apps/api`      | 16 ファイル / **262 件** | しきい値なし（`vitest.config.ts` に `thresholds` を置いていない）                        | **100%**（98 変異: Killed 98 / Timeout 0 / Survived 0）   |
| `apps/mobile`   | 19 スイート / **128 件** | Stmts 100% (100/100) / Branch 100% (80/80) / Funcs 100% (17/17) / Lines 100% (97/97)     | 対象外（設定もスクリプトも無し。Jest で実行しているため） |

合計 921 件。再現に使ったコマンドは次のとおりです。

```bash
cd packages/core && npx vitest run --coverage   # 13 files / 326 tests
cd packages/geo  && npx vitest run --coverage   #  9 files / 205 tests
cd apps/api      && npx vitest run              # 16 files / 262 tests
cd apps/mobile   && npx jest --coverage         # 19 suites / 128 tests

# 7m04s（api 3m16s → core 2m37s → geo 1m11s の直列。exit 0、3 つとも 100%）
npm run test:mutation
```

`apps/api` だけ変異 1 件あたりが重いのは、`npx vitest run` のたびに miniflare を起動して
D1 のマイグレーションを流し直すためです（98 変異で 3m32s。1 変異あたり約 2 秒）。

カバレッジの母集団に注意点があります。

- `packages/core` / `packages/geo`: `vitest.config.ts` で `src/index.ts`（バレル）と `*.test.ts` を除外し、
  残りに lines / functions / branches / statements 100% を**必須**にしています。
- `apps/mobile`: `jest.config.js` の `collectCoverageFrom` で `src/app/**`（画面）を除外し、
  残りに 100% を必須にしています。画面ができる Phase 5 の最後にこの除外を外し、
  代わりに `!src/app/_dev/**`（開発者向け UI カタログ。製品の画面ではない）だけを残します。
- `apps/api`: カバレッジしきい値はまだ設定していません。Phase 3 が実装途中のためです。

> Stryker の `testRunner` は `vitest` ではなく `command`（`npx vitest run --silent`）を使っています。
> `@stryker-mutator/vitest-runner@10.0.0` は `vitest@5.0.0` と組み合わせると変異ごとにテストを実行できず、
> スコアが実態より大幅に低く出るためです。詳細は [`packages/geo/README.md`](./packages/geo/README.md) に記録しています。

### 5. TypeScript の厳格設定

型の厳格さだけを `tsconfig.strict.json` に切り出しています。
`packages/*` と `apps/api` は `tsconfig.base.json` 経由で、`apps/mobile` は
`expo/tsconfig.base` と併せて直接継承しています。

| オプション                              | 効果                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `strict`                                | 厳格チェック一式                                           |
| `noUncheckedIndexedAccess`              | 配列・インデックスアクセスの結果を `T \| undefined` にする |
| `noImplicitOverride`                    | オーバーライドに `override` を必須にする                   |
| `noFallthroughCasesInSwitch`            | `switch` の case 抜けを禁止                                |
| `noUnusedLocals` / `noUnusedParameters` | 未使用の変数・引数を禁止                                   |
| `exactOptionalPropertyTypes`            | `?:` に `undefined` を明示代入できないようにする           |
| `forceConsistentCasingInFileNames`      | ファイル名の大文字小文字を一貫させる                       |
| `verbatimModuleSyntax`                  | 型 import / 値 import を明示させる                         |

加えて、コーディング規約（`docs/CODING_GUIDELINES.md` §2）で `any` / `as` / `!` / `console.log` /
マジックナンバー / 根拠のない `// TODO` / デフォルトエクスポートを禁止しています
（`as` はブランド型の生成点のみ、`default` は expo-router の画面ファイルのみ例外）。

### 6. ブランド型による型安全性

`string` 同士は取り違えてもコンパイルが通るため、ID・座標・権限主体をブランド型にしています。

```ts
// packages/core/src/identifier.ts — ID の取り違えをコンパイルエラーにする
declare const shopIdBrand: unique symbol;
declare const userIdBrand: unique symbol;

export type ShopId = string & { readonly [shopIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };

// packages/geo — 範囲チェックを通った値しか作れない
const center = coordinate(35.689592, 139.700413); // Latitude / Longitude / Geohash も同様
```

ブランドのキーに文字列リテラル（`{ __brand: 'ShopId' }`）ではなく `declare const ... : unique symbol` を
使っているのは、文字列キーだとブランドを手書きして偽造できてしまうためです。`unique symbol` は
宣言したモジュールの外から書けないため、ファクトリ関数を通る以外に値を作る経路がありません。

範囲外の緯度経度や未知のロール値は、専用ファクトリ（`toLatitude` / `toRole` など）で弾かれます。
ファクトリを経由しない生成経路を公開しないことで、不正値がドメインに入る経路を型レベルで塞いでいます。

---

## CI

GitHub Actions のワークフローは 2 本です。

### [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — 6 ジョブ

`main` への push と全 pull request で走ります。6 ジョブは互いに依存させず並列に回し、
同一ブランチへの連続 push では古い実行を打ち切ります（`concurrency.cancel-in-progress: true`）。
Node のバージョンは YAML に直書きせず `.nvmrc` を唯一の正とし、依存は `npm ci` で入れます。

| ジョブ          | 実行内容                                                                   | ねらい                                                                                 |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `typecheck`     | `npm run typecheck -w @meshimap/geo -w @meshimap/core -w @meshimap/mobile` | `apps/api` は `test-api` 側へ隔離しているのでここでは対象を明示                        |
| `lint`          | `apps/mobile` で `npx eslint .`                                            | ESLint 設定を持つのは `apps/mobile` だけ。`expo lint` は未設定時に対話に入るため直叩き |
| `format`        | `npm run format:check`                                                     | Prettier の差分検出                                                                    |
| `test-packages` | `npm run test:coverage -w @meshimap/geo -w @meshimap/core`                 | `test` ではなく `test:coverage`。100% しきい値はカバレッジ経由でしか効かない           |
| `test-mobile`   | `npm run test:coverage -w @meshimap/mobile`                                | 同上。`coverageThreshold` は `--coverage` 時のみ評価される                             |
| `test-api`      | `npm run typecheck -w @meshimap/api` → `npm run test -w @meshimap/api`     | miniflare でローカル D1 を起動するため時間がかかる（timeout 20 分）                    |

### [`.github/workflows/mutation.yml`](./.github/workflows/mutation.yml) — 週次 / 手動

`workflow_dispatch` と週次 cron（日曜 18:00 UTC = 月曜 03:00 JST）でのみ走ります。
`@meshimap/geo` と `@meshimap/core` の matrix ジョブで、`fail-fast: false`（片方が落ちても
もう片方のスコアを取る）です。

毎 push では回しません。core だけで約 2 分かかり、push のたびに待たされると CI 自体が
見られなくなるためです。しきい値割れは週明けに気づけば足りる、という判断です。

---

## 開発の始め方

### 必要環境

- **Node.js 22 以上**（`package.json` の `engines.node` は `>=22.0.0`、`.nvmrc` は `22.23.2`）
- iOS / Android の実機またはシミュレータ（Expo Dev Client を使うため、Expo Go では動きません）
- Cloudflare アカウント — **リモートの D1 / KV へ適用するときとデプロイ時のみ**必要です。
  ローカルのテスト（miniflare）にはログインもアカウントも不要です。

### セットアップ

```bash
nvm use            # .nvmrc の 22.23.2 を使う
npm install        # ルートで実行（npm workspaces が全パッケージを解決する）
npm test           # 全ワークスペースのテストを実行
```

### 動かす

```bash
npm run mobile         # Expo 開発サーバを起動
npm run mobile:ios     # iOS シミュレータで起動
npm run mobile:android # Android エミュレータで起動
```

`npm run api:dev`（`wrangler dev`）は**まだ起動しません**。`wrangler.jsonc` の `main` が指す
`src/index.ts` が存在せず、`The entry-point file at "src/index.ts" was not found.` で終了します。
Worker のエントリポイントは Phase 4 の成果物です。
現時点で `apps/api` を触るなら、miniflare で実 D1 を立ち上げるテスト（`npm run test -w @meshimap/api`）が
唯一の動作確認手段です。

> `apps/api/wrangler.jsonc` の `database_id` / KV の `id` はプレースホルダのままです。
> リモートの D1 / KV へ適用・デプロイするときに、`wrangler d1 create` /
> `wrangler kv namespace create` で作成した ID に差し替えてください。

---

## 動くもの / まだ動かないもの

### 動くもの

- `packages/geo` / `packages/core` の全 API（テスト 531 件、カバレッジ・ミューテーションとも 100%）
- `apps/mobile` の UI プリミティブ 8 種とカタログ画面（`src/app/_dev/catalog.tsx`）
- `apps/api` の Drizzle スキーマ 25 テーブル、マイグレーション 2 本、miniflare によるローカル D1 テスト
- `npm run db:reset:local`（`apps/api`）。ローカル D1 を捨てて 2 本のマイグレーションを流し直し、
  シード 1247 文を投入するところまで通ります。実測で店舗 60 / レビュー 109 / `shops_fts` 60 件、
  `shops_fts MATCH '"メンヤ"'` が 2 件ヒット（miniflare 経由のテストと同じ値）
- 4 ワークスペースのテスト（[実測値](#4-実測値2026-09-15-時点)のコマンド）と
  ルートの `npm run test:mutation`（`@meshimap/api` / `@meshimap/core` / `@meshimap/geo` の 3 つを直列実行。約 7 分）

> ルートの `npm test` / `npm run typecheck` / `npm run format:check` は全ワークスペースへ委譲するため、
> Phase 3 の作業中は `apps/api` の途中成果物で一時的に赤くなることがあります。
> 完了済みのワークスペース単体で確認したいときは `-w` を付けてください。

### まだ動かないもの

README に書かれていても、以下は**まだ動きません**。

| 項目                                                                                | 理由 / 予定                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `npm run api:dev`                                                                   | `apps/api/src/index.ts` が未作成（Phase 4） |
| 全 61 画面（認証 5 / 利用者 24 / 店舗管理者 18 / システム管理者 13 / ルート直下 1） | Phase 5 以降                                |
| API のルート・認証ミドルウェア・ロールガード・リポジトリ層                          | Phase 4                                     |
| `OwnerActor` / `AdminActor` ブランド型による権限制御                                | Phase 4                                     |
| 3 段構え検索のクエリ本体（`queries/nearby-shops.ts`）                               | Task 3-13                                   |
| R2 / Workers KV / Durable Objects の利用                                            | Phase 7 以降（`wrangler.jsonc` に宣言のみ） |
| プッシュ通知、ディープリンク、スクリーンショット、デモ動画                          | Phase 10                                    |

---

## スクリプト一覧

### ルート（全ワークスペースへ委譲）

| コマンド                                           | 内容                                           | 備考                              |
| -------------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `npm test`                                         | 全ワークスペースのテストを実行                 | —                                 |
| `npm run test:watch`                               | 同上（watch）                                  | —                                 |
| `npm run test:mutation`                            | 全ワークスペースのミューテーションテストを実行 | 直列で約 7 分（api → core → geo） |
| `npm run typecheck`                                | 全ワークスペースの型検査                       | —                                 |
| `npm run format` / `format:check`                  | Prettier による整形 / 検査                     | —                                 |
| `npm run mobile` / `mobile:ios` / `mobile:android` | Expo 開発サーバ                                | —                                 |
| `npm run api:dev`                                  | `wrangler dev`                                 | **現在は起動しない**（Phase 4）   |

ルートに Lint スクリプトはありません。ESLint 設定を持つのは `apps/mobile` だけです。

### `apps/mobile`（`-w @meshimap/mobile`）

| コマンド                                | 内容                                          |
| --------------------------------------- | --------------------------------------------- |
| `start` / `ios` / `android` / `web`     | Expo 開発サーバ                               |
| `test` / `test:watch` / `test:coverage` | Jest                                          |
| `lint`                                  | `expo lint`（CI は `npx eslint .` を直叩き）  |
| `typecheck`                             | `tsc --noEmit`                                |
| `prebuild`                              | `expo prebuild`（ネイティブプロジェクト生成） |

### `apps/api`（`-w @meshimap/api`）

| コマンド                                                | 内容                                       | 状態                         |
| ------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| `test` / `test:watch`                                   | Vitest（miniflare でローカル D1 を起動）   | 動く                         |
| `typecheck`                                             | `tsc --noEmit`                             | 動く                         |
| `db:generate`                                           | Drizzle スキーマからマイグレーション生成   | 動く                         |
| `db:migrate:local` / `db:migrate:remote`                | D1 へマイグレーション適用                  | remote は Cloudflare 要      |
| `db:studio`                                             | `drizzle-kit studio`                       | 動く                         |
| `cf-typegen`                                            | `wrangler types`（バインディングの型生成） | 動く                         |
| `dev` / `deploy`                                        | `wrangler dev` / `wrangler deploy`         | `src/index.ts` 未作成で不可  |
| `test:mutation`                                         | `stryker run`                              | 動く（`stryker.config.mjs`） |
| `db:seed:generate` / `db:seed:local` / `db:reset:local` | シード SQL の生成 / 適用 / 作り直し        | 動く（実測）                 |

### `packages/core` / `packages/geo`

| コマンド              | 内容                        |
| --------------------- | --------------------------- |
| `test` / `test:watch` | Vitest                      |
| `test:coverage`       | カバレッジ（しきい値 100%） |
| `test:mutation`       | Stryker（しきい値 85%）     |
| `typecheck`           | `tsc --noEmit`              |

---

## ロードマップ

全 11 フェーズ。タスク数は `docs/superpowers/plans/README.md`（2026-09-15 時点）に基づきます。
Phase 6 到達時点で「動くポートフォリオ」として成立する計画です。

| Phase | 内容                                                      |   タスク数 | 状態              |
| ----- | --------------------------------------------------------- | ---------: | ----------------- |
| 0     | モノレポ基盤 / デザインシステム / UI プリミティブ         |         14 | ✅ 完了           |
| 1     | `packages/geo`（地理計算）を TDD で実装                   |         13 | ✅ 完了           |
| 2     | `packages/core`（ドメインロジック）を TDD で実装          |         13 | ✅ 完了           |
| 3     | D1 スキーマ / マイグレーション / シード                   |         15 | 🚧 進行中（3-12） |
| 4     | API 基盤（Hono / 認証 / ロールガード / ブランド型 Actor） |     執筆中 | 計画を執筆中      |
| 5     | モバイル認証 + ロールルーティング                         |         21 | 計画済み・未着手  |
| 6     | 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / 保存）    |         37 | 計画済み・未着手  |
| 7     | 予約（利用者 + 店舗側承認 + Durable Objects）             | 13（見込） | 計画書なし        |
| 8     | 店舗管理者（ダッシュボード / 店舗編集 / メニュー / 返信） | 19（見込） | 計画書なし        |
| 9     | システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ）   | 15（見込） | 計画書なし        |
| 10    | 仕上げ（通知 / ディープリンク / README / デモ）           | 10（見込） | 計画書なし        |

計画書が確定しているフェーズ（0〜3 / 5 / 6）の合計は 113 タスク、見込みのみのフェーズ（7〜10）が
57 タスクで、**合計 170 + Phase 4 分**です。

**見込み値は当てになりません。** Phase 3 / 5 / 6 は計画書を書く段階でそれぞれ 12 → 15、9 → 21、
22 → 37 に増えました。Phase 7〜10 も同様に増える前提で読んでください。

Phase 3 の細かい進捗は `docs/superpowers/plans/2026-09-15-phase-3-database.md` の
チェックボックスを参照してください。

---

## ドキュメント

| ファイル                                                                                                         | 内容                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`docs/superpowers/specs/2026-09-15-meshimap-design.md`](./docs/superpowers/specs/2026-09-15-meshimap-design.md) | 設計書（技術選定 / 制約と対処 / 61 画面の構成 / データモデル / テスト戦略） |
| [`docs/CODING_GUIDELINES.md`](./docs/CODING_GUIDELINES.md)                                                       | コーディング規約（命名 / 禁止パターン / コンポーネント設計 / 型 / テスト）  |
| [`docs/superpowers/plans/README.md`](./docs/superpowers/plans/README.md)                                         | フェーズ別実装計画のインデックスと進捗                                      |
| [`apps/mobile/README.md`](./apps/mobile/README.md)                                                               | モバイルアプリの起動方法とディレクトリ責務                                  |
| [`packages/geo/README.md`](./packages/geo/README.md)                                                             | 地理計算パッケージの設計方針と 3 段階検索                                   |
| [`packages/core/README.md`](./packages/core/README.md)                                                           | ドメインパッケージの設計方針と公開 API                                      |

ライセンスは [MIT](./LICENSE) です。
