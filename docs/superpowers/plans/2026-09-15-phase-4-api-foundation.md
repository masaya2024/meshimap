# Phase 4: API 基盤（Hono / 認証 / ロールガード / ブランド型 Actor / 権限テスト）実装計画

> **エージェント作業者へ:** 必須サブスキル: `superpowers:subagent-driven-development`（推奨）または `superpowers:executing-plans` を使い、タスク単位で実装すること。各ステップはチェックボックス（`- [ ]`）で進捗管理する。

**ゴール:** 設計書 3.2 の課題「**D1 に行レベルセキュリティ（RLS）がない**」を、アプリケーション層で確実に埋める。到達点は設計書 12 章の表にある「**権限の抜けがないことを証明できる**」状態。ここでの「証明」は、次の 3 つを機械的に検証できることを指す。

1. 権限主体を渡さないリポジトリ関数は**書いてもコンパイルが通らない**（ブランド型 Actor）
2. 権限主体を引数に取らないリポジトリ関数が**混入したらテストが落ちる**（TypeScript Compiler API によるソース走査）
3. ロール × エンドポイントの**全組み合わせ**について、許可された組だけが通ることを網羅テストで確認できる

**アーキテクチャ:** 権限判定を「呼び出し側の `if` 文」ではなく「**型と SQL の WHERE 句**」の 2 層に押し込む。

```
[型の層]  auth ミドルウェアの中でしか生成できないブランド型 Actor を
          リポジトリ関数の第 2 引数に要求する
          → 「ログインチェックは通したが所有者チェックを忘れた」経路が型として存在しなくなる

[SQL の層] 所有者チェックを WHERE owner_id = ? として表現する
          → アプリの分岐を通らずに他人の行へ到達する経路が存在しなくなる
          → 「他人の行」も「存在しない行」も 0 件になるので、応答が自然に 404 へ収束する
```

**技術スタック（インストール済み実測値）:** Hono 4.13.7 ／ Better Auth 1.7.5 ／ @better-auth/expo 1.7.5 ／ Drizzle ORM 0.45.2 ／ Zod 4.6.5 ／ Vitest 5.0.0 ／ TypeScript 6.0.3 ／ Wrangler 4.131.2 ／ @cloudflare/workers-types 5.20260915.1 ／ @types/node 26.5.1 ／ Node.js 22.23.2

---

## グローバル制約

- Node.js 22 系（`.nvmrc` = `22.23.2`）。
- すべてのコマンドはリポジトリルート `/Users/hattori/Downloads/alee` から `-w @meshimap/api` 付きで実行する。
- **新規パッケージを一切インストールしない。** `apps/api/package.json` の依存関係は現状のまま維持する。テスト環境も既存の依存だけで組む（根拠は後述「テスト環境の選定」）。
- ファイル名は kebab-case。関数・変数は camelCase、定数は UPPER_SNAKE_CASE、型は PascalCase。
- `any` 禁止。`as` は**ブランド型生成時のみ**許可（`docs/CODING_GUIDELINES.md` 82 行目の例外規定）。`as const` は型アサーションではないため制限外。
- デフォルトエクスポート禁止（名前付きエクスポートのみ）。**例外は `src/index.ts` の 1 箇所だけ。** Workers のモジュール形式ワーカーは `export default { fetch }` 相当を要求するため、プラットフォームの仕様上避けられない（`docs/CODING_GUIDELINES.md` 88 行目が expo-router の画面ファイルに同種の例外を認めているのと同じ扱い）。他のファイルで default export を書いたらレビューで落とす。
- `verbatimModuleSyntax` 有効のため、型のみの import は必ず `import type` を使う。
- 相対 import には拡張子を付けない（`moduleResolution: bundler`）。
- `console.*` の直接呼び出し禁止。`src/lib/logger.ts` 経由にする。
- コメントは日本語で「なぜ」を書く。
- **リポジトリ層の関数シグネチャは `(db, actor, ...)` の順で固定する。** 設計書 3.2 の `updateShopAsOwner(db: Db, actor: OwnerActor, shopId: ShopId, data: ShopUpdate)` に合わせる。機械検査は「第 1 引数が `db`、第 2 引数が `actor` または `viewer` でありブランド型 Actor であること」を検証するので、「権限主体を省略できない」という要件は同じ強度で担保される。
- **リポジトリ層で `db.transaction()` を使わない。** 本番の D1 は対話的トランザクションを持たない。Task 4-10 の機械検査で使用を禁止する。
- `packages/core` と `packages/geo` は読むだけ。Phase 4 で編集しない。
- **Phase 3 の成果物（`apps/api/src/db/` 配下と `apps/api/vitest.config.ts` と `apps/api/migrations/`）は読むだけ。** Phase 4 が新しく書くのは `src/lib/` `src/auth/` `src/middleware/` `src/repositories/` `src/routes/` `src/test/` `src/index.ts` だけ。`src/db/client.ts`（`createDatabase` / `Database`）も **Phase 3 が作成済み**なので、上書きせず import して使う。
- **テスト用の D1 を Phase 4 で自作しない。** Phase 3 の `src/db/testing/local-d1.ts` の `createMigratedD1()` を使う（根拠は後述「テスト環境の選定」）。

---

## 裏取りした事実（推測ゼロ）

計画中の API・型・挙動は、すべて `node_modules` の型定義を読むか、実際に Node で実行して確認した。
**実行確認は `apps/api/src/db/testing/local-d1.ts`（Phase 3 が用意した miniflare 製の本物の D1）に対して行った。**

### ライブラリのバージョンと有無

| 事項                                                      | 確認結果                                                                                                                                                                                                                                | 確認方法                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Hono バージョン                                           | 4.13.7                                                                                                                                                                                                                                  | `node_modules/hono/package.json`                                                    |
| Better Auth バージョン                                    | 1.7.5                                                                                                                                                                                                                                   | `node_modules/better-auth/package.json`                                             |
| `@better-auth/expo` バージョン                            | 1.7.5                                                                                                                                                                                                                                   | `node_modules/@better-auth/expo/package.json`                                       |
| Drizzle ORM バージョン                                    | 0.45.2                                                                                                                                                                                                                                  | `node_modules/drizzle-orm/package.json`                                             |
| Zod バージョン                                            | 4.6.5                                                                                                                                                                                                                                   | `node_modules/zod/package.json`                                                     |
| `miniflare` バージョン                                    | 5.20260911.1-alpha。**`apps/api/package.json` の devDependencies に明記済み**（Phase 3 が追加した）                                                                                                                                     | `apps/api/package.json`                                                             |
| `@cloudflare/vitest-pool-workers`                         | **未インストール**                                                                                                                                                                                                                      | `node_modules` に存在しない                                                         |
| `@hono/zod-validator`                                     | **未インストール**                                                                                                                                                                                                                      | `node_modules` に存在しない → `hono/validator` + 手書き Zod parse を使う            |
| `apps/api/tsconfig.json` の `types`                       | 現状は `["@cloudflare/workers-types", "vitest/globals"]`。この状態では **`import { readFileSync } from 'node:fs'` が `TS2591: Cannot find name 'node:fs'` で落ち、`import.meta.dirname` も `TS2339` になる**。`"node"` を足すと解決する | 同じ `types` を持つ最小 tsconfig で `tsc --noEmit` を実行し、エラーを再現・解消した |
| `@types/node` バージョン                                  | 26.5.1（ルートに hoist 済み。`apps/api` の devDependencies には無い）                                                                                                                                                                   | `node_modules/@types/node/package.json`                                             |
| `types` に `"node"` を足しても Workers 型と衝突しないこと | `Hono` / `drizzle(d1)` / `Response` / `Request` / `Headers` / `fetch` / `URL` / `TextEncoder` / `AbortController` / `crypto.randomUUID()` / `crypto.subtle.digest` を使うファイルで **`tsc --noEmit` がエラー 0**                       | 上記の最小 tsconfig に `"node"` を足して再実行                                      |
| `typescript` バージョン                                   | 6.0.3（ルートの devDependencies。`ts.canHaveModifiers` / `ts.getModifiers` / `ts.createSourceFile` が使える）                                                                                                                           | `node_modules/typescript/package.json` と実際に走らせた検査スクリプト               |

### Phase 3 が既に置いたもの（Phase 4 は作らない）

| 事項                                            | 確認結果                                                                                                                                                                                                                                                                                                                    | 確認方法                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/api/vitest.config.ts`                     | **作成済み**。`globals: true` / `environment: 'node'` / `include: ['src/**/*.test.ts']` / `testTimeout: 30_000` / `hookTimeout: 60_000` / v8 カバレッジ                                                                                                                                                                     | ファイルを直接読んだ                            |
| `apps/api/src/db/testing/local-d1.ts`           | **作成済み**。`createLocalD1()` / `createMigratedD1()` / `applyMigrations(d1)` を export し、miniflare 上のインメモリ D1 に `migrations/*.sql` を適用して返す                                                                                                                                                               | ファイルを直接読んだ                            |
| `apps/api/src/db/constants.ts`                  | **作成済み**。`ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `ROLES` / `Role` / `PROFILE_STATUS_*` / `SHOP_STATUS_*` / `REVIEW_STATUS_*` / `RATING_*` / `BUDGET_YEN_*` / `SHOP_GEOHASH_PRECISION` などを持つ                                                                                                                   | ファイルを直接読んだ                            |
| スキーマの置き場所                              | `apps/api/src/db/schema/` ディレクトリ（`auth.ts` / `master.ts` / `shop.ts` / `index.ts`）。`index.ts` が全部を再 export する                                                                                                                                                                                               | ファイルを直接読んだ                            |
| `migrations/0000_init.sql` に入っているテーブル | `account` / `session` / `user` / `verification` / `areas` / `genres` / `profiles` / `shops` の 8 つ                                                                                                                                                                                                                         | `grep '^CREATE TABLE' migrations/0000_init.sql` |
| `reviews` テーブル                              | **この計画を書いた時点では未着地**（Phase 3 が作業中）。Phase 4 のレビュー関連タスクは Phase 3 の `reviews` 着地後に着手する                                                                                                                                                                                                | 同上                                            |
| `shops` の Drizzle プロパティ名                 | `id` / `ownerId` / `name` / `nameKana` / `genreId` / `areaId` / `description` / `postalCode` / `address` / `lat` / `lng` / `geohash` / `phone` / `website` / `budgetLunchMin` / `budgetLunchMax` / `budgetDinnerMin` / `budgetDinnerMax` / `status` / `ratingAvg` / `ratingCount` / `viewCount` / `createdAt` / `updatedAt` | `apps/api/src/db/schema/shop.ts`                |
| `shops.createdAt` / `shops.updatedAt` の型      | `integer(..., { mode: 'timestamp_ms' })`。**Drizzle には `number` ではなく `Date` を渡す**（生の SQL で読むと整数）                                                                                                                                                                                                         | 同上 ＋ 実行確認                                |
| `shops.ownerId`                                 | **NULL 可**。`references(() => user.id, { onDelete: 'set null' })`                                                                                                                                                                                                                                                          | 同上                                            |
| `shops.genreId` / `shops.areaId`                | `NOT NULL` かつ `genres` / `areas` への `ON DELETE restrict` 外部キー。**テストで店舗を作る前にジャンルとエリアを入れる必要がある**                                                                                                                                                                                         | 同上 ＋ 実行確認                                |
| `profiles` の Drizzle プロパティ名              | `userId` / `role` / `displayName` / `avatarKey` / `bio` / `status` / `createdAt`                                                                                                                                                                                                                                            | `apps/api/src/db/schema/master.ts`              |

### `@meshimap/core`（Phase 2 の成果物、実物を確認済み）

| 事項                                                     | 確認結果                                                                                                                                                                                                                                                                                    | 確認方法                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ロール関連の export                                      | `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `ROLES` / `Role` / `isRole` / `toRole` / `canManageShop` / `canModerate`                                                                                                                                                                        | `packages/core/src/index.ts`、`packages/core/src/role.ts` |
| ID ブランド型                                            | `ShopId` / `UserId` / `ReviewId` / `ReservationId` と `toShopId` / `toUserId` / `toReviewId` / `toReservationId`（不正値は `RangeError`）                                                                                                                                                   | `packages/core/src/identifier.ts`                         |
| ID の書式                                                | `IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/`、`IDENTIFIER_MAX_LENGTH = 64`。**`shp_${crypto.randomUUID()}` は 40 文字で合格する**                                                                                                                                                              | 同上                                                      |
| `shopCreateSchema` / `shopUpdateSchema` の実プロパティ名 | `name` / `nameKana` / `genreId` / `areaId` / `description` / `postalCode` / `address` / **`latitude`** / **`longitude`** / `phone` / `website` / **`budgetLunchMinYen`** / `budgetLunchMaxYen` / `budgetDinnerMinYen` / `budgetDinnerMaxYen`。**`geohash` も `status` も `ownerId` も無い** | `packages/core/src/schema.ts`                             |
| `reviewCreateSchema` の実プロパティ名                    | `shopId` / `rating` / `body` / `visitedOn`（`z.iso.date()`）/ **`budgetYen`**（`.default(null)`）                                                                                                                                                                                           | 同上                                                      |
| `shopUpdateSchema` は空オブジェクトを弾く                | `.refine((value) => Object.keys(value).length > 0)` が入っている                                                                                                                                                                                                                            | 同上                                                      |
| `shopCreateSchema` の `.default()` 付きフィールド        | `nameKana` / `description` / `phone` / `website` / `budgetLunchMinYen` / `budgetLunchMaxYen` / `budgetDinnerMinYen` / `budgetDinnerMaxYen`                                                                                                                                                  | 同上                                                      |
| `@meshimap/geo` の geohash 生成                          | `encodeGeohash(target: Coordinate, precision: GeohashPrecision): Geohash`、`coordinate(lat, lng)` で `Coordinate` を作る                                                                                                                                                                    | `packages/geo/src/index.ts`                               |
| `GeohashPrecision` はリテラルユニオン                    | `1 \| 2 \| … \| 12` なので `const X = 7` がそのまま渡せる                                                                                                                                                                                                                                   | 同上                                                      |

### Hono / Better Auth / Drizzle の API

| 事項                                                                                     | 確認結果                                                                                                                                                   | 確認方法                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `better-auth` の drizzle アダプタの import パス                                          | `better-auth/adapters/drizzle`                                                                                                                             | `package.json` の `exports` に `"./adapters/drizzle"` が存在                     |
| `drizzleAdapter` の設定型                                                                | `{ schema?, provider: "pg"｜"mysql"｜"sqlite", usePlural?, debugLogs?, camelCase?, transaction?, schemaName? }`                                            | `node_modules/better-auth/dist/adapters/drizzle-adapter/*.d.mts`                 |
| `transaction: false` の意味                                                              | 「DB がトランザクションをサポートしない場合に false にする」                                                                                               | 同上の JSDoc                                                                     |
| `auth.api.getSession({ headers })` の戻り                                                | `{ session, user }` または `null`                                                                                                                          | `node_modules/better-auth/dist/api/index.d.mts` ／ 実行確認                      |
| `Authorization: Bearer <token>` だけではセッションが取れない                             | `getSession` が `null` を返す（`bearer` プラグイン未導入のため）                                                                                           | 実行確認                                                                         |
| `@better-auth/expo` のクライアントは Cookie を SecureStore に保存して送り返す            | `parseSetCookieHeader` / `SECURE_COOKIE_PREFIX` / `normalizeCookieName` を使用                                                                             | `node_modules/@better-auth/expo/dist/client.js`                                  |
| `@better-auth/expo` のサーバプラグイン名                                                 | `expo`（`export { ExpoOptions, expo }`）                                                                                                                   | `node_modules/@better-auth/expo/dist/index.d.ts`                                 |
| drizzle が D1 クライアントに要求するメソッド                                             | `prepare` / `bind`（**新しい statement を返すこと**）/ `run` / `all` / `raw` と `client.batch`                                                             | `node_modules/drizzle-orm/d1/session.js` 107〜181 行目                           |
| `HTTPException` は `onError` で捕捉される（validator 内から投げても）                    | 422 応答を実測                                                                                                                                             | 実行確認                                                                         |
| `app.request(path, init, env)` の第 3 引数で Bindings を注入できる                       | `c.env.DB` が読めることを実測（本計画のエンドツーエンド検証はすべてこの形で実行した）                                                                      | 実行確認                                                                         |
| `testClient(app, Env?, executionCtx?)`                                                   | 第 2 引数に Bindings を渡せる                                                                                                                              | `node_modules/hono/dist/types/helper/testing/index.d.ts`                         |
| `testClient(app)` の RPC 呼び出し                                                        | `client.health.$get()` / `client.shops[':shopId'].$patch({ param, json })` が型付きで通る                                                                  | `tsc --noEmit` で確認                                                            |
| `hc` のシグネチャ                                                                        | `<T extends Hono<any,any,any>, Prefix extends string = string>(baseUrl: Prefix, options?: ClientRequestOptions) => UnionToIntersection<Client<T, Prefix>>` | `node_modules/hono/dist/types/client/client.d.ts`                                |
| `app.routes` の要素                                                                      | `{ basePath: string; path: string; method: string; handler: H }`。ミドルウェアとハンドラで **1 ルートにつき複数エントリ**が入る                            | `node_modules/hono/dist/types/hono-base.d.ts` ／ 実行確認                        |
| Hono 4.13.7 の `validator` の入出力型                                                    | 型引数を省略すると RPC クライアント側の入力型 = **Zod の出力型**になる（`V.in.json = unknown extends InputType ? ExtractValidatorOutput<VF> : InputType`） | `node_modules/hono/dist/types/validator/validator.d.ts` ／ `tsc --noEmit` で確認 |
| → 型引数を部分指定して直そうとすると壊れる                                               | `VF` の推論が止まり `ExtractValidatorOutput<VF>` が `any` になり、`hc` の戻りが `unknown` 化する                                                           | `tsc --noEmit` で確認（**確認済みの制約**であり未確認事項ではない）              |
| `wrangler.jsonc` が Durable Object を要求している                                        | バインディング `RESERVATION_LOCK` → `class_name: "ReservationLock"`、マイグレーション tag `v1` の `new_sqlite_classes`                                     | `apps/api/wrangler.jsonc`                                                        |
| → **`src/index.ts` が `ReservationLock` を export しないと `wrangler dev` が起動しない** | 同上                                                                                                                                                       | 同上                                                                             |
| `import { DurableObject } from 'cloudflare:workers'` が有効                              | `declare module "cloudflare:workers"` が存在し `DurableObject<Env>` を export                                                                              | `node_modules/@cloudflare/workers-types/index.d.ts` 15691 / 15916 行目           |

### 本物の D1（miniflare / workerd）で実測した挙動

すべて `createMigratedD1()` で起動した D1 に対して実行した。

| 事項                                                             | 実測結果                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `createMigratedD1()` の所要時間                                  | 1 回あたり 166〜233ms（4 回計測）。`dispose()` は 1〜3ms。**テストごとに作り直して問題ない**           |
| Better Auth のサインアップ 1 回                                  | 99〜130ms（scrypt のハッシュ計算込み）                                                                 |
| `stmt.bind()` を引数ゼロで呼ぶ                                   | 正常に動く（`SELECT COUNT(*)` などパラメータの無い文で使える）                                         |
| `stmt.first<T>()` が 0 件のとき                                  | `null` を返す                                                                                          |
| `stmt.run()` の戻り                                              | `{ success: true, meta: { changes: n, ... } }`。更新 0 行なら `changes === 0`                          |
| `d1.exec()` に 2 文渡したときの `count`                          | `1`（**文の数と一致しない**。件数の検証に使わない）                                                    |
| CHECK 制約                                                       | 効く。`profiles.role = 'superuser'` は `D1_ERROR: CHECK constraint failed: ck_profiles_role`           |
| 外部キー制約                                                     | **効く**。存在しない `user_id` の `profiles` 挿入は `D1_ERROR: FOREIGN KEY constraint failed`          |
| `boolean` のバインド                                             | 受け付ける（`email_verified` に `true` を渡して成功）                                                  |
| drizzle 越しの `insert().returning()`                            | 挿入した行をそのまま返す                                                                               |
| drizzle 越しの `update().returning()` が 0 行を返す条件          | WHERE に一致する行が無いとき。**他人の行を指定したときと存在しない ID を指定したときで区別がつかない** |
| drizzle 越しの `delete().returning()`                            | 一致 0 件なら空配列                                                                                    |
| drizzle の `where(undefined)`                                    | 条件なしとして全件が返る（admin の可視条件に使う）                                                     |
| Better Auth + `drizzleAdapter(..., { transaction: false })` + D1 | サインアップ 200、`Set-Cookie` あり、`getSession` がユーザーを返す                                     |

**ブランド型の負の確認（`@ts-expect-error` が 4 件すべて成立することを実測）:**

| 書いたコード                                                         | 結果                               |
| -------------------------------------------------------------------- | ---------------------------------- |
| `const a: OwnerActor = { role: 'owner', userId: toUserId('usr_1') }` | コンパイルエラー（ブランドが無い） |
| `const b: OwnerActor = userActor`                                    | コンパイルエラー                   |
| `const c: AdminActor = ownerActor`                                   | コンパイルエラー                   |
| `const d: OwnerActor = 'usr_1'`                                      | コンパイルエラー                   |

**権限まわりの実挙動（Hono + Better Auth + Phase 3 の実スキーマを載せた本物の D1 を起動して測定）:**

| リクエスト                                       | 実測応答                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `GET /me`（Cookie なし）                         | `401 {"error":{"status":401,"message":"認証が必要です"}}`           |
| `GET /me`（owner A の Cookie）                   | `200 {"userId":"…","role":"owner"}`                                 |
| `GET /shops/shp_draft`（匿名、他人の draft）     | **`404`**                                                           |
| `GET /shops/shp_draft`（所有者 owner B）         | `200`                                                               |
| `PATCH /shops/shp_a`（owner A = 自店舗）         | `200 {"id":"shp_a","name":"PATCHED"}`                               |
| `PATCH /shops/shp_b`（owner A → owner B の店舗） | **`404`**                                                           |
| `PATCH /shops/shp_zzz`（存在しない ID）          | **`404`**（上と 1 バイトも違わない = 情報が漏れない）               |
| `PATCH /shops/shp_a`（user）                     | `403`（ID を見る前にロールで拒否）                                  |
| `PATCH /shops/shp_a`（Cookie なし）              | `401`                                                               |
| 上記すべての実行後の `shp_b` の行                | `{"name":"shp_b 店","updated_at":2}` = **1 バイトも変わっていない** |

---

## テスト環境の選定（結論と根拠）

**結論: 素の Vitest（`environment: 'node'`）＋ Phase 3 の `createMigratedD1()`（miniflare 上の本物の D1）を使う。Phase 4 は D1 のフェイクを書かない。**

| 候補                                         | 判断       | 理由                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/vitest-pool-workers`            | **不採用** | `node_modules` に存在しない。本計画の制約でインストールが禁止されている                                                                                                                                                               |
| 自前の `node:sqlite` 製 D1 フェイク          | **不採用** | Phase 3 が `src/db/testing/local-d1.ts` で同じ役目を**より高い忠実度で**すでに満たしている。作れば二重管理になり、`migrations/*.sql` の CHECK 制約・外部キーがテストから抜け落ちる                                                    |
| Phase 3 の `createMigratedD1()`（miniflare） | **採用**   | 追加インストール不要（`miniflare` は `apps/api` の devDependency）。**workerd の本物の D1** に `migrations/*.sql` をそのまま適用するので、CHECK 制約も外部キーも本番と同じに効く。1 インスタンス約 170ms なのでテストごとに作り直せる |

**採用理由の核心:** Phase 4 の合格条件は「`WHERE owner_id = ?` が効いて更新 0 行になる」ことの証明である。
自前フェイクではこれを**自前フェイクの SQL 実装**の上で証明することになるが、
`createMigratedD1()` なら**本番と同じ workerd の SQLite** の上で証明できる。

**この構成の限界（把握した上で受け入れる）:**

- テストコードと Hono アプリ自体は Node 上で動き、D1 だけが workerd 側にある。`nodejs_compat` の差異や CPU 時間制限、`waitUntil` の挙動は検出できない。
- D1 の `meta` の実測値（`rows_read` 等）は本番と一致しない。Phase 4 のテストはこれに依存しない。
- 本番の D1 は対話的トランザクションを持たない。miniflare の D1 も `db.transaction()` を提供しないが、**リポジトリ層で `db.transaction(` を書かせない**規約は Task 4-10 の機械検査で別途担保する。
- 実 D1 との疎通は `npm run db:migrate:local -w @meshimap/api` + `npm run dev -w @meshimap/api` による手動確認で担保する（Task 4-14）。

**`reviews` テーブルが未着地であることの扱い:** Phase 4 の Task 4-9 / 4-11 / 4-12 / 4-13 は `reviews` を使う。
Phase 3 が `reviews` を `migrations/` に載せるまで、これらのタスクのテストは**必ず赤になる**。
着手順は Task 4-0 〜 4-8 → （Phase 3 の `reviews` 着地を待つ）→ Task 4-9 以降とする。

---

## Phase 2 / Phase 3 が提供するもの（前提）

Phase 4 は次のシンボルを**import するだけ**で、定義しない。

### `@meshimap/core`（Phase 2 の成果物・確認済み）

| シンボル                                                       | 型                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN`                      | `'user'` / `'owner'` / `'admin'`                                           |
| `ROLES`                                                        | `readonly ['user', 'owner', 'admin']`                                      |
| `Role`                                                         | `'user' \| 'owner' \| 'admin'`                                             |
| `isRole`                                                       | `(value: unknown) => value is Role`                                        |
| `toRole`                                                       | `(value: unknown) => Role`                                                 |
| `UserId` / `ShopId` / `ReviewId`                               | ブランド付き `string`                                                      |
| `toUserId` / `toShopId` / `toReviewId`                         | `(value: string) => UserId \| ShopId \| ReviewId`（不正値は `RangeError`） |
| `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` | Zod スキーマ                                                               |
| `ShopCreateInput` / `ShopUpdateInput` / `ReviewCreateInput`    | 上記の `z.infer`                                                           |

### `@meshimap/geo`（Phase 1 の成果物・確認済み）

| シンボル        | 型                                                             |
| --------------- | -------------------------------------------------------------- |
| `coordinate`    | `(latitude: number, longitude: number) => Coordinate`          |
| `encodeGeohash` | `(target: Coordinate, precision: GeohashPrecision) => Geohash` |

### `apps/api/src/db/constants.ts`（Phase 3 の成果物・確認済み）

**import 元の使い分け（迷ったらここに戻る）:**

- **ロール**（`ROLE_USER` / `Role` / `isRole` / `toRole`）は `@meshimap/core` を正とする。
  モバイルと共有するのは core 側だけなので、API の実装コードは core から import する。
- **状態値**（`PROFILE_STATUS_*` / `SHOP_STATUS_*` / `REVIEW_STATUS_*`）と `SHOP_GEOHASH_PRECISION` は
  **`src/db/constants.ts` にしか存在しない**（core は export していない。Task 4-1 のテストで固定する）。
  ここから import する。
- どちらであっても `src/lib/constants.ts` に**再定義も再 export もしない**。
  再 export すると「どちらから import しても良い」状態になり、片方だけ直したときに気づけなくなる。

| シンボル                                                                                                               | 値                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `ROLES` / `Role`                                                           | core と同じ                                                          |
| `PROFILE_STATUS_ACTIVE` / `PROFILE_STATUS_SUSPENDED` / `PROFILE_STATUS_DELETED`                                        | `'active'` / `'suspended'` / `'deleted'`                             |
| `SHOP_STATUS_DRAFT` / `SHOP_STATUS_PENDING` / `SHOP_STATUS_PUBLISHED` / `SHOP_STATUS_SUSPENDED` / `SHOP_STATUS_CLOSED` | `'draft'` / `'pending'` / `'published'` / `'suspended'` / `'closed'` |
| `REVIEW_STATUS_PUBLISHED` / `REVIEW_STATUS_HIDDEN` / `REVIEW_STATUS_DELETED`                                           | `'published'` / `'hidden'` / `'deleted'`                             |
| `SHOP_GEOHASH_PRECISION`                                                                                               | `7`                                                                  |

> `src/db/constants.ts` の先頭には `TODO(Phase 4): @meshimap/core からの再エクスポートに置き換える` と書かれているが、
> **Phase 4 ではこのファイルを書き換えない。** 理由は同ファイルのコメントにあるとおり「D1 のマイグレーション生成が
> `@meshimap/core` のビルドに依存すると、core が壊れているとマイグレーションが生成できなくなる」ため。
> 代わりに Task 4-1 で**値が一致していることを検証するテスト**を追加し、ずれたらビルドが落ちるようにする。

### `apps/api/src/db/schema/`（Phase 3 の成果物）

`index.ts` が `auth.ts` / `master.ts` / `shop.ts` / `shop-detail.ts` を再 export する（実ファイルで確認済み）。
Phase 4 のコードは常に `../db/schema` から import する。

| シンボル                                        | 用途                                                                                              | Phase 4 が使うカラム（Drizzle のプロパティ名）                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                                          | Better Auth                                                                                       | `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`                                                                                                                                                                                   |
| `session`                                       | Better Auth                                                                                       | `id`, `expiresAt`, `token`, `createdAt`, `updatedAt`, `ipAddress`, `userAgent`, `userId`                                                                                                                                                                    |
| `account`                                       | Better Auth                                                                                       | `id`, `accountId`, `providerId`, `userId`, `password`, `createdAt`, `updatedAt` ほか                                                                                                                                                                        |
| `verification`                                  | Better Auth                                                                                       | `id`, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`                                                                                                                                                                                          |
| `genres` / `areas`                              | マスタ（テストの下ごしらえで使う）                                                                | `id`, `name`, `slug`, `sortOrder` ／ `id`, `name`, `parentId`, `prefecture`                                                                                                                                                                                 |
| `profiles`                                      | ロール解決                                                                                        | `userId`, `role`, `displayName`, `status`, `createdAt`                                                                                                                                                                                                      |
| `shops`                                         | 店舗（**確認済み**）                                                                              | `id`, `ownerId`, `name`, `nameKana`, `genreId`, `areaId`, `description`, `postalCode`, `address`, `lat`, `lng`, `geohash`, `phone`, `website`, `budgetLunchMin`, `budgetLunchMax`, `budgetDinnerMin`, `budgetDinnerMax`, `status`, `createdAt`, `updatedAt` |
| `shopHours` / `shopClosures` / `shopPhotos`     | 店舗詳細（Phase 4 では使わない）                                                                  | —                                                                                                                                                                                                                                                           |
| `menuCategories` / `menuItems` / `seatSettings` | メニュー・席（Phase 4 では使わない）                                                              | —                                                                                                                                                                                                                                                           |
| `reviews`                                       | レビュー（**未着地。`migrations/0000_init.sql` に `CREATE TABLE reviews` が無いことを確認済み**） | `id`, `shopId`, `userId`, `rating`, `body`, `visitedOn`, `budgetYen`, `status`, `createdAt`                                                                                                                                                                 |

**時刻列の扱い（重要）:** `shops.createdAt` / `shops.updatedAt` / `profiles.createdAt` は
`integer(..., { mode: 'timestamp_ms' })` で定義されている。**Drizzle 経由の読み書きでは `Date` を使う。**
生の SQL（`d1.prepare(...)`）で読むとミリ秒の整数が返る。テストのアサーションはこの違いに合わせる。

---

## ファイル構成

| ファイル                                         | 責務                                                                                                                                                               | 区分     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `apps/api/src/lib/constants.ts`                  | API 層だけで使う定数（一覧のページング件数、`profiles.display_name` の上限の写し）。ロールは `@meshimap/core`、状態値は `src/db/constants.ts` から直接 import する | 新規     |
| `apps/api/src/lib/logger.ts`                     | `logError`（`console.error` の唯一の出口）                                                                                                                         | 新規     |
| `apps/api/src/lib/app-env.ts`                    | `AppBindings` / `AppVariables` / `AppEnv`                                                                                                                          | 新規     |
| `apps/api/src/lib/http-error.ts`                 | `unauthorized` / `forbidden` / `notFound` / `invalidInput`                                                                                                         | 新規     |
| `apps/api/src/lib/parse-id.ts`                   | URL パラメータ → ブランド型 ID。失敗は 404                                                                                                                         | 新規     |
| `apps/api/src/lib/validate.ts`                   | `jsonBody(schema)`。Zod で parse し、失敗を 422 に変換する Hono バリデータ                                                                                         | 新規     |
| `apps/api/src/auth/actor.ts`                     | **ブランド型 Actor** とファクトリ・型ガード                                                                                                                        | 新規     |
| `apps/api/src/auth/auth.ts`                      | Better Auth 初期化（D1 + Drizzle アダプタ）                                                                                                                        | 新規     |
| `apps/api/src/auth/load-actor.ts`                | セッション + profiles から Actor を組み立てる                                                                                                                      | 新規     |
| `apps/api/src/db/client.ts`                      | `createDatabase(d1)` と `Database` 型。**Phase 3 の成果物。Phase 4 では読むだけ**                                                                                  | 変更なし |
| `apps/api/src/middleware/error-handler.ts`       | 例外 → JSON。スタックトレースを漏らさない                                                                                                                          | 新規     |
| `apps/api/src/middleware/auth.ts`                | セッション検証 → `viewer` を Context に載せる                                                                                                                      | 新規     |
| `apps/api/src/middleware/role-guard.ts`          | ロール不一致で 403 ＋ 型ナローイングヘルパ                                                                                                                         | 新規     |
| `apps/api/src/repositories/shop-repository.ts`   | 店舗の取得・作成・更新・削除                                                                                                                                       | 新規     |
| `apps/api/src/repositories/review-repository.ts` | レビューの取得・作成・削除                                                                                                                                         | 新規     |
| `apps/api/src/routes/shops.ts`                   | `/shops` 配下                                                                                                                                                      | 新規     |
| `apps/api/src/routes/reviews.ts`                 | `/reviews` 配下                                                                                                                                                    | 新規     |
| `apps/api/src/routes/me.ts`                      | `/me`                                                                                                                                                              | 新規     |
| `apps/api/src/index.ts`                          | Hono エントリ。`AppType` と `ReservationLock`（Phase 7 用の空実体）を export                                                                                       | 新規     |
| `apps/api/src/test/fixtures.ts`                  | テスト用の世界（miniflare D1）生成・下ごしらえ・サインアップ・Cookie 取得                                                                                          | 新規     |
| `apps/api/wrangler.jsonc`                        | `vars` に `BETTER_AUTH_URL` / `MOBILE_APP_SCHEME` を追加                                                                                                           | 変更     |
| `apps/api/vitest.config.ts`                      | **Phase 3 が作成済み。Phase 4 では触らない**                                                                                                                       | 変更なし |
| `apps/api/tsconfig.json`                         | `compilerOptions.types` に `"node"` を足す（Task 4-3）。`node:fs` を使う検査テストが型チェックを通らないため                                                       | 変更     |
| `apps/api/src/db/testing/local-d1.ts`            | **Phase 3 の成果物。Phase 4 では読むだけ**                                                                                                                         | 変更なし |
| `apps/api/src/db/constants.ts`                   | **Phase 3 の成果物。Phase 4 では読むだけ**（一致検証テストのみ追加）                                                                                               | 変更なし |

**依存方向（一方通行、循環なし）:**

```
core, db/constants(P3) ← auth/*, repositories/*, routes/*   （定数の定義元は 2 つだけ）
lib/constants ← auth/auth, repositories/*                  （ページング件数と表示名上限のみ）
lib/http-error ← middleware/* ← routes/* ← index
lib/logger    ← middleware/error-handler
lib/app-env   ← middleware/*, routes/*, index
lib/http-error ← lib/validate, lib/parse-id ← routes/*
auth/actor    ← auth/load-actor ← middleware/auth
auth/actor    ← middleware/role-guard, repositories/*
db/client     ← auth/auth, middleware/auth, repositories/*
db/schema(P3) ← db/client, auth/auth, repositories/*
db/testing/local-d1(P3) ← test/fixtures ← *.test.ts
core, geo     ← repositories/*
repositories/* ← routes/*
```

---

## 権限マトリクス（Phase 4 で実装する全エンドポイント）

`匿名` は未認証。数値は期待する HTTP ステータス。

| #   | メソッド | パス                                  | 匿名 | user    | owner   | admin |
| --- | -------- | ------------------------------------- | ---- | ------- | ------- | ----- |
| 1   | GET      | `/health`                             | 200  | 200     | 200     | 200   |
| 2   | GET      | `/me`                                 | 401  | 200     | 200     | 200   |
| 3   | GET      | `/shops`                              | 200  | 200     | 200     | 200   |
| 4   | GET      | `/shops/:shopId`（published）         | 200  | 200     | 200     | 200   |
| 5   | GET      | `/shops/:shopId`（draft・他人の店舗） | 404  | 404     | 404     | 200   |
| 6   | POST     | `/shops`                              | 401  | 403     | 403     | 201   |
| 7   | PATCH    | `/shops/:shopId`（自分の店舗）        | 401  | 403     | 200     | 200   |
| 8   | PATCH    | `/shops/:shopId`（他人の店舗）        | 401  | 403     | **404** | 200   |
| 9   | DELETE   | `/shops/:shopId`                      | 401  | 403     | 403     | 204   |
| 10  | GET      | `/shops/:shopId/reviews`（published） | 200  | 200     | 200     | 200   |
| 11  | POST     | `/shops/:shopId/reviews`              | 401  | 201     | 403     | 403   |
| 12  | DELETE   | `/reviews/:reviewId`（自分の投稿）    | 401  | 204     | 403     | 204   |
| 13  | DELETE   | `/reviews/:reviewId`（他人の投稿）    | 401  | **404** | 403     | 204   |

### 403 と 404 の使い分け（情報漏洩対策の中核）

**この区別を間違えると、権限テストを全部書いても情報が漏れる。**

| 状況                                                   | 返す    | 理由                                                                                                                              |
| ------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 未認証                                                 | **401** | リソースの存在に依存しない。「ログインしろ」以上の情報は出ない                                                                    |
| ロールだけで判定でき、リソース ID を見る前に拒否できる | **403** | 例: `user` が `PATCH /shops/:shopId` を叩く。**どんな `shopId` でも 403** なので、ID の存在有無が漏れない                         |
| リソース単位の所有者判定で弾かれた                     | **404** | 例: owner A が owner B の店舗を更新。403 を返すと「その ID の店舗は存在する」と分かってしまう。存在しない ID と**同じ応答**にする |
| 可視性で弾かれた（他人の draft 店舗）                  | **404** | 同上                                                                                                                              |

実装上は「リポジトリ関数が `WHERE owner_id = ?` 込みで 0 件を返したら `notFound()` を投げる」という 1 本のルールに収斂させる。**アプリ側で「存在はするが権限がない」を判定しないので、区別して返す経路が最初から存在しない。**

### エラー応答の形

```json
{ "error": { "status": 404, "message": "対象が見つかりません" } }
```

`message` は**固定文言のみ**。例外のメッセージやスタックトレース、SQL、内部 ID を絶対に含めない。

---

## Task 4-0: テスト基盤（Phase 3 の D1 を Phase 4 のテストから使う）

前提タスク。ここが通らないと以降すべてのテストが書けない。

**Phase 4 は D1 のフェイクを書かない。** Phase 3 が `apps/api/src/db/testing/local-d1.ts` に
`createMigratedD1()`（miniflare 上の本物の D1 に `migrations/*.sql` を適用して返す）を用意済みで、
`apps/api/vitest.config.ts` も作成済みだから。このタスクでやるのは
「Phase 4 のテストが毎回書くことになる下ごしらえ」を 1 ファイルにまとめることだけ。

**Files:**

- Create: `apps/api/src/test/fixtures.ts`
- Test: `apps/api/src/test/fixtures.test.ts`

**Interfaces:**

- Consumes:
  - `../db/testing/local-d1` の `createMigratedD1(): Promise<LocalD1>`（`LocalD1 = { readonly d1: D1Database; readonly dispose: () => Promise<void> }`）
  - `../db/constants` の `Role` / `ProfileStatus` / `ShopStatus` / `PROFILE_STATUS_ACTIVE` / `SHOP_STATUS_PUBLISHED`
  - `@cloudflare/workers-types` の `D1Database`（グローバル型なので import は不要）
- Produces:
  - `type TestWorld = { readonly d1: D1Database; readonly dispose: () => Promise<void> }`
  - `createTestWorld(): Promise<TestWorld>`
  - `readRow(world: TestWorld, sql: string, ...params: readonly SqlParam[]): Promise<Record<string, unknown> | null>`
  - `countRows(world: TestWorld, sql: string, ...params: readonly SqlParam[]): Promise<number>`
  - `runWrite(world: TestWorld, sql: string, ...params: readonly SqlParam[]): Promise<number>`（更新行数を返す）
  - `seedMasters(world: TestWorld): Promise<void>`
  - `seedUser(world: TestWorld, options: SeedUserOptions): Promise<void>`
  - `seedShop(world: TestWorld, options: SeedShopOptions): Promise<void>`
  - `TEST_GENRE_ID` / `TEST_AREA_ID` / `TEST_LATITUDE` / `TEST_LONGITUDE` / `TEST_GEOHASH`

> このファイルは Task 4-5（`createTestBindings` / `signUpAs`）、Task 4-8（`buildActorForTest`）、
> Task 4-9（`seedReview`）で**追記されていく**。Task 4-0 では DB の下ごしらえだけを置く。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/test/fixtures.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_SUSPENDED,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_DRAFT,
} from '../db/constants';
import {
  countRows,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from './fixtures';
import type { TestWorld } from './fixtures';

describe('createTestWorld', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('migrations/ を適用済みの D1 を返す', async () => {
    const row = await readRow(
      world,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      'shops',
    );

    expect(row).toEqual({ name: 'shops' });
  });

  it('呼ぶたびに独立した D1 を返す（テスト間で状態が漏れない）', async () => {
    // 同じ世界を使い回すと、実行順でテスト結果が変わる。ここが緑であることが
    // 権限マトリクス（Task 4-12）の前提になる
    const other = await createTestWorld();
    await seedMasters(world);

    const seenFromOther = await countRows(other, 'SELECT COUNT(*) AS count FROM genres');
    const seenFromWorld = await countRows(world, 'SELECT COUNT(*) AS count FROM genres');

    await other.dispose();
    expect(seenFromOther).toBe(0);
    expect(seenFromWorld).toBe(1);
  });
});

describe('readRow / countRows / runWrite', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('readRow は 0 件のとき null を返す', async () => {
    const row = await readRow(world, 'SELECT id FROM user WHERE id = ?', 'usr_missing');
    expect(row).toBeNull();
  });

  it('countRows は 0 件のとき 0 を返す', async () => {
    const count = await countRows(world, 'SELECT COUNT(*) AS count FROM user');
    expect(count).toBe(0);
  });

  it('runWrite は更新した行数を返す', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_USER });

    const changed = await runWrite(
      world,
      'UPDATE user SET name = ? WHERE id = ?',
      'A',
      'usr_alice',
    );

    expect(changed).toBe(1);
  });

  it('runWrite は 1 行も一致しなければ 0 を返す', async () => {
    const changed = await runWrite(world, 'UPDATE user SET name = ? WHERE id = ?', 'A', 'usr_zzz');
    expect(changed).toBe(0);
  });
});

describe('seedUser', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('user と profiles を 1 行ずつ作る', async () => {
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    const userRow = await readRow(world, 'SELECT id, email FROM user WHERE id = ?', 'usr_bob');
    const profileRow = await readRow(
      world,
      'SELECT role, status FROM profiles WHERE user_id = ?',
      'usr_bob',
    );

    expect(userRow).toEqual({ id: 'usr_bob', email: 'usr_bob@example.test' });
    expect(profileRow).toEqual({ role: 'owner', status: 'active' });
  });

  it('status を指定すると profiles にそのまま入る', async () => {
    await seedUser(world, {
      userId: 'usr_carol',
      role: ROLE_USER,
      status: PROFILE_STATUS_SUSPENDED,
    });

    const profileRow = await readRow(
      world,
      'SELECT status FROM profiles WHERE user_id = ?',
      'usr_carol',
    );

    expect(profileRow).toEqual({ status: 'suspended' });
  });
});

describe('seedShop', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('seedMasters と seedUser の後なら店舗を作れる', async () => {
    await seedMasters(world);
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await seedShop(world, { id: 'shp_1', ownerId: 'usr_bob', name: 'B 店' });

    const row = await readRow(
      world,
      'SELECT owner_id, name, status, genre_id, area_id FROM shops WHERE id = ?',
      'shp_1',
    );

    expect(row).toEqual({
      owner_id: 'usr_bob',
      name: 'B 店',
      status: 'published',
      genre_id: TEST_GENRE_ID,
      area_id: TEST_AREA_ID,
    });
  });

  it('status を指定すると shops にそのまま入る', async () => {
    await seedMasters(world);
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await seedShop(world, { id: 'shp_2', ownerId: 'usr_bob', status: SHOP_STATUS_DRAFT });

    const row = await readRow(world, 'SELECT status FROM shops WHERE id = ?', 'shp_2');
    expect(row).toEqual({ status: 'draft' });
  });

  it('マスタを入れずに店舗を作ると外部キー制約で落ちる（本物の制約が効いている証拠）', async () => {
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await expect(seedShop(world, { id: 'shp_3', ownerId: 'usr_bob' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('存在しない owner_id を指定すると外部キー制約で落ちる', async () => {
    await seedMasters(world);

    await expect(seedShop(world, { id: 'shp_4', ownerId: 'usr_missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('owner_id に null を入れられる（shops.owner_id は NULL 可）', async () => {
    await seedMasters(world);

    await seedShop(world, { id: 'shp_5', ownerId: null });

    const row = await readRow(world, 'SELECT owner_id FROM shops WHERE id = ?', 'shp_5');
    expect(row).toEqual({ owner_id: null });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- fixtures
```

期待: `Cannot find module './fixtures' imported from .../apps/api/src/test/fixtures.test.ts` で失敗する。**このメッセージを目で見ること。**
見ずに次へ進むと、テストが実際には何も検証していない状態に気付けない。

> 解決エラーの文言はツールの版で変わる。**Vitest 5 は `Cannot find module '<指定子>' imported from <テストファイルの絶対パス>`**
> を出す（`Failed to resolve import "..."` は Vitest 4 以前の文言）。大事なのは「import が解決できずに
> 落ちた」ことを目で確認することであって、文字列の一致ではない。

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/test/fixtures.ts`:

```ts
import { PROFILE_STATUS_ACTIVE, SHOP_STATUS_PUBLISHED } from '../db/constants';
import type { ProfileStatus, Role, ShopStatus } from '../db/constants';
import { createMigratedD1 } from '../db/testing/local-d1';

/** D1 にバインドできる値。boolean も通るが、テストでは 0/1 を明示して曖昧さを消す */
export type SqlParam = string | number | null;

/**
 * テスト 1 件ごとに使い捨てる世界。
 * 中身は Phase 3 の `createMigratedD1()` が返す miniflare（= 本物の workerd SQLite）製の D1。
 * Phase 4 で D1 のフェイクを作らない理由は計画書「テスト環境の選定」を参照。
 */
export type TestWorld = {
  readonly d1: D1Database;
  readonly dispose: () => Promise<void>;
};

/** テストで使うジャンル。shops.genre_id は NOT NULL かつ genres への外部キー */
export const TEST_GENRE_ID = 'gnr_ramen';
/** テストで使うエリア。shops.area_id は NOT NULL かつ areas への外部キー */
export const TEST_AREA_ID = 'are_shibuya';
/** 渋谷駅付近。境界値ではない「普通の」座標を 1 つ決めておく */
export const TEST_LATITUDE = 35.658;
export const TEST_LONGITUDE = 139.7016;
/** 上の座標を precision 7 で符号化した値。ck_shops_geohash_alphabet を満たす */
export const TEST_GEOHASH = 'xn76fgr';

export async function createTestWorld(): Promise<TestWorld> {
  const local = await createMigratedD1();
  return { d1: local.d1, dispose: local.dispose };
}

/**
 * 1 行だけ読む。**リポジトリ層を通さずに DB の実体を見る**ために使う。
 * 「403 は返ったが実は書き込まれていた」を検出できるのは、この経路だけ。
 */
export async function readRow(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<Record<string, unknown> | null> {
  return await world.d1
    .prepare(sql)
    .bind(...params)
    .first<Record<string, unknown>>();
}

/** `SELECT COUNT(*) AS count ...` の結果を数値で返す */
export async function countRows(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<number> {
  const row = await world.d1
    .prepare(sql)
    .bind(...params)
    .first<{ count: number }>();
  return row === null ? 0 : row.count;
}

/** INSERT / UPDATE / DELETE を実行し、影響を受けた行数を返す */
export async function runWrite(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<number> {
  const result = await world.d1
    .prepare(sql)
    .bind(...params)
    .run();
  return result.meta.changes;
}

/**
 * shops の外部キー（genres / areas は ON DELETE restrict）を満たすためのマスタを入れる。
 * これを呼ばずに seedShop すると FOREIGN KEY constraint failed になる。
 */
export async function seedMasters(world: TestWorld): Promise<void> {
  await runWrite(
    world,
    'INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, ?, ?)',
    TEST_GENRE_ID,
    'ラーメン',
    'ramen',
    null,
    0,
  );
  await runWrite(
    world,
    'INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)',
    TEST_AREA_ID,
    '渋谷',
    null,
    '東京都',
  );
}

export type SeedUserOptions = {
  readonly userId: string;
  readonly role: Role;
  readonly status?: ProfileStatus;
  readonly displayName?: string;
};

/**
 * Better Auth を通さずに user + profiles を作る。
 * サインアップは scrypt で 100ms 前後かかるため、**セッションが要らないテストでは使わない**。
 * セッション付きのユーザーが要るときは Task 4-5 の `signUpAs` を使う。
 */
export async function seedUser(world: TestWorld, options: SeedUserOptions): Promise<void> {
  const displayName = options.displayName ?? options.userId;
  await runWrite(
    world,
    'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    options.userId,
    displayName,
    // example.test は RFC 6761 の予約 TLD。実在ドメインに送信事故が起きない
    `${options.userId}@example.test`,
    0,
    0,
    0,
  );
  await runWrite(
    world,
    'INSERT INTO profiles (user_id, role, display_name, avatar_key, bio, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    options.userId,
    options.role,
    displayName,
    null,
    null,
    options.status ?? PROFILE_STATUS_ACTIVE,
    0,
  );
}

export type SeedShopOptions = {
  readonly id: string;
  /** shops.owner_id は NULL 可（オーナー退会で set null されるため） */
  readonly ownerId: string | null;
  readonly name?: string;
  readonly status?: ShopStatus;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly geohash?: string;
  /** ミリ秒。生の SQL で入れるので Date ではなく整数で渡す */
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
};

/**
 * 店舗を 1 行作る。既定は published。
 * NOT NULL 制約と CHECK 制約をすべて満たす値を埋めるため、呼び出し側は
 * 検証したい列（owner_id / status / name）だけを指定すればよい。
 */
export async function seedShop(world: TestWorld, options: SeedShopOptions): Promise<void> {
  await runWrite(
    world,
    'INSERT INTO shops (id, owner_id, name, name_kana, genre_id, area_id, description, postal_code, address, lat, lng, geohash, phone, website, budget_lunch_min, budget_lunch_max, budget_dinner_min, budget_dinner_max, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    options.id,
    options.ownerId,
    options.name ?? `${options.id} 店`,
    null,
    TEST_GENRE_ID,
    TEST_AREA_ID,
    null,
    null,
    '東京都渋谷区道玄坂 1-1-1',
    options.latitude ?? TEST_LATITUDE,
    options.longitude ?? TEST_LONGITUDE,
    options.geohash ?? TEST_GEOHASH,
    null,
    null,
    null,
    null,
    null,
    null,
    options.status ?? SHOP_STATUS_PUBLISHED,
    options.createdAtMs ?? 0,
    options.updatedAtMs ?? 0,
  );
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- fixtures
```

期待: 13 件すべて PASS。

- [ ] **Step 5: 型チェックを通す**

```bash
npm run typecheck -w @meshimap/api
```

期待: エラーなし。

- [ ] **Step 6: 意図的にコードを壊してテストが検知することを確認する**

まず `createTestWorld` を「1 つの世界を使い回す」実装に変える:

```ts
// わざと壊す: 使い回しにする
let sharedWorld: TestWorld | null = null;

export async function createTestWorld(): Promise<TestWorld> {
  if (sharedWorld === null) {
    const local = await createMigratedD1();
    sharedWorld = { d1: local.d1, dispose: local.dispose };
  }
  return sharedWorld;
}
```

```bash
npm run test -w @meshimap/api -- fixtures
```

期待: **大量に落ちる**。実測では 13 件中 12 件が FAIL、1 件だけ PASS。

出方は「`seenFromOther` が 1 になった」という assertion ではなく、miniflare の
`Attempted to use poisoned stub` である。世界を使い回すと、最初のテストの `afterEach` で
`dispose()` された D1 スタブを 2 件目以降が掴み続けるため、assert に到達する前に
スタブの利用そのものが拒否される。**この出方を見ること。**
「1 件目だけが通り、以降が全滅する」形を覚えておくと、実装中に同じ壊れ方をしたときに
「世界を使い回してしまった」と即断できる。
**ここが FAIL しないなら、以降のテストは互いの書き込みを見てしまう。** 確認後に元へ戻す。

次に `seedMasters` の `areas` の INSERT を削る:

```ts
await runWrite(
  world,
  'INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)',
  TEST_AREA_ID,
  '渋谷',
  null,
  '東京都',
);
```

↓ この呼び出しを削除

```bash
npm run test -w @meshimap/api -- fixtures
```

期待: `seedMasters と seedUser の後なら店舗を作れる` が `FOREIGN KEY constraint failed` で FAIL。
**これが FAIL しないなら、D1 の外部キー制約が効いておらず、以降のテストは本番より緩い世界で回っていることになる。**
確認後に元へ戻す。

- [ ] **Step 7: コミット**

```bash
git add apps/api/src/test/fixtures.ts apps/api/src/test/fixtures.test.ts
git commit -m "test(api): Phase 3 の miniflare D1 を使うテスト用フィクスチャを追加"
```

---

## Task 4-1: 定数・ロガー・環境型・HTTP エラー

権限判定そのものではないが、以降すべてのタスクが依存する土台。**エラー応答の形をここで固定する**ことが、情報漏洩対策の起点になる。

**Files:**

- Create: `apps/api/src/lib/constants.ts`
- Create: `apps/api/src/lib/logger.ts`
- Create: `apps/api/src/lib/app-env.ts`
- Create: `apps/api/src/lib/http-error.ts`
- Modify: `apps/api/wrangler.jsonc`（`vars` を追加）
- Test: `apps/api/src/lib/http-error.test.ts`
- Test: `apps/api/src/db/constants-parity.test.ts`

**Interfaces:**

- Consumes: `hono/http-exception` の `HTTPException`、`@cloudflare/workers-types` の `D1Database` / `R2Bucket` / `KVNamespace`、`@meshimap/core` と `apps/api/src/db/constants.ts` の同名定数（値一致テスト用）
- Produces:
  - `SHOP_LIST_DEFAULT_LIMIT` / `SHOP_LIST_MAX_LIMIT`: `number`（店舗一覧のページング）
  - `REVIEW_LIST_DEFAULT_LIMIT` / `REVIEW_LIST_MAX_LIMIT`: `number`（レビュー一覧のページング）
  - `PROFILE_DISPLAY_NAME_MAX_LENGTH`: `50`（`profiles.display_name` の CHECK 制約と一致させる写し）
  - `logError(message: string, cause: unknown): void`
  - `type AppBindings` / `type AppVariables` / `type AppEnv`
  - `unauthorized(): HTTPException` / `forbidden(): HTTPException` / `notFound(): HTTPException` / `invalidInput(): HTTPException`
  - `ERROR_MESSAGE_UNAUTHORIZED` ほか固定文言の定数

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/lib/http-error.test.ts`:

```ts
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGE_FORBIDDEN,
  ERROR_MESSAGE_INTERNAL,
  ERROR_MESSAGE_INVALID_INPUT,
  ERROR_MESSAGE_NOT_FOUND,
  ERROR_MESSAGE_UNAUTHORIZED,
  forbidden,
  invalidInput,
  notFound,
  unauthorized,
} from './http-error';

describe('HTTP エラーファクトリ', () => {
  it('unauthorized は 401 の HTTPException を返す', () => {
    const error = unauthorized();
    expect(error).toBeInstanceOf(HTTPException);
    expect(error.status).toBe(401);
    expect(error.message).toBe(ERROR_MESSAGE_UNAUTHORIZED);
  });

  it('forbidden は 403 の HTTPException を返す', () => {
    const error = forbidden();
    expect(error.status).toBe(403);
    expect(error.message).toBe(ERROR_MESSAGE_FORBIDDEN);
  });

  it('notFound は 404 の HTTPException を返す', () => {
    const error = notFound();
    expect(error.status).toBe(404);
    expect(error.message).toBe(ERROR_MESSAGE_NOT_FOUND);
  });

  it('invalidInput は 422 の HTTPException を返す', () => {
    const error = invalidInput();
    expect(error.status).toBe(422);
    expect(error.message).toBe(ERROR_MESSAGE_INVALID_INPUT);
  });

  it('文言は決められた日本語そのものである', () => {
    // 上の各テストは定数どうしを比べているだけなので、文言が空文字に変わっても通ってしまう。
    // リテラルと突き合わせて初めて「文言が消えた」に気づける
    expect(ERROR_MESSAGE_UNAUTHORIZED).toBe('ログインが必要です');
    expect(ERROR_MESSAGE_FORBIDDEN).toBe('この操作を行う権限がありません');
    expect(ERROR_MESSAGE_NOT_FOUND).toBe('対象が見つかりません');
    expect(ERROR_MESSAGE_INVALID_INPUT).toBe('入力内容が正しくありません');
    expect(ERROR_MESSAGE_INTERNAL).toBe('サーバ内部でエラーが発生しました');
  });

  it('文言に内部情報を示す語が含まれていない', () => {
    // 「どのテーブルか」「どのカラムか」が分かる文言は情報漏洩になる
    const messages = [
      ERROR_MESSAGE_UNAUTHORIZED,
      ERROR_MESSAGE_FORBIDDEN,
      ERROR_MESSAGE_NOT_FOUND,
      ERROR_MESSAGE_INVALID_INPUT,
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/sql|table|column|owner_id|user_id|D1/i);
    }
  });

  it('notFound の文言は「権限がない」と「存在しない」を区別しない', () => {
    // 区別する文言を返すと、リソースの存在有無が漏れる
    expect(ERROR_MESSAGE_NOT_FOUND).not.toMatch(/権限|所有|アクセス/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- http-error
```

期待: `Cannot find module './http-error' imported from .../apps/api/src/lib/http-error.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/lib/constants.ts`:

```ts
/**
 * API 層だけで使う定数。
 *
 * ロール（`ROLE_*`）と状態値（`SHOP_STATUS_*` / `REVIEW_STATUS_*` / `PROFILE_STATUS_*`）、
 * および `SHOP_GEOHASH_PRECISION` は `src/db/constants.ts` が唯一の定義元。
 * ここには再定義も再 export もしない。
 * 再 export すると「どちらから import しても良い」状態になり、
 * 片方だけ直したときに値がずれても型では気づけなくなるため。
 */

/** 店舗一覧の既定件数。1 画面に収まる量として設定する */
export const SHOP_LIST_DEFAULT_LIMIT = 20;

/** 店舗一覧で許容する最大件数。無制限にすると Worker の CPU 時間を食い潰す */
export const SHOP_LIST_MAX_LIMIT = 100;

/** レビュー一覧の既定件数 */
export const REVIEW_LIST_DEFAULT_LIMIT = 20;

/** レビュー一覧で許容する最大件数 */
export const REVIEW_LIST_MAX_LIMIT = 100;

/**
 * `profiles.display_name` の上限。
 *
 * 値の定義元は `src/db/schema/master.ts` の `DISPLAY_NAME_MAX_LENGTH` だが、
 * あちらは module-private で export されていないため import できない（実ファイルで確認済み）。
 * `migrations/0000_init.sql` の `ck_profiles_display_name_length` にも同じ値が焼かれている。
 * Task 4-5 でサインアップ時に profiles を自動作成する際、Better Auth の `user.name` を
 * この長さに切り詰めないと CHECK 制約違反でサインアップ全体が 500 になるため、写しをここに置く。
 * ズレは `src/db/constants-parity.test.ts` がマイグレーション本文と突き合わせて検出する。
 */
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 50;
```

> 以前の草案ではここに `SHOP_STATUS_*` などを再定義していたが、Phase 3 が
> `apps/api/src/db/constants.ts` に確定値を置いたため削除した。
> 特に **レビューの公開状態は `'visible'` ではなく `REVIEW_STATUS_PUBLISHED = 'published'`**、
> geohash 精度の定数名は `SHOP_GEOHASH_PRECISION` である（`migrations/0000_init.sql` の
> CHECK 制約がこの値で焼かれているので、別名で `'visible'` を書くと実行時に必ず落ちる）。

`apps/api/src/lib/logger.ts`:

```ts
/**
 * Worker 上の唯一のログ出口。
 * 規約で console の直接呼び出しを禁じているため、ここだけが console を触る。
 * wrangler.jsonc の observability が有効なので、この出力は Cloudflare のログに乗る。
 */
export function logError(message: string, cause: unknown): void {
  // eslint-disable-next-line no-console -- ロガー実装本体。ここ以外では console を呼ばない
  console.error(message, cause);
}
```

`apps/api/src/lib/app-env.ts`:

```ts
import type { Viewer } from '../auth/actor';

/** wrangler.jsonc のバインディングと、secret で注入する値 */
export type AppBindings = {
  readonly DB: D1Database;
  readonly MEDIA: R2Bucket;
  readonly CACHE: KVNamespace;
  /**
   * 予約の同時押さえを防ぐ Durable Object。Phase 7 で本実装する。
   * wrangler.jsonc に既にバインディングが書かれているので、Phase 4 の時点で型に含めておく。
   * 含めないと index.ts の DurableObject<AppBindings> が env の型と食い違う。
   */
  readonly RESERVATION_LOCK: DurableObjectNamespace;
  /** Better Auth の署名鍵。`wrangler secret put BETTER_AUTH_SECRET` で設定する */
  readonly BETTER_AUTH_SECRET: string;
  /** Better Auth の baseURL。ローカルは http://localhost:8787 */
  readonly BETTER_AUTH_URL: string;
  /** Expo アプリのカスタムスキーム。trustedOrigins に渡す */
  readonly MOBILE_APP_SCHEME: string;
};

/**
 * Context に載せる値。
 * viewer は未認証（AnonymousActor）も含むため、認証必須の処理では必ず絞り込む。
 */
export type AppVariables = {
  readonly viewer: Viewer;
};

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };
```

`apps/api/src/lib/http-error.ts`:

```ts
import { HTTPException } from 'hono/http-exception';

/**
 * クライアントへ返す文言はすべてここで固定する。
 * 例外のメッセージをそのまま返すと、SQL やテーブル名が漏れる経路ができる。
 */
export const ERROR_MESSAGE_UNAUTHORIZED = 'ログインが必要です';
export const ERROR_MESSAGE_FORBIDDEN = 'この操作を行う権限がありません';
export const ERROR_MESSAGE_NOT_FOUND = '対象が見つかりません';
export const ERROR_MESSAGE_INVALID_INPUT = '入力内容が正しくありません';
export const ERROR_MESSAGE_INTERNAL = 'サーバ内部でエラーが発生しました';

/** 未認証。リソースの存在に依存しないので情報は漏れない */
export function unauthorized(): HTTPException {
  return new HTTPException(401, { message: ERROR_MESSAGE_UNAUTHORIZED });
}

/**
 * ロールだけで拒否できる場合に使う。
 * リソース ID を見る前に返すため、どんな ID でも同じ応答になり存在有無が漏れない。
 */
export function forbidden(): HTTPException {
  return new HTTPException(403, { message: ERROR_MESSAGE_FORBIDDEN });
}

/**
 * 「存在しない」と「所有者でないので触れない」の両方でこれを返す。
 * 区別して返すと「その ID のリソースは存在する」ことが漏れる。
 */
export function notFound(): HTTPException {
  return new HTTPException(404, { message: ERROR_MESSAGE_NOT_FOUND });
}

/** バリデーション失敗。どのフィールドが悪いかは返さない（スキーマ構造が漏れるため） */
export function invalidInput(): HTTPException {
  return new HTTPException(422, { message: ERROR_MESSAGE_INVALID_INPUT });
}
```

> `app-env.ts` は `../auth/actor` を参照するため、Task 4-2 を終えるまで `npm run typecheck` は通らない。Step 4 のテストは `http-error.test.ts` のみを対象に実行する。

- [ ] **Step 4: core と `db/constants.ts` の値が一致していることを機械的に固定する**

`apps/api/src/db/constants.ts` の冒頭コメントが明言している通り、この値は
`migrations/0000_init.sql` の CHECK 制約に**焼き込まれている**。
`@meshimap/core` 側だけを直すと、型は通るのに INSERT が実行時に落ちる。
「両方に同じ名前で存在する定数は同じ値である」ことをテストで固定する。

`apps/api/src/db/constants-parity.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import * as db from './constants';

/**
 * マイグレーション本文。CHECK 制約に焼かれた数値と TypeScript 側の定数を突き合わせる。
 *
 * `readFileSync(new URL(...))` と書けないのは、この tsconfig のグローバル `URL` が
 * `@cloudflare/workers-types` のもので、Node の `fs` が要求する `node:url` の `URL` と
 * 別物として扱われるため（TS2769 を実測）。src/db/testing/local-d1.ts と同じく
 * パス文字列へ落としてから読む。
 */
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(CURRENT_DIR, '..', '..', 'migrations', '0000_init.sql'),
  'utf8',
);

/**
 * 両方に同じ名前で存在する数値定数。
 * 名前空間 import を配列に展開して比較する。文字列キーで引くと
 * 型チェックが効かず「片方にしか無い名前」を書いても通ってしまうため、
 * 明示的に両辺を書き並べる。
 */
const SHARED_NUMBERS: ReadonlyArray<readonly [name: string, fromCore: number, fromDb: number]> = [
  ['RATING_MIN', core.RATING_MIN, db.RATING_MIN],
  ['RATING_MAX', core.RATING_MAX, db.RATING_MAX],
  ['BUDGET_YEN_MIN', core.BUDGET_YEN_MIN, db.BUDGET_YEN_MIN],
  ['BUDGET_YEN_MAX', core.BUDGET_YEN_MAX, db.BUDGET_YEN_MAX],
  ['DAY_OF_WEEK_MIN', core.DAY_OF_WEEK_MIN, db.DAY_OF_WEEK_MIN],
  ['DAY_OF_WEEK_MAX', core.DAY_OF_WEEK_MAX, db.DAY_OF_WEEK_MAX],
  ['MINUTE_OF_DAY_MIN', core.MINUTE_OF_DAY_MIN, db.MINUTE_OF_DAY_MIN],
  ['MINUTE_OF_DAY_MAX', core.MINUTE_OF_DAY_MAX, db.MINUTE_OF_DAY_MAX],
  ['MINUTES_PER_DAY', core.MINUTES_PER_DAY, db.MINUTES_PER_DAY],
  ['PARTY_SIZE_MIN', core.PARTY_SIZE_MIN, db.PARTY_SIZE_MIN],
  ['PARTY_SIZE_MAX', core.PARTY_SIZE_MAX, db.PARTY_SIZE_MAX],
  ['SLOT_MINUTES_MIN', core.SLOT_MINUTES_MIN, db.SLOT_MINUTES_MIN],
  ['SLOT_MINUTES_MAX', core.SLOT_MINUTES_MAX, db.SLOT_MINUTES_MAX],
  ['SEAT_CAPACITY_MIN', core.SEAT_CAPACITY_MIN, db.SEAT_CAPACITY_MIN],
  ['SEAT_CAPACITY_MAX', core.SEAT_CAPACITY_MAX, db.SEAT_CAPACITY_MAX],
  ['MAX_PARALLEL_MIN', core.MAX_PARALLEL_MIN, db.MAX_PARALLEL_MIN],
  ['MAX_PARALLEL_MAX', core.MAX_PARALLEL_MAX, db.MAX_PARALLEL_MAX],
  ['SHOP_NAME_MAX_LENGTH', core.SHOP_NAME_MAX_LENGTH, db.SHOP_NAME_MAX_LENGTH],
  ['SHOP_NAME_KANA_MAX_LENGTH', core.SHOP_NAME_KANA_MAX_LENGTH, db.SHOP_NAME_KANA_MAX_LENGTH],
  ['SHOP_ADDRESS_MAX_LENGTH', core.SHOP_ADDRESS_MAX_LENGTH, db.SHOP_ADDRESS_MAX_LENGTH],
  ['SHOP_DESCRIPTION_MAX_LENGTH', core.SHOP_DESCRIPTION_MAX_LENGTH, db.SHOP_DESCRIPTION_MAX_LENGTH],
  ['REVIEW_BODY_MAX_LENGTH', core.REVIEW_BODY_MAX_LENGTH, db.REVIEW_BODY_MAX_LENGTH],
  ['RESERVATION_NOTE_MAX_LENGTH', core.RESERVATION_NOTE_MAX_LENGTH, db.RESERVATION_NOTE_MAX_LENGTH],
  ['IDENTIFIER_MAX_LENGTH', core.IDENTIFIER_MAX_LENGTH, db.IDENTIFIER_MAX_LENGTH],
];

describe('@meshimap/core と src/db/constants.ts の値の一致', () => {
  it.each(SHARED_NUMBERS)('%s が両者で一致する', (_name, fromCore, fromDb) => {
    expect(fromDb).toBe(fromCore);
  });

  it('ロールの値が一致する', () => {
    expect(db.ROLE_USER).toBe(core.ROLE_USER);
    expect(db.ROLE_OWNER).toBe(core.ROLE_OWNER);
    expect(db.ROLE_ADMIN).toBe(core.ROLE_ADMIN);
  });

  it('ロールの並びと個数が一致する', () => {
    // profiles.role の CHECK 制約はこの並びで生成されている。
    // 増減すると「core には存在するが DB が受け付けない」ロールが生まれる。
    expect([...db.ROLES]).toStrictEqual([...core.ROLES]);
  });

  it('ck_profiles_display_name_length が PROFILE_DISPLAY_NAME_MAX_LENGTH と一致する', () => {
    // src/db/schema/master.ts の DISPLAY_NAME_MAX_LENGTH は export されていないので
    // 生成物（マイグレーション本文）を正として突き合わせる
    expect(migrationSql).toContain(
      `CHECK(length("profiles"."display_name") <= ${PROFILE_DISPLAY_NAME_MAX_LENGTH})`,
    );
  });

  it('ck_shops_geohash_length が SHOP_GEOHASH_PRECISION と一致する', () => {
    expect(migrationSql).toContain(
      `CHECK(length("shops"."geohash") = ${db.SHOP_GEOHASH_PRECISION})`,
    );
  });

  it('ck_profiles_role の列挙が ROLES と一致する', () => {
    const roleList = db.ROLES.map((role) => `'${role}'`).join(', ');
    expect(migrationSql).toContain(`CHECK("profiles"."role" IN (${roleList}))`);
  });

  it('core にロール以外の状態値が無いことを確認する', () => {
    // 状態値（SHOP_STATUS_* など）の定義元は db/constants.ts 側だけ、という前提を固定する。
    // core に生えたらこのテストが落ちるので、そのとき定義元を一本化する判断をする。
    const coreNames = Object.keys(core);
    expect(coreNames.filter((name) => name.endsWith('_STATUS_ACTIVE'))).toStrictEqual([]);
    expect(coreNames.filter((name) => name.startsWith('SHOP_STATUS_'))).toStrictEqual([]);
    expect(coreNames.filter((name) => name.startsWith('REVIEW_STATUS_'))).toStrictEqual([]);
  });
});
```

```bash
npm run test -w @meshimap/api -- constants-parity
```

期待: 30 件すべて PASS（数値 24 件 + ロール 2 件 + マイグレーション突き合わせ 3 件 + 状態値の不在 1 件）。

> `@meshimap/core` は `apps/api/package.json` の `dependencies` にあり、
> `node_modules/@meshimap/core` はリポジトリルートの `packages/core` へのシンボリックリンクとして
> 実在する（`ls -la node_modules/@meshimap/` で確認済み）。`main` / `types` / `exports` はいずれも
> `./src/index.ts` を指すのでビルド不要で import できる。

- [ ] **Step 5: 意図的に値をずらしてテストが検知することを確認する**

`apps/api/src/db/constants.ts` の `RATING_MAX` を `6` に変える。

```bash
npm run test -w @meshimap/api -- constants-parity
```

期待: `RATING_MAX が両者で一致する` が FAIL。**FAIL しないなら、CHECK 制約と core のズレを
検出する仕組みが働いていない。** 確認後に必ず `5` に戻す。

- [ ] **Step 6: wrangler.jsonc に `vars` を追加する**

`BETTER_AUTH_URL` と `MOBILE_APP_SCHEME` は秘密ではないので `vars` に置く。
`BETTER_AUTH_SECRET` だけは `wrangler secret put` で入れる（`vars` に書かない）。

`apps/api/wrangler.jsonc` の `"compatibility_flags"` の次の行に足す:

```jsonc
  "vars": {
    // ローカル開発の既定値。本番は `wrangler deploy --var` か環境別設定で上書きする
    "BETTER_AUTH_URL": "http://localhost:8787",
    // Expo アプリのカスタムスキーム。Better Auth の trustedOrigins に渡す
    "MOBILE_APP_SCHEME": "meshimap"
  },
```

ローカルの秘密鍵は `apps/api/.dev.vars` に置く。**ルートの `.gitignore` は現状 `.env*.local`（34 行目）と
`.wrangler/`（46 行目）しか無視しておらず、`.dev.vars` は無視されない**（実測確認済み）。
先に `.gitignore` へ 1 行足してから作る。

```bash
printf '\n# wrangler のローカル秘密変数\n.dev.vars\n' >> .gitignore
printf 'BETTER_AUTH_SECRET=local-dev-secret-not-for-production\n' > apps/api/.dev.vars
grep -n "dev.vars" .gitignore
```

期待: `.dev.vars` の行がヒットする。**`git status` に `apps/api/.dev.vars` が現れないことを目で確認してから次へ進む。**

- [ ] **Step 7: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- http-error
```

期待: 7 件すべて PASS。

- [ ] **Step 8: 意図的にコードを壊してテストが検知することを確認する**

`http-error.ts` の `ERROR_MESSAGE_NOT_FOUND` を情報が漏れる文言に変える:

```ts
export const ERROR_MESSAGE_NOT_FOUND = 'この店舗にアクセスする権限がありません';
```

```bash
npm run test -w @meshimap/api -- http-error
```

期待: `文言は決められた日本語そのものである` と `notFound の文言は「権限がない」と「存在しない」を区別しない` の 2 件が FAIL。
`notFound は 404 の HTTPException を返す` は**落ちない**（`expect(error.message).toBe(ERROR_MESSAGE_NOT_FOUND)` が
同じ定数どうしの比較なので、文言を書き換えても両辺が一緒に変わる）。この同語反復を埋めるために
`文言は決められた日本語そのものである` をリテラル比較で置いてある。
**2 件とも FAIL しないなら、情報漏洩を防ぐテストが機能していない。** 確認後に元へ戻す。

さらに `forbidden()` の `403` を `404` に変えて実行し、`forbidden は 403 の HTTPException を返す` が FAIL することを確認してから元へ戻す。

- [ ] **Step 9: コミット**

```bash
git add apps/api/src/lib/ apps/api/wrangler.jsonc
git commit -m "feat(api): 定数・ロガー・環境型・HTTP エラーファクトリを追加"
```

> `.dev.vars` はコミットしない。`git status` に出てきたら `.gitignore` の設定を見直す。

---

## Task 4-2: ブランド型 Actor（Phase 4 の中核）

設計書 3.2 の「`OwnerActor` / `AdminActor` はブランド型にし、認証ミドルウェアの中でしか構築できないようにする」を実装する。`packages/geo/src/coordinate.ts` の `Latitude` / `Longitude` と**同じ書き方**で作る（`declare const xxxBrand: unique symbol` ＋ ファクトリ末尾の `as` 1 箇所）。

**Files:**

- Create: `apps/api/src/auth/actor.ts`
- Test: `apps/api/src/auth/actor.test.ts`
- Test: `apps/api/src/auth/actor.type-test.ts`（`@ts-expect-error` による型レベルテスト。Vitest は実行しないが `tsc` が検査する）

**Interfaces:**

- Consumes: `@meshimap/core` の `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / `Role` / `UserId` / `toUserId`
- Produces:
  - `type UserActor` / `type OwnerActor` / `type AdminActor` / `type AnonymousActor`
  - `type Actor = UserActor | OwnerActor | AdminActor`（認証済みの操作主体）
  - `type Viewer = Actor | AnonymousActor`（未認証を含む閲覧主体）
  - `ROLE_ANONYMOUS: 'anonymous'`
  - `ANONYMOUS_VIEWER: AnonymousActor`
  - `toActor(userId: string, role: Role): Actor`
  - `isUserActor(viewer: Viewer): viewer is UserActor`
  - `isOwnerActor(viewer: Viewer): viewer is OwnerActor`
  - `isAdminActor(viewer: Viewer): viewer is AdminActor`
  - `isAuthenticatedActor(viewer: Viewer): viewer is Actor`

### 設計の要点

```
Actor   … 認証済み。userId は必ず存在する（UserId ブランド型）
Viewer  … 匿名を含む。userId は null になりうる

ブランドは 4 つの型で共有する 1 つの unique symbol。
ロールの区別は role フィールド（リテラル型）で行う。
  → 判別可能ユニオンなので、型ガードで絞り込める（as が不要）
  → OwnerActor と AdminActor は role が違うので相互に代入できない
  → ブランドが無い素のオブジェクトはどの型にも代入できない
```

`admin` が `owner` の操作を代行できる件は、**`OwnerActor | AdminActor` というユニオンを作らず**、`updateShopAsOwner`（所有者スコープ）と `updateShopAsAdmin`（全件スコープ）の 2 関数に分ける。ユニオンにすると「どちらの WHERE 句を組むか」の分岐が関数内に入り、設計書 3.2 が避けたい「アプリの分岐による権限チェック」に逆戻りするため。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/auth/actor.test.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_VIEWER,
  ROLE_ANONYMOUS,
  isAdminActor,
  isAuthenticatedActor,
  isOwnerActor,
  isUserActor,
  toActor,
} from './actor';

describe('toActor', () => {
  it('user ロールから UserActor を作る', () => {
    const actor = toActor('usr_alice', ROLE_USER);
    expect(actor.role).toBe(ROLE_USER);
    expect(actor.userId).toBe('usr_alice');
  });

  it('owner ロールから OwnerActor を作る', () => {
    const actor = toActor('usr_bob', ROLE_OWNER);
    expect(actor.role).toBe(ROLE_OWNER);
    expect(actor.userId).toBe('usr_bob');
  });

  it('admin ロールから AdminActor を作る', () => {
    const actor = toActor('usr_carol', ROLE_ADMIN);
    expect(actor.role).toBe(ROLE_ADMIN);
    expect(actor.userId).toBe('usr_carol');
  });

  it('識別子として不正な userId を拒否する', () => {
    // toUserId（@meshimap/core）の検証をそのまま通すので、空文字や記号は弾かれる
    expect(() => toActor('', ROLE_USER)).toThrow(RangeError);
  });

  it('生成された Actor は凍結されていて後から書き換えられない', () => {
    const actor = toActor('usr_alice', ROLE_USER);
    expect(Object.isFrozen(actor)).toBe(true);
  });
});

describe('ANONYMOUS_VIEWER', () => {
  it('role は anonymous で userId は null である', () => {
    expect(ANONYMOUS_VIEWER.role).toBe(ROLE_ANONYMOUS);
    expect(ANONYMOUS_VIEWER.userId).toBeNull();
  });

  it('凍結されていて書き換えられない', () => {
    expect(Object.isFrozen(ANONYMOUS_VIEWER)).toBe(true);
  });
});

describe('型ガード', () => {
  const userActor = toActor('usr_alice', ROLE_USER);
  const ownerActor = toActor('usr_bob', ROLE_OWNER);
  const adminActor = toActor('usr_carol', ROLE_ADMIN);

  it('isUserActor は UserActor にだけ true を返す', () => {
    expect(isUserActor(userActor)).toBe(true);
    expect(isUserActor(ownerActor)).toBe(false);
    expect(isUserActor(adminActor)).toBe(false);
    expect(isUserActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isOwnerActor は OwnerActor にだけ true を返す', () => {
    expect(isOwnerActor(ownerActor)).toBe(true);
    expect(isOwnerActor(userActor)).toBe(false);
    expect(isOwnerActor(adminActor)).toBe(false);
    expect(isOwnerActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isAdminActor は AdminActor にだけ true を返す', () => {
    expect(isAdminActor(adminActor)).toBe(true);
    expect(isAdminActor(userActor)).toBe(false);
    expect(isAdminActor(ownerActor)).toBe(false);
    expect(isAdminActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isAuthenticatedActor は匿名にだけ false を返す', () => {
    expect(isAuthenticatedActor(userActor)).toBe(true);
    expect(isAuthenticatedActor(ownerActor)).toBe(true);
    expect(isAuthenticatedActor(adminActor)).toBe(true);
    expect(isAuthenticatedActor(ANONYMOUS_VIEWER)).toBe(false);
  });
});
```

- [ ] **Step 2: 型レベルテストを書く**

`apps/api/src/auth/actor.type-test.ts`:

```ts
// このファイルは実行されない。tsc が「本来コンパイルエラーになるべきコード」を検査する。
// `@ts-expect-error` が付いた行が実際にはエラーにならない場合、tsc は（この行のように
// 先頭を記号で始めればディレクティブとして解釈されない）
// 「Unused '@ts-expect-error' directive」として失敗する。つまりブランド型が壊れたら typecheck が落ちる。
import { ROLE_OWNER, ROLE_USER, toUserId } from '@meshimap/core';
import { toActor } from './actor';
import type { AdminActor, Actor, AnonymousActor, OwnerActor, UserActor, Viewer } from './actor';

declare const userActor: UserActor;
declare const ownerActor: OwnerActor;
declare const adminActor: AdminActor;
declare const anonymousViewer: AnonymousActor;

// --- 代入できてはいけない組み合わせ ---

// @ts-expect-error ブランドを持たない素のオブジェクトは OwnerActor にならない
export const bareObject: OwnerActor = { role: ROLE_OWNER, userId: toUserId('usr_bob') };

// @ts-expect-error UserActor は OwnerActor に代入できない
export const userToOwner: OwnerActor = userActor;

// @ts-expect-error OwnerActor は AdminActor に代入できない
export const ownerToAdmin: AdminActor = ownerActor;

// @ts-expect-error AdminActor は OwnerActor に代入できない（admin 用の関数は別に用意する）
export const adminToOwner: OwnerActor = adminActor;

// @ts-expect-error 素の文字列は OwnerActor に代入できない
export const rawStringToOwner: OwnerActor = 'usr_bob';

// @ts-expect-error 匿名は認証済み Actor に代入できない
export const anonymousToActor: Actor = anonymousViewer;

// --- 代入できなければならない組み合わせ（ここがエラーになったら型が厳しすぎる） ---

export const userToActor: Actor = userActor;
export const ownerToActor: Actor = ownerActor;
export const adminToActor: Actor = adminActor;
export const actorToViewer: Viewer = userActor;
export const anonymousToViewer: Viewer = anonymousViewer;

// --- ファクトリの戻り値はユニオンなので、絞り込まずに OwnerActor へは渡せない ---

// @ts-expect-error toActor の戻り値は Actor（ユニオン）なので OwnerActor に直接代入できない
export const factoryToOwner: OwnerActor = toActor('usr_bob', ROLE_USER);
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- actor
```

期待: `Cannot find module './actor' imported from .../apps/api/src/auth/actor.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 4: 最小実装を書く**

`apps/api/src/auth/actor.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER, toUserId } from '@meshimap/core';
import type { Role, UserId } from '@meshimap/core';

declare const actorBrand: unique symbol;

/**
 * 操作主体の共通形。
 * `[actorBrand]` は宣言だけで実体がないため、このモジュールの外では作れない。
 * ロールの区別は role フィールド（リテラル型）で行うので、型ガードで as なしに絞り込める。
 */
type BrandedActor<TRole extends string, TUserId> = {
  readonly role: TRole;
  readonly userId: TUserId;
  readonly [actorBrand]: true;
};

/** 未認証を表すロール値。@meshimap/core の Role には含めない（DB に保存されないため） */
export const ROLE_ANONYMOUS = 'anonymous';

/** 一般利用者。検索・レビュー・お気に入り・予約・通報ができる（設計書 4 章） */
export type UserActor = BrandedActor<typeof ROLE_USER, UserId>;

/** 店舗管理者。自店舗の編集・予約承認・レビュー返信ができる */
export type OwnerActor = BrandedActor<typeof ROLE_OWNER, UserId>;

/** システム管理者。審査・通報対応・ユーザー停止・マスタ管理ができる */
export type AdminActor = BrandedActor<typeof ROLE_ADMIN, UserId>;

/** 未認証の閲覧者。userId を持たないので、所有者スコープの操作には型として渡せない */
export type AnonymousActor = BrandedActor<typeof ROLE_ANONYMOUS, null>;

/** 認証済みの操作主体。書き込み系のリポジトリ関数はこのいずれかを要求する */
export type Actor = UserActor | OwnerActor | AdminActor;

/** 未認証を含む閲覧主体。公開データの読み取りだけに使う */
export type Viewer = Actor | AnonymousActor;

/**
 * ブランド型の唯一の生成点。
 * `actorBrand` は declare 専用でランタイムの値が無く、オブジェクトリテラルとして書けないため
 * ここでだけ as を使う。packages/core/src/identifier.ts と同じ「検証済みの値にだけ as を当てる」方針。
 * リテラルへ直接 as を当てないのは、規約（consistent-type-assertions）が
 * `const x: T = { ... }` を書けない場合に限って値経由の as を許すため。
 */
function brandActor<TRole extends string, TUserId>(
  role: TRole,
  userId: TUserId,
): BrandedActor<TRole, TUserId> {
  const unbranded = { role, userId };
  return unbranded as BrandedActor<TRole, TUserId>;
}

/**
 * Actor の唯一の生成点。
 * 呼んでよいのは `src/auth/load-actor.ts` とテストだけで、これは Task 4-3 の検査で機械的に強制する。
 * 設計書 3.2 の「コンストラクタを外部に公開しない」を、TypeScript に friend 修飾子がないため
 * 「import 元を検査するテスト」で代替している。
 */
export function toActor(userId: string, role: Role): Actor {
  // 識別子としての検証は @meshimap/core に委ねる。ここで独自の検証を書かない
  const brandedUserId = toUserId(userId);
  switch (role) {
    case ROLE_USER:
      return Object.freeze(brandActor(ROLE_USER, brandedUserId));
    case ROLE_OWNER:
      return Object.freeze(brandActor(ROLE_OWNER, brandedUserId));
    case ROLE_ADMIN:
      return Object.freeze(brandActor(ROLE_ADMIN, brandedUserId));
  }
}

/**
 * 未認証を表す唯一の値。
 * Actor と違い userId が null なので、所有者スコープの関数へは型として渡せない。
 */
export const ANONYMOUS_VIEWER: AnonymousActor = Object.freeze(brandActor(ROLE_ANONYMOUS, null));

export function isUserActor(viewer: Viewer): viewer is UserActor {
  return viewer.role === ROLE_USER;
}

export function isOwnerActor(viewer: Viewer): viewer is OwnerActor {
  return viewer.role === ROLE_OWNER;
}

export function isAdminActor(viewer: Viewer): viewer is AdminActor {
  return viewer.role === ROLE_ADMIN;
}

export function isAuthenticatedActor(viewer: Viewer): viewer is Actor {
  return viewer.role !== ROLE_ANONYMOUS;
}
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- actor
```

期待: 11 件すべて PASS。

- [ ] **Step 6: 型レベルテストが通ることを確認する**

```bash
npm run typecheck -w @meshimap/api
```

期待: エラーなし。`actor.type-test.ts` の `@ts-expect-error` が 7 件すべて「実際にエラーになった」ことを意味する。

- [ ] **Step 7: ブランド型が本当に効いていることを手で確認する**

`apps/api/src/auth/brand-check.tmp.ts` を作る:

```ts
import { ROLE_OWNER, toUserId } from '@meshimap/core';
import type { OwnerActor } from './actor';

export const fake: OwnerActor = { role: ROLE_OWNER, userId: toUserId('usr_bob') };
```

```bash
npm run typecheck -w @meshimap/api
```

期待: `Property '[actorBrand]' is missing in type '{ role: "owner"; userId: UserId; }' but required in type 'BrandedActor<"owner", UserId>'` が出る。**出なければブランド型が機能していない**ので `declare const actorBrand: unique symbol` の書き方を見直すこと。確認できたらファイルを削除する。

```bash
rm apps/api/src/auth/brand-check.tmp.ts
```

- [ ] **Step 8: 意図的にコードを壊してテストが検知することを確認する**

`actor.ts` の `isOwnerActor` の比較を反転させる:

```ts
export function isOwnerActor(viewer: Viewer): viewer is OwnerActor {
  return viewer.role !== ROLE_OWNER;
}
```

```bash
npm run test -w @meshimap/api -- actor
```

期待: `isOwnerActor は OwnerActor にだけ true を返す` が FAIL（4 つの expect すべてが逆になる）。確認後に元へ戻す。

次に、ブランドを外して型の強制を殺す:

```ts
type BrandedActor<TRole extends string, TUserId> = {
  readonly role: TRole;
  readonly userId: TUserId;
};
```

```bash
npm run typecheck -w @meshimap/api
```

期待: `actor.type-test.ts` の `bareObject` と `rawStringToOwner` の行で `Unused '@ts-expect-error' directive` が出る（素のオブジェクトが通ってしまうため）。**これが出ないなら型レベルテストが機能していない。** 確認後に元へ戻す。

- [ ] **Step 9: コミット**

```bash
git add apps/api/src/auth/actor.ts apps/api/src/auth/actor.test.ts apps/api/src/auth/actor.type-test.ts
git commit -m "feat(api): 権限主体のブランド型 Actor を追加"
```

---

## Task 4-3: Actor ファクトリの閉じ込め検査

設計書 3.2 の「コンストラクタを外部に公開しない」を機械的に強制する。TypeScript には `friend` に相当する仕組みがないため、**`toActor` を import してよいファイルをホワイトリストで固定し、逸脱をテストで落とす。**

**Files:**

- Create: `apps/api/src/auth/actor-encapsulation.test.ts`
- Modify: `apps/api/tsconfig.json`（`types` に `"node"` を足す）
- Test: `apps/api/src/auth/actor-encapsulation.test.ts`（このファイル自体がテスト）

**Interfaces:**

- Consumes: `node:fs/promises` の `readdir` / `readFile`、`node:path`、`node:url` の `fileURLToPath`、`typescript` の `createSourceFile` / `isImportDeclaration` / `isNamedImports` / `isNamespaceImport`
- Produces: なし（検査専用）

- [ ] **Step 1: `tsconfig.json` の `types` に `"node"` を足す**

`apps/api/tsconfig.json` の現状は `"types": ["@cloudflare/workers-types", "vitest/globals"]`。
`types` を明示しているため `@types/node` が読み込まれず、**`import { readFile } from 'node:fs/promises'` が
`TS2591: Cannot find name 'node:fs/promises'` で落ちる**（同じ `types` を持つ最小 tsconfig で再現済み）。
本タスク以降、ソースを走査する検査テストが `node:fs` / `node:path` / `node:url` を使うので、ここで直す。

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "vitest/globals", "node"],
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "worker-configuration.d.ts"]
}
```

`@types/node` 26.5.1 はルートに hoist 済みなので**インストールは不要**。
`"node"` を足しても Workers の型と衝突しないことは、`Response` / `Request` / `Headers` / `fetch` /
`URL` / `TextEncoder` / `AbortController` / `crypto.randomUUID()` / `crypto.subtle.digest` / `drizzle(d1)` /
`new Hono<{ Bindings }>()` を使うファイルで `tsc --noEmit` がエラー 0 になることを実測して確認した。

> **`"node"` を足しても、グローバルの `URL` は `@cloudflare/workers-types` のまま**である点に注意。
> `readFileSync(new URL(...), 'utf8')` は `node:fs` が要求する `node:url` の `URL` と別物と判定され
> **TS2769 で落ちる**（Task 4-1 の `constants-parity.test.ts` で実測）。ファイルを読むときは
> `fileURLToPath(import.meta.url)` でパス文字列へ落としてから `node:path` の `join` で組み立てること。
> 本計画のソース走査テストはすべてこの形に揃えてある。

```bash
npm run typecheck -w @meshimap/api
```

期待: エラー 0（このタスクの時点では `worker-configuration.d.ts` が未生成でも `include` に無いファイルは無視される）。

- [ ] **Step 2: 検査テストを書く**

検査器（`collectActorFactoryViolations`）は純関数として切り出し、**検査器そのものの取りこぼしを
自己テストで塞ぐ**。ソースを文字列リテラルで渡して AST 化するので、実ファイルを作らずに
「名前空間 import」「別名 import」「型だけの import」を試せる。

`apps/api/src/auth/actor-encapsulation.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Actor の生成関数を import してよいファイル（src/ からの相対パス）。
 * ここを増やすときは「本当に認証経路か」を必ず確認すること。
 *
 * 下の「ホワイトリストに載っているファイルが実在する」検査があるため、
 * **まだ存在しないファイルをここに先に書くことはできない**。
 * `auth/load-actor.ts` と `middleware/auth.ts` は Task 4-6 で作るので、
 * この時点では書かない（Task 4-6 Step 1 で足して 3 件になる）。
 */
const ACTOR_FACTORY_ALLOWLIST = new Set(['test/fixtures.ts']);

/** 生成系のシンボル。型だけの import は対象外（型は漏れても権限は作れない） */
const ACTOR_FACTORY_SYMBOLS = new Set(['toActor', 'ANONYMOUS_VIEWER']);

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 名前空間 import に対する違反メッセージ。個別シンボルの文言と混ざらないよう分けている */
const NAMESPACE_IMPORT_REASON = 'actor モジュール全体を名前空間として import している';

/**
 * そのファイルが actor モジュールの生成能力を持ち込んでいれば、違反メッセージを返す。
 *
 * 名前空間 import を別扱いするのは、`import * as actorModule from './actor'` と書けば
 * `actorModule.toActor(...)` で同じ生成ができるのに、名前付き import の検査では
 * 1 つも引っかからないため。ここを見落とすと検査全体が素通りになる。
 */
function collectActorFactoryViolations(sourceFile: ts.SourceFile, relativePath: string): string[] {
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    if (!/(^|\/)actor$/.test(moduleSpecifier.text)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) {
      // `import type { OwnerActor } from './actor'` は生成能力を持たないので対象外
      continue;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      violations.push(`${relativePath} が ${NAMESPACE_IMPORT_REASON}`);
      continue;
    }
    if (!ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      // `import { toActor as make }` では name が別名になるので、元の名前がある propertyName を優先する
      const originalName = (element.propertyName ?? element.name).text;
      if (ACTOR_FACTORY_SYMBOLS.has(originalName)) {
        violations.push(`${relativePath} が ${originalName} を import している`);
      }
    }
  }
  return violations;
}

describe('検査器そのものの取りこぼし', () => {
  /** 実ファイルを作らずに検査ロジックだけを試すためのヘルパ */
  function violationsOf(code: string): string[] {
    const sourceFile = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.ES2022, true);
    return collectActorFactoryViolations(sourceFile, 'probe.ts');
  }

  it('名前付き import の toActor を捕まえる', () => {
    expect(violationsOf("import { toActor } from './actor';")).toEqual([
      'probe.ts が toActor を import している',
    ]);
  });

  it('名前空間 import も捕まえる', () => {
    // `import * as actorModule from './actor'` は actorModule.toActor(...) と書けるため、
    // 名前付き import と同じだけ生成能力がある。ここを見落とすと検査は素通りする
    expect(violationsOf("import * as actorModule from './actor';")).toEqual([
      'probe.ts が actor モジュール全体を名前空間として import している',
    ]);
  });

  it('別名を付けた import も、元の名前で捕まえる', () => {
    expect(violationsOf("import { toActor as make } from './actor';")).toEqual([
      'probe.ts が toActor を import している',
    ]);
  });

  it('型だけの import は見逃す', () => {
    expect(violationsOf("import type { Actor } from './actor';")).toEqual([]);
    expect(violationsOf("import { type Actor } from './actor';")).toEqual([]);
  });

  it('型ガードなど生成能力のない値 import は見逃す', () => {
    expect(violationsOf("import { isOwnerActor } from './actor';")).toEqual([]);
  });

  it('別モジュールの同名 import は見逃す', () => {
    expect(violationsOf("import { toActor } from './not-actor';")).toEqual([]);
  });
});

describe('Actor ファクトリの閉じ込め', () => {
  it('toActor と ANONYMOUS_VIEWER を import してよいのはホワイトリストのファイルだけ', async () => {
    const files = await listSourceFiles(SOURCE_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const relativePath = path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
      // テストファイル自身と actor.ts 本体は対象外
      if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.type-test.ts')) {
        continue;
      }
      if (relativePath === 'auth/actor.ts') {
        continue;
      }
      if (ACTOR_FACTORY_ALLOWLIST.has(relativePath)) {
        continue;
      }

      const content = await readFile(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
      );
      violations.push(...collectActorFactoryViolations(sourceFile, relativePath));
    }

    expect(violations).toEqual([]);
  });

  it('ホワイトリストに載っているファイルが実在する', async () => {
    // パスを書き間違えると検査が素通りするので、実在確認もテストにする
    const files = await listSourceFiles(SOURCE_ROOT);
    const relativePaths = new Set(
      files.map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/')),
    );
    for (const allowed of ACTOR_FACTORY_ALLOWLIST) {
      expect(relativePaths.has(allowed)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: テストが通ることと、違反を本当に捕まえることを確認する**

```bash
npm run test -w @meshimap/api -- actor-encapsulation
npm run typecheck -w @meshimap/api
```

期待: 8 件すべて PASS（検査器の自己テスト 6 件 + 閉じ込め検査 2 件）。

このタスクは「検査を書く」タスクなので、素直に書くと**最初から緑**になる。それでは検査が働いて
いるのか分からないため、**わざと違反を作って赤を見る**こと。`apps/api/src/lib/logger.ts` の先頭に
一時的に次の 1 行を足す:

```ts
import { toActor } from '../auth/actor';
```

```bash
npm run test -w @meshimap/api -- actor-encapsulation
```

期待: `toActor と ANONYMOUS_VIEWER を import してよいのはホワイトリストのファイルだけ` が
`['lib/logger.ts が toActor を import している']` で FAIL する。**このメッセージを目で見ること。**
`import * as actorModule from '../auth/actor';` に書き換えると
`lib/logger.ts が actor モジュール全体を名前空間として import している` で落ちることも確認する
（名前空間 import を見落とすと検査全体が素通りになるため、ここは必ず両方試す）。確認後に必ず消す。

> 許可リストは Task 4-6 で `auth/load-actor.ts` と `middleware/auth.ts` を足して 3 件になる。
> 「ホワイトリストに載っているファイルが実在する」検査があるので、**まだ無いファイルを先に書くと
> このタスクが赤のまま次へ進むことになる**。だからここでは `test/fixtures.ts`（Task 4-0 で作成済み）
> だけを載せている。

> `typescript` は**ルートの devDependencies に 6.0.3 が入っている**ため、追加インストールは不要。Vitest は Node 環境で走るので `import ts from 'typescript'` がそのまま解決できる。

- [ ] **Step 4: コミット**

```bash
git add apps/api/src/auth/actor-encapsulation.test.ts apps/api/tsconfig.json
git commit -m "test(api): Actor 生成関数の import 元を検査するテストを追加"
```

> このタスクは検査だけなので実装ファイルがない。許可リストは Task 4-6 の Step 5 と Step 10 で
> 1 件ずつ増え、Task 4-6 完了時点で実物と同じ 3 件になる。

---

## Task 4-4: error-handler ミドルウェア（スタックトレースを漏らさない）

**Files:**

- Create: `apps/api/src/middleware/error-handler.ts`
- Test: `apps/api/src/middleware/error-handler.test.ts`

**Interfaces:**

- Consumes: `hono` の `ErrorHandler` / `NotFoundHandler`、`hono/http-exception` の `HTTPException`、`../lib/http-error` の `ERROR_MESSAGE_INTERNAL` / `ERROR_MESSAGE_NOT_FOUND`、`../lib/logger` の `logError`、`../lib/app-env` の `AppEnv`
- Produces:
  - `errorHandler: ErrorHandler<AppEnv>`
  - `notFoundHandler: NotFoundHandler<AppEnv>`

> **hono 4.13.7 では「文字列を throw しても 500 の固定文言」にはならない。**
> `node_modules/hono/dist/hono-base.js` の `#handleError` は
>
> ```js
> #handleError(err, c) {
>   if (err instanceof Error) {
>     return this.errorHandler(err, c);
>   }
>   throw err;
> }
> ```
>
> となっており、`Error` でない値は `errorHandler` に渡さずそのまま再送出する。
> 応答本文が一切作られないので情報漏洩は起きないが、**テストの期待は「500 の固定文言」ではなく
> 「再送出される／`logError` が呼ばれない」**にしなければ落ちる。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/middleware/error-handler.test.ts`:

```ts
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_MESSAGE_INTERNAL,
  ERROR_MESSAGE_NOT_FOUND,
  forbidden,
  notFound,
} from '../lib/http-error';
import type { AppEnv } from '../lib/app-env';
import * as logger from '../lib/logger';
import { errorHandler, notFoundHandler } from './error-handler';

/** Error インスタンス以外を throw した場合の検証用。文言自体に意味は無い */
const THROWN_STRING = 'ただの文字列';

/** 機密が混ざった例外メッセージ。これが応答に出てはいけない */
const LEAKY_MESSAGE =
  'D1_ERROR: no such column: shops.owner_id at /var/app/src/repositories/shop-repository.ts:42';

// errorHandler / notFoundHandler は ErrorHandler<AppEnv> なので、
// 素の Hono（BlankEnv）に渡すと型が合わない。アプリ本体と同じ型引数で組み立てる
function createApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .notFound(notFoundHandler)
    .get('/ok', (c) => c.json({ status: 'ok' }))
    .get('/http-exception', () => {
      throw notFound();
    })
    .get('/forbidden', () => {
      throw forbidden();
    })
    .get('/boom', () => {
      throw new Error(LEAKY_MESSAGE);
    })
    .get('/throw-string', () => {
      // Error 以外が throw された場合の経路を再現する。
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 非 Error の throw を意図的に起こす検証
      throw THROWN_STRING;
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler', () => {
  it('正常系には介入しない', async () => {
    const res = await createApp().request('/ok');
    expect(res.status).toBe(200);
  });

  it('HTTPException のステータスと文言をそのまま返す', async () => {
    const res = await createApp().request('/http-exception');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } });
  });

  it('403 の HTTPException も同じ形で返す', async () => {
    const res = await createApp().request('/forbidden');
    expect(res.status).toBe(403);
  });

  it('未知の例外は 500 と固定文言に置き換える', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { status: 500, message: ERROR_MESSAGE_INTERNAL } });
  });

  it('未知の例外のメッセージを応答本文に含めない', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    const body = await res.text();
    expect(body).not.toContain('D1_ERROR');
    expect(body).not.toContain('owner_id');
    expect(body).not.toContain('shop-repository.ts');
    expect(body).not.toContain(LEAKY_MESSAGE);
  });

  it('スタックトレースを応答本文に含めない', async () => {
    vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    const res = await createApp().request('/boom');
    const body = await res.text();
    expect(body).not.toMatch(/at\s|\.ts:|\.js:|stack/i);
  });

  it('Error でない値の throw は onError に渡らず再送出される（応答本文が作られない）', async () => {
    // hono 4.13.7 の #handleError は `err instanceof Error` を満たさない値を
    // errorHandler へ渡さずそのまま再送出する（node_modules/hono/dist/hono-base.js で確認）。
    // 単一ハンドラ経路では同期 try/catch の中で再送出されるため、request() は
    // 拒否された Promise ではなく同期 throw になる。だから try/catch で受ける。
    // 応答本文が一切作られないので、throw された値がクライアントへ出る経路は無い。
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      await createApp().request('/throw-string');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(THROWN_STRING);
    expect(spy).not.toHaveBeenCalled();
  });

  it('未知の例外はサーバ側ログに残す', async () => {
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    await createApp().request('/boom');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('HTTPException はサーバ側ログに残さない（想定内のため）', async () => {
    const spy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    await createApp().request('/http-exception');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('notFoundHandler', () => {
  it('未定義のルートは errorHandler と同じ形の 404 を返す', async () => {
    const res = await createApp().request('/no-such-route');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- error-handler
```

期待: `Cannot find module './error-handler' imported from .../apps/api/src/middleware/error-handler.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/middleware/error-handler.ts`:

```ts
import { HTTPException } from 'hono/http-exception';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from '../lib/app-env';
import { ERROR_MESSAGE_INTERNAL, ERROR_MESSAGE_NOT_FOUND } from '../lib/http-error';
import { logError } from '../lib/logger';

/**
 * 例外を JSON へ変換する唯一の出口。
 * HTTPException は「意図して投げたもの」なので文言をそのまま返してよい
 * （文言は src/lib/http-error.ts の固定文字列に限られる）。
 * それ以外は何が入っているか分からないので、内容を一切外へ出さない。
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { status: err.status, message: err.message } }, err.status);
  }

  // 例外の中身（SQL、ファイルパス、スタック）はサーバ側のログにだけ残す
  logError('未処理の例外', err);
  return c.json({ error: { status: 500, message: ERROR_MESSAGE_INTERNAL } }, 500);
};

/** 未定義ルート。errorHandler の 404 と応答の形を揃える（形が違うと経路が推測できる） */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND } }, 404);
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- error-handler
```

期待: 10 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`error-handler.ts` の 500 応答を「親切な」実装に変える:

```ts
logError('未処理の例外', err);
return c.json(
  { error: { status: 500, message: err instanceof Error ? err.message : ERROR_MESSAGE_INTERNAL } },
  500,
);
```

```bash
npm run test -w @meshimap/api -- error-handler
```

期待: `未知の例外は 500 と固定文言に置き換える` / `未知の例外のメッセージを応答本文に含めない` / `スタックトレースを応答本文に含めない` の 3 件が FAIL。**これが FAIL しないなら、情報漏洩を検出できていない。** 確認後に元へ戻す。

次に `err instanceof HTTPException` を `!(err instanceof HTTPException)` に変えて実行し、**7 件が FAIL する**ことを確認してから元へ戻す
（`HTTPException のステータスと文言をそのまま返す` / `403 の HTTPException も同じ形で返す` /
`未知の例外は 500 と固定文言に置き換える` / `未知の例外のメッセージを応答本文に含めない` /
`スタックトレースを応答本文に含めない` / `未知の例外はサーバ側ログに残す` /
`HTTPException はサーバ側ログに残さない（想定内のため）`。判定を反転すると
「想定内／想定外」の両側が同時に入れ替わるので、片側 1 件では済まない）。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/middleware/error-handler.ts apps/api/src/middleware/error-handler.test.ts
git commit -m "feat(api): 情報を漏らさないエラーハンドラを追加"
```

---

## Task 4-5: DB クライアントと Better Auth の初期化

**Files:**

- Create: `apps/api/src/auth/auth.ts`
- Test: `apps/api/src/auth/auth.test.ts`
- 読むだけ: `apps/api/src/db/client.ts`（**Phase 3 で作成済み**）

> `apps/api/src/db/client.ts` は **Phase 3 のコミットで既に入っている**（19 行。`createDatabase` と
> `Database` を export し、`apps/api/src/db/client.test.ts` も 7 件ある）。
> 「Phase 3 の `apps/api/src/db/` 配下は読むだけ」というグローバル制約どおり、
> **このタスクで作り直さない**。書き換えると Phase 3 の型（`DrizzleD1Database<typeof schema>`）と
> 戻り値の型注釈が失われ、`client.test.ts` が壊れる。

**Interfaces:**

- Consumes:
  - `drizzle-orm/d1` の `drizzle`
  - `better-auth` の `betterAuth`
  - `better-auth/adapters/drizzle` の `drizzleAdapter`
  - `@better-auth/expo` の `expo`
  - `../db/client`（**Phase 3**）の `createDatabase(d1: D1Database): Database` / `type Database = DrizzleD1Database<typeof schema>`
  - `../db/schema`（Phase 3）の `account` / `profiles` / `session` / `user` / `verification`
  - `../db/constants` の `ROLE_USER` / `PROFILE_STATUS_ACTIVE`
  - `../lib/constants` の `PROFILE_DISPLAY_NAME_MAX_LENGTH`
  - `../lib/app-env` の `AppBindings`
  - `../test/fixtures`（テストのみ）の `createTestWorld` / `readRow` / `countRows`
- Produces:
  - `AUTH_BASE_PATH: '/api/auth'`
  - `createAuth(db: Database, env: AppBindings): Auth`
  - `type Auth = ReturnType<typeof createAuth>`

### 設定値の根拠（すべて `node_modules` と実測で裏取り済み）

| 設定                              | 値                                                | 根拠                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`                        | `drizzleAdapter(db, { provider: 'sqlite', ... })` | Drizzle アダプタなら Phase 3 の `src/db/schema/` を単一の正にできる                                                                                                                                                                                                                                                                                                      |
| `provider`                        | `'sqlite'`                                        | `DrizzleAdapterConfig.provider` の型は `"pg" \| "mysql" \| "sqlite"`                                                                                                                                                                                                                                                                                                     |
| `transaction`                     | `false`                                           | **必須**。`true` にすると sign-up が 500 になる。miniflare 上の本物の D1 で実測した例外文言は `D1_ERROR: To execute a transaction, please use the state.storage.transaction() ... instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements`。`user` テーブルは 0 行のままだった                                                                                      |
| `schema`                          | `{ user, session, account, verification }`        | Better Auth に渡すのはこの 4 つだけ。`profiles` を渡すと Better Auth が所有権を持ってしまう                                                                                                                                                                                                                                                                              |
| `basePath`                        | `'/api/auth'`                                     | Hono 側の `app.on(['GET','POST'], '/api/auth/*', ...)` と一致させる。ずらすと同じ URL への POST が 404 になることを実測済み                                                                                                                                                                                                                                              |
| `plugins`                         | `[expo()]`                                        | `@better-auth/expo` のサーバプラグイン。`expo-origin` ヘッダを `origin` に移し替える `onRequest` と `/expo-authorization-proxy` エンドポイントを持つ（`@better-auth/expo/dist/index.js` を直接読んで確認）                                                                                                                                                               |
| `trustedOrigins`                  | ``[`${env.MOBILE_APP_SCHEME}://`]``               | **`://` を付けないと一致しない。** `better-auth/dist/auth/trusted-origins.mjs` の `parseCustomSchemeOrigin` は `value.indexOf(':')` が `0` 以下なら `null` を返すため、`'meshimap'` 単体はどの URL とも一致しない。実測でも `matchesOriginPattern('meshimap://callback', 'meshimap')` は `false`、`matchesOriginPattern('meshimap://callback', 'meshimap://')` は `true` |
| `telemetry.enabled`               | `false`                                           | Worker から外部への送信を発生させない                                                                                                                                                                                                                                                                                                                                    |
| `databaseHooks.user.create.after` | `profiles` を 1 行作る                            | **Better Auth はサインアップで `profiles` を作らない**（実測: sign-up 後 `SELECT COUNT(*) FROM profiles` が 0）。作らないと Task 4-6 の `loadActor` が必ず `null` になり、サインアップ直後のユーザーが全 API で 401 になる                                                                                                                                               |
| セッションの持ち方                | **Cookie**                                        | sign-up と sign-in の双方で `set-cookie: better-auth.session_token=...` が返ることを実測。Expo クライアント（`@better-auth/expo/dist/client.js`）はこれを SecureStore に保存して `Cookie` ヘッダで送り返す。`Authorization: Bearer` は `bearer` プラグインなしでは `getSession` が `null` を返す                                                                         |

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/auth/auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_STATUS_ACTIVE, ROLE_USER } from '../db/constants';
import { countRows, createTestWorld, readRow } from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { createDatabase } from '../db/client';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import { AUTH_BASE_PATH, createAuth } from './auth';

const TEST_BINDINGS = {
  BETTER_AUTH_SECRET: 'test-secret-value-at-least-32-characters-long',
  BETTER_AUTH_URL: 'http://localhost:8787',
  // wrangler.jsonc の vars と同じ「スキーム名だけ」の形。`://` は auth.ts が付ける
  MOBILE_APP_SCHEME: 'meshimap',
} as const;

/**
 * このテストでは D1 以外のバインディング（R2 / KV / DO）を一切使わない。
 * AppBindings を満たすためだけにダミーを置くと、使っていない依存が増えて壊れやすくなるので、
 * createAuth が実際に読む 3 つのキーだけを持つオブジェクトを渡す。
 * createAuth の引数型を AppBindings から「必要な 3 キーだけ」に絞ることで as を使わずに済ませる。
 * （`AppBindings` 型そのものはこのファイルで使わない。import すると `noUnusedLocals` と
 * `@typescript-eslint/no-unused-vars` の両方で落ちるので**書かない**こと）
 */
function createTestAuth(world: TestWorld) {
  return createAuth(createDatabase(world.d1), TEST_BINDINGS);
}

function signUpRequest(body: Record<string, string>): Request {
  return new Request(`${TEST_BINDINGS.BETTER_AUTH_URL}${AUTH_BASE_PATH}/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_BINDINGS.BETTER_AUTH_URL },
    body: JSON.stringify(body),
  });
}

function signInRequest(body: Record<string, string>): Request {
  return new Request(`${TEST_BINDINGS.BETTER_AUTH_URL}${AUTH_BASE_PATH}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_BINDINGS.BETTER_AUTH_URL },
    body: JSON.stringify(body),
  });
}

/** `set-cookie` ヘッダから `name=value` の部分だけを取り出す */
function toCookieHeader(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

describe('createAuth', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('basePath は /api/auth である', () => {
    expect(AUTH_BASE_PATH).toBe('/api/auth');
  });

  it('メールとパスワードでサインアップできる', async () => {
    const auth = createTestAuth(world);
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ user: { id: string; email: string } }>();
    expect(body.user.email).toBe('alice@example.com');
  });

  it('サインアップで profiles が role=user / status=active で自動作成される', async () => {
    const auth = createTestAuth(world);
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    const body = await res.json<{ user: { id: string } }>();

    const profile = await readRow(
      world,
      'SELECT user_id, role, display_name, status FROM profiles WHERE user_id = ?',
      body.user.id,
    );

    expect(profile).toStrictEqual({
      user_id: body.user.id,
      role: ROLE_USER,
      display_name: 'Alice',
      status: PROFILE_STATUS_ACTIVE,
    });
  });

  it('表示名が長すぎてもサインアップが 500 にならず、上限まで切り詰められる', async () => {
    // profiles.display_name には CHECK(length(...) <= 50) が掛かっている。
    // 切り詰めずに INSERT すると databaseHooks の中で例外が出てサインアップ全体が落ちる。
    const auth = createTestAuth(world);
    const longName = 'あ'.repeat(PROFILE_DISPLAY_NAME_MAX_LENGTH + 30);

    const res = await auth.handler(
      signUpRequest({ email: 'long@example.com', password: 'password1234', name: longName }),
    );

    expect(res.status).toBe(200);
    const profile = await readRow(
      world,
      'SELECT length(display_name) AS length FROM profiles WHERE display_name IS NOT NULL',
    );
    expect(profile).toStrictEqual({ length: PROFILE_DISPLAY_NAME_MAX_LENGTH });
  });

  it('サインインでセッション Cookie が発行される', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const res = await auth.handler(
      signInRequest({ email: 'alice@example.com', password: 'password1234' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('session_token');
  });

  it('Cookie 付きで getSession を呼ぶとユーザーが取れる', async () => {
    const auth = createTestAuth(world);
    const signUpRes = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: toCookieHeader(signUpRes) }),
    });

    expect(session).not.toBeNull();
    expect(session?.user.email).toBe('alice@example.com');
  });

  it('Cookie なしで getSession を呼ぶと null になる', async () => {
    const auth = createTestAuth(world);
    const session = await auth.api.getSession({ headers: new Headers() });
    expect(session).toBeNull();
  });

  it('壊れた Cookie では null になる（例外にならない）', async () => {
    const auth = createTestAuth(world);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: 'better-auth.session_token=deadbeef' }),
    });
    expect(session).toBeNull();
  });

  it('別の秘密鍵で作ったインスタンスでは同じ Cookie が通らない', async () => {
    // セッション Cookie は secret で署名されている。
    // 署名検証を外すと「他人が組み立てた Cookie」で入れてしまう。
    const auth = createTestAuth(world);
    const signUpRes = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    const cookie = toCookieHeader(signUpRes);

    const otherAuth = createAuth(createDatabase(world.d1), {
      ...TEST_BINDINGS,
      BETTER_AUTH_SECRET: 'a-completely-different-secret-value-32ch',
    });

    expect(await otherAuth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it('間違ったパスワードではサインインできない', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const res = await auth.handler(
      signInRequest({ email: 'alice@example.com', password: 'wrong-password' }),
    );

    // 実測値は 401。将来 429 などに変わっても「通らない」ことが本質なので不等号で見る
    expect(res.status).not.toBe(200);
  });

  it('サインアップに失敗したときは user も profiles も残らない', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    // 同じメールアドレスは user.email の UNIQUE 制約で弾かれる
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice2' }),
    );

    expect(res.status).not.toBe(200);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM user')).toBe(1);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM profiles')).toBe(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: `Cannot find module './auth' imported from .../apps/api/src/auth/auth.test.ts` で失敗する。**このメッセージを目で見ること。**

> `../db/client` は **Phase 3 で実在する**ので解決エラーにはならない。落ちるのは `./auth` だけ。
> ここで `../db/client` が見つからないと出るなら、Phase 3 の成果物を消してしまっている。

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/auth/auth.ts`:

```ts
import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { PROFILE_STATUS_ACTIVE, ROLE_USER } from '../db/constants';
import { account, profiles, session, user, verification } from '../db/schema';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import type { Database } from '../db/client';
import type { AppBindings } from '../lib/app-env';

/** Hono 側の `app.on(['GET', 'POST'], '/api/auth/*', ...)` と一致させる */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * createAuth が実際に読むバインディングだけを要求する。
 * AppBindings 全体を要求すると、テストで R2 / KV / Durable Object のダミーを
 * `as` で捏造する必要が出る。必要な 3 つに絞れば `as` なしで呼べる。
 * AppBindings はこの型を構造的に満たすので、本番の呼び出し側は何も変えなくてよい。
 */
export type AuthBindings = Pick<
  AppBindings,
  'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'
>;

/**
 * Better Auth のインスタンスを作る。
 * Workers では env がリクエストごとなので、リクエスト単位で生成する。
 *
 * セッションは Cookie で運ぶ。Expo クライアント（@better-auth/expo）は
 * set-cookie を SecureStore に保存して Cookie ヘッダで送り返す実装なので、
 * bearer プラグインは不要（Bearer だけでは getSession が null になることを実測済み）。
 */
export function createAuth(db: Database, env: AuthBindings) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      // Better Auth が触ってよいのはこの 4 テーブルだけ。profiles は渡さない
      schema: { user, session, account, verification },
      // D1 に対話的トランザクションがないため無効化する。
      // true にすると `begin` の時点で D1_ERROR になり sign-up が 500 になる（実測済み）
      transaction: false,
    }),
    emailAndPassword: { enabled: true },
    // Expo アプリのカスタムスキームを trustedOrigins に加え、認可プロキシを生やす
    plugins: [expo()],
    // `://` まで含めないと better-auth の parseCustomSchemeOrigin が null を返して一致しない
    trustedOrigins: [`${env.MOBILE_APP_SCHEME}://`],
    // Worker から外部への送信を発生させない
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          /**
           * Better Auth は user しか作らないため、アプリ側のロールを持つ profiles をここで作る。
           * これが無いと Task 4-6 の loadActor が常に null になり、
           * サインアップ直後のユーザーが全 API で 401 になる。
           * 新規ユーザーのロールは常に user。owner への昇格は店舗申請の審査を通す（設計書 §4）。
           */
          after: async (createdUser) => {
            await db.insert(profiles).values({
              userId: createdUser.id,
              role: ROLE_USER,
              // CHECK(length(display_name) <= 50) を満たすため切り詰める
              displayName: createdUser.name.slice(0, PROFILE_DISPLAY_NAME_MAX_LENGTH),
              status: PROFILE_STATUS_ACTIVE,
              // Better Auth の User.createdAt は Date。
              // profiles.created_at は mode: 'timestamp_ms' なので Date のまま渡す
              createdAt: createdUser.createdAt,
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: 11 件すべて PASS。

> このテストは 1 件ごとに miniflare の D1 を作り直し、さらに scrypt でパスワードを導出する。
> 実測で `createMigratedD1()` が 166〜233ms、サインアップ 1 回が 99〜130ms。
> Phase 3 の `vitest.config.ts` が `testTimeout: 30_000` / `hookTimeout: 60_000` を設定済みなので余裕がある。

- [ ] **Step 5: 意図的に設定を壊してテストが検知することを確認する**

まず `auth.ts` の `transaction: false` を `true` に変える:

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: サインアップ系が FAIL し、ログに
`D1_ERROR: To execute a transaction, please use the state.storage.transaction() ... instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements`
が出る（miniflare 上の本物の D1 で実測した文言）。**この文言を目で見ること。** 確認後に元へ戻す。

次に `databaseHooks` のブロックごと削除する:

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: `サインアップで profiles が role=user / status=active で自動作成される` が FAIL。
**FAIL しないなら、サインアップ直後のユーザーが全 API で 401 になる欠陥を検出できていない。** 確認後に元へ戻す。

次に `displayName` の `.slice(0, PROFILE_DISPLAY_NAME_MAX_LENGTH)` を外す:

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: `表示名が長すぎてもサインアップが 500 にならず、上限まで切り詰められる` が FAIL。確認後に元へ戻す。

最後に `trustedOrigins` の `` `${env.MOBILE_APP_SCHEME}://` `` から `://` を取って `env.MOBILE_APP_SCHEME` にする。
このテストはすべて `origin: http://localhost:8787`（= `baseURL`）で投げているため **テストは通ってしまう**。
代わりに次のワンライナーで、スキームだけでは一致しないことを直接確かめる:

```bash
node -e "import('./node_modules/better-auth/dist/auth/trusted-origins.mjs').then(({matchesOriginPattern})=>{console.log(matchesOriginPattern('meshimap://callback','meshimap'));console.log(matchesOriginPattern('meshimap://callback','meshimap://'));})"
```

期待: `false` と `true` がこの順で出る。**`false` が出ることを目で見てから `://` を戻す。**
Phase 5 で Expo からのディープリンク経由の認証を通すときに効いてくる。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/auth/auth.ts apps/api/src/auth/auth.test.ts
git commit -m "feat(api): D1 + Drizzle 上の Better Auth 初期化と profiles 自動作成を追加"
```

---

## Task 4-6: auth ミドルウェア（Better Auth セッション → Actor）

設計書 6 章のとおり `role` は Better Auth の `user` テーブルではなく **`profiles` テーブル**にある。したがって「セッション検証」と「ロール解決」は 2 段階になる。

**Files:**

- Create: `apps/api/src/auth/load-actor.ts`
- Create: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/test/fixtures.ts`（Task 4-0 で作成済み。`createTestBindings` / `signUpAs` / `corruptProfileRole` を追記する）
- Modify: `apps/api/src/auth/auth.test.ts`（Task 4-5 で作成済み。ローカルの `TEST_BINDINGS` を `createTestBindings` に寄せる）
- Test: `apps/api/src/auth/load-actor.test.ts`
- Test: `apps/api/src/middleware/auth.test.ts`

**Interfaces:**

- Consumes:
  - `drizzle-orm` の `eq`
  - `@meshimap/core` の `isRole`
  - `hono/factory` の `createMiddleware`
  - `../db/schema`（Phase 3）の `profiles`
  - `../db/client`（**Phase 3**）の `createDatabase` / `Database`
  - `../db/constants`（Phase 3）の `PROFILE_STATUS_ACTIVE` / `ROLE_ADMIN` / `ROLE_OWNER` / `ROLE_USER` / `PROFILE_STATUS_SUSPENDED` / `PROFILE_STATUS_DELETED`
  - `../auth/actor`（Task 4-2）の `toActor` / `ANONYMOUS_VIEWER` / `ROLE_ANONYMOUS` / `Actor`
  - `../auth/auth`（Task 4-5）の `createAuth` / `AUTH_BASE_PATH`
  - `../lib/app-env`（Task 4-1）の `AppBindings` / `AppEnv`
  - `../lib/http-error`（Task 4-1）の `forbidden` / `ERROR_MESSAGE_FORBIDDEN`
  - `../test/fixtures`（Task 4-0）の `createTestWorld` / `readRow` / `runWrite` / `seedUser` / `TestWorld`
- Produces:
  - `type ProfileRow = { readonly role: string; readonly status: string }`
  - `decideActor(userId: string, row: ProfileRow | undefined): ActorLoadResult`
  - `type ActorLoadResult = { readonly kind: 'found'; readonly actor: Actor } | { readonly kind: 'no-profile' } | { readonly kind: 'suspended' } | { readonly kind: 'invalid-role' }`
  - `loadActor(db: Database, userId: string): Promise<ActorLoadResult>`
  - `authMiddleware: MiddlewareHandler<AppEnv>`
  - （fixtures 追記分）`TEST_BASE_URL` / `TEST_BETTER_AUTH_SECRET` / `TEST_MOBILE_APP_SCHEME` / `type TestBindings` / `createTestBindings(world)` / `type TestUser` / `signUpAs(world, email, role)` / `corruptProfileRole(world, userId, role)`

### 判定表

| セッション     | profiles 行 | status                  | role   | Context の viewer       | 後続の結果                                           |
| -------------- | ----------- | ----------------------- | ------ | ----------------------- | ---------------------------------------------------- |
| なし           | —           | —                       | —      | `ANONYMOUS_VIEWER`      | 公開 API は 200、認証必須は 401                      |
| 無効・期限切れ | —           | —                       | —      | `ANONYMOUS_VIEWER`      | 同上（例外にしない）                                 |
| あり           | 無し        | —                       | —      | `ANONYMOUS_VIEWER`      | 同上（プロフィール未作成のユーザーは未ログイン扱い） |
| あり           | あり        | `suspended` / `deleted` | —      | （設定せず）            | **403**（ロール単位の判定なので ID は漏れない）      |
| あり           | あり        | `active`                | 不正値 | （設定せず）            | **403**（DB が壊れている。通してはいけない）         |
| あり           | あり        | `active`                | 正常   | `toActor(userId, role)` | ロールに応じて処理                                   |

### なぜ `decideActor` と `loadActor` に分けるか

`profiles.role` には Phase 3 のマイグレーションで
`CONSTRAINT "ck_profiles_role" CHECK("profiles"."role" IN ('user', 'owner', 'admin'))`
が掛かっている（`sqlite_master` から実際に読んで確認済み）。つまり **通常の UPDATE では不正な role を作れない**。

```
D1_ERROR: CHECK constraint failed: ck_profiles_role: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)
```

判定ロジックを純関数 `decideActor` として切り出せば、DB を壊さずに `invalid-role` の分岐を直接検証できる。
DB 経由の検証も捨てない: `PRAGMA ignore_check_constraints = ON` は miniflare 上の D1 でも効く（実測済み）ので、
`corruptProfileRole` で一時的に制約を外して壊した行を作り、ミドルウェアが 403 を返すところまで通しで確認する。

- [ ] **Step 1: fixtures に認証用のヘルパを追記する**

`apps/api/src/test/fixtures.ts` の末尾に足す（既存の `createTestWorld` などはそのまま）:

```ts
import { AUTH_BASE_PATH, createAuth } from '../auth/auth';
import { createDatabase } from '../db/client';
import type { AppBindings } from '../lib/app-env';

/** Better Auth の baseURL。テストのリクエストもこの origin で投げる */
export const TEST_BASE_URL = 'http://localhost:8787';
/** 本番の鍵は wrangler secret で入れる。テストでは固定値でよい */
export const TEST_BETTER_AUTH_SECRET = 'test-secret-value-at-least-32-characters-long';
/** wrangler.jsonc の vars と同じ「スキーム名だけ」の形。`://` は auth.ts が付ける */
export const TEST_MOBILE_APP_SCHEME = 'meshimap';

/**
 * Phase 4 のテストが実際に読むバインディングだけを持つ型。
 * R2 / KV / Durable Object のダミーを `as` で捏造しないための絞り込み。
 * `app.request(path, init, bindings)` の第 3 引数の型は `AppBindings | {}` なので、
 * 部分的なオブジェクトでもそのまま渡せる（`hono/dist/types/hono-base.d.ts` の `request` シグネチャで確認済み）。
 * 返り値に型注釈を付けてあるので、キー名を打ち間違えれば AppBindings との照合でコンパイルエラーになる。
 */
export type TestBindings = Pick<
  AppBindings,
  'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'
>;

export function createTestBindings(world: TestWorld): TestBindings {
  return {
    DB: world.d1,
    BETTER_AUTH_SECRET: TEST_BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    MOBILE_APP_SCHEME: TEST_MOBILE_APP_SCHEME,
  };
}

export type TestUser = {
  readonly userId: string;
  readonly email: string;
  /** `name=value` の形。リクエストの `cookie` ヘッダにそのまま入れる */
  readonly cookie: string;
};

/**
 * Better Auth で本当にサインアップし、profiles のロールを指定値へ変える。
 *
 * ロールを INSERT ではなく UPDATE するのは、Task 4-5 の `databaseHooks.user.create.after` が
 * すでに `role = 'user'` の行を作っているため。INSERT すると PRIMARY KEY 衝突で落ちる。
 *
 * 認証経路を本物のまま通すので、Actor は必ず authMiddleware が生成する
 * （この関数は `toActor` を呼ばない。リポジトリ単体テスト用の `buildActorForTest` とは別経路）。
 */
export async function signUpAs(
  world: TestWorld,
  email: string,
  role: Role = ROLE_USER,
): Promise<TestUser> {
  const bindings = createTestBindings(world);
  const auth = createAuth(createDatabase(world.d1), bindings);

  const response = await auth.handler(
    new Request(`${TEST_BASE_URL}${AUTH_BASE_PATH}/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_BASE_URL },
      body: JSON.stringify({ email, password: 'password1234', name: email }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`サインアップに失敗した: ${response.status}`);
  }
  const body = await response.json<{ user: { id: string } }>();
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const changed = await runWrite(
    world,
    'UPDATE profiles SET role = ? WHERE user_id = ?',
    role,
    body.user.id,
  );
  // databaseHooks が profiles を作らなくなったら、ここで気付けるようにする
  if (changed !== 1) {
    throw new Error(`profiles の更新行数が想定外: ${changed}`);
  }

  return { userId: body.user.id, email, cookie };
}

/**
 * profiles.role に CHECK 制約が許さない値を無理やり書き込む。
 *
 * 本番では起き得ないが、**マイグレーション事故や DB 直編集で壊れた値が入ったときに
 * API が通してしまわないこと**を証明するために必要。
 * `PRAGMA ignore_check_constraints` は接続に対する設定なので、必ず OFF に戻してから抜ける。
 * 戻し忘れると、以降の同じ world でのテストが制約なしの緩い世界で回ってしまう。
 */
export async function corruptProfileRole(
  world: TestWorld,
  userId: string,
  role: string,
): Promise<void> {
  await world.d1.prepare('PRAGMA ignore_check_constraints = ON').run();
  try {
    const changed = await runWrite(
      world,
      'UPDATE profiles SET role = ? WHERE user_id = ?',
      role,
      userId,
    );
    if (changed !== 1) {
      throw new Error(`profiles の更新行数が想定外: ${changed}`);
    }
  } finally {
    await world.d1.prepare('PRAGMA ignore_check_constraints = OFF').run();
  }
}
```

ファイル冒頭の import 文も次のとおり足す:

```ts
import { ROLE_USER } from '../db/constants';
import type { ProfileStatus, Role, ShopStatus } from '../db/constants';
```

（`PROFILE_STATUS_ACTIVE` / `SHOP_STATUS_PUBLISHED` は Task 4-0 で既に import 済み。`ROLE_USER` だけ増える）

- [ ] **Step 2: Task 4-5 のテストを fixtures に寄せる（Refactor）**

`apps/api/src/auth/auth.test.ts` のローカル定数を消し、fixtures から取る。
同じ秘密鍵の文字列が 2 箇所に散ると、片方だけ変えたときに「なぜか Cookie が通らない」で時間を溶かす。

```ts
// 削除する
const TEST_BINDINGS = {
  BETTER_AUTH_SECRET: 'test-secret-value-at-least-32-characters-long',
  BETTER_AUTH_URL: 'http://localhost:8787',
  MOBILE_APP_SCHEME: 'meshimap',
} as const;

function createTestAuth(world: TestWorld) {
  return createAuth(createDatabase(world.d1), TEST_BINDINGS);
}
```

```ts
// 置き換え後
import {
  countRows,
  createTestBindings,
  createTestWorld,
  readRow,
  TEST_BASE_URL,
} from '../test/fixtures';

function createTestAuth(world: TestWorld) {
  return createAuth(createDatabase(world.d1), createTestBindings(world));
}
```

併せて次の 3 箇所を書き換える。

1. `signUpRequest` / `signInRequest` の中の `TEST_BINDINGS.BETTER_AUTH_URL` を `TEST_BASE_URL` にする。
2. `別の秘密鍵で作ったインスタンスでは同じ Cookie が通らない` の中の
   `{ ...TEST_BINDINGS, BETTER_AUTH_SECRET: 'a-completely-different-secret-value-32ch' }` を
   `{ ...createTestBindings(world), BETTER_AUTH_SECRET: 'a-completely-different-secret-value-32ch' }` にする。
3. `createTestAuth` の上のコメント後半 3 行（`createAuth が実際に読む 3 つのキーだけ…` から
   `…両方で落ちるので**書かない**こと）` まで）を、次の 2 行に差し替える。
   Task 4-5 の時点では `AppBindings` を import しない理由を書く必要があったが、
   fixtures に寄せたあとは「鍵の文字列を散らさない」ことが理由になる。

```ts
 * fixtures の createTestBindings が返す「実際に読むキーだけ」のオブジェクトを渡す。
 * 秘密鍵の文字列を 2 箇所に散らすと、片方だけ変えたときに原因を追いにくくなる。
```

`TEST_BETTER_AUTH_SECRET` は `createTestBindings` の中でしか使わないので、このファイルでは import しない
（import すると `noUnusedLocals` でコンパイルエラーになる）。

```bash
npm run test -w @meshimap/api -- auth.test
```

期待: Task 4-5 の 11 件がそのまま PASS（リファクタなので緑のまま）。

- [ ] **Step 3: 失敗するテストを書く（decideActor / loadActor）**

`apps/api/src/auth/load-actor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_ACTIVE,
  PROFILE_STATUS_DELETED,
  PROFILE_STATUS_SUSPENDED,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
} from '../db/constants';
import { createDatabase } from '../db/client';
import { corruptProfileRole, createTestWorld, runWrite, seedUser } from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { decideActor, loadActor } from './load-actor';

describe('decideActor', () => {
  it('行が無ければ no-profile を返す', () => {
    expect(decideActor('usr_alice', undefined)).toEqual({ kind: 'no-profile' });
  });

  it('active な user から UserActor を作る', () => {
    const result = decideActor('usr_alice', { role: ROLE_USER, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_USER);
      expect(result.actor.userId).toBe('usr_alice');
    }
  });

  it('active な owner から OwnerActor を作る', () => {
    const result = decideActor('usr_bob', { role: ROLE_OWNER, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_OWNER);
    }
  });

  it('active な admin から AdminActor を作る', () => {
    const result = decideActor('usr_carol', { role: ROLE_ADMIN, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_ADMIN);
    }
  });

  it('suspended なら suspended を返す', () => {
    expect(decideActor('usr_dave', { role: ROLE_USER, status: PROFILE_STATUS_SUSPENDED })).toEqual({
      kind: 'suspended',
    });
  });

  it('suspended な admin でも suspended を返す（特権を残さない）', () => {
    expect(decideActor('usr_eve', { role: ROLE_ADMIN, status: PROFILE_STATUS_SUSPENDED })).toEqual({
      kind: 'suspended',
    });
  });

  it('deleted（退会済み）も suspended と同じ扱いにする', () => {
    // status は active / suspended / deleted の 3 値。active 以外はすべて拒否する
    expect(decideActor('usr_frank', { role: ROLE_USER, status: PROFILE_STATUS_DELETED })).toEqual({
      kind: 'suspended',
    });
  });

  it('role が未知の値なら invalid-role を返す', () => {
    // DB 直編集やマイグレーション事故で壊れた値が入った場合に通してはいけない
    expect(decideActor('usr_grace', { role: 'superuser', status: PROFILE_STATUS_ACTIVE })).toEqual({
      kind: 'invalid-role',
    });
  });
});

describe('loadActor', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('profiles が無いユーザーには no-profile を返す', async () => {
    const result = await loadActor(createDatabase(world.d1), 'usr_missing');
    expect(result).toEqual({ kind: 'no-profile' });
  });

  it('active な user から UserActor を作る', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_USER });

    const result = await loadActor(createDatabase(world.d1), 'usr_alice');

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_USER);
      expect(result.actor.userId).toBe('usr_alice');
    }
  });

  it('suspended なユーザーには suspended を返す', async () => {
    await seedUser(world, {
      userId: 'usr_dave',
      role: ROLE_ADMIN,
      status: PROFILE_STATUS_SUSPENDED,
    });

    const result = await loadActor(createDatabase(world.d1), 'usr_dave');

    expect(result).toEqual({ kind: 'suspended' });
  });

  it('他のユーザーの profiles を混ぜて引かない', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_ADMIN });
    await seedUser(world, { userId: 'usr_bob', role: ROLE_USER });

    const result = await loadActor(createDatabase(world.d1), 'usr_bob');

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      // WHERE user_id が抜けていると先頭行（admin）が返ってしまう
      expect(result.actor.role).toBe(ROLE_USER);
    }
  });

  it('未知の role は DB の CHECK 制約が先に弾く（防御の一段目）', async () => {
    await seedUser(world, { userId: 'usr_grace', role: ROLE_USER });

    await expect(
      runWrite(world, 'UPDATE profiles SET role = ? WHERE user_id = ?', 'superuser', 'usr_grace'),
    ).rejects.toThrow(/CHECK constraint failed: ck_profiles_role/);
  });

  it('CHECK をすり抜けて壊れた role が入っていたら invalid-role を返す（防御の二段目）', async () => {
    await seedUser(world, { userId: 'usr_grace', role: ROLE_USER });
    await corruptProfileRole(world, 'usr_grace', 'superuser');

    const result = await loadActor(createDatabase(world.d1), 'usr_grace');

    expect(result).toEqual({ kind: 'invalid-role' });
  });
});
```

- [ ] **Step 4: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- load-actor
```

期待: `Cannot find module './load-actor' imported from .../apps/api/src/auth/load-actor.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 5: loadActor を実装する**

`apps/api/src/auth/load-actor.ts`:

```ts
import { isRole } from '@meshimap/core';
import { eq } from 'drizzle-orm';
import { PROFILE_STATUS_ACTIVE } from '../db/constants';
import { profiles } from '../db/schema';
import type { Database } from '../db/client';
import { toActor } from './actor';
import type { Actor } from './actor';

/**
 * Actor を組み立てられなかった理由を呼び出し側へ伝える。
 * 例外ではなく値で返すのは、ミドルウェア以外（テストやバッチ）から使っても
 * HTTP のステータスを勝手に決めてしまわないようにするため。
 */
export type ActorLoadResult =
  | { readonly kind: 'found'; readonly actor: Actor }
  | { readonly kind: 'no-profile' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'invalid-role' };

/**
 * profiles から読んだ生の行。
 * role / status を `Role` / `ProfileStatus` ではなく `string` で受けるのは、
 * **DB の値が型どおりである保証がない**（CHECK 制約はマイグレーションで外れうる）ため。
 * 信じずに検査するのがこの関数の仕事。
 */
export type ProfileRow = {
  readonly role: string;
  readonly status: string;
};

/**
 * profiles の行から Actor を決める純関数。
 *
 * DB アクセスと分けてあるのは、`invalid-role` の分岐を直接検証するため。
 * `profiles.role` には ck_profiles_role という CHECK 制約があるので、
 * 通常の UPDATE では壊れた値を作れず、DB 経由だとこの分岐に到達できない。
 */
export function decideActor(userId: string, row: ProfileRow | undefined): ActorLoadResult {
  if (row === undefined) {
    return { kind: 'no-profile' };
  }
  if (row.status !== PROFILE_STATUS_ACTIVE) {
    // suspended も deleted も拒否する。admin であっても特権を与えない
    return { kind: 'suspended' };
  }
  if (!isRole(row.role)) {
    // DB に未知のロールが入っている = 壊れている。通すより落とす
    return { kind: 'invalid-role' };
  }
  return { kind: 'found', actor: toActor(userId, row.role) };
}

/**
 * Better Auth のセッションが指すユーザー ID から Actor を組み立てる。
 * role は設計書 6 章のとおり profiles テーブルにあるため、セッション検証だけでは決まらない。
 */
export async function loadActor(db: Database, userId: string): Promise<ActorLoadResult> {
  const rows = await db
    .select({ role: profiles.role, status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  return decideActor(userId, rows[0]);
}
```

**同時に Task 4-3 の許可リストへ `auth/load-actor.ts` を足す。** このファイルは `toActor` を
import するので、足さないと `actor-encapsulation.test.ts` の
`toActor と ANONYMOUS_VIEWER を import してよいのはホワイトリストのファイルだけ` が
`['auth/load-actor.ts が toActor を import している']` で落ちる。

`apps/api/src/auth/actor-encapsulation.test.ts`:

```ts
const ACTOR_FACTORY_ALLOWLIST = new Set(['auth/load-actor.ts', 'test/fixtures.ts']);
```

- [ ] **Step 6: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- load-actor
npm run test -w @meshimap/api -- actor-encapsulation
```

期待: `load-actor` は 14 件すべて PASS。`actor-encapsulation` も 8 件すべて PASS（許可リストを
足さずに走らせると閉じ込め検査が落ちるので、**先にわざと足さずに 1 回走らせて赤を見ておくとよい**）。

- [ ] **Step 7: 意図的にコードを壊してテストが検知することを確認する**

まず `load-actor.ts` の `where` を削る:

```ts
    .from(profiles)
    .limit(1);
```

```bash
npm run test -w @meshimap/api -- load-actor
```

期待: `他のユーザーの profiles を混ぜて引かない` と `profiles が無いユーザーには no-profile を返す` が FAIL。
**これが FAIL しないなら、他人のロールを引いてしまう事故を検出できていない。** 確認後に元へ戻す。

次に status の判定を「active 以外も通す」に緩める（`row.status !== PROFILE_STATUS_ACTIVE` → `row.status === PROFILE_STATUS_DELETED`）:

```bash
npm run test -w @meshimap/api -- load-actor
```

期待: `suspended なら suspended を返す` / `suspended な admin でも suspended を返す（特権を残さない）` /
`suspended なユーザーには suspended を返す` が FAIL。確認後に元へ戻す。

次に `isRole` の検査を消す（`if (!isRole(row.role))` のブロックを削除し、`toActor(userId, row.role as Role)` にする）:

```bash
npm run test -w @meshimap/api -- typecheck
```

…の前に `npm run typecheck -w @meshimap/api` が **`as` を使わないと通らないこと**を確認する。
`toActor` の第 2 引数が `Role` なので、`string` のままでは代入できずコンパイルエラーになる。
**これが「検査を消すと `as` を書く羽目になる」＝ CODING_GUIDELINES の禁止パターンに触れる、という設計上の防波堤。**
確認後に元へ戻す。

最後に `corruptProfileRole` の `finally` を消して `PRAGMA ... OFF` を戻さないようにする:

```bash
npm run test -w @meshimap/api -- load-actor
```

期待: `未知の role は DB の CHECK 制約が先に弾く（防御の一段目）` は **テストの実行順によっては** 通ってしまう
（テストごとに world を作り直しているため）。だからこの壊し方では検出できない。
代わりに `corruptProfileRole` の `PRAGMA ignore_check_constraints = ON` の行を消す:

```bash
npm run test -w @meshimap/api -- load-actor
```

期待: `CHECK をすり抜けて壊れた role が入っていたら invalid-role を返す（防御の二段目）` が
`CHECK constraint failed: ck_profiles_role` で FAIL。**この文言を目で見ること。** 確認後に元へ戻す。

- [ ] **Step 8: authMiddleware のテストを書く**

`apps/api/src/middleware/auth.test.ts`:

```ts
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_ANONYMOUS } from '../auth/actor';
import { PROFILE_STATUS_SUSPENDED, ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '../db/constants';
import { ERROR_MESSAGE_FORBIDDEN } from '../lib/http-error';
import type { AppEnv } from '../lib/app-env';
import {
  corruptProfileRole,
  createTestBindings,
  createTestWorld,
  runWrite,
  signUpAs,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { errorHandler } from './error-handler';
import { authMiddleware } from './auth';

/**
 * viewer をそのまま JSON にして返すだけのアプリ。
 * ルート側のロジックを混ぜないことで、失敗したときにミドルウェアの問題だと即断できる。
 */
function createProbeApp() {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .use('*', authMiddleware)
    .get('/probe', (c) => {
      const viewer = c.get('viewer');
      return c.json({ role: viewer.role, userId: viewer.userId });
    });
}

describe('authMiddleware', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('Cookie が無いリクエストは匿名になる', async () => {
    const res = await createProbeApp().request('/probe', {}, createTestBindings(world));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('無効な Cookie のリクエストも匿名になる（例外にしない）', async () => {
    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: 'better-auth.session_token=deadbeef' } },
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('user のセッションから UserActor を載せる', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: alice.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_USER, userId: alice.userId });
  });

  it('owner のセッションから OwnerActor を載せる', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: bob.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_OWNER, userId: bob.userId });
  });

  it('admin のセッションから AdminActor を載せる', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: carol.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_ADMIN, userId: carol.userId });
  });

  it('profiles が消えたユーザーは匿名扱いになる', async () => {
    const dave = await signUpAs(world, 'dave@example.com', ROLE_USER);
    await runWrite(world, 'DELETE FROM profiles WHERE user_id = ?', dave.userId);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: dave.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('停止中のユーザーは 403 になる', async () => {
    const eve = await signUpAs(world, 'eve@example.com', ROLE_USER);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      eve.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: eve.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('停止中の admin も 403 になる', async () => {
    const frank = await signUpAs(world, 'frank@example.com', ROLE_ADMIN);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      frank.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: frank.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('role が壊れているユーザーは 403 になる', async () => {
    const grace = await signUpAs(world, 'grace@example.com', ROLE_USER);
    await corruptProfileRole(world, grace.userId, 'superuser');

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: grace.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('403 の本文にユーザー ID もテーブル名も載らない', async () => {
    const heidi = await signUpAs(world, 'heidi@example.com', ROLE_USER);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      heidi.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: heidi.cookie } },
      createTestBindings(world),
    );
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({ error: { status: 403, message: ERROR_MESSAGE_FORBIDDEN } });
    expect(text).not.toContain(heidi.userId);
    expect(text).not.toContain('profiles');
  });

  it('別ユーザーの Cookie でロールが入れ替わらない', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    await signUpAs(world, 'carol@example.com', ROLE_ADMIN);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: alice.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_USER, userId: alice.userId });
  });
});
```

- [ ] **Step 9: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- middleware/auth
```

期待: `Cannot find module './auth' imported from .../apps/api/src/middleware/auth.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 10: authMiddleware を実装する**

`apps/api/src/middleware/auth.ts`:

```ts
import { createMiddleware } from 'hono/factory';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { createAuth } from '../auth/auth';
import { loadActor } from '../auth/load-actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { forbidden } from '../lib/http-error';

/**
 * セッションを検証して Context に viewer を載せる。
 * ここが Actor の唯一の生成経路であり、以降のレイヤは viewer を信頼してよい。
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // Cookie が無いリクエストで Better Auth を組み立てるのは無駄。
  // 公開エンドポイント（地図・検索）の方が呼び出し回数が多いので、ここで短絡させる
  if (c.req.header('cookie') === undefined) {
    c.set('viewer', ANONYMOUS_VIEWER);
    await next();
    return;
  }

  const database = createDatabase(c.env.DB);
  const auth = createAuth(database, c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    // 期限切れや改竄された Cookie。エラーにせず匿名として続行する
    c.set('viewer', ANONYMOUS_VIEWER);
    await next();
    return;
  }

  const result = await loadActor(database, session.user.id);
  switch (result.kind) {
    case 'found':
      c.set('viewer', result.actor);
      break;
    case 'no-profile':
      // 認証は通ったがアプリ側のプロフィールが無い。権限は一切与えない
      c.set('viewer', ANONYMOUS_VIEWER);
      break;
    case 'suspended':
    case 'invalid-role':
      // ロール単位の拒否。リソース ID に依存しないので存在有無は漏れない
      throw forbidden();
  }

  await next();
});
```

**許可リストへ `middleware/auth.ts` を足す。** ここが「セッションが無い＝匿名」を決める唯一の場所で、
`ANONYMOUS_VIEWER` を import するため。これで Task 4-3 の許可リストは実物と同じ 3 件になる。

`apps/api/src/auth/actor-encapsulation.test.ts`:

```ts
/**
 * Actor の生成関数を import してよいファイル（src/ からの相対パス）。
 * ここを増やすときは「本当に認証経路か」を必ず確認すること。
 *
 * 下の「ホワイトリストに載っているファイルが実在する」検査があるため、
 * **まだ存在しないファイルをここに先に書くことはできない**。
 *
 * `middleware/auth.ts` が載っているのは、そこが「セッションが無い＝匿名」を決める
 * 唯一の場所だから。ANONYMOUS_VIEWER は権限を 1 つも持たない値なので、
 * これを他所から作られても権限は増えないが、viewer を決める経路が散ると
 * 「どこで匿名に落ちたのか」を追えなくなるため認証経路に閉じ込める。
 */
const ACTOR_FACTORY_ALLOWLIST = new Set([
  'auth/load-actor.ts',
  'middleware/auth.ts',
  'test/fixtures.ts',
]);
```

- [ ] **Step 11: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- middleware/auth
npm run test -w @meshimap/api -- actor-encapsulation
```

期待: `middleware/auth` は 11 件すべて PASS。`actor-encapsulation` も 8 件すべて PASS
（許可リストの 3 件がすべて実在するようになった）。

- [ ] **Step 12: 型チェックを通す**

```bash
npm run typecheck -w @meshimap/api
```

期待: エラーなし。

- [ ] **Step 13: 意図的にコードを壊してテストが検知することを確認する**

まず `auth.ts` の `suspended` の扱いを甘くする:

```ts
    case 'suspended':
      c.set('viewer', ANONYMOUS_VIEWER);
      break;
    case 'invalid-role':
      throw forbidden();
```

```bash
npm run test -w @meshimap/api -- middleware/auth
```

期待: `停止中のユーザーは 403 になる` / `停止中の admin も 403 になる` / `403 の本文にユーザー ID もテーブル名も載らない`
の 3 件が FAIL（200 が返る）。確認後に元へ戻す。

次に `invalid-role` の扱いを甘くする（`case 'invalid-role': c.set('viewer', ANONYMOUS_VIEWER); break;`）:

```bash
npm run test -w @meshimap/api -- middleware/auth
```

期待: `role が壊れているユーザーは 403 になる` が FAIL。確認後に元へ戻す。

次に Cookie 短絡の条件を反転させる（`=== undefined` → `!== undefined`）:

```bash
npm run test -w @meshimap/api -- middleware/auth
```

期待: `user のセッションから UserActor を載せる` 以下、ログイン済みのテストが軒並み FAIL。確認後に元へ戻す。

最後に `loadActor(database, session.user.id)` を `loadActor(database, 'usr_alice')` のような固定値に変える:

```bash
npm run test -w @meshimap/api -- middleware/auth
```

期待: `別ユーザーの Cookie でロールが入れ替わらない` を含め、ログイン済みのテストが FAIL。
**セッションのユーザー ID を実際に使っていることの確認。** 確認後に元へ戻す。

- [ ] **Step 14: コミット**

```bash
git add apps/api/src/auth/load-actor.ts apps/api/src/auth/load-actor.test.ts apps/api/src/auth/auth.test.ts apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts apps/api/src/test/fixtures.ts
git commit -m "feat(api): セッションから Actor を組み立てる認証ミドルウェアを追加"
```

---

## Task 4-7: role-guard ミドルウェアと型ナローイングヘルパ

**2 つの部品を作る。役割が違う。**

| 部品                        | 役割                                                    | 返すもの        |
| --------------------------- | ------------------------------------------------------- | --------------- |
| `roleGuard(...roles)`       | ルートグループ単位の門番。ハンドラが走る前に弾く        | 401 / 403       |
| `requireOwnerActor(c)` ほか | ハンドラ内で `Viewer` を具体的な Actor 型へ**絞り込む** | `OwnerActor` 等 |

**なぜ 2 つ必要か:** Hono のミドルウェアは Context に載っている `viewer` の型を後段で「狭める」ことができない（`Variables` の型は `Hono<AppEnv>` の生成時に固定される）。ミドルウェアだけだと、ハンドラ内の `c.get('viewer')` は `Viewer` のままで `OwnerActor` を要求するリポジトリ関数へ渡せない。そこで **HTTP の契約はミドルウェア、型の絞り込みはヘルパ**と分担する。ヘルパも失敗時は同じ 403 を投げるので、ミドルウェアを付け忘れても穴は空かない（二重の防御）。

**Files:**

- Create: `apps/api/src/middleware/role-guard.ts`
- Test: `apps/api/src/middleware/role-guard.test.ts`

**Interfaces:**

- Consumes: `hono` の `Context` / `MiddlewareHandler`、`hono/factory` の `createMiddleware`、`@meshimap/core` の `Role` / `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN`、`../auth/actor`（Task 4-2）の型ガード、`../lib/http-error`（Task 4-1）の `unauthorized` / `forbidden`、`../test/fixtures`（Task 4-0 / 4-6）の `createTestWorld` / `createTestBindings` / `signUpAs`（テストのみ）
- Produces:
  - `roleGuard(...allowedRoles: readonly Role[]): MiddlewareHandler<AppEnv>`
  - `requireUserActor(c: Context<AppEnv>): UserActor`
  - `requireOwnerActor(c: Context<AppEnv>): OwnerActor`
  - `requireAdminActor(c: Context<AppEnv>): AdminActor`
  - `requireActor(c: Context<AppEnv>): Actor`

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/middleware/role-guard.test.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../lib/app-env';
import { createTestBindings, createTestWorld, signUpAs } from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { authMiddleware } from './auth';
import { errorHandler } from './error-handler';
import {
  requireActor,
  requireAdminActor,
  requireOwnerActor,
  requireUserActor,
  roleGuard,
} from './role-guard';

function createGuardApp() {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .use('*', authMiddleware)
    .get('/owner-only', roleGuard(ROLE_OWNER), (c) => c.json({ ok: true }))
    .get('/admin-only', roleGuard(ROLE_ADMIN), (c) => c.json({ ok: true }))
    .get('/owner-or-admin', roleGuard(ROLE_OWNER, ROLE_ADMIN), (c) => c.json({ ok: true }))
    .get('/any-authenticated', roleGuard(ROLE_USER, ROLE_OWNER, ROLE_ADMIN), (c) =>
      c.json({ ok: true }),
    )
    .get('/require-user', (c) => c.json({ userId: requireUserActor(c).userId }))
    .get('/require-owner', (c) => c.json({ userId: requireOwnerActor(c).userId }))
    .get('/require-admin', (c) => c.json({ userId: requireAdminActor(c).userId }))
    .get('/require-actor', (c) => c.json({ role: requireActor(c).role }));
}

describe('roleGuard', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  async function get(path: string, cookie?: string): Promise<Response> {
    const headers = cookie === undefined ? {} : { cookie };
    return await createGuardApp().request(path, { headers }, createTestBindings(world));
  }

  it('未認証は 401 を返す（403 ではない）', async () => {
    const res = await get('/owner-only');
    expect(res.status).toBe(401);
  });

  it('許可ロールなら通す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const res = await get('/owner-only', bob.cookie);
    expect(res.status).toBe(200);
  });

  it('許可されていないロールは 403 を返す', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const res = await get('/owner-only', alice.cookie);
    expect(res.status).toBe(403);
  });

  it('admin でも owner 専用ルートには入れない（暗黙の昇格をしない）', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    const res = await get('/owner-only', carol.cookie);
    expect(res.status).toBe(403);
  });

  it('複数ロールを許可した場合は両方通す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect((await get('/owner-or-admin', bob.cookie)).status).toBe(200);
    expect((await get('/owner-or-admin', carol.cookie)).status).toBe(200);
  });

  it('複数ロールを許可しても、含まれないロールは 403', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    expect((await get('/owner-or-admin', alice.cookie)).status).toBe(403);
  });

  it('全ロール許可でも未認証は 401', async () => {
    expect((await get('/any-authenticated')).status).toBe(401);
  });

  it('403 の本文にロール名やルート名を含めない', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const body = await (await get('/owner-only', alice.cookie)).text();
    expect(body).not.toContain('owner');
    expect(body).not.toContain('user');
  });
});

describe('require*Actor ヘルパ', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  async function get(path: string, cookie?: string): Promise<Response> {
    const headers = cookie === undefined ? {} : { cookie };
    return await createGuardApp().request(path, { headers }, createTestBindings(world));
  }

  it('requireUserActor は user のとき userId を返す', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const res = await get('/require-user', alice.cookie);
    expect(await res.json()).toEqual({ userId: alice.userId });
  });

  it('requireUserActor は owner のとき 403', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    expect((await get('/require-user', bob.cookie)).status).toBe(403);
  });

  it('requireOwnerActor は owner のとき userId を返す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const res = await get('/require-owner', bob.cookie);
    expect(await res.json()).toEqual({ userId: bob.userId });
  });

  it('requireOwnerActor は admin のとき 403（admin 用の関数を使わせる）', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect((await get('/require-owner', carol.cookie)).status).toBe(403);
  });

  it('requireAdminActor は admin のとき userId を返す', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    const res = await get('/require-admin', carol.cookie);
    expect(await res.json()).toEqual({ userId: carol.userId });
  });

  it('requireAdminActor は user のとき 403（ロールの取り違えを検出する）', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    expect((await get('/require-admin', alice.cookie)).status).toBe(403);
  });

  it('requireAdminActor は未認証のとき 401', async () => {
    expect((await get('/require-admin')).status).toBe(401);
  });

  it('requireActor は認証済みなら全ロールで通る', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect(await (await get('/require-actor', alice.cookie)).json()).toEqual({ role: ROLE_USER });
    expect(await (await get('/require-actor', bob.cookie)).json()).toEqual({ role: ROLE_OWNER });
    expect(await (await get('/require-actor', carol.cookie)).json()).toEqual({ role: ROLE_ADMIN });
  });

  it('requireActor は未認証のとき 401', async () => {
    expect((await get('/require-actor')).status).toBe(401);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- role-guard
```

期待: `Cannot find module './role-guard' imported from .../apps/api/src/middleware/role-guard.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/middleware/role-guard.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import type { Role } from '@meshimap/core';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import { isAdminActor, isAuthenticatedActor, isOwnerActor, isUserActor } from '../auth/actor';
import type { Actor, AdminActor, OwnerActor, UserActor, Viewer } from '../auth/actor';
import type { AppEnv } from '../lib/app-env';
import { forbidden, unauthorized } from '../lib/http-error';

/** ロール名からその判定関数を引く表。switch を各所に散らさないため */
const ROLE_PREDICATES: Record<Role, (viewer: Viewer) => boolean> = {
  [ROLE_USER]: isUserActor,
  [ROLE_OWNER]: isOwnerActor,
  [ROLE_ADMIN]: isAdminActor,
};

/**
 * ルートグループ単位の門番。
 * 未認証は 401、ロール不一致は 403。403 はリソース ID を見る前に返すので存在有無が漏れない。
 * admin を暗黙に通す特例は作らない（必要なら呼び出し側で ROLE_ADMIN を明示する）。
 */
export function roleGuard(...allowedRoles: readonly Role[]): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const viewer = c.get('viewer');
    if (!isAuthenticatedActor(viewer)) {
      throw unauthorized();
    }
    const isAllowed = allowedRoles.some((role) => ROLE_PREDICATES[role](viewer));
    if (!isAllowed) {
      throw forbidden();
    }
    await next();
  });
}

/**
 * ハンドラ内で Viewer を具体的な Actor 型へ絞り込む。
 * Hono の Variables 型は後段で狭められないため、リポジトリ関数へ渡すにはこの関数が要る。
 * roleGuard を付け忘れても同じ 403 を投げるので、二重の防御になる。
 */
export function requireUserActor(c: Context<AppEnv>): UserActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isUserActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

export function requireOwnerActor(c: Context<AppEnv>): OwnerActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isOwnerActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

export function requireAdminActor(c: Context<AppEnv>): AdminActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isAdminActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

/** ロールを問わず「ログインしていること」だけを要求する */
export function requireActor(c: Context<AppEnv>): Actor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  return viewer;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- role-guard
```

期待: 17 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`role-guard.ts` の `roleGuard` の判定を反転させる:

```ts
const isAllowed = !allowedRoles.some((role) => ROLE_PREDICATES[role](viewer));
```

```bash
npm run test -w @meshimap/api -- role-guard
```

期待: `許可ロールなら通す` / `許可されていないロールは 403 を返す` / `複数ロールを許可した場合は両方通す` / `複数ロールを許可しても、含まれないロールは 403` の 4 件が FAIL。**これが FAIL しないならロールガードのテストが役に立っていない。** 確認後に元へ戻す。

次に `roleGuard` から未認証チェックを消す:

```ts
const viewer = c.get('viewer');
const isAllowed = allowedRoles.some((role) => ROLE_PREDICATES[role](viewer));
```

```bash
npm run test -w @meshimap/api -- role-guard
```

期待: `未認証は 401 を返す（403 ではない）` と `全ロール許可でも未認証は 401` が FAIL（403 になる）。**401 と 403 の取り違えはクライアントの再ログイン導線を壊す。** 確認後に元へ戻す。

さらに `requireOwnerActor` の `isOwnerActor` を `isAdminActor` に取り違えて実行し、`requireOwnerActor は owner のとき userId を返す` と `requireOwnerActor は admin のとき 403` が FAIL することを確認してから元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/middleware/role-guard.ts apps/api/src/middleware/role-guard.test.ts
git commit -m "feat(api): ロールガードと Actor 絞り込みヘルパを追加"
```

---

## Task 4-8: 店舗リポジトリ（所有者チェックを SQL の WHERE 句として書く）

設計書 3.2 の核心。**所有者判定をアプリの `if` ではなくクエリ条件そのものにする。**

**Files:**

- Create: `apps/api/src/repositories/shop-repository.ts`
- Modify: `apps/api/src/test/fixtures.ts`（テスト用 Actor ヘルパを追加）
- Test: `apps/api/src/repositories/shop-repository.test.ts`

**Interfaces:**

- Consumes:
  - `drizzle-orm` の `and` / `desc` / `eq` / `or` と型 `SQL`
  - `@meshimap/core` の `ShopCreateInput` / `ShopId` / `ShopUpdateInput` / `UserId` / `toShopId` / `toUserId`
    （**`packages/core/src/schema.ts` の実物を読んで確認済み**。`ShopUpdateInput` は `shopFieldsSchema.partial()` なので
    `latitude` / `longitude` / `budgetLunchMinYen` などの**キャメルケースかつ Yen サフィックス付き**のプロパティ名を持つ）
  - `@meshimap/geo` の `coordinate` / `encodeGeohash`
  - `../auth/actor`（Task 4-2）の `isAdminActor` / `isOwnerActor` と型 `AdminActor` / `OwnerActor` / `Viewer`
  - `../db/client`（**Phase 3**）の `Database`、`../db/schema`（Phase 3）の `shops`
  - `../db/constants`（Phase 3）の `SHOP_GEOHASH_PRECISION` / `SHOP_STATUS_DRAFT` / `SHOP_STATUS_PUBLISHED`
  - `../lib/constants`（Task 4-1）の `SHOP_LIST_DEFAULT_LIMIT` / `SHOP_LIST_MAX_LIMIT`
- Produces:
  - `type ShopRow = typeof shops.$inferSelect`
  - `listVisibleShops(db: Database, viewer: Viewer, limit?: number): Promise<ShopRow[]>`
  - `findVisibleShop(db: Database, viewer: Viewer, shopId: ShopId): Promise<ShopRow | null>`
  - `createShopAsAdmin(db: Database, _actor: AdminActor, input: ShopCreateInput, ownerId: UserId, shopId: ShopId, now: Date): Promise<ShopRow>`
  - `updateShopAsOwner(db: Database, actor: OwnerActor, shopId: ShopId, input: ShopUpdateInput, now: Date): Promise<ShopRow | null>`
  - `updateShopAsAdmin(db: Database, _actor: AdminActor, shopId: ShopId, input: ShopUpdateInput, now: Date): Promise<ShopRow | null>`
  - `deleteShopAsAdmin(db: Database, _actor: AdminActor, shopId: ShopId): Promise<boolean>`

### 可視性の規則

| 閲覧者      | 見える店舗                          | SQL の WHERE                                                                          |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| 匿名 / user | `published` のみ                    | `status = 'published'`                                                                |
| owner       | `published` ＋ 自分が所有する全店舗 | `status = 'published' OR owner_id = ?`                                                |
| admin       | 全件                                | （`undefined` を渡して条件なし。miniflare 上の本物の D1 で全 4 件返ることを実測済み） |

**`null` を返す設計の理由:** 「見つからない」も「権限がなくて見えない」も、どちらもクエリ結果 0 件になる。リポジトリは両者を区別できないので `null` を返すだけ。ルート側は `null` を一律 `notFound()` に変換する。**区別する情報が最初から存在しないので、漏らしようがない。**

### 時刻は `Date` で渡す（`number` ではない）

`shops.created_at` / `shops.updated_at` は Phase 3 のスキーマで
`integer('created_at', { mode: 'timestamp_ms' })` と定義されている。**Drizzle 経由の読み書きは `Date` オブジェクト**になる
（実測: `.returning()` の戻りは `row.createdAt instanceof Date === true`）。
したがってリポジトリの `now` 引数は `Date`。生 SQL（fixtures の `seedShop`）側だけがミリ秒の整数を扱う。

`updatedAt` 列には `.$onUpdateFn(() => new Date())` が付いているが、**`set()` で明示した値が優先される**
（実測: `set({ updatedAt: new Date(100) })` の戻りが `1970-01-01T00:00:00.100Z`）。
テストから時刻を固定できるよう、リポジトリは常に明示的に入れる。

### 入力型とテーブル列の対応（スプレッドを使えない理由）

`@meshimap/core` の `ShopUpdateInput` のプロパティ名と、`db/schema` の Drizzle プロパティ名は**一致しない**。`{ ...input }` でそのまま `set()` に渡すとコンパイルが通らないので、明示的な対応表を関数にする。

| `ShopUpdateInput` / `ShopCreateInput`      | `shops` テーブル                           | 備考                                                                         |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `name` / `nameKana` / `genreId` / `areaId` | `name` / `nameKana` / `genreId` / `areaId` | 同名                                                                         |
| `description` / `postalCode` / `address`   | `description` / `postalCode` / `address`   | 同名                                                                         |
| `phone` / `website`                        | `phone` / `website`                        | 同名。`null` 許容                                                            |
| `latitude`                                 | `lat`                                      | **名前が違う**                                                               |
| `longitude`                                | `lng`                                      | **名前が違う**                                                               |
| （入力に無い）                             | `geohash`                                  | `encodeGeohash(coordinate(lat, lng), SHOP_GEOHASH_PRECISION)` で**導出する** |
| `budgetLunchMinYen`                        | `budgetLunchMin`                           | **Yen サフィックスが落ちる**                                                 |
| `budgetLunchMaxYen`                        | `budgetLunchMax`                           | 同上                                                                         |
| `budgetDinnerMinYen`                       | `budgetDinnerMin`                          | 同上                                                                         |
| `budgetDinnerMaxYen`                       | `budgetDinnerMax`                          | 同上                                                                         |

> **緯度・経度は必ず 2 つセットで更新する。** 片方だけ来たときに geohash を再計算すると、古い方の値と混ざった誤った geohash ができ、地図検索から店舗が消える。リポジトリは「両方揃っているときだけ `lat` / `lng` / `geohash` を更新する」。片方だけのリクエストはルート側で 422 にする（Task 4-11）。

- [ ] **Step 1: テスト用 Actor ヘルパを fixtures に追加する**

`apps/api/src/test/fixtures.ts` を編集する。このファイルは Task 4-3 の
「`toActor` を import してよいファイル」ホワイトリストに載っているので、封じ込め検査に通る。

ファイル冒頭の import 群に 2 行追加する（`Role` は Task 4-0 で `../db/constants` から import 済み）:

```ts
import { isAdminActor, isOwnerActor, isUserActor, toActor } from '../auth/actor';
import type { Actor, AdminActor, OwnerActor, UserActor } from '../auth/actor';
```

ファイル末尾に追加する:

```ts
/**
 * リポジトリ層の単体テスト専用の Actor 生成。
 * HTTP を通さずにリポジトリだけを検証したいときに使う。
 * 本番コードからは呼ばない（Task 4-3 の検査で機械的に禁止している）。
 */
export function buildActorForTest(userId: string, role: Role): Actor {
  return toActor(userId, role);
}

/**
 * 以下 3 つは Actor ユニオンを各ロール型へ絞るヘルパ。
 * テストコードでも `as` を使わずに絞れるよう、必ず型ガードを通す。
 */
export function userActorOrThrow(actor: Actor): UserActor {
  if (!isUserActor(actor)) {
    throw new Error('テストの前提が壊れている: user ではない');
  }
  return actor;
}

export function ownerActorOrThrow(actor: Actor): OwnerActor {
  if (!isOwnerActor(actor)) {
    throw new Error('テストの前提が壊れている: owner ではない');
  }
  return actor;
}

export function adminActorOrThrow(actor: Actor): AdminActor {
  if (!isAdminActor(actor)) {
    throw new Error('テストの前提が壊れている: admin ではない');
  }
  return actor;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/shop-repository.test.ts`:

```ts
import { toShopId, toUserId } from '@meshimap/core';
import type { ShopCreateInput } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import {
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import {
  adminActorOrThrow,
  buildActorForTest,
  createTestWorld,
  ownerActorOrThrow,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  TEST_AREA_ID,
  TEST_GENRE_ID,
  TEST_LONGITUDE,
  userActorOrThrow,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import {
  createShopAsAdmin,
  deleteShopAsAdmin,
  findVisibleShop,
  listVisibleShops,
  updateShopAsAdmin,
  updateShopAsOwner,
} from './shop-repository';

const OWNER_A_ID = 'usr_owner_a';
const OWNER_B_ID = 'usr_owner_b';
const ADMIN_ID = 'usr_admin';
const USER_ID = 'usr_alice';

/** 渋谷駅付近（fixtures の既定座標）。precision 7 では xn76fgr */
const SEEDED_GEOHASH = 'xn76fgr';
/** 銀座 1-1-1。encodeGeohash(coordinate(35.6717, 139.765), 7) の実測値 */
const GINZA_GEOHASH = 'xn76umv';
/** 大阪駅。encodeGeohash(coordinate(34.702485, 135.495951), 7) の実測値 */
const OSAKA_GEOHASH = 'xn0m7m3';
const OSAKA_LATITUDE = 34.702485;
/** 差し替え先の master。genre_id / area_id が本当に書き換わったと言うには別の行が要る */
const OTHER_GENRE_ID = 'gnr_sushi';
const OTHER_AREA_ID = 'are_shinjuku';
const OSAKA_LONGITUDE = 135.495951;

/** shopCreateSchema.parse を通した後の形。default が適用済みなので全キーが揃っている */
const NEW_SHOP_INPUT: ShopCreateInput = {
  name: '新規店',
  nameKana: 'シンキテン',
  // genres / areas は ON DELETE restrict の外部キー。seedMasters が入れた ID しか使えない
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '104-0061',
  address: '東京都中央区銀座1-1-1',
  latitude: 35.6717,
  longitude: 139.765,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

describe('shop-repository', () => {
  let world: TestWorld;
  let db: Database;

  // buildActorForTest の戻りは Actor ユニオン。OwnerActor を要求する関数へは
  // 型ガードで絞ってからでないと渡せない。この一手間が必要なこと自体がブランド型が効いている証拠
  const ownerA = ownerActorOrThrow(buildActorForTest(OWNER_A_ID, ROLE_OWNER));
  const admin = adminActorOrThrow(buildActorForTest(ADMIN_ID, ROLE_ADMIN));
  const user = userActorOrThrow(buildActorForTest(USER_ID, ROLE_USER));

  beforeEach(async () => {
    world = await createTestWorld();
    await seedMasters(world);
    await seedUser(world, { userId: OWNER_A_ID, role: ROLE_OWNER });
    await seedUser(world, { userId: OWNER_B_ID, role: ROLE_OWNER });
    await seedUser(world, { userId: ADMIN_ID, role: ROLE_ADMIN });
    await seedUser(world, { userId: USER_ID, role: ROLE_USER });
    await seedShop(world, {
      id: 'shp_a_pub',
      ownerId: OWNER_A_ID,
      name: 'A の公開店',
      status: SHOP_STATUS_PUBLISHED,
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    await seedShop(world, {
      id: 'shp_a_draft',
      ownerId: OWNER_A_ID,
      name: 'A の下書き店',
      status: SHOP_STATUS_DRAFT,
      createdAtMs: 20,
      updatedAtMs: 20,
    });
    await seedShop(world, {
      id: 'shp_b_pub',
      ownerId: OWNER_B_ID,
      name: 'B の公開店',
      status: SHOP_STATUS_PUBLISHED,
      createdAtMs: 30,
      updatedAtMs: 30,
    });
    await seedShop(world, {
      id: 'shp_b_draft',
      ownerId: OWNER_B_ID,
      name: 'B の下書き店',
      status: SHOP_STATUS_DRAFT,
      createdAtMs: 40,
      updatedAtMs: 40,
    });
    db = createDatabase(world.d1);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('listVisibleShops', () => {
    it('user には published だけ見せる', async () => {
      const rows = await listVisibleShops(db, user);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_pub', 'shp_b_pub']);
    });

    it('匿名にも published だけ見せる', async () => {
      const rows = await listVisibleShops(db, ANONYMOUS_VIEWER);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_pub', 'shp_b_pub']);
    });

    it('owner には published と自分の draft を見せる', async () => {
      const rows = await listVisibleShops(db, ownerA);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_draft', 'shp_a_pub', 'shp_b_pub']);
    });

    it('owner に他人の draft を見せない', async () => {
      const rows = await listVisibleShops(db, ownerA);
      expect(rows.map((row) => row.id)).not.toContain('shp_b_draft');
    });

    it('owner_id が NULL の draft は owner からも見えない', async () => {
      // shops.owner_id は NULL 可（オーナー退会で set null される）。
      // `owner_id = ?` は NULL とは一致しないので、宙に浮いた店舗は誰のものにもならない
      await seedShop(world, { id: 'shp_orphan', ownerId: null, status: SHOP_STATUS_DRAFT });

      const rows = await listVisibleShops(db, ownerA);

      expect(rows.map((row) => row.id)).not.toContain('shp_orphan');
    });

    it('admin には全件見せる', async () => {
      const rows = await listVisibleShops(db, admin);
      expect(rows).toHaveLength(4);
    });

    it('新しい順（created_at の降順）に並ぶ', async () => {
      const rows = await listVisibleShops(db, admin);
      expect(rows.map((row) => row.id)).toEqual([
        'shp_b_draft',
        'shp_b_pub',
        'shp_a_draft',
        'shp_a_pub',
      ]);
    });

    it('limit で件数を絞れる', async () => {
      const rows = await listVisibleShops(db, admin, 2);
      expect(rows).toHaveLength(2);
    });

    it('limit に 0 を渡しても 1 件は返す（0 は結果が消えるので下限で丸める）', async () => {
      const rows = await listVisibleShops(db, admin, 0);
      expect(rows).toHaveLength(1);
    });

    it('limit に巨大な値を渡しても上限で丸める', async () => {
      const rows = await listVisibleShops(db, admin, 100000);
      expect(rows).toHaveLength(4);
    });
  });

  describe('findVisibleShop', () => {
    it('published は user から見える', async () => {
      const row = await findVisibleShop(db, user, toShopId('shp_a_pub'));
      expect(row?.id).toBe('shp_a_pub');
    });

    it('他人の draft は user から見えない（null）', async () => {
      const row = await findVisibleShop(db, user, toShopId('shp_a_draft'));
      expect(row).toBeNull();
    });

    it('自分の draft は owner から見える', async () => {
      const row = await findVisibleShop(db, ownerA, toShopId('shp_a_draft'));
      expect(row?.id).toBe('shp_a_draft');
    });

    it('他人の draft は owner から見えない（null）', async () => {
      const row = await findVisibleShop(db, ownerA, toShopId('shp_b_draft'));
      expect(row).toBeNull();
    });

    it('admin はどの draft も見える', async () => {
      const row = await findVisibleShop(db, admin, toShopId('shp_b_draft'));
      expect(row?.id).toBe('shp_b_draft');
    });

    it('存在しない ID は null（見えない draft と区別がつかない）', async () => {
      const missing = await findVisibleShop(db, ownerA, toShopId('shp_nothing'));
      const hidden = await findVisibleShop(db, ownerA, toShopId('shp_b_draft'));
      expect(missing).toBeNull();
      expect(hidden).toBeNull();
      expect(missing).toEqual(hidden);
    });
  });

  describe('updateShopAsOwner', () => {
    it('自分の店舗を更新できる', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { name: '改名後' },
        new Date(100),
      );
      expect(updated?.name).toBe('改名後');
      // timestamp_ms なので Drizzle からは Date で返る
      expect(updated?.updatedAt).toEqual(new Date(100));
    });

    it('他人の店舗を更新しようとすると null を返す', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_b_pub'),
        { name: '乗っ取り' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });

    it('他人の店舗の行は 1 バイトも変わらない', async () => {
      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_b_pub'),
        { name: '乗っ取り' },
        new Date(100),
      );

      // リポジトリを通さず生 SQL で実体を見る。null が返っても書けていた、を検出するため
      const row = await readRow(
        world,
        'SELECT name, updated_at FROM shops WHERE id = ?',
        'shp_b_pub',
      );

      expect(row).toEqual({ name: 'B の公開店', updated_at: 30 });
    });

    it('存在しない ID でも null を返す（他人の店舗と同じ結果）', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_nothing'),
        { name: 'x' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });

    it('自分の draft も更新できる', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_draft'),
        { name: '下書き改' },
        new Date(100),
      );
      expect(updated?.name).toBe('下書き改');
    });

    it('指定していない項目は書き換えない', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { name: '改名後' },
        new Date(100),
      );
      expect(updated?.address).toBe('東京都渋谷区道玄坂 1-1-1');
      expect(updated?.genreId).toBe(TEST_GENRE_ID);
    });

    it('更新項目が空でも updatedAt だけは進む', async () => {
      // ルート側は shopUpdateSchema の refine で空オブジェクトを 422 にするが、
      // リポジトリ単体では通る。set() が常に updatedAt を含むので SQL は成立する
      const updated = await updateShopAsOwner(db, ownerA, toShopId('shp_a_pub'), {}, new Date(200));
      expect(updated?.updatedAt).toEqual(new Date(200));
      expect(updated?.name).toBe('A の公開店');
    });

    it('緯度と経度を両方指定すると geohash を再計算する', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { latitude: OSAKA_LATITUDE, longitude: OSAKA_LONGITUDE },
        new Date(100),
      );
      expect(updated?.lat).toBe(OSAKA_LATITUDE);
      expect(updated?.lng).toBe(OSAKA_LONGITUDE);
      expect(updated?.geohash).toBe(OSAKA_GEOHASH);
    });

    it('緯度だけの指定では緯度も geohash も変えない', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { latitude: OSAKA_LATITUDE },
        new Date(100),
      );
      expect(updated?.lat).not.toBe(OSAKA_LATITUDE);
      expect(updated?.geohash).toBe(SEEDED_GEOHASH);
    });

    it('予算の Yen サフィックス付きプロパティを列名へ対応づける', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { budgetLunchMinYen: 800, budgetLunchMaxYen: 1500 },
        new Date(100),
      );
      expect(updated?.budgetLunchMin).toBe(800);
      expect(updated?.budgetLunchMax).toBe(1500);
    });

    it('任意項目をすべて指定すると、対応する列へ 1 つずつ書き込む', async () => {
      // genre_id / area_id は外部キー。別の値へ確かに変わったと言うために master をもう 1 組入れる
      await runWrite(
        world,
        'INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, ?, ?)',
        OTHER_GENRE_ID,
        '寿司',
        'sushi',
        null,
        1,
      );
      await runWrite(
        world,
        'INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)',
        OTHER_AREA_ID,
        '新宿',
        null,
        '東京都',
      );

      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        {
          nameKana: 'エーノコウカイテン',
          genreId: OTHER_GENRE_ID,
          areaId: OTHER_AREA_ID,
          description: '説明を入れた',
          postalCode: '160-0022',
          address: '東京都新宿区新宿3-1-1',
          phone: '03-1234-5678',
          website: 'https://example.com',
          budgetDinnerMinYen: 3000,
          budgetDinnerMaxYen: 6000,
        },
        new Date(100),
      );

      // 戻り値ではなく生 SQL で見る。プロパティ名と列名の対応がずれていても
      // 戻り値どうしの比較では一致してしまい、取り違えに気づけない
      const row = await readRow(
        world,
        'SELECT name_kana, genre_id, area_id, description, postal_code, address, phone, website, budget_dinner_min, budget_dinner_max FROM shops WHERE id = ?',
        'shp_a_pub',
      );

      expect(row).toEqual({
        name_kana: 'エーノコウカイテン',
        genre_id: OTHER_GENRE_ID,
        area_id: OTHER_AREA_ID,
        description: '説明を入れた',
        postal_code: '160-0022',
        address: '東京都新宿区新宿3-1-1',
        phone: '03-1234-5678',
        website: 'https://example.com',
        budget_dinner_min: 3000,
        budget_dinner_max: 6000,
      });
    });

    it('経度だけの指定では経度も geohash も変えない', async () => {
      // 緯度側の条件だけを落とす変異は、undefined の緯度から geohash を
      // 計算しようとしてここで初めて表に出る
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { longitude: OSAKA_LONGITUDE },
        new Date(100),
      );
      expect(updated?.lng).toBe(TEST_LONGITUDE);
      expect(updated?.geohash).toBe(SEEDED_GEOHASH);
    });

    it('null を明示した項目は null で上書きする', async () => {
      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { phone: '03-1234-5678' },
        new Date(100),
      );

      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { phone: null },
        new Date(110),
      );

      expect(updated?.phone).toBeNull();
    });
  });

  describe('updateShopAsAdmin', () => {
    it('他人の店舗でも更新できる', async () => {
      const updated = await updateShopAsAdmin(
        db,
        admin,
        toShopId('shp_b_pub'),
        { name: '管理者改名' },
        new Date(100),
      );
      expect(updated?.name).toBe('管理者改名');
    });

    it('存在しない ID には null を返す', async () => {
      const updated = await updateShopAsAdmin(
        db,
        admin,
        toShopId('shp_nothing'),
        { name: 'x' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });
  });

  describe('createShopAsAdmin', () => {
    it('指定した owner に紐づく店舗を作る', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.id).toBe('shp_new');
      expect(created.ownerId).toBe(OWNER_A_ID);
      expect(created.name).toBe('新規店');
    });

    it('作成直後は draft', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.status).toBe(SHOP_STATUS_DRAFT);
    });

    it('作成直後は draft なので user からは見えない', async () => {
      await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(await findVisibleShop(db, user, toShopId('shp_new'))).toBeNull();
    });

    it('緯度経度から geohash を導出して保存する', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.geohash).toBe(GINZA_GEOHASH);
      expect(created.lat).toBe(NEW_SHOP_INPUT.latitude);
      expect(created.lng).toBe(NEW_SHOP_INPUT.longitude);
    });

    it('createdAt と updatedAt に同じ値を入れる', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.createdAt).toEqual(new Date(300));
      expect(created.updatedAt).toEqual(new Date(300));
    });
  });

  describe('deleteShopAsAdmin', () => {
    it('存在する店舗を削除して true を返す', async () => {
      expect(await deleteShopAsAdmin(db, admin, toShopId('shp_a_pub'))).toBe(true);
      expect(await findVisibleShop(db, admin, toShopId('shp_a_pub'))).toBeNull();
    });

    it('存在しない ID には false を返す', async () => {
      expect(await deleteShopAsAdmin(db, admin, toShopId('shp_nothing'))).toBe(false);
    });

    it('削除対象以外の行を消さない', async () => {
      await deleteShopAsAdmin(db, admin, toShopId('shp_a_pub'));
      const rows = await listVisibleShops(db, admin);
      expect(rows).toHaveLength(3);
    });
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- shop-repository
```

期待: `Cannot find module './shop-repository' imported from .../apps/api/src/repositories/shop-repository.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 4: 定数の存在を確認する**

```bash
grep -n "SHOP_GEOHASH_PRECISION" apps/api/src/db/constants.ts
grep -n "SHOP_LIST_DEFAULT_LIMIT\|SHOP_LIST_MAX_LIMIT" apps/api/src/lib/constants.ts
```

期待: 1 つ目は `export const SHOP_GEOHASH_PRECISION = 7;`（Phase 3 が定義済み）、
2 つ目は `SHOP_LIST_DEFAULT_LIMIT` / `SHOP_LIST_MAX_LIMIT` の 2 行（Task 4-1 で定義済み）。

> `@meshimap/geo` の `GeohashPrecision` は `1 | 2 | ... | 12` のリテラルユニオン。
> `export const SHOP_GEOHASH_PRECISION = 7;` は型注釈が無いので `number` ではなく `7` に推論され、
> `encodeGeohash(coordinate, SHOP_GEOHASH_PRECISION)` がそのまま通る（`as const` は不要）。
> **`SHOP_GEOHASH_PRECISION` を `src/lib/constants.ts` に再定義しないこと。** 定義が 2 つになると、
> マイグレーションの `ck_shops_geohash_length` と API の導出値がずれても誰も気付けない。

- [ ] **Step 5: 最小実装を書く**

`apps/api/src/repositories/shop-repository.ts`:

```ts
import type { ShopCreateInput, ShopId, ShopUpdateInput, UserId } from '@meshimap/core';
import { coordinate, encodeGeohash } from '@meshimap/geo';
import { and, desc, eq, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isAdminActor, isOwnerActor } from '../auth/actor';
import type { AdminActor, OwnerActor, Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { SHOP_GEOHASH_PRECISION, SHOP_STATUS_DRAFT, SHOP_STATUS_PUBLISHED } from '../db/constants';
import { shops } from '../db/schema';
import { SHOP_LIST_DEFAULT_LIMIT, SHOP_LIST_MAX_LIMIT } from '../lib/constants';

export type ShopRow = typeof shops.$inferSelect;

/**
 * 閲覧者ごとの可視条件を **SQL の WHERE 句として**組み立てる。
 * 取得後にアプリ側でフィルタしないこと。取り漏らしがそのまま情報漏洩になる。
 * admin は undefined を返す。drizzle は undefined を「条件なし」として扱う（本物の D1 で実測確認済み）。
 */
function visibilityCondition(viewer: Viewer): SQL | undefined {
  if (isAdminActor(viewer)) {
    return undefined;
  }
  if (isOwnerActor(viewer)) {
    // 自分の店舗は status を問わず見える。
    // owner_id が NULL の店舗は `owner_id = ?` に一致しないので、誰のものにもならない
    return or(eq(shops.status, SHOP_STATUS_PUBLISHED), eq(shops.ownerId, viewer.userId));
  }
  return eq(shops.status, SHOP_STATUS_PUBLISHED);
}

type ShopWriteValues = Partial<typeof shops.$inferInsert>;

/**
 * `ShopUpdateInput`（core の Zod スキーマ由来）を shops テーブルの列へ写す。
 * プロパティ名が一致しない（latitude→lat, budgetLunchMinYen→budgetLunchMin）ため、
 * スプレッドではなく 1 対 1 で書き下す。列を増やしたらここも足す。
 */
function toShopUpdateValues(input: ShopUpdateInput, now: Date): ShopWriteValues {
  // updatedAt は常に入るので、set() が空になって SQL が壊れることがない
  const values: ShopWriteValues = { updatedAt: now };
  if (input.name !== undefined) {
    values.name = input.name;
  }
  if (input.nameKana !== undefined) {
    values.nameKana = input.nameKana;
  }
  if (input.genreId !== undefined) {
    values.genreId = input.genreId;
  }
  if (input.areaId !== undefined) {
    values.areaId = input.areaId;
  }
  if (input.description !== undefined) {
    values.description = input.description;
  }
  if (input.postalCode !== undefined) {
    values.postalCode = input.postalCode;
  }
  if (input.address !== undefined) {
    values.address = input.address;
  }
  if (input.phone !== undefined) {
    values.phone = input.phone;
  }
  if (input.website !== undefined) {
    values.website = input.website;
  }
  if (input.budgetLunchMinYen !== undefined) {
    values.budgetLunchMin = input.budgetLunchMinYen;
  }
  if (input.budgetLunchMaxYen !== undefined) {
    values.budgetLunchMax = input.budgetLunchMaxYen;
  }
  if (input.budgetDinnerMinYen !== undefined) {
    values.budgetDinnerMin = input.budgetDinnerMinYen;
  }
  if (input.budgetDinnerMaxYen !== undefined) {
    values.budgetDinnerMax = input.budgetDinnerMaxYen;
  }
  // 片方だけで geohash を再計算すると古い値と混ざった誤ったセルになるため、両方揃ったときだけ更新する
  if (input.latitude !== undefined && input.longitude !== undefined) {
    values.lat = input.latitude;
    values.lng = input.longitude;
    values.geohash = encodeGeohash(
      coordinate(input.latitude, input.longitude),
      SHOP_GEOHASH_PRECISION,
    );
  }
  return values;
}

export async function listVisibleShops(
  db: Database,
  viewer: Viewer,
  limit: number = SHOP_LIST_DEFAULT_LIMIT,
): Promise<ShopRow[]> {
  // 上限を超える limit は Worker の CPU 時間を食い潰す。0 以下は結果が消えるので下限でも丸める
  const safeLimit = Math.min(Math.max(limit, 1), SHOP_LIST_MAX_LIMIT);
  return await db
    .select()
    .from(shops)
    .where(visibilityCondition(viewer))
    .orderBy(desc(shops.createdAt))
    .limit(safeLimit);
}

/**
 * 「存在しない」と「見る権限がない」は同じ null を返す。
 * 区別する情報をこの関数が持たないので、呼び出し側が誤って漏らすこともできない。
 */
export async function findVisibleShop(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
): Promise<ShopRow | null> {
  const rows = await db
    .select()
    .from(shops)
    .where(and(eq(shops.id, shopId), visibilityCondition(viewer)))
    .limit(1);
  return rows[0] ?? null;
}

/** admin が `POST /shops` で直接作る（唯一の呼び出し元）。作成直後は draft */
export async function createShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  input: ShopCreateInput,
  ownerId: UserId,
  shopId: ShopId,
  now: Date,
): Promise<ShopRow> {
  const inserted = await db
    .insert(shops)
    .values({
      id: shopId,
      ownerId,
      name: input.name,
      nameKana: input.nameKana,
      genreId: input.genreId,
      areaId: input.areaId,
      description: input.description,
      postalCode: input.postalCode,
      address: input.address,
      lat: input.latitude,
      lng: input.longitude,
      geohash: encodeGeohash(coordinate(input.latitude, input.longitude), SHOP_GEOHASH_PRECISION),
      phone: input.phone,
      website: input.website,
      budgetLunchMin: input.budgetLunchMinYen,
      budgetLunchMax: input.budgetLunchMaxYen,
      budgetDinnerMin: input.budgetDinnerMinYen,
      budgetDinnerMax: input.budgetDinnerMaxYen,
      status: SHOP_STATUS_DRAFT,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    // INSERT ... RETURNING が 0 件を返すのは D1 側の異常。握り潰さない
    throw new Error('店舗の作成に失敗した');
  }
  return row;
}

/**
 * 設計書 3.2 の中核。所有者チェックは `eq(shops.ownerId, actor.userId)` という
 * **クエリ条件**として表現する。アプリ側の if 文を通らないので、書き忘れる場所が存在しない。
 * 他人の店舗・存在しない店舗のどちらも 0 件 → null になる。
 */
export async function updateShopAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  input: ShopUpdateInput,
  now: Date,
): Promise<ShopRow | null> {
  const updated = await db
    .update(shops)
    .set(toShopUpdateValues(input, now))
    .where(and(eq(shops.id, shopId), eq(shops.ownerId, actor.userId)))
    .returning();
  return updated[0] ?? null;
}

/**
 * admin は所有者を問わず更新できる。
 * owner 版とユニオン型でまとめないのは、まとめると「どちらの WHERE を組むか」の分岐が
 * 関数内に入り、設計書 3.2 が避けたい「アプリの分岐による権限チェック」に戻るため。
 */
export async function updateShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  shopId: ShopId,
  input: ShopUpdateInput,
  now: Date,
): Promise<ShopRow | null> {
  const updated = await db
    .update(shops)
    .set(toShopUpdateValues(input, now))
    .where(eq(shops.id, shopId))
    .returning();
  return updated[0] ?? null;
}

export async function deleteShopAsAdmin(
  db: Database,
  _actor: AdminActor,
  shopId: ShopId,
): Promise<boolean> {
  const deleted = await db.delete(shops).where(eq(shops.id, shopId)).returning({ id: shops.id });
  return deleted.length > 0;
}
```

> `_actor` の先頭アンダースコアは `noUnusedParameters` を満たすため。**引数を要求すること自体が目的**なので、本体で使わなくても削ってはいけない。Task 4-10 の検査は `_actor` も受け付ける。

- [ ] **Step 6: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- shop-repository
npm run typecheck -w @meshimap/api
```

期待: テスト 39 件すべて PASS。`typecheck` はエラー 0。

- [ ] **Step 7: 意図的にコードを壊してテストが検知することを確認する**

`updateShopAsOwner` から所有者条件を落とす（**これが Phase 4 で最も起きてはいけないバグ**）:

```ts
    .where(eq(shops.id, shopId))
```

```bash
npm run test -w @meshimap/api -- shop-repository
```

期待: `他人の店舗を更新しようとすると null を返す` と `他人の店舗の行は 1 バイトも変わらない` が FAIL。**これが FAIL しないなら、Phase 4 の存在意義が無い。** 確認後に元へ戻す。

次に `visibilityCondition` の owner 分岐を `or` から `and` に変える:

```ts
return and(eq(shops.status, SHOP_STATUS_PUBLISHED), eq(shops.ownerId, viewer.userId));
```

期待: `owner には published と自分の draft を見せる` と `自分の draft は owner から見える` が FAIL。確認後に元へ戻す。

次に `isAdminActor(viewer)` を `isOwnerActor(viewer)` に取り違える。
期待: `admin には全件見せる` と `admin はどの draft も見える` が FAIL。確認後に元へ戻す。

次に `toShopUpdateValues` の緯度経度の条件を `&&` から `||` に変える:

```ts
  if (input.latitude !== undefined || input.longitude !== undefined) {
```

期待: `緯度だけの指定では緯度も geohash も変えない` が FAIL。
`values.lng` に `undefined` が入ると Drizzle はその列を SET 句から落とすため、
**緯度だけが大阪になり geohash が東京のまま**という最悪の壊れ方をする。この壊れ方こそテストで止めたい。
確認後に元へ戻す。

次に `values.budgetLunchMin = input.budgetLunchMinYen;` を `values.budgetLunchMax = input.budgetLunchMinYen;` に取り違える。
期待: `予算の Yen サフィックス付きプロパティを列名へ対応づける` が FAIL。確認後に元へ戻す。

最後に `encodeGeohash(..., SHOP_GEOHASH_PRECISION)` の精度を `6` に変える。
期待: `緯度経度から geohash を導出して保存する` が FAIL（`xn76um` になる）。
さらに `createShopAsAdmin` は `ck_shops_geohash_length` の CHECK 制約で INSERT 自体が落ちる可能性がある。
**DB 側の CHECK と API 側の導出値が同じ定数から出ていることの確認。** 確認後に元へ戻す。

- [ ] **Step 8: コミット**

```bash
git add apps/api/src/repositories/shop-repository.ts apps/api/src/repositories/shop-repository.test.ts apps/api/src/test/fixtures.ts
git commit -m "feat(api): 所有者チェックを WHERE 句で表現する店舗リポジトリを追加"
```

---

## Task 4-9: レビューリポジトリ（投稿者チェックを SQL の WHERE 句として書く）

**Files:**

- Create: `apps/api/src/repositories/review-repository.ts`
- Modify: `apps/api/src/test/fixtures.ts`（`seedReview` と `rejectionMessageOf` を追加）
- Test: `apps/api/src/repositories/review-repository.test.ts`

**Interfaces:**

- Consumes:
  - `drizzle-orm` の `and` / `desc` / `eq` / `ne` と型 `SQL`
  - `../db/schema`（Phase 3）の `reviews`
  - `../db/constants`（Phase 3）の `REVIEW_STATUS_DELETED` / `REVIEW_STATUS_PUBLISHED`
  - `../auth/actor`（Task 4-2）の `isAdminActor` と型 `AdminActor` / `UserActor` / `Viewer`
  - `@meshimap/core` の `ReviewCreateInput` / `ReviewId` / `ShopId`
  - `../db/client`（**Phase 3**）の `Database`
- Produces:
  - `type ReviewRow = typeof reviews.$inferSelect`
  - `listVisibleReviews(db: Database, viewer: Viewer, shopId: ShopId): Promise<ReviewRow[]>`
  - `createReviewAsUser(db: Database, actor: UserActor, shopId: ShopId, reviewId: ReviewId, input: ReviewCreateInput, now: Date): Promise<ReviewRow>`
  - `deleteReviewAsAuthor(db: Database, actor: UserActor, reviewId: ReviewId): Promise<boolean>`
  - `deleteReviewAsAdmin(db: Database, _actor: AdminActor, reviewId: ReviewId): Promise<boolean>`

### Phase 3 の `reviews` テーブルで確認した事実

`apps/api/src/db/schema/review.ts` の実物を読んで確認した。推測していない。

| 事実                                                                                     | Phase 4 への影響                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createdAt` は `integer('created_at', { mode: 'timestamp_ms' })`                         | `now` 引数は `number` ではなく **`Date`**。読み出しも `Date`                                   |
| **`updatedAt` 列が無い**                                                                 | レビューは Phase 4 では作成と削除だけ。更新 API を作らない                                     |
| `status` は `REVIEW_STATUSES`（`published` / `hidden` / `deleted`）、既定は `published`  | 可視条件の定数は `REVIEW_STATUS_PUBLISHED`。`REVIEW_STATUS_VISIBLE` という名前は**存在しない** |
| `budget`（`budget_yen` ではない）、`CHECK betweenInclusive(0, 1_000_000)`                | `ReviewCreateInput.budgetYen` → `budget` に対応づける                                          |
| `visitedOn` は NULL 可だが `CHECK ... GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'` | `reviewCreateSchema.visitedOn` は `z.iso.date()` で必須。書式違いは DB でも落ちる              |
| `uniqueIndex('uq_reviews_shop_user').on(shopId, userId)`                                 | **1 ユーザー 1 店舗 1 レビュー。** テストのシードで同じ組を 2 回使えない                       |
| `shopId` → `shops.id` ON DELETE cascade、`userId` → `user.id` ON DELETE cascade          | シードには実在する店舗行とユーザー行が要る                                                     |

### 入力型とテーブル列の対応

`@meshimap/core` の `ReviewCreateInput` は
`{ shopId: string; rating: number; body: string; visitedOn: string; budgetYen: number | null }`
（`packages/core/src/schema.ts` の `reviewCreateSchema` を読んで確認。`shopId` は `identifierSchema` 由来なので
**ブランド型ではない素の `string`**）。

| `ReviewCreateInput`             | `reviews` テーブル              | 備考                                           |
| ------------------------------- | ------------------------------- | ---------------------------------------------- |
| `rating` / `body` / `visitedOn` | `rating` / `body` / `visitedOn` | 同名                                           |
| `budgetYen`                     | `budget`                        | **Yen サフィックスが落ちる**                   |
| `shopId`                        | （使わない）                    | **URL 由来の `shopId` 引数を正とする**（下記） |
| （入力に無い）                  | `userId`                        | `actor.userId` から取る                        |
| （入力に無い）                  | `status`                        | 常に `published`                               |

> **`input.shopId` を INSERT に使わない理由:** ボディの `shopId` を信じると、URL は自分が見られる
> 店舗、ボディは見えない別店舗、という組み合わせでレビューを差し込めてしまう。
> リポジトリは常に**引数の `shopId`（＝ URL から取り、可視性チェックを通した値）**を使う。
> 両者の不一致はルート側で 422 にする（Task 4-11）。

### `deleted` を admin にも見せない

`status = 'deleted'` は「利用者が消した」印。通報対応で admin が見るのは `hidden` までで、
`deleted` を管理画面に出すと「消したはずのレビューが運営には残っている」ことになる。
admin の可視条件を `undefined`（条件なし）にせず `ne(status, 'deleted')` にするのはこのため。
Phase 4 の削除 API は物理削除なので `deleted` は現状どこからも作られないが、
**後から論理削除に変えたときに管理画面へ漏れ出さない形**を先に決めておく。

- [ ] **Step 1: fixtures に `seedReview` と `rejectionMessageOf` を追加する**

`apps/api/src/test/fixtures.ts` の末尾に追加する（Task 4-8 Step 1 の Actor ヘルパの後ろ）。
import 行に `REVIEW_STATUS_PUBLISHED` と型 `ReviewStatus` を足す:

```ts
import {
  PROFILE_STATUS_ACTIVE,
  REVIEW_STATUS_PUBLISHED,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import type { ProfileStatus, ReviewStatus, Role, ShopStatus } from '../db/constants';
```

```ts
export type SeedReviewOptions = {
  readonly id: string;
  readonly shopId: string;
  readonly userId: string;
  readonly status?: ReviewStatus;
  readonly rating?: number;
  readonly body?: string;
  /** NULL 可だが、入れるなら YYYY-MM-DD（ck_reviews_visited_on_format） */
  readonly visitedOn?: string | null;
  readonly budget?: number | null;
  /** ミリ秒。生の SQL で入れるので Date ではなく整数で渡す */
  readonly createdAtMs?: number;
};

/**
 * レビューを 1 行作る。
 * `uq_reviews_shop_user` があるので、**同じ (shopId, userId) の組を 2 回渡すと落ちる**。
 * hidden なレビューを混ぜたいときは、別の利用者を用意すること。
 */
export async function seedReview(world: TestWorld, options: SeedReviewOptions): Promise<void> {
  await runWrite(
    world,
    'INSERT INTO reviews (id, shop_id, user_id, rating, body, visited_on, budget, status, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    options.id,
    options.shopId,
    options.userId,
    options.rating ?? 4,
    options.body ?? '美味しかった',
    options.visitedOn === undefined ? '2026-09-01' : options.visitedOn,
    options.budget ?? null,
    options.status ?? REVIEW_STATUS_PUBLISHED,
    options.createdAtMs ?? 0,
  );
}

/**
 * Drizzle は D1 のエラーを `Failed query: insert into ...` という自前のメッセージで包み、
 * 本当の理由（`UNIQUE constraint failed: ...`）を `cause` の先に隠す。
 * `rejects.toThrow(/UNIQUE/)` は message しか見ないので**必ず素通りする**。
 * cause を末端まで辿って連結し、制約名で検証できるようにする。
 */
export async function rejectionMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(' / ');
  }
  throw new Error('例外が発生すると期待したが、正常に解決した');
}
```

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/review-repository.test.ts`:

```ts
import { toReviewId, toShopId } from '@meshimap/core';
import type { ReviewCreateInput } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import {
  REVIEW_STATUS_DELETED,
  REVIEW_STATUS_HIDDEN,
  REVIEW_STATUS_PUBLISHED,
  ROLE_ADMIN,
  ROLE_USER,
} from '../db/constants';
import {
  adminActorOrThrow,
  buildActorForTest,
  countRows,
  createTestWorld,
  readRow,
  rejectionMessageOf,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  userActorOrThrow,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import {
  createReviewAsUser,
  deleteReviewAsAdmin,
  deleteReviewAsAuthor,
  listVisibleReviews,
} from './review-repository';

const ALICE_ID = 'usr_alice';
const BOB_ID = 'usr_bob';
const CAROL_ID = 'usr_carol';
const ADMIN_ID = 'usr_admin';

const SHOP_ID = 'shp_a';
const OTHER_SHOP_ID = 'shp_b';
/** レビューが 1 件も無い店舗。uq_reviews_shop_user を避けて新規投稿を試す場所 */
const EMPTY_SHOP_ID = 'shp_c';

/** reviewCreateSchema.parse を通した後の形。budgetYen は default(null) で必ず存在する */
const NEW_REVIEW_INPUT: ReviewCreateInput = {
  // identifierSchema 由来なので素の string。ブランド型ではない
  shopId: SHOP_ID,
  rating: 5,
  body: 'とても良かった',
  visitedOn: '2026-09-10',
  budgetYen: 3200,
};

describe('review-repository', () => {
  let world: TestWorld;
  let db: Database;

  const alice = userActorOrThrow(buildActorForTest(ALICE_ID, ROLE_USER));
  const bob = userActorOrThrow(buildActorForTest(BOB_ID, ROLE_USER));
  const carol = userActorOrThrow(buildActorForTest(CAROL_ID, ROLE_USER));
  const admin = adminActorOrThrow(buildActorForTest(ADMIN_ID, ROLE_ADMIN));

  beforeEach(async () => {
    world = await createTestWorld();
    await seedMasters(world);
    await seedUser(world, { userId: ALICE_ID, role: ROLE_USER });
    await seedUser(world, { userId: BOB_ID, role: ROLE_USER });
    await seedUser(world, { userId: CAROL_ID, role: ROLE_USER });
    await seedUser(world, { userId: ADMIN_ID, role: ROLE_ADMIN });
    // owner_id は NULL 可。ここではオーナーを問わないので null にして依存を減らす
    await seedShop(world, { id: SHOP_ID, ownerId: null });
    await seedShop(world, { id: OTHER_SHOP_ID, ownerId: null });
    await seedShop(world, { id: EMPTY_SHOP_ID, ownerId: null });
    // uq_reviews_shop_user があるので (店舗, 利用者) の組は全部ばらばらにする
    await seedReview(world, {
      id: 'rev_alice',
      shopId: SHOP_ID,
      userId: ALICE_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 10,
    });
    await seedReview(world, {
      id: 'rev_bob',
      shopId: SHOP_ID,
      userId: BOB_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 20,
    });
    await seedReview(world, {
      id: 'rev_hidden',
      shopId: SHOP_ID,
      userId: CAROL_ID,
      status: REVIEW_STATUS_HIDDEN,
      createdAtMs: 30,
    });
    await seedReview(world, {
      id: 'rev_other_shop',
      shopId: OTHER_SHOP_ID,
      userId: ALICE_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 40,
    });
    await seedReview(world, {
      id: 'rev_deleted',
      shopId: OTHER_SHOP_ID,
      userId: BOB_ID,
      status: REVIEW_STATUS_DELETED,
      createdAtMs: 50,
    });
    db = createDatabase(world.d1);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('listVisibleReviews', () => {
    it('指定した店舗の published なレビューだけを返す', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id).sort()).toEqual(['rev_alice', 'rev_bob']);
    });

    it('別の店舗のレビューを混ぜない', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).not.toContain('rev_other_shop');
    });

    it('hidden なレビューは投稿者本人にも見せない', async () => {
      // 本人にだけ見えると「伏せられた」と分かり、通報されたこと自体が漏れる
      const rows = await listVisibleReviews(db, carol, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).not.toContain('rev_hidden');
    });

    it('admin には hidden も見せる（通報対応のため）', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id).sort()).toEqual(['rev_alice', 'rev_bob', 'rev_hidden']);
    });

    it('admin にも deleted は見せない', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(OTHER_SHOP_ID));
      expect(rows.map((row) => row.id)).toEqual(['rev_other_shop']);
    });

    it('新しい順に並ぶ', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).toEqual(['rev_hidden', 'rev_bob', 'rev_alice']);
    });

    it('レビューが 1 件も無い店舗では空配列を返す（例外にしない）', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(EMPTY_SHOP_ID));
      expect(rows).toEqual([]);
    });
  });

  describe('createReviewAsUser', () => {
    it('投稿者の userId が記録される', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new'),
        NEW_REVIEW_INPUT,
        new Date(100),
      );
      expect(created.userId).toBe(ALICE_ID);
      expect(created.status).toBe(REVIEW_STATUS_PUBLISHED);
    });

    it('引数の userId を受け取らない（なりすましの経路を作らない）', async () => {
      // シグネチャに userId が無いことを型で保証している。ここでは値の出所だけ確認する
      const created = await createReviewAsUser(
        db,
        bob,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new2'),
        NEW_REVIEW_INPUT,
        new Date(110),
      );
      expect(created.userId).toBe(BOB_ID);
    });

    it('入力の shopId ではなく引数の shopId を保存する', async () => {
      // 入力の shopId は shp_a。引数には別店舗を渡す。保存されるのは引数側
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new3'),
        NEW_REVIEW_INPUT,
        new Date(120),
      );
      expect(created.shopId).toBe(EMPTY_SHOP_ID);
    });

    it('budgetYen を budget 列へ対応づける', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new4'),
        NEW_REVIEW_INPUT,
        new Date(130),
      );
      expect(created.budget).toBe(3200);
    });

    it('budgetYen が null なら budget も null', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new5'),
        { ...NEW_REVIEW_INPUT, budgetYen: null },
        new Date(140),
      );
      expect(created.budget).toBeNull();
    });

    it('visitedOn を ISO 日付文字列のまま保存する', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new6'),
        NEW_REVIEW_INPUT,
        new Date(150),
      );
      expect(created.visitedOn).toBe('2026-09-10');
    });

    it('createdAt を Date のまま返す（timestamp_ms なので整数ではない）', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new7'),
        NEW_REVIEW_INPUT,
        new Date(160),
      );
      expect(created.createdAt).toEqual(new Date(160));
    });

    it('作成直後は published なので一覧に載る', async () => {
      await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new8'),
        NEW_REVIEW_INPUT,
        new Date(170),
      );
      const rows = await listVisibleReviews(db, bob, toShopId(EMPTY_SHOP_ID));
      expect(rows.map((row) => row.id)).toContain('rev_new8');
    });

    it('同じ利用者が同じ店に 2 件目を投稿すると一意制約で落ちる', async () => {
      // alice は shp_a に rev_alice を投稿済み。DB 側の uq_reviews_shop_user が効いている証拠
      const message = await rejectionMessageOf(
        createReviewAsUser(
          db,
          alice,
          toShopId(SHOP_ID),
          toReviewId('rev_dup'),
          NEW_REVIEW_INPUT,
          new Date(180),
        ),
      );
      expect(message).toContain('UNIQUE constraint failed: reviews.shop_id, reviews.user_id');
    });

    it('存在しない店舗 ID では外部キー制約で落ちる', async () => {
      const message = await rejectionMessageOf(
        createReviewAsUser(
          db,
          alice,
          toShopId('shp_nothing'),
          toReviewId('rev_fk'),
          NEW_REVIEW_INPUT,
          new Date(190),
        ),
      );
      expect(message).toContain('FOREIGN KEY constraint failed');
    });
  });

  describe('deleteReviewAsAuthor', () => {
    it('自分のレビューを削除できる', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_alice'))).toBe(true);
    });

    it('他人のレビューは削除できない（false）', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_bob'))).toBe(false);
    });

    it('他人のレビューの行が残っている', async () => {
      await deleteReviewAsAuthor(db, alice, toReviewId('rev_bob'));

      // リポジトリを通さず生 SQL で実体を見る。false が返っても消えていた、を検出するため
      const row = await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_bob');

      expect(row).toEqual({ id: 'rev_bob' });
    });

    it('存在しない ID でも false（他人のレビューと同じ結果）', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_nothing'))).toBe(false);
    });

    it('自分の hidden なレビューも削除できる（見えないが自分のものではある）', async () => {
      expect(await deleteReviewAsAuthor(db, carol, toReviewId('rev_hidden'))).toBe(true);
    });
  });

  describe('deleteReviewAsAdmin', () => {
    it('他人のレビューでも削除できる', async () => {
      expect(await deleteReviewAsAdmin(db, admin, toReviewId('rev_bob'))).toBe(true);
    });

    it('存在しない ID には false を返す', async () => {
      expect(await deleteReviewAsAdmin(db, admin, toReviewId('rev_nothing'))).toBe(false);
    });

    it('削除対象以外を消さない', async () => {
      await deleteReviewAsAdmin(db, admin, toReviewId('rev_bob'));
      expect(await countRows(world, 'SELECT COUNT(*) AS count FROM reviews')).toBe(4);
    });
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- review-repository
```

期待: `Cannot find module './review-repository' imported from .../apps/api/src/repositories/review-repository.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 4: fixtures のヘルパが揃っていることを確認する**

Task 4-8 Step 1 で `buildActorForTest` / `userActorOrThrow` / `adminActorOrThrow` を、
本タスク Step 1 で `seedReview` / `rejectionMessageOf` を追加済み。

```bash
grep -n "export function buildActorForTest\|export async function seedReview\|export async function rejectionMessageOf" apps/api/src/test/fixtures.ts
```

期待: 3 行ともヒットする。ヒットしなければ該当 Step のコードを適用する。

- [ ] **Step 5: 最小実装を書く**

`apps/api/src/repositories/review-repository.ts`:

```ts
import type { ReviewCreateInput, ReviewId, ShopId } from '@meshimap/core';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isAdminActor } from '../auth/actor';
import type { AdminActor, UserActor, Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { REVIEW_STATUS_DELETED, REVIEW_STATUS_PUBLISHED } from '../db/constants';
import { reviews } from '../db/schema';

export type ReviewRow = typeof reviews.$inferSelect;

/**
 * hidden は通報対応で admin が伏せた状態。
 * 投稿者本人にも見せない（本人にだけ見えると「伏せられた」と分かり、通報の有無が漏れる）。
 * deleted は利用者が消したもの。admin にも見せない（消したはずが運営には残っている、を避ける）。
 */
function reviewVisibilityCondition(viewer: Viewer): SQL {
  if (isAdminActor(viewer)) {
    return ne(reviews.status, REVIEW_STATUS_DELETED);
  }
  return eq(reviews.status, REVIEW_STATUS_PUBLISHED);
}

export async function listVisibleReviews(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
): Promise<ReviewRow[]> {
  return await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.shopId, shopId), reviewVisibilityCondition(viewer)))
    .orderBy(desc(reviews.createdAt));
}

/**
 * 投稿者 ID は **引数で受け取らず** actor から取る。
 * 引数で受け取れる形にすると、ルート側がリクエストボディの userId を渡してなりすませる。
 * 同じ理由で店舗 ID も input.shopId ではなく、URL 由来で可視性チェックを通した引数を使う。
 *
 * 1 ユーザー 1 店舗 1 レビューは `uq_reviews_shop_user` が DB 側で保証する。
 * 事前に SELECT して重複を弾く実装にしない（確認と INSERT の間に別リクエストが差し込める）。
 */
export async function createReviewAsUser(
  db: Database,
  actor: UserActor,
  shopId: ShopId,
  reviewId: ReviewId,
  input: ReviewCreateInput,
  now: Date,
): Promise<ReviewRow> {
  const inserted = await db
    .insert(reviews)
    .values({
      id: reviewId,
      shopId,
      userId: actor.userId,
      rating: input.rating,
      body: input.body,
      visitedOn: input.visitedOn,
      budget: input.budgetYen,
      status: REVIEW_STATUS_PUBLISHED,
      createdAt: now,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    // INSERT ... RETURNING が 0 件を返すのは D1 側の異常。握り潰さない
    throw new Error('レビューの作成に失敗した');
  }
  return row;
}

/** 投稿者本人だけが消せる。投稿者チェックは `WHERE user_id = ?` として表現する */
export async function deleteReviewAsAuthor(
  db: Database,
  actor: UserActor,
  reviewId: ReviewId,
): Promise<boolean> {
  const deleted = await db
    .delete(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.userId, actor.userId)))
    .returning({ id: reviews.id });
  return deleted.length > 0;
}

/** 通報対応。admin は投稿者を問わず消せる */
export async function deleteReviewAsAdmin(
  db: Database,
  _actor: AdminActor,
  reviewId: ReviewId,
): Promise<boolean> {
  const deleted = await db
    .delete(reviews)
    .where(eq(reviews.id, reviewId))
    .returning({ id: reviews.id });
  return deleted.length > 0;
}
```

- [ ] **Step 6: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- review-repository
npm run typecheck -w @meshimap/api
```

期待: テスト 25 件すべて PASS。`typecheck` はエラー 0。

- [ ] **Step 7: 意図的にコードを壊してテストが検知することを確認する**

`deleteReviewAsAuthor` から投稿者条件を落とす:

```ts
    .where(eq(reviews.id, reviewId))
```

```bash
npm run test -w @meshimap/api -- review-repository
```

期待: `他人のレビューは削除できない（false）` と `他人のレビューの行が残っている` が FAIL。確認後に元へ戻す。

次に `listVisibleReviews` から `eq(reviews.shopId, shopId)` を落とす。
期待: `指定した店舗の published なレビューだけを返す` と `別の店舗のレビューを混ぜない` が FAIL。確認後に元へ戻す。

次に `createReviewAsUser` の `shopId` を `input.shopId` に差し替える:

```ts
      shopId: input.shopId,
```

期待: `入力の shopId ではなく引数の shopId を保存する` が FAIL。**ここが通ってしまうと、
見えない店舗へレビューを差し込める穴が開く。** 加えて
`同じ利用者が同じ店に 2 件目を投稿すると一意制約で落ちる` も、alice の rev_alice と衝突しなくなって FAIL する。
確認後に元へ戻す。

次に `reviewVisibilityCondition` の `isAdminActor(viewer)` を `!isAdminActor(viewer)` に反転する。
期待: `hidden なレビューは投稿者本人にも見せない` と `admin には hidden も見せる（通報対応のため）` が FAIL。確認後に元へ戻す。

次に admin 側の条件を `ne(reviews.status, REVIEW_STATUS_DELETED)` から
`ne(reviews.status, REVIEW_STATUS_HIDDEN)` に取り違える。
期待: `admin にも deleted は見せない` と `admin には hidden も見せる（通報対応のため）` が FAIL。確認後に元へ戻す。

次に `budget: input.budgetYen` を `budget: null` に固定する。
期待: `budgetYen を budget 列へ対応づける` が FAIL。確認後に元へ戻す。

最後に `userId: actor.userId` を `userId: input.shopId` に差し替える
（`ReviewCreateInput.shopId` は素の `string` なので、**これは型が通ってしまう**）。
期待: `投稿者の userId が記録される` と `引数の userId を受け取らない（なりすましの経路を作らない）` が FAIL。
実際には `FOREIGN KEY constraint failed` で例外になり、10 件中 8 件がまとめて FAIL する。
**ブランド型は Actor の取り違えは防ぐが、素の string 同士の取り違えは防げない**ことの確認でもある。
確認後に元へ戻す。

- [ ] **Step 8: コミット**

```bash
git add apps/api/src/repositories/review-repository.ts apps/api/src/repositories/review-repository.test.ts apps/api/src/test/fixtures.ts
git commit -m "feat(api): 投稿者チェックを WHERE 句で表現するレビューリポジトリを追加"
```

---

## Task 4-10: リポジトリ規約の機械検査（Actor を取らない関数を存在させない）

型は「渡された Actor が正しいか」は守ってくれるが、「**Actor を引数に取り忘れた関数**」は守れない。
`getShopById(db, shopId)` という関数をうっかり生やすと、型検査は素通りする。
ここを塞ぐのが本タスク。TypeScript Compiler API でリポジトリ層のソースを走査し、規約違反を機械的に落とす。

**Files:**

- Create: `apps/api/src/repositories/repository-convention.test.ts`
- Test: 同上（このファイル自体がテスト）

**Interfaces:**

- Consumes: `node:fs` の `readdirSync` / `readFileSync`、`node:path`（既定 import）、`node:url` の `fileURLToPath`、`typescript` 6.0.3（ルートの devDependencies。追加インストール不要）。`node:*` を使うため Task 4-3 の tsconfig 変更（`types` に `"node"`）が前提
- Produces: `collectConventionViolations(sourceFile: ts.SourceFile, label: string): string[]`（同一ファイル内の自己テストから呼ぶため export する。他ファイルからは import しない）

> **`import.meta.dirname` は使わない**。グローバルの `URL` が `@cloudflare/workers-types` のものに
> 差し替わっている影響でファイル読み込み系が TS2769 になるのを避けるため、リポジトリ内のソース走査は
> すべて `path.dirname(fileURLToPath(import.meta.url))` に揃えてある
> （`auth/actor-encapsulation.test.ts` / `db/constants-parity.test.ts` と同形）。

### 検査する 8 つの規約

| #   | 規約                                                                                          | 破られたときに起きること                                                  |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `src/repositories/*.ts`（`.test.ts` を除く）に export された関数が 1 つ以上ある               | 走査対象ゼロで「違反なし」の偽の緑になるのを防ぐ                          |
| 2   | export された関数は引数を 2 つ以上取る                                                        | `listAllShops()` のような無条件全件取得が生える                           |
| 3   | 第 1 引数は `db: Database`                                                                    | 引数順がばらつき、レビューで見落とす                                      |
| 4   | 第 2 引数の**名前**が `actor` / `viewer`（未使用時の `_` 接頭辞可）                           | 呼び出し側が何を渡すべきか読み取れない                                    |
| 5   | 第 2 引数の**型**が `UserActor` / `OwnerActor` / `AdminActor` / `Actor` / `Viewer` のいずれか | `actor: string` で素通りする                                              |
| 6   | ファイル内に `db.transaction(` が現れない                                                     | ローカルの node:sqlite では通るが本番 D1 で落ちる（グローバル制約の再掲） |
| 7   | `export default` / `export *` / 分割代入 export / 他モジュールの再エクスポートを使わない      | 署名を辿れなくなり、検査を素通りする関数が生える                          |
| 8   | export してよいのは関数リテラルとリテラル定数だけ（`class` の export は禁止）                 | メソッドの中に Actor を取らない処理が隠れる                               |

> **型名のテキストだけを見ていて十分か**: 十分ではない。`type Viewer = string` と別名定義すれば抜けられる。
> しかしそれは `auth/actor.ts` を書き換える行為で、Task 4-2 の型テスト（`@ts-expect-error` 7 件）が同時に壊れる。
> **2 つの検査を同時に欺く必要がある**状態まで持ち込めていればよい、と判断する。

- [ ] **Step 1: 検査テストを書く**

`apps/api/src/repositories/repository-convention.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * リポジトリ層の規約をソースコードそのものに対して機械的に検査する。
 *
 * 設計書 3.2 の二層防御のうち「Actor を第 2 引数として必ず受け取る」という型側の担保は、
 * 新しい関数を 1 つ書き忘れるだけで穴が開く。レビューに頼らず、ここで構文レベルで落とす。
 *
 * `import.meta.dirname` ではなく fileURLToPath を使う理由:
 * グローバルの `URL` が @cloudflare/workers-types のものに差し替わっているため
 * `readFileSync(new URL(...))` は TS2769 になる。src/auth/actor-encapsulation.test.ts と同じ形に揃える。
 */
const REPOSITORIES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 第 2 引数に許される型名。src/auth/actor.ts の export と一致させること */
const ACTOR_TYPE_NAMES = new Set(['UserActor', 'OwnerActor', 'AdminActor', 'Actor', 'Viewer']);
/** 未使用引数は noUnusedParameters を満たすため `_` を付ける。引数を要求すること自体が目的なので削らない */
const ACTOR_PARAMETER_NAMES = new Set(['actor', '_actor', 'viewer', '_viewer']);
const DB_PARAMETER_NAME = 'db';
const DB_TYPE_NAME = 'Database';
/** 本番の D1 に対話的トランザクションは無い。ローカルの miniflare では通ってしまうので構文で禁じる */
const FORBIDDEN_TRANSACTION_CALL = 'db.transaction(';

type ExportedSignature = {
  readonly name: string;
  readonly parameters: ts.NodeArray<ts.ParameterDeclaration>;
};

type ExportScanResult = {
  readonly signatures: ExportedSignature[];
  readonly violations: string[];
};

function isFunctionLiteral(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * 「関数が隠れている余地がない値」かどうか。
 * `export const findShop = makeFinder(shops)` のような間接参照は引数が構文に現れず、
 * 検査を素通りする抜け道になるため、リテラル以外の初期化子は一律で違反にする。
 */
function isLiteralConstant(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isLiteralConstant(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return isLiteralConstant(node.operand);
  }
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * ファイル内のトップレベル関数を export の有無に関わらず索引する。
 * `export { findShop }` 形式の公開では宣言側に export 修飾子が付かないため、
 * 修飾子だけを見ていると実体を見失う。
 * オーバーロードがあると同じ名前に複数のシグネチャがぶら下がるので配列で持つ。
 */
function indexLocalCallables(sourceFile: ts.SourceFile): Map<string, ExportedSignature[]> {
  const index = new Map<string, ExportedSignature[]>();
  const add = (name: string, parameters: ts.NodeArray<ts.ParameterDeclaration>): void => {
    const current = index.get(name) ?? [];
    current.push({ name, parameters });
    index.set(name, current);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement.parameters);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer !== undefined &&
          isFunctionLiteral(initializer) &&
          ts.isIdentifier(declaration.name)
        ) {
          add(declaration.name.text, initializer.parameters);
        }
      }
    }
  }
  return index;
}

/** `export { a as b }` の再エクスポートを、同じファイル内の宣言まで辿って解決する */
function resolveReExport(
  statement: ts.ExportDeclaration,
  clause: ts.NamedExports,
  localCallables: Map<string, ExportedSignature[]>,
  label: string,
): ExportScanResult {
  const signatures: ExportedSignature[] = [];
  const violations: string[] = [];

  for (const specifier of clause.elements) {
    if (specifier.isTypeOnly) {
      continue;
    }
    const exportedName = specifier.name.text;
    if (statement.moduleSpecifier !== undefined) {
      // 署名が別ファイルにあるので、このファイルだけを見る検査器では中身を確かめられない
      violations.push(
        `${label}: ${exportedName} を別モジュールから再エクスポートしている（署名が検査から外れる）`,
      );
      continue;
    }
    // import の別名と同じく、ローカル側の名前は propertyName に入る（`export { local as public }`）
    const localName = (specifier.propertyName ?? specifier.name).text;
    const resolved = localCallables.get(localName);
    if (resolved === undefined) {
      violations.push(`${label}: ${exportedName} の実体を同じファイル内に解決できない`);
      continue;
    }
    for (const signature of resolved) {
      signatures.push({ name: exportedName, parameters: signature.parameters });
    }
  }
  return { signatures, violations };
}

/**
 * export された「関数」だけを拾う。`export type` / 非関数の `export const` は対象外。
 * オーバーロード宣言は実装シグネチャとは別の公開された呼び出し口なので、1 つずつ拾う
 * （実装だけを見ると、Actor を取らないオーバーロードが公開されたまま素通りする）。
 */
function scanExports(sourceFile: ts.SourceFile, label: string): ExportScanResult {
  const signatures: ExportedSignature[] = [];
  const violations: string[] = [];
  const localCallables = indexLocalCallables(sourceFile);

  for (const statement of sourceFile.statements) {
    // `export default findShop;` は修飾子を持たない ExportAssignment なので個別に見る
    if (ts.isExportAssignment(statement)) {
      violations.push(`${label}: default export は禁止`);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        // 型だけの再エクスポートは実行時の呼び出し口を増やさない
        continue;
      }
      const clause = statement.exportClause;
      if (clause === undefined) {
        violations.push(`${label}: export * による再エクスポートは禁止（署名が検査から外れる）`);
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        violations.push(`${label}: export * as による再エクスポートは禁止（署名が検査から外れる）`);
        continue;
      }
      const resolved = resolveReExport(statement, clause, localCallables, label);
      signatures.push(...resolved.signatures);
      violations.push(...resolved.violations);
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      // 規約で default export は禁止。中身も続けて検査したいので continue しない
      violations.push(`${label}: default export は禁止`);
    }

    if (ts.isClassDeclaration(statement)) {
      violations.push(`${label}: class の export は禁止（リポジトリ層は関数だけを export する）`);
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      signatures.push({ name: statement.name.text, parameters: statement.parameters });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          violations.push(`${label}: 分割代入による export は禁止`);
          continue;
        }
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        if (initializer !== undefined && isFunctionLiteral(initializer)) {
          signatures.push({ name, parameters: initializer.parameters });
          continue;
        }
        if (initializer === undefined || !isLiteralConstant(initializer)) {
          violations.push(
            `${label}: ${name} は関数リテラルでもリテラル定数でもない値を export している（関数が隠れていても検査できない）`,
          );
        }
      }
    }
  }
  return { signatures, violations };
}

function parameterTypeName(parameter: ts.ParameterDeclaration): string | null {
  const typeNode = parameter.type;
  if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode)) {
    return null;
  }
  const typeName = typeNode.typeName;
  return ts.isIdentifier(typeName) ? typeName.text : null;
}

function parameterName(parameter: ts.ParameterDeclaration): string | null {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

/**
 * 規約違反を人間が読める文字列の配列で返す。空配列なら合格。
 *
 * ソースファイルだけを見る純関数にしてあるので、実ファイルを作らずに
 * `ts.createSourceFile` した文字列で検査器そのものをテストできる。
 */
export function collectConventionViolations(sourceFile: ts.SourceFile, label: string): string[] {
  const violations: string[] = [];

  if (sourceFile.text.includes(FORBIDDEN_TRANSACTION_CALL)) {
    violations.push(`${label}: ${FORBIDDEN_TRANSACTION_CALL} を使っている`);
  }

  const scanned = scanExports(sourceFile, label);
  violations.push(...scanned.violations);
  if (scanned.signatures.length === 0) {
    violations.push(`${label}: export された関数が 1 つも無い`);
  }

  for (const signature of scanned.signatures) {
    const first = signature.parameters[0];
    const second = signature.parameters[1];
    if (first === undefined || second === undefined) {
      violations.push(`${label}: ${signature.name} の引数が 2 つ未満（db と actor が必須）`);
      continue;
    }
    if (parameterName(first) !== DB_PARAMETER_NAME || parameterTypeName(first) !== DB_TYPE_NAME) {
      violations.push(`${label}: ${signature.name} の第 1 引数が db: Database ではない`);
    }
    const secondName = parameterName(second);
    if (secondName === null || !ACTOR_PARAMETER_NAMES.has(secondName)) {
      violations.push(
        `${label}: ${signature.name} の第 2 引数名が actor / viewer ではない（${String(secondName)}）`,
      );
    }
    const secondType = parameterTypeName(second);
    if (secondType === null || !ACTOR_TYPE_NAMES.has(secondType)) {
      violations.push(
        `${label}: ${signature.name} の第 2 引数の型が Actor 系ではない（${String(secondType)}）`,
      );
    }
  }
  return violations;
}

function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** 実ファイルを読んで検査する薄いラッパ。ファイル入出力をここだけに閉じ込める */
function violationsOfFile(fileName: string): string[] {
  const filePath = path.join(REPOSITORIES_DIR, fileName);
  const source = readFileSync(filePath, 'utf8');
  return collectConventionViolations(parseSource(filePath, source), fileName);
}

function listRepositoryFiles(): string[] {
  return readdirSync(REPOSITORIES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'));
}

describe('検査器そのものの取りこぼし', () => {
  /** 実ファイルを作らずに検査ロジックだけを試すためのヘルパ */
  function violationsOf(code: string): string[] {
    return collectConventionViolations(parseSource('probe.ts', code), 'probe.ts');
  }

  const COMPLIANT_SOURCE = `
import type { Database } from '../db/client';

export type ShopRow = { readonly id: string };
export const SOME_CONSTANT = 1;

function notExported(value: number): number {
  return value;
}

export async function listThings(db: Database, viewer: Viewer, limit?: number): Promise<ShopRow[]> {
  return [];
}

export async function updateThingAsOwner(db: Database, actor: OwnerActor, id: ShopId): Promise<null> {
  return null;
}

export async function deleteThingAsAdmin(db: Database, _actor: AdminActor, id: ShopId): Promise<boolean> {
  return false;
}

export const arrowGood = async (db: Database, viewer: Viewer): Promise<void> => {};
`;

  it('規約を満たすソースには違反を出さない', () => {
    expect(violationsOf(COMPLIANT_SOURCE)).toEqual([]);
  });

  it('Actor を取らない関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function noActor(db: Database, shopId: ShopId): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('noActor の第 2 引数名が actor / viewer ではない');
  });

  it('引数順が逆の関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function wrongOrder(actor: OwnerActor, db: Database): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('wrongOrder の第 1 引数が db: Database ではない');
  });

  it('第 2 引数の型が string の関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function stringActor(db: Database, actor: string): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('stringActor の第 2 引数の型が Actor 系ではない');
  });

  it('引数を取らない関数を違反として検出する', () => {
    const violations = violationsOf('export async function noParams(): Promise<void> {}');
    expect(violations.join('\n')).toContain('noParams の引数が 2 つ未満');
  });

  it('アロー関数の export も検査する', () => {
    // `export const fn = (...) => {}` は FunctionDeclaration ではないので、
    // 関数宣言だけを見ていると 1 件も引っかからない
    const violations = violationsOf(
      'export const arrowBad = async (db: Database, shopId: ShopId): Promise<void> => {};',
    );
    expect(violations.join('\n')).toContain('arrowBad の第 2 引数名が actor / viewer ではない');
  });

  it('関数式の export も検査する', () => {
    const violations = violationsOf(
      'export const expressionBad = async function (db: Database, shopId: ShopId) {};',
    );
    expect(violations.join('\n')).toContain(
      'expressionBad の第 2 引数名が actor / viewer ではない',
    );
  });

  it('db.transaction( を違反として検出する', () => {
    const violations = violationsOf(
      [
        'export async function usesTransaction(db: Database, actor: AdminActor): Promise<void> {',
        '  await db.transaction(async () => {});',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('db.transaction( を使っている');
  });

  it('export された関数が無いファイルを違反として検出する', () => {
    const violations = violationsOf(
      [
        'export type OnlyAType = { readonly id: string };',
        'export const ONLY_A_CONSTANT = 1;',
        'function notExported(): void {}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('export された関数が 1 つも無い');
  });

  it('オーバーロード宣言も 1 つずつ検査する', () => {
    // 実装シグネチャは規約を満たしているので、実装だけを見ると 1 件も引っかからない。
    // だが 1 本目のオーバーロードは Actor を取らない呼び出し口として公開されている
    const violations = violationsOf(
      [
        'export function findShop(db: Database, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId?: ShopId): null {',
        '  return null;',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain(
      'findShop の第 2 引数名が actor / viewer ではない（shopId）',
    );
  });

  it('すべてのオーバーロードが規約を満たしていれば通す', () => {
    const violations = violationsOf(
      [
        'export function findShop(db: Database, viewer: Viewer): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId?: ShopId): null {',
        '  return null;',
        '}',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('default export を違反として検出する（宣言形）', () => {
    const violations = violationsOf(
      'export default async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('default export は禁止');
  });

  it('default export を違反として検出する（代入形）', () => {
    // `export default findShop` は ExportAssignment なので、修飾子だけを見ていると素通りする
    const violations = violationsOf(
      [
        'async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
        'export default findShop;',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('default export は禁止');
  });

  it('同じファイル内の関数を export { } で公開しても検査する', () => {
    // 宣言側に export 修飾子が付かないので、修飾子だけを見ていると素通りする
    const violations = violationsOf(
      [
        'async function findShop(db: Database, shopId: ShopId): Promise<void> {}',
        'export { findShop };',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('findShop の第 2 引数名が actor / viewer ではない');
  });

  it('別名を付けた export { x as y } も、元の宣言を辿って検査する', () => {
    const violations = violationsOf(
      [
        'async function findShop(db: Database, shopId: ShopId): Promise<void> {}',
        'export { findShop as lookupShop };',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('lookupShop の第 2 引数名が actor / viewer ではない');
  });

  it('別名を付けた export { x as y } は規約を満たしていれば通す', () => {
    const violations = violationsOf(
      [
        'async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
        'export { findShop as lookupShop };',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('別モジュールからの再エクスポートを違反として検出する', () => {
    // 署名が別ファイルにあるので、このファイルだけを見る検査器では中身を確かめようがない
    const violations = violationsOf("export { findShop } from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('findShop を別モジュールから再エクスポートしている');
  });

  it('export * を違反として検出する', () => {
    const violations = violationsOf("export * from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('export * による再エクスポートは禁止');
  });

  it('export * as を違反として検出する', () => {
    const violations = violationsOf("export * as queries from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('export * as による再エクスポートは禁止');
  });

  it('型だけの再エクスポートは見逃す', () => {
    const violations = violationsOf(
      [
        "export type { ShopRow } from './shop-repository';",
        'export async function listThings(db: Database, viewer: Viewer): Promise<void> {}',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('関数リテラル以外の値を export していたら違反として検出する', () => {
    // `export const findShop = makeFinder(shops)` は関数を返しうるのに
    // 引数が構文に現れないため、検査を素通りさせる抜け道になる
    const violations = violationsOf(
      [
        'export const findShop = makeFinder(shops);',
        'export async function listThings(db: Database, viewer: Viewer): Promise<void> {}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('findShop は関数リテラルでもリテラル定数でもない');
  });

  it('class の export を違反として検出する', () => {
    const violations = violationsOf(
      [
        'export class ShopRepository {',
        '  find(shopId: ShopId): null {',
        '    return null;',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('class の export は禁止');
  });
});

describe('リポジトリ層の規約', () => {
  const files = listRepositoryFiles();

  it('走査対象のリポジトリファイルが 1 つ以上ある', () => {
    // 対象がゼロだと以下の it.each が 0 件になり、何も検査していないのに緑になる
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s は規約を満たす', (fileName) => {
    expect(violationsOfFile(fileName)).toEqual([]);
  });
});
```

- [ ] **Step 2: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- repository-convention
```

期待: 自己テスト 22 件 ＋ 対象数チェック 1 件 ＋ `it.each` が回す実ファイル 2 件
（`shop-repository.ts` / `review-repository.ts`）、**合計 25 件**すべて PASS。

> **このタスクは最初から緑になる。** 検査を書くタスクなので赤を見るのは次の Step で、
> 実ファイルをわざと壊して行う。フィクスチャファイル（`__fixtures__/*.ts.txt`）は作らない。
> 検査器を `collectConventionViolations(sourceFile, label)` という純関数にしてあるので、
> 自己テストはソースを**文字列リテラル**で渡して `ts.createSourceFile` すれば足り、
> 「わざと壊したファイル」を `tsc` / ESLint / Prettier から隠す工夫そのものが要らなくなる。

- [ ] **Step 3: 意図的にコードを壊してテストが検知することを確認する**

`apps/api/src/repositories/shop-repository.ts` の末尾に、Actor を取らない関数を足す:

```ts
export async function findShopWithoutActor(db: Database, shopId: ShopId): Promise<ShopRow | null> {
  const rows = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  return rows[0] ?? null;
}
```

```bash
npm run test -w @meshimap/api -- repository-convention
```

期待: `shop-repository.ts は規約を満たす` が
`findShopWithoutActor の第 2 引数名が actor / viewer ではない（shopId）` を含んで FAIL。
**これが Task 4-10 の存在意義そのもの。** 確認後に追加した関数を削除する。

次に `updateShopAsOwner` の引数順を `(actor, db, ...)` に入れ替える:

```ts
export async function updateShopAsOwner(
  actor: OwnerActor,
  db: Database,
```

期待: `updateShopAsOwner の第 1 引数が db: Database ではない` で FAIL。確認後に元へ戻す。

最後に `listRepositoryFiles` の `.filter((name) => name.endsWith('.ts'))` を `.endsWith('.nonexistent')` に変えて、
`走査対象のリポジトリファイルが 1 つ以上ある` が FAIL することを確認する（**偽の緑を検出できる**ことの確認）。確認後に元へ戻す。

- [ ] **Step 4: コミット**

```bash
git add apps/api/src/repositories/repository-convention.test.ts
git commit -m "test(api): Actor を取らないリポジトリ関数を機械的に禁止する検査を追加"
```

---

## Task 4-11: ルートとアプリ本体（`AppType` の export まで）

ここまでの部品を HTTP に繋ぐ。**ハンドラの中に権限判定を書かない**のが合格条件。
ハンドラがやってよいのは次の 3 つだけ。

1. URL / ボディのパース（失敗は 404 か 422）
2. **どのリポジトリ関数を呼ぶかの選択**（`isAdminActor(viewer) ? asAdmin : asOwner`）
3. リポジトリが返した `null` / `false` を `notFound()` に変換する

**「この viewer はこの行を触ってよいか」を判定する `if` をハンドラに書いたら、それは Phase 4 の設計違反。**

**Files:**

- Create: `apps/api/src/lib/parse-id.ts`
- Create: `apps/api/src/lib/validate.ts`
- Create: `apps/api/src/routes/me.ts`
- Create: `apps/api/src/routes/shops.ts`
- Create: `apps/api/src/routes/reviews.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/routes.test.ts`

> **fixtures は触らない。** Task 4-0 の `createTestWorld` / `seedMasters` / `seedShop`、
> Task 4-6 の `createTestBindings` / `signUpAs`、Task 4-9 の `seedReview` で足りる。
> ここで DDL を書き足すと、Phase 3 のマイグレーションと二重管理になる。

**Interfaces:**

- Consumes:
  - `hono` の `Hono`、`hono/validator` の `validator`、`hono/http-exception` の `HTTPException`
  - グローバル型 `DurableObject` / `DurableObjectState`（`@cloudflare/workers-types`。**`cloudflare:workers` からは import しない**。理由は下の「確定事項」）
  - `@meshimap/core` の `ROLE_ADMIN` / `ROLE_OWNER` / `ROLE_USER` / `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` / `toReviewId` / `toShopId` / `toUserId` と型 `ReviewId` / `ShopId`
  - `zod` の型 `ZodType`
  - `drizzle-orm` の `eq`、`../db/schema` の `profiles`
  - `../auth/auth`（Task 4-5）の `AUTH_BASE_PATH` / `createAuth`
  - `../auth/actor`（Task 4-2）の `isAdminActor`
  - `../db/client`（**Phase 3**）の `createDatabase`
  - `../lib/app-env`（Task 4-1）の型 `AppBindings` / `AppEnv`
  - `../lib/http-error`（Task 4-1）の `ERROR_MESSAGE_INTERNAL` / `invalidInput` / `notFound`
  - `../middleware/auth`（Task 4-6）の `authMiddleware`
  - `../middleware/error-handler`（Task 4-4）の `errorHandler` / `notFoundHandler`
  - `../middleware/role-guard`（Task 4-7）の `roleGuard` / `requireActor` / `requireAdminActor` / `requireOwnerActor` / `requireUserActor`
  - `../repositories/shop-repository`（Task 4-8）の 6 関数、`../repositories/review-repository`（Task 4-9）の 4 関数
  - （テストのみ）`../test/fixtures` の `corruptProfileRole` / `createTestBindings` / `createTestWorld` / `readRow` / `seedMasters` / `seedReview` / `seedShop` / `signUpAs` / `TEST_AREA_ID` / `TEST_GENRE_ID` と型 `TestUser` / `TestWorld`
- Produces:
  - `parseShopId(value: string): ShopId` / `parseReviewId(value: string): ReviewId`
  - `generateShopId(): ShopId` / `generateReviewId(): ReviewId`
  - `jsonBody<TSchema extends ZodType>(schema: TSchema)`
  - `meRoutes` / `shopRoutes` / `reviewRoutes`
  - `app` / `type AppType` / `class ReservationLock` / `export default app`

### 確定事項 1: `cloudflare:workers` を import してはいけない（裏取り済み）

`wrangler.jsonc` は `durable_objects.bindings[0].class_name = "ReservationLock"` と
`migrations[0].new_sqlite_classes = ["ReservationLock"]` を持つため、
`src/index.ts` は `ReservationLock` を export しなければ `wrangler dev` が起動しない。

素直に書くと `import { DurableObject } from 'cloudflare:workers'` になるが、**これは使えない**。
`routes.test.ts` は `../index` を import し、テストは Node（`environment: 'node'`）で走るので、
モジュール解決が次のように失敗する（実測済み）:

```
Error: Cannot find module 'cloudflare:workers'
  code: 'MODULE_NOT_FOUND'
```

`cloudflare:workers` は workerd の内蔵モジュールで、Node には存在しない。
Phase 4 のテストは **Hono アプリを Node で動かし、D1 だけを miniflare（workerd）に置く**構成なので、
アプリ本体が workerd 専用モジュールに触れた時点でテストが一切読み込めなくなる。

**採る方針:** 旧来（classic）形式の Durable Object クラスで書く。
`DurableObject` / `DurableObjectState` は `@cloudflare/workers-types` のグローバル型なので import 不要、
つまり実行時の依存がゼロになる。workerd 側が classic 形式と `useSQLite`（= `new_sqlite_classes`）の
組み合わせを受け付けることは miniflare 上で実測確認済み（DO の `fetch` が 501 を返すところまで到達した）。

### 確定事項 2: `AppType` と RPC 入力型（裏取り済み・回避不能）

Hono 4.13.7 の `validator` は、型引数を省略すると **RPC クライアント側の入力型が Zod の「出力型」**になる。
`node_modules/hono/dist/types/validator/validator.d.ts` の

```
in: { [K in Target]: unknown extends InputType ? ExtractValidatorOutput<VF> : InputType }
```

がその根拠で、`InputType` を推論させる経路が無いため常に `ExtractValidatorOutput<VF>`（= 出力型）になる。

**結果として起きること:** `reviewCreateSchema` の `budgetYen` は `.default(null)` なので
サーバは省略を受け付ける（実測: 省略しても 201）が、`hc<AppType>` の型は `budgetYen` を**必須**として要求する。

**型引数を部分指定して直そうとしてはいけない。** `validator<z.input<TSchema>, string, string, 'json'>(...)` と
書くと `VF` の推論が止まり、`ExtractValidatorOutput<VF>` が `any` に落ち、
`hc` の戻りが `unknown` 化して `$patch is not a member` のような無関係なエラーになる（実測済み）。

**採る方針:** 入力型 = 出力型のまま受け入れる。モバイル側（Phase 5 以降）は
`.default()` を持つフィールドも明示的に送る。ランタイムの許容範囲は Zod が広い側なので、
「型が要求するものを送れば必ず通る」という関係は保たれる。

- [ ] **Step 1: ID パーサを書く**

`apps/api/src/lib/parse-id.ts`:

```ts
import { toReviewId, toShopId } from '@meshimap/core';
import type { ReviewId, ShopId } from '@meshimap/core';
import { notFound } from './http-error';

/**
 * 形式が不正な ID は「存在しない ID」と同じ 404 にする。
 * 422 を返すと「形式は正しいが存在しない」との差から ID の書式が推測できてしまう。
 */
export function parseShopId(value: string): ShopId {
  try {
    return toShopId(value);
  } catch {
    // toShopId は RangeError を投げる（packages/core/src/identifier.ts）。握り潰して 404 に寄せる
    throw notFound();
  }
}

export function parseReviewId(value: string): ReviewId {
  try {
    return toReviewId(value);
  } catch {
    throw notFound();
  }
}

/**
 * ID はサーバで採番する。クライアントに決めさせると、既存 ID との衝突を試して
 * 存在有無を探れる（衝突時のエラーが情報になる）。
 * crypto.randomUUID はハイフンを含むが IDENTIFIER_PATTERN が許容する文字種。
 * 接頭辞 4 文字 + UUID 36 文字 = 40 文字で IDENTIFIER_MAX_LENGTH（64）に収まる。
 */
export function generateShopId(): ShopId {
  return toShopId(`shp_${crypto.randomUUID()}`);
}

export function generateReviewId(): ReviewId {
  return toReviewId(`rev_${crypto.randomUUID()}`);
}
```

- [ ] **Step 2: Zod バリデータを書く**

`apps/api/src/lib/validate.ts`:

```ts
import { validator } from 'hono/validator';
import type { ZodType } from 'zod';
import { invalidInput } from './http-error';

/**
 * JSON ボディを Zod で検証する Hono バリデータ。
 * `@hono/zod-validator` は未インストールなので `hono/validator` の上に自前で載せる。
 *
 * エラーの詳細（どのフィールドが不正か）は返さない。返すとスキーマの構造が漏れる。
 * ここで throw した HTTPException は app.onError が拾う（実測確認済み）。
 *
 * 型引数を省略しているのは意図的。部分指定すると VF の推論が止まり、
 * hc<AppType> の戻りが unknown 化する（詳細は本タスク冒頭の「確定事項 2」）。
 */
export function jsonBody<TSchema extends ZodType>(schema: TSchema) {
  return validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw invalidInput();
    }
    return parsed.data;
  });
}
```

- [ ] **Step 3: 失敗するテストを書く（前半: health / me / 一覧・単体取得）**

`apps/api/src/routes/routes.test.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REVIEW_STATUS_HIDDEN,
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import { app } from '../index';
import {
  createTestBindings,
  createTestWorld,
  readRow,
  seedMasters,
  seedReview,
  seedShop,
  signUpAs,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from '../test/fixtures';
import type { TestUser, TestWorld } from '../test/fixtures';

const BASE_URL = 'http://localhost:8787';

/**
 * shopCreateSchema を満たす最小のボディ。
 * genreId / areaId は **実在するマスタ**でなければ外部キー違反になる。
 * 架空の 'izakaya' などを書くと 201 のはずが 500 になる（本物の D1 で実測）。
 */
const NEW_SHOP_BODY = {
  name: '新規店',
  nameKana: 'シンキテン',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '104-0061',
  address: '東京都中央区銀座1-1-1',
  latitude: 35.6717,
  longitude: 139.765,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

function jsonRequest(path: string, method: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return new Request(`${BASE_URL}${path}`, { method, headers, body: JSON.stringify(body) });
}

describe('routes', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    // shops.genre_id / area_id は NOT NULL かつ外部キー。どのテストでも要る
    await seedMasters(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  /** cookie 無しで GET する。未認証（AnonymousActor）の経路 */
  async function getAnonymously(path: string): Promise<Response> {
    return await app.request(path, {}, createTestBindings(world));
  }

  /** cookie 付きで GET する */
  async function getAs(path: string, actor: TestUser): Promise<Response> {
    return await app.request(path, { headers: { cookie: actor.cookie } }, createTestBindings(world));
  }

  /** cookie 付きで DELETE する */
  async function deleteAs(path: string, actor: TestUser): Promise<Response> {
    return await app.request(
      path,
      { method: 'DELETE', headers: { cookie: actor.cookie } },
      createTestBindings(world),
    );
  }

  /** ボディ付きのメソッドは Request を組み立てて渡す（第 2 引数は undefined にする） */
  async function sendJson(request: Request): Promise<Response> {
    return await app.request(request, undefined, createTestBindings(world));
  }

  describe('GET /health', () => {
    it('認証なしで 200 と ok を返す', async () => {
      const res = await getAnonymously('/health');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /me', () => {
    it('未認証は 401', async () => {
      const res = await getAnonymously('/me');
      expect(res.status).toBe(401);
    });

    it('認証済みは自分のプロフィールを返す', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);

      const res = await getAs('/me', alice);

      expect(res.status).toBe(200);
      // signUpAs は name にメールアドレスをそのまま渡すため displayName もメールになる
      expect(await res.json()).toEqual({
        profile: { userId: alice.userId, role: ROLE_USER, displayName: 'alice@example.com' },
      });
    });
  });

  describe('GET /shops', () => {
    /** owner_id を持つ店舗を作るには user 行が要る。owner を先に作ってから店舗を撒く */
    async function seedThreeShops(owner: TestUser): Promise<void> {
      await seedShop(world, { id: 'shp_pub', ownerId: null, status: SHOP_STATUS_PUBLISHED });
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });
      await seedShop(world, {
        id: 'shp_mine_draft',
        ownerId: owner.userId,
        status: SHOP_STATUS_DRAFT,
      });
    }

    async function listedIds(res: Response): Promise<string[]> {
      const body = await res.json<{ shops: { id: string }[] }>();
      return body.shops.map((shop) => shop.id);
    }

    it('未認証には published だけを返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedThreeShops(owner);

      const res = await getAnonymously('/shops');

      expect(res.status).toBe(200);
      expect(await listedIds(res)).toEqual(['shp_pub']);
    });

    it('owner には published と「自分の」draft を返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedThreeShops(owner);

      const res = await getAs('/shops', owner);

      // created_at は seedShop の既定で全件 0。順序は保証されないのでソートして比べる
      expect((await listedIds(res)).sort()).toEqual(['shp_mine_draft', 'shp_pub']);
    });

    it('admin には status を問わず全件返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedThreeShops(owner);

      const res = await getAs('/shops', admin);

      expect((await listedIds(res)).sort()).toEqual(['shp_draft', 'shp_mine_draft', 'shp_pub']);
    });
  });

  describe('GET /shops/:shopId', () => {
    it('published は未認証でも 200', async () => {
      await seedShop(world, { id: 'shp_pub', ownerId: null, status: SHOP_STATUS_PUBLISHED });

      const res = await getAnonymously('/shops/shp_pub');

      expect(res.status).toBe(200);
    });

    it('他人の draft は 404', async () => {
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const res = await getAnonymously('/shops/shp_draft');

      expect(res.status).toBe(404);
    });

    it('存在しない ID と他人の draft で、本文まで完全に一致する', async () => {
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const hidden = await getAnonymously('/shops/shp_draft');
      const missing = await getAnonymously('/shops/shp_zzz');

      // 状態コードだけ揃えても本文が違えば存在有無が漏れる。本文まで比べる
      expect(hidden.status).toBe(missing.status);
      expect(await hidden.text()).toBe(await missing.text());
    });

    it('ID の形式が不正でも 404（422 にしない）', async () => {
      // %E3%81%82 は「あ」。IDENTIFIER_PATTERN に一致しないので toShopId が RangeError を投げる
      const res = await getAnonymously('/shops/%E3%81%82');

      expect(res.status).toBe(404);
    });

    it('owner は自分の draft を 200 で取得できる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, {
        id: 'shp_mine_draft',
        ownerId: owner.userId,
        status: SHOP_STATUS_DRAFT,
      });

      const res = await getAs('/shops/shp_mine_draft', owner);

      expect(res.status).toBe(200);
    });
  });
```

- [ ] **Step 4: 失敗するテストを書く（後半: 書き込み系と 404 の形）**

同じファイルに続けて書く（`describe('routes', ...)` の中）:

```ts
  describe('POST /shops', () => {
    it('admin は 201 で作成でき、status は draft から始まる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(`/shops?ownerId=${owner.userId}`, 'POST', NEW_SHOP_BODY, admin.cookie),
      );

      expect(res.status).toBe(201);
      const body = await res.json<{ shop: { id: string; ownerId: string; status: string } }>();
      expect(body.shop.ownerId).toBe(owner.userId);
      expect(body.shop.status).toBe(SHOP_STATUS_DRAFT);
      // 応答だけでなく行が実際に増えたことを DB 側から確認する
      expect(await readRow(world, 'SELECT id FROM shops WHERE id = ?', body.shop.id)).toEqual({
        id: body.shop.id,
      });
    });

    it('ownerId が無いと 422', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(jsonRequest('/shops', 'POST', NEW_SHOP_BODY, admin.cookie));

      expect(res.status).toBe(422);
    });

    it('ボディがスキーマに合わないと 422', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(
          `/shops?ownerId=${owner.userId}`,
          'POST',
          { ...NEW_SHOP_BODY, latitude: 999 },
          admin.cookie,
        ),
      );

      expect(res.status).toBe(422);
    });

    it('422 の本文にフィールド名が含まれない', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(
          `/shops?ownerId=${owner.userId}`,
          'POST',
          { ...NEW_SHOP_BODY, latitude: 999 },
          admin.cookie,
        ),
      );

      // どの項目が弾かれたかを返すと、スキーマの形が総当たりで復元できてしまう
      expect(await res.text()).not.toMatch(/latitude/);
    });
  });

  describe('PATCH /shops/:shopId', () => {
    it('owner は自分の店舗を更新できる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest('/shops/shp_mine', 'PATCH', { name: '改名後' }, owner.cookie),
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ shop: { name: string } }>();
      expect(body.shop.name).toBe('改名後');
    });

    it('owner が他人の店舗を更新しようとすると 404', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_other', ownerId: null, name: '元の名前' });

      const res = await sendJson(
        jsonRequest('/shops/shp_other', 'PATCH', { name: '乗っ取り' }, owner.cookie),
      );

      // ロールは owner で合っているので 403 にはならない。行が一致しないので 404
      expect(res.status).toBe(404);
      expect(await readRow(world, 'SELECT name FROM shops WHERE id = ?', 'shp_other')).toEqual({
        name: '元の名前',
      });
    });

    it('空のボディは 422（shopUpdateSchema の refine）', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(jsonRequest('/shops/shp_mine', 'PATCH', {}, owner.cookie));

      expect(res.status).toBe(422);
    });

    it('緯度だけの指定は 422（geohash が壊れるため受け付けない）', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest('/shops/shp_mine', 'PATCH', { latitude: 34.7 }, owner.cookie),
      );

      expect(res.status).toBe(422);
    });

    it('緯度と経度を両方指定すれば 200 になり geohash も張り替わる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_mine',
          'PATCH',
          { latitude: 34.702485, longitude: 135.495951 },
          owner.cookie,
        ),
      );

      expect(res.status).toBe(200);
      // 大阪駅。precision 7 で xn0m7m3（本物の D1 で実測した値）
      expect(
        await readRow(world, 'SELECT geohash, lat, lng FROM shops WHERE id = ?', 'shp_mine'),
      ).toEqual({ geohash: 'xn0m7m3', lat: 34.702485, lng: 135.495951 });
    });

    it('admin は他人の店舗を更新できる', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_other', ownerId: null });

      const res = await sendJson(
        jsonRequest('/shops/shp_other', 'PATCH', { name: '管理者改名' }, admin.cookie),
      );

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /shops/:shopId', () => {
    it('admin は 204 で削除でき、本文は空', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_x', ownerId: null });

      const res = await deleteAs('/shops/shp_x', admin);

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(await readRow(world, 'SELECT id FROM shops WHERE id = ?', 'shp_x')).toBeNull();
    });

    it('存在しない ID は 404', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await deleteAs('/shops/shp_zzz', admin);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /shops/:shopId/reviews', () => {
    async function seedTwoReviews(): Promise<void> {
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      // uq_reviews_shop_user があるので、同じ店舗には別々の利用者で入れる
      await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      const carol = await signUpAs(world, 'carol@example.com', ROLE_USER);
      await seedReview(world, { id: 'rev_open', shopId: 'shp_pub', userId: bob.userId });
      await seedReview(world, {
        id: 'rev_hidden',
        shopId: 'shp_pub',
        userId: carol.userId,
        status: REVIEW_STATUS_HIDDEN,
      });
    }

    async function listedReviewIds(res: Response): Promise<string[]> {
      const body = await res.json<{ reviews: { id: string }[] }>();
      return body.reviews.map((review) => review.id);
    }

    it('published なレビューだけを未認証にも返す', async () => {
      await seedTwoReviews();

      const res = await getAnonymously('/shops/shp_pub/reviews');

      expect(res.status).toBe(200);
      expect(await listedReviewIds(res)).toEqual(['rev_open']);
    });

    it('admin には hidden なレビューも返す', async () => {
      await seedTwoReviews();
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await getAs('/shops/shp_pub/reviews', admin);

      expect((await listedReviewIds(res)).sort()).toEqual(['rev_hidden', 'rev_open']);
    });
  });

  describe('POST /shops/:shopId/reviews', () => {
    it('user は 201 で投稿でき、userId は自分になる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          {
            shopId: 'shp_pub',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: 3200,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(201);
      const body = await res.json<{ review: { userId: string; shopId: string } }>();
      // ボディに userId を書かせない。書かせると他人になりすませる
      expect(body.review.userId).toBe(alice.userId);
      expect(body.review.shopId).toBe('shp_pub');
    });

    it('URL とボディの shopId が食い違うと 422', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedShop(world, { id: 'shp_other', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          {
            shopId: 'shp_other',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: null,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(422);
    });

    it('見えない店舗へは投稿できない（404）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_draft/reviews',
          'POST',
          {
            shopId: 'shp_draft',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: null,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(404);
      // 404 を返しただけでなく、行が作られていないことを確かめる
      expect(
        await readRow(world, 'SELECT id FROM reviews WHERE shop_id = ?', 'shp_draft'),
      ).toBeNull();
    });

    it('budgetYen を省略しても 201（Zod の default が効く）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          { shopId: 'shp_pub', rating: 4, body: 'ふつう', visitedOn: '2026-09-10' },
          alice.cookie,
        ),
      );

      // RPC の型は budgetYen を必須として要求するが、ランタイムは省略を受け付ける。
      // この差は Hono 4.13.7 の validator の仕様（本タスク冒頭の「確定事項 2」）
      expect(res.status).toBe(201);
      const body = await res.json<{ review: { budget: number | null } }>();
      expect(body.review.budget).toBeNull();
    });
  });

  describe('DELETE /reviews/:reviewId', () => {
    it('投稿者本人は 204 で削除できる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_1', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_1', alice);

      expect(res.status).toBe(204);
      expect(await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_1')).toBeNull();
    });

    it('admin は他人のレビューを 204 で削除できる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_1', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_1', admin);

      expect(res.status).toBe(204);
    });

    it('他人のレビューは user には消せず、404 で行も残る', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_alice', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_alice', bob);

      // 403 にすると「その ID のレビューは存在する」が漏れる。404 に寄せる
      expect(res.status).toBe(404);
      expect(await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_alice')).toEqual({
        id: 'rev_alice',
      });
    });
  });

  describe('未定義の経路', () => {
    it('未定義のパスは 404 を同じ形の JSON で返す', async () => {
      const res = await getAnonymously('/no-such-path');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { status: 404, message: '対象が見つかりません' } });
    });

    it('定義済みパスの未定義メソッドも同じ 404 になる', async () => {
      const res = await app.request(
        '/shops/shp_x',
        { method: 'PUT' },
        createTestBindings(world),
      );

      // 405 を返すと「そのパスは存在する」が分かる。404 に寄せる
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { status: 404, message: '対象が見つかりません' } });
    });
  });

  describe('Better Auth のハンドラ', () => {
    it('/api/auth/* が Hono の 404 にも authMiddleware にも飲み込まれない', async () => {
      const res = await sendJson(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({
            email: 'new@example.com',
            password: 'password1234',
            name: 'new',
          }),
        }),
      );

      expect(res.status).toBe(200);
    });

    it('ロールが壊れた利用者でも /api/auth/* に到達できる（サインアウト経路を塞がない）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      // authMiddleware は invalid-role を 403 にする。Better Auth のハンドラが
      // authMiddleware より **先** に登録されていないと、壊れた利用者は
      // サインアウトすらできず自力で復帰できなくなる
      await corruptProfileRole(world, alice.userId, 'superuser');

      const res = await getAs('/api/auth/get-session', alice);

      expect(res.status).toBe(200);
    });
  });
});
```

> **このテストが無いと Step 11 の破壊検証 (1) が成立しない。** サインアップは Cookie を
> 持たないリクエストなので、`authMiddleware` を Better Auth ハンドラより前に置いても
> ミドルウェアが匿名として素通りさせてしまい、上の 1 件は 200 のまま通ってしまう。
> **Cookie を持ち、かつロールが壊れている**利用者を通して初めて順序の逆転が 403 として現れる。

- [ ] **Step 5: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/api -- routes
```

期待: `Cannot find module '../index' imported from .../apps/api/src/routes/routes.test.ts` で失敗する。**このメッセージを目で見ること。**

- [ ] **Step 6: `/me` ルートを書く**

`apps/api/src/routes/me.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createDatabase } from '../db/client';
import { profiles } from '../db/schema';
import type { AppEnv } from '../lib/app-env';
import { ERROR_MESSAGE_INTERNAL } from '../lib/http-error';
import { requireActor } from '../middleware/role-guard';

export const meRoutes = new Hono<AppEnv>().get('/', async (c) => {
  // ロールを問わず「ログインしていること」だけを要求する。未認証は 401
  const actor = requireActor(c);
  const db = createDatabase(c.env.DB);
  const rows = await db
    .select({ userId: profiles.userId, role: profiles.role, displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.userId, actor.userId))
    .limit(1);

  const profile = rows[0];
  if (profile === undefined) {
    // authMiddleware が Actor を作れた以上プロフィールは必ずある。無いのは DB の不整合なので 500
    throw new HTTPException(500, { message: ERROR_MESSAGE_INTERNAL });
  }
  return c.json({ profile });
});
```

- [ ] **Step 7: `/shops` ルートを書く**

`apps/api/src/routes/shops.ts`:

```ts
import {
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  reviewCreateSchema,
  shopCreateSchema,
  shopUpdateSchema,
  toUserId,
} from '@meshimap/core';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { isAdminActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { invalidInput, notFound } from '../lib/http-error';
import { generateReviewId, generateShopId, parseShopId } from '../lib/parse-id';
import { jsonBody } from '../lib/validate';
import {
  requireAdminActor,
  requireOwnerActor,
  requireUserActor,
  roleGuard,
} from '../middleware/role-guard';
import { createReviewAsUser, listVisibleReviews } from '../repositories/review-repository';
import {
  createShopAsAdmin,
  deleteShopAsAdmin,
  findVisibleShop,
  listVisibleShops,
  updateShopAsAdmin,
  updateShopAsOwner,
} from '../repositories/shop-repository';

/**
 * 店舗の所有者。shopCreateSchema には ownerId が無く、packages/core は Phase 4 で編集できないため、
 * クエリパラメータとして受ける。toUserId を通すので不正な形式は 422 になる。
 */
function ownerIdQuery() {
  return validator('query', (value) => {
    const raw = value['ownerId'];
    if (typeof raw !== 'string') {
      throw invalidInput();
    }
    try {
      return { ownerId: toUserId(raw) };
    } catch {
      throw invalidInput();
    }
  });
}

export const shopRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = createDatabase(c.env.DB);
    // viewer をそのまま渡す。誰に何が見えるかはリポジトリの WHERE 句が決める
    const shops = await listVisibleShops(db, c.get('viewer'));
    return c.json({ shops });
  })
  .post('/', roleGuard(ROLE_ADMIN), ownerIdQuery(), jsonBody(shopCreateSchema), async (c) => {
    const actor = requireAdminActor(c);
    const db = createDatabase(c.env.DB);
    const input = c.req.valid('json');
    const { ownerId } = c.req.valid('query');
    const shop = await createShopAsAdmin(db, actor, input, ownerId, generateShopId(), new Date());
    return c.json({ shop }, 201);
  })
  .get('/:shopId', async (c) => {
    const db = createDatabase(c.env.DB);
    const shop = await findVisibleShop(db, c.get('viewer'), parseShopId(c.req.param('shopId')));
    if (shop === null) {
      // 「見えない」も「存在しない」も同じ 404。区別する情報をここは持っていない
      throw notFound();
    }
    return c.json({ shop });
  })
  .patch('/:shopId', roleGuard(ROLE_OWNER, ROLE_ADMIN), jsonBody(shopUpdateSchema), async (c) => {
    const db = createDatabase(c.env.DB);
    const shopId = parseShopId(c.req.param('shopId'));
    const input = c.req.valid('json');
    // 緯度と経度は必ず対で受け取る。片方だけ更新すると geohash が実座標とずれる
    if ((input.latitude === undefined) !== (input.longitude === undefined)) {
      throw invalidInput();
    }
    const viewer = c.get('viewer');
    // ロールで「どちらの関数を呼ぶか」を選ぶだけ。権限判定そのものは各関数の WHERE 句が行う
    const shop = isAdminActor(viewer)
      ? await updateShopAsAdmin(db, requireAdminActor(c), shopId, input, new Date())
      : await updateShopAsOwner(db, requireOwnerActor(c), shopId, input, new Date());
    if (shop === null) {
      throw notFound();
    }
    return c.json({ shop });
  })
  .delete('/:shopId', roleGuard(ROLE_ADMIN), async (c) => {
    const db = createDatabase(c.env.DB);
    const isDeleted = await deleteShopAsAdmin(
      db,
      requireAdminActor(c),
      parseShopId(c.req.param('shopId')),
    );
    if (!isDeleted) {
      throw notFound();
    }
    return c.body(null, 204);
  })
  .get('/:shopId/reviews', async (c) => {
    const db = createDatabase(c.env.DB);
    const reviews = await listVisibleReviews(
      db,
      c.get('viewer'),
      parseShopId(c.req.param('shopId')),
    );
    return c.json({ reviews });
  })
  .post('/:shopId/reviews', roleGuard(ROLE_USER), jsonBody(reviewCreateSchema), async (c) => {
    const actor = requireUserActor(c);
    const db = createDatabase(c.env.DB);
    const shopId = parseShopId(c.req.param('shopId'));
    const input = c.req.valid('json');
    // URL とボディで店舗が食い違うリクエストは通さない
    if (input.shopId !== shopId) {
      throw invalidInput();
    }
    // 見えない店舗へレビューを差し込めないよう、投稿前に可視性を確認する
    const shop = await findVisibleShop(db, actor, shopId);
    if (shop === null) {
      throw notFound();
    }
    const review = await createReviewAsUser(
      db,
      actor,
      shopId,
      generateReviewId(),
      input,
      new Date(),
    );
    return c.json({ review }, 201);
  });
```

- [ ] **Step 8: `/reviews` ルートを書く**

`apps/api/src/routes/reviews.ts`:

```ts
import { ROLE_ADMIN, ROLE_USER } from '@meshimap/core';
import { Hono } from 'hono';
import { isAdminActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { notFound } from '../lib/http-error';
import { parseReviewId } from '../lib/parse-id';
import { requireAdminActor, requireUserActor, roleGuard } from '../middleware/role-guard';
import { deleteReviewAsAdmin, deleteReviewAsAuthor } from '../repositories/review-repository';

export const reviewRoutes = new Hono<AppEnv>().delete(
  '/:reviewId',
  // owner はレビューを消せない。ロールだけで決まるのでここは 403 でよい
  roleGuard(ROLE_USER, ROLE_ADMIN),
  async (c) => {
    const db = createDatabase(c.env.DB);
    const reviewId = parseReviewId(c.req.param('reviewId'));
    const viewer = c.get('viewer');
    const isDeleted = isAdminActor(viewer)
      ? await deleteReviewAsAdmin(db, requireAdminActor(c), reviewId)
      : await deleteReviewAsAuthor(db, requireUserActor(c), reviewId);
    if (!isDeleted) {
      // 他人のレビューも存在しないレビューも同じ 404
      throw notFound();
    }
    return c.body(null, 204);
  },
);
```

- [ ] **Step 9: エントリポイントを書く**

`apps/api/src/index.ts`:

```ts
import { Hono } from 'hono';
import { AUTH_BASE_PATH, createAuth } from './auth/auth';
import { createDatabase } from './db/client';
import type { AppBindings, AppEnv } from './lib/app-env';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { meRoutes } from './routes/me';
import { reviewRoutes } from './routes/reviews';
import { shopRoutes } from './routes/shops';

/**
 * ルートの登録順には意味がある。
 * 1. onError / notFound を先に付ける（以降のどこで投げても同じ形の JSON になる）
 * 2. Better Auth のハンドラ（authMiddleware より前。セッション発行自体は未認証で行う）
 * 3. authMiddleware（以降すべてのハンドラで c.get('viewer') が使える）
 * 4. 各ルートグループ
 *
 * メソッドチェーンを途中で変数に切らないこと。切ると型が積み上がらず AppType が痩せる。
 */
export const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .notFound(notFoundHandler)
  .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => {
    const auth = createAuth(createDatabase(c.env.DB), c.env);
    return auth.handler(c.req.raw);
  })
  .use('*', authMiddleware)
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/me', meRoutes)
  .route('/shops', shopRoutes)
  .route('/reviews', reviewRoutes);

/** モバイル側が `hc<AppType>` で使う型。ここを export しないと RPC の型が付かない */
export type AppType = typeof app;

/**
 * Phase 7（予約）で実装する。
 * wrangler.jsonc の durable_objects バインディング（RESERVATION_LOCK → ReservationLock）と
 * migrations[0].new_sqlite_classes がこのクラスの export を要求するため、空の実体を先に置く。
 * 置かないと `wrangler dev` が「Class ReservationLock not found」で起動しない。
 *
 * `cloudflare:workers` の DurableObject 基底クラスを継承しない。
 * 継承すると index.ts が workerd 専用モジュールに依存し、Node で走る routes.test.ts が
 * `Cannot find module 'cloudflare:workers'` で読み込めなくなる（実測済み）。
 * 旧来形式（コンストラクタで state と env を受ける普通のクラス）でも
 * new_sqlite_classes と組み合わせて動くことは miniflare 上で確認済み。
 * DurableObject / DurableObjectState は @cloudflare/workers-types のグローバル型なので import は要らない。
 */
export class ReservationLock implements DurableObject {
  // Phase 7 で state.storage.sql を使う。今は受け取るだけで保持しない
  constructor(_state: DurableObjectState, _env: AppBindings) {}

  // await するものが無いので async にしない（@typescript-eslint/require-await）。
  // DurableObject#fetch の戻りは Response | Promise<Response> なので同期で返してよい
  fetch(_request: Request): Response {
    return new Response('Not Implemented', { status: 501 });
  }
}

// Workers のモジュールワーカーは default export を要求する。
// CODING_GUIDELINES 2 章のデフォルトエクスポート禁止に対する、プラットフォーム上の唯一の例外。
// eslint-disable-next-line no-restricted-syntax -- Workers ランタイムが default export を必須とするため
export default app;
```

- [ ] **Step 10: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- routes
npm run typecheck -w @meshimap/api
```

期待: テスト 36 件すべて PASS。`typecheck` はエラー 0。

> **時間がかかる。** `signUpAs` は scrypt でハッシュを作るため 1 回 100ms 前後、
> `createTestWorld` は miniflare を 1 つ起動する。36 件で数十秒かかるが、
> `vitest.config.ts` の `testTimeout: 30_000` / `hookTimeout: 60_000` の範囲に収まる。
> 遅いからといって world を describe 間で共有しないこと（Task 4-0 Step 6 で
> 共有が何を壊すか確認済み）。

- [ ] **Step 11: 意図的にコードを壊してテストが検知することを確認する**

`index.ts` のミドルウェア順を入れ替え、`authMiddleware` を Better Auth ハンドラより前に置く:

```ts
  .use('*', authMiddleware)
  .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => { ... })
```

期待: `ロールが壊れた利用者でも /api/auth/* に到達できる（サインアウト経路を塞がない）` が
200 ではなく **403** で FAIL する。

> **落ちるのはこの 1 件だけ**で、`/api/auth/* が Hono の 404 にも authMiddleware にも飲み込まれない`
> は **PASS したままになる**。サインアップは Cookie 無しのリクエストで、`authMiddleware` は
> セッションが無ければ匿名として素通りさせるため、順序を入れ替えても結果が変わらない。
> 「Cookie があり、かつ Actor の生成に失敗する」利用者を通さないと順序の逆転は観測できない。

確認後に元へ戻す。

次に `.notFound(notFoundHandler)` の行を削除する。
期待: `未定義のパスは 404 を同じ形の JSON で返す` と
`定義済みパスの未定義メソッドも同じ 404 になる` が FAIL（Hono 既定の `404 Not Found` テキストになる）。確認後に元へ戻す。

次に `shops.ts` の PATCH から緯度経度の対チェックを削除する。
期待: `緯度だけの指定は 422（geohash が壊れるため受け付けない）` が FAIL。確認後に元へ戻す。

次に `shops.ts` の POST reviews から `if (input.shopId !== shopId)` を削除する。
期待: `URL とボディの shopId が食い違うと 422` が FAIL。確認後に元へ戻す。

次に `shops.ts` の POST reviews から `findVisibleShop` の確認を削除する。
期待: `見えない店舗へは投稿できない（404）` が FAIL。**ここが通ると、非公開店舗の存在が投稿の成否から漏れる。** 確認後に元へ戻す。

次に `shops.ts` の PATCH で、owner の側だけ `updateShopAsOwner` を `updateShopAsAdmin` に差し替える:

```ts
const shop = isAdminActor(viewer)
  ? await updateShopAsAdmin(db, requireAdminActor(c), shopId, input, new Date())
  : // わざと壊す: owner なのに admin 版（所有者を見ない WHERE）を呼ぶ。
    // 第 2 引数の型が合わなくなるので、一時的に requireAdminActor(c) を両方に使う
    await updateShopAsAdmin(db, requireAdminActor(c), shopId, input, new Date());
```

期待: `owner が他人の店舗を更新しようとすると 404` が FAIL する。
`requireAdminActor` が owner に 403 を返すため 404 ではなく 403 になり、
`shp_other` の name が `元の名前` のままであることまでは守られる。
**「ブランド型 Actor が無ければ admin 用のリポジトリ関数を呼べない」ことの実演**でもある。
確認後に元へ戻す。

次に `reviews.ts` の `deleteReviewAsAuthor` を `deleteReviewAsAdmin` に差し替える。
期待: `他人のレビューは user には消せず、404 で行も残る` が FAIL（204 になり行が消える）。確認後に元へ戻す。

次に `parse-id.ts` の `parseShopId` の `catch` を `throw invalidInput()` に変える。
期待: `ID の形式が不正でも 404（422 にしない）` が FAIL。確認後に元へ戻す。

次に `validate.ts` の `throw invalidInput()` を `return value` に変える（検証を素通りさせる）。
期待: `ボディがスキーマに合わないと 422` と `空のボディは 422（shopUpdateSchema の refine）` が FAIL。確認後に元へ戻す。

最後に `index.ts` の `ReservationLock` を
`import { DurableObject } from 'cloudflare:workers';` を使う形へ書き換える。
期待: `routes.test.ts` が 1 件も実行されず `Cannot find module 'cloudflare:workers'` で落ちる。
**この失敗を目で見ること。** 見ておかないと、後から誰かが基底クラスへ戻したときに
原因が分からなくなる。確認後に元へ戻す。

- [ ] **Step 12: コミット**

```bash
git add apps/api/src/lib/parse-id.ts apps/api/src/lib/validate.ts apps/api/src/routes/ apps/api/src/index.ts
git commit -m "feat(api): ルートとアプリ本体を追加し AppType を export する"
```

---

## Task 4-12: ロール × エンドポイントの網羅権限テスト

設計書 12 章の「**権限の抜けがないことを証明できる**」の 3 本目。
**13 エンドポイント × 4 閲覧者 = 52 通りを 1 件も飛ばさずに検証する。**

**Files:**

- Test: `apps/api/src/routes/permission-matrix.test.ts`

> **ここでも fixtures は触らない。** Task 4-0 の `createTestWorld` / `seedMasters` / `seedUser` /
> `seedShop`、Task 4-6 の `createTestBindings` / `signUpAs`、Task 4-9 の `seedReview` で足りる。

**Interfaces:**

- Consumes:
  - `../index` の `app`
  - `../test/fixtures` の `createTestBindings` / `createTestWorld` / `seedMasters` / `seedReview` / `seedShop` / `seedUser` / `signUpAs` / `TEST_AREA_ID` / `TEST_GENRE_ID`、型 `TestWorld`
  - `@meshimap/core` の `ROLE_ADMIN` / `ROLE_OWNER` / `ROLE_USER`、型 `Role`
  - `../db/constants` の `SHOP_STATUS_DRAFT` / `SHOP_STATUS_PUBLISHED`
- Produces: なし（テストのみ）

### 検証する 52 通り

`匿名` は Cookie なし。数値は期待する HTTP ステータス。**計画書冒頭の権限マトリクスと同じ表を、テストのデータとしてそのまま持つ。**

| #   | メソッド | パス                     | 状況                   | 匿名 | user | owner | admin |
| --- | -------- | ------------------------ | ---------------------- | ---- | ---- | ----- | ----- |
| 1   | GET      | `/health`                | —                      | 200  | 200  | 200   | 200   |
| 2   | GET      | `/me`                    | —                      | 401  | 200  | 200   | 200   |
| 3   | GET      | `/shops`                 | —                      | 200  | 200  | 200   | 200   |
| 4   | GET      | `/shops/:shopId`         | published              | 200  | 200  | 200   | 200   |
| 5   | GET      | `/shops/:shopId`         | 他人の draft           | 404  | 404  | 404   | 200   |
| 6   | POST     | `/shops`                 | —                      | 401  | 403  | 403   | 201   |
| 7   | PATCH    | `/shops/:shopId`         | owner 視点で自分の店舗 | 401  | 403  | 200   | 200   |
| 8   | PATCH    | `/shops/:shopId`         | 他人の店舗             | 401  | 403  | 404   | 200   |
| 9   | DELETE   | `/shops/:shopId`         | —                      | 401  | 403  | 403   | 204   |
| 10  | GET      | `/shops/:shopId/reviews` | published 店舗         | 200  | 200  | 200   | 200   |
| 11  | POST     | `/shops/:shopId/reviews` | published 店舗         | 401  | 201  | 403   | 403   |
| 12  | DELETE   | `/reviews/:reviewId`     | user 視点で自分の投稿  | 401  | 204  | 403   | 204   |
| 13  | DELETE   | `/reviews/:reviewId`     | 他人の投稿             | 401  | 404  | 403   | 204   |

**「自分の」の意味:** 閲覧者が owner のとき `shp_mine` の所有者は**その owner 自身**、それ以外のロールのときは別ユーザー。閲覧者が user のとき `rev_mine` の投稿者は**その user 自身**、それ以外のロールのときは別ユーザー。こうすることで「owner の 200」と「admin の 200」が別の理由で通っていることを 1 つの表で表せる。

### 本物の D1 を使うことで決まった 3 つの制約（裏取り済み）

フェイク D1 なら無視できたが、Phase 3 の miniflare 製 D1 は**外部キーと UNIQUE 制約を本当に効かせる**。

1. **第三者も `user` 行として作る。**
   `shops.owner_id` と `reviews.user_id` は `user.id` への外部キー。`'usr_other_owner'` のような
   架空の ID をそのまま入れると `FOREIGN KEY constraint failed` で `seedShop` が落ちる。
   `signUpAs` は scrypt で 100ms 前後かかるので、**セッションが要らない第三者は `seedUser` で作る**
   （`seedUser` は user + profiles を直接 INSERT するだけ）。

2. **`shp_mine` に付ける 2 件のレビューは、別々の投稿者にする。**
   `uq_reviews_shop_user` があるため、同じ (shop, user) の組を 2 回入れると落ちる。
   `rev_mine` の投稿者は「閲覧者が user ならその user、それ以外なら `OTHER_AUTHOR_ID`」、
   `rev_other` の投稿者は**常に第三の利用者 `SECOND_AUTHOR_ID`** にする。
   こうすれば閲覧者のロールに関わらず 2 件の投稿者が必ず食い違う。

3. **#11 の投稿先は、レビューが 1 件も無い専用の店舗にする。**
   閲覧者が user のとき `rev_mine` の投稿者は閲覧者自身なので、同じ `shp_mine` へ POST すると
   `uq_reviews_shop_user` に当たる。実測では **500**（`Failed query: insert into "reviews" …` を
   error-handler が握り潰した結果）が返り、期待の 201 と食い違った。
   そのため published で無レビューの `shp_reviewable` を用意し、#11 はそこへ投稿する。

`genres` / `areas` も `shops` からの外部キー（`ON DELETE restrict`）なので、
`beforeEach` で必ず `seedMasters` を呼ぶ。

### なぜケースごとに DB を作り直すのか

PATCH / DELETE / POST は DB を書き換える。52 ケースを 1 つの DB で回すと、実行順によって結果が変わる。
`beforeEach` で毎回 miniflare の D1 を起こし直し、**必要な閲覧者 1 人だけ**をサインアップする。
（3 ロール全員を毎回作ると scrypt のハッシュ計算が 3 倍かかる。閲覧者は 1 ケースに 1 人しか要らない。）

D1 の起動は実測 280ms 前後。52 ケース + 6 件で**全体 30 秒前後**かかるが、
「権限の抜けが無いことを本物の SQLite で証明する」ための代金として払う。

- [ ] **Step 1: マトリクスのデータを書く**

`apps/api/src/routes/permission-matrix.test.ts` の前半:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import type { Role } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_STATUS_DRAFT, SHOP_STATUS_PUBLISHED } from '../db/constants';
import { app } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  createTestBindings,
  createTestWorld,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  signUpAs,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from '../test/fixtures';

/**
 * 閲覧者の種類。'anonymous' は Cookie を送らない＝未認証。
 * Role をそのまま使うので、@meshimap/core にロールが増えたらここがコンパイルエラーになり、
 * マトリクスの更新漏れに気付ける。
 */
type ViewerKind = 'anonymous' | Role;

const VIEWER_KINDS: readonly ViewerKind[] = ['anonymous', ROLE_USER, ROLE_OWNER, ROLE_ADMIN];

const BASE_URL = 'http://localhost:8787';

/**
 * 閲覧者以外の第三者。所有者・投稿者としてシードに使う。
 * user テーブルへの外部キーがあるので、**3 人とも本当に user 行を作る**。
 */
const OTHER_OWNER_ID = 'usr_other_owner';
const OTHER_AUTHOR_ID = 'usr_other_author';
/** rev_other の投稿者。uq_reviews_shop_user を避けるため rev_mine とは必ず別人にする */
const SECOND_AUTHOR_ID = 'usr_second_author';

const SHOP_MINE_ID = 'shp_mine';
const SHOP_OTHER_DRAFT_ID = 'shp_other_draft';
/** #11 の投稿先。レビューを 1 件も持たせない（同じ利用者の二重投稿を避けるため） */
const SHOP_REVIEWABLE_ID = 'shp_reviewable';
const REVIEW_MINE_ID = 'rev_mine';
const REVIEW_OTHER_ID = 'rev_other';

/** shopCreateSchema を満たす最小のボディ。genre / area は seedMasters が入れた実在の ID */
const NEW_SHOP_BODY = {
  name: '新規店',
  nameKana: 'シンキテン',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '104-0061',
  address: '東京都中央区銀座1-1-1',
  latitude: 35.6717,
  longitude: 139.765,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

const NEW_REVIEW_BODY = {
  shopId: SHOP_REVIEWABLE_ID,
  rating: 5,
  body: 'とても良かった',
  visitedOn: '2026-09-10',
  budgetYen: 3200,
};

type EndpointCase = {
  readonly no: number;
  readonly label: string;
  readonly method: string;
  readonly path: string;
  /**
   * Hono に登録されるルートパターン（`app.routes` の `method` + `path` と同じ形）。
   * Task 4-14 でここと `app.routes` を突き合わせ、**表に無いエンドポイント**を機械的に検出する。
   */
  readonly routePattern: string;
  readonly body?: unknown;
  /** 閲覧者ごとの期待ステータス */
  readonly expected: Readonly<Record<ViewerKind, number>>;
};

/**
 * 計画書冒頭の権限マトリクスをそのままデータにしたもの。
 * 表を更新したらここも更新する。ここに無いエンドポイントは Task 4-14 の突き合わせで検出する。
 */
const ENDPOINT_CASES: readonly EndpointCase[] = [
  {
    no: 1,
    label: 'GET /health',
    method: 'GET',
    path: '/health',
    routePattern: 'GET /health',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 2,
    label: 'GET /me',
    method: 'GET',
    path: '/me',
    routePattern: 'GET /me',
    expected: { anonymous: 401, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 3,
    label: 'GET /shops',
    method: 'GET',
    path: '/shops',
    routePattern: 'GET /shops',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 4,
    label: 'GET /shops/:shopId（published）',
    method: 'GET',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'GET /shops/:shopId',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 5,
    label: 'GET /shops/:shopId（他人の draft）',
    method: 'GET',
    path: `/shops/${SHOP_OTHER_DRAFT_ID}`,
    routePattern: 'GET /shops/:shopId',
    expected: { anonymous: 404, user: 404, owner: 404, admin: 200 },
  },
  {
    no: 6,
    label: 'POST /shops',
    method: 'POST',
    path: `/shops?ownerId=${OTHER_OWNER_ID}`,
    routePattern: 'POST /shops',
    body: NEW_SHOP_BODY,
    expected: { anonymous: 401, user: 403, owner: 403, admin: 201 },
  },
  {
    no: 7,
    label: 'PATCH /shops/:shopId（owner から見て自分の店舗）',
    method: 'PATCH',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'PATCH /shops/:shopId',
    body: { name: '改名後' },
    expected: { anonymous: 401, user: 403, owner: 200, admin: 200 },
  },
  {
    no: 8,
    label: 'PATCH /shops/:shopId（他人の店舗）',
    method: 'PATCH',
    path: `/shops/${SHOP_OTHER_DRAFT_ID}`,
    routePattern: 'PATCH /shops/:shopId',
    body: { name: '乗っ取り' },
    expected: { anonymous: 401, user: 403, owner: 404, admin: 200 },
  },
  {
    no: 9,
    label: 'DELETE /shops/:shopId',
    method: 'DELETE',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'DELETE /shops/:shopId',
    expected: { anonymous: 401, user: 403, owner: 403, admin: 204 },
  },
  {
    no: 10,
    label: 'GET /shops/:shopId/reviews',
    method: 'GET',
    path: `/shops/${SHOP_MINE_ID}/reviews`,
    routePattern: 'GET /shops/:shopId/reviews',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 11,
    label: 'POST /shops/:shopId/reviews',
    method: 'POST',
    path: `/shops/${SHOP_REVIEWABLE_ID}/reviews`,
    routePattern: 'POST /shops/:shopId/reviews',
    body: NEW_REVIEW_BODY,
    expected: { anonymous: 401, user: 201, owner: 403, admin: 403 },
  },
  {
    no: 12,
    label: 'DELETE /reviews/:reviewId（user から見て自分の投稿）',
    method: 'DELETE',
    path: `/reviews/${REVIEW_MINE_ID}`,
    routePattern: 'DELETE /reviews/:reviewId',
    expected: { anonymous: 401, user: 204, owner: 403, admin: 204 },
  },
  {
    no: 13,
    label: 'DELETE /reviews/:reviewId（他人の投稿）',
    method: 'DELETE',
    path: `/reviews/${REVIEW_OTHER_ID}`,
    routePattern: 'DELETE /reviews/:reviewId',
    expected: { anonymous: 401, user: 404, owner: 403, admin: 204 },
  },
];
```

- [ ] **Step 2: 世界のセットアップを書く**

同じファイルの続き:

```ts
type Viewer = { readonly kind: ViewerKind; readonly cookie: string | null };

/**
 * 閲覧者を 1 人だけ用意し、その閲覧者から見た世界をシードする。
 *
 * - `shp_mine`: 閲覧者が owner ならその owner の店舗。それ以外なら第三者の店舗（どちらも published）
 * - `shp_other_draft`: 常に第三者の draft
 * - `shp_reviewable`: 常に第三者の published。レビューを付けない（#11 の投稿先）
 * - `rev_mine`: 閲覧者が user ならその user の投稿。それ以外なら `OTHER_AUTHOR_ID` の投稿
 * - `rev_other`: 常に `SECOND_AUTHOR_ID` の投稿
 *
 * `rev_other` を第三の利用者にしているのは、閲覧者が user 以外のとき
 * `rev_mine` と投稿者が一致して `uq_reviews_shop_user` に当たるのを避けるため。
 */
async function setUpWorld(world: TestWorld, kind: ViewerKind): Promise<Viewer> {
  await seedMasters(world);
  // 外部キー（shops.owner_id / reviews.user_id → user.id）を満たすため、第三者も本当に作る。
  // セッションが要らないので scrypt を通さない seedUser を使う
  await seedUser(world, { userId: OTHER_OWNER_ID, role: ROLE_OWNER });
  await seedUser(world, { userId: OTHER_AUTHOR_ID, role: ROLE_USER });
  await seedUser(world, { userId: SECOND_AUTHOR_ID, role: ROLE_USER });

  let cookie: string | null = null;
  let ownerId = OTHER_OWNER_ID;
  let authorId = OTHER_AUTHOR_ID;

  if (kind !== 'anonymous') {
    const signedUp = await signUpAs(world, `${kind}@example.com`, kind);
    cookie = signedUp.cookie;
    if (kind === ROLE_OWNER) {
      ownerId = signedUp.userId;
    }
    if (kind === ROLE_USER) {
      authorId = signedUp.userId;
    }
  }

  await seedShop(world, { id: SHOP_MINE_ID, ownerId, status: SHOP_STATUS_PUBLISHED });
  await seedShop(world, {
    id: SHOP_OTHER_DRAFT_ID,
    ownerId: OTHER_OWNER_ID,
    status: SHOP_STATUS_DRAFT,
  });
  await seedShop(world, {
    id: SHOP_REVIEWABLE_ID,
    ownerId: OTHER_OWNER_ID,
    status: SHOP_STATUS_PUBLISHED,
  });
  await seedReview(world, { id: REVIEW_MINE_ID, shopId: SHOP_MINE_ID, userId: authorId });
  await seedReview(world, {
    id: REVIEW_OTHER_ID,
    shopId: SHOP_MINE_ID,
    userId: SECOND_AUTHOR_ID,
  });

  return { kind, cookie };
}

function buildRequest(endpoint: EndpointCase, viewer: Viewer): Request {
  const headers: Record<string, string> = {};
  if (viewer.cookie !== null) {
    headers['cookie'] = viewer.cookie;
  }
  if (endpoint.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`${BASE_URL}${endpoint.path}`, {
    method: endpoint.method,
    headers,
    body: endpoint.body === undefined ? null : JSON.stringify(endpoint.body),
  });
}
```

- [ ] **Step 3: 52 通りを回すテスト本体を書く**

同じファイルの続き:

```ts
describe('権限マトリクス（13 エンドポイント × 4 閲覧者）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  for (const endpoint of ENDPOINT_CASES) {
    describe(`#${endpoint.no} ${endpoint.label}`, () => {
      for (const kind of VIEWER_KINDS) {
        it(`${kind} には ${endpoint.expected[kind]} を返す`, async () => {
          const viewer = await setUpWorld(world, kind);
          const res = await app.request(
            buildRequest(endpoint, viewer),
            undefined,
            createTestBindings(world),
          );
          expect(res.status).toBe(endpoint.expected[kind]);
        });
      }
    });
  }

  it('マトリクスは 13 エンドポイント × 4 閲覧者 = 52 通りを網羅している', () => {
    // ケースの取りこぼしを件数で検出する。表に行を足したらここも更新する
    expect(ENDPOINT_CASES).toHaveLength(13);
    expect(VIEWER_KINDS).toHaveLength(4);
    for (const endpoint of ENDPOINT_CASES) {
      expect(Object.keys(endpoint.expected).sort()).toEqual([
        'admin',
        'anonymous',
        'owner',
        'user',
      ]);
    }
  });

  it('エンドポイント番号が 1 から 13 まで重複なく並んでいる', () => {
    expect(ENDPOINT_CASES.map((endpoint) => endpoint.no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });
});
```

- [ ] **Step 4: 403 と 404 が混ざっていないことを検証するテストを足す**

同じファイルの末尾に追加する。**ステータスコードが合っていても、本文で区別が漏れたら意味がない。**

```ts
describe('403 と 404 の使い分け', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('owner が触れない店舗と存在しない店舗で、応答が完全に一致する', async () => {
    const viewer = await setUpWorld(world, ROLE_OWNER);
    const headers = { 'content-type': 'application/json', cookie: viewer.cookie ?? '' };
    const forbiddenRes = await app.request(
      new Request(`${BASE_URL}/shops/${SHOP_OTHER_DRAFT_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    const missingRes = await app.request(
      new Request(`${BASE_URL}/shops/shp_does_not_exist`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(forbiddenRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    // ステータスだけでなく本文まで一致していること。差があれば存在有無が漏れる
    expect(await forbiddenRes.text()).toBe(await missingRes.text());
  });

  it('user が触れないレビューと存在しないレビューで、応答が完全に一致する', async () => {
    const viewer = await setUpWorld(world, ROLE_USER);
    const headers = { cookie: viewer.cookie ?? '' };
    const forbiddenRes = await app.request(
      `/reviews/${REVIEW_OTHER_ID}`,
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    const missingRes = await app.request(
      '/reviews/rev_does_not_exist',
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    expect(forbiddenRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(await forbiddenRes.text()).toBe(await missingRes.text());
  });

  it('403 はリソース ID に依存しない（存在する ID でも存在しない ID でも同じ）', async () => {
    const viewer = await setUpWorld(world, ROLE_USER);
    const headers = { cookie: viewer.cookie ?? '' };
    const existingRes = await app.request(
      `/shops/${SHOP_MINE_ID}`,
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    const missingRes = await app.request(
      '/shops/shp_does_not_exist',
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    // roleGuard がリソースを読む前に弾くので、存在有無が応答に出ない
    expect(existingRes.status).toBe(403);
    expect(missingRes.status).toBe(403);
    expect(await existingRes.text()).toBe(await missingRes.text());
  });

  it('エラー応答にスタックトレース・SQL・テーブル名が含まれない', async () => {
    const viewer = await setUpWorld(world, ROLE_OWNER);
    const res = await app.request(
      new Request(`${BASE_URL}/shops/${SHOP_OTHER_DRAFT_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: viewer.cookie ?? '' },
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    const text = await res.text();
    expect(text).toBe('{"error":{"status":404,"message":"対象が見つかりません"}}');
    expect(text).not.toMatch(/at\s+\w+\s+\(/);
    expect(text).not.toMatch(/select|update|delete\s+from|owner_id|shops|reviews/i);
  });
});
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- permission-matrix
```

期待: 52 + 2 + 4 = **58 件すべて PASS**。所要 30 秒前後（1 ケースごとに miniflare の D1 を起こし直すため）。
Vitest の出力で `#1` 〜 `#13` の describe がそれぞれ 4 件ずつ並んでいることを目で確認する。

- [ ] **Step 6: 意図的にコードを壊してテストが検知することを確認する**

**壊す箇所は「二重防御のうち 1 枚しか無い場所」を選ぶ。**
下の 5 つはすべて、本物の D1 を載せたプローブで実際に壊して FAIL することを確認した内容。

**(a) `src/repositories/shop-repository.ts` の `updateShopAsOwner` から所有者条件を外す**

```ts
const updated = await db
  .update(shops)
  .set(toShopUpdateValues(input, now))
  // わざと壊す: eq(shops.ownerId, actor.userId) を落とす
  .where(eq(shops.id, shopId))
  .returning();
```

期待: `#8 PATCH /shops/:shopId（他人の店舗） › owner には 404 を返す` の**1 件だけ**が FAIL し、
`expected 404, received 200` になる。**他人の店舗名が実際に書き換わる**ことが応答本文で見える。
Phase 4 の中心である「所有権を `WHERE` で表す」が効いている唯一の証拠。確認後に元へ戻す。

**(b) `src/repositories/review-repository.ts` の `deleteReviewAsAuthor` から投稿者条件を外す**

```ts
const deleted = await db
  .delete(reviews)
  // わざと壊す: eq(reviews.userId, actor.userId) を落とす
  .where(eq(reviews.id, reviewId))
  .returning({ id: reviews.id });
```

期待: `#13 … user には 404 を返す` が FAIL（204 が返る）。
加えて `user が触れないレビューと存在しないレビューで、応答が完全に一致する` も FAIL する
（他人のレビューは 204、存在しないレビューは 404 になり、本文が一致しなくなる）。確認後に元へ戻す。

**(c) `src/repositories/shop-repository.ts` の `visibilityCondition` を published 固定にする**

```ts
function visibilityCondition(_viewer: Viewer): SQL | undefined {
  // わざと壊す: admin / owner の分岐を消す
  return eq(shops.status, SHOP_STATUS_PUBLISHED);
}
```

期待: `#5 GET /shops/:shopId（他人の draft） › admin には 200 を返す` が FAIL（404 が返る）。
確認後に元へ戻す。

**(d) `src/routes/shops.ts` の PATCH を「無い＝404 / 他人のもの＝403」に分ける**

まず `src/repositories/shop-repository.ts` に Actor を取らない関数を足す:

```ts
// わざと壊す: Actor を取らずに 1 行読む
export async function findShopWithoutActor(db: Database, shopId: ShopId): Promise<ShopRow | null> {
  const rows = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);
  return rows[0] ?? null;
}
```

次に `src/routes/shops.ts` の PATCH ハンドラの、リポジトリを呼ぶ直前に差し込む:

```ts
// わざと壊す: 先に行を読んでから存在有無と所有権を別々のステータスにする
const existing = await findShopWithoutActor(db, shopId);
if (existing === null) {
  throw notFound();
}
if (!isAdminActor(viewer) && existing.ownerId !== requireActor(c).userId) {
  throw forbidden();
}
```

期待: `#8 … owner には 404 を返す` が FAIL（403 が返る）。
さらに `owner が触れない店舗と存在しない店舗で、応答が完全に一致する` も FAIL する。
**これが設計書 3.2 が禁じている情報漏洩そのもの**で、ステータスだけを見る 1 本目より
本文まで比べる 2 本目のほうが意図を強く守っていることが分かる。
`findShopWithoutActor` は Actor を取らないので、Task 4-10 の `repository-convention.test.ts` も
同時に FAIL する。**壊し方が 2 段階で捕まる**ことを確認したら元へ戻す。

**(e) `ENDPOINT_CASES` から `#5` の 1 行を削除する**

期待: `マトリクスは 13 エンドポイント × 4 閲覧者 = 52 通りを網羅している` と
`エンドポイント番号が 1 から 13 まで重複なく並んでいる` が FAIL。
**表からエンドポイントを落としても気付けることを確認する。** 確認後に元へ戻す。

> **確認済みの「壊しても落ちない」ケース:** `src/middleware/role-guard.ts` の `roleGuard` を
> `await next()` だけの no-op にしても、**このファイルのテストは 1 件も落ちない**（実測）。
> ハンドラ側の `requireUserActor` / `requireOwnerActor` / `requireAdminActor` が同じ 401 / 403 を
> 投げるためで、これは Task 4-7 で意図した二重防御が本当に効いていることの裏返しでもある。
> `roleGuard` 単体の退行を捕まえるのは Task 4-7 の `role-guard.test.ts` なので、
> **壊しの確認は必ず `npm run test -w @meshimap/api` を全体で回して行う。**

- [ ] **Step 7: コミット**

```bash
git add apps/api/src/routes/permission-matrix.test.ts
git commit -m "test(api): ロール × エンドポイントの網羅権限テストを追加"
```

---

## Task 4-13: 他人のデータに触れないことを証明するテスト

Task 4-12 が見ているのは**ステータスコード**。ここで見るのは**DB の中身**。
「403 が返ったが実は書き込まれていた」「404 が返ったが実は消えていた」を検出する。

**このタスクのテストはすべて次の形をとる。**

1. 被害者のデータを作る
2. 加害者としてリクエストする
3. 応答が 403 / 404 であることを確認する
4. **被害者のデータが 1 バイトも変わっていないことを SQL で直接確認する**

4 を書かないテストは、このタスクでは不合格。
4 を `findVisibleShop` などのリポジトリ経由で書くのも不合格。
**リポジトリが壊れていたら検証まで一緒に壊れる**ので、`readRow` / `countRows` で生の SQL を投げる。

**Files:**

- Test: `apps/api/src/routes/tenant-isolation.test.ts`

**Interfaces:**

- Consumes:
  - `../index` の `app`
  - `../test/fixtures` の `countRows` / `createTestBindings` / `createTestWorld` / `readRow` / `runWrite` / `seedMasters` / `seedReview` / `seedShop` / `seedUser` / `signUpAs`、型 `TestWorld`
  - `@meshimap/core` の `ROLE_OWNER` / `ROLE_USER`
  - `../db/constants` の `PROFILE_STATUS_SUSPENDED` / `REVIEW_STATUS_PUBLISHED` / `SHOP_STATUS_DRAFT` / `SHOP_STATUS_PUBLISHED`
- Produces: なし（テストのみ）

- [ ] **Step 1: 比較用のヘルパとレビュー侵害のテストを書く**

`apps/api/src/routes/tenant-isolation.test.ts` の前半:

```ts
import { ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_SUSPENDED,
  REVIEW_STATUS_PUBLISHED,
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import { app } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  countRows,
  createTestBindings,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  signUpAs,
} from '../test/fixtures';

const BASE_URL = 'http://localhost:8787';

/** レビューを載せる店舗の所有者。shops.owner_id は user.id への外部キーなので実在させる */
const SHOP_OWNER_ID = 'usr_shop_owner';

/**
 * 権限侵害の前後で比較するためのスナップショット。1 列でも変わったら toEqual で検出できる。
 * **リポジトリ層を通さない**のが肝心で、リポジトリが壊れたら検証も一緒に壊れる経路では
 * 「触れていないこと」を証明したことにならない。
 */
async function snapshotShop(
  world: TestWorld,
  shopId: string,
): Promise<Record<string, unknown> | null> {
  return await readRow(
    world,
    'SELECT name, owner_id, status, lat, lng, geohash, updated_at FROM shops WHERE id = ?',
    shopId,
  );
}

/** 行が残っているかだけを見る */
async function countReviews(world: TestWorld, reviewId: string): Promise<number> {
  return await countRows(world, 'SELECT COUNT(*) AS count FROM reviews WHERE id = ?', reviewId);
}

function jsonRequest(path: string, method: string, body: unknown, cookie: string): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('他人のデータへの到達不能性', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    // shops.genre_id / area_id は NOT NULL かつ外部キー。全テストで必要になる
    await seedMasters(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('user A は user B のレビューに触れない', () => {
    it('DELETE は 404 を返し、B のレビューが残る', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });
      await seedReview(world, { id: 'rev_bob', shopId: 'shp_1', userId: bob.userId });

      const res = await app.request(
        '/reviews/rev_bob',
        { method: 'DELETE', headers: { cookie: alice.cookie } },
        createTestBindings(world),
      );

      expect(res.status).toBe(404);
      expect(await countReviews(world, 'rev_bob')).toBe(1);
    });

    it('自分のレビューは消えるが、他人のレビューは巻き添えにならない', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });
      // uq_reviews_shop_user があるので、同じ店舗には別々の利用者で入れる
      await seedReview(world, { id: 'rev_alice', shopId: 'shp_1', userId: alice.userId });
      await seedReview(world, { id: 'rev_bob', shopId: 'shp_1', userId: bob.userId });

      const res = await app.request(
        '/reviews/rev_alice',
        { method: 'DELETE', headers: { cookie: alice.cookie } },
        createTestBindings(world),
      );

      expect(res.status).toBe(204);
      expect(await countReviews(world, 'rev_alice')).toBe(0);
      expect(await countReviews(world, 'rev_bob')).toBe(1);
    });

    it('ボディに userId を混ぜても投稿者は自分のままになる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_1/reviews',
          'POST',
          {
            shopId: 'shp_1',
            rating: 5,
            body: 'なりすまし',
            visitedOn: '2026-09-10',
            budgetYen: null,
            userId: bob.userId,
          },
          alice.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(201);
      const created = await res.json<{ review: { userId: string } }>();
      // createReviewAsUser は userId を引数に取らず actor.userId を使う。型として渡す経路が無い
      expect(created.review.userId).toBe(alice.userId);
      expect(created.review.userId).not.toBe(bob.userId);
    });

    it('ボディに status を混ぜても hidden なレビューを作れない', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_1/reviews',
          'POST',
          {
            shopId: 'shp_1',
            rating: 5,
            body: 'ふつう',
            visitedOn: '2026-09-10',
            budgetYen: null,
            status: 'hidden',
          },
          alice.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(201);
      const created = await res.json<{ review: { status: string } }>();
      expect(created.review.status).toBe(REVIEW_STATUS_PUBLISHED);
    });
  });
});
```

- [ ] **Step 2: 店舗侵害のテストを足す**

Step 1 で書いた `describe('他人のデータへの到達不能性', ...)` の**内側**、
`describe('user A は user B のレビューに触れない', ...)` の**前**に足す。
`world` は外側の describe の `let world: TestWorld;` を共有するので、
**トップレベルに置くと `world` を参照できない**。以下は 2 段インデント済みの形で示す:

```ts
describe('owner A は owner B の店舗に触れない', () => {
  it('PATCH は 404 を返し、B の店舗の全列が変わらない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
    await seedShop(world, {
      id: 'shp_b',
      ownerId: ownerB.userId,
      status: SHOP_STATUS_PUBLISHED,
      name: 'B の店',
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    const before = await snapshotShop(world, 'shp_b');

    const res = await app.request(
      jsonRequest('/shops/shp_b', 'PATCH', { name: '乗っ取り' }, ownerA.cookie),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(404);
    // updated_at まで含めて比較する。「更新は失敗したが updatedAt だけ進む」も検出したい
    expect(await snapshotShop(world, 'shp_b')).toEqual(before);
  });

  it('緯度経度の更新でも B の座標と geohash が変わらない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_b', ownerId: ownerB.userId, status: SHOP_STATUS_PUBLISHED });
    const before = await snapshotShop(world, 'shp_b');

    const res = await app.request(
      jsonRequest(
        '/shops/shp_b',
        'PATCH',
        { latitude: 34.702485, longitude: 135.495951 },
        ownerA.cookie,
      ),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(404);
    expect(await snapshotShop(world, 'shp_b')).toEqual(before);
  });

  it('B の draft 店舗は一覧に出てこない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
    await seedShop(world, {
      id: 'shp_b_draft',
      ownerId: ownerB.userId,
      status: SHOP_STATUS_DRAFT,
    });
    await seedShop(world, {
      id: 'shp_a_draft',
      ownerId: ownerA.userId,
      status: SHOP_STATUS_DRAFT,
    });

    const res = await app.request(
      '/shops',
      { headers: { cookie: ownerA.cookie } },
      createTestBindings(world),
    );

    const body = await res.json<{ shops: { id: string }[] }>();
    const ids = body.shops.map((shop) => shop.id);
    // 「自分のは見える」まで確認しないと、可視条件が全部落ちていても通ってしまう
    expect(ids).toContain('shp_a_draft');
    expect(ids).not.toContain('shp_b_draft');
  });

  it('B の draft 店舗の名前が応答本文のどこにも現れない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
    await seedShop(world, {
      id: 'shp_b_draft',
      ownerId: ownerB.userId,
      status: SHOP_STATUS_DRAFT,
      name: '秘密の新店',
    });

    const listRes = await app.request(
      '/shops',
      { headers: { cookie: ownerA.cookie } },
      createTestBindings(world),
    );
    const detailRes = await app.request(
      '/shops/shp_b_draft',
      { headers: { cookie: ownerA.cookie } },
      createTestBindings(world),
    );

    expect(detailRes.status).toBe(404);
    // 構造ではなく生文字列で見る。エラーメッセージや将来の追加フィールドに混ざっても捕まえたい
    expect(await listRes.text()).not.toContain('秘密の新店');
    expect(await detailRes.text()).not.toContain('秘密の新店');
  });
});

describe('owner は自分の店舗でも変えてはいけない列がある', () => {
  it('ボディに ownerId を混ぜても所有者は移らない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });

    const res = await app.request(
      jsonRequest(
        '/shops/shp_a',
        'PATCH',
        { name: '改名後', ownerId: ownerB.userId },
        ownerA.cookie,
      ),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    const row = await snapshotShop(world, 'shp_a');
    // shopUpdateSchema に ownerId が無く Zod の既定が strip、かつ toShopUpdateValues が
    // 列を 1 つずつ写す。この 2 枚のどちらかが残っていれば所有者は移らない
    expect(row?.['owner_id']).toBe(ownerA.userId);
    // 同じリクエストで name は本当に通っている（strip が全部を捨てているのではない）
    expect(row?.['name']).toBe('改名後');
  });

  it('ボディに status を混ぜても勝手に公開されない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_DRAFT });

    const res = await app.request(
      jsonRequest(
        '/shops/shp_a',
        'PATCH',
        { name: '改名後', status: SHOP_STATUS_PUBLISHED },
        ownerA.cookie,
      ),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    // 公開は admin の審査を通す（設計書 4 章）。owner が自力で published にできてはいけない
    expect((await snapshotShop(world, 'shp_a'))?.['status']).toBe(SHOP_STATUS_DRAFT);
  });

  it('ボディに geohash を混ぜても座標と矛盾する値は入らない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
    const before = await snapshotShop(world, 'shp_a');

    const res = await app.request(
      jsonRequest('/shops/shp_a', 'PATCH', { name: '改名後', geohash: 'zzzzzzz' }, ownerA.cookie),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    // 'zzzzzzz' は ck_shops_geohash_alphabet を満たしてしまう（z は base32 に含まれる）。
    // つまり DB の CHECK では止まらず、止めているのはアプリ側の列マッピングだけ
    expect((await snapshotShop(world, 'shp_a'))?.['geohash']).toBe(before?.['geohash']);
  });
});
```

- [ ] **Step 3: 停止アカウントとセッション取り違えのテストを足す**

同じく `describe('他人のデータへの到達不能性', ...)` の**内側**、
`describe('user A は user B のレビューに触れない', ...)` の**後ろ**（外側 describe を閉じる
`});` の直前）に足す。以下も 2 段インデント済みの形で示す:

```ts
describe('停止されたアカウント', () => {
  it('profiles.status が suspended なら 403 になり、書き込みも起きない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      ownerA.userId,
    );
    const before = await snapshotShop(world, 'shp_a');

    const res = await app.request(
      jsonRequest('/shops/shp_a', 'PATCH', { name: '停止中の更新' }, ownerA.cookie),
      undefined,
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
    expect(await snapshotShop(world, 'shp_a')).toEqual(before);
  });

  it('停止されたアカウントは公開一覧も読めないが、Cookie を捨てれば匿名として読める', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      ownerA.userId,
    );

    const signedInRes = await app.request(
      '/shops',
      { headers: { cookie: ownerA.cookie } },
      createTestBindings(world),
    );
    const anonymousRes = await app.request('/shops', {}, createTestBindings(world));

    // authMiddleware が 403 を投げるので、公開エンドポイントでも止まる
    expect(signedInRes.status).toBe(403);
    // Cookie を捨てれば匿名として読める。公開情報の可用性は損なわれない
    expect(anonymousRes.status).toBe(200);
  });
});

describe('セッションの取り違え', () => {
  it('owner A の Cookie で owner B になりすませない', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);

    const res = await app.request(
      '/me',
      { headers: { cookie: ownerA.cookie } },
      createTestBindings(world),
    );

    const body = await res.json<{ profile: { userId: string } }>();
    expect(body.profile.userId).toBe(ownerA.userId);
    expect(body.profile.userId).not.toBe(ownerB.userId);
  });

  it('Cookie の値を 1 文字書き換えると匿名に落ちる', async () => {
    const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
    await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
    const tampered = `${ownerA.cookie.slice(0, -1)}${ownerA.cookie.endsWith('a') ? 'b' : 'a'}`;
    const before = await snapshotShop(world, 'shp_a');

    const res = await app.request(
      jsonRequest('/shops/shp_a', 'PATCH', { name: '改ざん' }, tampered),
      undefined,
      createTestBindings(world),
    );

    // Better Auth の署名検証に落ちてセッションが取れず、匿名扱いになるので roleGuard が 401 を返す
    expect(res.status).toBe(401);
    expect(await snapshotShop(world, 'shp_a')).toEqual(before);
  });
});
```

- [ ] **Step 4: テストが失敗することを確認する**

Task 4-11 まで終わっていればほとんど PASS するはずだが、**必ず 1 度は赤を見る**。
`src/repositories/shop-repository.ts` の `updateShopAsOwner` の WHERE から
`eq(shops.ownerId, actor.userId)` を一時的に外して実行する。

```bash
npm run test -w @meshimap/api -- tenant-isolation
```

期待: `PATCH は 404 を返し、B の店舗の全列が変わらない` と
`緯度経度の更新でも B の座標と geohash が変わらない` が FAIL する。

> **出るのは `expected 404, received 200` だけ。** Vitest は**最初に失敗した `expect` で
> その `it` を打ち切る**ので、その次の行にある `toEqual(before)` の差分は表示されない。
> 「ステータスだけでなく DB の中身も見ている」ことを目で確かめたいなら、
> 一時的に `expect(res.status).toBe(404);` を `toEqual` の**後ろ**へ移してもう 1 度流す。
> そうすると `name` が `'B の店'` → `'乗っ取り'`、`updated_at` が `100` → 現在時刻、
> 2 本目は `lat/lng` が大阪の座標へ、`geohash` が `xn76fgr` → `xn0m7m3` へ変わった差分が出る。
> 確認したら**並び順も元に戻す**（本番の並びはステータス先で正しい。
> 権限の失敗は「まず 404 であること」が主張の中心なので、そこから読ませたい）。

確認後に元へ戻す。

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm run test -w @meshimap/api -- tenant-isolation
```

期待: 15 件すべて PASS。所要 20 秒前後（1 件ごとに D1 を起こし直し、2 人分の scrypt を回すため）。

- [ ] **Step 6: 意図的にコードを壊してテストが検知することを確認する**

下の 3 つはすべて、本物の D1 を載せたプローブで実際に壊して FAIL することを確認した内容。

**(a) `src/repositories/review-repository.ts` の `deleteReviewAsAuthor` から投稿者条件を外す**

```ts
const deleted = await db
  .delete(reviews)
  // わざと壊す: eq(reviews.userId, actor.userId) を落とす
  .where(eq(reviews.id, reviewId))
  .returning({ id: reviews.id });
```

期待: `DELETE は 404 を返し、B のレビューが残る` が FAIL。
`expected 404, received 204` と `expected 1, received 0` の**2 段で**落ちる。確認後に元へ戻す。

**(b) `src/auth/load-actor.ts` の `decideActor` から suspended 判定を外す**

```ts
export function decideActor(userId: string, row: ProfileRow | undefined): ActorLoadResult {
  if (row === undefined) {
    return { kind: 'no-profile' };
  }
  // わざと壊す: status の比較を丸ごと消す
  if (!isRole(row.role)) {
    return { kind: 'invalid-role' };
  }
  return { kind: 'found', actor: toActor(userId, row.role) };
}
```

期待: `profiles.status が suspended なら 403 になり、書き込みも起きない`（403 → 200 になり、
店名が `'停止中の更新'` へ書き換わる）と
`停止されたアカウントは公開一覧も読めないが、Cookie を捨てれば匿名として読める`（403 → 200）が FAIL。
確認後に元へ戻す。

**(c) 入力の絞り込みを 2 枚とも外す**

`ownerId` / `status` / `geohash` の混入を止めているのは**2 枚の壁**で、片方だけ壊しても通ってしまう
（実測で確認済み）。壊すときは必ず両方を同時に外す。

1 枚目、`src/lib/validate.ts` の `jsonBody` を素通しにする:

```ts
return validator('json', (value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput();
  }
  // わざと壊す: strip 済みの parsed.data ではなく生のボディを返す
  return value as typeof parsed.data;
});
```

2 枚目、`src/repositories/shop-repository.ts` の `toShopUpdateValues` を丸写しにする:

```ts
function toShopUpdateValues(input: ShopUpdateInput, now: Date): ShopWriteValues {
  const values: ShopWriteValues = { updatedAt: now };
  // わざと壊す: 列を 1 つずつ写すのをやめて入力を丸ごと展開する
  Object.assign(values, input);
```

期待: `ボディに ownerId を混ぜても所有者は移らない`（`owner_id` が B の ID になる）、
`ボディに status を混ぜても勝手に公開されない`（`draft` → `published`）、
`ボディに geohash を混ぜても座標と矛盾する値は入らない`（`xn76fgr` → `zzzzzzz`）の**3 件**が FAIL。
`zzzzzzz` は `ck_shops_geohash_alphabet`（`0-9bcdefghjkmnpqrstuvwxyz`）も
`ck_shops_geohash_length`（7 文字）も満たすため、**DB の CHECK では止まらない**。
止めているのがアプリ側の 2 枚だけであることがここで分かる。確認後に両方とも元へ戻す。

- [ ] **Step 7: コミット**

```bash
git add apps/api/src/routes/tenant-isolation.test.ts
git commit -m "test(api): 他人のデータに到達できないことを DB の中身で検証するテストを追加"
```

---

## Task 4-14: RPC 契約の型検証と、ルート表 ↔ 実装の機械的な突合

Phase 4 の最後のタスク。ここまでで「動くこと」「他人のデータに届かないこと」は証明した。
残っている穴は 2 つある。

1. **`AppType` が本当に使える型かを誰も確かめていない。** `index.ts` から export しているだけでは、
   Phase 5 のモバイルが `hc<AppType>` を書いた瞬間に壊れていても Phase 4 のテストは全部緑のまま。
2. **Task 4-12 の 13 行の表が、実装の全エンドポイントを覆っている保証が無い。**
   `index.ts` にルートを 1 本足しても、いまのテストは 1 件も落ちない（実測確認済み）。
   「網羅した権限テスト」は、表の内側でしか網羅していない。

このタスクはプロダクションコードを 1 行も増やさない。**増えるのは検証だけ。**

**Files:**

- Create: `apps/api/src/routes/rpc-contract.test.ts`
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Task 4-12 で作成済み。末尾に **`describe` を 2 つ**と、突合用の純関数・定数をモジュール直下に足す）

**Interfaces:**

- Consumes:
  - `hono/client` の `hc`
  - `hono/testing` の `testClient`
    （`node_modules/hono/dist/types/helper/testing/index.d.ts` で確認したシグネチャ:
    `testClient<T>(app: T, Env?, executionCtx?: ExecutionContext, options?: Omit<ClientRequestOptions, 'fetch'>)`）
  - `../index` の `app` と型 `AppType`
  - `../auth/auth`（Task 4-5）の `AUTH_BASE_PATH`
  - `@meshimap/core` の `ROLE_ADMIN` / `ROLE_OWNER` / `ROLE_USER`
  - `../db/constants`（Phase 3）の `SHOP_STATUS_DRAFT`
  - `../test/fixtures` の `createTestBindings` / `createTestWorld` / `seedMasters` / `seedShop` /
    `seedUser` / `signUpAs` / `TEST_AREA_ID` / `TEST_BASE_URL` / `TEST_GENRE_ID` と型 `TestWorld`
- Produces: なし（検証専用。`src/` の実装ファイルは増減しない）

### `app.request` ではなく `testClient` を使う理由

Task 4-11〜4-13 はすべて `app.request(new Request(...), undefined, bindings)` で叩いてきた。
これは**パスを文字列で組み立てる**ので、`AppType` の型は 1 ミリも効いていない。
`/shops/:shopId` を `/shop/:shopId` と書き間違えても、テストは「404 が返る」と読んで緑になりうる。

`testClient` は `hc` を `app.request` に繋いだだけのヘルパで、
**パス・param・query・json・レスポンス型がすべて `AppType` 由来**になる。
つまりこのファイルは、モバイルが書くコードと同じ型の上を通る唯一のテストになる。

第 2 引数に `createTestBindings(world)` をそのまま渡せることは実測で確認済み
（`testClient(app, bindings)` で `GET /shops` が 200 を返し、`shops` が本物の D1 の行を返した）。
Cookie は第 4 引数 `{ headers: { cookie } }` で乗る（これも実測確認済み）。

### vitest が見るもの / tsc が見るもの

**`@ts-expect-error` は vitest では一切効かない。** vitest は esbuild で型を剥がして実行するだけ。
逆に「型は通るが実行時に落ちる」も `tsc` では見つからない。

| 検証対象                                                                                     | 検証者                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| param / query / json の型、レスポンスの絞り込み、`@ts-expect-error` が本当にエラーになること | `npm run typecheck -w @meshimap/api` |
| 実際に 200 / 201 / 204 / 404 が返り、本物の D1 の行が動くこと                                | `npm run test -w @meshimap/api`      |

**両方を回して初めてこのタスクは完了する。** 片方だけだと半分しか見ていない。

### レスポンスの `status` 型（実測値）

`hc` が返す `ClientResponse` の `status` は、ハンドラの書き方でリテラルにも広い型にもなる。
実際に代入して確かめた結果は次のとおり。

| 呼び出し                                                                                 | `status` の型          | ハンドラの書き方                 |
| ---------------------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| `GET /health` / `GET /shops` / `GET /shops/:shopId` / `PATCH /shops/:shopId` / `GET /me` | `ContentfulStatusCode` | `c.json(...)`（第 2 引数を省略） |
| `POST /shops` / `POST /shops/:shopId/reviews`                                            | `201`                  | `c.json(..., 201)`               |
| `DELETE /shops/:shopId` / `DELETE /reviews/:reviewId`                                    | `204`                  | `c.body(null, 204)`              |

**`status` を 200 に絞り込まなくても `.json()` は呼べる**（`ContentfulStatusCode` でも
レスポンス本文の型はひとつしかないため）。実際に `if (res.status === 200)` を外しても
`tsc` は通る（確認済み）。404 は `onError` が返すので `AppType` の型には現れない。
そのため**「404 が返る」ことを型で保証することはできない**。そこは実行時のテストの仕事。

### `@ts-expect-error` は「次の 1 行」しか抑制しない（実測でハマった）

`@ts-expect-error` を複数行の呼び出しの**先頭**に置くと動かない。
tsc はエラーを「実際に型が合わない行」に報告するので、ディレクティブの次の行に
エラーが無ければ `TS2578: Unused '@ts-expect-error' directive.` になる。

```ts
// ❌ これは TS2578 になる。エラーが出るのは rating の行であって $post の行ではない
// @ts-expect-error rating は number
await rpcClient.shops[':shopId'].reviews.$post({
  param: { shopId: 'shp_1' },
  json: { shopId: 'shp_1', rating: '5', ... },
});
```

**エラーが出る行の直前に置く。** 下の Step 4 のコードはその形にしてある。
1 行に収めて書く手もあるが、prettier（`printWidth: 100`）が折り返すので採れない。

### 型が要求するものとサーバが受け取るもののズレ（実測値）

Task 4-11 の「確定事項 2」のとおり、`hc<AppType>` は `.default()` を持つ列も**必須**として要求する。
一方でサーバはそれらを省いたボディも受け付ける。実測した対応は次のとおり。

| リクエスト                                                                                | 型が要求                   | 実際のサーバ                                                      | 結果             |
| ----------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- | ---------------- |
| `POST /shops` から `nameKana` / `description` / `phone` / `website` / `budget*Yen` を省く | コンパイルエラー（TS2741） | 201。`nameKana` は `""`、`description` は `""`、`phone` は `null` | ランタイムは寛容 |
| `POST /shops/:shopId/reviews` から `budgetYen` を省く                                     | コンパイルエラー（TS2741） | 201。`budget` は `null`                                           | ランタイムは寛容 |

**方向は常に「型 ⊆ ランタイム」**。型が通るものは必ずサーバも通る。
この関係が逆転していないことを、下の Step 3 で実際のリクエストを投げて固定する。

- [ ] **Step 1: 匿名クライアントの契約を書く**

`apps/api/src/routes/rpc-contract.test.ts`:

```ts
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { hc } from 'hono/client';
import { testClient } from 'hono/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_STATUS_DRAFT } from '../db/constants';
import { app } from '../index';
import type { AppType } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  createTestBindings,
  createTestWorld,
  seedMasters,
  seedShop,
  seedUser,
  signUpAs,
  TEST_AREA_ID,
  TEST_BASE_URL,
  TEST_GENRE_ID,
} from '../test/fixtures';

const SHOP_OWNER_ID = 'usr_shop_owner';
const PUBLISHED_SHOP_ID = 'shp_published';
const DRAFT_SHOP_ID = 'shp_draft';

/**
 * `hc<AppType>` が要求するボディ。`.default()` を持つ列（nameKana / description / phone /
 * website / budget*Yen）も**必ず書く**。省くと tsc が TS2741 を出す。
 * 理由は Task 4-11 の「確定事項 2」。
 */
const NEW_SHOP_BODY = {
  name: '新規店',
  nameKana: 'シンキテン',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '104-0061',
  address: '東京都中央区銀座1-1-1',
  latitude: 35.6717,
  longitude: 139.765,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

/** マスタ + オーナー + 公開店舗 1 件 + 他人の下書き 1 件。全テスト共通の下ごしらえ */
async function seedBaseWorld(world: TestWorld): Promise<void> {
  await seedMasters(world);
  await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
  await seedShop(world, { id: PUBLISHED_SHOP_ID, ownerId: SHOP_OWNER_ID, name: '公開店' });
  await seedShop(world, { id: DRAFT_SHOP_ID, ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_DRAFT });
}

describe('RPC 契約（匿名クライアント）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('GET /health は status: ok を返し、型も "ok" リテラルに絞られる', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.health.$get();
    const body = await res.json();
    // 代入先に 'ok' リテラル型を書いているので、レスポンス型が広がれば tsc が落ちる
    const status: 'ok' = body.status;
    expect(status).toBe('ok');
  });

  it('GET /shops は published の店舗だけを返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shops.map((shop) => shop.id)).toEqual([PUBLISHED_SHOP_ID]);
  });

  it('GET /shops/:shopId は param 経由で公開店舗を取得できる', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].$get({ param: { shopId: PUBLISHED_SHOP_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shop.name).toBe('公開店');
  });

  it('GET /shops/:shopId は他人の下書きに 404 を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].$get({ param: { shopId: DRAFT_SHOP_ID } });
    expect(res.status).toBe(404);
  });

  it('GET /shops/:shopId/reviews はレビューが無ければ空配列を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].reviews.$get({
      param: { shopId: PUBLISHED_SHOP_ID },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviews).toEqual([]);
  });

  it('GET /me は Cookie が無ければ 401 を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.me.$get();
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Cookie 付きクライアントの契約を書く**

同じファイルの続き。`testClient` の第 4 引数に `headers` を渡すと、以降すべての呼び出しに乗る。

```ts
describe('RPC 契約（Cookie 付きクライアント）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('admin の Cookie を載せると GET /me が自分のロールを返す', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.me.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.role).toBe(ROLE_ADMIN);
    expect(body.profile.userId).toBe(admin.userId);
  });

  it('POST /shops は query と json を両方型付きで送れる', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops.$post({
      query: { ownerId: SHOP_OWNER_ID },
      json: NEW_SHOP_BODY,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.shop.ownerId).toBe(SHOP_OWNER_ID);
    // 作成直後は必ず下書き。公開は別途 PATCH する運用（Task 4-8 で確認済み）
    expect(body.shop.status).toBe(SHOP_STATUS_DRAFT);
  });

  it('PATCH /shops/:shopId は param と json を組み合わせて更新できる', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops[':shopId'].$patch({
      param: { shopId: PUBLISHED_SHOP_ID },
      json: { name: '改名後' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shop.name).toBe('改名後');
  });

  it('DELETE /shops/:shopId は 204 を返し、本文を持たない', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops[':shopId'].$delete({ param: { shopId: PUBLISHED_SHOP_ID } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('user は POST /shops/:shopId/reviews で投稿し、DELETE /reviews/:reviewId で消せる', async () => {
    const author = await signUpAs(world, 'user@example.com', ROLE_USER);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: author.cookie },
    });
    const posted = await client.shops[':shopId'].reviews.$post({
      param: { shopId: PUBLISHED_SHOP_ID },
      json: {
        shopId: PUBLISHED_SHOP_ID,
        rating: 5,
        body: 'とても良かった',
        visitedOn: '2026-09-10',
        budgetYen: 3200,
      },
    });
    expect(posted.status).toBe(201);
    const postedBody = await posted.json();
    expect(postedBody.review.rating).toBe(5);

    const removed = await client.reviews[':reviewId'].$delete({
      param: { reviewId: postedBody.review.id },
    });
    expect(removed.status).toBe(204);
  });
});
```

- [ ] **Step 3: 型とランタイムのズレを固定する**

同じファイルの続き。**`.default()` 付きの列を省いたボディは型では書けない**ので、
ここだけは `app.request` で生の JSON を投げる。型が要求する側が厳しいこと（＝安全側）を明示する。

```ts
describe('型が要求するものとサーバが受け取るもののズレ', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('hc の型は必須でも、default を持つ列を省いたボディをサーバは 201 で受け取る', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    // hc<AppType> では書けないボディ。ズレの向きを固定するため生のリクエストで投げる
    const res = await app.request(
      new Request(`${TEST_BASE_URL}/shops?ownerId=${SHOP_OWNER_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({
          name: '最小店',
          genreId: TEST_GENRE_ID,
          areaId: TEST_AREA_ID,
          postalCode: '104-0061',
          address: '東京都中央区銀座1-1-1',
          latitude: 35.6717,
          longitude: 139.765,
        }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ shop: { nameKana: string; description: string; phone: null } }>();
    // Zod の .default() が埋めた値がそのまま列に入る
    expect(body.shop.nameKana).toBe('');
    expect(body.shop.description).toBe('');
    expect(body.shop.phone).toBeNull();
  });

  it('budgetYen を省いたレビューも 201 になり budget は null で入る', async () => {
    const author = await signUpAs(world, 'user@example.com', ROLE_USER);
    const res = await app.request(
      new Request(`${TEST_BASE_URL}/shops/${PUBLISHED_SHOP_ID}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({
          shopId: PUBLISHED_SHOP_ID,
          rating: 5,
          body: 'よかった',
          visitedOn: '2026-09-10',
        }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ review: { budget: number | null } }>();
    expect(body.review.budget).toBeNull();
  });
});
```

- [ ] **Step 4: 型でしか検出できない誤りを `@ts-expect-error` で固定する**

同じファイルの末尾。**この 2 つの関数は絶対に呼ばない。**
呼ぶと `hc` が本物の `fetch` を叩き、テストが外部ネットワークに出てしまう。

```ts
/**
 * Phase 5 のモバイルが書くのと同じ形。ここでは**型が付くかどうかだけ**を見る。
 * 実リクエストは上の testClient 側で済ませてある。
 */
const rpcClient = hc<AppType>(TEST_BASE_URL);

/** 正しい呼び出しが型エラーにならないことの確認。実行しない */
async function typeOnlyValidCalls(): Promise<void> {
  const list = await rpcClient.shops.$get();
  const listBody = await list.json();
  const ids: string[] = listBody.shops.map((shop) => shop.id);
  void ids;

  const detail = await rpcClient.shops[':shopId'].$get({ param: { shopId: 'shp_1' } });
  if (detail.status === 200) {
    const detailBody = await detail.json();
    const name: string = detailBody.shop.name;
    void name;
  }

  const created = await rpcClient.shops.$post({
    query: { ownerId: SHOP_OWNER_ID },
    json: NEW_SHOP_BODY,
  });
  const createdBody = await created.json();
  const newShopId: string = createdBody.shop.id;

  const patched = await rpcClient.shops[':shopId'].$patch({
    param: { shopId: newShopId },
    json: { name: '改名後' },
  });
  void patched;

  const removed = await rpcClient.shops[':shopId'].$delete({ param: { shopId: newShopId } });
  void removed;

  const reviewRemoved = await rpcClient.reviews[':reviewId'].$delete({
    param: { reviewId: 'rev_1' },
  });
  void reviewRemoved;
}

/**
 * 間違った呼び出しが**必ず型エラーになる**ことの確認。実行しない。
 * 下のディレクティブは「次の行がエラーであること」を要求するので、
 * ここが素通りするようになったら tsc が TS2578（未使用のディレクティブ）で落ちる。
 * つまりこの関数は「型が緩くなったら気付ける」仕掛けそのもの。
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access --
   `@ts-expect-error` で握り潰した式は型が解決できないまま残るので、型認識 ESLint ルールが
   「安全でない呼び出し」として誤検知する。ここは tsc がエラーを出すこと自体が目的の
   実行されないブロックなので、実行時の安全性とは無関係 */
async function typeOnlyInvalidCalls(): Promise<void> {
  // @ts-expect-error param が必須なのに渡していない
  await rpcClient.shops[':shopId'].$get();

  await rpcClient.shops[':shopId'].reviews.$post({
    param: { shopId: 'shp_1' },
    json: {
      shopId: 'shp_1',
      // @ts-expect-error rating は number なのに string を渡している
      rating: '5',
      body: 'よかった',
      visitedOn: '2026-09-10',
      budgetYen: null,
    },
  });

  // @ts-expect-error 定義していないパス
  await rpcClient.unknownPath.$get();

  // @ts-expect-error DELETE は /shops/:shopId にしか無い。/shops 直下には無い
  await rpcClient.shops.$delete();
}
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

describe('型検査専用ブロック', () => {
  it('型検査専用の関数は定義されているが、テストからは呼ばれない', () => {
    // noUnusedLocals に引っかからないための参照も兼ねる。
    // 中身を検証するのは vitest ではなく `npm run typecheck -w @meshimap/api`
    expect(typeof typeOnlyValidCalls).toBe('function');
    expect(typeof typeOnlyInvalidCalls).toBe('function');
  });
});
```

- [ ] **Step 5: ルート表と実装の突合を権限マトリクスに足す**

`apps/api/src/routes/permission-matrix.test.ts` の import に 1 行足す:

```ts
import { AUTH_BASE_PATH } from '../auth/auth';
```

同じファイルの末尾に、突合用の純関数と `describe` を 2 つ追加する:

```ts
// ───────────────── ルート表 ↔ 実装の突合（Task 4-14）─────────────────

/** `app.routes` の 1 要素から、突合に必要な 2 つだけを抜き出した形 */
type RegisteredRoute = { readonly method: string; readonly path: string };

/** 走査対象が 0 本のときに返す違反。これが無いと「表も実装も空」で偽の緑になる */
const VIOLATION_NO_SCAN_TARGET = '走査対象のエンドポイントが 1 本も無い';

/**
 * `.use()` で登録したミドルウェアか。
 *
 * Hono は `.use('*', mw)` も `app.all('/x', h)` も method を 'ALL' として記録するため、
 * method だけでは区別できない。ワイルドカードで終わるパスだけをミドルウェアとみなす。
 * こうしないと `app.all('/version', ...)` のような**本物のエンドポイントが
 * 静かに突合から漏れる**。`.use('/admin', mw)` のようなワイルドカード無しの登録は
 * エンドポイント扱いになって突合に失敗するが、**黙って見逃すより落ちる側に倒す**。
 */
function isMiddlewareRoute(route: RegisteredRoute): boolean {
  return route.method === 'ALL' && route.path.endsWith('*');
}

/**
 * Better Auth のハンドラ配下か。権限は Better Auth 側の責務なのでマトリクスの対象外にする。
 *
 * 単なる前方一致で判定してはいけない。`AUTH_BASE_PATH` が `/api/auth` のとき、
 * `startsWith` だけだと `/api/authorize` のような**別のエンドポイントまで巻き込んで除外**する。
 * パス境界（完全一致か、直後が `/`）まで見る。
 */
function isAuthHandlerRoute(route: RegisteredRoute, authBasePath: string): boolean {
  return route.path === authBasePath || route.path.startsWith(`${authBasePath}/`);
}

/**
 * 登録済みルートから「権限マトリクスが責任を持つエンドポイント」を取り出す。
 * ミドルウェアとハンドラで同じ method + path が重複して現れるので Set で潰す。
 */
export function collectEndpointPatterns(
  routes: readonly RegisteredRoute[],
  authBasePath: string,
): readonly string[] {
  const patterns = routes
    .filter((route) => !isMiddlewareRoute(route) && !isAuthHandlerRoute(route, authBasePath))
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(patterns)].sort();
}

/**
 * ルート表（権限マトリクス）と実装を突き合わせ、食い違いを文字列で列挙する純関数。
 * 空配列が返れば「表と実装が 1 本残らず一致している」。
 */
export function collectRouteCoverageViolations(
  routes: readonly RegisteredRoute[],
  coveredPatterns: readonly string[],
  authBasePath: string,
): readonly string[] {
  const declared = collectEndpointPatterns(routes, authBasePath);
  if (declared.length === 0) {
    return [VIOLATION_NO_SCAN_TARGET];
  }
  const covered = [...new Set(coveredPatterns)].sort();
  const violations: string[] = [];
  for (const pattern of declared) {
    if (!covered.includes(pattern)) {
      violations.push(`権限マトリクスに無いエンドポイント: ${pattern}`);
    }
  }
  for (const pattern of covered) {
    if (!declared.includes(pattern)) {
      violations.push(`実装に無いエンドポイント: ${pattern}`);
    }
  }
  return violations;
}

/**
 * `app.routes` に実際に載っているルート。実測した内訳は次のとおり。
 * - 生の要素数 22（ミドルウェアとハンドラで同じ method + path が重複して現れる）
 * - 重複を潰すと 13
 * - そこから `ALL /*`（authMiddleware）と `GET|POST /api/auth/*`（Better Auth）を除くと 10
 */
function declaredRoutePatterns(): readonly string[] {
  return collectEndpointPatterns(app.routes, AUTH_BASE_PATH);
}

/** 権限マトリクスが責任を持つ 10 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /shops/:shopId',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];

describe('突合器そのものの取りこぼし', () => {
  const AUTH_BASE = '/api/auth';
  const SAMPLE_ROUTES: readonly RegisteredRoute[] = [
    { method: 'ALL', path: '/*' },
    { method: 'GET', path: '/api/auth/*' },
    { method: 'POST', path: '/api/auth/*' },
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/health' },
  ];

  it('表と実装が一致していれば違反は無い', () => {
    expect(collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health'], AUTH_BASE)).toEqual([]);
  });

  it('ミドルウェア（ALL + ワイルドカード）はエンドポイントに数えない', () => {
    expect(collectEndpointPatterns(SAMPLE_ROUTES, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('ワイルドカードを持たない ALL は本物のエンドポイントとして数える', () => {
    // app.all('/version', ...) を「ミドルウェアだから」と見逃すと突合が素通りする
    const routes = [...SAMPLE_ROUTES, { method: 'ALL', path: '/version' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: ALL /version',
    ]);
  });

  it('Better Auth 配下は除外するが、前方一致だけの別パスは除外しない', () => {
    // '/api/authorize' は '/api/auth' で startsWith が真になる。境界を見ないと黙って消える
    const routes = [...SAMPLE_ROUTES, { method: 'GET', path: '/api/authorize' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /api/authorize',
    ]);
  });

  it('AUTH_BASE_PATH と完全一致するパスも除外する', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'POST', path: '/api/auth' }];
    expect(collectEndpointPatterns(routes, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('実装に足されたエンドポイントを検出する', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'GET', path: '/version' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /version',
    ]);
  });

  it('表にだけあって実装に無いエンドポイントを検出する', () => {
    expect(
      collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health', 'GET /healthz'], AUTH_BASE),
    ).toEqual(['実装に無いエンドポイント: GET /healthz']);
  });

  it('パスが同じでもメソッドが違えば別のエンドポイントとして扱う', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'POST', path: '/health' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: POST /health',
    ]);
  });

  it('同じ method + path が何度現れても 1 本に潰れる', () => {
    // ミドルウェアとハンドラで同じ行が重複して載るため、潰さないと件数が合わない
    const routes = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/health' },
    ];
    expect(collectEndpointPatterns(routes, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('表の側に重複があっても違反にならない（#4 と #5 のように 1 本を複数ケースで検証する）', () => {
    expect(
      collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health', 'GET /health'], AUTH_BASE),
    ).toEqual([]);
  });

  it('入力の並び順が変わっても結果は変わらない', () => {
    const shuffled = [...SAMPLE_ROUTES].reverse();
    expect(collectEndpointPatterns(shuffled, AUTH_BASE)).toEqual(
      collectEndpointPatterns(SAMPLE_ROUTES, AUTH_BASE),
    );
  });

  it('走査対象が 0 本なら、表も空でも違反として報告する（偽の緑を防ぐ）', () => {
    // ここが無いと「ルートが 1 本も取れていない」状態が「全部覆えている」に見える
    expect(collectRouteCoverageViolations([], [], AUTH_BASE)).toEqual([VIOLATION_NO_SCAN_TARGET]);
    expect(collectRouteCoverageViolations([{ method: 'ALL', path: '/*' }], [], AUTH_BASE)).toEqual([
      VIOLATION_NO_SCAN_TARGET,
    ]);
  });

  it('表が空なら実装の全エンドポイントが未検証として並ぶ', () => {
    expect(collectRouteCoverageViolations(SAMPLE_ROUTES, [], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /health',
    ]);
  });
});

describe('ルート表と実装の突合', () => {
  it('走査対象のエンドポイントが 1 本以上ある', () => {
    // 0 本なら以降の比較は「空 vs 空」で必ず通ってしまう。先に本数を押さえる
    expect(declaredRoutePatterns().length).toBeGreaterThan(0);
  });

  it('app に登録されたエンドポイントは 10 本で、想定どおりの並びである', () => {
    expect(declaredRoutePatterns()).toEqual(EXPECTED_ROUTE_PATTERNS);
  });

  it('権限マトリクスは app のエンドポイントを 1 本残らず覆っている', () => {
    // #4 と #5 のように 1 本のルートを複数ケースで検証しているので、重複は潰して比べる
    const covered = ENDPOINT_CASES.map((endpoint) => endpoint.routePattern);
    expect(collectRouteCoverageViolations(app.routes, covered, AUTH_BASE_PATH)).toEqual([]);
  });
});
```

- [ ] **Step 6: テストが落ちることを先に確認する（Red）**

**このタスクは検証専用なので、普通に書くと最初から緑になる。**
それでは「テストが壊れていても気付けない」状態と区別がつかないので、
**先に系をわざと歪めて、3 種類の FAIL を目で見る。**

まず `src/index.ts` にルートを 1 本足す:

```ts
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  // わざと壊す: 権限マトリクスに載せていないルートを足す
  .get('/version', (c) => c.json({ version: '0.1.0' as const }))
```

次に `permission-matrix.test.ts` のケース #1 の `routePattern` を書き換える:

```ts
    routePattern: 'GET /healthz',
```

最後に `rpc-contract.test.ts` の `@ts-expect-error` を 1 つだけ消す:

```ts
await rpcClient.shops[':shopId'].$get();
```

そのうえで両方を回す:

```bash
npm run test -w @meshimap/api -- permission-matrix
npm run typecheck -w @meshimap/api
```

期待する FAIL は 3 つ。

| 歪ませた場所                            | 落ちるもの                                                         | 実測した中身                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/version` を足した                     | `app に登録されたエンドポイントは 10 本で、想定どおりの並びである` | 実際が 11 本になり `GET /version` が配列に混ざる                                                                 |
| `/version` を足した                     | `権限マトリクスは app のエンドポイントを 1 本残らず覆っている`     | 違反配列に `権限マトリクスに無いエンドポイント: GET /version`                                                    |
| `routePattern` を `GET /healthz` にした | `権限マトリクスは app のエンドポイントを 1 本残らず覆っている`     | 違反配列に `実装に無いエンドポイント: GET /healthz` と `権限マトリクスに無いエンドポイント: GET /health` の 2 件 |
| `@ts-expect-error` を消した             | **vitest ではなく tsc**                                            | `TS2554: Expected 1-2 arguments, but got 0.`（`$get` は第 2 引数 `options` を任意で取るため）                    |

**`@ts-expect-error` を消した分は `npm run test` では絶対に落ちない。** ここで
「型の検証者は tsc だけ」という事実を目で確認しておくこと。

3 つとも確認したら、**3 箇所すべてを元に戻す**。

- [ ] **Step 7: テストが通ることを確認する（Green）**

```bash
npm run test -w @meshimap/api -- rpc-contract
npm run test -w @meshimap/api -- permission-matrix
npm run typecheck -w @meshimap/api
```

期待:

- `rpc-contract` は 14 件すべて PASS（匿名 6 + Cookie 5 + ズレ 2 + 型検査専用 1）。所要 20 秒前後
- `permission-matrix` は 58 + 16 = **74 件すべて PASS**（追記分は突合器の自己テスト 13 件 + 突合 3 件）
- `typecheck` はエラー 0

- [ ] **Step 8: Phase 4 全体をまとめて流す**

個別に緑でも、全体で回すと落ちることがある（`PRAGMA ignore_check_constraints` の戻し忘れ、
world の共有、Phase 3 のマイグレーション追加との衝突）。**必ず全体で 1 回通す。**

```bash
npm run test -w @meshimap/api
npm run typecheck -w @meshimap/api
npm run format:check
```

期待: 3 つとも成功。

> **`format:check` が落ちたときに `npm run format` を無条件で流さない。** ルートの `format` は
> `prettier --write "**/*.{ts,tsx,js,json,md}"` なので、`docs/superpowers/plans/` の**他フェーズの
> 計画書まで書き換わる**（並行作業中の担当者の差分と衝突する）。落ちたファイル名を確認し、
> 自分が触ったファイルだけを `npx prettier --write <path>` で直す。

- [ ] **Step 8-b: ミューテーションテストを流す（2026-09-15 に前提が変わった）**

```bash
npm run test:mutation -w @meshimap/api
```

期待: **スコア 85% 以上**（`stryker.base.mjs` の `thresholds.break: 85`）。

Phase 4 完了時点の実測（`apps/api/reports/mutation/mutation.json`）:

| 項目     | 値                                                       |
| -------- | -------------------------------------------------------- |
| 変異総数 | 659                                                      |
| Killed   | 560                                                      |
| Survived | 86                                                       |
| Timeout  | 13（Killed 扱い）                                        |
| スコア   | **86.95%**（(560 + 13) / 659）                           |
| 閾値     | 85（`break`）→ exit 0                                    |
| 所要     | 約 148 分（`concurrency: 12`。マシン依存で大きく振れる） |

> **所要時間を 4 分前後だと思って待たないこと。** この計画の初稿は Phase 3 時点の
> 98 変異 / 3m32s を基準に書いていた。Phase 4 が足したコードで変異が **6.7 倍**になり、
> 1 変異あたり回すスイートも 414 件 / 18 秒 → 774 件 / 133 秒（`--no-file-parallelism` 時）に
> 伸びたため、掛け算で 2 時間超になる。**Phase を追うごとに伸びる**前提で見積もること。

`mutate` は `src/**/*.ts` から `*.test.ts` / `src/db/schema/**` / `src/db/testing/**` を除いたもの
なので、**Phase 4 が足すルート・ミドルウェア・リポジトリはそのまま変異の対象に入る**。
つまりこれは既存コードの確認ではなく、**Phase 4 が書いたコードのテストが十分かを見るゲート**。

落ちたときに `stryker.config.mjs` の `thresholds` や `mutate` の除外を触って通すのは禁止。
Survived として報告された変異を読み、それを殺すテストを足すこと。
除外を足してよいのは「Stryker のサンドボックス外のファイルを読むテスト」だけで、
実例と理由は `apps/api/stryker.config.mjs` の `vitestArgs` のコメントにある。

> **生存が 1 箇所に固まっていたら、まず assert が弱くないかを疑う。** Phase 4 の初回は
> **81.34%**（生存 123 件）で break に引っかかった。最大の塊は `toShopUpdateValues` の
> 項目別 `if` で **48 件**。原因は「指定していない項目は変わらない」しか見ておらず、
> **任意項目を 1 つも書き換えないまま**更新テストを組んでいたこと。
> 閾値も `mutate` の除外も触らず、`shop-repository.test.ts` に
> `任意項目をすべて指定すると、対応する列へ 1 つずつ書き込む` と
> `経度だけの指定では経度も geohash も変えない` を足して 86.95% になった
> （この 2 件は上の Task 4-8 の Step に取り込み済み）。
> 生存の一覧は `reports/mutation/index.html` をブラウザで開くとファイル別に読める。

> **変異対象に入っていて、スコアを構造的に押し下げるファイルが 2 つある。**
> `mutate` の除外条件は `!src/**/*.test.ts` なので、
> `src/auth/actor.type-test.ts`（**4 変異すべて生存**。tsc でしか検証しないファイルなので
> vitest では 1 つも殺せない）と `src/test/fixtures.ts`（119 変異中 **33 件生存**）は対象に残る。
> 見かけのスコアはこの分だけ下がるが、**ここに除外を足さない**。
> 「閾値も除外も触らない」方針の例外を 1 つ作ると、次から本物の生存も除外で消せてしまう。
> 驚かないために書いてあるだけで、対応は不要。

> **Timeout 13 件のうち 12 件は `src/middleware/role-guard.ts` に出る。** Stryker は
> Timeout を Killed 側に数えるのでスコアは 86.95% になるが、同じ変異は初回の実行では
> 素直に Killed だった。CPU 競合によるものと**推測**している（断定できる材料は無い）。
> かりに 13 件すべてを生存扱いに落とすと **560 / 659 = 84.98%** となり、
> **閾値 85 をわずかに割る**。つまりこのスコアは Timeout の数え方に依存している。
> 余力があるなら他の作業を止めて流し直すこと。

> **バックグラウンド実行はハーネス管理下だと約 1 時間で kill される。** 2 時間かかるので、
> 素直に流すと完走しない。ハーネス管理外へ逃がすと最後まで走る。
>
> ```bash
> nohup sh -c 'npm run test:mutation -w @meshimap/api > /tmp/mutation.log 2>&1' &
> disown
> ```
>
> 進捗は `tail -f /tmp/mutation.log` で見る。

- [ ] **Step 9: 本物の wrangler で起動して手で叩く**

テストは Hono アプリを Node で動かし、D1 だけを miniflare に置いている。
**本番と同じ workerd の上でアプリ全体が起動するかは、これで初めて確認できる。**
特に `ReservationLock` を classic 形式で書いた判断（Task 4-11 の確定事項 1）は、
ここを通さないと検証できない。

```bash
npm run db:migrate:local -w @meshimap/api
npm run db:seed:local -w @meshimap/api
npm run dev -w @meshimap/api
```

別のターミナルで:

```bash
curl -i http://localhost:8787/health
curl -i http://localhost:8787/shops
curl -i http://localhost:8787/me
curl -i -X POST http://localhost:8787/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"password1234","name":"smoke@example.com"}'
```

期待:

- `wrangler dev` が `Class ReservationLock not found` を出さずに起動する
- `/health` → `200` / `{"status":"ok"}`
- `/shops` → `200`。シード済みの公開店舗が並ぶ
- `/me` → `401` / `{"error":{"status":401,"message":"ログインが必要です"}}`
- サインアップ → `200` と `set-cookie` ヘッダ

確認できたら `Ctrl-C` で止める。

> **ここで落ちたら Phase 4 は未完了。** 落ちるとしたら次の 2 つが疑わしい。
>
> 1. `ReservationLock` の classic 形式が本番の workerd に受け付けられない
>    → `wrangler.jsonc` の `migrations[0]` を `new_classes` に変える必要があるかを確認する
> 2. `BETTER_AUTH_SECRET` が未設定
>    → ローカルは `.dev.vars` に、本番は `wrangler secret put BETTER_AUTH_SECRET` で入れる

- [ ] **Step 10: コミット**

```bash
git add apps/api/src/routes/rpc-contract.test.ts apps/api/src/routes/permission-matrix.test.ts
git commit -m "test(api): hc<AppType> の RPC 契約と、ルート表と実装の突合を追加"
```

---

## Phase 4 完了チェックリスト

### タスクとテスト件数

| タスク | 内容                                 | 主なテストファイル                                                         | 期待 PASS |
| ------ | ------------------------------------ | -------------------------------------------------------------------------- | --------- |
| 4-0    | テスト基盤（Phase 3 の D1 を借りる） | `src/test/fixtures.test.ts`                                                | 13        |
| 4-1    | 定数・ロガー・環境型・HTTP エラー    | `src/db/constants-parity.test.ts`（30）/ `src/lib/http-error.test.ts`（7） | 37        |
| 4-2    | ブランド型 Actor                     | `src/auth/actor.test.ts` ＋ `src/auth/actor.type-test.ts`（tsc のみ）      | 11        |
| 4-3    | Actor ファクトリの閉じ込め検査       | `src/auth/actor-encapsulation.test.ts`                                     | 8         |
| 4-4    | error-handler ミドルウェア           | `src/middleware/error-handler.test.ts`                                     | 10        |
| 4-5    | DB クライアントと Better Auth 初期化 | `src/auth/auth.test.ts`                                                    | 11        |
| 4-6    | auth ミドルウェア                    | `src/auth/load-actor.test.ts`（14）/ `src/middleware/auth.test.ts`（11）   | 25        |
| 4-7    | role-guard ミドルウェア              | `src/middleware/role-guard.test.ts`                                        | 17        |
| 4-8    | 店舗リポジトリ                       | `src/repositories/shop-repository.test.ts`                                 | 39        |
| 4-9    | レビューリポジトリ                   | `src/repositories/review-repository.test.ts`                               | 25        |
| 4-10   | リポジトリ規約の機械検査             | `src/repositories/repository-convention.test.ts`                           | 25        |
| 4-11   | ルートとアプリ本体                   | `src/routes/routes.test.ts`                                                | 36        |
| 4-12   | ロール × エンドポイント網羅          | `src/routes/permission-matrix.test.ts`                                     | 58        |
| 4-13   | 他人のデータに触れない証明           | `src/routes/tenant-isolation.test.ts`                                      | 15        |
| 4-14   | RPC 契約とルート表の突合             | `src/routes/rpc-contract.test.ts`（14）＋ 4-12 への追記（16）              | 30        |
|        |                                      | **合計**                                                                   | **360**   |

**タスク数 15（4-0 〜 4-14）。**

> **件数は「実行されるテスト数」で数えている。** `it.each` は配列の要素ごとに 1 件、
> `for` で回して `it` を作っている箇所（4-12 の 13 エンドポイント × 4 閲覧者）は 52 件と数える。
> `src/auth/actor.type-test.ts` は vitest では 0 件（tsc が `@ts-expect-error` 7 件を検証する）なので
> 4-2 の 11 件には含めていない。`src/db/client.test.ts`（7 件）は Phase 3 の成果物なので表に無い。

### 全部通ったことの確認

```bash
npm run test -w @meshimap/api
npm run typecheck -w @meshimap/api
npm run format:check
```

`format:check` はリポジトリ全体の `**/*.{ts,tsx,js,json,md}` を見る。**この計画書自身も対象に
含まれるが、prettier 整形済みなので Phase 4 の作業で落ちることはない。** 他フェーズの計画書が
警告に出た場合はその担当者の未整形分であり、Phase 4 の完了条件とは無関係なので触らない。

### 設計上の合格条件

- [ ] `UserActor` / `OwnerActor` / `AdminActor` は `src/auth/actor.ts` の外で生成できない（Task 4-3 の `actor-encapsulation.test.ts` が PASS）
- [ ] リポジトリの全 export 関数が第 2 引数にブランド型 Actor を取る（Task 4-10 の機械検査が PASS）
- [ ] リポジトリ層に `db.transaction()` が 1 箇所も無い（Task 4-10 の機械検査が PASS）
- [ ] ルートハンドラに「この viewer はこの行を触ってよいか」を判定する `if` が無い
- [ ] 所有者判定はすべて SQL の `WHERE owner_id = ?` にある。アプリ側の比較で弾いている箇所が無い
- [ ] 401 / 403 / 404 の応答本文が固定文言のみ。例外メッセージ・スタックトレース・SQL・内部 ID を含まない
- [ ] 「他人の行」と「存在しない行」がバイト単位で同じ応答になる（Task 4-12 の 403/404 テストが PASS）
- [ ] `app.routes` の 10 本すべてが権限マトリクスで覆われている（Task 4-14 の突合が PASS）
- [ ] `index.ts` が `AppType` を export し、`hc<AppType>` が型付きで使える（Task 4-14 の型検査専用ブロックが `tsc` を通る）
- [ ] `wrangler dev` が起動し、`/health` `/shops` `/me` が手で叩けた（Task 4-14 Step 9）

---

## 未確認事項

計画中の記述は原則すべて `node_modules` の型定義を読むか Node で実行して裏取りした。
**以下は裏取りできなかった／裏取りの範囲が限られている項目。** 実装時に必ず再確認すること。

### A. 本番環境で未検証（ローカルの miniflare でしか確かめていない）

| #   | 事項                                                                                                                         | 状況                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | `ReservationLock` を classic 形式（`implements DurableObject`）で書き、`migrations[0].new_sqlite_classes` と組み合わせる判断 | miniflare 上では DO の `fetch` が 501 を返すところまで到達することを確認した。**本番の Cloudflare では未検証。** 起動しなければ `new_classes` への変更を検討する |
| A-2 | `PRAGMA ignore_check_constraints`（Task 4-5 の `corruptProfileRole`）                                                        | miniflare/workerd のローカル D1 では効いた。**本番 D1 で同じ挙動かは未検証。** テスト専用なので本番経路には影響しない                                            |
| A-3 | `wrangler dev` の起動そのもの（Task 4-14 Step 9）                                                                            | 計画時点では実行していない。**`.dev.vars` に `BETTER_AUTH_SECRET` が必要**。ここが Phase 4 で唯一、手で確認する工程                                              |
| A-4 | Better Auth のセッション Cookie が本番の HTTPS + `Secure` 属性下でモバイルから往復すること                                   | ローカル `http://localhost:8787` でしか確認していない                                                                                                            |

### B. 仕様上そうなるが、回避策が無いまま残るもの

| #   | 事項                                                                | 状況                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | Hono 4.13.7 の `validator` は RPC の入力型 = Zod の**出力**型になる | `hc<AppType>` が `.default()` を持つ列（`nameKana` / `description` / `phone` / `website` / `budget*Yen` / `budgetYen`）を**必須**として要求する。型引数の部分指定では直せない（`any` に落ちる）ことを `tsc` で確認済み。Phase 5 は明示的に送る |
| B-2 | 404 は `onError` が返すため `AppType` の型に現れない                | 「404 が返ること」を型で保証する手段が無い。実行時テストで担保する                                                                                                                                                                             |
| B-3 | `@ts-expect-error` は次の 1 行しか抑制しない                        | 複数行の呼び出しでは、エラーが実際に出る行の直前に置く必要がある（`TS2578` で確認済み）                                                                                                                                                        |

### C. リポジトリの現状に起因する未整備

| #   | 事項                                                                                     | 状況                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | **解消済み（2026-09-15）。** `apps/api/stryker.config.mjs` を追加した                    | 設定は `stryker.base.mjs` に集約し、api 固有なのは `mutate` の除外と `vitestArgs` の 2 つだけ（`timeoutMS` は既定の 10 秒のまま。`src/db/testing/local-d1.ts` を 1 往復にまとめてスイートが 18 秒まで縮んだので上乗せが要らなくなった）。Phase 4 **直前**の実測は 98 変異 / 100% / Survived 0 だが、Phase 4 **完了時**は 659 変異 / 86.95% になる。**Task 4-14 Step 8-b で流すのが Phase 4 の完了条件に入った**（`thresholds.break: 85`） |
| C-2 | **解消済み（2026-09-15）。** ルートに `eslint.config.mjs` と `lint` スクリプトを追加した | `packages/*` と `apps/api` が対象（`apps/mobile` は自前の設定があるので `ignores` で除外）。`no-console` を `error` で有効にしてあるので、**Task 4-1 に書いた `// eslint-disable-next-line no-console` は実際に抑制として働く**（同じ関数の別行に素の `console.log` を置くと `no-console` で落ちることを実測して確認済み）。CI の `lint` ジョブもルートと `apps/mobile` の 2 ステップに広げた                                             |
| C-3 | `apps/api/worker-configuration.d.ts` が存在しない                                        | `tsconfig.json` の `include` に書かれているが未生成。`npm run cf-typegen -w @meshimap/api` で作れるが、存在しなくても `tsc` は通る（実測 `EXIT=0`）。Phase 4 では生成しない                                                                                                                                                                                                                                                               |
| C-4 | `apps/api/tsconfig.json` の `types` に `"node"` が無い                                   | 現状は `["@cloudflare/workers-types", "vitest/globals"]`。Task 4-3 で `"node"` を足す（`node:fs` を使うソース走査テストのため）。この変更が `@cloudflare/workers-types` のグローバル型と衝突しないことは未検証                                                                                                                                                                                                                            |
| C-5 | `apps/api` に `vitest` / `typescript` / `@types/node` の devDependency が無い            | ルートから hoist されている。`npm run test -w @meshimap/api` は動くが、`apps/api` 単体で切り出すと壊れる                                                                                                                                                                                                                                                                                                                                  |
| C-6 | `apps/mobile/package.json` に `expo-network` が無い                                      | `@better-auth/expo@1.7.5` の peerDependencies は `expo-network >= 8.0.7` を要求している。Phase 5 でモバイル認証を組むときに追加が要る可能性が高い。**Phase 4 では `npm install` を実行しないため未対応**                                                                                                                                                                                                                                  |
| C-7 | `apps/mobile` は `@meshimap/api` に依存していない                                        | `hc<AppType>` を書くには `AppType` を import する必要がある。Phase 5 で依存追加か型の置き場所の決定が要る                                                                                                                                                                                                                                                                                                                                 |

### D. Phase 3 との並行作業に起因する不安定さ

| #   | 事項                                                                                                       | 状況                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | `shops` への書き込みで `meta.changes` が実数より大きく出る                                                 | FTS のトリガが数に乗る。実測: `INSERT` = 3、`UPDATE` = 5、`DELETE` = 3。**Phase 4 のリポジトリは `.returning()` で判定しているので影響しない**が、`runWrite` の戻り値で `shops` の行数を検証するテストを新しく書くときは注意する                                    |
| D-2 | `d1.exec()` の `count` が文の数と一致しない                                                                | 2 文渡しても `1`。件数の検証に使わない                                                                                                                                                                                                                              |
| D-3 | Phase 3 がマイグレーションを追加し続けている                                                               | 計画作成中に 2 回、`createMigratedD1()` が一時的に壊れた（`0001_shops_fts.sql` のコメント行、FTS トリガの列取り違え）。Phase 4 のテストが理由不明で落ちたら、まず `apps/api/migrations/` の変更を疑う                                                               |
| D-4 | `DISPLAY_NAME_MAX_LENGTH` が `src/db/schema/master.ts` の module-private（`const` で export されていない） | Phase 4 から import できない。Task 4-1 で `src/lib/constants.ts` の `PROFILE_DISPLAY_NAME_MAX_LENGTH` に**値を写す**（写しであることをコメントで明示し、生成 DDL と突き合わせるテストを置く）。Phase 3 側が値を変えたら `constants-parity.test.ts` が落ちて気付ける |

### E. テスト構成そのものの制約

| #   | 事項                                                                   | 状況                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-1 | Hono アプリは Node、D1 だけ workerd という分割構成                     | そのため `src/index.ts` は `cloudflare:workers` を import できない（`Cannot find module` で全テストが読み込めなくなる。実測済み）。将来 `@cloudflare/vitest-pool-workers` を入れればこの制約は消えるが、**Phase 4 では新規パッケージを入れない方針なので採らない** |
| E-2 | `crypto.randomUUID` / `scrypt` / `Date` の実挙動に依存するテストがある | サインアップ 1 回で 100ms 前後かかる。`vitest.config.ts` の `testTimeout: 30_000` / `hookTimeout: 60_000` に依存している                                                                                                                                           |
| E-3 | `roleGuard` を no-op にしても HTTP 層のテストは 1 件も落ちない         | `require*Actor` が同じ 401/403 を返す二重防御のため（実測済み）。**`roleGuard` 自体の検証は Task 4-7 の単体テストが担う。** 壊しの確認は必ず全体で回す                                                                                                             |

---

## 次フェーズへの引き継ぎ

| 引き継ぎ先                  | 内容                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 5（モバイル認証）     | `AUTH_BASE_PATH = '/api/auth'`。Better Auth の Cookie セッションをそのまま使う。`trustedOrigins` は `` `${MOBILE_APP_SCHEME}://` `` の形（`://` 必須。無いとどの URL とも一致しない）。`expo-network` の追加と `@meshimap/api` への依存追加が要る（未確認事項 C-6 / C-7） |
| Phase 5（API クライアント） | `hc<AppType>` を使う。`.default()` を持つ列も明示的に送る（未確認事項 B-1）。`features/*/api.ts` だけが `fetch` を呼ぶ規約（`docs/CODING_GUIDELINES.md` 3.2）に従い、クライアント生成はそこに閉じる                                                                       |
| Phase 6（店舗詳細・写真）   | 写真は R2。`AppBindings` に `PHOTOS: R2Bucket` を足す。R2 のキー規約は `shop-photos/<shopId>/<uuid>.webp`（`docs/CODING_GUIDELINES.md` 1.2）。Actor を取る規約は Phase 4 と同じ                                                                                           |
| Phase 7（予約）             | `src/index.ts` の `ReservationLock`（現状は 501 を返すだけ）を実装する。`state.storage.sql` を使う。classic 形式のままでよいかは未確認事項 A-1 の確認結果しだい                                                                                                           |
| Phase 9（運用・監査）       | 監査ログは `Actor` を受け取る形で入れる。`src/lib/logger.ts` の `logError` が `console.error` の唯一の出口になっているので、ここを差し替えれば送信先を変えられる                                                                                                          |
| 全フェーズ共通              | 新しいエンドポイントを足したら、**Task 4-12 の `ENDPOINT_CASES` に行を足さない限り Task 4-14 の突合テストが落ちる**。権限マトリクスの更新漏れはこの 1 本で止まる                                                                                                          |
