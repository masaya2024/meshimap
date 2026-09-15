# MeshiMap

地図を主役にしたグルメ発見・予約のネイティブアプリ。**利用者 / 店舗管理者 / システム管理者**の
3 ロールが 1 つのコードベースで共存する業務アプリ相当の設計を、Expo + Cloudflare Workers で実装する
ポートフォリオプロジェクトです。

> **現在の状況: 開発中（Phase 3 / 全 11 フェーズ中）。**
> 完成済みは共有ロジック（`packages/geo` / `packages/core`）、モバイルの UI プリミティブ、
> API の D1 スキーマ基盤までです。画面・API エンドポイントは未実装です。
> 何がどこまで動くかは [ロードマップ](#ロードマップ) を参照してください。
> スクリーンショットとデモは Phase 10 で用意します。

---

## 目次

- [このリポジトリで見てほしいところ](#このリポジトリで見てほしいところ)
- [技術スタック](#技術スタック)
- [アーキテクチャ](#アーキテクチャ)
- [品質への取り組み](#品質への取り組み)
- [開発の始め方](#開発の始め方)
- [スクリプト一覧](#スクリプト一覧)
- [ロードマップ](#ロードマップ)
- [ドキュメント](#ドキュメント)

---

## このリポジトリで見てほしいところ

設計書（`docs/superpowers/specs/2026-09-15-meshimap-design.md` §1）で掲げている主張は 4 点です。
このうち 1〜3 の土台部分は実装済みです。

| #   | 主張                                                                         | 現状                                                       |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | ロール別アクセス制御を、忘れようがない形で型に埋め込む                       | 設計済み / Phase 4 で実装                                  |
| 2   | 制約のある環境（D1）で地理空間検索を成立させる                               | **実装済み**（`packages/geo`）                             |
| 3   | テストが機能していることを機械的に証明する                                   | **実装済み**（下記 [品質への取り組み](#品質への取り組み)） |
| 4   | ネイティブ機能を使いこなす（位置情報 / 地図 / 画像 / 通知 / ディープリンク） | Phase 6 以降で実装                                         |

### D1 に地理空間拡張がないという制約への対処

Cloudflare D1 は R*Tree / Geopoly を持たず、SQL 内の三角関数にも依存できません。
そこで半径検索を 3 段に分け、SQL 側では数学関数を一切使わない設計にしています。

| 段  | 使う関数         | 実行場所                                       | 役割                                   |
| --- | ---------------- | ---------------------------------------------- | -------------------------------------- |
| 1   | `cellsForRadius` | SQL（`WHERE geohash IN (…)`）                  | B-tree インデックスで数万件 → 数百件へ |
| 2   | `boundingBox`    | SQL（`WHERE lat BETWEEN … AND lng BETWEEN …`） | 矩形で数百件 → 数十件へ                |
| 3   | `distanceMeters` | Worker の TypeScript（Haversine）              | 正確な円内判定と距離順ソート           |

詳細と実装は [`packages/geo/README.md`](./packages/geo/README.md) にあります。

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

バージョンは各 `package.json` の記載値です。

### モバイル（`apps/mobile`）

| 領域             | 採用                                    | バージョン           | 選定理由                                                         |
| ---------------- | --------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| フレームワーク   | Expo（Dev Client + Prebuild）           | `~57.0.22`           | 実機ネイティブ機能を使いつつ、ビルド環境の管理コストを下げるため |
| ランタイム       | React Native / React                    | `0.86.3` / `19.2.3`  | —                                                                |
| ルーティング     | expo-router                             | `~57.0.21`           | ファイルベースでロールごとのルートグループを表現できるため       |
| スタイル         | NativeWind / Tailwind CSS               | `^4.2.7` / `^3.4.19` | デザイントークンを 1 箇所（`tailwind.config.js`）に集約するため  |
| 地図             | react-native-maps                       | `1.27.2`             | ネイティブ地図とカスタムマーカーを扱うため                       |
| ボトムシート     | @gorhom/bottom-sheet                    | `^5.2.14`            | 地図画面の 3 段スナップシートに使うため                          |
| アニメーション   | react-native-reanimated                 | `4.5.1`              | 折りたたみヘッダー・シート連動を UI スレッドで動かすため         |
| 図形描画         | react-native-svg                        | `15.15.4`            | ダッシュボードの折れ線グラフを自前実装するため                   |
| サーバ状態       | TanStack Query                          | `^5.102.8`           | キャッシュと楽観的更新を宣言的に扱うため                         |
| クライアント状態 | Zustand                                 | `^5.0.15`            | 地図ビューポート・検索フィルタなどの局所状態用                   |
| フォーム         | React Hook Form / Zod                   | `^7.88.0` / `^4.6.5` | バリデーションスキーマを `packages/core` と共有するため          |
| アイコン         | lucide-react-native                     | `^1.46.0`            | —                                                                |
| フォント         | @expo-google-fonts/outfit, noto-sans-jp | `^0.4.3`             | 見出し・数値と日本語本文でフォントを分けるため                   |

### バックエンド（`apps/api`）

| 領域           | 採用                              | バージョン             | 選定理由                                                            |
| -------------- | --------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| 実行環境       | Cloudflare Workers                | —                      | エッジ実行とゼロ運用コスト                                          |
| フレームワーク | Hono                              | `^4.13.7`              | RPC 型（`hc<AppType>`）で API 型をモバイルへ直接流せるため          |
| DB             | Cloudflare D1（SQLite）           | —                      | Workers とバインディングで直結でき、無料枠で完結するため            |
| ORM            | Drizzle ORM / drizzle-kit         | `^0.45.2` / `^0.31.10` | スキーマ定義からマイグレーションを生成でき、型が素の SQL に近いため |
| 認証           | Better Auth / @better-auth/expo   | `^1.7.5`               | Drizzle アダプタと Expo（SecureStore）を公式サポートするため        |
| ストレージ     | R2 / Workers KV / Durable Objects | —                      | 写真 / 集計キャッシュ / 予約枠の直列化                              |
| CLI            | Wrangler                          | `^4.131.2`             | —                                                                   |
| ローカル D1    | miniflare                         | `5.20260911.1-alpha`   | テストから実際の D1（SQLite）を起動して制約を検証するため           |

### 共有パッケージ・開発基盤

| 領域                       | 採用                                             | バージョン                        |
| -------------------------- | ------------------------------------------------ | --------------------------------- |
| 言語                       | TypeScript                                       | `~6.0.3`                          |
| モノレポ                   | npm workspaces                                   | Node `>=22.0.0`                   |
| テスト（パッケージ / API） | Vitest + @vitest/coverage-v8                     | `^5.0.0`                          |
| テスト（モバイル）         | Jest + jest-expo + @testing-library/react-native | `^30.5.1` / `~57.0.5` / `^14.0.1` |
| ミューテーションテスト     | Stryker                                          | `^10.0.0`                         |
| フォーマッタ               | Prettier + prettier-plugin-tailwindcss           | `^3.9.6` / `^0.8.1`               |

---

## アーキテクチャ

### モノレポ構成

```
meshimap/
├── apps/
│   ├── mobile/                    # Expo アプリ
│   │   └── src/
│   │       ├── app/               # 画面（ルーティングと組み立てのみ）
│   │       ├── components/ui/     # 汎用プリミティブ（実装済み: 8 種）
│   │       ├── constants/         # theme / fonts
│   │       ├── hooks/             # use-app-fonts ほか
│   │       └── lib/               # logger ほか
│   └── api/                       # Cloudflare Workers
│       └── src/
│           └── db/
│               ├── constants.ts   # 列挙値・数値範囲（実装済み）
│               ├── sql-helpers.ts # CHECK 式ヘルパ（実装済み）
│               ├── schema/        # Drizzle スキーマ（auth / master を実装済み）
│               └── testing/       # miniflare によるローカル D1 ハーネス（実装済み）
├── packages/
│   ├── geo/                       # geohash / Haversine / 境界ボックス / クラスタリング（完了）
│   └── core/                      # ロール / 営業時間 / 予約枠 / 評価 / Zod スキーマ（完了）
└── docs/
    ├── CODING_GUIDELINES.md
    └── superpowers/
        ├── specs/                 # 設計書
        └── plans/                 # フェーズ別の実装計画
```

`packages/geo` と `packages/core` は **I/O を持たない純粋関数のみ**です。
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

半径検索は上記「3 段構え」のうち第 1・2 段を D1 の SQL で、第 3 段を Worker の TypeScript で実行します。

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
を必ず置いています。現在の実装計画には合計 **91 箇所**このステップが埋め込まれています。

```
docs/superpowers/plans/*.md 内の「意図的に壊して検知することを確認する」Step 数
  Phase 0: 2   Phase 1: 10   Phase 2: 14   Phase 3: 10
  Phase 4: 11  Phase 5: 17   Phase 6: 27
```

### 3. ミューテーションテスト（Stryker、しきい値 85%）

Stryker が実装コードを機械的に書き換え（`>` → `>=`、条件を `true` 固定、ブロックを空に、など）、
その改変版でテストが落ちるかを確認します。落ちなければ、そのテストはその挙動を検証できていません。

`stryker.config.json` で `thresholds.break: 85` を設定しており、スコアが 85% を下回ると失敗します。

### 4. 実測値

以下は実際にコマンドを実行して得た数値です（`packages/geo` / `packages/core` のカバレッジしきい値は
`vitest.config.ts` で 100% を必須にしています）。

| ワークスペース  | テスト                   | カバレッジ                                                                               | ミューテーションスコア                                    |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/core` | 13 ファイル / **323 件** | Stmts 100% (226/226) / Branch 100% (129/129) / Funcs 100% (49/49) / Lines 100% (219/219) | **100%**（610 変異: Killed 601 / Timeout 9 / Survived 0） |
| `packages/geo`  | 9 ファイル / **203 件**  | Stmts 100% (182/182) / Branch 100% (84/84) / Funcs 100% (22/22) / Lines 100% (181/181)   | **100%**（360 変異: Killed 352 / Timeout 8 / Survived 0） |
| `apps/mobile`   | 15 スイート / **105 件** | —                                                                                        | 対象外                                                    |

- テスト件数・カバレッジ: `npx vitest run --coverage`（各パッケージ）および `npx jest`（mobile）の出力
- ミューテーションスコア: 直近のローカル実行が出力した `reports/mutation/index.html` の集計値
- `apps/api` は Phase 3 の実装途中のため、数値は未掲載です

> Stryker の `testRunner` は `vitest` ではなく `command`（`npx vitest run --silent`）を使っています。
> `@stryker-mutator/vitest-runner@10.0.0` は `vitest@5.0.0` と組み合わせると変異ごとにテストを実行できず、
> スコアが実態より大幅に低く出るためです。詳細は [`packages/geo/README.md`](./packages/geo/README.md) に記録しています。

### 5. TypeScript の厳格設定

型の厳格さだけを `tsconfig.strict.json` に切り出し、全ワークスペースが継承しています
（`apps/mobile` は `expo/tsconfig.base` と併せて継承）。

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

加えて、コーディング規約（`docs/CODING_GUIDELINES.md`）で `any` / `as` / `!` / `console.log` /
マジックナンバー / デフォルトエクスポートを禁止しています。

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

## 開発の始め方

### 必要環境

- **Node.js 22 以上**（`package.json` の `engines.node` は `>=22.0.0`、`.nvmrc` は `22.23.2`）
- iOS / Android の実機またはシミュレータ（Expo Dev Client を使うため、Expo Go では動きません）
- Cloudflare アカウント（API のローカル開発・デプロイに使用）

### セットアップ

```bash
nvm use            # .nvmrc の 22.23.2 を使う
npm install        # ルートで実行（npm workspaces が全パッケージを解決する）
npm test           # 全ワークスペースのテストが通ることを確認する
```

### 動かす

```bash
npm run mobile         # Expo 開発サーバを起動
npm run mobile:ios     # iOS シミュレータで起動
npm run mobile:android # Android エミュレータで起動
npm run api:dev        # Cloudflare Workers をローカル起動（wrangler dev）
```

> `apps/api/wrangler.jsonc` の `database_id` / KV の `id` はプレースホルダのままです。
> **ローカル開発（`--local` / miniflare）はこのままで動きます**（Cloudflare へのログインも不要）。
> リモートの D1 / KV へ適用・デプロイするときだけ、`wrangler d1 create` /
> `wrangler kv namespace create` で作成した ID に差し替えてください。

---

## スクリプト一覧

### ルート（全ワークスペースへ委譲）

| コマンド                                           | 内容                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| `npm test`                                         | 全ワークスペースのテストを実行                 |
| `npm run test:watch`                               | 同上（watch）                                  |
| `npm run test:mutation`                            | 全ワークスペースのミューテーションテストを実行 |
| `npm run typecheck`                                | 全ワークスペースの型検査                       |
| `npm run format` / `format:check`                  | Prettier による整形 / 検査                     |
| `npm run mobile` / `mobile:ios` / `mobile:android` | Expo 開発サーバ                                |
| `npm run api:dev`                                  | `wrangler dev`                                 |

### `apps/mobile`（`-w @meshimap/mobile`）

| コマンド                                | 内容                                          |
| --------------------------------------- | --------------------------------------------- |
| `start` / `ios` / `android` / `web`     | Expo 開発サーバ                               |
| `test` / `test:watch` / `test:coverage` | Jest                                          |
| `lint`                                  | `expo lint`                                   |
| `typecheck`                             | `tsc --noEmit`                                |
| `prebuild`                              | `expo prebuild`（ネイティブプロジェクト生成） |

### `apps/api`（`-w @meshimap/api`）

| コマンド                                 | 内容                                       |
| ---------------------------------------- | ------------------------------------------ |
| `dev` / `deploy`                         | `wrangler dev` / `wrangler deploy`         |
| `test` / `test:watch` / `test:mutation`  | Vitest / Stryker                           |
| `typecheck`                              | `tsc --noEmit`                             |
| `db:generate`                            | Drizzle スキーマからマイグレーション生成   |
| `db:migrate:local` / `db:migrate:remote` | D1 へマイグレーション適用                  |
| `db:seed:generate` / `db:seed:local`     | シード SQL の生成 / 適用                   |
| `db:reset:local`                         | ローカル D1 を作り直して再適用・再シード   |
| `db:studio`                              | `drizzle-kit studio`                       |
| `cf-typegen`                             | `wrangler types`（バインディングの型生成） |

### `packages/core` / `packages/geo`

| コマンド              | 内容                        |
| --------------------- | --------------------------- |
| `test` / `test:watch` | Vitest                      |
| `test:coverage`       | カバレッジ（しきい値 100%） |
| `test:mutation`       | Stryker（しきい値 85%）     |
| `typecheck`           | `tsc --noEmit`              |

---

## ロードマップ

全 11 フェーズ / 155 タスク。進捗は `docs/superpowers/plans/README.md` に基づきます。
Phase 6 到達時点で「動くポートフォリオ」として成立する計画です。

| Phase | 内容                                                      | タスク数 | 状態             |
| ----- | --------------------------------------------------------- | -------: | ---------------- |
| 0     | モノレポ基盤 / デザインシステム / UI プリミティブ         |       14 | ✅ 完了          |
| 1     | `packages/geo`（地理計算）を TDD で実装                   |       13 | ✅ 完了          |
| 2     | `packages/core`（ドメインロジック）を TDD で実装          |       13 | ✅ 完了          |
| 3     | D1 スキーマ / マイグレーション / シード                   |       15 | 🚧 進行中        |
| 4     | API 基盤（Hono / 認証 / 権限の型設計 / 店舗検索）         |       12 | 計画済み・未着手 |
| 5     | モバイル認証 + ロールルーティング                         |        9 | 計画済み・未着手 |
| 6     | 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / 保存）    |       22 | 計画済み・未着手 |
| 7     | 予約（利用者 + 店舗側承認 + Durable Objects）             |       13 | 未着手           |
| 8     | 店舗管理者（ダッシュボード / 店舗編集 / メニュー / 返信） |       19 | 未着手           |
| 9     | システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ）   |       15 | 未着手           |
| 10    | 仕上げ（通知 / ディープリンク / README / デモ）           |       10 | 未着手           |

Phase 3 の細かい進捗は `docs/superpowers/plans/2026-09-15-phase-3-database.md` の
チェックボックスを参照してください。

### 計画済みで未実装のもの

README に書かれていても、以下は**まだ動きません**。

- 全 61 画面（認証 5 / 利用者 24 / 店舗管理者 18 / システム管理者 14）
- API のルート・認証ミドルウェア・ロールガード・リポジトリ層
- `OwnerActor` / `AdminActor` ブランド型による権限制御
- R2 / Workers KV / Durable Objects の利用
- プッシュ通知、ディープリンク、スクリーンショット、デモ動画

---

## ドキュメント

| ファイル                                                                                                         | 内容                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`docs/superpowers/specs/2026-09-15-meshimap-design.md`](./docs/superpowers/specs/2026-09-15-meshimap-design.md) | 設計書（技術選定 / 制約と対処 / 61 画面の構成 / データモデル / テスト戦略） |
| [`docs/CODING_GUIDELINES.md`](./docs/CODING_GUIDELINES.md)                                                       | コーディング規約（命名 / 禁止パターン / コンポーネント設計 / 型 / テスト）  |
| [`docs/superpowers/plans/README.md`](./docs/superpowers/plans/README.md)                                         | フェーズ別実装計画のインデックスと進捗                                      |
| [`packages/geo/README.md`](./packages/geo/README.md)                                                             | 地理計算パッケージの設計方針と 3 段階検索                                   |
| [`packages/core/README.md`](./packages/core/README.md)                                                           | ドメインパッケージの設計方針と公開 API                                      |
