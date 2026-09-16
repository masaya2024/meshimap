# MeshiMap Phase 9: システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** システム管理者ロールの 13 画面と対応する管理 API を実装し、利用者 / 店舗オーナー / システム管理者の 3 ロールを揃える。

**Architecture:** 管理系の書き込みは `withAuditLog()` という 1 本の関数だけを通す。この関数は業務データの SQL 文と監査ログの INSERT を **1 回の `db.batch()`** にまとめて流す。D1 の `batch()` は 1 文でも失敗すれば全体がロールバックすることを実測済みなので、「業務データだけ変わって監査ログが無い」状態を DB のレベルで作れなくする。さらに TypeScript Compiler API によるソース走査で「`db.insert/update/delete` の実行を `withAuditLog` 以外から行うコード」をコンパイル対象のテストとして落とす。破壊的操作はすべて物理削除ではなく状態遷移で表し、`audit_logs.diff` に観測済みの前後値を残して取り消しの原資にする。

**Tech Stack:** Cloudflare Workers / Hono 4.13.7 / D1 (SQLite) / Drizzle ORM 0.45.2 / Better Auth 1.7.5 / Vitest 5.0.0 + miniflare 5 / Stryker 10 / Expo SDK 57 + expo-router / NativeWind 4.2.7 / TanStack Query v5 / React Hook Form 7.88 + Zod 4.6.5 / Jest 30 + jest-expo 57 + RNTL 14

---

## Global Constraints

Phase 4 / Phase 6 の計画書に書かれた制約をそのまま引き継ぐ。各タスクの要件にはこの節が暗黙に含まれる。

- **新しい npm パッケージを追加しない。** `package.json` に無い依存を import するタスクは 1 つも無い。
- **`any` 禁止。** `as` によるアサーション禁止（ブランド型の生成のみ例外。Phase 9 ではブランド型を新規に作らないので、`as` は `as const` 以外に 1 つも登場しない）。
- **`!`（non-null assertion）禁止。** Drizzle の `and()` / `or()` が `SQL | undefined` を返す箇所は `sql` テンプレートで書くか `undefined` のまま `.where()` に渡す。
- **default export 禁止。** 例外は `apps/api/src/index.ts` と expo-router の画面ファイルのみ。
- **`console.log` をコミットに含めない。**
- **マジックナンバー・マジックストリングの直書き禁止。** 定数として `UPPER_SNAKE_CASE` で定義する。
- **ファイル名 kebab-case / 変数・関数 camelCase / 型・コンポーネント PascalCase / 定数 UPPER_SNAKE_CASE。**
- **expo-router の動的セグメントは具体名。** `[id]` ではなく `[applicationId]` `[reportId]` `[userId]` `[shopId]`。
- **リポジトリ関数の第 1 引数は `db: Database`、第 2 引数は `actor` / `_actor` / `viewer` / `_viewer` のいずれかの名前で型は `UserActor` / `OwnerActor` / `AdminActor` / `Actor` / `Viewer` のいずれか。** Phase 4 Task 4-10 の `repository-convention.test.ts` が機械的に落とす。
- **`db.transaction(` 禁止。** D1 に対話的トランザクションが無い。同じく Phase 4 Task 4-10 が落とす。
- **エラーの body は `{ "error": { "status": 404, "message": "対象が見つかりません" } }` 形。メッセージは固定文言のみで、可変値を混ぜない。**
- **401 / 403 / 404 の使い分け:** 未認証は 401。リソース ID を見る前にロールだけで決まる拒否は 403。リソースごとの所有・可視性で拒否するときは 404（存在を漏らさないため）。`/admin/*` は全経路がロールだけで決まるので、非管理者には **ID の実在によらず 403** を返す。
- **テストの `describe` / `it` は日本語で、振る舞いを書く。** 境界値は必ず両側（上限ちょうどと上限 +1）を置く。
- **ミューテーションテストで生き残った変異への対応は 3 つだけ。** (a) テストの穴 → テストを足す、(b) 出力を変えない最適化 → 呼び出し回数などで縛る、(c) 到達不能 → 到達可能に書き換えて殺す。**「除外する」は選択肢に無い。** `stryker.config.mjs` の除外を増やしてよいのは「Stryker のサンドボックス外のファイルを読むテストだから」という理由だけ。
- **`apps/api` のカバレッジ閾値・`apps/mobile` の 100% 閾値を下げない。**
- **新しいテーブルを作らない。** `apps/api/src/db/schema/design-doc-sync.test.ts` が「スキーマの export しているテーブル名の集合」と「設計書 §6 のコードブロックに現れるテーブル名の集合」の一致を検査している（`collectExportedTableNames()` と `readDesignDocTableNames()`）。テーブルを足すと設計書の改訂が要る。Phase 9 は設計書を改訂しない。

---

## このフェーズで確認済みの事実（実測・実ファイル）

推測と実測を混ぜないために、計画時点で自分の手で確かめたことだけをここに置く。確かめていないものは末尾の「未確認事項」に分けてある。

### D1 の `batch()`（miniflare 5 / workerd の実 D1 に対して実測、2026-09-15）

| #   | 確かめたこと                                             | 結果                                                                                                                                                                           |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B-1 | バッチ内の 1 文が FK 違反で失敗したとき                  | `D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)` が投げられ、**バッチ全体がロールバックされる**（失敗後に数えた行数は 0） |
| B-2 | 成功したバッチの戻り値                                   | 文の数だけ `D1Result` が並ぶ。INSERT 1 行あたり `meta.changes === 1`                                                                                                           |
| B-3 | `INSERT OR IGNORE` を 2 回流したとき                     | 2 回目の `changes` は 0。冪等                                                                                                                                                  |
| B-4 | バッチのサイズ                                           | 100 文 → 9ms、500 文 → 31ms、1000 文 → 40ms。いずれも成功                                                                                                                      |
| B-5 | **空のバッチ**                                           | `D1_ERROR: No SQL statements detected.` で失敗する。文が 0 本のときは `batch()` を呼んではいけない                                                                             |
| B-6 | Drizzle の `db.batch([first, ...rest])`                  | 型が通る（`Readonly<[U, ...U[]]>` は非空タプル。`as` ではなく分割代入で満たす）                                                                                                |
| B-7 | Drizzle の `.onConflictDoNothing()` を含むバッチの再実行 | 行数が増えない。冪等                                                                                                                                                           |
| B-8 | INSERT と SELECT を混ぜたバッチ                          | 文ごとの結果が順番に返る                                                                                                                                                       |

### 型定義（node_modules を直接読んで確認）

- `node_modules/@cloudflare/workers-types/index.d.ts:14350` — `batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>`
- `node_modules/drizzle-orm/d1/driver.d.ts:9` — `batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>`
- `node_modules/drizzle-orm/batch.d.ts` — `export type BatchItem<TDialect extends Dialect = Dialect> = RunnableQuery<any, TDialect>`。**import 元は `drizzle-orm/batch`**

### Better Auth のユーザー ID

実際に発行された値は `IU6EHuiWGzSo4q4LT71aW8YMvX8EYOgV` で **32 文字**。お知らせ通知の決定的 ID を `ntf_`(4) + お知らせ ID(16) + `_`(1) + ユーザー ID(32) = **53 文字**で組むと `ck_notifications_id_length`（`length(id) <= 64`）に収まる。

### 既存スキーマ（`apps/api/src/db/schema/` を実際に開いて確認）

| テーブル            | Phase 9 が使う列                                                                                    | 効いてくる制約・索引                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`          | `userId`(PK) / `role` / `displayName` / `status` / `createdAt`                                      | `idx_profiles_role` のみ。`status` にも `displayName` にも索引は無い                                                                                                                                                                                     |
| `shops`             | `ownerId`（**nullable**, `on delete set null`） / `status` / `createdAt`                            | `idx_shops_owner_id`, `idx_shops_status_geohash`, `idx_shops_status_rating`                                                                                                                                                                              |
| `reviews`           | `status`（`published` / `hidden` / `deleted`）                                                      | `idx_reviews_shop_status_created`, `uq_reviews_shop_user`                                                                                                                                                                                                |
| `reports`           | `status` / `handledBy` / `handledAt` / `targetType` / `targetId`                                    | `idx_reports_status_created`, `uq_reports_reporter_target`, CHECK `ck_reports_handler_requires_time`（`handled_by IS NULL OR handled_at IS NOT NULL`）と `ck_reports_closed_requires_time`（`status IN ('open','in_review') OR handled_at IS NOT NULL`） |
| `shop_applications` | `applicantId` / `shopId` / `documents`(json) / `status` / `reviewedBy` / `reviewNote`               | `uq_shop_applications_shop_pending`（`status = 'pending'` の部分ユニーク索引）、CHECK `json_valid(documents) AND json_type(documents) = 'array'`                                                                                                         |
| `notifications`     | `userId` / `type` / `title` / `body` / `data`(json) / `readAt`                                      | `ck_notifications_type` が語彙を **`inValues(NOTIFICATION_TYPES)` で固定**、`ck_notifications_title_length <= 100`、`ck_notifications_body_length <= 500`                                                                                                |
| `audit_logs`        | `actorId`(nullable, `set null`) / `action` / `targetType` / `targetId` / `diff`(json) / `createdAt` | `idx_audit_logs_created`（`created_at desc`）, `idx_audit_logs_actor_created`, `idx_audit_logs_target`、CHECK `consistsOf(action, 'a-z0-9_.')`、`length(target_type) <= 32`                                                                              |
| `genres`            | `id` / `name` / `slug` / `iconKey` / `sortOrder`                                                    | `uq` on `slug`, CHECK `consistsOf(slug, 'a-z0-9-')`, `sort_order >= 0`                                                                                                                                                                                   |
| `areas`             | `id` / `name` / `parentId`（自己参照, `set null`） / `prefecture`                                   | `idx_areas_parent_id`                                                                                                                                                                                                                                    |

`shops.genreId` / `shops.areaId` は `on delete restrict`（`apps/api/src/db/schema/shop.ts`）。使用中のマスタは DB が削除を拒む。

### すべての ID 列の CHECK は「長さ 64 以下」だけ

`grep -n "id_length" apps/api/src/db/schema/*.ts` で確認。`ck_<table>_id_length` は例外なく `lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)`（= 64）で、**書式の CHECK は無い**。よって `aud_` + UUID のハイフンを除いた 32 文字 = 36 文字の ID を新たに使ってよい。

### Hono 4.13.7 のルート登録（`apps/api` の node_modules を使って実測、2026-09-15）

`app.routes` からルート定義を機械的に取り出せることを確かめた。Task 9-16 の「表とルート定義の照合」はこれに依存する。

```bash
cd /Users/hattori/Downloads/alee/apps/api
node --input-type=module -e "..."   # Hono を組み立てて app.routes と app.request を見る
```

| #   | 確かめたこと                                                                                                                  | 結果                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 | 子ルータの `get('/')` を `route('/applications', sub)` で載せ、さらに `route('/admin', admin)` したときの `app.routes[].path` | `/admin/applications`（**末尾スラッシュは付かない**）                                                                                                |
| H-2 | `get('/:id')` / `post('/:id/approve')`                                                                                        | `/admin/applications/:id` / `/admin/applications/:id/approve`。パラメータ名は宣言どおり残る                                                          |
| H-3 | `admin.use('*', mw)` の現れ方                                                                                                 | `{ method: 'ALL', path: '/admin/*' }` の 1 行。**表と照合するときは `method === 'ALL'` を除く必要がある**                                            |
| H-4 | `admin.use('*', mw)` を `admin.route(...)` より**先**に登録したとき、子ルータ配下のリクエストで mw が走るか                   | 走る（`/admin/applications`・`/admin/applications/abc` の両方で走った）                                                                              |
| H-5 | `/admin/nope`（未定義パス）でも mw が走るか                                                                                   | **走る**。つまり未ログインで未定義の `/admin/*` を叩くと、404 ではなく門番の 401 が先に返る。ハーネスの 404 テストは**ログイン済み管理者で**叩くこと |
| H-6 | `/admin/applications/`（末尾スラッシュ）                                                                                      | 404（`notFound` ハンドラへ落ちる）                                                                                                                   |

### `check-constraints.test.ts` の作りと、そこから出る制約

`apps/api/src/db/schema/check-constraints.test.ts` は

- `collectDrizzleChecks()` が `schema/index.ts` の全テーブルの CHECK を `SQLiteSyncDialect` で描画し、
- `MIGRATION_SQL`（= `readMigrationSql()`。`migrations/*.sql` を**全部連結**したもの）に**その文字列がそのまま含まれるか**を照合し、
- さらに `DRIZZLE_CHECKS.length` と `countChecksInMigration()`（連結後の SQL に現れる `CONSTRAINT "ck_..." CHECK(` の出現数）の一致、
- `DRIZZLE_CHECKS` の名前一覧と `constraintNamesInMigration()`（**`0000_init.sql` 単体**を読む）の一致

を見ている。つまり **既存テーブルの CHECK を変えるマイグレーションを足すと、この 3 本すべてが落ちる**。drizzle-kit が SQLite の CHECK 変更に対して出すのはテーブル再構築（`CREATE TABLE __new_notifications ... CONSTRAINT "ck_notifications_type" CHECK("__new_notifications"."type" IN (...))`）で、描画側の `"notifications"."type"` と文字列が一致しないうえ、CHECK の出現数が二重に数えられるため。この事実は設計判断 4（お知らせ・警告の通知型）の根拠になる。

### expo-router 57.0.21 の実体（`node_modules` の型定義を直接読んだ。2026-09-16）

AGENTS.md に「Expo HAS CHANGED」とあるので、画面を書く前に入っている型定義を読んだ。

| #   | 確かめたこと                          | 結果（読んだファイル）                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1 | `import { Tabs } from 'expo-router'`  | **非推奨**。`build/exports.d.ts:44` に `@deprecated Use \`import { Tabs } from 'expo-router/js-tabs'\` instead.` と明記されている。`expo-router/js-tabs`は`build/layouts/Tabs` を再輸出しているだけで**中身は同一**（`js-tabs.d.ts`）。Phase 9 のタブは `expo-router/js-tabs` から取る                                                                                                         |
| E-2 | `Tabs` の形                           | `build/layouts/TabsClient.d.ts` の末尾。`Tabs` 本体に加えて `Tabs.Screen`（`name` / `options`）と `Tabs.Protected`（`{ guard: boolean }`）を持つ                                                                                                                                                                                                                                               |
| E-3 | `import { Stack } from 'expo-router'` | 非推奨ではない。`build/stack/index.d.ts` が `build/layouts/Stack`（ネイティブスタック）を輸出する。`expo-router/js-stack` は別物（JS 実装）なので取り違えない                                                                                                                                                                                                                                  |
| E-4 | `Redirect`                            | `build/link/Redirect.d.ts`。`{ href: Href; relativeToDirectory?: boolean; withAnchor?: boolean }` を取り、**戻り値は `null`**（描画せずに副作用で遷移する）                                                                                                                                                                                                                                    |
| E-5 | `useRouter` / `useLocalSearchParams`  | `build/exports.d.ts:2` で `./hooks` から輸出。`Link` は `build/link/index.d.ts` 経由で `expo-router` から取れる                                                                                                                                                                                                                                                                                |
| E-6 | `Href` の中身                         | `build/typed-routes/types.d.ts` の `export type Href<T extends ExpoRouter.__routes = ExpoRouter.__routes> = T extends { href: any } ? T['href'] : string \| HrefObject;`。`ExpoRouter.__routes` は既定で空インターフェイスで、`.expo/types/router.d.ts` が生成されたときだけ `href` を持つ形に拡張される。**つまり `.expo/types/` が無い環境では `Href` は `string \| HrefObject` に退化する** |
| E-7 | いま `.expo/types/` は無い            | `ls apps/mobile/.expo` の結果は `cache` と `dev` だけ（2026-09-15 実測）。さらに `.expo/` は gitignore されている（`apps/mobile/.gitignore:7`）。`apps/mobile/tsconfig.json` の `include` には `".expo/types/**/*.ts"` が入っているが、実体が無いので現状の `npm run typecheck` はルート文字列を検査していない                                                                                 |
| E-8 | 存在しないルート文字列は通る          | E-6・E-7 を踏まえ、スクラッチの ts ファイルで実測（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 等を同じにして `tsc --noEmit`）。`{ typo: '/this/route/does/not/exist' } as const satisfies Record<string, Href>` は**エラーにならず exit 0**。ルートの綴りは型では守られないので、Task 9-24 でファイルの実在をテストで確かめる                                          |

**画面テストでの扱い。** `apps/mobile/jest-setup.ts` に expo-router のモックは**無い**（実ファイルで確認）。よって `useRouter` を使う画面のテストでは、そのテストファイルで `jest.mock('expo-router', ...)` する。`src/app/` 配下は薄くしてあるので、モックが要るのは `src/features/admin/screens/` の一部だけで済む。

---

## 他フェーズから受け取るもの

Phase 4 の一部は**すでにリポジトリに実体がある**。下表の「状態」列は 2026-09-15 時点で `find apps/api/src -name '*.ts'` と実ファイルの `grep` で確認した結果であり、**実体があるものは形をこちらが合わせる**（Phase 4 の契約が正）。「未実装」のものは Phase 9 の着手条件になる。

| 受け取る先 | 名前                                                                                                                                                                                                                                                                                                     | 状態           | 形                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4    | `apps/api/src/db/client.ts` の `Database` / `createDatabase`                                                                                                                                                                                                                                             | 実体あり       | `DrizzleD1Database<typeof schema>`                                                                                                                                                                                                                                                                                               |
| Phase 4    | `apps/api/src/auth/actor.ts` の `Actor` / `AdminActor`                                                                                                                                                                                                                                                   | 実体あり       | `Actor = UserActor \| OwnerActor \| AdminActor` の判別可能ユニオン。判別子は `role`。`AdminActor = { readonly role: 'admin'; readonly userId: UserId; readonly [actorBrand]: true }`                                                                                                                                             |
| Phase 4    | 同 `Viewer`                                                                                                                                                                                                                                                                                              | 実体あり       | **`Viewer = Actor \| AnonymousActor`**。`AnonymousActor` は `role: 'anonymous'` / `userId: null`。`{ kind: 'anonymous' }` のような入れ子ではない                                                                                                                                                                                 |
| Phase 4    | 同 `toActor(userId, role)` / `ANONYMOUS_VIEWER` / `isUserActor` / `isOwnerActor` / `isAdminActor` / `isAuthenticatedActor`                                                                                                                                                                               | 実体あり       | `toActor` は Actor の唯一の生成点。**import 元は `auth/actor-encapsulation.test.ts` の `ACTOR_FACTORY_ALLOWLIST`（`auth/load-actor.ts` / `middleware/auth.ts` / `test/fixtures.ts`）に限られる**。`.test.ts` と `.type-test.ts` は検査対象外                                                                                     |
| Phase 4    | `apps/api/src/lib/app-env.ts` の `AppBindings` / `AppVariables` / `AppEnv`                                                                                                                                                                                                                               | 実体あり       | `AppVariables = { readonly viewer: Viewer }`。`AppEnv = { Bindings: AppBindings; Variables: AppVariables }`                                                                                                                                                                                                                      |
| Phase 4    | `apps/api/src/lib/http-error.ts`                                                                                                                                                                                                                                                                         | 実体あり       | `unauthorized()` 401 / `forbidden()` 403 / `notFound()` 404 / `invalidInput()` 422 が `HTTPException` を返す。**409 は無いので Task 9-0 で足す**                                                                                                                                                                                 |
| Phase 4    | `apps/api/src/middleware/error-handler.ts` の `errorHandler` / `notFoundHandler`                                                                                                                                                                                                                         | 実体あり       | `HTTPException` を `{ error: { status, message } }` に変換する唯一の出口                                                                                                                                                                                                                                                         |
| Phase 4    | `apps/api/src/middleware/role-guard.ts` の `roleGuard(...roles)` / `requireAdminActor(c)`                                                                                                                                                                                                                | 実体あり       | `roleGuard` は未認証 401・ロール不一致 403。`requireAdminActor` は `Context<AppEnv>` から `AdminActor` を絞り込んで返す。**Phase 9 は門番を新規作成しない**                                                                                                                                                                      |
| Phase 4    | `apps/api/src/middleware/auth.ts` の `authMiddleware`                                                                                                                                                                                                                                                    | 実体あり       | `c.set('viewer', ...)` を置く。`profiles.status = 'suspended'` は `forbidden()` で弾く                                                                                                                                                                                                                                           |
| Phase 4    | `apps/api/src/test/fixtures.ts` の `createTestWorld` / `createTestBindings` / `seedMasters` / `seedUser` / `seedShop` / `seedReview` / `signUpAs` / `readRow` / `countRows` / `runWrite` / `rejectionMessageOf` / `TEST_GENRE_ID` / `TEST_AREA_ID` / `TEST_GEOHASH` / `TEST_LATITUDE` / `TEST_LONGITUDE` | 実体あり       | 実 D1（miniflare）。Phase 9 のリポジトリテストとルートテストはこれを土台にする                                                                                                                                                                                                                                                   |
| Phase 4    | 同 `buildActorForTest(userId, role)` / `userActorOrThrow` / `ownerActorOrThrow` / `adminActorOrThrow`                                                                                                                                                                                                    | 実体あり       | HTTP を通さずにリポジトリだけを検証するときの Actor 生成。**Phase 9 の新規ファイルはここを経由する**（`toActor` の直接 import はホワイトリスト外）                                                                                                                                                                               |
| Phase 4    | `apps/api/src/index.ts` の `app` / `AppType`                                                                                                                                                                                                                                                             | 実体あり       | **実測: 20-31 行は `new Hono<AppEnv>()` から始まる単一のメソッドチェーン**（`.onError` → `.notFound` → `.on` → `.use` → `.get` → `.route` ×3）。18 行目に「途中で変数に切ると `AppType` が痩せる」と明記がある。Phase 9 は**チェーンの末尾に `.route('/admin', adminRoutes)` を足す**。`app.route(...)` という独立文にしないこと |
| Phase 4    | `apps/api/src/routes/permission-matrix.test.ts`                                                                                                                                                                                                                                                          | 実体あり       | **実測: 628 行で実在する。** `EXPECTED_ROUTE_PATTERNS`（Phase 4 時点で 10 本）を `toEqual` で固定し、`collectEndpointPatterns` / `collectRouteCoverageViolations` で `app.routes` と双方向に突き合わせている。**Task 9-17 で `/admin` を生やすと必ず落ちる**ので、Task 9-17 の Files: に `Modify` として入れてある               |
| Phase 4    | `apps/api/src/repositories/repository-convention.test.ts` の `collectConventionViolations`                                                                                                                                                                                                               | 実体あり       | **実測: 235 行に `export function collectConventionViolations(sourceFile: ts.SourceFile, label: string): string[]` が実在する。`findConventionViolations` という export は存在しない。** Phase 9 の admin リポジトリもこの検査に乗る                                                                                             |
| Phase 5    | `apps/mobile/src/lib/api-client.ts` の `apiFetch(path, options)`                                                                                                                                                                                                                                         | **未実装**     | `{ method, searchParams, body }` を受け、JSON を返す                                                                                                                                                                                                                                                                             |
| Phase 5    | `apps/mobile/src/features/auth/` の `useSession()`                                                                                                                                                                                                                                                       | 型のみ実体あり | `AuthState`（`apps/mobile/src/features/auth/types.ts` に実体あり）を返す                                                                                                                                                                                                                                                         |
| Phase 5    | `apps/mobile/src/app/(admin)/_layout.tsx` と `(admin)/(tabs)/_layout.tsx`                                                                                                                                                                                                                                | **未実装**     | ロールで入口を振り分けるシェル。Phase 9 は**タブの中身だけ**を作る                                                                                                                                                                                                                                                               |
| Phase 6    | `apps/mobile/src/lib/query-client.ts` の `createQueryClient`                                                                                                                                                                                                                                             | **未実装**     | TanStack Query の既定設定（`mutations.retry: false`）                                                                                                                                                                                                                                                                            |

**着手条件の確認コマンド。** Phase 9 の最初に必ず流す。

```bash
cd /Users/hattori/Downloads/alee
ls apps/api/src/index.ts apps/api/src/routes/permission-matrix.test.ts apps/api/src/repositories/repository-convention.test.ts
ls apps/mobile/src/lib/api-client.ts apps/mobile/src/lib/query-client.ts
ls "apps/mobile/src/app/(admin)/_layout.tsx"
```

すべて存在すること。欠けている場合、その依存を使うタスク（`apps/api/src/index.ts` は Task 9-17、モバイルは Task 9-19 以降。Task 9-18 は既存のプリミティブだけで完結するので先行できる）には着手できない。Task 9-0 〜 9-16 のうち `apps/api/src/index.ts` に触れない範囲は、上の「実体あり」だけで完結するので先行して進められる。

---

## 設計判断

### 1. 監査ログの記録漏れを機械的に塞ぐ（Phase 9 の肝）

「管理者が何かしたら監査ログを書く」は、人の注意力に任せた瞬間に必ず抜ける。抜けても**テストは緑のまま**なのが最悪で、抜けたことに気づく機会が無い。次の 4 段で塞ぐ。「気をつける」は 1 段も含まない。

**第 1 段（実行時・DB の性質）— 書き込みと監査行を同じ `batch()` に入れる。**
`withAuditLog(db, actor, spec, statements)` は、渡された業務データの SQL 文の**末尾に監査ログの INSERT を自分で足して**、1 回の `db.batch()` で流す。B-1 で実測したとおり D1 の `batch()` は 1 文でも失敗すれば全体がロールバックするので、「業務データが書き換わったのに監査行が無い」という状態は DB のレベルで発生しない。逆向き（監査行だけ残って業務データが変わらない）も同じ理由で起きない。

**第 2 段（静的・ソース走査）— 監査経路以外からの書き込みをコンパイル対象のテストで落とす。**
`apps/api/src/repositories/admin-audit-convention.test.ts` が TypeScript Compiler API で `src/repositories/admin-*.ts` を走査し、5 つの規約違反を集める。

1. `db.insert(...)` / `db.update(...)` / `db.delete(...)` から始まる式を **`await` する / `.run()` `.all()` `.get()` `.values()` `.execute()` `.then()` を呼ぶ** — 禁止。ビルダーは「作るだけ」で、実行は `withAuditLog` に渡した先でしか起きない。
2. `db.batch` / `db.run` / `db.transaction` / `db.$client` の直接参照 — 禁止。実行系の入口を 1 つに絞る。
3. 書き込みビルダーを含む export された関数が、同じ関数の中で `withAuditLog` か `withAuditLogChunked` を呼んでいない — 違反。
4. `withAuditLog` / `withAuditLogChunked` が `../lib/audit-log` からの import でない（ローカルで同名を定義して差し替えている） — 違反。
5. **export されていない関数が書き込みビルダーを含んでいる** — 違反。書き込みを private ヘルパへ切り出すと、export 関数から書き込みが見えなくなり、第 4 段の網羅照合をすり抜けられてしまう。多少重複しても、書き込みは必ず export された関数の中に直接書く。

これで「書き込みを実行する手段が `withAuditLog` しか無い」状態を作る。Phase 4 Task 4-10 の `repository-convention.test.ts` と同じ作り方（`ts.createSourceFile` で走査し、違反文字列の配列を返す関数を export して、`__fixtures__/*.ts.txt` の擬似ソースで検査器自身をテストする）を踏襲する。

**第 3 段（実行時・網羅）— 「全部の書き込み関数が本当に 1 行足す」を実 D1 で確かめる。**
`apps/api/src/repositories/admin-audit-coverage.test.ts` が、管理系の書き込み関数を**表**にして 1 つずつ実 D1 に対して呼び、呼び出し前後で `audit_logs` の件数が期待どおり増えることを見る。

**第 4 段（第 3 段の表自体の網羅）— 表への書き忘れを落とす。**
第 3 段の表に書き忘れたら第 3 段は素通りしてしまうので、第 2 段の AST 走査で得た「書き込みビルダーを含む export 関数名の集合」と、表に並んだ関数名の集合が**一致する**ことを同じテストで検査する。新しい管理操作を足して表に書き忘れると、この検査が落ちる。

**残る穴と、それを穴のままにする理由。** D1 に対話的トランザクションが無いので「読んで → 判断して → 書く」の間に他の管理者が同じ対象を書き換える可能性は消せない。Phase 9 は UPDATE の `WHERE` に**観測した前状態を再掲する**（楽観ロック）ことで二重適用そのものは防ぐが、2 人目の操作は「0 行更新 + 監査行 1 行」で終わる。これは監査ログの意味（「誰がいつ何をしようとしたか」）として正しいので許容する。`diff` には**事前 SELECT で実際に観測した値**を入れるので、後から突き合わせれば空振りだったと分かる。

### 2. 権限の強さ — 「所有チェックが無いコード」を他ロールから絶対に触らせない

管理者は、他人のデータを正面から触ってよい唯一のロールである。つまり Phase 9 のリポジトリには **`WHERE owner_id = ?` が付かない SQL** が入る。これが user / owner トークンから到達できてしまうと、所有チェックの欠落がそのまま権限昇格になる。

- 入口は Phase 4 が既に作った `apps/api/src/middleware/role-guard.ts` の **`roleGuard(ROLE_ADMIN)` を `/admin` 配下へ一括適用**する（ルートごとに書かない。書き忘れが起きる）。Phase 9 で新しい門番を作らないのは、「認可の分岐が 2 か所にある」状態そのものが事故の元だから。実ファイルを読んで確認した挙動は、未認証 → `unauthorized()`（401）、ロール不一致 → `forbidden()`（403）で、Phase 9 が必要とするものと完全に一致する。
- ハンドラ内で `AdminActor` が要るところは、同じファイルの **`requireAdminActor(c)`** を使う。これは `isAuthenticatedActor` → `isAdminActor` の順に絞り込んで `AdminActor` を返すので、Phase 9 に `as` も新しいブランド型の生成も出てこない。`roleGuard` を付け忘れたルートがあっても `requireAdminActor` が同じ 403 を投げるため、二重の防御になっている。
- Phase 4 Task 4-12 の権限行列テストを拡張し、**admin の全 32 エンドポイント × 4 視点（anonymous / user / owner / admin）= 128 ケース**を表で回す。非管理者に対しては**リソース ID が実在しても 403**（`/admin/*` はロールだけで拒否が決まるため）。この「実在する ID で試す」ところが肝で、存在しない ID だけで試すと 404 と 403 の取り違えを見逃す。
- 門番が本当に全ルートに掛かっているかは、権限行列の 128 ケース自体が担保する。エンドポイントを足して表に書き忘れると、Task 9-14 の「ルート定義から集めたパスの集合 = 表のパスの集合」検査が落ちる。

### 3. 破壊的操作の取り消し可能性 — 既存スキーマで足りる（マイグレーション不要）

`apps/api/src/db/schema/` を実際に開いて 1 つずつ確認した結果、Phase 9 の破壊的操作は**すべて物理削除ではなく状態遷移で表せる**。新しい列もテーブルも要らない。

| 操作                              | 表し方                                   | 戻し方                                                                  | 根拠                                                                             |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 店舗の強制非公開                  | `shops.status = 'suspended'`             | 直前の `shop.suspend` 監査行の `diff.status[0]`（= 停止前の状態）へ戻す | `SHOP_STATUSES` に `suspended` がある（`constants.ts`）                          |
| ユーザーの停止                    | `profiles.status = 'suspended'`          | `'active'` へ戻す。`'deleted'` は対象外にして上書きしない               | `PROFILE_STATUSES = ['active','suspended','deleted']`                            |
| オーナー付け替え                  | `shops.ownerId` の更新（`null` も可）    | `diff.ownerId[0]` へ戻す                                                | `ownerId` は nullable（「申請前やオーナー付け替え中は NULL」というコメント付き） |
| レビューの非表示                  | `reviews.status = 'hidden'`              | `'published'` へ戻す                                                    | `REVIEW_STATUSES` に `hidden` がある                                             |
| ロール変更                        | `profiles.role` の更新                   | `diff.role[0]` へ戻す                                                   | `ROLES`                                                                          |
| マスタ（ジャンル / エリア）の削除 | **物理削除**。ただし使用中は削除できない | `diff` に残した行全体から再 INSERT                                      | `shops.genreId` / `shops.areaId` が `on delete restrict`                         |

取り消しの原資は `audit_logs.diff`（`Readonly<Record<string, readonly [unknown, unknown]>>` = 列名 → `[前, 後]`）1 本に集約する。取り消し自体も破壊的操作なので `withAuditLog` を通し、`audit.undo` という新しい監査行を積む（**元の監査行は消さない。追記専用**）。現在値が `diff` の「後」と一致しないときは 409 を返して何もしない（その間に別の操作が入っている）。

マスタ削除だけが物理削除だが、(a) `on delete restrict` により使用中は DB が拒む、(b) アプリ側でも事前に使用件数を数えて 409 を返す、(c) `diff` に削除した行の全列を `[値, null]` の形で残すので再 INSERT で戻せる、の 3 段で扱う。

**結論: 取り消し可能性のためのマイグレーションは不要。**

### 4. お知らせ配信の宛先と、途中失敗時の一貫性

宛先は 3 種類。`{ kind: 'all' }` / `{ kind: 'role'; role }` / `{ kind: 'users'; userIds }`。

**N 件の INSERT をどう流すか。** B-4 のとおり `batch()` は 1000 文でも通ったが、実 D1（miniflare ではない本番）の上限は測っていないので **100 文で刻む**。受信者は `user_id` の昇順に固定して並べる（並びが決まっていないと、後述の再開が「どこまで進んだか」を意味しなくなる）。

**D1 に対話的トランザクションが無い以上、チャンクをまたいだ原子性は作れない。** 作れないものを作れるように書かないで、代わりに**冪等 + 再開可能**にする。

1. 通知の ID を**決定的**に組む。`buildNotificationId(announcementId, userId)` = `ntf_${announcementId}_${userId}`。`announcementId` は 16 文字でクライアントが 1 回だけ生成し、再送時も同じ値を使う。53 文字なので `length(id) <= 64` に収まる（実測したユーザー ID 32 文字を前提。長いユーザー ID が来たら ID 組み立ての時点で例外にする）。
2. 各 INSERT に `.onConflictDoNothing()` を付ける（B-7 で冪等性を実測済み）。チャンク 3 で落ちて再送しても、チャンク 1・2 は素通りしてチャンク 3 から実際の書き込みが進む。
3. **監査行は最後のチャンクと同じ `batch()` に入れる。** したがって「`announcement.send` の監査行が存在する ⇔ 全チャンクが流れ切った」が成り立つ。途中で落ちれば監査行は無く、未完了だと機械的に判別できる。
4. 送信前に `audit_logs` を `action = 'announcement.send'` かつ `target_id = announcementId` で引き、すでにあれば**書き込まずに** `already-sent` を返す（二重送信の防止）。
5. **受信者 0 件は `batch()` を呼ぶ前に弾く**（B-5 のとおり空バッチは `No SQL statements detected.` で落ちる）。422 を返す。

**警告通知（`reports/[reportId].tsx` の「警告」）について。** `notifications.type` の語彙に `warning` は無く、`ck_notifications_type` が `inValues(NOTIFICATION_TYPES)` で DB レベルに固定されている。新設するとテーブル再構築のマイグレーションになり、上で述べたとおり `check-constraints.test.ts` の 3 本（DDL 文字列一致 / CHECK 個数 / CHECK 名一覧）がまとめて落ちてテスト側の作り直しまで波及する。Phase 9 の主題から外れ、影響も大きいので **警告は `announcement` 型の通知（タイトル固定「運営からの警告」、`data` に `reportId`）+ `report.warn` の監査行**で表す。専用の型が欲しくなったときに要る作業は「`constants.ts` に定数追加 → `schema/admin.ts` は自動追従 → `drizzle-kit generate` → `check-constraints.test.ts` の照合方式を再構築後のテーブル名に耐える形へ作り替え」の 4 点で、Phase 9 の範囲外だと明示しておく。

### 5. 監査ログ画面のページング — オフセットではなくカーソル（キーセット）

**カーソル方式を採る。** 理由は 2 つで、どちらも監査ログ特有の性質から来る。

- **表が増え続ける。** 監査ログは追記専用で、削除も更新もしない。`LIMIT 20 OFFSET 10000` は SQLite に 10000 行を読み飛ばさせる（`OFFSET` は行を数えるためにインデックスを実際に辿る）。深いページほど線形に遅くなり、D1 の 1 クエリあたりの行スキャン上限にもぶつかる。
- **先頭に挿入され続ける。** 管理者が操作するたびに `created_at desc` の先頭へ行が増える。オフセット方式では、2 ページ目を取りに行く間に 3 行増えると **1 ページ目の末尾 3 件が 2 ページ目の先頭に再登場する**。監査という用途で同じ行を二度見せるのは致命的で、逆に減る方向の操作があれば取りこぼす。

キーは `(created_at DESC, id DESC)`。`created_at` だけでは同一ミリ秒に複数行入ったときに順序が決まらない（`batch()` は 1 ミリ秒に複数行を書く）ので、ID を第 2 キーに足して全順序にする。述語は
`(created_at < :c) OR (created_at = :c AND id < :i)`。
既存の `idx_audit_logs_created`（`created_at desc`）が先頭列を賄う。カーソル文字列は `` `${createdAtMs}:${id}` `` で、URL に載せる（Base64 にはしない。中身が読めたところで害が無く、読めたほうが障害調査が早い）。

同じ仕組みを審査キュー・通報キュー・ユーザー一覧・お知らせ履歴にも使う（`src/lib/cursor.ts` に 1 つ置いて共有する）。

---

## ファイル構成

### `apps/api`

| ファイル                                                                                        | 責務                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/audit-log.ts`                                                                          | **監査ログ付き書き込みの唯一の経路。** `withAuditLog` / `withAuditLogChunked` / `toNonEmptyBatch` / `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES` |
| `src/lib/cursor.ts`                                                                             | カーソルページングの符号化・復号・キーセット述語・ページ組み立て                                                                           |
| `src/lib/identifier.ts`                                                                         | 接頭辞付き ID の生成（`createPrefixedId` / `ID_PREFIXES`）                                                                                 |
| `src/lib/admin-outcome.ts`                                                                      | 管理系書き込みの結果値（`ok` / `not-found` / `conflict`）                                                                                  |
| `src/db/testing/admin-world.ts`                                                                 | 管理系テスト共通の初期データ（`createAdminWorld`）。Phase 4 の `src/test/fixtures.ts` の上に積む                                           |
| `src/lib/http-error.ts`（Modify）                                                               | 409（`conflict`）を足す                                                                                                                    |
| `src/repositories/admin-stats-repository.ts`                                                    | 全体 KPI の集計                                                                                                                            |
| `src/repositories/admin-application-repository.ts`                                              | 店舗申請の一覧 / 詳細 / 承認 / 差し戻し / 却下                                                                                             |
| `src/repositories/admin-report-repository.ts`                                                   | 通報の一覧 / 詳細 / 対応 / 却下 / 警告                                                                                                     |
| `src/repositories/admin-user-repository.ts`                                                     | ユーザー検索 / 詳細 / 停止 / 再開 / ロール変更                                                                                             |
| `src/repositories/admin-shop-repository.ts`                                                     | 店舗の強制非公開 / 再公開 / オーナー付け替え                                                                                               |
| `src/repositories/admin-master-repository.ts`                                                   | ジャンル・エリアの CRUD                                                                                                                    |
| `src/repositories/admin-announcement-repository.ts`                                             | お知らせ配信（チャンク分割 batch）と配信履歴                                                                                               |
| `src/repositories/admin-audit-repository.ts`                                                    | 監査ログの一覧（カーソル）と取り消し                                                                                                       |
| `src/repositories/admin-audit-convention.test.ts`                                               | 監査経路の静的検査（TS Compiler API）。AST ヘルパを export する                                                                            |
| `src/repositories/admin-audit-coverage.test.ts`                                                 | 監査記録の網羅検査（実 D1 + 表の網羅性照合）                                                                                               |
| `src/repositories/__fixtures__/audit-*-repo.ts.txt`（6 本）                                     | 検査器自身のテスト用の擬似ソース                                                                                                           |
| `src/routes/admin/schemas.ts`                                                                   | 管理 API のリクエスト Zod スキーマ                                                                                                         |
| `src/routes/admin/respond.ts`                                                                   | 管理 API の固定エラー応答                                                                                                                  |
| `src/routes/admin/index.ts`                                                                     | `/admin` 配下のルート集約。**Phase 4 の `roleGuard(ROLE_ADMIN)` をここで一括適用**                                                         |
| `src/routes/admin/{stats,applications,reports,users,shops,masters,announcements,audit-logs}.ts` | 各リソースのルート                                                                                                                         |

### `apps/mobile`

| ファイル                                                | 責務                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/components/ui/confirm-dialog.tsx`                  | 破壊的操作の確認ダイアログ（**新規プリミティブ**）                                     |
| `src/components/ui/select-field.tsx`                    | 選択肢から 1 つ選ぶ入力（**新規プリミティブ**）                                        |
| `src/components/ui/segmented-control.tsx`               | キューの状態絞り込み（**新規プリミティブ**）                                           |
| `src/features/admin/types.ts`                           | 管理 API のレスポンス Zod スキーマと、そこから導いた型                                 |
| `src/features/admin/labels.ts`                          | 状態値・操作名の日本語表示（`Record<語彙, string>`）                                   |
| `src/features/admin/api.ts`                             | 管理 API の呼び出し。**`apiFetch` を呼んでよいのはここだけ**                           |
| `src/features/admin/queries.ts`                         | クエリキーと TanStack Query のフック 30 本                                             |
| `src/features/admin/components/admin-list-screen.tsx`   | 読み込み / 空 / 失敗 / 追加読み込みを持つ汎用一覧。キュー 4 画面が共有する             |
| `src/features/admin/components/admin-detail-screen.tsx` | 読み込み / 失敗 / 本体の出し分けを持つ汎用詳細。詳細 4 画面が共有する                  |
| `src/features/admin/components/action-row.tsx`          | 「説明 + ボタン 1 個」の操作行。詳細画面の破壊的操作に使う                             |
| `src/features/admin/components/action-panel.tsx`        | 操作行の束と確認ダイアログ 1 枚。**破壊的操作が確認を通ることをここ 1 箇所で保証する** |
| `src/features/admin/components/detail-field.tsx`        | 詳細画面のラベル + 値の 1 行                                                           |
| `src/features/admin/components/stat-card.tsx`           | KPI 1 枚                                                                               |
| `src/features/admin/components/audit-log-row.tsx`       | 監査ログ 1 行（誰が / いつ / 何を / 差分）                                             |
| `src/features/admin/components/master-editor.tsx`       | ジャンル / エリアで共有する一覧 + 編集フォーム                                         |
| `src/features/admin/screens/*.tsx`（13 本）             | 画面本体。**テストとカバレッジの対象はこちら**                                         |
| `src/features/admin/testing/query-wrapper.tsx`          | 画面テスト共通の `QueryClientProvider` ラッパ                                          |
| `src/features/admin/routes.ts`                          | 管理画面のルート定義。パス文字列を書いてよいのはここだけ                               |
| `src/features/admin/format.ts`                          | 日時と差分値の整形                                                                     |
| `src/features/admin/components/filter-options.ts`       | 「すべて」を含む絞り込み選択肢の組み立て                                               |
| `src/features/admin/components/status-badge.tsx`        | 状態語彙 → `Badge` の色と文言                                                          |
| `src/app/(admin)/**`（13 本）                           | `screens/` を呼ぶだけの薄いルート。Task 9-24 で薄さを機械検査する                      |

`src/app/(admin)/_layout.tsx` と `src/app/(admin)/(tabs)/_layout.tsx` は **Phase 5 の成果物**（上の「他フェーズから受け取るもの」）。Phase 9 はタブの中身だけを作り、シェルには触らない。

**画面本体を `src/app/` に置かない理由。**`apps/mobile/jest.config.js` の `collectCoverageFrom` が `'!src/app/**'` で app 配下を除外している（実ファイルで確認済み）。`src/app/` に中身を書くと、その行はカバレッジの分母に入らないまま素通りする。ロジックを `src/features/admin/screens/` に置き、`src/app/` は再エクスポートだけにすれば、13 画面すべてが 100% の対象になる。

**既存 UI プリミティブは再利用する。** `Badge` / `Button` / `Card` / `EmptyState` / `ErrorState` / `Icon` / `Input` / `Skeleton` は全部実物を読んで props を確認済みなので、同等品を作り直さない。複数行入力は `Input` の `isMultiline` で足りる。足りないのは上の 3 つだけ。

---

## 管理 API のエンドポイント一覧と期待ステータス

Task 9-16 の権限行列テストはこの表をそのまま実装する。**admin 列は「正しいリクエストを投げたときの成功系」**で、対象が無いときは 404、状態が合わないときは 409 を返す。

| #   | メソッド | パス                                         | anonymous | user | owner | admin |
| --- | -------- | -------------------------------------------- | --------- | ---- | ----- | ----- |
| 1   | GET      | `/admin/stats/overview`                      | 401       | 403  | 403   | 200   |
| 2   | GET      | `/admin/applications`                        | 401       | 403  | 403   | 200   |
| 3   | GET      | `/admin/applications/:applicationId`         | 401       | 403  | 403   | 200   |
| 4   | POST     | `/admin/applications/:applicationId/approve` | 401       | 403  | 403   | 200   |
| 5   | POST     | `/admin/applications/:applicationId/return`  | 401       | 403  | 403   | 200   |
| 6   | POST     | `/admin/applications/:applicationId/reject`  | 401       | 403  | 403   | 200   |
| 7   | GET      | `/admin/reports`                             | 401       | 403  | 403   | 200   |
| 8   | GET      | `/admin/reports/:reportId`                   | 401       | 403  | 403   | 200   |
| 9   | POST     | `/admin/reports/:reportId/resolve`           | 401       | 403  | 403   | 200   |
| 10  | POST     | `/admin/reports/:reportId/reject`            | 401       | 403  | 403   | 200   |
| 11  | GET      | `/admin/users`                               | 401       | 403  | 403   | 200   |
| 12  | GET      | `/admin/users/:userId`                       | 401       | 403  | 403   | 200   |
| 13  | POST     | `/admin/users/:userId/suspend`               | 401       | 403  | 403   | 200   |
| 14  | POST     | `/admin/users/:userId/restore`               | 401       | 403  | 403   | 200   |
| 15  | PATCH    | `/admin/users/:userId/role`                  | 401       | 403  | 403   | 200   |
| 16  | GET      | `/admin/shops`                               | 401       | 403  | 403   | 200   |
| 17  | GET      | `/admin/shops/:shopId`                       | 401       | 403  | 403   | 200   |
| 18  | POST     | `/admin/shops/:shopId/suspend`               | 401       | 403  | 403   | 200   |
| 19  | POST     | `/admin/shops/:shopId/restore`               | 401       | 403  | 403   | 200   |
| 20  | PATCH    | `/admin/shops/:shopId/owner`                 | 401       | 403  | 403   | 200   |
| 21  | GET      | `/admin/genres`                              | 401       | 403  | 403   | 200   |
| 22  | POST     | `/admin/genres`                              | 401       | 403  | 403   | 201   |
| 23  | PATCH    | `/admin/genres/:genreId`                     | 401       | 403  | 403   | 200   |
| 24  | DELETE   | `/admin/genres/:genreId`                     | 401       | 403  | 403   | 200   |
| 25  | GET      | `/admin/areas`                               | 401       | 403  | 403   | 200   |
| 26  | POST     | `/admin/areas`                               | 401       | 403  | 403   | 201   |
| 27  | PATCH    | `/admin/areas/:areaId`                       | 401       | 403  | 403   | 200   |
| 28  | DELETE   | `/admin/areas/:areaId`                       | 401       | 403  | 403   | 200   |
| 29  | POST     | `/admin/announcements`                       | 401       | 403  | 403   | 200   |
| 30  | GET      | `/admin/announcements`                       | 401       | 403  | 403   | 200   |
| 31  | GET      | `/admin/audit-logs`                          | 401       | 403  | 403   | 200   |
| 32  | POST     | `/admin/audit-logs/:auditLogId/undo`         | 401       | 403  | 403   | 200   |

32 エンドポイント × 4 視点 = **128 ケース**。

**2026-09-16 追加。** 初回店舗申請（`user` → `owner`）の 4 本をこのフェーズが引き取った（末尾の「追補」節を参照）。**この 4 本は `/admin/**` ではないので `DELEGATED_ROUTE_PATTERNS` に入れず、Phase 4 の `ENDPOINT_CASES` に直接足す。**

| #   | メソッド | パス                              | anonymous | user | owner | admin |
| --- | -------- | --------------------------------- | --------- | ---- | ----- | ----- |
| 33  | GET      | `/masters`                        | 200       | 200  | 200   | 200   |
| 34  | POST     | `/shop-applications`              | 401       | 201  | 403   | 403   |
| 35  | GET      | `/shop-applications/me`           | 401       | 200  | 403   | 403   |
| 36  | POST     | `/shop-applications/me/documents` | 401       | 404  | 403   | 403   |

---

## タスクの粒度について

タスク数は 28（Task 9-0 〜 Task 9-27）。目安の 15 より多いのは、Phase 9 が **画面 14 枚 + リポジトリ 10 本 + 監査ログの機械的担保 3 本 + 36 エンドポイントのルート層 + 権限行列 128 ケース** を同時に抱えるためで、15 に詰めると 1 タスクが半日〜1 日仕事になり「レビュアーが隣のタスクを通しつつこのタスクだけ差し戻せる」境界を割る。逆に監査ログの担保（Task 9-1 / 9-2 / 9-3）は成果物が別物なので束ねない。

| 範囲       | タスク                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 土台       | 9-0（409）、9-1〜9-3（監査ログの機械的担保）、9-4（ページング）                                                                                                   |
| リポジトリ | 9-5 申請 / 9-6 通報 / 9-7 ユーザー / 9-8 店舗 / 9-9 マスタ / 9-10 お知らせ / 9-11 監査ログ / 9-12 KPI                                                             |
| ルート層   | 9-13 土台 + stats + 申請 / 9-14 通報・ユーザー・店舗 / 9-15 マスタ・お知らせ・監査ログ / 9-16 権限行列 128 ケース / 9-17 API 仕上げ                               |
| モバイル   | 9-18 UI プリミティブ / 9-19 型・API・クエリ層 / 9-20 共有スキャフォールド / 9-21 画面共通部品 / 9-22 タブ 5 画面 / 9-23 詳細 4 画面 / 9-24 残り 4 画面 + 総仕上げ |
| 初回申請   | 9-25 リポジトリ + 公開マスタ / 9-26 ルート 4 本と権限行列（83 → 87 本） / 9-27 申請フォーム画面                                                                   |

---

### Task 9-0: 土台の穴埋め（409 応答）

Phase 9 は Phase 4 の上に建つ。実ファイルを読んだ結果、**Phase 9 が作り直す必要のあるものはほとんど無い**ことが分かった。

| 要るもの                                               | 現状                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 門番（`roleGuard(...roles)` / `requireAdminActor(c)`） | **すでにある**（`apps/api/src/middleware/role-guard.ts`）。Phase 9 では作らない                                                                                                                                                                                                                                                                          |
| テスト用の `AdminActor` 生成                           | **すでにある**。`apps/api/src/test/fixtures.ts` の `buildActorForTest(userId, role): Actor` と `adminActorOrThrow(actor): AdminActor` を組み合わせる。`toActor` を import してよいのはホワイトリストの 3 ファイル（`auth/load-actor.ts` / `middleware/auth.ts` / `test/fixtures.ts`）だけなので、**Phase 9 の新規ファイルからは必ずこの 2 つを経由する** |
| レビュー行のシード                                     | **すでにある**（`seedReview`）。Phase 9 で作らない                                                                                                                                                                                                                                                                                                       |
| 409（`conflict()`）                                    | **無い**。ここで足す                                                                                                                                                                                                                                                                                                                                     |

つまりこの Task の実体は `conflict()` の追加 1 本だけになる。小さいが、独立して落とせる境界なので分ける（409 の文言と番号は 32 エンドポイントすべてが依存する）。

**Files:**

- Modify: `apps/api/src/lib/http-error.ts`
- Modify: `apps/api/src/lib/http-error.test.ts`

**Interfaces:**

- Consumes: `hono/http-exception` の `HTTPException`
- Produces:
  - `ERROR_MESSAGE_CONFLICT: '対象の状態が変わっています'`
  - `conflict(): HTTPException`（409）

**Phase 4 の実装を読んで分かった前提（推測ではなく実ファイル）:**

| 事実                                                                                                                                                                                                                                                                                                                 | 実ファイル                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `Viewer = Actor \| AnonymousActor`。判別子は `role` で、未認証は `role: 'anonymous'`。**`{ kind: 'anonymous' }` のような形ではない**                                                                                                                                                                                 | `apps/api/src/auth/actor.ts`                    |
| `isAdminActor(viewer): viewer is AdminActor` がある。自前で `role === 'admin'` を書かない                                                                                                                                                                                                                            | 同上                                            |
| `Actor` の生成点は `toActor(userId: string, role: Role): Actor` の 1 つだけ。戻り値は**ユニオン**なので、`AdminActor` が要るなら型ガードで絞る                                                                                                                                                                       | 同上                                            |
| `toActor` を import してよいファイルはホワイトリスト管理で、`.test.ts` / `.type-test.ts` だけが検査対象外                                                                                                                                                                                                            | `apps/api/src/auth/actor-encapsulation.test.ts` |
| 門番は `roleGuard(...roles)`（401/403）と `requireAdminActor(c): AdminActor` がすでにある                                                                                                                                                                                                                            | `apps/api/src/middleware/role-guard.ts`         |
| エラーは `HTTPException` を **throw** する。`c.json(...)` でエラー本文を直接組み立てる作りではない                                                                                                                                                                                                                   | `apps/api/src/lib/http-error.ts`                |
| 応答の形は `{ error: { status, message } }`。文言は `ERROR_MESSAGE_*` の固定文字列                                                                                                                                                                                                                                   | `apps/api/src/middleware/error-handler.ts`      |
| 401/403/404/422 のヘルパはあるが **409 が無い**                                                                                                                                                                                                                                                                      | `apps/api/src/lib/http-error.ts`                |
| 認証ミドルウェアは `profiles.status = 'suspended'` を `forbidden()` で弾く                                                                                                                                                                                                                                           | `apps/api/src/middleware/auth.ts`               |
| `src/test/fixtures.ts` に実 D1 の世界（`createTestWorld` / `seedMasters` / `seedUser` / `seedShop` / `seedReview` / `readRow` / `countRows` / `runWrite`）と、Actor 生成の入口（`buildActorForTest` / `userActorOrThrow` / `ownerActorOrThrow` / `adminActorOrThrow`）と、`cause` を辿る `rejectionMessageOf` がある | `apps/api/src/test/fixtures.ts`                 |
| `seedUser` は `user` と `profiles` の両方を入れる。`seedShop` は NOT NULL と CHECK をすべて満たす（`address` に `'東京都渋谷区道玄坂 1-1-1'`、`geohash` に `TEST_GEOHASH`）。`created_at` は既定 0                                                                                                                   | 同上                                            |
| `signUpAs(world, email, role)` は Better Auth で本当にサインアップし、`{ userId, email, cookie }` を返す。`cookie` は `name=value` 形式でそのまま `cookie` ヘッダに入れられる                                                                                                                                        | 同上                                            |
| `shops` の Drizzle 側のフィールド名は `lat` / `lng`（`latitude` / `longitude` ではない）。`address` は NOT NULL                                                                                                                                                                                                      | `apps/api/src/db/schema/shop.ts`                |

- [ ] **Step 1: 着手条件を確認する**

```bash
cd /Users/hattori/Downloads/alee
ls apps/api/src/auth/actor.ts apps/api/src/db/client.ts apps/api/src/lib/app-env.ts \
   apps/api/src/lib/http-error.ts apps/api/src/middleware/error-handler.ts \
   apps/api/src/middleware/role-guard.ts apps/api/src/test/fixtures.ts
grep -n "export type Viewer\|export type AdminActor\|export function toActor\|export function isAdminActor" apps/api/src/auth/actor.ts
grep -n "export function roleGuard\|export function requireAdminActor" apps/api/src/middleware/role-guard.ts
grep -n "ACTOR_FACTORY_ALLOWLIST" -A 6 apps/api/src/auth/actor-encapsulation.test.ts
npm test -w @meshimap/api
```

Expected: 7 ファイルすべてが存在し、`grep` が上の名前を見つけ、既存テストが全部通る。通らない状態から始めると、以降の「落ちた／通った」が信用できない。

- [ ] **Step 2: 409 の失敗するテストを書く**

`apps/api/src/lib/http-error.test.ts` に足す。

```ts
import { conflict, ERROR_MESSAGE_CONFLICT } from './http-error';

describe('conflict', () => {
  it('409 と固定文言を持つ HTTPException を返す', () => {
    const error = conflict();

    expect(error.status).toBe(409);
    expect(error.message).toBe(ERROR_MESSAGE_CONFLICT);
  });

  it('文言に内部情報を含めない', () => {
    expect(ERROR_MESSAGE_CONFLICT).toBe('対象の状態が変わっています');
  });
});
```

既存の `http-error.test.ts` が `import { ... } from './http-error'` を 1 本にまとめている場合は、新しい import 文を足さずにそこへ `conflict` と `ERROR_MESSAGE_CONFLICT` を追加すること（`verbatimModuleSyntax` と `noUnusedLocals` の下では重複 import が lint エラーになる）。

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- http-error`
Expected: FAIL。`"conflict" is not exported by "src/lib/http-error.ts"`。

- [ ] **Step 4: `conflict` を足す**

`apps/api/src/lib/http-error.ts`。文言は既存の並び（401 → 403 → 404 → 422 → 500）に合わせて 404 と 422 の間へ入れる。

```ts
/**
 * 対象は見えているが、今の状態ではその操作ができない（すでに承認済み、など）。
 * どの状態だったかは返さない。他人の処分状況が漏れるため。
 */
export const ERROR_MESSAGE_CONFLICT = '対象の状態が変わっています';
```

関数はファイル末尾の並びに合わせて `notFound` と `invalidInput` の間へ。

```ts
/** 409。管理 API の「二重処理」を表すのに使う */
export function conflict(): HTTPException {
  return new HTTPException(409, { message: ERROR_MESSAGE_CONFLICT });
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- http-error`
Expected: PASS

- [ ] **Step 6: テスト用 `AdminActor` の作り方を確認する（新規実装はしない）**

Phase 9 のリポジトリテストは HTTP を経由せず `AdminActor` を直接渡す。作り方は**すでに `src/test/fixtures.ts` にある**ので、ここでは「その組み合わせが本当に `AdminActor` になる」ことを 1 回だけ確認して、以降のタスクで使い回す。

```bash
cd /Users/hattori/Downloads/alee
grep -n "export function buildActorForTest" -A 3 apps/api/src/test/fixtures.ts
grep -n "export function adminActorOrThrow" -A 6 apps/api/src/test/fixtures.ts
```

Expected: 次の 2 つが見つかる。

```ts
export function buildActorForTest(userId: string, role: Role): Actor;
export function adminActorOrThrow(actor: Actor): AdminActor;
```

Phase 9 の新規ファイルは、必ずこの形で `AdminActor` を作る。

```ts
import { ROLE_ADMIN } from '../db/constants';
import { adminActorOrThrow, buildActorForTest } from '../test/fixtures';

const ADMIN_ACTOR = adminActorOrThrow(buildActorForTest('usr_admin_0001', ROLE_ADMIN));
```

`toActor` を直接 import しないこと。`auth/actor-encapsulation.test.ts` の `ACTOR_FACTORY_ALLOWLIST` は `auth/load-actor.ts` / `middleware/auth.ts` / `test/fixtures.ts` の 3 つだけで、**ホワイトリストを増やすのは Phase 9 の方針外**（Actor の生成経路を増やさない）。

- [ ] **Step 7: わざと壊して、2 つの検査が本当に噛んでいることを確認する**

1. `conflict()` の `409` を `404` に変える → `npm test -w @meshimap/api -- http-error` が `expected 404 to be 409` で落ちる。
2. `src/lib/logger.ts`（ホワイトリスト外の任意の非テストファイル）の先頭に `import { toActor } from '../auth/actor';` を足す → `npm test -w @meshimap/api -- actor-encapsulation` が `logger.ts が toActor を import している` で落ちる。**この 2 つ目が重要**で、Phase 9 が Actor の生成経路を増やしても既存の検査が気づくことを意味する。

両方確認したら戻す。

```bash
git diff --stat
```

Expected: `git diff --stat` が Step 4 の変更だけを表示する（壊した箇所が残っていない）。

- [ ] **Step 8: コミットする**

```bash
cd /Users/hattori/Downloads/alee
npm test -w @meshimap/api
git add apps/api/src/lib/http-error.ts apps/api/src/lib/http-error.test.ts
git commit -m "feat(api): 409 応答のヘルパを追加"
```

Expected: 既存テストを含めて全件 PASS。

---

### Task 9-1: 監査ログ付き書き込みの唯一の経路（`withAuditLog`）

**Files:**

- Create: `apps/api/src/lib/audit-log.ts`
- Test: `apps/api/src/lib/audit-log.test.ts`

**Interfaces:**

- Consumes: `apps/api/src/db/client.ts` の `Database`、`apps/api/src/auth/actor.ts` の `AdminActor`（型のみ）、`apps/api/src/test/fixtures.ts` の `buildActorForTest` / `adminActorOrThrow`、`apps/api/src/db/schema` の `auditLogs` / `AuditLogDiff`、`apps/api/src/db/testing/local-d1.ts` の `createMigratedD1` / `LocalD1`
- Produces:
  - `AUDIT_ACTIONS`（action 語彙）と `type AuditAction`
  - `AUDIT_TARGET_TYPES`（target_type 語彙）と `type AuditTargetType`
  - `type AuditSpec = { readonly action: AuditAction; readonly targetType: AuditTargetType; readonly targetId: string; readonly diff: AuditLogDiff | null }`
  - `type SqliteStatement = BatchItem<'sqlite'>`
  - `createAuditLogId(): string`
  - `toNonEmptyBatch(statements: readonly SqliteStatement[]): readonly [SqliteStatement, ...SqliteStatement[]]`
  - `withAuditLog(db: Database, actor: AdminActor, spec: AuditSpec, statements: readonly SqliteStatement[]): Promise<void>`
  - `withAuditLogChunked(db: Database, actor: AdminActor, spec: AuditSpec, statements: readonly SqliteStatement[], chunkSize: number): Promise<void>`
  - `buildAuditDiff(before, after): AuditLogDiff` / `buildCreationDiff(after): AuditLogDiff` / `buildDeletionDiff(before): AuditLogDiff`

- [ ] **Step 1: 失敗するテストを書く（純粋関数の部分）**

`apps/api/src/lib/audit-log.test.ts`（まず前半だけ書く）

```ts
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  buildAuditDiff,
  buildCreationDiff,
  buildDeletionDiff,
  createAuditLogId,
  toNonEmptyBatch,
} from './audit-log';

const IDENTIFIER_MAX_LENGTH = 64;
const AUDIT_TARGET_TYPE_MAX_LENGTH = 32;
const AUDIT_ACTION_PATTERN = /^[a-z0-9_.]+$/;

describe('監査ログの語彙', () => {
  it('action はすべて ck_audit_logs_action（a-z0-9_. のみ・空でない）を満たす', () => {
    const invalid = Object.values(AUDIT_ACTIONS).filter(
      (action) => !AUDIT_ACTION_PATTERN.test(action),
    );

    expect(invalid).toEqual([]);
  });

  it('target_type はすべて 32 文字以内', () => {
    const tooLong = Object.values(AUDIT_TARGET_TYPES).filter(
      (targetType) => targetType.length > AUDIT_TARGET_TYPE_MAX_LENGTH,
    );

    expect(tooLong).toEqual([]);
  });

  it('action の値に重複が無い', () => {
    const actions = Object.values(AUDIT_ACTIONS);

    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe('createAuditLogId', () => {
  it('ck_audit_logs_id_length（64 文字以内）に収まる', () => {
    expect(createAuditLogId().length).toBeLessThanOrEqual(IDENTIFIER_MAX_LENGTH);
  });

  it('呼ぶたびに違う値を返す', () => {
    expect(createAuditLogId()).not.toBe(createAuditLogId());
  });

  it('aud_ で始まり、ハイフンを含まない', () => {
    const id = createAuditLogId();

    expect(id.startsWith('aud_')).toBe(true);
    expect(id.includes('-')).toBe(false);
  });
});

describe('toNonEmptyBatch', () => {
  it('空配列を渡すと理由付きで落ちる（D1 の空バッチは No SQL statements detected. になるため）', () => {
    expect(() => toNonEmptyBatch([])).toThrow('監査ログ付き書き込みには 1 文以上の SQL が必要です');
  });
});

describe('buildAuditDiff', () => {
  it('変わった列だけを [前, 後] の組で残す', () => {
    const diff = buildAuditDiff(
      { status: 'published', ownerId: 'usr_1' },
      { status: 'suspended', ownerId: 'usr_1' },
    );

    expect(diff).toEqual({ status: ['published', 'suspended'] });
  });

  it('前の値に無い列は前を null として扱う', () => {
    expect(buildAuditDiff({}, { reviewNote: '書類不足' })).toEqual({
      reviewNote: [null, '書類不足'],
    });
  });

  it('前の値が false や 0 でも「無い」と混同しない', () => {
    expect(buildAuditDiff({ sortOrder: 0 }, { sortOrder: 5 })).toEqual({ sortOrder: [0, 5] });
  });

  it('何も変わっていなければ空オブジェクトになる', () => {
    expect(buildAuditDiff({ status: 'open' }, { status: 'open' })).toEqual({});
  });
});

describe('buildCreationDiff / buildDeletionDiff', () => {
  it('作成は [null, 値]', () => {
    expect(buildCreationDiff({ name: '和食', sortOrder: 3 })).toEqual({
      name: [null, '和食'],
      sortOrder: [null, 3],
    });
  });

  it('削除は [値, null]', () => {
    expect(buildDeletionDiff({ name: '和食', sortOrder: 3 })).toEqual({
      name: ['和食', null],
      sortOrder: [3, null],
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- audit-log`
Expected: FAIL。`Failed to resolve import "./audit-log"`。

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/lib/audit-log.ts`

```ts
import type { BatchItem } from 'drizzle-orm/batch';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import { auditLogs, type AuditLogDiff } from '../db/schema';

/**
 * 監査ログの action 語彙。
 *
 * `ck_audit_logs_action` が `a-z0-9_.` 以外を弾くので、大文字やハイフンを足さないこと。
 * 表記ゆれが 1 つ混ざると action 別の集計がその時点から壊れる。
 */
export const AUDIT_ACTIONS = {
  applicationApprove: 'application.approve',
  applicationReturn: 'application.return',
  applicationReject: 'application.reject',
  reportResolve: 'report.resolve',
  reportReject: 'report.reject',
  reportWarn: 'report.warn',
  reviewHide: 'review.hide',
  reviewRestore: 'review.restore',
  userSuspend: 'user.suspend',
  userRestore: 'user.restore',
  userRoleChange: 'user.role_change',
  shopSuspend: 'shop.suspend',
  shopRestore: 'shop.restore',
  shopOwnerAssign: 'shop.owner_assign',
  genreCreate: 'genre.create',
  genreUpdate: 'genre.update',
  genreDelete: 'genre.delete',
  areaCreate: 'area.create',
  areaUpdate: 'area.update',
  areaDelete: 'area.delete',
  announcementSend: 'announcement.send',
  auditUndo: 'audit.undo',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** 監査ログの target_type 語彙。`ck_audit_logs_target_type_length` により 32 文字以内 */
export const AUDIT_TARGET_TYPES = {
  shopApplication: 'shop_application',
  report: 'report',
  review: 'review',
  user: 'user',
  shop: 'shop',
  genre: 'genre',
  area: 'area',
  announcement: 'announcement',
  auditLog: 'audit_log',
} as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[keyof typeof AUDIT_TARGET_TYPES];

export type AuditSpec = {
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly diff: AuditLogDiff | null;
};

/** Drizzle の `db.batch()` に渡せる 1 文。`drizzle-orm/batch` の型をそのまま使う */
export type SqliteStatement = BatchItem<'sqlite'>;

/** `db.batch()` の引数が要求する非空タプル */
export type NonEmptyStatements = readonly [SqliteStatement, ...SqliteStatement[]];

const AUDIT_LOG_ID_PREFIX = 'aud_';
const UUID_HYPHEN = '-';
const MIN_CHUNK_SIZE = 1;

/** `aud_` + UUID からハイフンを除いた 32 文字 = 36 文字。ID 列の CHECK は「64 文字以内」だけ */
export function createAuditLogId(): string {
  return `${AUDIT_LOG_ID_PREFIX}${crypto.randomUUID().replaceAll(UUID_HYPHEN, '')}`;
}

/**
 * 文の配列を `db.batch()` が要求する非空タプルへ変換する。
 *
 * `as` を使わずに非空を型で示すために分割代入で組み直している。
 * D1 は文が 0 本のバッチを `No SQL statements detected.` で落とすので、
 * その手前で読める理由を付けて落とす。
 */
export function toNonEmptyBatch(statements: readonly SqliteStatement[]): NonEmptyStatements {
  const [head, ...tail] = statements;
  if (head === undefined) {
    throw new Error('監査ログ付き書き込みには 1 文以上の SQL が必要です');
  }
  return [head, ...tail];
}

/**
 * **管理系の書き込みは、必ずこの関数を通る。**
 *
 * 渡された業務データの文の末尾に監査ログの INSERT を足し、1 回の `db.batch()` で流す。
 * D1 の batch は 1 文でも失敗すると全体がロールバックする（実測済み）ので、
 * 「データが変わったのに監査ログが無い」状態を DB のレベルで作れない。
 *
 * 呼び出し側は文を「組み立てるだけ」で、await も `.run()` もしてはいけない。
 * その規約は `src/repositories/admin-audit-convention.test.ts` が機械的に落とす。
 */
export async function withAuditLog(
  db: Database,
  actor: AdminActor,
  spec: AuditSpec,
  statements: readonly SqliteStatement[],
): Promise<void> {
  const auditStatement = db.insert(auditLogs).values({
    id: createAuditLogId(),
    actorId: actor.userId,
    action: spec.action,
    targetType: spec.targetType,
    targetId: spec.targetId,
    diff: spec.diff,
  });

  await db.batch(toNonEmptyBatch([...statements, auditStatement]));
}

/**
 * 文の数が多いときにチャンクへ割って流す。お知らせの一斉配信だけが使う。
 *
 * D1 に対話的トランザクションが無いのでチャンクをまたいだ原子性は作れない。
 * 代わりに **監査行を最後のチャンクと同じバッチに入れる**ことで、
 * 「監査行がある ⇔ 全チャンクが流れ切った」を成立させる。
 * 途中で落ちたときは監査行が無いので、未完了だと機械的に判別できる。
 */
export async function withAuditLogChunked(
  db: Database,
  actor: AdminActor,
  spec: AuditSpec,
  statements: readonly SqliteStatement[],
  chunkSize: number,
): Promise<void> {
  if (chunkSize < MIN_CHUNK_SIZE) {
    throw new Error('チャンクサイズは 1 以上でなければなりません');
  }

  let index = 0;
  while (index + chunkSize < statements.length) {
    await db.batch(toNonEmptyBatch(statements.slice(index, index + chunkSize)));
    index += chunkSize;
  }

  await withAuditLog(db, actor, spec, statements.slice(index));
}

/** 更新前後を比べ、変わった列だけ `[前, 後]` で残す */
export function buildAuditDiff(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): AuditLogDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const [key, afterValue] of Object.entries(after)) {
    const beforeValue = Object.hasOwn(before, key) ? before[key] : null;
    if (beforeValue !== afterValue) {
      diff[key] = [beforeValue, afterValue];
    }
  }
  return diff;
}

/** 新規作成。全列を `[null, 値]` で残す */
export function buildCreationDiff(after: Readonly<Record<string, unknown>>): AuditLogDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(after)) {
    diff[key] = [null, value];
  }
  return diff;
}

/** 物理削除。全列を `[値, null]` で残す。これが再 INSERT の原資になる */
export function buildDeletionDiff(before: Readonly<Record<string, unknown>>): AuditLogDiff {
  const diff: Record<string, readonly [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(before)) {
    diff[key] = [value, null];
  }
  return diff;
}
```

- [ ] **Step 4: 純粋関数のテストが通ることを確認する**

Run: `npm test -w @meshimap/api -- audit-log`
Expected: PASS（13 件）

- [ ] **Step 5: 実 D1 に対する失敗するテストを足す**

`apps/api/src/lib/audit-log.test.ts` の末尾に足す。

```ts
import { drizzle } from 'drizzle-orm/d1';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, vi } from 'vitest';
import { auditLogs, genres } from '../db/schema';
import { ROLE_ADMIN } from '../db/constants';
import { createMigratedD1, type LocalD1 } from '../db/testing/local-d1';
import { adminActorOrThrow, buildActorForTest } from '../test/fixtures';
import { withAuditLog, withAuditLogChunked } from './audit-log';

const ADMIN_ACTOR = adminActorOrThrow(buildActorForTest('usr_admin_0001', ROLE_ADMIN));

/** genres だけを触るので user 行は要らない（audit_logs.actor_id は set null 参照で NULL 可） */
const AUDIT_SPEC = {
  action: AUDIT_ACTIONS.genreCreate,
  targetType: AUDIT_TARGET_TYPES.genre,
  targetId: 'gnr_test',
  diff: null,
} as const;

describe('withAuditLog（実 D1）', () => {
  let local: LocalD1;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    local = await createMigratedD1();
    db = drizzle(local.d1);
  });

  afterEach(async () => {
    await local.dispose();
  });

  it('業務データの書き込みと監査ログが同時に入る', async () => {
    await withAuditLog(db, ADMIN_ACTOR, AUDIT_SPEC, [
      db.insert(genres).values({ id: 'gnr_test', name: '和食', slug: 'washoku' }),
    ]);

    const [genreCount] = await db.select({ value: count() }).from(genres);
    const [auditCount] = await db.select({ value: count() }).from(auditLogs);

    expect(genreCount?.value).toBe(1);
    expect(auditCount?.value).toBe(1);
  });

  it('監査行には実行者・action・target が入る', async () => {
    await withAuditLog(db, ADMIN_ACTOR, AUDIT_SPEC, [
      db.insert(genres).values({ id: 'gnr_test', name: '和食', slug: 'washoku' }),
    ]);

    const [entry] = await db.select().from(auditLogs);

    expect(entry?.actorId).toBe(ADMIN_ACTOR.userId);
    expect(entry?.action).toBe('genre.create');
    expect(entry?.targetType).toBe('genre');
    expect(entry?.targetId).toBe('gnr_test');
  });

  it('業務データ側の文が制約違反で落ちると、監査ログも残らない', async () => {
    // slug は consistsOf(slug, 'a-z0-9-') なので大文字は CHECK 違反になる
    await expect(
      withAuditLog(db, ADMIN_ACTOR, AUDIT_SPEC, [
        db.insert(genres).values({ id: 'gnr_test', name: '和食', slug: 'WASHOKU' }),
      ]),
    ).rejects.toThrow(/CHECK constraint failed/);

    const [genreCount] = await db.select({ value: count() }).from(genres);
    const [auditCount] = await db.select({ value: count() }).from(auditLogs);

    expect(genreCount?.value).toBe(0);
    expect(auditCount?.value).toBe(0);
  });

  it('文を 1 つも渡さなくても監査行だけは残る', async () => {
    await withAuditLog(db, ADMIN_ACTOR, AUDIT_SPEC, []);

    const [auditCount] = await db.select({ value: count() }).from(auditLogs);

    expect(auditCount?.value).toBe(1);
  });
});

describe('withAuditLogChunked（実 D1）', () => {
  let local: LocalD1;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    local = await createMigratedD1();
    db = drizzle(local.d1);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await local.dispose();
  });

  function buildGenreStatements(total: number): readonly SqliteStatement[] {
    return Array.from({ length: total }, (_unused, index) =>
      db
        .insert(genres)
        .values({ id: `gnr_${index}`, name: `ジャンル${index}`, slug: `g-${index}` }),
    );
  }

  it('チャンクに割っても全件書き込まれ、監査行は 1 行だけ増える', async () => {
    await withAuditLogChunked(db, ADMIN_ACTOR, AUDIT_SPEC, buildGenreStatements(10), 3);

    const [genreCount] = await db.select({ value: count() }).from(genres);
    const [auditCount] = await db.select({ value: count() }).from(auditLogs);

    expect(genreCount?.value).toBe(10);
    expect(auditCount?.value).toBe(1);
  });

  it('文の数がチャンクサイズの倍数ちょうどでも batch は（件数 / サイズ）回しか呼ばれない', async () => {
    const batchSpy = vi.spyOn(db, 'batch');

    await withAuditLogChunked(db, ADMIN_ACTOR, AUDIT_SPEC, buildGenreStatements(6), 3);

    // 先頭チャンク 1 回 + 最終チャンク（3 文 + 監査行）1 回 = 2 回。
    // ループ条件を `<=` に書き換えると 3 回になる（最後のバッチが監査行だけになる）
    expect(batchSpy).toHaveBeenCalledTimes(2);
  });

  it('文が 0 本でも監査行は 1 行入る（バッチは 1 回だけ）', async () => {
    const batchSpy = vi.spyOn(db, 'batch');

    await withAuditLogChunked(db, ADMIN_ACTOR, AUDIT_SPEC, [], 3);

    const [auditCount] = await db.select({ value: count() }).from(auditLogs);

    expect(auditCount?.value).toBe(1);
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it('チャンクサイズ 0 は理由付きで落ちる', async () => {
    await expect(
      withAuditLogChunked(db, ADMIN_ACTOR, AUDIT_SPEC, buildGenreStatements(1), 0),
    ).rejects.toThrow('チャンクサイズは 1 以上でなければなりません');
  });

  it('チャンクサイズ 1 でも通る（境界の下限）', async () => {
    await withAuditLogChunked(db, ADMIN_ACTOR, AUDIT_SPEC, buildGenreStatements(2), 1);

    const [genreCount] = await db.select({ value: count() }).from(genres);

    expect(genreCount?.value).toBe(2);
  });
});
```

Run: `npm test -w @meshimap/api -- audit-log`
Expected: PASS（22 件）。ここで落ちる場合に真っ先に疑うのは 2 つ。

1. `db.batch(toNonEmptyBatch([...statements, auditStatement]))` の型。`toNonEmptyBatch` の戻り値型で非空タプルを示しているので通るはずだが、通らない場合は `SqliteStatement` の import 元（`drizzle-orm/batch`）が合っているかを `node_modules/drizzle-orm/batch.d.ts` で確認する。
2. `vi.spyOn(db, 'batch')` が「メソッドが無い」で落ちる場合。`batch` は `DrizzleD1Database` のプロトタイプにあるので spy は張れるが、張れないときは `db` を `{ batch: (...) => ... }` で包む薄いラッパを作り、呼び出し回数をそのラッパで数える。

- [ ] **Step 6: わざと壊して、原子性のテストが本物か確認する**

`withAuditLog` の `await db.batch(...)` を、次のように「2 回に分けて流す」形へ書き換える。

```ts
await db.batch(toNonEmptyBatch([...statements]));
await db.batch(toNonEmptyBatch([auditStatement]));
```

Run: `npm test -w @meshimap/api -- audit-log`
Expected: FAIL。「業務データ側の文が制約違反で落ちると、監査ログも残らない」だけが落ちる…**のではなく**、`toNonEmptyBatch([...statements])` が空配列で落ちるため「文を 1 つも渡さなくても監査行だけは残る」も落ちる。**2 件落ちることを確認する。** この 2 件が Phase 9 の原子性の担保そのものなので、書き換えても緑のままなら実 D1 を使えていない（`createMigratedD1` ではなくモックを掴んでいる）。確認できたら元に戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/lib/audit-log.ts apps/api/src/lib/audit-log.test.ts
git commit -m "feat(api): 監査ログ付き書き込みの単一経路 withAuditLog を追加"
```

---

### Task 9-2: 監査ログ規約の静的検査（TypeScript Compiler API）

Phase 4 Task 4-10 の `repository-convention.test.ts` と同じ作り方をする。違うのは見る規約だけ。

**Files:**

- Create: `apps/api/src/repositories/admin-audit-convention.test.ts`
- Create: `apps/api/src/repositories/admin-stats-repository.ts`（Step 4 で作る「監査ログを書かない読み取り専用リポジトリ」の見本。中身は Task 9-12 で差し替える）
- Create: `apps/api/src/repositories/__fixtures__/audit-compliant-repo.ts.txt`
- Create: `apps/api/src/repositories/__fixtures__/audit-awaited-write-repo.ts.txt`
- Create: `apps/api/src/repositories/__fixtures__/audit-direct-batch-repo.ts.txt`
- Create: `apps/api/src/repositories/__fixtures__/audit-missing-call-repo.ts.txt`
- Create: `apps/api/src/repositories/__fixtures__/audit-shadowed-repo.ts.txt`
- Create: `apps/api/src/repositories/__fixtures__/audit-private-write-repo.ts.txt`

**Interfaces:**

- Consumes: `typescript`（devDependency に既存。`^6.0.3`）、`node:fs` / `node:path`
- Produces（同ファイルから export し、Task 9-3 が import する）:
  - `listAdminRepositoryFiles(): readonly string[]`
  - `findAuditViolations(filePath: string): readonly string[]`
  - `listAuditedWriteFunctionNames(filePath: string): readonly string[]`

拡張子を `.ts.txt` にするのは Phase 4 と同じ理由で、tsc・vitest・カバレッジ・prettier・eslint のどれにも拾わせないため。`__fixtures__` ディレクトリは `listAdminRepositoryFiles()` の `.ts` フィルタで自然に外れる。

- [ ] **Step 1: 検査対象の擬似ソース（fixture）を 6 本書く**

`apps/api/src/repositories/__fixtures__/audit-compliant-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import { withAuditLog, type AuditSpec } from '../../lib/audit-log';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

export async function suspendShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
  spec: AuditSpec,
): Promise<void> {
  await withAuditLog(db, actor, spec, [
    db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId)),
  ]);
}

export async function findShop(db: Database, _actor: AdminActor, shopId: string): Promise<unknown> {
  return db.select().from(shops).where(eq(shops.id, shopId));
}
```

`apps/api/src/repositories/__fixtures__/audit-awaited-write-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import { withAuditLog, type AuditSpec } from '../../lib/audit-log';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

export async function suspendShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
  spec: AuditSpec,
): Promise<void> {
  await db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId));
  await withAuditLog(db, actor, spec, []);
}

export async function deleteShop(db: Database, actor: AdminActor, shopId: string): Promise<void> {
  await db.delete(shops).where(eq(shops.id, shopId)).run();
  await withAuditLog(
    db,
    actor,
    { action: 'shop.suspend', targetType: 'shop', targetId: shopId, diff: null },
    [],
  );
}
```

`apps/api/src/repositories/__fixtures__/audit-direct-batch-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import { withAuditLog, type AuditSpec } from '../../lib/audit-log';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

export async function suspendShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
  spec: AuditSpec,
): Promise<void> {
  await db.batch([db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId))]);
  await withAuditLog(db, actor, spec, []);
}
```

`apps/api/src/repositories/__fixtures__/audit-missing-call-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

export const suspendShop = async (
  db: Database,
  _actor: AdminActor,
  shopId: string,
): Promise<void> => {
  const statement = db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId));
  void statement;
};
```

`apps/api/src/repositories/__fixtures__/audit-shadowed-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

/** 監査ログを書いたことにして握りつぶす偽物。これを見逃したら検査の意味が無い */
async function withAuditLog(): Promise<void> {
  return;
}

export async function suspendShop(db: Database, _actor: AdminActor, shopId: string): Promise<void> {
  const statement = db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId));
  void statement;
  await withAuditLog();
}
```

`apps/api/src/repositories/__fixtures__/audit-private-write-repo.ts.txt`

```ts
import { eq } from 'drizzle-orm';
import { withAuditLog, type AuditSpec } from '../../lib/audit-log';
import type { AdminActor } from '../../auth/actor';
import type { Database } from '../../db/client';
import { shops } from '../../db/schema';

/** 書き込みを private ヘルパへ逃がすと、export 側から書き込みが見えなくなる */
function buildSuspendStatement(db: Database, shopId: string) {
  return db.update(shops).set({ status: 'suspended' }).where(eq(shops.id, shopId));
}

export async function suspendShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
  spec: AuditSpec,
): Promise<void> {
  await withAuditLog(db, actor, spec, [buildSuspendStatement(db, shopId)]);
}
```

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/admin-audit-convention.test.ts`

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 管理リポジトリが「監査ログの単一経路」を外れていないかをソースの形で検査する。
 *
 * 実行時のテスト（admin-audit-coverage.test.ts）は「呼んだら監査行が増える」しか見られない。
 * 呼ばれない経路や、まだ書かれていない関数は検査できない。
 * ここはソースそのものを見るので、テストを 1 本も書かずに足した書き込みでも捕まえられる。
 */

/** 自分の置き場所。`src/repositories/` */
const REPOSITORIES_DIR = __dirname;

const ADMIN_FILE_PREFIX = 'admin-';
const SOURCE_EXTENSION = '.ts';
const TEST_SUFFIX = '.test.ts';

const DB_PARAMETER_NAME = 'db';

/** 書き込みを組み立てるビルダーの入口 */
const WRITE_BUILDER_METHODS = new Set(['insert', 'update', 'delete']);

/** ビルダーをその場で実行してしまうメソッド。await と合わせてこれらを禁じる */
const EXECUTION_METHODS = new Set(['run', 'all', 'get', 'values', 'execute', 'then']);

/** db から直接叩かせない実行系。`transaction` は Phase 4 の規約でも禁止 */
const FORBIDDEN_DB_MEMBERS = new Set(['batch', 'run', 'transaction', '$client']);

const AUDIT_FUNCTION_NAMES = new Set(['withAuditLog', 'withAuditLogChunked']);
const AUDIT_MODULE_SPECIFIER = '../lib/audit-log';

const FIXTURES_DIR = join(REPOSITORIES_DIR, '__fixtures__');

export function listAdminRepositoryFiles(): readonly string[] {
  return readdirSync(REPOSITORIES_DIR)
    .filter(
      (fileName) =>
        fileName.startsWith(ADMIN_FILE_PREFIX) &&
        fileName.endsWith(SOURCE_EXTENSION) &&
        !fileName.endsWith(TEST_SUFFIX),
    )
    .sort()
    .map((fileName) => join(REPOSITORIES_DIR, fileName));
}

function parseSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

function forEachDescendant(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    forEachDescendant(child, visit);
  });
}

/**
 * `db.update(shops).set(...).where(...)` のような連鎖をたどって、
 * 根が `db.insert` / `db.update` / `db.delete` かどうかを調べる。
 * 根が `db.select` なら読み取りなので null を返す。
 */
function findWriteBuilderMethod(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const target = current.expression;
      if (ts.isIdentifier(target) && target.text === DB_PARAMETER_NAME) {
        return WRITE_BUILDER_METHODS.has(current.name.text) ? current.name.text : null;
      }
      current = target;
      continue;
    }
    return null;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

type ExportedFunction = { readonly name: string; readonly body: ts.Node };

function collectExportedFunctions(sourceFile: ts.SourceFile): readonly ExportedFunction[] {
  const functions: ExportedFunction[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      const { name, body } = statement;
      if (name !== undefined && body !== undefined) {
        functions.push({ name: name.text, body });
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const { initializer } = declaration;
        if (
          initializer !== undefined &&
          ts.isArrowFunction(initializer) &&
          ts.isIdentifier(declaration.name)
        ) {
          functions.push({ name: declaration.name.text, body: initializer.body });
        }
      }
    }
  }

  return functions;
}

/** export されていないトップレベル関数。書き込みを含んでいたら違反にする */
function collectPrivateFunctions(sourceFile: ts.SourceFile): readonly ExportedFunction[] {
  const functions: ExportedFunction[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && !hasExportModifier(statement)) {
      const { name, body } = statement;
      if (name !== undefined && body !== undefined) {
        functions.push({ name: name.text, body });
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && !hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const { initializer } = declaration;
        if (
          initializer !== undefined &&
          ts.isArrowFunction(initializer) &&
          ts.isIdentifier(declaration.name)
        ) {
          functions.push({ name: declaration.name.text, body: initializer.body });
        }
      }
    }
  }

  return functions;
}

function containsWriteBuilder(node: ts.Node): boolean {
  let found = false;
  forEachDescendant(node, (child) => {
    if (ts.isCallExpression(child) && findWriteBuilderMethod(child) !== null) {
      found = true;
    }
  });
  return found;
}

function callsAuditFunction(node: ts.Node): boolean {
  let found = false;
  forEachDescendant(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      AUDIT_FUNCTION_NAMES.has(child.expression.text)
    ) {
      found = true;
    }
  });
  return found;
}

function collectAuditImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text !== AUDIT_MODULE_SPECIFIER) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      names.add(element.name.text);
    }
  }

  return names;
}

function collectLocalAuditDeclarations(sourceFile: ts.SourceFile): readonly string[] {
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (AUDIT_FUNCTION_NAMES.has(statement.name.text)) {
        names.push(statement.name.text);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && AUDIT_FUNCTION_NAMES.has(declaration.name.text)) {
          names.push(declaration.name.text);
        }
      }
    }
  }

  return names;
}

function describeAt(sourceFile: ts.SourceFile, node: ts.Node, message: string): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${basename(sourceFile.fileName)}:${line + 1} ${message}`;
}

/** 違反を人が読める文字列の配列で返す。空配列なら規約どおり */
export function findAuditViolations(filePath: string): readonly string[] {
  const sourceFile = parseSourceFile(filePath);
  const fileName = basename(filePath);
  const violations: string[] = [];
  const usedAuditNames = new Set<string>();

  forEachDescendant(sourceFile, (node) => {
    if (ts.isAwaitExpression(node) && findWriteBuilderMethod(node.expression) !== null) {
      violations.push(
        describeAt(
          sourceFile,
          node,
          '書き込みビルダーを await しています。文は withAuditLog に渡すこと',
        ),
      );
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (
        EXECUTION_METHODS.has(methodName) &&
        findWriteBuilderMethod(node.expression.expression) !== null
      ) {
        violations.push(
          describeAt(
            sourceFile,
            node,
            `書き込みビルダーに .${methodName}() を呼んでいます。文は withAuditLog に渡すこと`,
          ),
        );
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === DB_PARAMETER_NAME &&
      FORBIDDEN_DB_MEMBERS.has(node.name.text)
    ) {
      violations.push(
        describeAt(
          sourceFile,
          node,
          `db.${node.name.text} を直接使っています。実行は withAuditLog / withAuditLogChunked だけが行うこと`,
        ),
      );
    }

    if (ts.isIdentifier(node) && AUDIT_FUNCTION_NAMES.has(node.text)) {
      usedAuditNames.add(node.text);
    }
  });

  for (const exported of collectExportedFunctions(sourceFile)) {
    if (containsWriteBuilder(exported.body) && !callsAuditFunction(exported.body)) {
      violations.push(
        `${fileName} の ${exported.name} が書き込みを組み立てているのに withAuditLog を呼んでいません`,
      );
    }
  }

  for (const privateFunction of collectPrivateFunctions(sourceFile)) {
    if (containsWriteBuilder(privateFunction.body)) {
      violations.push(
        `${fileName} の ${privateFunction.name} は export されていないのに書き込みを組み立てています。書き込みは export した関数に直接書くこと`,
      );
    }
  }

  for (const localName of collectLocalAuditDeclarations(sourceFile)) {
    violations.push(
      `${fileName} が ${localName} をローカルで定義しています。${AUDIT_MODULE_SPECIFIER} から import すること`,
    );
  }

  const importedAuditNames = collectAuditImports(sourceFile);
  for (const usedName of [...usedAuditNames].sort()) {
    if (!importedAuditNames.has(usedName)) {
      violations.push(
        `${fileName} が ${usedName} を ${AUDIT_MODULE_SPECIFIER} 以外から取得しています`,
      );
    }
  }

  return violations;
}

/** 書き込みビルダーを含む export 関数の名前。Task 9-3 の表の網羅性照合に使う */
export function listAuditedWriteFunctionNames(filePath: string): readonly string[] {
  return collectExportedFunctions(parseSourceFile(filePath))
    .filter((exported) => containsWriteBuilder(exported.body))
    .map((exported) => exported.name);
}

const fixturePath = (fileName: string): string => join(FIXTURES_DIR, fileName);

describe('findAuditViolations（検査器そのものの検査）', () => {
  it('規約どおりのソースは違反 0 件', () => {
    expect(findAuditViolations(fixturePath('audit-compliant-repo.ts.txt'))).toEqual([]);
  });

  it('書き込みビルダーを await していると落とす', () => {
    const violations = findAuditViolations(fixturePath('audit-awaited-write-repo.ts.txt'));

    expect(violations).toContain(
      'audit-awaited-write-repo.ts.txt:13 書き込みビルダーを await しています。文は withAuditLog に渡すこと',
    );
  });

  it('書き込みビルダーに .run() を呼んでいると落とす', () => {
    const violations = findAuditViolations(fixturePath('audit-awaited-write-repo.ts.txt'));

    expect(violations.some((violation) => violation.includes('.run() を呼んでいます'))).toBe(true);
  });

  it('db.batch を直接呼んでいると落とす', () => {
    const violations = findAuditViolations(fixturePath('audit-direct-batch-repo.ts.txt'));

    expect(violations.some((violation) => violation.includes('db.batch を直接使っています'))).toBe(
      true,
    );
  });

  it('書き込みを組み立てているのに withAuditLog を呼ばない関数を落とす', () => {
    expect(findAuditViolations(fixturePath('audit-missing-call-repo.ts.txt'))).toContain(
      'audit-missing-call-repo.ts.txt の suspendShop が書き込みを組み立てているのに withAuditLog を呼んでいません',
    );
  });

  it('withAuditLog をローカルで定義して差し替えていると落とす', () => {
    const violations = findAuditViolations(fixturePath('audit-shadowed-repo.ts.txt'));

    expect(violations).toContain(
      'audit-shadowed-repo.ts.txt が withAuditLog をローカルで定義しています。../lib/audit-log から import すること',
    );
  });

  it('private な関数に書き込みを逃がしていると落とす', () => {
    expect(findAuditViolations(fixturePath('audit-private-write-repo.ts.txt'))).toContain(
      'audit-private-write-repo.ts.txt の buildSuspendStatement は export されていないのに書き込みを組み立てています。書き込みは export した関数に直接書くこと',
    );
  });

  it('読み取り（db.select）は違反にしない', () => {
    const violations = findAuditViolations(fixturePath('audit-compliant-repo.ts.txt'));

    expect(violations).toEqual([]);
  });
});

describe('listAuditedWriteFunctionNames', () => {
  it('書き込みを含む export 関数だけを拾い、読み取り専用の関数は拾わない', () => {
    expect(listAuditedWriteFunctionNames(fixturePath('audit-compliant-repo.ts.txt'))).toEqual([
      'suspendShop',
    ]);
  });
});

describe('管理リポジトリの監査ログ規約', () => {
  const targets = listAdminRepositoryFiles().map((filePath) => ({
    fileName: basename(filePath),
    filePath,
  }));

  it('検査対象が 1 本以上ある（ファイル名の規約 admin-*.ts が守られている証拠）', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)('$fileName は監査ログの単一経路だけを通る', ({ filePath }) => {
    expect(findAuditViolations(filePath)).toEqual([]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-audit-convention`
Expected: FAIL。`検査対象が 1 本以上ある` が `0 > 0` で落ちる（`admin-*.ts` がまだ 1 本も無いため）。**fixture を使う 9 件は PASS する**。この状態が正しい。

- [ ] **Step 4: 検査対象を 1 本作って通す**

Task 9-5 以降で本物のリポジトリが増えるが、この段階では `src/repositories/admin-stats-repository.ts` を先に置く（Task 9-12 で中身を足す。ここでは「読み取りだけのリポジトリ」として完成させる）。

**ここで作る `AdminOverviewStats` は暫定である。Task 9-12 で型名が `OverviewStats` に変わり、列も入れ替わる**（`suspendedUserCount` が消え、`newUserCount` が入る。詳しくは Task 9-12 の Step 3 直前の差分表）。ここでの目的は「監査ログを書かない読み取り専用リポジトリ」という形の見本を 1 本置くことであって、KPI の確定仕様を決めることではない。**この型を import する側を Task 9-11 までに作らないこと。** 参照が `admin-stats-repository.ts` の中だけに閉じていれば、Task 9-12 の差し替えで壊れる箇所が 0 になる。

`apps/api/src/repositories/admin-stats-repository.ts`

```ts
import { and, count, eq, gte } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  APPLICATION_STATUS_PENDING,
  PROFILE_STATUS_SUSPENDED,
  REPORT_STATUS_OPEN,
  REVIEW_STATUS_PUBLISHED,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import { profiles, reports, reviews, shopApplications, shops } from '../db/schema';

export type AdminOverviewStats = {
  readonly newShopCount: number;
  readonly newReviewCount: number;
  readonly pendingApplicationCount: number;
  readonly openReportCount: number;
  readonly suspendedUserCount: number;
};

/** count() の結果は 1 行しか返らないが、noUncheckedIndexedAccess 下では undefined を潰す必要がある */
const EMPTY_COUNT = 0;

function firstCount(rows: readonly { readonly value: number }[]): number {
  return rows[0]?.value ?? EMPTY_COUNT;
}

/**
 * 管理トップの KPI。「新規」は呼び出し側が渡した時刻以降で数える。
 * 期間の既定値をここに埋めるとルート側の指定が効かなくなるので、必ず引数で受ける。
 */
export async function getOverviewStats(
  db: Database,
  _actor: AdminActor,
  sinceMs: number,
): Promise<AdminOverviewStats> {
  const since = new Date(sinceMs);

  const [newShops, newReviews, pendingApplications, openReports, suspendedUsers] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(shops)
        .where(and(gte(shops.createdAt, since), eq(shops.status, SHOP_STATUS_PUBLISHED))),
      db
        .select({ value: count() })
        .from(reviews)
        .where(and(gte(reviews.createdAt, since), eq(reviews.status, REVIEW_STATUS_PUBLISHED))),
      db
        .select({ value: count() })
        .from(shopApplications)
        .where(eq(shopApplications.status, APPLICATION_STATUS_PENDING)),
      db.select({ value: count() }).from(reports).where(eq(reports.status, REPORT_STATUS_OPEN)),
      db
        .select({ value: count() })
        .from(profiles)
        .where(eq(profiles.status, PROFILE_STATUS_SUSPENDED)),
    ]);

  return {
    newShopCount: firstCount(newShops),
    newReviewCount: firstCount(newReviews),
    pendingApplicationCount: firstCount(pendingApplications),
    openReportCount: firstCount(openReports),
    suspendedUserCount: firstCount(suspendedUsers),
  };
}
```

Run: `npm test -w @meshimap/api -- admin-audit-convention`
Expected: PASS（11 件）。`admin-stats-repository.ts` は読み取りだけなので違反 0 件になる。

- [ ] **Step 5: Phase 4 の規約検査も通ることを確認する**

Run: `npm test -w @meshimap/api -- repository-convention`
Expected: PASS。`admin-stats-repository.ts` の第 1 引数が `db: Database`、第 2 引数が `_actor: AdminActor` なので Phase 4 の 6 規約も満たす。ここが落ちたら Phase 4 側の規約に合わせる（Phase 4 が正）。

- [ ] **Step 6: わざと壊して、検査が効いていることを確認する**

`admin-stats-repository.ts` の末尾に次を足す。

```ts
export async function breakAuditRule(db: Database, _actor: AdminActor): Promise<void> {
  await db.delete(reports);
}
```

Run: `npm test -w @meshimap/api -- admin-audit-convention`
Expected: FAIL。`admin-stats-repository.ts` のケースが落ち、違反として

- `admin-stats-repository.ts:NN 書き込みビルダーを await しています。文は withAuditLog に渡すこと`
- `admin-stats-repository.ts の breakAuditRule が書き込みを組み立てているのに withAuditLog を呼んでいません`

の 2 件が並ぶ。確認できたら足した関数を消す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-audit-convention.test.ts apps/api/src/repositories/__fixtures__ apps/api/src/repositories/admin-stats-repository.ts
git commit -m "test(api): 管理リポジトリの監査ログ規約をソース走査で機械的に縛る"
```

---

### Task 9-3: 監査ログ記録の網羅検査（実 D1 + 表の網羅性照合）

Task 9-2 が「書ける形になっているか」を見るのに対し、ここは「実際に呼んだら 1 行増えるか」と「検査の表自体に漏れが無いか」を見る。**この 2 本立てが揃って初めて記録漏れが塞がる。**

このタスクでは表の枠組みと 1 ケース目（`admin-stats-repository.ts` には書き込み関数が無いので、まず空でも成立することを確かめる）だけを作り、Task 9-5 以降で書き込み関数を足すたびに**同じコミットの中で**表へ 1 行足す。

**Files:**

- Create: `apps/api/src/db/testing/admin-world.ts`（置き場所の根拠は下記）
- Create: `apps/api/src/repositories/admin-audit-coverage.test.ts`

**Interfaces:**

- Consumes: Task 9-2 の `listAdminRepositoryFiles` / `listAuditedWriteFunctionNames`、Phase 4 の `apps/api/src/test/fixtures.ts` の `createTestWorld` / `seedMasters` / `seedUser` / `seedShop` / `seedReview` / `readRow` / `countRows` / `runWrite` / `buildActorForTest` / `adminActorOrThrow` / `TEST_GENRE_ID` / `TEST_AREA_ID` / `TestWorld`
- Produces:
  - `type AdminWorld = { readonly db: Database; readonly world: TestWorld; readonly actor: AdminActor; readonly ids: AdminWorldIds; readonly dispose: () => Promise<void> }`
  - `createAdminWorld(): Promise<AdminWorld>`
  - `AdminWorldIds`（シードした行の ID をまとめたもの）

**置き場所の理由。** 最初 `src/repositories/admin-test-world.ts` に置こうとしたが、3 つの制約に引っかかる。

1. Task 9-2 の `listAdminRepositoryFiles` は `src/repositories/` の `admin-` で始まる `.ts` を対象にするので、名前を変えれば外れる。
2. Phase 4 の `repository-convention.test.ts` は `src/repositories/*.ts` を**全部**見て「export された関数の第 1 引数が `db: Database`」を要求する。`createAdminWorld()` は引数を取らないので、`src/repositories/` に置く限り名前を変えても違反になる。
3. `src/test/fixtures.ts` の隣（`src/test/admin-world.ts`）も考えたが、`stryker.config.mjs` の `mutate` は `src/**/*.ts` から `src/db/schema/**` と `src/db/testing/**` しか除いていないので、`src/test/**` は**変異対象に入る**。シードの文字列リテラル（店名やメールアドレス）を書き換える変異は誰も殺せないので、ミューテーションスコアが理由もなく下がる。`stryker.config.mjs` には「除外を増やすときは『サンドボックス外を読むから』以外の理由を認めないこと」と明記されているので、設定を緩めて解決するのは禁じ手。

したがって **`src/db/testing/admin-world.ts`** に置く。ここは既存の `local-d1.ts` と同じディレクトリで、`vitest.config.ts` の `coverage.exclude` にも `stryker.config.mjs` の `mutate` 除外にも `src/db/testing/**` として**すでに入っている**（両ファイルを開いて確認済み）。テスト用の道具置き場として既に想定されている場所である。

**`src/test/fixtures.ts` との関係。** 車輪の再発明をしない。世界の生成（`createTestWorld`）・マスタ投入（`seedMasters`）・ユーザー投入（`seedUser`）・店舗投入（`seedShop`）・レビュー投入（`seedReview`）・生 SQL の読み書き（`readRow` / `countRows` / `runWrite`）はすべて Phase 4 の `src/test/fixtures.ts` にあるので、`admin-world.ts` はその上に「管理系だけが要る行（通報・申請）」と「Drizzle の `Database`」と「`AdminActor`」を足す薄い層にする。`toActor` を直接 import しないのは、`auth/actor-encapsulation.test.ts` のホワイトリストに `db/testing/admin-world.ts` が入っていないため。`buildActorForTest` と `adminActorOrThrow` を経由する。

**Files（確定）:**

- Create: `apps/api/src/db/testing/admin-world.ts`
- Create: `apps/api/src/repositories/admin-audit-coverage.test.ts`

- [ ] **Step 1: テスト用の世界を作る**

`apps/api/src/db/testing/admin-world.ts`

列名は `apps/api/src/db/schema/` の実体に合わせてある。特に注意した点を先に挙げる。

- `shops` の緯度経度は Drizzle 側で **`lat` / `lng`**（`latitude` / `longitude` ではない）。`address` は NOT NULL。
- `user.emailVerified` は `{ mode: 'boolean' }` なので `false` を渡す（`0` ではない）。
- `shopApplications.documents` は `readonly ApplicationDocument[]` の JSON で NOT NULL（既定 `[]`）。
- `genres.slug` は UNIQUE で `ck_genres_slug_format` が `a-z0-9-` だけを許す。
- `areas.prefecture` は NOT NULL。
- 時刻列はすべて `{ mode: 'timestamp_ms' }` なので `Date` を渡す。数値を渡すと Drizzle の型で弾かれる。

```ts
import type { AdminActor } from '../../auth/actor';
import {
  TEST_AREA_ID,
  TEST_GENRE_ID,
  adminActorOrThrow,
  buildActorForTest,
  createTestWorld,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  type TestWorld,
} from '../../test/fixtures';
import { createDatabase, type Database } from '../client';
import {
  APPLICATION_STATUS_PENDING,
  REPORT_STATUS_OPEN,
  REPORT_TARGET_TYPE_REVIEW,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
} from '../constants';
import { reports, shopApplications } from '../schema';

/**
 * 管理リポジトリのテストが共有するシード済みの世界。
 *
 * ケースごとに作り直す。使い回すと、あるケースが状態を変えた結果として
 * 次のケースが通る／落ちるという再現しないテストになる。
 *
 * 生成・投入の大半は Phase 4 の src/test/fixtures.ts に任せ、
 * ここは「管理系のテストだけが要る行」と Drizzle の Database、AdminActor を足すだけにする。
 */
export type AdminWorldIds = {
  readonly adminUserId: string;
  readonly normalUserId: string;
  readonly ownerUserId: string;
  readonly genreId: string;
  readonly areaId: string;
  readonly shopId: string;
  readonly reviewId: string;
  readonly reportId: string;
  readonly applicationId: string;
};

export type AdminWorld = {
  /** Drizzle 経由。リポジトリ関数に渡す */
  readonly db: Database;
  /** 生 SQL 経由。**リポジトリ層を通さずに DB の実体を見る**ために使う */
  readonly world: TestWorld;
  readonly actor: AdminActor;
  readonly ids: AdminWorldIds;
  readonly dispose: () => Promise<void>;
};

const IDS: AdminWorldIds = {
  adminUserId: 'usr_admin_0001',
  normalUserId: 'usr_normal_0001',
  ownerUserId: 'usr_owner_0001',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  shopId: 'shp_0001',
  reviewId: 'rvw_0001',
  reportId: 'rep_0001',
  applicationId: 'app_0001',
};

/** レビューの評価。1〜5 の CHECK の内側で、境界値ではない値を選ぶ */
const SEED_RATING = 4;

/** シードした行の作成時刻。0 だと「未設定」と紛らわしいので固定の過去日時にする */
const SEED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

export async function createAdminWorld(): Promise<AdminWorld> {
  const world = await createTestWorld();
  // drizzle(world.d1) ではなく createDatabase を使う。
  // schema を型引数に渡さないと DrizzleD1Database<Record<string, never>> になり、
  // Database（= DrizzleD1Database<typeof schema>）に代入できない。
  const db: Database = createDatabase(world.d1);

  await seedMasters(world);
  await seedUser(world, { userId: IDS.adminUserId, role: ROLE_ADMIN, displayName: '管理 太郎' });
  await seedUser(world, { userId: IDS.normalUserId, role: ROLE_USER, displayName: '利用 花子' });
  await seedUser(world, { userId: IDS.ownerUserId, role: ROLE_OWNER, displayName: '店主 次郎' });
  await seedShop(world, { id: IDS.shopId, ownerId: IDS.ownerUserId, name: 'めし処テスト' });
  await seedReview(world, {
    id: IDS.reviewId,
    shopId: IDS.shopId,
    userId: IDS.normalUserId,
    rating: SEED_RATING,
    body: 'おいしかった',
    createdAtMs: SEED_CREATED_AT.getTime(),
  });

  // 管理系だけが要る 2 行。fixtures に無いのでここで入れる
  await db.batch([
    db.insert(reports).values({
      id: IDS.reportId,
      reporterId: IDS.normalUserId,
      targetType: REPORT_TARGET_TYPE_REVIEW,
      targetId: IDS.reviewId,
      reason: '不適切な内容',
      status: REPORT_STATUS_OPEN,
      createdAt: SEED_CREATED_AT,
    }),
    db.insert(shopApplications).values({
      id: IDS.applicationId,
      applicantId: IDS.ownerUserId,
      shopId: IDS.shopId,
      documents: [{ kind: 'business-license', r2Key: 'docs/app_0001/license.pdf' }],
      status: APPLICATION_STATUS_PENDING,
      createdAt: SEED_CREATED_AT,
    }),
  ]);

  return {
    db,
    world,
    actor: adminActorOrThrow(buildActorForTest(IDS.adminUserId, ROLE_ADMIN)),
    ids: IDS,
    dispose: world.dispose,
  };
}
```

`documents` に渡す `{ kind, r2Key }` は `apps/api/src/db/schema/admin.ts` の `ApplicationDocument` そのもの。`kind` に許される値は同ファイルの定義に従うので、型エラーが出たら値を捏造せず定義を読み直すこと。

シードが落ちたときは、まず `sed -n '/CREATE TABLE \`shops\`/,/^);/p' apps/api/migrations/0000_init.sql` で NOT NULL と CHECK を突き合わせる。Drizzle のフィールド名と列名は別物なので、**列名ではなくフィールド名**（`db/schema/*.ts` の左辺）を見ること。

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/admin-audit-coverage.test.ts`

```ts
import { count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import {
  listAdminRepositoryFiles,
  listAuditedWriteFunctionNames,
} from './admin-audit-convention.test';

/**
 * 管理系の書き込み関数が「呼べば必ず監査ログが増える」ことを実 D1 で確かめる。
 *
 * 表に載せ忘れたらこのテストは素通りしてしまうので、
 * 最後の it で「表に並んだ関数名の集合」と
 * 「ソース走査で見つけた書き込み関数名の集合」の一致まで見る。
 * 新しい管理操作を足して表に書き忘れると、そこで落ちる。
 */

type AuditedWriteCase = {
  /** ソース走査で得られる名前と厳密に一致させる */
  readonly functionName: string;
  readonly label: string;
  /** 1 回の呼び出しで増える監査行の数。ふつうは 1 */
  readonly expectedAuditCount: number;
  readonly run: (world: AdminWorld) => Promise<void>;
};

/** Task 9-5 以降、書き込み関数を足すたびにここへ 1 行足す */
export const AUDITED_WRITE_CASES: readonly AuditedWriteCase[] = [];

async function countAuditLogs(world: AdminWorld): Promise<number> {
  const rows = await world.db.select({ value: count() }).from(auditLogs);
  return rows[0]?.value ?? 0;
}

describe('管理系の書き込みは必ず監査ログを残す', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it.each(AUDITED_WRITE_CASES)(
    '$label は監査ログを $expectedAuditCount 行足す',
    async (testCase) => {
      const before = await countAuditLogs(world);

      await testCase.run(world);

      expect(await countAuditLogs(world)).toBe(before + testCase.expectedAuditCount);
    },
  );
});

describe('監査ログ検査の網羅', () => {
  it('ソースにある書き込み関数がすべて表に載っている', () => {
    const declared = [
      ...new Set(
        listAdminRepositoryFiles().flatMap((filePath) => listAuditedWriteFunctionNames(filePath)),
      ),
    ].sort();
    const covered = [
      ...new Set(AUDITED_WRITE_CASES.map((testCase) => testCase.functionName)),
    ].sort();

    expect(covered).toEqual(declared);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-audit-coverage`
Expected: FAIL。`it.each([])` は vitest が「空の each」で落とすので、まず `AUDITED_WRITE_CASES` が空のままでは動かないことを確認する。**ここで `it.each` を空配列で回す構造の弱点が見えるので、次の Step で直す。**

- [ ] **Step 4: 空の表でも成立する形に直す**

`it.each` を空配列で呼べない問題は、`describe.skipIf` ではなく「表が空なら『まだ書き込み関数が無い』ことを主張する `it` に切り替える」で解く。除外ではなく、空であること自体を検査対象にする。

```ts
describe('管理系の書き込みは必ず監査ログを残す', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  if (AUDITED_WRITE_CASES.length === 0) {
    it('書き込み関数がまだ 1 つも無い（ソース走査の結果と一致していること）', () => {
      const declared = listAdminRepositoryFiles().flatMap((filePath) =>
        listAuditedWriteFunctionNames(filePath),
      );

      expect(declared).toEqual([]);
    });
  } else {
    it.each(AUDITED_WRITE_CASES)(
      '$label は監査ログを $expectedAuditCount 行足す',
      async (testCase) => {
        const before = await countAuditLogs(world);

        await testCase.run(world);

        expect(await countAuditLogs(world)).toBe(before + testCase.expectedAuditCount);
      },
    );
  }
});
```

Run: `npm test -w @meshimap/api -- admin-audit-coverage`
Expected: PASS（2 件）。Task 9-5 以降で表に行が入ると自動的に `it.each` 側へ切り替わる。

- [ ] **Step 5: わざと壊して、網羅の検査が効いていることを確認する**

`admin-stats-repository.ts` の末尾に、監査ログを正しく書く**が表には載せない**関数を足す。

```ts
import { withAuditLog, AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../lib/audit-log';
import { genres } from '../db/schema';

export async function createDummyGenre(db: Database, actor: AdminActor): Promise<void> {
  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.genreCreate,
      targetType: AUDIT_TARGET_TYPES.genre,
      targetId: 'gnr_dummy',
      diff: null,
    },
    [db.insert(genres).values({ id: 'gnr_dummy', name: 'ダミー', slug: 'dummy' })],
  );
}
```

Run: `npm test -w @meshimap/api -- admin-audit-coverage`
Expected: FAIL。「ソースにある書き込み関数がすべて表に載っている」が `[] ` と `['createDummyGenre']` の差で落ちる。**Task 9-2 の規約検査は通ってしまう**（規約どおりに書いてあるので）ことも合わせて確認する。この 2 本が別々の穴を塞いでいる証拠になる。確認できたら足した関数と import を消す。

- [ ] **Step 6: コミットする**

```bash
git add apps/api/src/db/testing/admin-world.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "test(api): 管理系書き込みの監査ログ記録を実 D1 で網羅検査する枠組みを追加"
```

---

### Task 9-4: カーソル（キーセット）ページングの基盤

**Files:**

- Create: `apps/api/src/lib/cursor.ts`
- Test: `apps/api/src/lib/cursor.test.ts`

**Interfaces:**

- Consumes: `drizzle-orm` の `sql` / `SQL`、`drizzle-orm/sqlite-core` の `AnySQLiteColumn`
- Produces:
  - `type Cursor = { readonly createdAtMs: number; readonly id: string }`
  - `type CursorPage<T> = { readonly items: readonly T[]; readonly nextCursor: string | null }`
  - `PAGE_SIZE_DEFAULT: 20` / `PAGE_SIZE_MAX: 100`
  - `encodeCursor(cursor: Cursor): string`
  - `decodeCursor(raw: string): Cursor | null`
  - `clampPageSize(requested: number | null): number`
  - `buildKeysetCondition(createdAtColumn: AnySQLiteColumn, idColumn: AnySQLiteColumn, cursor: Cursor): SQL`
  - `buildCursorPage<T>(rows: readonly T[], limit: number, toCursor: (row: T) => Cursor): CursorPage<T>`

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/lib/cursor.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCursorPage,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from './cursor';

describe('encodeCursor / decodeCursor', () => {
  it('作った文字列をそのまま戻せる', () => {
    const cursor = { createdAtMs: 1_789_500_000_000, id: 'aud_0001' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('createdAtMs が 0 でも通る（下限の境界）', () => {
    expect(decodeCursor('0:a')).toEqual({ createdAtMs: 0, id: 'a' });
  });

  it('区切りが無い文字列は null', () => {
    expect(decodeCursor('1789500000000')).toBeNull();
  });

  it('先頭が区切りの文字列は null', () => {
    expect(decodeCursor(':aud_0001')).toBeNull();
  });

  it('ID が空の文字列は null', () => {
    expect(decodeCursor('1789500000000:')).toBeNull();
  });

  it('時刻が数字以外を含むと null', () => {
    expect(decodeCursor('178950000000a:aud_0001')).toBeNull();
  });

  it('時刻が負号付きだと null', () => {
    expect(decodeCursor('-1:aud_0001')).toBeNull();
  });

  it('安全な整数の上限を超えると null', () => {
    expect(decodeCursor('9007199254740992:aud_0001')).toEqual({
      createdAtMs: 9_007_199_254_740_992,
      id: 'aud_0001',
    });
    expect(decodeCursor('9007199254740993:aud_0001')).toBeNull();
  });

  it('空文字は null', () => {
    expect(decodeCursor('')).toBeNull();
  });
});

describe('clampPageSize', () => {
  it('未指定なら既定値', () => {
    expect(clampPageSize(null)).toBe(PAGE_SIZE_DEFAULT);
  });

  it('1 は通る（下限ちょうど）', () => {
    expect(clampPageSize(1)).toBe(1);
  });

  it('0 は既定値へ倒す', () => {
    expect(clampPageSize(0)).toBe(PAGE_SIZE_DEFAULT);
  });

  it('上限ちょうどは通る', () => {
    expect(clampPageSize(PAGE_SIZE_MAX)).toBe(PAGE_SIZE_MAX);
  });

  it('上限 +1 は上限へ丸める', () => {
    expect(clampPageSize(PAGE_SIZE_MAX + 1)).toBe(PAGE_SIZE_MAX);
  });

  it('整数でない値は既定値へ倒す', () => {
    expect(clampPageSize(1.5)).toBe(PAGE_SIZE_DEFAULT);
  });
});

describe('buildCursorPage', () => {
  const toCursor = (row: { readonly createdAtMs: number; readonly id: string }) => row;

  it('limit + 1 件取れたら 1 件削って nextCursor を返す', () => {
    const rows = [
      { createdAtMs: 3, id: 'c' },
      { createdAtMs: 2, id: 'b' },
      { createdAtMs: 1, id: 'a' },
    ];

    expect(buildCursorPage(rows, 2, toCursor)).toEqual({
      items: [
        { createdAtMs: 3, id: 'c' },
        { createdAtMs: 2, id: 'b' },
      ],
      nextCursor: '2:b',
    });
  });

  it('limit ちょうどなら nextCursor は null（境界）', () => {
    const rows = [
      { createdAtMs: 3, id: 'c' },
      { createdAtMs: 2, id: 'b' },
    ];

    expect(buildCursorPage(rows, 2, toCursor)).toEqual({ items: rows, nextCursor: null });
  });

  it('0 件なら空ページ', () => {
    expect(buildCursorPage([], 2, toCursor)).toEqual({ items: [], nextCursor: null });
  });

  it('limit 0 で行が来たら空ページを返す（nextCursor を作る材料が無い）', () => {
    expect(buildCursorPage([{ createdAtMs: 1, id: 'a' }], 0, toCursor)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- cursor`
Expected: FAIL。`Failed to resolve import "./cursor"`。

- [ ] **Step 3: 最小実装を書く**

`apps/api/src/lib/cursor.ts`

```ts
import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * カーソル（キーセット）ページング。
 *
 * オフセットを使わない理由は 2 つ。
 * 1. 監査ログのような追記専用の表は増え続け、OFFSET N は N 行を実際に辿るので深いページほど遅くなる。
 * 2. 管理者の操作で先頭に行が増え続けるため、オフセットでは同じ行が 2 ページ目に再登場する。
 *
 * 並びは `(created_at DESC, id DESC)` で全順序にする。
 * batch() は同一ミリ秒に複数行を書くので、created_at だけでは順序が決まらない。
 */
export type Cursor = {
  readonly createdAtMs: number;
  readonly id: string;
};

export type CursorPage<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_MIN = 1;

/** Base64 にしない。中身が読めても害が無く、読めたほうが障害調査が早い */
const CURSOR_SEPARATOR = ':';
const DIGITS_ONLY_PATTERN = /^[0-9]+$/;
const EMPTY_STRING = '';

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.createdAtMs}${CURSOR_SEPARATOR}${cursor.id}`;
}

/** 壊れたカーソルは例外ではなく null。利用者が URL を書き換えても 500 にしない */
export function decodeCursor(raw: string): Cursor | null {
  const separatorIndex = raw.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  const id = raw.slice(separatorIndex + 1);
  if (id === EMPTY_STRING) {
    return null;
  }

  const createdAtPart = raw.slice(0, separatorIndex);
  if (!DIGITS_ONLY_PATTERN.test(createdAtPart)) {
    return null;
  }

  const createdAtMs = Number(createdAtPart);
  if (!Number.isSafeInteger(createdAtMs)) {
    return null;
  }

  return { createdAtMs, id };
}

export function clampPageSize(requested: number | null): number {
  if (requested === null || !Number.isInteger(requested) || requested < PAGE_SIZE_MIN) {
    return PAGE_SIZE_DEFAULT;
  }
  return Math.min(requested, PAGE_SIZE_MAX);
}

/**
 * `(created_at, id)` の降順に対するキーセット述語。
 *
 * `and()` / `or()` は `SQL | undefined` を返すので `!` が要る。
 * 非 null アサーションは禁止なので `sql` テンプレートで直接書く。
 * timestamp_ms 列は整数なので、Date ではなくミリ秒の数値をそのまま束縛する。
 */
export function buildKeysetCondition(
  createdAtColumn: AnySQLiteColumn,
  idColumn: AnySQLiteColumn,
  cursor: Cursor,
): SQL {
  return sql`(${createdAtColumn} < ${cursor.createdAtMs} OR (${createdAtColumn} = ${cursor.createdAtMs} AND ${idColumn} < ${cursor.id}))`;
}

/**
 * `limit + 1` 件取ってきた行からページを組む。
 * 「次がある」を件数で判定するので、総件数を数える COUNT クエリが要らない。
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): CursorPage<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }

  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  if (lastItem === undefined) {
    return { items, nextCursor: null };
  }

  return { items, nextCursor: encodeCursor(toCursor(lastItem)) };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- cursor`
Expected: PASS（19 件）

- [ ] **Step 5: わざと壊して、境界のテストが効いていることを確認する**

`clampPageSize` の `requested < PAGE_SIZE_MIN` を `requested < 0` に書き換える。

Run: `npm test -w @meshimap/api -- cursor`
Expected: FAIL。「0 は既定値へ倒す」が `0` を返して落ちる。次に `Math.min(requested, PAGE_SIZE_MAX)` を `Math.max(...)` に書き換えると「上限 +1 は上限へ丸める」が落ちる。両方確認したら戻す。

- [ ] **Step 6: コミットする**

```bash
git add apps/api/src/lib/cursor.ts apps/api/src/lib/cursor.test.ts
git commit -m "feat(api): 監査ログ・各キューで共有するカーソルページング基盤を追加"
```

---

### Task 9-5: 店舗申請の審査キュー（一覧 / 詳細 / 承認 / 差し戻し / 却下）

**Files:**

- Create: `apps/api/src/lib/identifier.ts`
- Create: `apps/api/src/lib/admin-outcome.ts`
- Create: `apps/api/src/repositories/admin-application-repository.ts`
- Modify: `apps/api/src/lib/audit-log.ts`（`createAuditLogId` を `createPrefixedId` に寄せる）
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 3 行足す）
- Test: `apps/api/src/repositories/admin-application-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 の `withAuditLog` / `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES` / `buildAuditDiff` / `SqliteStatement`、Task 9-4 の `buildCursorPage` / `buildKeysetCondition` / `Cursor` / `CursorPage`、Task 9-3 の `createAdminWorld`
- Produces:
  - `createPrefixedId(prefix: string): string` / `ID_PREFIXES`
  - `ADMIN_WRITE_OUTCOME` / `type AdminWriteOutcome = 'ok' | 'not-found' | 'conflict'`
  - `type AdminApplicationSummary` / `type AdminApplicationDetail` / `type ListApplicationsParams`
  - `listApplications(db, _actor, params): Promise<CursorPage<AdminApplicationSummary>>`
  - `getApplication(db, _actor, applicationId: string): Promise<AdminApplicationDetail | null>`
  - `approveApplication(db, actor, applicationId: string): Promise<AdminWriteOutcome>`
  - `returnApplication(db, actor, applicationId: string, reviewNote: string): Promise<AdminWriteOutcome>`
  - `rejectApplication(db, actor, applicationId: string, reviewNote: string): Promise<AdminWriteOutcome>`

- [ ] **Step 1: 共有の小物を作る**

`apps/api/src/lib/identifier.ts`

```ts
/** UUID からハイフンを抜いた 32 文字に接頭辞を付ける。ID 列の CHECK は「64 文字以内」だけ */
const UUID_HYPHEN = '-';

export const ID_PREFIXES = {
  auditLog: 'aud_',
  notification: 'ntf_',
  genre: 'gnr_',
  area: 'are_',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export function createPrefixedId(prefix: IdPrefix): string {
  return `${prefix}${crypto.randomUUID().replaceAll(UUID_HYPHEN, '')}`;
}
```

`apps/api/src/lib/admin-outcome.ts`

```ts
/**
 * 管理系の書き込みの結果。
 *
 * 例外ではなく値で返す。ルート側は `ok` → 200、`not-found` → 404、`conflict` → 409 に
 * 1 対 1 で写すだけになり、どこかで握りつぶされる余地が無くなる。
 */
export const ADMIN_WRITE_OUTCOME = {
  ok: 'ok',
  notFound: 'not-found',
  conflict: 'conflict',
} as const;

export type AdminWriteOutcome = (typeof ADMIN_WRITE_OUTCOME)[keyof typeof ADMIN_WRITE_OUTCOME];
```

`apps/api/src/lib/audit-log.ts` の `createAuditLogId` を差し替える（重複した ID 生成を 1 箇所に寄せる）。

```ts
// 追加する import
import { createPrefixedId, ID_PREFIXES } from './identifier';

// 置き換える本体（AUDIT_LOG_ID_PREFIX と UUID_HYPHEN の定数は削除する）
export function createAuditLogId(): string {
  return createPrefixedId(ID_PREFIXES.auditLog);
}
```

Run: `npm test -w @meshimap/api -- audit-log`
Expected: PASS（22 件。`aud_ で始まり、ハイフンを含まない` が引き続き通ることを確認する）

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/admin-application-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import { auditLogs, notifications, profiles, shopApplications, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import {
  approveApplication,
  getApplication,
  listApplications,
  rejectApplication,
  returnApplication,
} from './admin-application-repository';

const PAGE_LIMIT = 20;
const REVIEW_NOTE = '営業許可証の写しが不鮮明です。再提出してください。';

describe('listApplications', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('申請一覧に店舗名と申請者名が入る', async () => {
    const page = await listApplications(world.db, world.actor, {
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([
      {
        applicationId: world.ids.applicationId,
        shopId: world.ids.shopId,
        shopName: 'めし処テスト',
        applicantId: world.ids.ownerUserId,
        applicantName: '店主 次郎',
        status: 'pending',
        documentCount: 1,
        createdAtMs: expect.any(Number),
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('status で絞り込める', async () => {
    const page = await listApplications(world.db, world.actor, {
      status: 'approved',
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([]);
  });

  it('limit 1 で 2 件目があれば nextCursor が返る', async () => {
    await world.db.insert(shopApplications).values({
      id: 'app_0002',
      applicantId: world.ids.normalUserId,
      shopId: world.ids.shopId,
      documents: [],
      status: 'rejected',
    });

    const page = await listApplications(world.db, world.actor, {
      status: null,
      limit: 1,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('getApplication', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('提出書類の中身まで返す', async () => {
    const detail = await getApplication(world.db, world.actor, world.ids.applicationId);

    expect(detail?.documents).toEqual([
      { kind: 'business-license', r2Key: 'docs/app_0001/license.pdf' },
    ]);
  });

  it('存在しない ID は null', async () => {
    expect(await getApplication(world.db, world.actor, 'app_missing')).toBeNull();
  });
});

describe('approveApplication', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('申請を承認し、店舗を公開してオーナーを付ける', async () => {
    const outcome = await approveApplication(world.db, world.actor, world.ids.applicationId);

    const [application] = await world.db
      .select()
      .from(shopApplications)
      .where(eq(shopApplications.id, world.ids.applicationId));
    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(application?.status).toBe('approved');
    expect(application?.reviewedBy).toBe(world.ids.adminUserId);
    expect(shop?.status).toBe('published');
    expect(shop?.ownerId).toBe(world.ids.ownerUserId);
  });

  it('申請者へ承認通知を 1 通送る', async () => {
    await approveApplication(world.db, world.actor, world.ids.applicationId);

    const rows = await world.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, world.ids.ownerUserId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('application_approved');
    expect(rows[0]?.title).toBe('店舗申請が承認されました');
  });

  it('監査ログに前後の差分が残る', async () => {
    await approveApplication(world.db, world.actor, world.ids.applicationId);

    const [entry] = await world.db.select().from(auditLogs);

    expect(entry?.action).toBe('application.approve');
    expect(entry?.targetType).toBe('shop_application');
    expect(entry?.targetId).toBe(world.ids.applicationId);
    expect(entry?.diff).toMatchObject({ status: ['pending', 'approved'] });
  });

  it('存在しない申請は not-found', async () => {
    expect(await approveApplication(world.db, world.actor, 'app_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });

  it('すでに承認済みなら conflict で、監査ログも増えない', async () => {
    await approveApplication(world.db, world.actor, world.ids.applicationId);
    const before = await world.db.select().from(auditLogs);

    const outcome = await approveApplication(world.db, world.actor, world.ids.applicationId);
    const after = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.conflict);
    expect(after).toHaveLength(before.length);
  });

  it('申請者が利用者ロールなら owner へ上げる', async () => {
    await world.db
      .update(shopApplications)
      .set({ applicantId: world.ids.normalUserId })
      .where(eq(shopApplications.id, world.ids.applicationId));

    await approveApplication(world.db, world.actor, world.ids.applicationId);

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(profile?.role).toBe('owner');
  });
});

describe('returnApplication / rejectApplication', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('差し戻すと理由が残り、店舗の状態は変わらない', async () => {
    const outcome = await returnApplication(
      world.db,
      world.actor,
      world.ids.applicationId,
      REVIEW_NOTE,
    );

    const [application] = await world.db
      .select()
      .from(shopApplications)
      .where(eq(shopApplications.id, world.ids.applicationId));
    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(application?.status).toBe('returned');
    expect(application?.reviewNote).toBe(REVIEW_NOTE);
    expect(shop?.status).toBe('published');
  });

  it('却下すると status が rejected になり、却下通知が届く', async () => {
    await rejectApplication(world.db, world.actor, world.ids.applicationId, REVIEW_NOTE);

    const [application] = await world.db
      .select()
      .from(shopApplications)
      .where(eq(shopApplications.id, world.ids.applicationId));
    const rows = await world.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, world.ids.ownerUserId));

    expect(application?.status).toBe('rejected');
    expect(rows[0]?.type).toBe('application_rejected');
  });

  it('pending 以外を差し戻すと conflict', async () => {
    await rejectApplication(world.db, world.actor, world.ids.applicationId, REVIEW_NOTE);

    expect(
      await returnApplication(world.db, world.actor, world.ids.applicationId, REVIEW_NOTE),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-application-repository`
Expected: FAIL。`Failed to resolve import "./admin-application-repository"`。

- [ ] **Step 4: 実装を書く**

`apps/api/src/repositories/admin-application-repository.ts`

```ts
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  APPLICATION_STATUS_APPROVED,
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUS_REJECTED,
  APPLICATION_STATUS_RETURNED,
  NOTIFICATION_TYPE_APPLICATION_APPROVED,
  NOTIFICATION_TYPE_APPLICATION_REJECTED,
  NOTIFICATION_TYPE_APPLICATION_RETURNED,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_PUBLISHED,
  type ApplicationStatus,
  type NotificationType,
  type Role,
} from '../db/constants';
import {
  notifications,
  profiles,
  shopApplications,
  shops,
  type ApplicationDocument,
} from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  buildAuditDiff,
  withAuditLog,
  type AuditAction,
  type SqliteStatement,
} from '../lib/audit-log';
import { buildCursorPage, buildKeysetCondition, type Cursor, type CursorPage } from '../lib/cursor';
import { createPrefixedId, ID_PREFIXES } from '../lib/identifier';

export type AdminApplicationSummary = {
  readonly applicationId: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly applicantId: string;
  readonly applicantName: string;
  readonly status: ApplicationStatus;
  readonly documentCount: number;
  readonly createdAtMs: number;
};

export type AdminApplicationDetail = AdminApplicationSummary & {
  readonly documents: readonly ApplicationDocument[];
  readonly reviewNote: string | null;
  readonly reviewedBy: string | null;
};

export type ListApplicationsParams = {
  readonly status: ApplicationStatus | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** 通知の文面は固定。可変値を入れると文言のテストが書けなくなり、過去の通知が仕様変更で壊れる */
const DECISION_NOTIFICATIONS = {
  approved: {
    type: NOTIFICATION_TYPE_APPLICATION_APPROVED,
    title: '店舗申請が承認されました',
    body: '店舗管理の画面から店舗情報を編集できます。',
  },
  returned: {
    type: NOTIFICATION_TYPE_APPLICATION_RETURNED,
    title: '店舗申請が差し戻されました',
    body: '差し戻しの理由を確認し、書類を整えたうえで再度お申し込みください。',
  },
  rejected: {
    type: NOTIFICATION_TYPE_APPLICATION_REJECTED,
    title: '店舗申請が却下されました',
    body: '審査の結果、今回のお申し込みはお受けできませんでした。',
  },
} as const satisfies Readonly<
  Record<string, { readonly type: NotificationType; readonly title: string; readonly body: string }>
>;

type ApplicationRow = {
  readonly applicationId: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly applicantId: string;
  readonly applicantName: string;
  readonly status: ApplicationStatus;
  readonly documents: readonly ApplicationDocument[];
  readonly reviewNote: string | null;
  readonly reviewedBy: string | null;
  readonly createdAt: Date;
};

const APPLICATION_SELECTION = {
  applicationId: shopApplications.id,
  shopId: shopApplications.shopId,
  shopName: shops.name,
  applicantId: shopApplications.applicantId,
  applicantName: profiles.displayName,
  status: shopApplications.status,
  documents: shopApplications.documents,
  reviewNote: shopApplications.reviewNote,
  reviewedBy: shopApplications.reviewedBy,
  createdAt: shopApplications.createdAt,
} as const;

function toSummary(row: ApplicationRow): AdminApplicationSummary {
  return {
    applicationId: row.applicationId,
    shopId: row.shopId,
    shopName: row.shopName,
    applicantId: row.applicantId,
    applicantName: row.applicantName,
    status: row.status,
    documentCount: row.documents.length,
    createdAtMs: row.createdAt.getTime(),
  };
}

export async function listApplications(
  db: Database,
  _actor: AdminActor,
  params: ListApplicationsParams,
): Promise<CursorPage<AdminApplicationSummary>> {
  const conditions: SQL[] = [];
  if (params.status !== null) {
    conditions.push(eq(shopApplications.status, params.status));
  }
  if (params.cursor !== null) {
    conditions.push(
      buildKeysetCondition(shopApplications.createdAt, shopApplications.id, params.cursor),
    );
  }

  const rows = await db
    .select(APPLICATION_SELECTION)
    .from(shopApplications)
    .innerJoin(shops, eq(shops.id, shopApplications.shopId))
    .innerJoin(profiles, eq(profiles.userId, shopApplications.applicantId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(shopApplications.createdAt), desc(shopApplications.id))
    .limit(params.limit + 1);

  return buildCursorPage(rows.map(toSummary), params.limit, (item) => ({
    createdAtMs: item.createdAtMs,
    id: item.applicationId,
  }));
}

export async function getApplication(
  db: Database,
  _actor: AdminActor,
  applicationId: string,
): Promise<AdminApplicationDetail | null> {
  const rows = await db
    .select(APPLICATION_SELECTION)
    .from(shopApplications)
    .innerJoin(shops, eq(shops.id, shopApplications.shopId))
    .innerJoin(profiles, eq(profiles.userId, shopApplications.applicantId))
    .where(eq(shopApplications.id, applicationId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    ...toSummary(row),
    documents: row.documents,
    reviewNote: row.reviewNote,
    reviewedBy: row.reviewedBy,
  };
}

/**
 * 承認。申請・店舗・申請者のロール・通知を 1 バッチで動かす。
 *
 * UPDATE の WHERE に `status = 'pending'` を再掲しているのは、事前 SELECT から
 * バッチ実行までの間に別の管理者が同じ申請を処理した場合に二重適用しないため
 * （D1 に対話的トランザクションが無いので、これが唯一の防ぎ方）。
 */
export async function approveApplication(
  db: Database,
  actor: AdminActor,
  applicationId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({
      status: shopApplications.status,
      shopId: shopApplications.shopId,
      applicantId: shopApplications.applicantId,
      shopStatus: shops.status,
      shopOwnerId: shops.ownerId,
      applicantRole: profiles.role,
    })
    .from(shopApplications)
    .innerJoin(shops, eq(shops.id, shopApplications.shopId))
    .innerJoin(profiles, eq(profiles.userId, shopApplications.applicantId))
    .where(eq(shopApplications.id, applicationId))
    .limit(1);

  const application = rows[0];
  if (application === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (application.status !== APPLICATION_STATUS_PENDING) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const nextRole: Role =
    application.applicantRole === ROLE_USER ? ROLE_OWNER : application.applicantRole;
  const notification = DECISION_NOTIFICATIONS.approved;

  const statements: readonly SqliteStatement[] = [
    db
      .update(shopApplications)
      .set({
        status: APPLICATION_STATUS_APPROVED,
        reviewedBy: actor.userId,
        reviewNote: null,
      })
      .where(
        and(
          eq(shopApplications.id, applicationId),
          eq(shopApplications.status, APPLICATION_STATUS_PENDING),
        ),
      ),
    db
      .update(shops)
      .set({ ownerId: application.applicantId, status: SHOP_STATUS_PUBLISHED })
      .where(eq(shops.id, application.shopId)),
    db.update(profiles).set({ role: nextRole }).where(eq(profiles.userId, application.applicantId)),
    db.insert(notifications).values({
      id: createPrefixedId(ID_PREFIXES.notification),
      userId: application.applicantId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: { shopId: application.shopId },
    }),
  ];

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.applicationApprove,
      targetType: AUDIT_TARGET_TYPES.shopApplication,
      targetId: applicationId,
      diff: buildAuditDiff(
        {
          status: application.status,
          shopStatus: application.shopStatus,
          shopOwnerId: application.shopOwnerId,
          applicantRole: application.applicantRole,
        },
        {
          status: APPLICATION_STATUS_APPROVED,
          shopStatus: SHOP_STATUS_PUBLISHED,
          shopOwnerId: application.applicantId,
          applicantRole: nextRole,
        },
      ),
    },
    statements,
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function returnApplication(
  db: Database,
  actor: AdminActor,
  applicationId: string,
  reviewNote: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: shopApplications.status, applicantId: shopApplications.applicantId })
    .from(shopApplications)
    .where(eq(shopApplications.id, applicationId))
    .limit(1);

  const application = rows[0];
  if (application === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (application.status !== APPLICATION_STATUS_PENDING) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const notification = DECISION_NOTIFICATIONS.returned;
  const statements: readonly SqliteStatement[] = [
    db
      .update(shopApplications)
      .set({ status: APPLICATION_STATUS_RETURNED, reviewedBy: actor.userId, reviewNote })
      .where(
        and(
          eq(shopApplications.id, applicationId),
          eq(shopApplications.status, APPLICATION_STATUS_PENDING),
        ),
      ),
    db.insert(notifications).values({
      id: createPrefixedId(ID_PREFIXES.notification),
      userId: application.applicantId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: { applicationId },
    }),
  ];

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.applicationReturn,
      targetType: AUDIT_TARGET_TYPES.shopApplication,
      targetId: applicationId,
      diff: buildAuditDiff(
        { status: application.status },
        { status: APPLICATION_STATUS_RETURNED, reviewNote },
      ),
    },
    statements,
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function rejectApplication(
  db: Database,
  actor: AdminActor,
  applicationId: string,
  reviewNote: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: shopApplications.status, applicantId: shopApplications.applicantId })
    .from(shopApplications)
    .where(eq(shopApplications.id, applicationId))
    .limit(1);

  const application = rows[0];
  if (application === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (application.status !== APPLICATION_STATUS_PENDING) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const notification = DECISION_NOTIFICATIONS.rejected;
  const statements: readonly SqliteStatement[] = [
    db
      .update(shopApplications)
      .set({ status: APPLICATION_STATUS_REJECTED, reviewedBy: actor.userId, reviewNote })
      .where(
        and(
          eq(shopApplications.id, applicationId),
          eq(shopApplications.status, APPLICATION_STATUS_PENDING),
        ),
      ),
    db.insert(notifications).values({
      id: createPrefixedId(ID_PREFIXES.notification),
      userId: application.applicantId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: { applicationId },
    }),
  ];

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.applicationReject,
      targetType: AUDIT_TARGET_TYPES.shopApplication,
      targetId: applicationId,
      diff: buildAuditDiff(
        { status: application.status },
        { status: APPLICATION_STATUS_REJECTED, reviewNote },
      ),
    },
    statements,
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

/** 使っていない import を残さないための型エイリアス確認用。AuditAction は spec の型で使う */
export type ApplicationAuditAction = Extract<AuditAction, `application.${string}`>;
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-application-repository`
Expected: PASS（14 件）

- [ ] **Step 6: 監査ログの表に 3 行足す**

`apps/api/src/repositories/admin-audit-coverage.test.ts` の `AUDITED_WRITE_CASES` に足す。

```ts
import {
  approveApplication,
  rejectApplication,
  returnApplication,
} from './admin-application-repository';

const REVIEW_NOTE = '書類を整えて再度お申し込みください。';

export const AUDITED_WRITE_CASES: readonly AuditedWriteCase[] = [
  {
    functionName: 'approveApplication',
    label: '店舗申請の承認',
    expectedAuditCount: 1,
    run: async (world) => {
      await approveApplication(world.db, world.actor, world.ids.applicationId);
    },
  },
  {
    functionName: 'returnApplication',
    label: '店舗申請の差し戻し',
    expectedAuditCount: 1,
    run: async (world) => {
      await returnApplication(world.db, world.actor, world.ids.applicationId, REVIEW_NOTE);
    },
  },
  {
    functionName: 'rejectApplication',
    label: '店舗申請の却下',
    expectedAuditCount: 1,
    run: async (world) => {
      await rejectApplication(world.db, world.actor, world.ids.applicationId, REVIEW_NOTE);
    },
  },
];
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS。`admin-audit-convention`（**12 件**）と `admin-audit-coverage`（4 件）の両方が通る。

件数の数え方: `admin-audit-convention.test.ts` は **単発 10 件**（fixture を使う `findAuditViolations` の 8 件 + `listAuditedWriteFunctionNames` の 1 件 + `検査対象が 1 本以上ある` の 1 件）に、`it.each(targets)` が `listAdminRepositoryFiles()` の本数ぶん展開された分を足したものになる。この時点の `src/repositories/admin-*.ts`（`.test.ts` を除く）は `admin-stats-repository.ts`（Task 9-2）と `admin-application-repository.ts`（このタスク）の **2 本**なので、10 + 2 = 12 件。リポジトリを 1 本足すたびにこの件数は 1 ずつ増える。

`admin-audit-coverage` の 4 件は、`AUDITED_WRITE_CASES` の 3 行（`application.approve` / `application.reject` / `application.request_changes`）+ 表の網羅性を見る 1 件。

- [ ] **Step 7: わざと壊して、2 つの検査がそれぞれ別の穴を塞いでいることを確認する**

(a) `approveApplication` の `await withAuditLog(...)` を「監査ログを書かない直接実行」に置き換える。

```ts
await db.batch([statements[0], statements[1], statements[2], statements[3]]);
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: FAIL。規約検査が `db.batch を直接使っています` と `approveApplication が書き込みを組み立てているのに withAuditLog を呼んでいません` の 2 件を出す。

(b) (a) を戻し、今度は `AUDITED_WRITE_CASES` から `returnApplication` の行だけを消す。

Run: `npm test -w @meshimap/api -- admin-audit-coverage`
Expected: FAIL。「ソースにある書き込み関数がすべて表に載っている」が落ち、差分に `returnApplication` が出る。確認したら戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/api/src/lib/identifier.ts apps/api/src/lib/admin-outcome.ts apps/api/src/lib/audit-log.ts apps/api/src/repositories/admin-application-repository.ts apps/api/src/repositories/admin-application-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): 店舗申請の審査キュー（一覧・詳細・承認・差し戻し・却下）を追加"
```

---

### Task 9-6: 通報キュー（一覧 / 詳細 / 対応 / 却下）

**Files:**

- Create: `apps/api/src/repositories/admin-report-repository.ts`
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 2 行足す）
- Test: `apps/api/src/repositories/admin-report-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 / 9-4 / 9-5 の成果物
- Produces:
  - `REPORT_DECISIONS = { hideContent: 'hide-content', suspendUser: 'suspend-user', warn: 'warn' }` と `type ReportDecision`
  - `type AdminReportSummary` / `type AdminReportDetail` / `type ListReportsParams`
  - `listReports(db, _actor, params): Promise<CursorPage<AdminReportSummary>>`
  - `getReport(db, _actor, reportId: string): Promise<AdminReportDetail | null>`
  - `resolveReport(db, actor, reportId: string, decision: ReportDecision): Promise<AdminWriteOutcome>`
  - `rejectReport(db, actor, reportId: string): Promise<AdminWriteOutcome>`

**対応の組み合わせ（この表をそのまま実装する）:**

| 通報対象 | `hide-content`                                        | `suspend-user`                                                              | `warn`                                              |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `review` | `reviews.status = 'hidden'`（action `review.hide`）   | 投稿者の `profiles.status = 'suspended'`（action `user.suspend`）           | 投稿者へ警告通知（action `report.warn`）            |
| `shop`   | `shops.status = 'suspended'`（action `shop.suspend`） | オーナーの `profiles.status = 'suspended'`。`ownerId` が NULL なら conflict | オーナーへ警告通知。`ownerId` が NULL なら conflict |
| `user`   | **conflict**（ユーザーそのものに「非表示」は無い）    | `profiles.status = 'suspended'`                                             | 本人へ警告通知                                      |

いずれの場合も `reports` は `status = 'resolved'` / `handled_by` / `handled_at` を同時に埋める（`ck_reports_closed_requires_time` と `ck_reports_handler_requires_time` が両方を要求する）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/admin-report-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import { auditLogs, notifications, profiles, reports, reviews, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import {
  getReport,
  listReports,
  REPORT_DECISIONS,
  rejectReport,
  resolveReport,
} from './admin-report-repository';

const PAGE_LIMIT = 20;

describe('通報キュー', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('未対応の通報を新着順で返す', async () => {
    const page = await listReports(world.db, world.actor, {
      status: 'open',
      targetType: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.reportId).toBe(world.ids.reportId);
    expect(page.items[0]?.targetType).toBe('review');
  });

  it('対象種別で絞り込める', async () => {
    const page = await listReports(world.db, world.actor, {
      status: null,
      targetType: 'shop',
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([]);
  });

  it('詳細では通報対象の本文が読める', async () => {
    const detail = await getReport(world.db, world.actor, world.ids.reportId);

    expect(detail?.targetSummary).toBe('おいしかった');
  });

  it('存在しない通報は null', async () => {
    expect(await getReport(world.db, world.actor, 'rep_missing')).toBeNull();
  });

  it('レビュー通報を「非表示」で対応するとレビューが隠れる', async () => {
    const outcome = await resolveReport(
      world.db,
      world.actor,
      world.ids.reportId,
      REPORT_DECISIONS.hideContent,
    );

    const [review] = await world.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, world.ids.reviewId));
    const [report] = await world.db
      .select()
      .from(reports)
      .where(eq(reports.id, world.ids.reportId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(review?.status).toBe('hidden');
    expect(report?.status).toBe('resolved');
    expect(report?.handledBy).toBe(world.ids.adminUserId);
    expect(report?.handledAt).not.toBeNull();
    expect(entry?.action).toBe('review.hide');
    expect(entry?.diff).toMatchObject({ status: ['published', 'hidden'] });
  });

  it('「ユーザー停止」で対応すると投稿者が停止される', async () => {
    await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.suspendUser);

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(profile?.status).toBe('suspended');
  });

  it('「警告」で対応すると本人に通知が 1 通届き、内容は変わらない', async () => {
    await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.warn);

    const rows = await world.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, world.ids.normalUserId));
    const [review] = await world.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, world.ids.reviewId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('運営からの警告');
    expect(rows[0]?.type).toBe('announcement');
    expect(review?.status).toBe('published');
    expect(entry?.action).toBe('report.warn');
  });

  it('ユーザー通報に「非表示」は conflict', async () => {
    await world.db
      .update(reports)
      .set({ targetType: 'user', targetId: world.ids.normalUserId })
      .where(eq(reports.id, world.ids.reportId));

    expect(
      await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.hideContent),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('オーナー不在の店舗通報に「ユーザー停止」は conflict', async () => {
    await world.db.update(shops).set({ ownerId: null }).where(eq(shops.id, world.ids.shopId));
    await world.db
      .update(reports)
      .set({ targetType: 'shop', targetId: world.ids.shopId })
      .where(eq(reports.id, world.ids.reportId));

    expect(
      await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.suspendUser),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('却下すると内容は変わらず rejected になる', async () => {
    const outcome = await rejectReport(world.db, world.actor, world.ids.reportId);

    const [report] = await world.db
      .select()
      .from(reports)
      .where(eq(reports.id, world.ids.reportId));
    const [review] = await world.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, world.ids.reviewId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(report?.status).toBe('rejected');
    expect(report?.handledAt).not.toBeNull();
    expect(review?.status).toBe('published');
  });

  it('対応済みの通報を再度対応すると conflict', async () => {
    await rejectReport(world.db, world.actor, world.ids.reportId);

    expect(
      await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.hideContent),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('存在しない通報は not-found', async () => {
    expect(
      await resolveReport(world.db, world.actor, 'rep_missing', REPORT_DECISIONS.hideContent),
    ).toBe(ADMIN_WRITE_OUTCOME.notFound);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-report-repository`
Expected: FAIL。`Failed to resolve import "./admin-report-repository"`。

- [ ] **Step 3: 実装を書く**

`apps/api/src/repositories/admin-report-repository.ts`

```ts
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  NOTIFICATION_TYPE_ANNOUNCEMENT,
  PROFILE_STATUS_SUSPENDED,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_OPEN,
  REPORT_STATUS_REJECTED,
  REPORT_STATUS_RESOLVED,
  REPORT_TARGET_TYPE_REVIEW,
  REPORT_TARGET_TYPE_SHOP,
  REPORT_TARGET_TYPE_USER,
  REVIEW_STATUS_HIDDEN,
  SHOP_STATUS_SUSPENDED,
  type ReportStatus,
  type ReportTargetType,
} from '../db/constants';
import { notifications, profiles, reports, reviews, shops } from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  buildAuditDiff,
  withAuditLog,
  type AuditAction,
  type AuditTargetType,
  type SqliteStatement,
} from '../lib/audit-log';
import { buildCursorPage, buildKeysetCondition, type Cursor, type CursorPage } from '../lib/cursor';
import { createPrefixedId, ID_PREFIXES } from '../lib/identifier';

export const REPORT_DECISIONS = {
  hideContent: 'hide-content',
  suspendUser: 'suspend-user',
  warn: 'warn',
} as const;

export type ReportDecision = (typeof REPORT_DECISIONS)[keyof typeof REPORT_DECISIONS];

/**
 * 警告の通知。
 *
 * `notifications.type` の語彙に `warning` が無く、追加は notifications の
 * テーブル再構築マイグレーションになる（`check-constraints.test.ts` の
 * DDL 文字列一致・CHECK 個数・CHECK 名一覧の 3 本がまとめて落ちる）。
 * Phase 9 では `announcement` 型に固定文言を載せて表し、区別は監査ログの
 * action（`report.warn`）で付ける。
 */
const WARNING_NOTIFICATION = {
  type: NOTIFICATION_TYPE_ANNOUNCEMENT,
  title: '運営からの警告',
  body: '投稿の内容が利用規約に触れる可能性があります。ガイドラインをご確認ください。',
} as const;

export type AdminReportSummary = {
  readonly reportId: string;
  readonly targetType: ReportTargetType;
  readonly targetId: string;
  readonly reason: string;
  readonly status: ReportStatus;
  readonly reporterId: string | null;
  readonly createdAtMs: number;
};

export type AdminReportDetail = AdminReportSummary & {
  readonly detail: string | null;
  /** 通報対象の本文（レビューなら本文、店舗なら店名、ユーザーなら表示名） */
  readonly targetSummary: string | null;
  readonly handledBy: string | null;
  readonly handledAtMs: number | null;
};

export type ListReportsParams = {
  readonly status: ReportStatus | null;
  readonly targetType: ReportTargetType | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** 対応してよいのは未対応と確認中だけ。resolved / rejected は再対応させない */
const OPEN_STATUSES: readonly ReportStatus[] = [REPORT_STATUS_OPEN, REPORT_STATUS_IN_REVIEW];

type ReportRow = {
  readonly reportId: string;
  readonly targetType: ReportTargetType;
  readonly targetId: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly status: ReportStatus;
  readonly reporterId: string | null;
  readonly handledBy: string | null;
  readonly handledAt: Date | null;
  readonly createdAt: Date;
};

const REPORT_SELECTION = {
  reportId: reports.id,
  targetType: reports.targetType,
  targetId: reports.targetId,
  reason: reports.reason,
  detail: reports.detail,
  status: reports.status,
  reporterId: reports.reporterId,
  handledBy: reports.handledBy,
  handledAt: reports.handledAt,
  createdAt: reports.createdAt,
} as const;

function toReportSummary(row: ReportRow): AdminReportSummary {
  return {
    reportId: row.reportId,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    status: row.status,
    reporterId: row.reporterId,
    createdAtMs: row.createdAt.getTime(),
  };
}

export async function listReports(
  db: Database,
  _actor: AdminActor,
  params: ListReportsParams,
): Promise<CursorPage<AdminReportSummary>> {
  const conditions: SQL[] = [];
  if (params.status !== null) {
    conditions.push(eq(reports.status, params.status));
  }
  if (params.targetType !== null) {
    conditions.push(eq(reports.targetType, params.targetType));
  }
  if (params.cursor !== null) {
    conditions.push(buildKeysetCondition(reports.createdAt, reports.id, params.cursor));
  }

  const rows = await db
    .select(REPORT_SELECTION)
    .from(reports)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(params.limit + 1);

  return buildCursorPage(rows.map(toReportSummary), params.limit, (item) => ({
    createdAtMs: item.createdAtMs,
    id: item.reportId,
  }));
}

/** 通報対象の中身を 1 行ぶんだけ引く。対象の種類ごとに読む表が違う */
async function readTargetSummary(
  db: Database,
  targetType: ReportTargetType,
  targetId: string,
): Promise<string | null> {
  if (targetType === REPORT_TARGET_TYPE_REVIEW) {
    const rows = await db
      .select({ value: reviews.body })
      .from(reviews)
      .where(eq(reviews.id, targetId))
      .limit(1);
    return rows[0]?.value ?? null;
  }
  if (targetType === REPORT_TARGET_TYPE_SHOP) {
    const rows = await db
      .select({ value: shops.name })
      .from(shops)
      .where(eq(shops.id, targetId))
      .limit(1);
    return rows[0]?.value ?? null;
  }
  const rows = await db
    .select({ value: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.userId, targetId))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function getReport(
  db: Database,
  _actor: AdminActor,
  reportId: string,
): Promise<AdminReportDetail | null> {
  const rows = await db
    .select(REPORT_SELECTION)
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    ...toReportSummary(row),
    detail: row.detail,
    targetSummary: await readTargetSummary(db, row.targetType, row.targetId),
    handledBy: row.handledBy,
    handledAtMs: row.handledAt === null ? null : row.handledAt.getTime(),
  };
}

/**
 * 通報への対応。対象コンテンツへの処分と通報の完了を 1 バッチで行う。
 *
 * 監査ログの action は「処分の内容」に合わせる（`review.hide` / `shop.suspend` /
 * `user.suspend` / `report.warn`）。取り消し（Task 9-11）はこの action を見て
 * 対象コンテンツの状態だけを戻す。通報を対応済みに戻すことはしない
 * （対応した事実は監査の対象なので消さない）。
 */
export async function resolveReport(
  db: Database,
  actor: AdminActor,
  reportId: string,
  decision: ReportDecision,
): Promise<AdminWriteOutcome> {
  const reportRows = await db
    .select(REPORT_SELECTION)
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  const report = reportRows[0];
  if (report === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (!OPEN_STATUSES.includes(report.status)) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const handledAt = new Date();
  const closeReport = db
    .update(reports)
    .set({ status: REPORT_STATUS_RESOLVED, handledBy: actor.userId, handledAt })
    .where(and(eq(reports.id, reportId), eq(reports.status, report.status)));

  if (decision === REPORT_DECISIONS.hideContent) {
    if (report.targetType === REPORT_TARGET_TYPE_REVIEW) {
      const targetRows = await db
        .select({ status: reviews.status })
        .from(reviews)
        .where(eq(reviews.id, report.targetId))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        return ADMIN_WRITE_OUTCOME.notFound;
      }
      if (target.status === REVIEW_STATUS_HIDDEN) {
        return ADMIN_WRITE_OUTCOME.conflict;
      }

      await withAuditLog(
        db,
        actor,
        {
          action: AUDIT_ACTIONS.reviewHide,
          targetType: AUDIT_TARGET_TYPES.review,
          targetId: report.targetId,
          diff: buildAuditDiff(
            { status: target.status },
            { status: REVIEW_STATUS_HIDDEN, reportId },
          ),
        },
        [
          db
            .update(reviews)
            .set({ status: REVIEW_STATUS_HIDDEN })
            .where(and(eq(reviews.id, report.targetId), eq(reviews.status, target.status))),
          closeReport,
        ],
      );
      return ADMIN_WRITE_OUTCOME.ok;
    }

    if (report.targetType === REPORT_TARGET_TYPE_SHOP) {
      const targetRows = await db
        .select({ status: shops.status })
        .from(shops)
        .where(eq(shops.id, report.targetId))
        .limit(1);
      const target = targetRows[0];
      if (target === undefined) {
        return ADMIN_WRITE_OUTCOME.notFound;
      }
      if (target.status === SHOP_STATUS_SUSPENDED) {
        return ADMIN_WRITE_OUTCOME.conflict;
      }

      await withAuditLog(
        db,
        actor,
        {
          action: AUDIT_ACTIONS.shopSuspend,
          targetType: AUDIT_TARGET_TYPES.shop,
          targetId: report.targetId,
          diff: buildAuditDiff(
            { status: target.status },
            { status: SHOP_STATUS_SUSPENDED, reportId },
          ),
        },
        [
          db
            .update(shops)
            .set({ status: SHOP_STATUS_SUSPENDED })
            .where(and(eq(shops.id, report.targetId), eq(shops.status, target.status))),
          closeReport,
        ],
      );
      return ADMIN_WRITE_OUTCOME.ok;
    }

    // 通報対象がユーザーのとき「非表示」は意味を持たない
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const offenderId = await findOffenderId(db, report.targetType, report.targetId);
  if (offenderId === null) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const offenderRows = await db
    .select({ status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, offenderId))
    .limit(1);
  const offender = offenderRows[0];
  if (offender === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }

  if (decision === REPORT_DECISIONS.suspendUser) {
    if (offender.status === PROFILE_STATUS_SUSPENDED) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    await withAuditLog(
      db,
      actor,
      {
        action: AUDIT_ACTIONS.userSuspend,
        targetType: AUDIT_TARGET_TYPES.user,
        targetId: offenderId,
        diff: buildAuditDiff(
          { status: offender.status },
          { status: PROFILE_STATUS_SUSPENDED, reportId },
        ),
      },
      [
        db
          .update(profiles)
          .set({ status: PROFILE_STATUS_SUSPENDED })
          .where(and(eq(profiles.userId, offenderId), eq(profiles.status, offender.status))),
        closeReport,
      ],
    );
    return ADMIN_WRITE_OUTCOME.ok;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.reportWarn,
      targetType: AUDIT_TARGET_TYPES.report,
      targetId: reportId,
      diff: buildAuditDiff({ status: report.status }, { status: REPORT_STATUS_RESOLVED }),
    },
    [
      db.insert(notifications).values({
        id: createPrefixedId(ID_PREFIXES.notification),
        userId: offenderId,
        type: WARNING_NOTIFICATION.type,
        title: WARNING_NOTIFICATION.title,
        body: WARNING_NOTIFICATION.body,
        data: { reportId },
      }),
      closeReport,
    ],
  );
  return ADMIN_WRITE_OUTCOME.ok;
}

/** 処分の相手。レビューなら投稿者、店舗ならオーナー、ユーザーなら本人 */
async function findOffenderId(
  db: Database,
  targetType: ReportTargetType,
  targetId: string,
): Promise<string | null> {
  if (targetType === REPORT_TARGET_TYPE_USER) {
    return targetId;
  }
  if (targetType === REPORT_TARGET_TYPE_REVIEW) {
    const rows = await db
      .select({ value: reviews.userId })
      .from(reviews)
      .where(eq(reviews.id, targetId))
      .limit(1);
    return rows[0]?.value ?? null;
  }
  const rows = await db
    .select({ value: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, targetId))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function rejectReport(
  db: Database,
  actor: AdminActor,
  reportId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: reports.status })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  const report = rows[0];
  if (report === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (!OPEN_STATUSES.includes(report.status)) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.reportReject,
      targetType: AUDIT_TARGET_TYPES.report,
      targetId: reportId,
      diff: buildAuditDiff({ status: report.status }, { status: REPORT_STATUS_REJECTED }),
    },
    [
      db
        .update(reports)
        .set({
          status: REPORT_STATUS_REJECTED,
          handledBy: actor.userId,
          handledAt: new Date(),
        })
        .where(and(eq(reports.id, reportId), eq(reports.status, report.status))),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

/** 監査 action / target の型を使っていることを示すためのエイリアス（未使用 import を作らない） */
export type ReportAuditTarget = Extract<AuditTargetType, 'report' | 'review' | 'shop' | 'user'>;
export type ReportAuditAction = Extract<AuditAction, `report.${string}`>;
```

`readTargetSummary` と `findOffenderId` は書き込みを含まない private 関数なので、Task 9-2 の規約 5（private な書き込みヘルパの禁止）には触れない。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-report-repository`
Expected: PASS（12 件）

- [ ] **Step 5: 監査ログの表に 2 行足す**

```ts
import { REPORT_DECISIONS, rejectReport, resolveReport } from './admin-report-repository';

  {
    functionName: 'resolveReport',
    label: '通報への対応（レビュー非表示）',
    expectedAuditCount: 1,
    run: async (world) => {
      await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.hideContent);
    },
  },
  {
    functionName: 'rejectReport',
    label: '通報の却下',
    expectedAuditCount: 1,
    run: async (world) => {
      await rejectReport(world.db, world.actor, world.ids.reportId);
    },
  },
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 6: わざと壊して、対応の分岐が本当に効いていることを確認する**

`resolveReport` の `if (!OPEN_STATUSES.includes(report.status))` を `if (false)` に書き換える。

Run: `npm test -w @meshimap/api -- admin-report-repository`
Expected: FAIL。「対応済みの通報を再度対応すると conflict」が落ちる。次に `REPORT_DECISIONS.hideContent` の分岐で `REVIEW_STATUS_HIDDEN` を `REVIEW_STATUS_PUBLISHED` に書き換えると「レビュー通報を「非表示」で対応するとレビューが隠れる」が落ちる。両方確認したら戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-report-repository.ts apps/api/src/repositories/admin-report-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): 通報キュー（一覧・詳細・非表示/停止/警告・却下）を追加"
```

---

### Task 9-7: ユーザー管理（検索 / 詳細 / 停止 / 復帰 / ロール変更）

**Files:**

- Create: `apps/api/src/repositories/admin-user-repository.ts`
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 3 行足す）
- Test: `apps/api/src/repositories/admin-user-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 / 9-4 / 9-5 の成果物
- Produces:
  - `type AdminUserSummary` / `type AdminUserDetail` / `type ListUsersParams`
  - `listUsers(db, _actor, params): Promise<CursorPage<AdminUserSummary>>`
  - `getUser(db, _actor, userId: string): Promise<AdminUserDetail | null>`
  - `suspendUser(db, actor, userId: string): Promise<AdminWriteOutcome>`
  - `restoreUser(db, actor, userId: string): Promise<AdminWriteOutcome>`
  - `changeUserRole(db, actor, userId: string, nextRole: Role): Promise<AdminWriteOutcome>`

**この Task で決めておくこと:**

- **停止はセッションも消す。** `profiles.status` を `suspended` にするだけでは、すでに発行済みの Cookie がそのまま使える。Phase 4 の `resolveViewer` が `profiles.status` を見るかどうかはこの計画の時点では**未確認**（Phase 6 の実装待ち）なので、確実に締め出すために `session` 行も同じバッチで消す。`session` は Better Auth の管理テーブルだが、DELETE は Better Auth の API を通さなくても整合性が壊れない（セッションは失効させるためにある）。
- **自分自身は停止できない。** 全管理者が自分を止めて誰も入れなくなる事故を止める。`actor.userId === userId` なら `conflict`。
- **自分自身のロールも変えられない。** 同じ理由。
- **admin を停止することは許す。** 管理者が複数いる前提で、不正を働いた管理者を止められないほうが危ない。ただし自分自身は上の規則で守られる。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/admin-user-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '../db/constants';
import { auditLogs, profiles, session } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import {
  changeUserRole,
  getUser,
  listUsers,
  restoreUser,
  suspendUser,
} from './admin-user-repository';

const PAGE_LIMIT = 20;

describe('ユーザー管理', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('全ユーザーを新着順で返す', async () => {
    const page = await listUsers(world.db, world.actor, {
      keyword: null,
      role: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items.map((item) => item.userId).sort()).toEqual(
      [world.ids.adminUserId, world.ids.ownerUserId, world.ids.normalUserId].sort(),
    );
  });

  it('表示名の部分一致で絞り込める', async () => {
    const page = await listUsers(world.db, world.actor, {
      keyword: '次郎',
      role: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items.map((item) => item.userId)).toEqual([world.ids.ownerUserId]);
  });

  it('メールアドレスの部分一致でも絞り込める', async () => {
    const page = await listUsers(world.db, world.actor, {
      keyword: 'owner@',
      role: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items.map((item) => item.userId)).toEqual([world.ids.ownerUserId]);
  });

  it('キーワードの % は文字として扱う（全件ヒットしない）', async () => {
    const page = await listUsers(world.db, world.actor, {
      keyword: '%',
      role: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([]);
  });

  it('ロールで絞り込める', async () => {
    const page = await listUsers(world.db, world.actor, {
      keyword: null,
      role: ROLE_ADMIN,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items.map((item) => item.userId)).toEqual([world.ids.adminUserId]);
  });

  it('詳細ではメールと投稿数が取れる', async () => {
    const detail = await getUser(world.db, world.actor, world.ids.normalUserId);

    expect(detail?.email).toBe('user@example.test');
    expect(detail?.reviewCount).toBe(1);
    expect(detail?.shopCount).toBe(0);
  });

  it('存在しないユーザーは null', async () => {
    expect(await getUser(world.db, world.actor, 'usr_missing')).toBeNull();
  });

  it('停止するとステータスが変わり、セッションが消え、監査ログが残る', async () => {
    const outcome = await suspendUser(world.db, world.actor, world.ids.normalUserId);

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));
    const sessions = await world.db
      .select()
      .from(session)
      .where(eq(session.userId, world.ids.normalUserId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(profile?.status).toBe('suspended');
    expect(sessions).toEqual([]);
    expect(entry?.action).toBe('user.suspend');
    expect(entry?.diff).toEqual({ status: ['active', 'suspended'] });
  });

  it('停止済みをもう一度停止すると conflict', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);

    expect(await suspendUser(world.db, world.actor, world.ids.normalUserId)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('自分自身は停止できない', async () => {
    expect(await suspendUser(world.db, world.actor, world.ids.adminUserId)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('停止したユーザーを復帰できる', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);

    const outcome = await restoreUser(world.db, world.actor, world.ids.normalUserId);

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));
    const entries = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(profile?.status).toBe('active');
    expect(entries.map((entry) => entry.action)).toEqual(['user.suspend', 'user.restore']);
  });

  it('退会済み（deleted）は復帰できない', async () => {
    await world.db
      .update(profiles)
      .set({ status: 'deleted' })
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(await restoreUser(world.db, world.actor, world.ids.normalUserId)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('ロールを変えられる', async () => {
    const outcome = await changeUserRole(world.db, world.actor, world.ids.normalUserId, ROLE_OWNER);

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(profile?.role).toBe(ROLE_OWNER);
    expect(entry?.action).toBe('user.role_change');
    expect(entry?.diff).toEqual({ role: [ROLE_USER, ROLE_OWNER] });
  });

  it('同じロールへの変更は conflict で、監査ログも増えない', async () => {
    const outcome = await changeUserRole(world.db, world.actor, world.ids.normalUserId, ROLE_USER);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.conflict);
    expect(await world.db.select().from(auditLogs)).toEqual([]);
  });

  it('自分自身のロールは変えられない', async () => {
    expect(await changeUserRole(world.db, world.actor, world.ids.adminUserId, ROLE_USER)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('存在しないユーザーは not-found', async () => {
    expect(await suspendUser(world.db, world.actor, 'usr_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-user-repository`
Expected: FAIL。`Failed to resolve import "./admin-user-repository"`。

- [ ] **Step 3: 実装を書く**

`apps/api/src/repositories/admin-user-repository.ts`

```ts
import { and, countDistinct, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  PROFILE_STATUS_ACTIVE,
  PROFILE_STATUS_SUSPENDED,
  type ProfileStatus,
  type Role,
} from '../db/constants';
import { profiles, reviews, session, shops, user } from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, buildAuditDiff, withAuditLog } from '../lib/audit-log';
import { buildCursorPage, buildKeysetCondition, type Cursor, type CursorPage } from '../lib/cursor';

export type AdminUserSummary = {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
  readonly status: ProfileStatus;
  readonly createdAtMs: number;
};

export type AdminUserDetail = AdminUserSummary & {
  readonly bio: string | null;
  readonly reviewCount: number;
  readonly shopCount: number;
};

export type ListUsersParams = {
  readonly keyword: string | null;
  readonly role: Role | null;
  readonly status: ProfileStatus | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** LIKE のワイルドカードを打ち消すためのエスケープ文字 */
const LIKE_ESCAPE_CHARACTER = '\\';

/**
 * 検索語を LIKE のパターンに変換する。
 *
 * `%` `_` をそのまま渡すとワイルドカードとして働き、「%」の 1 文字検索で
 * 全ユーザーが出てしまう。エスケープしたうえで ESCAPE 句を必ず添える。
 * SQLite の LIKE は ASCII に限り大文字小文字を区別しない（日本語は影響なし）。
 */
function toLikePattern(keyword: string): string {
  const escaped = keyword
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);
  return `%${escaped}%`;
}

const USER_SELECTION = {
  userId: profiles.userId,
  displayName: profiles.displayName,
  email: user.email,
  role: profiles.role,
  status: profiles.status,
  bio: profiles.bio,
  createdAt: profiles.createdAt,
} as const;

export async function listUsers(
  db: Database,
  _actor: AdminActor,
  params: ListUsersParams,
): Promise<CursorPage<AdminUserSummary>> {
  const conditions: SQL[] = [];
  if (params.keyword !== null) {
    const pattern = toLikePattern(params.keyword);
    conditions.push(
      sql`(${profiles.displayName} LIKE ${pattern} ESCAPE '\\' OR ${user.email} LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (params.role !== null) {
    conditions.push(eq(profiles.role, params.role));
  }
  if (params.status !== null) {
    conditions.push(eq(profiles.status, params.status));
  }
  if (params.cursor !== null) {
    conditions.push(buildKeysetCondition(profiles.createdAt, profiles.userId, params.cursor));
  }

  const rows = await db
    .select(USER_SELECTION)
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(profiles.createdAt), desc(profiles.userId))
    .limit(params.limit + 1);

  const items = rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAtMs: row.createdAt.getTime(),
  }));

  return buildCursorPage(items, params.limit, (item) => ({
    createdAtMs: item.createdAtMs,
    id: item.userId,
  }));
}

export async function getUser(
  db: Database,
  _actor: AdminActor,
  userId: string,
): Promise<AdminUserDetail | null> {
  const rows = await db
    .select(USER_SELECTION)
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(profiles.userId, userId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  // 2 本に分けて数える。1 本の LEFT JOIN でまとめると直積になって件数が水増しされる
  const reviewRows = await db
    .select({ value: countDistinct(reviews.id) })
    .from(reviews)
    .where(eq(reviews.userId, userId));
  const shopRows = await db
    .select({ value: countDistinct(shops.id) })
    .from(shops)
    .where(eq(shops.ownerId, userId));

  return {
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAtMs: row.createdAt.getTime(),
    bio: row.bio,
    reviewCount: reviewRows[0]?.value ?? 0,
    shopCount: shopRows[0]?.value ?? 0,
  };
}

/**
 * 利用停止。
 *
 * `profiles.status` を落とすだけでなく、発行済みセッションも同じバッチで消す。
 * ステータスだけ変えても Cookie が生きていれば操作を続けられてしまうため。
 */
export async function suspendUser(
  db: Database,
  actor: AdminActor,
  userId: string,
): Promise<AdminWriteOutcome> {
  if (actor.userId === userId) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const rows = await db
    .select({ status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const profile = rows[0];
  if (profile === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (profile.status !== PROFILE_STATUS_ACTIVE) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.userSuspend,
      targetType: AUDIT_TARGET_TYPES.user,
      targetId: userId,
      diff: buildAuditDiff({ status: profile.status }, { status: PROFILE_STATUS_SUSPENDED }),
    },
    [
      db
        .update(profiles)
        .set({ status: PROFILE_STATUS_SUSPENDED })
        .where(and(eq(profiles.userId, userId), eq(profiles.status, PROFILE_STATUS_ACTIVE))),
      db.delete(session).where(eq(session.userId, userId)),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function restoreUser(
  db: Database,
  actor: AdminActor,
  userId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const profile = rows[0];
  if (profile === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  // 退会済み（deleted）は本人の意思なので、管理者が戻すことはしない
  if (profile.status !== PROFILE_STATUS_SUSPENDED) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.userRestore,
      targetType: AUDIT_TARGET_TYPES.user,
      targetId: userId,
      diff: buildAuditDiff({ status: profile.status }, { status: PROFILE_STATUS_ACTIVE }),
    },
    [
      db
        .update(profiles)
        .set({ status: PROFILE_STATUS_ACTIVE })
        .where(and(eq(profiles.userId, userId), eq(profiles.status, PROFILE_STATUS_SUSPENDED))),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function changeUserRole(
  db: Database,
  actor: AdminActor,
  userId: string,
  nextRole: Role,
): Promise<AdminWriteOutcome> {
  if (actor.userId === userId) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const rows = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const profile = rows[0];
  if (profile === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (profile.role === nextRole) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.userRoleChange,
      targetType: AUDIT_TARGET_TYPES.user,
      targetId: userId,
      diff: buildAuditDiff({ role: profile.role }, { role: nextRole }),
    },
    [
      db
        .update(profiles)
        .set({ role: nextRole })
        .where(and(eq(profiles.userId, userId), eq(profiles.role, profile.role))),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-user-repository`
Expected: PASS（16 件）

もし「キーワードの % は文字として扱う」が落ちたら、`ESCAPE '\\'` が SQL に `ESCAPE '\'` として出ているかを疑う。確認方法:

```bash
cd /Users/hattori/Downloads/alee/apps/api && node -e "
const { sql } = require('drizzle-orm');
" # ここでは確認できないので、代わりにテスト内で一時的に console に出さず、
  # toLikePattern('%') が '%\\%%' を返すことを単体で確かめること
```

`toLikePattern` の期待値だけを見るテストを一時的に足して切り分ける（`expect(toLikePattern('%')).toBe('%\\%%')`）。原因が特定できたら一時テストは消す。

- [ ] **Step 5: 監査ログの表に 3 行足す**

```ts
import { changeUserRole, restoreUser, suspendUser } from './admin-user-repository';
import { ROLE_OWNER } from '../db/constants';

  {
    functionName: 'suspendUser',
    label: 'ユーザーの利用停止',
    expectedAuditCount: 1,
    run: async (world) => {
      await suspendUser(world.db, world.actor, world.ids.normalUserId);
    },
  },
  {
    functionName: 'restoreUser',
    label: 'ユーザーの復帰',
    expectedAuditCount: 2,
    run: async (world) => {
      await suspendUser(world.db, world.actor, world.ids.normalUserId);
      await restoreUser(world.db, world.actor, world.ids.normalUserId);
    },
  },
  {
    functionName: 'changeUserRole',
    label: 'ロール変更',
    expectedAuditCount: 1,
    run: async (world) => {
      await changeUserRole(world.db, world.actor, world.ids.normalUserId, ROLE_OWNER);
    },
  },
```

`restoreUser` の `expectedAuditCount` が 2 なのは、復帰させるために先に停止しているから。表の意味は「この `run` を通したとき監査ログが何行増えるか」であって「関数 1 回あたり何行か」ではない。

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 6: わざと壊して、セッション削除が本当に効いていることを確認する**

`suspendUser` のバッチから `db.delete(session)...` の 1 行を消す。

Run: `npm test -w @meshimap/api -- admin-user-repository`
Expected: FAIL。「停止するとステータスが変わり、セッションが消え、監査ログが残る」が `expected [ { … } ] to deeply equal []` で落ちる。確認したら戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-user-repository.ts apps/api/src/repositories/admin-user-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): ユーザー管理（検索・詳細・停止・復帰・ロール変更）を追加"
```

---

### Task 9-8: 店舗の強制非公開・再公開・オーナー付け替え

**Files:**

- Create: `apps/api/src/repositories/admin-shop-repository.ts`
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 3 行足す）
- Test: `apps/api/src/repositories/admin-shop-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 / 9-4 / 9-5 の成果物
- Produces:
  - `type AdminShopSummary` / `type AdminShopDetail` / `type ListShopsParams`
  - `listShops(db, _actor, params): Promise<CursorPage<AdminShopSummary>>`
  - `getShopForAdmin(db, _actor, shopId: string): Promise<AdminShopDetail | null>`
  - `suspendShop(db, actor, shopId: string): Promise<AdminWriteOutcome>`
  - `restoreShop(db, actor, shopId: string): Promise<AdminWriteOutcome>`
  - `assignShopOwner(db, actor, shopId: string, nextOwnerId: string | null): Promise<AdminWriteOutcome>`

**取り消し可能性についてこの Task で確定させること:**

- **強制非公開は物理削除しない。** `shops.status` を `published` → `suspended` にするだけ。`SHOP_STATUSES` に `suspended` があることは `apps/api/src/db/constants.ts:52` で確認済み。
- **再公開は `suspended` → `published` の一手だけ。** `draft` や `closed` に戻す道は作らない（`closed` は店側の意思なので管理者が触らない）。
- **オーナー付け替えで前のオーナーのロールは下げない。** 他の店を持っている可能性があるため。監査ログの `diff` には前後の `ownerId` を必ず残し、取り消しで戻せるようにする。
- **オーナーを外す（`null`）ことも許す。** `shops.owner_id` が NULL 可であることは `apps/api/src/db/schema/shop.ts:66-67` で確認済み。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/admin-shop-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs, profiles, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import {
  assignShopOwner,
  getShopForAdmin,
  listShops,
  restoreShop,
  suspendShop,
} from './admin-shop-repository';

const PAGE_LIMIT = 20;

describe('管理者から見た店舗', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('店舗一覧にオーナー名が並ぶ', async () => {
    const page = await listShops(world.db, world.actor, {
      keyword: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([
      {
        shopId: world.ids.shopId,
        name: 'めし処テスト',
        status: 'published',
        ownerId: world.ids.ownerUserId,
        ownerName: '店主 次郎',
        createdAtMs: expect.any(Number),
      },
    ]);
  });

  it('オーナー不在の店舗も一覧に出る', async () => {
    await world.db.update(shops).set({ ownerId: null }).where(eq(shops.id, world.ids.shopId));

    const page = await listShops(world.db, world.actor, {
      keyword: null,
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items[0]?.ownerId).toBeNull();
    expect(page.items[0]?.ownerName).toBeNull();
  });

  it('店名の部分一致で絞り込める', async () => {
    const page = await listShops(world.db, world.actor, {
      keyword: 'めし処',
      status: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
  });

  it('詳細では通報件数とレビュー件数が取れる', async () => {
    const detail = await getShopForAdmin(world.db, world.actor, world.ids.shopId);

    expect(detail?.reviewCount).toBe(1);
    expect(detail?.openReportCount).toBe(0);
  });

  it('存在しない店舗は null', async () => {
    expect(await getShopForAdmin(world.db, world.actor, 'shp_missing')).toBeNull();
  });

  it('強制非公開にすると status が suspended になり、削除はされない', async () => {
    const outcome = await suspendShop(world.db, world.actor, world.ids.shopId);

    const rows = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('suspended');
    expect(entry?.action).toBe('shop.suspend');
    expect(entry?.diff).toEqual({ status: ['published', 'suspended'] });
  });

  it('非公開でない店舗を再公開すると conflict', async () => {
    expect(await restoreShop(world.db, world.actor, world.ids.shopId)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('非公開の店舗を再公開できる', async () => {
    await suspendShop(world.db, world.actor, world.ids.shopId);

    const outcome = await restoreShop(world.db, world.actor, world.ids.shopId);

    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(shop?.status).toBe('published');
  });

  it('オーナーを付け替えると新オーナーが owner ロールになる', async () => {
    const outcome = await assignShopOwner(
      world.db,
      world.actor,
      world.ids.shopId,
      world.ids.normalUserId,
    );

    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));
    const [newOwner] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));
    const [previousOwner] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.ownerUserId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(shop?.ownerId).toBe(world.ids.normalUserId);
    expect(newOwner?.role).toBe('owner');
    // 前のオーナーは他店を持っているかもしれないので下げない
    expect(previousOwner?.role).toBe('owner');
    expect(entry?.action).toBe('shop.owner_assign');
    expect(entry?.diff).toEqual({ ownerId: [world.ids.ownerUserId, world.ids.normalUserId] });
  });

  it('オーナーを外せる', async () => {
    const outcome = await assignShopOwner(world.db, world.actor, world.ids.shopId, null);

    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(shop?.ownerId).toBeNull();
    expect(entry?.diff).toEqual({ ownerId: [world.ids.ownerUserId, null] });
  });

  it('同じオーナーへの付け替えは conflict', async () => {
    expect(
      await assignShopOwner(world.db, world.actor, world.ids.shopId, world.ids.ownerUserId),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('存在しないユーザーをオーナーにすると not-found', async () => {
    expect(await assignShopOwner(world.db, world.actor, world.ids.shopId, 'usr_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });

  it('停止中のユーザーはオーナーにできない', async () => {
    await world.db
      .update(profiles)
      .set({ status: 'suspended' })
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(
      await assignShopOwner(world.db, world.actor, world.ids.shopId, world.ids.normalUserId),
    ).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('存在しない店舗は not-found', async () => {
    expect(await suspendShop(world.db, world.actor, 'shp_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-shop-repository`
Expected: FAIL。`Failed to resolve import "./admin-shop-repository"`。

- [ ] **Step 3: 実装を書く**

`apps/api/src/repositories/admin-shop-repository.ts`

```ts
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  PROFILE_STATUS_ACTIVE,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_OPEN,
  REPORT_TARGET_TYPE_SHOP,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_PUBLISHED,
  SHOP_STATUS_SUSPENDED,
  type ShopStatus,
} from '../db/constants';
import { profiles, reports, reviews, shops } from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  buildAuditDiff,
  withAuditLog,
  type SqliteStatement,
} from '../lib/audit-log';
import { inValues } from '../db/sql-helpers';
import { buildCursorPage, buildKeysetCondition, type Cursor, type CursorPage } from '../lib/cursor';

export type AdminShopSummary = {
  readonly shopId: string;
  readonly name: string;
  readonly status: ShopStatus;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly createdAtMs: number;
};

export type AdminShopDetail = AdminShopSummary & {
  readonly address: string;
  readonly reviewCount: number;
  readonly openReportCount: number;
};

export type ListShopsParams = {
  readonly keyword: string | null;
  readonly status: ShopStatus | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** LIKE のワイルドカードを打ち消すためのエスケープ文字 */
const LIKE_ESCAPE_CHARACTER = '\\';

/** まだ決着していない通報の状態 */
const UNRESOLVED_REPORT_STATUSES = [REPORT_STATUS_OPEN, REPORT_STATUS_IN_REVIEW] as const;

function toLikePattern(keyword: string): string {
  const escaped = keyword
    .replaceAll(LIKE_ESCAPE_CHARACTER, `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`)
    .replaceAll('%', `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll('_', `${LIKE_ESCAPE_CHARACTER}_`);
  return `%${escaped}%`;
}

const SHOP_SELECTION = {
  shopId: shops.id,
  name: shops.name,
  status: shops.status,
  address: shops.address,
  ownerId: shops.ownerId,
  ownerName: profiles.displayName,
  createdAt: shops.createdAt,
} as const;

export async function listShops(
  db: Database,
  _actor: AdminActor,
  params: ListShopsParams,
): Promise<CursorPage<AdminShopSummary>> {
  const conditions: SQL[] = [];
  if (params.keyword !== null) {
    const pattern = toLikePattern(params.keyword);
    conditions.push(sql`${shops.name} LIKE ${pattern} ESCAPE '\\'`);
  }
  if (params.status !== null) {
    conditions.push(eq(shops.status, params.status));
  }
  if (params.cursor !== null) {
    conditions.push(buildKeysetCondition(shops.createdAt, shops.id, params.cursor));
  }

  // オーナー不在の店舗も管理画面には出す必要があるので left join
  const rows = await db
    .select(SHOP_SELECTION)
    .from(shops)
    .leftJoin(profiles, eq(profiles.userId, shops.ownerId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(shops.createdAt), desc(shops.id))
    .limit(params.limit + 1);

  const items = rows.map((row) => ({
    shopId: row.shopId,
    name: row.name,
    status: row.status,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    createdAtMs: row.createdAt.getTime(),
  }));

  return buildCursorPage(items, params.limit, (item) => ({
    createdAtMs: item.createdAtMs,
    id: item.shopId,
  }));
}

export async function getShopForAdmin(
  db: Database,
  _actor: AdminActor,
  shopId: string,
): Promise<AdminShopDetail | null> {
  const rows = await db
    .select(SHOP_SELECTION)
    .from(shops)
    .leftJoin(profiles, eq(profiles.userId, shops.ownerId))
    .where(eq(shops.id, shopId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const reviewRows = await db
    .select({ value: count() })
    .from(reviews)
    .where(eq(reviews.shopId, shopId));
  const reportRows = await db
    .select({ value: count() })
    .from(reports)
    .where(
      and(
        eq(reports.targetType, REPORT_TARGET_TYPE_SHOP),
        eq(reports.targetId, shopId),
        inValues(reports.status, UNRESOLVED_REPORT_STATUSES),
      ),
    );

  return {
    shopId: row.shopId,
    name: row.name,
    status: row.status,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    createdAtMs: row.createdAt.getTime(),
    address: row.address,
    reviewCount: reviewRows[0]?.value ?? 0,
    openReportCount: reportRows[0]?.value ?? 0,
  };
}

/**
 * 強制非公開。行は消さず `status` を `suspended` にするだけ。
 * `restoreShop` で元に戻せることが「取り消し可能」の根拠になる。
 */
export async function suspendShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: shops.status })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const shop = rows[0];
  if (shop === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (shop.status === SHOP_STATUS_SUSPENDED) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.shopSuspend,
      targetType: AUDIT_TARGET_TYPES.shop,
      targetId: shopId,
      diff: buildAuditDiff({ status: shop.status }, { status: SHOP_STATUS_SUSPENDED }),
    },
    [
      db
        .update(shops)
        .set({ status: SHOP_STATUS_SUSPENDED })
        .where(and(eq(shops.id, shopId), eq(shops.status, shop.status))),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function restoreShop(
  db: Database,
  actor: AdminActor,
  shopId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({ status: shops.status })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const shop = rows[0];
  if (shop === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (shop.status !== SHOP_STATUS_SUSPENDED) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.shopRestore,
      targetType: AUDIT_TARGET_TYPES.shop,
      targetId: shopId,
      diff: buildAuditDiff({ status: shop.status }, { status: SHOP_STATUS_PUBLISHED }),
    },
    [
      db
        .update(shops)
        .set({ status: SHOP_STATUS_PUBLISHED })
        .where(and(eq(shops.id, shopId), eq(shops.status, SHOP_STATUS_SUSPENDED))),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

/**
 * オーナーの付け替え。`nextOwnerId` が null なら「オーナー不在」にする。
 *
 * 新オーナーが利用者ロールなら owner に上げる。前のオーナーは他店を持っている
 * 可能性があるのでロールを下げない（下げるなら `changeUserRole` を明示的に呼ぶ）。
 */
export async function assignShopOwner(
  db: Database,
  actor: AdminActor,
  shopId: string,
  nextOwnerId: string | null,
): Promise<AdminWriteOutcome> {
  const shopRows = await db
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const shop = shopRows[0];
  if (shop === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (shop.ownerId === nextOwnerId) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const statements: SqliteStatement[] = [
    db
      .update(shops)
      .set({ ownerId: nextOwnerId })
      .where(
        and(
          eq(shops.id, shopId),
          shop.ownerId === null ? sql`${shops.ownerId} IS NULL` : eq(shops.ownerId, shop.ownerId),
        ),
      ),
  ];

  if (nextOwnerId !== null) {
    const ownerRows = await db
      .select({ role: profiles.role, status: profiles.status })
      .from(profiles)
      .where(eq(profiles.userId, nextOwnerId))
      .limit(1);

    const nextOwner = ownerRows[0];
    if (nextOwner === undefined) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
    if (nextOwner.status !== PROFILE_STATUS_ACTIVE) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }
    if (nextOwner.role === ROLE_USER) {
      statements.push(
        db
          .update(profiles)
          .set({ role: ROLE_OWNER })
          .where(and(eq(profiles.userId, nextOwnerId), eq(profiles.role, ROLE_USER))),
      );
    }
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.shopOwnerAssign,
      targetType: AUDIT_TARGET_TYPES.shop,
      targetId: shopId,
      diff: buildAuditDiff({ ownerId: shop.ownerId }, { ownerId: nextOwnerId }),
    },
    statements,
  );

  return ADMIN_WRITE_OUTCOME.ok;
}
```

`statements` を `readonly` にせず `SqliteStatement[]` にしているのは、条件によって 1 文追加するため。`withAuditLog` の引数型は `readonly SqliteStatement[]` なので、可変配列をそのまま渡せる。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-shop-repository`
Expected: PASS（14 件）

- [ ] **Step 5: 監査ログの表に 3 行足す**

```ts
import { assignShopOwner, restoreShop, suspendShop } from './admin-shop-repository';

  {
    functionName: 'suspendShop',
    label: '店舗の強制非公開',
    expectedAuditCount: 1,
    run: async (world) => {
      await suspendShop(world.db, world.actor, world.ids.shopId);
    },
  },
  {
    functionName: 'restoreShop',
    label: '店舗の再公開',
    expectedAuditCount: 2,
    run: async (world) => {
      await suspendShop(world.db, world.actor, world.ids.shopId);
      await restoreShop(world.db, world.actor, world.ids.shopId);
    },
  },
  {
    functionName: 'assignShopOwner',
    label: 'オーナーの付け替え',
    expectedAuditCount: 1,
    run: async (world) => {
      await assignShopOwner(world.db, world.actor, world.ids.shopId, world.ids.normalUserId);
    },
  },
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 6: わざと壊して、「取り消せる」ことを検査していることを確認する**

`suspendShop` の UPDATE を DELETE に書き換える。

```ts
      db.delete(shops).where(eq(shops.id, shopId)),
```

Run: `npm test -w @meshimap/api -- admin-shop-repository`
Expected: FAIL。「強制非公開にすると status が suspended になり、削除はされない」が `expected [] to have a length of 1 but got +0` で落ちる。物理削除に変えたらテストが落ちる、という形になっていることをここで確かめる。確認したら戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-shop-repository.ts apps/api/src/repositories/admin-shop-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): 店舗の強制非公開・再公開・オーナー付け替えを追加"
```

---

### Task 9-9: マスタ管理（ジャンル / エリアの CRUD）

**Files:**

- Create: `apps/api/src/repositories/admin-master-repository.ts`
- Modify: `apps/api/src/db/schema/master.ts`（長さ上限と slug の文字種を export するだけ。DDL は変えない）
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 6 行足す）
- Test: `apps/api/src/repositories/admin-master-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 / 9-5 の成果物
- Produces:
  - `MASTER_NAME_MAX_LENGTH` / `PREFECTURE_MAX_LENGTH` / `SLUG_ALLOWED_CHARACTERS`（`db/schema/master.ts` から）
  - `type AdminGenre` / `type AdminArea` / `type GenreInput` / `type AreaInput`
  - `listGenres(db, _actor): Promise<readonly AdminGenre[]>`
  - `createGenre(db, actor, input: GenreInput): Promise<AdminWriteOutcome>`
  - `updateGenre(db, actor, genreId: string, input: GenreInput): Promise<AdminWriteOutcome>`
  - `deleteGenre(db, actor, genreId: string): Promise<AdminWriteOutcome>`
  - `listAreas(db, _actor): Promise<readonly AdminArea[]>`
  - `createArea(db, actor, input: AreaInput): Promise<AdminWriteOutcome>`
  - `updateArea(db, actor, areaId: string, input: AreaInput): Promise<AdminWriteOutcome>`
  - `deleteArea(db, actor, areaId: string): Promise<AdminWriteOutcome>`

**削除について（取り消し可能性の唯一の例外）:**

マスタの削除だけは物理削除になる。ステータス列が無く、追加すると `genres` / `areas` のテーブル再構築マイグレーションが要り、`check-constraints.test.ts` の 3 つの検査（DDL 文字列一致・CHECK 個数・CHECK 名一覧）をまとめて壊すため。代わりに次の 2 つで守る。

1. **使われているマスタは消せない。** `shops.genre_id` / `shops.area_id` は `on delete restrict`（`apps/api/src/db/schema/shop.ts:71-77` で確認済み）。ただし D1 で外部キーが実際に強制されるかどうかは**未確認**なので、DB 任せにせず削除前に店舗件数を数えて 0 件でなければ `conflict` を返す。この事前チェックがあれば、外部キーが効いていてもいなくても挙動は同じになる。
2. **消す直前の行の全列を監査ログの `diff` に残す。** `buildDeletionDiff`（Task 9-1）が `{ 列名: [値, null] }` を作る。これを読めば `createGenre` で同じ内容を作り直せる。ID まで含めて復元できるよう、Task 9-11 の取り消しでは `diff` の `id` をそのまま使って INSERT する。

エリアの子（`areas.parent_id`）は `on delete set null`（`apps/api/src/db/schema/master.ts:100-102`）なので、親を消しても子は残って親無しになる。これは「街だけ残る」状態で、店舗は宙に浮かない。

- [ ] **Step 1: マスタの上限値を export する**

`apps/api/src/db/schema/master.ts` の 3 つの定数に `export` を付ける（値は変えない）。

```ts
/** ジャンル名・エリア名の上限 */
export const MASTER_NAME_MAX_LENGTH = 50;
/** 都道府県名の上限（「神奈川県」など最長 4 文字だが余裕を持たせる） */
export const PREFECTURE_MAX_LENGTH = 20;
/** slug に使える文字。URL とフィルタのクエリ文字列にそのまま出るため小文字英数字とハイフンのみ */
export const SLUG_ALLOWED_CHARACTERS = 'a-z0-9-';
```

`check-constraints.test.ts` / `design-doc-sync.test.ts` / `index.test.ts` はいずれも `Object.values(schema)` を `is(exported, SQLiteTable)`・`isTable` で絞り込んでからテーブル名を集めている（`apps/api/src/db/schema/check-constraints.test.ts:1040`、`design-doc-sync.test.ts:62`、`index.test.ts:62`）。数値や文字列の export が増えても除外されるので、これらの検査には影響しない。

Run: `npm test -w @meshimap/api -- src/db/schema`
Expected: PASS（スキーマ系のテストが全部通ること。ここで落ちたら export を戻して、代わりに管理側で定数を再定義する）

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/repositories/admin-master-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areas, auditLogs, genres, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import {
  createArea,
  createGenre,
  deleteArea,
  deleteGenre,
  listAreas,
  listGenres,
  updateArea,
  updateGenre,
} from './admin-master-repository';

const NEW_GENRE = { id: 'gnr_sushi', name: '寿司', slug: 'sushi', iconKey: null, sortOrder: 2 };
const NEW_AREA = { id: 'are_kita', name: '北区', parentId: null, prefecture: '東京都' };

describe('マスタ管理', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('ジャンルを sort_order 順で返す', async () => {
    await createGenre(world.db, world.actor, NEW_GENRE);

    const list = await listGenres(world.db, world.actor);

    expect(list.map((genre) => genre.id)).toEqual([world.ids.genreId, NEW_GENRE.id]);
  });

  it('ジャンルを作ると監査ログに全列が残る', async () => {
    const outcome = await createGenre(world.db, world.actor, NEW_GENRE);

    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(entry?.action).toBe('genre.create');
    expect(entry?.targetId).toBe(NEW_GENRE.id);
    expect(entry?.diff).toEqual({
      id: [null, 'gnr_sushi'],
      name: [null, '寿司'],
      slug: [null, 'sushi'],
      iconKey: [null, null],
      sortOrder: [null, 2],
    });
  });

  it('同じ ID のジャンルは作れない', async () => {
    await createGenre(world.db, world.actor, NEW_GENRE);

    expect(await createGenre(world.db, world.actor, NEW_GENRE)).toBe(ADMIN_WRITE_OUTCOME.conflict);
  });

  it('slug が重複するジャンルは作れない', async () => {
    await createGenre(world.db, world.actor, NEW_GENRE);

    expect(await createGenre(world.db, world.actor, { ...NEW_GENRE, id: 'gnr_other' })).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('ジャンルを更新すると変わった列だけ差分に載る', async () => {
    const outcome = await updateGenre(world.db, world.actor, world.ids.genreId, {
      id: world.ids.genreId,
      name: '和食',
      slug: 'washoku',
      iconKey: null,
      sortOrder: 1,
    });

    const [genre] = await world.db.select().from(genres).where(eq(genres.id, world.ids.genreId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(genre?.name).toBe('和食');
    expect(entry?.action).toBe('genre.update');
    expect(entry?.diff).toEqual({ name: ['ラーメン', '和食'], slug: ['ramen', 'washoku'] });
  });

  it('存在しないジャンルの更新は not-found', async () => {
    expect(await updateGenre(world.db, world.actor, 'gnr_missing', NEW_GENRE)).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });

  it('店舗に使われているジャンルは消せない', async () => {
    const outcome = await deleteGenre(world.db, world.actor, world.ids.genreId);

    const rows = await world.db.select().from(genres).where(eq(genres.id, world.ids.genreId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.conflict);
    expect(rows).toHaveLength(1);
    expect(await world.db.select().from(auditLogs)).toEqual([]);
  });

  it('使われていないジャンルは消せて、復元に足る差分が残る', async () => {
    await createGenre(world.db, world.actor, NEW_GENRE);

    const outcome = await deleteGenre(world.db, world.actor, NEW_GENRE.id);

    const rows = await world.db.select().from(genres).where(eq(genres.id, NEW_GENRE.id));
    const entries = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(rows).toEqual([]);
    expect(entries.at(-1)?.action).toBe('genre.delete');
    expect(entries.at(-1)?.diff).toEqual({
      id: ['gnr_sushi', null],
      name: ['寿司', null],
      slug: ['sushi', null],
      iconKey: [null, null],
      sortOrder: [2, null],
    });
  });

  it('エリアを作れて、親子で並ぶ', async () => {
    await createArea(world.db, world.actor, NEW_AREA);
    await createArea(world.db, world.actor, {
      id: 'are_akabane',
      name: '赤羽',
      parentId: NEW_AREA.id,
      prefecture: '東京都',
    });

    const list = await listAreas(world.db, world.actor);

    expect(list.find((area) => area.id === 'are_akabane')?.parentId).toBe(NEW_AREA.id);
  });

  it('存在しない親を指定したエリアは作れない', async () => {
    expect(await createArea(world.db, world.actor, { ...NEW_AREA, parentId: 'are_missing' })).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });

  it('自分自身を親にはできない', async () => {
    expect(await createArea(world.db, world.actor, { ...NEW_AREA, parentId: NEW_AREA.id })).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('エリアを更新できる', async () => {
    const outcome = await updateArea(world.db, world.actor, world.ids.areaId, {
      id: world.ids.areaId,
      name: '渋谷区',
      parentId: null,
      prefecture: '東京都',
    });

    const [area] = await world.db.select().from(areas).where(eq(areas.id, world.ids.areaId));
    const [entry] = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(area?.name).toBe('渋谷区');
    expect(entry?.action).toBe('area.update');
  });

  it('店舗に使われているエリアは消せない', async () => {
    expect(await deleteArea(world.db, world.actor, world.ids.areaId)).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
    expect(await world.db.select().from(shops)).toHaveLength(1);
  });

  it('使われていないエリアは消せる', async () => {
    await createArea(world.db, world.actor, NEW_AREA);

    const outcome = await deleteArea(world.db, world.actor, NEW_AREA.id);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(await world.db.select().from(areas).where(eq(areas.id, NEW_AREA.id))).toEqual([]);
  });

  it('存在しないエリアの削除は not-found', async () => {
    expect(await deleteArea(world.db, world.actor, 'are_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-master-repository`
Expected: FAIL。`Failed to resolve import "./admin-master-repository"`。

- [ ] **Step 4: 実装を書く**

`apps/api/src/repositories/admin-master-repository.ts`

```ts
import { asc, count, eq, or } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import { areas, genres, shops } from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  buildAuditDiff,
  buildCreationDiff,
  buildDeletionDiff,
  withAuditLog,
} from '../lib/audit-log';

export type AdminGenre = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly iconKey: string | null;
  readonly sortOrder: number;
};

export type AdminArea = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly prefecture: string;
};

export type GenreInput = AdminGenre;
export type AreaInput = AdminArea;

/** 「使われていない」の判定に使う件数 */
const NO_REFERENCES = 0;

export async function listGenres(db: Database, _actor: AdminActor): Promise<readonly AdminGenre[]> {
  return await db
    .select({
      id: genres.id,
      name: genres.name,
      slug: genres.slug,
      iconKey: genres.iconKey,
      sortOrder: genres.sortOrder,
    })
    .from(genres)
    .orderBy(asc(genres.sortOrder), asc(genres.id));
}

export async function createGenre(
  db: Database,
  actor: AdminActor,
  input: GenreInput,
): Promise<AdminWriteOutcome> {
  // id と slug のどちらが当たっても UNIQUE 違反でバッチごと落ちるので、両方まとめて先に見る
  const existing = await db
    .select({ id: genres.id })
    .from(genres)
    .where(or(eq(genres.id, input.id), eq(genres.slug, input.slug)))
    .limit(1);

  if (existing.length > NO_REFERENCES) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.genreCreate,
      targetType: AUDIT_TARGET_TYPES.genre,
      targetId: input.id,
      diff: buildCreationDiff(input),
    },
    [
      db.insert(genres).values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        iconKey: input.iconKey,
        sortOrder: input.sortOrder,
      }),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function updateGenre(
  db: Database,
  actor: AdminActor,
  genreId: string,
  input: GenreInput,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({
      id: genres.id,
      name: genres.name,
      slug: genres.slug,
      iconKey: genres.iconKey,
      sortOrder: genres.sortOrder,
    })
    .from(genres)
    .where(eq(genres.id, genreId))
    .limit(1);

  const current = rows[0];
  if (current === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }

  const next = { ...input, id: genreId };
  // slug を他の行と同じにしようとしていないか
  const duplicated = await db
    .select({ id: genres.id })
    .from(genres)
    .where(eq(genres.slug, next.slug))
    .limit(1);
  if (duplicated[0] !== undefined && duplicated[0].id !== genreId) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.genreUpdate,
      targetType: AUDIT_TARGET_TYPES.genre,
      targetId: genreId,
      diff: buildAuditDiff(current, next),
    },
    [
      db
        .update(genres)
        .set({
          name: next.name,
          slug: next.slug,
          iconKey: next.iconKey,
          sortOrder: next.sortOrder,
        })
        .where(eq(genres.id, genreId)),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function deleteGenre(
  db: Database,
  actor: AdminActor,
  genreId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({
      id: genres.id,
      name: genres.name,
      slug: genres.slug,
      iconKey: genres.iconKey,
      sortOrder: genres.sortOrder,
    })
    .from(genres)
    .where(eq(genres.id, genreId))
    .limit(1);

  const current = rows[0];
  if (current === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }

  // shops.genre_id は on delete restrict だが、D1 で外部キーが強制されるかは未確認。
  // DB 任せにせず件数で判定する（強制されていてもいなくても同じ結果になる）
  const usage = await db.select({ value: count() }).from(shops).where(eq(shops.genreId, genreId));
  if ((usage[0]?.value ?? NO_REFERENCES) > NO_REFERENCES) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.genreDelete,
      targetType: AUDIT_TARGET_TYPES.genre,
      targetId: genreId,
      diff: buildDeletionDiff(current),
    },
    [db.delete(genres).where(eq(genres.id, genreId))],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function listAreas(db: Database, _actor: AdminActor): Promise<readonly AdminArea[]> {
  return await db
    .select({
      id: areas.id,
      name: areas.name,
      parentId: areas.parentId,
      prefecture: areas.prefecture,
    })
    .from(areas)
    .orderBy(asc(areas.prefecture), asc(areas.id));
}

export async function createArea(
  db: Database,
  actor: AdminActor,
  input: AreaInput,
): Promise<AdminWriteOutcome> {
  if (input.parentId === input.id) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const existing = await db
    .select({ id: areas.id })
    .from(areas)
    .where(eq(areas.id, input.id))
    .limit(1);
  if (existing.length > NO_REFERENCES) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  if (input.parentId !== null) {
    const parent = await db
      .select({ id: areas.id })
      .from(areas)
      .where(eq(areas.id, input.parentId))
      .limit(1);
    if (parent.length === NO_REFERENCES) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.areaCreate,
      targetType: AUDIT_TARGET_TYPES.area,
      targetId: input.id,
      diff: buildCreationDiff(input),
    },
    [
      db.insert(areas).values({
        id: input.id,
        name: input.name,
        parentId: input.parentId,
        prefecture: input.prefecture,
      }),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function updateArea(
  db: Database,
  actor: AdminActor,
  areaId: string,
  input: AreaInput,
): Promise<AdminWriteOutcome> {
  if (input.parentId === areaId) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const rows = await db
    .select({
      id: areas.id,
      name: areas.name,
      parentId: areas.parentId,
      prefecture: areas.prefecture,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);

  const current = rows[0];
  if (current === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }

  if (input.parentId !== null) {
    const parent = await db
      .select({ id: areas.id })
      .from(areas)
      .where(eq(areas.id, input.parentId))
      .limit(1);
    if (parent.length === NO_REFERENCES) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
  }

  const next = { ...input, id: areaId };

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.areaUpdate,
      targetType: AUDIT_TARGET_TYPES.area,
      targetId: areaId,
      diff: buildAuditDiff(current, next),
    },
    [
      db
        .update(areas)
        .set({ name: next.name, parentId: next.parentId, prefecture: next.prefecture })
        .where(eq(areas.id, areaId)),
    ],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}

export async function deleteArea(
  db: Database,
  actor: AdminActor,
  areaId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({
      id: areas.id,
      name: areas.name,
      parentId: areas.parentId,
      prefecture: areas.prefecture,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);

  const current = rows[0];
  if (current === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }

  const usage = await db.select({ value: count() }).from(shops).where(eq(shops.areaId, areaId));
  if ((usage[0]?.value ?? NO_REFERENCES) > NO_REFERENCES) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.areaDelete,
      targetType: AUDIT_TARGET_TYPES.area,
      targetId: areaId,
      diff: buildDeletionDiff(current),
    },
    [db.delete(areas).where(eq(areas.id, areaId))],
  );

  return ADMIN_WRITE_OUTCOME.ok;
}
```

`areas.parent_id` は `on delete set null` なので、親を消しても子は残る。子を持つ親を消すと子が親無しになるが、`listAreas` は `parentId === null` を「区」として扱うだけなので表示は壊れない。

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-master-repository`
Expected: PASS（15 件）

- [ ] **Step 6: 監査ログの表に 6 行足す**

```ts
import {
  createArea,
  createGenre,
  deleteArea,
  deleteGenre,
  updateArea,
  updateGenre,
} from './admin-master-repository';

const SPARE_GENRE = { id: 'gnr_sushi', name: '寿司', slug: 'sushi', iconKey: null, sortOrder: 2 };
const SPARE_AREA = { id: 'are_kita', name: '北区', parentId: null, prefecture: '東京都' };

  {
    functionName: 'createGenre',
    label: 'ジャンルの作成',
    expectedAuditCount: 1,
    run: async (world) => {
      await createGenre(world.db, world.actor, SPARE_GENRE);
    },
  },
  {
    functionName: 'updateGenre',
    label: 'ジャンルの更新',
    expectedAuditCount: 1,
    run: async (world) => {
      await updateGenre(world.db, world.actor, world.ids.genreId, {
        id: world.ids.genreId,
        name: '和食',
        slug: 'washoku',
        iconKey: null,
        sortOrder: 1,
      });
    },
  },
  {
    functionName: 'deleteGenre',
    label: 'ジャンルの削除',
    expectedAuditCount: 2,
    run: async (world) => {
      await createGenre(world.db, world.actor, SPARE_GENRE);
      await deleteGenre(world.db, world.actor, SPARE_GENRE.id);
    },
  },
  {
    functionName: 'createArea',
    label: 'エリアの作成',
    expectedAuditCount: 1,
    run: async (world) => {
      await createArea(world.db, world.actor, SPARE_AREA);
    },
  },
  {
    functionName: 'updateArea',
    label: 'エリアの更新',
    expectedAuditCount: 1,
    run: async (world) => {
      await updateArea(world.db, world.actor, world.ids.areaId, {
        id: world.ids.areaId,
        name: '渋谷区',
        parentId: null,
        prefecture: '東京都',
      });
    },
  },
  {
    functionName: 'deleteArea',
    label: 'エリアの削除',
    expectedAuditCount: 2,
    run: async (world) => {
      await createArea(world.db, world.actor, SPARE_AREA);
      await deleteArea(world.db, world.actor, SPARE_AREA.id);
    },
  },
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 7: わざと壊して、削除の事前チェックが効いていることを確認する**

`deleteGenre` の使用件数チェック 4 行を消す。

Run: `npm test -w @meshimap/api -- admin-master-repository`
Expected: FAIL。「店舗に使われているジャンルは消せない」が落ちる。落ち方は 2 通りありうる。

- 外部キーが強制されている場合: `db.batch` が `FOREIGN KEY constraint failed` を投げ、テストは未処理の例外で落ちる。
- 強制されていない場合: `outcome` が `'ok'` になり `expected 'ok' to be 'conflict'` で落ちる。

**どちらだったかを計画書ではなく実際の出力で確認し、`## 未確認事項` の「D1 の外部キー強制」の行を実測済みに書き換えること。** 確認したらチェックを戻す。

- [ ] **Step 8: コミットする**

```bash
git add apps/api/src/db/schema/master.ts apps/api/src/repositories/admin-master-repository.ts apps/api/src/repositories/admin-master-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): ジャンル・エリアのマスタ管理を追加"
```

---

### Task 9-10: お知らせの一斉配信（宛先の解決 / チャンク分割 / 再送）

**Files:**

- Create: `apps/api/src/lib/identifier.test.ts`
- Create: `apps/api/src/repositories/admin-announcement-repository.ts`
- Modify: `apps/api/src/lib/identifier.ts`（`ID_PREFIXES.announcement` と長さ指定を足す）
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 1 行足す）
- Test: `apps/api/src/repositories/admin-announcement-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 の `withAuditLogChunked`、Task 9-4 の `CursorPage`、Task 9-5 の `createPrefixedId`
- Produces:
  - `createPrefixedId(prefix: IdPrefix, randomLength?: number): string`（引数追加）
  - `ANNOUNCEMENT_OUTCOME` / `type AnnouncementOutcome = 'ok' | 'already-sent' | 'no-recipients'`
  - `type AnnouncementAudience` / `type SendAnnouncementInput` / `type AnnouncementHistoryItem`
  - `createAnnouncementId(): string`
  - `buildNotificationId(announcementId: string, userId: string): string`
  - `sendAnnouncement(db, actor, input): Promise<AnnouncementOutcome>`
  - `listAnnouncementHistory(db, _actor, params): Promise<CursorPage<AnnouncementHistoryItem>>`

**この Task で確定させること:**

- **お知らせ専用のテーブルは作らない**（グローバル制約「新規テーブル禁止」）。お知らせの実体は「N 件の `notifications` 行」＋「`action = 'announcement.send'` の監査ログ 1 行」。配信履歴は `audit_logs` から引く。
- **通知 ID は決定的**。`ntf_` + お知らせ ID(16) + `_` + ユーザー ID(32) = 53 文字。`.onConflictDoNothing()` と組み合わせることで、途中で落ちた配信を同じお知らせ ID でやり直しても二重に届かない。
- **チャンクサイズは 100**（このフェーズの実測 B-6/B-7/B-8: 100 文 → 9ms / 500 文 → 31ms / 1000 文 → 40ms。1000 文の単発 batch も通ったが、Workers の CPU 時間と D1 のリクエストサイズ上限に対する余裕を取って 100 にする）。
- **監査行は最後のチャンクに同梱する**。「監査行がある ⇔ 全件流れ切った」を成り立たせるため。

- [ ] **Step 1: identifier.ts の失敗するテストを書く**

`apps/api/src/lib/identifier.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createPrefixedId, ID_PREFIXES } from './identifier';

/** ハイフンを除いた UUID の長さ */
const FULL_LENGTH = 32;

describe('createPrefixedId', () => {
  it('既定では接頭辞 + 32 文字を返す', () => {
    const id = createPrefixedId(ID_PREFIXES.notification);

    expect(id.startsWith(ID_PREFIXES.notification)).toBe(true);
    expect(id).toHaveLength(ID_PREFIXES.notification.length + FULL_LENGTH);
  });

  it('ハイフンを含まない', () => {
    expect(createPrefixedId(ID_PREFIXES.genre)).not.toContain('-');
  });

  it('長さを指定するとその分だけ切り詰める', () => {
    const id = createPrefixedId(ID_PREFIXES.announcement, 12);

    expect(id).toHaveLength(ID_PREFIXES.announcement.length + 12);
  });

  it('1 文字でも切り詰められる（境界値）', () => {
    expect(createPrefixedId(ID_PREFIXES.announcement, 1)).toHaveLength(
      ID_PREFIXES.announcement.length + 1,
    );
  });

  it('32 を超える長さを指定しても 32 文字までしか伸びない', () => {
    expect(createPrefixedId(ID_PREFIXES.announcement, 64)).toHaveLength(
      ID_PREFIXES.announcement.length + FULL_LENGTH,
    );
  });

  it('呼ぶたびに違う値になる', () => {
    expect(createPrefixedId(ID_PREFIXES.area)).not.toBe(createPrefixedId(ID_PREFIXES.area));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- identifier`
Expected: FAIL。`ID_PREFIXES.announcement` が無いので `Expected 1 arguments, but got 2.` の型エラーと、`undefined` を `.length` した実行時エラーが出る。

- [ ] **Step 3: identifier.ts を直す**

```ts
/** UUID からハイフンを抜いた 32 文字に接頭辞を付ける。ID 列の CHECK は「64 文字以内」だけ */
const UUID_HYPHEN = '-';

/** ハイフンを除いた UUID の長さ */
const UUID_HEX_LENGTH = 32;

export const ID_PREFIXES = {
  auditLog: 'aud_',
  notification: 'ntf_',
  genre: 'gnr_',
  area: 'are_',
  announcement: 'ann_',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/**
 * 接頭辞付きの ID を作る。
 *
 * `randomLength` を渡すと乱数部分を短くできる。お知らせ ID のように
 * 「他の ID の一部として埋め込むので全体を 64 文字に収めたい」場合に使う。
 * 32 より大きい値を渡しても 32 文字までしか伸びない（UUID の桁数が上限）。
 */
export function createPrefixedId(prefix: IdPrefix, randomLength: number = UUID_HEX_LENGTH): string {
  return `${prefix}${crypto.randomUUID().replaceAll(UUID_HYPHEN, '').slice(0, randomLength)}`;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- identifier`
Expected: PASS（6 件）

- [ ] **Step 5: お知らせ配信の失敗するテストを書く**

`apps/api/src/repositories/admin-announcement-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_OWNER } from '../db/constants';
import { auditLogs, notifications, profiles, user } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import {
  ANNOUNCEMENT_OUTCOME,
  buildNotificationId,
  createAnnouncementId,
  listAnnouncementHistory,
  sendAnnouncement,
} from './admin-announcement-repository';

const TITLE = 'メンテナンスのお知らせ';
const BODY = '9 月 20 日 2:00 〜 4:00 の間、予約機能を停止します。';
const PAGE_LIMIT = 20;
/** 追加で作るユーザー数。チャンク境界（100）をまたがせるため */
const EXTRA_USER_COUNT = 150;

describe('通知 ID の組み立て', () => {
  it('お知らせ ID とユーザー ID から決まる', () => {
    expect(buildNotificationId('ann_0123456789ab', 'u'.repeat(32))).toBe(
      `ntf_ann_0123456789ab_${'u'.repeat(32)}`,
    );
  });

  it('64 文字を超えるなら例外にする', () => {
    expect(() => buildNotificationId('ann_0123456789ab', 'u'.repeat(64))).toThrow(
      '通知 ID が 64 文字を超えます',
    );
  });

  it('お知らせ ID は ann_ + 12 文字', () => {
    expect(createAnnouncementId()).toHaveLength(16);
  });
});

describe('お知らせの一斉配信', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('全員宛てに配ると全ユーザーに 1 通ずつ届く', async () => {
    const announcementId = createAnnouncementId();

    const outcome = await sendAnnouncement(world.db, world.actor, {
      announcementId,
      title: TITLE,
      body: BODY,
      audience: { kind: 'all' },
    });

    const rows = await world.db.select().from(notifications);

    expect(outcome).toBe(ANNOUNCEMENT_OUTCOME.ok);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.type === 'announcement')).toBe(true);
    expect(rows.every((row) => row.title === TITLE)).toBe(true);
  });

  it('監査ログが 1 行だけ残り、宛先と件数が差分に入る', async () => {
    const announcementId = createAnnouncementId();

    await sendAnnouncement(world.db, world.actor, {
      announcementId,
      title: TITLE,
      body: BODY,
      audience: { kind: 'all' },
    });

    const entries = await world.db.select().from(auditLogs);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('announcement.send');
    expect(entries[0]?.targetType).toBe('announcement');
    expect(entries[0]?.targetId).toBe(announcementId);
    expect(entries[0]?.diff).toMatchObject({
      title: [null, TITLE],
      audience: [null, 'all'],
      recipientCount: [null, 3],
    });
  });

  it('ロール指定ならそのロールだけに届く', async () => {
    await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'role', role: ROLE_OWNER },
    });

    const rows = await world.db.select().from(notifications);

    expect(rows.map((row) => row.userId)).toEqual([world.ids.ownerUserId]);
  });

  it('個別指定ならその人だけに届く', async () => {
    await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'users', userIds: [world.ids.normalUserId] },
    });

    const rows = await world.db.select().from(notifications);

    expect(rows.map((row) => row.userId)).toEqual([world.ids.normalUserId]);
  });

  it('停止中のユーザーには届かない', async () => {
    await world.db
      .update(profiles)
      .set({ status: 'suspended' })
      .where(eq(profiles.userId, world.ids.normalUserId));

    await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'all' },
    });

    const rows = await world.db.select().from(notifications);

    expect(rows.map((row) => row.userId)).not.toContain(world.ids.normalUserId);
  });

  it('宛先が 0 件なら何も書かずに no-recipients', async () => {
    const outcome = await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'users', userIds: ['usr_missing'] },
    });

    expect(outcome).toBe(ANNOUNCEMENT_OUTCOME.noRecipients);
    expect(await world.db.select().from(notifications)).toEqual([]);
    expect(await world.db.select().from(auditLogs)).toEqual([]);
  });

  it('同じお知らせ ID で送り直すと already-sent で、通知は増えない', async () => {
    const announcementId = createAnnouncementId();
    const input = { announcementId, title: TITLE, body: BODY, audience: { kind: 'all' } } as const;

    await sendAnnouncement(world.db, world.actor, input);
    const outcome = await sendAnnouncement(world.db, world.actor, input);

    expect(outcome).toBe(ANNOUNCEMENT_OUTCOME.alreadySent);
    expect(await world.db.select().from(notifications)).toHaveLength(3);
    expect(await world.db.select().from(auditLogs)).toHaveLength(1);
  });

  it('153 人に配ってもチャンク境界をまたいで全員に 1 通ずつ届く', async () => {
    const extraUserIds = Array.from(
      { length: EXTRA_USER_COUNT },
      (_unused, index) => `usr_bulk_${String(index).padStart(4, '0')}`,
    );
    await world.db.batch([
      world.db.insert(user).values(
        extraUserIds.map((userId) => ({
          id: userId,
          name: userId,
          email: `${userId}@example.test`,
        })),
      ),
      world.db
        .insert(profiles)
        .values(extraUserIds.map((userId) => ({ userId, displayName: userId }))),
    ]);

    const outcome = await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'all' },
    });

    const rows = await world.db.select().from(notifications);
    const uniqueUserIds = new Set(rows.map((row) => row.userId));

    expect(outcome).toBe(ANNOUNCEMENT_OUTCOME.ok);
    expect(rows).toHaveLength(EXTRA_USER_COUNT + 3);
    expect(uniqueUserIds.size).toBe(EXTRA_USER_COUNT + 3);
    expect(await world.db.select().from(auditLogs)).toHaveLength(1);
  });

  it('配信履歴を新着順で返す', async () => {
    await sendAnnouncement(world.db, world.actor, {
      announcementId: createAnnouncementId(),
      title: TITLE,
      body: BODY,
      audience: { kind: 'all' },
    });

    const page = await listAnnouncementHistory(world.db, world.actor, {
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe(TITLE);
    expect(page.items[0]?.recipientCount).toBe(3);
    expect(page.items[0]?.sentBy).toBe(world.ids.adminUserId);
  });
});
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-announcement-repository`
Expected: FAIL。`Failed to resolve import "./admin-announcement-repository"`。

- [ ] **Step 7: 実装を書く**

`apps/api/src/repositories/admin-announcement-repository.ts`

```ts
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  IDENTIFIER_MAX_LENGTH,
  NOTIFICATION_TYPE_ANNOUNCEMENT,
  PROFILE_STATUS_ACTIVE,
  type Role,
} from '../db/constants';
import { auditLogs, notifications, profiles } from '../db/schema';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  withAuditLogChunked,
  type SqliteStatement,
} from '../lib/audit-log';
import { buildCursorPage, type Cursor, type CursorPage } from '../lib/cursor';
import { createPrefixedId, ID_PREFIXES } from '../lib/identifier';

export const ANNOUNCEMENT_OUTCOME = {
  ok: 'ok',
  alreadySent: 'already-sent',
  noRecipients: 'no-recipients',
} as const;

export type AnnouncementOutcome = (typeof ANNOUNCEMENT_OUTCOME)[keyof typeof ANNOUNCEMENT_OUTCOME];

export type AnnouncementAudience =
  | { readonly kind: 'all' }
  | { readonly kind: 'role'; readonly role: Role }
  | { readonly kind: 'users'; readonly userIds: readonly string[] };

export type SendAnnouncementInput = {
  readonly announcementId: string;
  readonly title: string;
  readonly body: string;
  readonly audience: AnnouncementAudience;
};

export type AnnouncementHistoryItem = {
  readonly announcementId: string;
  readonly title: string;
  readonly audience: string;
  readonly recipientCount: number;
  readonly sentBy: string | null;
  readonly sentAtMs: number;
};

export type ListAnnouncementHistoryParams = {
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** お知らせ ID の乱数部分の長さ。通知 ID 全体を 64 文字に収めるために短くしてある */
const ANNOUNCEMENT_RANDOM_LENGTH = 12;

/**
 * 1 回の batch に入れる文の数。
 * 実測（このフェーズの B-6〜B-8）: 100 文 → 9ms / 500 文 → 31ms / 1000 文 → 40ms。
 * 1000 文でも通るが、Workers の CPU 時間と D1 のリクエストサイズに余裕を残して 100 にする。
 */
const ANNOUNCEMENT_CHUNK_SIZE = 100;

/**
 * 宛先ユーザーを引くときに 1 クエリへ入れる ID の数。
 * D1 のバインドパラメータ上限は未確認のため、確実に安全な 50 で刻む。
 */
const RECIPIENT_LOOKUP_CHUNK_SIZE = 50;

/** 宛先が 1 人もいない状態 */
const NO_RECIPIENTS = 0;

export function createAnnouncementId(): string {
  return createPrefixedId(ID_PREFIXES.announcement, ANNOUNCEMENT_RANDOM_LENGTH);
}

/**
 * 通知の ID を決定的に組む。
 *
 * 同じお知らせを同じ人に 2 回入れようとしたとき、主キー衝突として
 * `.onConflictDoNothing()` に吸わせるための仕掛け。途中で落ちた配信を
 * 同じお知らせ ID でやり直しても二重には届かない。
 */
export function buildNotificationId(announcementId: string, userId: string): string {
  const id = `${ID_PREFIXES.notification}${announcementId}_${userId}`;
  if (id.length > IDENTIFIER_MAX_LENGTH) {
    throw new Error(`通知 ID が ${IDENTIFIER_MAX_LENGTH} 文字を超えます: ${id.length} 文字`);
  }
  return id;
}

/** 宛先の種類を監査ログに書くときの文字列 */
function describeAudience(audience: AnnouncementAudience): string {
  if (audience.kind === 'all') {
    return 'all';
  }
  if (audience.kind === 'role') {
    return `role:${audience.role}`;
  }
  return `users:${audience.userIds.length}`;
}

/** 宛先ユーザー ID を解決する。停止中・退会済みには配らない */
async function resolveRecipients(
  db: Database,
  audience: AnnouncementAudience,
): Promise<readonly string[]> {
  if (audience.kind === 'users') {
    const found: string[] = [];
    for (let index = 0; index < audience.userIds.length; index += RECIPIENT_LOOKUP_CHUNK_SIZE) {
      const slice = audience.userIds.slice(index, index + RECIPIENT_LOOKUP_CHUNK_SIZE);
      const rows = await db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(and(inArray(profiles.userId, slice), eq(profiles.status, PROFILE_STATUS_ACTIVE)));
      found.push(...rows.map((row) => row.userId));
    }
    return found;
  }

  const conditions: SQL[] = [eq(profiles.status, PROFILE_STATUS_ACTIVE)];
  if (audience.kind === 'role') {
    conditions.push(eq(profiles.role, audience.role));
  }

  const rows = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(...conditions))
    .orderBy(profiles.userId);

  return rows.map((row) => row.userId);
}

/**
 * お知らせを一斉配信する。
 *
 * D1 に対話的トランザクションが無いため、N 件の INSERT を 1 つの
 * トランザクションにまとめることはできない。代わりに
 *
 * - 通知 ID を決定的にして `.onConflictDoNothing()` を付ける（再送で重複しない）
 * - 監査行は最後のチャンクと同じ batch に入れる（監査行がある ⇔ 全件流れた）
 * - 送信前に監査行の有無を見る（二重送信を止める）
 *
 * の 3 点で一貫性を担保する。途中のチャンクで落ちた場合は監査行が無いので、
 * 同じお知らせ ID で呼び直せば残りだけが入る。
 */
export async function sendAnnouncement(
  db: Database,
  actor: AdminActor,
  input: SendAnnouncementInput,
): Promise<AnnouncementOutcome> {
  const alreadySent = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AUDIT_ACTIONS.announcementSend),
        eq(auditLogs.targetId, input.announcementId),
      ),
    )
    .limit(1);

  if (alreadySent.length > NO_RECIPIENTS) {
    return ANNOUNCEMENT_OUTCOME.alreadySent;
  }

  const recipientIds = await resolveRecipients(db, input.audience);
  // 空配列を batch に渡すと `No SQL statements detected.` で落ちるので、ここで返す
  if (recipientIds.length === NO_RECIPIENTS) {
    return ANNOUNCEMENT_OUTCOME.noRecipients;
  }

  const statements: readonly SqliteStatement[] = recipientIds.map((userId) =>
    db
      .insert(notifications)
      .values({
        id: buildNotificationId(input.announcementId, userId),
        userId,
        type: NOTIFICATION_TYPE_ANNOUNCEMENT,
        title: input.title,
        body: input.body,
        data: { announcementId: input.announcementId },
      })
      .onConflictDoNothing(),
  );

  await withAuditLogChunked(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.announcementSend,
      targetType: AUDIT_TARGET_TYPES.announcement,
      targetId: input.announcementId,
      diff: {
        title: [null, input.title],
        audience: [null, describeAudience(input.audience)],
        recipientCount: [null, recipientIds.length],
      },
    },
    statements,
    ANNOUNCEMENT_CHUNK_SIZE,
  );

  return ANNOUNCEMENT_OUTCOME.ok;
}

/**
 * 配信履歴。専用テーブルを作らず `audit_logs` から引く。
 * `diff` は JSON なので `json_extract` で必要な値だけ取り出す。
 */
export async function listAnnouncementHistory(
  db: Database,
  _actor: AdminActor,
  params: ListAnnouncementHistoryParams,
): Promise<CursorPage<AnnouncementHistoryItem>> {
  const conditions: SQL[] = [eq(auditLogs.action, AUDIT_ACTIONS.announcementSend)];
  if (params.cursor !== null) {
    conditions.push(
      sql`(${auditLogs.createdAt} < ${params.cursor.createdAtMs} OR (${auditLogs.createdAt} = ${params.cursor.createdAtMs} AND ${auditLogs.id} < ${params.cursor.id}))`,
    );
  }

  const rows = await db
    .select({
      announcementId: auditLogs.targetId,
      title: sql<string>`json_extract(${auditLogs.diff}, '$.title[1]')`,
      audience: sql<string>`json_extract(${auditLogs.diff}, '$.audience[1]')`,
      recipientCount: sql<number>`json_extract(${auditLogs.diff}, '$.recipientCount[1]')`,
      sentBy: auditLogs.actorId,
      createdAt: auditLogs.createdAt,
      auditLogId: auditLogs.id,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(params.limit + 1);

  const items = rows.map((row) => ({
    announcementId: row.announcementId,
    title: row.title,
    audience: row.audience,
    recipientCount: row.recipientCount,
    sentBy: row.sentBy,
    sentAtMs: row.createdAt.getTime(),
    auditLogId: row.auditLogId,
  }));

  return buildCursorPage(items, params.limit, (item) => ({
    createdAtMs: item.sentAtMs,
    id: item.auditLogId,
  }));
}
```

`listAnnouncementHistory` の要素は `AnnouncementHistoryItem` に `auditLogId` が乗った形になる。カーソルの組み立てに監査ログ ID が要るためで、`AnnouncementHistoryItem` は `auditLogId` を持たない型なので、型を次のように直して合わせる。

```ts
export type AnnouncementHistoryItem = {
  readonly announcementId: string;
  readonly title: string;
  readonly audience: string;
  readonly recipientCount: number;
  readonly sentBy: string | null;
  readonly sentAtMs: number;
  readonly auditLogId: string;
};
```

`buildKeysetCondition`（Task 9-4）ではなく `sql` を直接書いているのは、`auditLogs.createdAt` が `timestamp_ms` モードで、カーソル側が数値のミリ秒だから。`buildKeysetCondition` も同じ形なので**そちらを使ってよい**。実装時は `buildKeysetCondition(auditLogs.createdAt, auditLogs.id, params.cursor)` に置き換え、`sql` の import が不要になるなら消すこと（`json_extract` で `sql` は使い続ける）。

- [ ] **Step 8: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-announcement-repository`
Expected: PASS（12 件）

153 人のテストが遅い（数秒かかる）ようなら、`EXTRA_USER_COUNT` を減らさずに `vitest` の `testTimeout` を確認する。**件数を減らすとチャンク境界（100）をまたがなくなり、このテストの意味が無くなる**ので減らさないこと。

- [ ] **Step 9: 監査ログの表に 1 行足す**

```ts
import { createAnnouncementId, sendAnnouncement } from './admin-announcement-repository';

  {
    functionName: 'sendAnnouncement',
    label: 'お知らせの一斉配信',
    expectedAuditCount: 1,
    run: async (world) => {
      await sendAnnouncement(world.db, world.actor, {
        announcementId: createAnnouncementId(),
        title: 'テストのお知らせ',
        body: 'テストです。',
        audience: { kind: 'all' },
      });
    },
  },
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 10: わざと壊して、途中失敗と再送の性質を確認する**

(a) チャンクサイズを 1 にして、監査行が最後のチャンクにしか入らないことを確かめる。

```ts
const ANNOUNCEMENT_CHUNK_SIZE = 1;
```

Run: `npm test -w @meshimap/api -- admin-announcement-repository`
Expected: PASS（全部通る。チャンクサイズを変えても結果は同じであるべき、という性質の確認）。通らなければ `withAuditLogChunked` の境界計算が誤っている。確認したら 100 に戻す。

(b) `.onConflictDoNothing()` を外し、二重送信の防止を監査行の事前チェックだけに頼らせる。さらに `alreadySent` のチェックを `if (false)` にする。

Run: `npm test -w @meshimap/api -- admin-announcement-repository`
Expected: FAIL。「同じお知らせ ID で送り直すと already-sent で、通知は増えない」が、主キー重複（`UNIQUE constraint failed: notifications.id`）の未処理例外で落ちる。**決定的 ID + onConflictDoNothing が「再送で壊れない」ことの実体である**ことをここで見る。確認したら両方戻す。

- [ ] **Step 11: コミットする**

```bash
git add apps/api/src/lib/identifier.ts apps/api/src/lib/identifier.test.ts apps/api/src/repositories/admin-announcement-repository.ts apps/api/src/repositories/admin-announcement-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): お知らせの一斉配信（決定的 ID・チャンク分割・再送安全）を追加"
```

---

### Task 9-11: 監査ログの閲覧と「取り消し」

**Files:**

- Create: `apps/api/src/repositories/admin-audit-repository.ts`
- Modify: `apps/api/src/repositories/admin-audit-coverage.test.ts`（表に 1 行足す）
- Test: `apps/api/src/repositories/admin-audit-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-1 / 9-4 / 9-5 の成果物
- Produces:
  - `type AuditLogItem` / `type ListAuditLogsParams`
  - `UNDOABLE_ACTIONS: readonly AuditAction[]`
  - `listAuditLogs(db, _actor, params): Promise<CursorPage<AuditLogItem>>`
  - `undoAuditLog(db, actor, auditLogId: string): Promise<AdminWriteOutcome>`

**取り消しの仕様（ここが設計判断 3 の実装）:**

| 取り消せる action               | 戻す対象          | 戻し方                                         |
| ------------------------------- | ----------------- | ---------------------------------------------- |
| `user.suspend` / `user.restore` | `profiles.status` | `diff.status` の変更前へ戻す                   |
| `user.role_change`              | `profiles.role`   | `diff.role` の変更前へ戻す                     |
| `shop.suspend` / `shop.restore` | `shops.status`    | `diff.status` の変更前へ戻す                   |
| `shop.owner_assign`             | `shops.ownerId`   | `diff.ownerId` の変更前へ戻す（NULL も戻せる） |
| `review.hide`                   | `reviews.status`  | `diff.status` の変更前へ戻す                   |

取り消せないもの（`conflict` を返す）と、その理由。

- `application.*` — 承認は店舗の公開・ロール昇格まで波及しており、機械的に巻き戻すと別の管理者がその後に行った操作と衝突する。再度 `returnApplication` を呼んで人手でやり直す。
- `report.*` — 「対応した事実」は消さない。処分の中身（`review.hide` など）は別の監査行になっているのでそちらを取り消す。
- `genre.*` / `area.*` — マスタは削除しても `diff` に全列が残るので手で作り直せる。自動復元は ID 衝突の扱いが複雑になるため Phase 9 では対象外とする。
- `announcement.send` — 届いた通知は取り消せない。
- `audit.undo` — 取り消しの取り消しは無限に入れ子になる。1 段で止める。

**取り消しそのものも監査対象。** `audit.undo` の行を追記し、元の監査行は消さない・書き換えない（追記専用）。二重取り消しは「`action = 'audit.undo'` かつ `target_id = 元の監査ログ ID` の行が既にあるか」で弾く。

**競合の扱い。** 取り消しの UPDATE には「現在値が `diff` の変更後と一致すること」を WHERE に入れる。一致しなければ誰かが後から変えているので、書き込む前に `conflict` を返す。D1 に対話的トランザクションが無いため、SELECT からバッチ実行までの隙間は残る。その場合 UPDATE は 0 行に当たり、`audit.undo` の行だけが残る。**これは既知の穴として受け入れる**（監査ログは「試みた事実」の記録でもあり、`diff` に観測値が入っているので後から読み解ける）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/admin-audit-repository.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_OWNER } from '../db/constants';
import { auditLogs, profiles, reviews, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import { ADMIN_WRITE_OUTCOME } from '../lib/admin-outcome';
import { REPORT_DECISIONS, resolveReport } from './admin-report-repository';
import { assignShopOwner, suspendShop } from './admin-shop-repository';
import { changeUserRole, suspendUser } from './admin-user-repository';
import { listAuditLogs, undoAuditLog } from './admin-audit-repository';

const PAGE_LIMIT = 20;

/** 直近の監査ログ 1 行を取る */
async function latestAuditLog(world: AdminWorld) {
  const page = await listAuditLogs(world.db, world.actor, {
    actorId: null,
    action: null,
    targetType: null,
    targetId: null,
    limit: 1,
    cursor: null,
  });
  return page.items[0];
}

describe('監査ログの閲覧', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('最初は空', async () => {
    const page = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: null,
      targetType: null,
      targetId: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('新着順に並び、実行者の表示名が付く', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    await suspendShop(world.db, world.actor, world.ids.shopId);

    const page = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: null,
      targetType: null,
      targetId: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items.map((item) => item.action)).toEqual(['shop.suspend', 'user.suspend']);
    expect(page.items[0]?.actorName).toBe('管理 太郎');
  });

  it('action で絞り込める', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    await suspendShop(world.db, world.actor, world.ids.shopId);

    const page = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: 'user.suspend',
      targetType: null,
      targetId: null,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
  });

  it('対象で絞り込める', async () => {
    await suspendShop(world.db, world.actor, world.ids.shopId);

    const page = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: null,
      targetType: 'shop',
      targetId: world.ids.shopId,
      limit: PAGE_LIMIT,
      cursor: null,
    });

    expect(page.items).toHaveLength(1);
  });

  it('limit を超えたら nextCursor が返り、続きが読める', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    await suspendShop(world.db, world.actor, world.ids.shopId);

    const first = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: null,
      targetType: null,
      targetId: null,
      limit: 1,
      cursor: null,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listAuditLogs(world.db, world.actor, {
      actorId: null,
      action: null,
      targetType: null,
      targetId: null,
      limit: 1,
      cursor: decodeCursorOrThrow(first.nextCursor),
    });

    expect(second.items[0]?.action).toBe('user.suspend');
    expect(second.nextCursor).toBeNull();
  });
});

describe('監査ログの取り消し', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('ユーザー停止を取り消すと active に戻る', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    const entry = await latestAuditLog(world);

    const outcome = await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));
    const entries = await world.db.select().from(auditLogs);

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.ok);
    expect(profile?.status).toBe('active');
    expect(entries).toHaveLength(2);
    expect(entries.map((row) => row.action).includes('audit.undo')).toBe(true);
  });

  it('元の監査ログは消さない（追記専用）', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    const entry = await latestAuditLog(world);

    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const rows = await world.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, entry?.auditLogId ?? ''));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('user.suspend');
  });

  it('店舗の強制非公開を取り消すと published に戻る', async () => {
    await suspendShop(world.db, world.actor, world.ids.shopId);
    const entry = await latestAuditLog(world);

    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));

    expect(shop?.status).toBe('published');
  });

  it('オーナー付け替えを取り消すと前のオーナーに戻る', async () => {
    await assignShopOwner(world.db, world.actor, world.ids.shopId, null);
    const entry = await latestAuditLog(world);

    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [shop] = await world.db.select().from(shops).where(eq(shops.id, world.ids.shopId));

    expect(shop?.ownerId).toBe(world.ids.ownerUserId);
  });

  it('ロール変更を取り消すと元のロールに戻る', async () => {
    await changeUserRole(world.db, world.actor, world.ids.normalUserId, ROLE_OWNER);
    const entry = await latestAuditLog(world);

    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(profile?.role).toBe('user');
  });

  it('通報対応によるレビュー非表示も取り消せる', async () => {
    await resolveReport(world.db, world.actor, world.ids.reportId, REPORT_DECISIONS.hideContent);
    const entry = await latestAuditLog(world);

    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [review] = await world.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, world.ids.reviewId));

    expect(review?.status).toBe('published');
  });

  it('同じ監査ログを 2 回取り消すと conflict', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    const entry = await latestAuditLog(world);
    await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    expect(await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '')).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('取り消し対象外の action は conflict', async () => {
    await world.db.insert(auditLogs).values({
      id: 'aud_manual0000000000000000000000000',
      actorId: world.ids.adminUserId,
      action: 'announcement.send',
      targetType: 'announcement',
      targetId: 'ann_000000000000',
      diff: { title: [null, 'x'] },
    });

    expect(await undoAuditLog(world.db, world.actor, 'aud_manual0000000000000000000000000')).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });

  it('取り消し後に対象が変わっていたら conflict（書き込まない）', async () => {
    await suspendUser(world.db, world.actor, world.ids.normalUserId);
    const entry = await latestAuditLog(world);
    // 別の管理者が手で戻した、という状況を作る
    await world.db
      .update(profiles)
      .set({ status: 'deleted' })
      .where(eq(profiles.userId, world.ids.normalUserId));

    const outcome = await undoAuditLog(world.db, world.actor, entry?.auditLogId ?? '');

    const [profile] = await world.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, world.ids.normalUserId));

    expect(outcome).toBe(ADMIN_WRITE_OUTCOME.conflict);
    expect(profile?.status).toBe('deleted');
    expect(await world.db.select().from(auditLogs)).toHaveLength(1);
  });

  it('存在しない監査ログは not-found', async () => {
    expect(await undoAuditLog(world.db, world.actor, 'aud_missing')).toBe(
      ADMIN_WRITE_OUTCOME.notFound,
    );
  });

  it('diff が無い監査ログは conflict', async () => {
    await world.db.insert(auditLogs).values({
      id: 'aud_nodiff000000000000000000000000',
      actorId: world.ids.adminUserId,
      action: 'user.suspend',
      targetType: 'user',
      targetId: world.ids.normalUserId,
      diff: null,
    });

    expect(await undoAuditLog(world.db, world.actor, 'aud_nodiff000000000000000000000000')).toBe(
      ADMIN_WRITE_OUTCOME.conflict,
    );
  });
});
```

テスト先頭に、カーソル文字列を `Cursor` に戻す小さなヘルパを置く。

```ts
import { decodeCursor, type Cursor } from '../lib/cursor';

/** nextCursor は文字列。テストでは必ずデコードできる前提で扱う */
function decodeCursorOrThrow(raw: string | null): Cursor {
  if (raw === null) {
    throw new Error('nextCursor が null です');
  }
  const cursor = decodeCursor(raw);
  if (cursor === null) {
    throw new Error(`カーソルを復号できません: ${raw}`);
  }
  return cursor;
}
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-audit-repository`
Expected: FAIL。`Failed to resolve import "./admin-audit-repository"`。

- [ ] **Step 3: 実装を書く**

`apps/api/src/repositories/admin-audit-repository.ts`

```ts
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  PROFILE_STATUSES,
  REVIEW_STATUSES,
  ROLES,
  SHOP_STATUSES,
  type ProfileStatus,
  type ReviewStatus,
  type Role,
  type ShopStatus,
} from '../db/constants';
import { auditLogs, profiles, reviews, shops, type AuditLogDiff } from '../db/schema';
import { ADMIN_WRITE_OUTCOME, type AdminWriteOutcome } from '../lib/admin-outcome';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  withAuditLog,
  type AuditAction,
} from '../lib/audit-log';
import { buildCursorPage, buildKeysetCondition, type Cursor, type CursorPage } from '../lib/cursor';

export type AuditLogItem = {
  readonly auditLogId: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly diff: AuditLogDiff | null;
  readonly createdAtMs: number;
  readonly undoable: boolean;
};

export type ListAuditLogsParams = {
  readonly actorId: string | null;
  readonly action: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly limit: number;
  readonly cursor: Cursor | null;
};

/** 取り消せる操作。ここに無い action は `undoAuditLog` が conflict を返す */
export const UNDOABLE_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.userSuspend,
  AUDIT_ACTIONS.userRestore,
  AUDIT_ACTIONS.userRoleChange,
  AUDIT_ACTIONS.shopSuspend,
  AUDIT_ACTIONS.shopRestore,
  AUDIT_ACTIONS.shopOwnerAssign,
  AUDIT_ACTIONS.reviewHide,
];

/** 「既に取り消されているか」の判定に使う件数 */
const NO_ROWS = 0;

/** `diff` の 1 項目を [変更前, 変更後] として取り出す */
function readChange(
  diff: AuditLogDiff | null,
  key: string,
): { readonly before: unknown; readonly after: unknown } | null {
  if (diff === null) {
    return null;
  }
  const pair = diff[key];
  if (pair === undefined) {
    return null;
  }
  return { before: pair[0], after: pair[1] };
}

function toProfileStatus(value: unknown): ProfileStatus | null {
  return PROFILE_STATUSES.find((status) => status === value) ?? null;
}

function toShopStatus(value: unknown): ShopStatus | null {
  return SHOP_STATUSES.find((status) => status === value) ?? null;
}

function toReviewStatus(value: unknown): ReviewStatus | null {
  return REVIEW_STATUSES.find((status) => status === value) ?? null;
}

function toRole(value: unknown): Role | null {
  return ROLES.find((role) => role === value) ?? null;
}

/** null もありうる ID。`{ value }` で包むのは「null 自体が正しい値」と「型違い」を区別するため */
function toNullableId(value: unknown): { readonly value: string | null } | null {
  if (value === null) {
    return { value: null };
  }
  if (typeof value === 'string') {
    return { value };
  }
  return null;
}

export async function listAuditLogs(
  db: Database,
  _actor: AdminActor,
  params: ListAuditLogsParams,
): Promise<CursorPage<AuditLogItem>> {
  const conditions: SQL[] = [];
  if (params.actorId !== null) {
    conditions.push(eq(auditLogs.actorId, params.actorId));
  }
  if (params.action !== null) {
    conditions.push(eq(auditLogs.action, params.action));
  }
  if (params.targetType !== null) {
    conditions.push(eq(auditLogs.targetType, params.targetType));
  }
  if (params.targetId !== null) {
    conditions.push(eq(auditLogs.targetId, params.targetId));
  }
  if (params.cursor !== null) {
    conditions.push(buildKeysetCondition(auditLogs.createdAt, auditLogs.id, params.cursor));
  }

  // 実行者アカウントが消えていても行は残るので left join
  const rows = await db
    .select({
      auditLogId: auditLogs.id,
      actorId: auditLogs.actorId,
      actorName: profiles.displayName,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      diff: auditLogs.diff,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(profiles, eq(profiles.userId, auditLogs.actorId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(params.limit + 1);

  const items = rows.map((row) => ({
    auditLogId: row.auditLogId,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    diff: row.diff,
    createdAtMs: row.createdAt.getTime(),
    undoable: UNDOABLE_ACTIONS.some((action) => action === row.action),
  }));

  return buildCursorPage(items, params.limit, (item) => ({
    createdAtMs: item.createdAtMs,
    id: item.auditLogId,
  }));
}

/**
 * 監査ログ 1 件を取り消す。
 *
 * 元の行は消さず、`audit.undo` の行を追記する（監査ログは追記専用）。
 * UPDATE の WHERE に「現在値が diff の変更後と同じ」を入れてあるので、
 * 誰かが後から別の値に変えていた場合は 0 行更新になる。事前の突き合わせでも
 * 弾いているが、SELECT からバッチ実行までの隙間は D1 では塞げないため、
 * 二重の防御として両方入れている。
 *
 * 分岐ごとに UPDATE を直書きしているのは意図的。書き込みの組み立てを
 * 非 export のヘルパに切り出すと、`admin-audit-convention.test.ts` の
 * 規約 5（private な書き込みヘルパの禁止）に引っかかり、かつ網羅照合を
 * すり抜ける道を作ってしまう。
 */
export async function undoAuditLog(
  db: Database,
  actor: AdminActor,
  auditLogId: string,
): Promise<AdminWriteOutcome> {
  const rows = await db
    .select({
      action: auditLogs.action,
      targetId: auditLogs.targetId,
      diff: auditLogs.diff,
    })
    .from(auditLogs)
    .where(eq(auditLogs.id, auditLogId))
    .limit(1);

  const entry = rows[0];
  if (entry === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (!UNDOABLE_ACTIONS.some((action) => action === entry.action)) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const alreadyUndone = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, AUDIT_ACTIONS.auditUndo), eq(auditLogs.targetId, auditLogId)))
    .limit(1);
  if (alreadyUndone.length > NO_ROWS) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  if (entry.action === AUDIT_ACTIONS.userSuspend || entry.action === AUDIT_ACTIONS.userRestore) {
    const change = readChange(entry.diff, 'status');
    const before = toProfileStatus(change?.before);
    const after = toProfileStatus(change?.after);
    if (before === null || after === null) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    const current = await db
      .select({ status: profiles.status })
      .from(profiles)
      .where(eq(profiles.userId, entry.targetId))
      .limit(1);
    if (current[0] === undefined) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
    if (current[0].status !== after) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    await withAuditLog(
      db,
      actor,
      {
        action: AUDIT_ACTIONS.auditUndo,
        targetType: AUDIT_TARGET_TYPES.auditLog,
        targetId: auditLogId,
        diff: { undoneAction: [null, entry.action], status: [after, before] },
      },
      [
        db
          .update(profiles)
          .set({ status: before })
          .where(and(eq(profiles.userId, entry.targetId), eq(profiles.status, after))),
      ],
    );
    return ADMIN_WRITE_OUTCOME.ok;
  }

  if (entry.action === AUDIT_ACTIONS.userRoleChange) {
    const change = readChange(entry.diff, 'role');
    const before = toRole(change?.before);
    const after = toRole(change?.after);
    if (before === null || after === null) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    const current = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.userId, entry.targetId))
      .limit(1);
    if (current[0] === undefined) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
    if (current[0].role !== after) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    await withAuditLog(
      db,
      actor,
      {
        action: AUDIT_ACTIONS.auditUndo,
        targetType: AUDIT_TARGET_TYPES.auditLog,
        targetId: auditLogId,
        diff: { undoneAction: [null, entry.action], role: [after, before] },
      },
      [
        db
          .update(profiles)
          .set({ role: before })
          .where(and(eq(profiles.userId, entry.targetId), eq(profiles.role, after))),
      ],
    );
    return ADMIN_WRITE_OUTCOME.ok;
  }

  if (entry.action === AUDIT_ACTIONS.shopSuspend || entry.action === AUDIT_ACTIONS.shopRestore) {
    const change = readChange(entry.diff, 'status');
    const before = toShopStatus(change?.before);
    const after = toShopStatus(change?.after);
    if (before === null || after === null) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    const current = await db
      .select({ status: shops.status })
      .from(shops)
      .where(eq(shops.id, entry.targetId))
      .limit(1);
    if (current[0] === undefined) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
    if (current[0].status !== after) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    await withAuditLog(
      db,
      actor,
      {
        action: AUDIT_ACTIONS.auditUndo,
        targetType: AUDIT_TARGET_TYPES.auditLog,
        targetId: auditLogId,
        diff: { undoneAction: [null, entry.action], status: [after, before] },
      },
      [
        db
          .update(shops)
          .set({ status: before })
          .where(and(eq(shops.id, entry.targetId), eq(shops.status, after))),
      ],
    );
    return ADMIN_WRITE_OUTCOME.ok;
  }

  if (entry.action === AUDIT_ACTIONS.shopOwnerAssign) {
    const change = readChange(entry.diff, 'ownerId');
    const before = toNullableId(change?.before);
    const after = toNullableId(change?.after);
    if (before === null || after === null) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    const current = await db
      .select({ ownerId: shops.ownerId })
      .from(shops)
      .where(eq(shops.id, entry.targetId))
      .limit(1);
    if (current[0] === undefined) {
      return ADMIN_WRITE_OUTCOME.notFound;
    }
    if (current[0].ownerId !== after.value) {
      return ADMIN_WRITE_OUTCOME.conflict;
    }

    await withAuditLog(
      db,
      actor,
      {
        action: AUDIT_ACTIONS.auditUndo,
        targetType: AUDIT_TARGET_TYPES.auditLog,
        targetId: auditLogId,
        diff: { undoneAction: [null, entry.action], ownerId: [after.value, before.value] },
      },
      [db.update(shops).set({ ownerId: before.value }).where(eq(shops.id, entry.targetId))],
    );
    return ADMIN_WRITE_OUTCOME.ok;
  }

  // ここに来るのは review.hide だけ（UNDOABLE_ACTIONS の残り 1 つ）
  const change = readChange(entry.diff, 'status');
  const before = toReviewStatus(change?.before);
  const after = toReviewStatus(change?.after);
  if (before === null || after === null) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  const current = await db
    .select({ status: reviews.status })
    .from(reviews)
    .where(eq(reviews.id, entry.targetId))
    .limit(1);
  if (current[0] === undefined) {
    return ADMIN_WRITE_OUTCOME.notFound;
  }
  if (current[0].status !== after) {
    return ADMIN_WRITE_OUTCOME.conflict;
  }

  await withAuditLog(
    db,
    actor,
    {
      action: AUDIT_ACTIONS.auditUndo,
      targetType: AUDIT_TARGET_TYPES.auditLog,
      targetId: auditLogId,
      diff: { undoneAction: [null, entry.action], status: [after, before] },
    },
    [
      db
        .update(reviews)
        .set({ status: before })
        .where(and(eq(reviews.id, entry.targetId), eq(reviews.status, after))),
    ],
  );
  return ADMIN_WRITE_OUTCOME.ok;
}
```

`shop.owner_assign` の UPDATE だけ WHERE に現在値を入れていないのは、`ownerId` が NULL になりうるため（`eq(col, null)` は SQL の `= NULL` になり常に偽）。事前の突き合わせで弾いているので、隙間の狭さは他の分岐と同じ。**この非対称は意図的**であり、直前の SELECT との差は既知の穴として受け入れる（この節の冒頭で述べたとおり）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-audit-repository`
Expected: PASS（16 件）

- [ ] **Step 5: 監査ログの表に 1 行足す**

```ts
import { listAuditLogs, undoAuditLog } from './admin-audit-repository';

  {
    functionName: 'undoAuditLog',
    label: '監査ログの取り消し',
    expectedAuditCount: 2,
    run: async (world) => {
      await suspendUser(world.db, world.actor, world.ids.normalUserId);
      const page = await listAuditLogs(world.db, world.actor, {
        actorId: null,
        action: null,
        targetType: null,
        targetId: null,
        limit: 1,
        cursor: null,
      });
      const auditLogId = page.items[0]?.auditLogId;
      if (auditLogId === undefined) {
        throw new Error('監査ログが 1 件も無い状態で取り消しを呼ぼうとしています');
      }
      await undoAuditLog(world.db, world.actor, auditLogId);
    },
  },
```

Run: `npm test -w @meshimap/api -- admin-audit`
Expected: PASS

- [ ] **Step 6: わざと壊して、「追記専用」が守られていることを確認する**

`undoAuditLog` の `user.suspend` 分岐に、元の監査行を消す文を足す。

```ts
      [
        db.delete(auditLogs).where(eq(auditLogs.id, auditLogId)),
        db
          .update(profiles)
          .set({ status: before })
          .where(and(eq(profiles.userId, entry.targetId), eq(profiles.status, after))),
      ],
```

Run: `npm test -w @meshimap/api -- admin-audit-repository`
Expected: FAIL。「元の監査ログは消さない（追記専用）」が `expected [] to have a length of 1 but got +0` で落ちる。確認したら戻す。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-audit-repository.ts apps/api/src/repositories/admin-audit-repository.test.ts apps/api/src/repositories/admin-audit-coverage.test.ts
git commit -m "feat(api): 監査ログの閲覧と取り消しを追加"
```

---

### Task 9-12: 全体 KPI（overview タブの数値）

**Files:**

- Modify: `apps/api/src/repositories/admin-stats-repository.ts`（Task 9-2 で読み取り専用の骨だけ作ったもの）
- Test: `apps/api/src/repositories/admin-stats-repository.test.ts`

**Interfaces:**

- Consumes: Task 9-3 の `createAdminWorld`
- Produces: `type OverviewStats` / `getOverviewStats(db, _actor, sinceMs: number): Promise<OverviewStats>`

**出す数値（設計書 5.1「全体 KPI: 新規店舗/投稿数/未処理件数」）:**

| 項目                      | 定義                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `newShopCount`            | `shops.created_at >= sinceMs` の件数                                                            |
| `newReviewCount`          | `reviews.created_at >= sinceMs` の件数                                                          |
| `newUserCount`            | `profiles.created_at >= sinceMs` の件数                                                         |
| `pendingApplicationCount` | `shop_applications.status = 'pending'` の件数（期間で切らない。溜まっている総数が知りたいため） |
| `openReportCount`         | `reports.status IN ('open', 'in_review')` の件数（同上）                                        |

`sinceMs` を引数で受け取るのは、`Date.now()` をリポジトリの中で呼ぶとテストが時刻に依存するため。「いつからか」を決めるのはルート層の責務にする。

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/admin-stats-repository.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reports, reviews, shopApplications, shops } from '../db/schema';
import { createAdminWorld, type AdminWorld } from '../db/testing/admin-world';
import { getOverviewStats } from './admin-stats-repository';

/** 30 日ぶんのミリ秒 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 100 日ぶんのミリ秒。期間外の行を作るのに使う */
const HUNDRED_DAYS_MS = 100 * 24 * 60 * 60 * 1000;

describe('全体 KPI', () => {
  let world: AdminWorld;

  beforeEach(async () => {
    world = await createAdminWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('直近 30 日の新規件数と未処理件数を返す', async () => {
    const stats = await getOverviewStats(world.db, world.actor, Date.now() - THIRTY_DAYS_MS);

    expect(stats).toEqual({
      newShopCount: 1,
      newReviewCount: 1,
      newUserCount: 3,
      pendingApplicationCount: 1,
      openReportCount: 1,
    });
  });

  it('期間より前の行は新規に数えない', async () => {
    const old = new Date(Date.now() - HUNDRED_DAYS_MS);
    await world.db.update(shops).set({ createdAt: old });
    await world.db.update(reviews).set({ createdAt: old });

    const stats = await getOverviewStats(world.db, world.actor, Date.now() - THIRTY_DAYS_MS);

    expect(stats.newShopCount).toBe(0);
    expect(stats.newReviewCount).toBe(0);
  });

  it('未処理件数は期間で切らない', async () => {
    const old = new Date(Date.now() - HUNDRED_DAYS_MS);
    await world.db.update(shopApplications).set({ createdAt: old });
    await world.db.update(reports).set({ createdAt: old });

    const stats = await getOverviewStats(world.db, world.actor, Date.now() - THIRTY_DAYS_MS);

    expect(stats.pendingApplicationCount).toBe(1);
    expect(stats.openReportCount).toBe(1);
  });

  it('境界値: created_at が sinceMs ちょうどの行は新規に数える', async () => {
    const boundaryMs = Date.now() - THIRTY_DAYS_MS;
    await world.db.update(shops).set({ createdAt: new Date(boundaryMs) });

    const stats = await getOverviewStats(world.db, world.actor, boundaryMs);

    expect(stats.newShopCount).toBe(1);
  });

  it('境界値: created_at が sinceMs の 1 ミリ秒前なら数えない', async () => {
    const boundaryMs = Date.now() - THIRTY_DAYS_MS;
    await world.db.update(shops).set({ createdAt: new Date(boundaryMs - 1) });

    const stats = await getOverviewStats(world.db, world.actor, boundaryMs);

    expect(stats.newShopCount).toBe(0);
  });

  it('対応済みの通報は未処理に数えない', async () => {
    await world.db.update(reports).set({ status: 'resolved', handledAt: new Date() });

    const stats = await getOverviewStats(world.db, world.actor, Date.now() - THIRTY_DAYS_MS);

    expect(stats.openReportCount).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- admin-stats-repository`
Expected: FAIL。Task 9-2 の骨は全部 0 を返すので `expected { newShopCount: 0, … } to deeply equal { newShopCount: 1, … }`。

- [ ] **Step 3: 実装を書く**

**このステップは Task 9-2 が置いたファイルを丸ごと差し替える。型名と列が変わるので、差分を先に確認すること。**

| Task 9-2 の骨                                                    | Task 9-12 の実装                                   | なぜ変えるか                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 型名 `AdminOverviewStats`                                        | 型名 `OverviewStats`                               | 置き場所が `admin-stats-repository.ts` なので `Admin` が重複する。**改名するので、差し替え前に古い名前の参照が 0 本であることを確かめる** |
| `suspendedUserCount`（`profiles.status = 'suspended'` の総数）   | **落とす**                                         | 設計書 5.1 の KPI は「新規店舗 / 投稿数 / 未処理件数」。停止中ユーザー数は概況ではなく、ユーザー一覧の `status` 絞り込みで見る            |
| 無い                                                             | `newUserCount`（`profiles.created_at >= sinceMs`） | 「新規」の 3 本目として要る                                                                                                               |
| `REVIEW_STATUS_PUBLISHED` / `SHOP_STATUS_PUBLISHED` で状態を絞る | 絞らない（`created_at` だけで数える）              | 「その期間に増えた数」なので、あとから非公開になった行も母数に残す。状態で絞ると過去の KPI が後から書き換わり、前月比が意味を失う         |

差し替える前に次を流し、古い名前が 1 ファイルに閉じていることを確認する。閉じていなければ呼び出し側も同じコミットで直す。

```bash
cd /Users/hattori/Downloads/alee
grep -rn 'AdminOverviewStats\|suspendedUserCount' apps/api/src
```

Expected: `apps/api/src/repositories/admin-stats-repository.ts` の行だけが出る。

`apps/api/src/repositories/admin-stats-repository.ts`

```ts
import { and, count, gte } from 'drizzle-orm';
import type { AdminActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  APPLICATION_STATUS_PENDING,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_OPEN,
} from '../db/constants';
import { inValues } from '../db/sql-helpers';
import { profiles, reports, reviews, shopApplications, shops } from '../db/schema';
import { eq } from 'drizzle-orm';

export type OverviewStats = {
  readonly newShopCount: number;
  readonly newReviewCount: number;
  readonly newUserCount: number;
  readonly pendingApplicationCount: number;
  readonly openReportCount: number;
};

/** 件数が取れなかったときの既定値 */
const ZERO = 0;

/** まだ決着していない通報の状態 */
const UNRESOLVED_REPORT_STATUSES = [REPORT_STATUS_OPEN, REPORT_STATUS_IN_REVIEW] as const;

/**
 * 管理ダッシュボードの数値をまとめて返す。
 *
 * 現在時刻をここで作らず `sinceMs` を受け取るのは、テストを時計に依存させないため。
 * 5 本のクエリを `db.batch` にまとめる案もあるが、`batch` は書き込み用に
 * `withAuditLog` からしか呼ばない決まりにしてあるので（Task 9-2 の規約 3）、
 * 読み取りは素直に 5 回投げる。
 */
export async function getOverviewStats(
  db: Database,
  _actor: AdminActor,
  sinceMs: number,
): Promise<OverviewStats> {
  const since = new Date(sinceMs);

  const newShops = await db
    .select({ value: count() })
    .from(shops)
    .where(gte(shops.createdAt, since));
  const newReviews = await db
    .select({ value: count() })
    .from(reviews)
    .where(gte(reviews.createdAt, since));
  const newUsers = await db
    .select({ value: count() })
    .from(profiles)
    .where(gte(profiles.createdAt, since));
  const pendingApplications = await db
    .select({ value: count() })
    .from(shopApplications)
    .where(eq(shopApplications.status, APPLICATION_STATUS_PENDING));
  const openReports = await db
    .select({ value: count() })
    .from(reports)
    .where(and(inValues(reports.status, UNRESOLVED_REPORT_STATUSES)));

  return {
    newShopCount: newShops[0]?.value ?? ZERO,
    newReviewCount: newReviews[0]?.value ?? ZERO,
    newUserCount: newUsers[0]?.value ?? ZERO,
    pendingApplicationCount: pendingApplications[0]?.value ?? ZERO,
    openReportCount: openReports[0]?.value ?? ZERO,
  };
}
```

`and(...)` を 1 引数で呼んでいる箇所は冗長なので、実装時は `.where(inValues(reports.status, UNRESOLVED_REPORT_STATUSES))` に縮め、`and` の import が他で使われていなければ消すこと（`noUnusedLocals` で落ちる）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- admin-stats-repository`
Expected: PASS（6 件）

- [ ] **Step 5: わざと壊して、境界値のテストが効いていることを確認する**

`gte(shops.createdAt, since)` を `gt(shops.createdAt, since)` に変える（`gt` を import する）。

Run: `npm test -w @meshimap/api -- admin-stats-repository`
Expected: FAIL。「境界値: created_at が sinceMs ちょうどの行は新規に数える」だけが `expected +0 to be 1` で落ちる。`>=` と `>` の取り違えを 1 件のテストが捕まえていることを確認する。確認したら戻す。

- [ ] **Step 6: 監査ログの規約検査が読み取り専用ファイルを素通りさせることを確認する**

`admin-stats-repository.ts` は `admin-` で始まるので Task 9-2 の走査対象に入るが、書き込みビルダーを含まないので違反にならない。

Run: `npm test -w @meshimap/api -- admin-audit-convention`
Expected: PASS（**18 件**）。単発 10 件 + `it.each(targets)` が `src/repositories/admin-*.ts`（`.test.ts` を除く）の本数ぶん展開された分。この時点の 8 本は `admin-announcement-repository.ts` / `admin-application-repository.ts` / `admin-audit-repository.ts` / `admin-master-repository.ts` / `admin-report-repository.ts` / `admin-shop-repository.ts` / `admin-stats-repository.ts` / `admin-user-repository.ts` なので、10 + 8 = 18 件。

- [ ] **Step 7: コミットする**

```bash
git add apps/api/src/repositories/admin-stats-repository.ts apps/api/src/repositories/admin-stats-repository.test.ts
git commit -m "feat(api): 管理ダッシュボードの全体 KPI を実装"
```

---

### Task 9-13: ルート層の土台（応答変換 / 入力スキーマ / 検査用ハーネス）と stats・applications

ここから API の外側に出る。**リポジトリの戻り値を HTTP に写す規則を 1 箇所に閉じ込める**のがこのタスクの主目的で、ルート自体は stats と applications の 6 本だけ作る。残りは Task 9-14 / 9-15 が同じ型に流し込む。

**Files:**

- Create: `apps/api/src/routes/admin/respond.ts`
- Create: `apps/api/src/routes/admin/respond.test.ts`
- Create: `apps/api/src/routes/admin/schemas.ts`
- Create: `apps/api/src/routes/admin/schemas.test.ts`
- Create: `apps/api/src/routes/admin/route-harness.test.ts`
- Create: `apps/api/src/routes/admin/stats.ts`
- Create: `apps/api/src/routes/admin/applications.ts`
- Create: `apps/api/src/routes/admin/applications.test.ts`
- Create: `apps/api/src/routes/admin/index.ts`

**Interfaces:**

- Consumes: Task 9-0 の `conflict`、Phase 4 の `invalidInput` / `notFound` / `authMiddleware` / `errorHandler` / `notFoundHandler` / `roleGuard` / `requireAdminActor` / `createDatabase` / `createTestWorld` / `createTestBindings` / `signUpAs` / `seedMasters` / `seedUser` / `seedShop` / `readRow`、Task 9-4 の `clampPageSize` / `decodeCursor` / `Cursor`、Task 9-5 の `listApplications` / `getApplication` / `approveApplication` / `returnApplication` / `rejectApplication` / `ListApplicationsParams`、Task 9-12 の `getOverviewStats`、`apps/api/src/lib/admin-outcome.ts` の `ADMIN_WRITE_OUTCOME` / `AdminWriteOutcome`
- Produces:
  - `assertWriteSucceeded(outcome: AdminWriteOutcome): void`
  - `assertFound<T>(value: T | null): T`
  - `parseOrThrow<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema>`
  - `readJsonBody(request: Request): Promise<unknown>`
  - `type PaginationQuery = { readonly cursor: string \| null; readonly limit: number \| null }`
  - `type PageParams = { readonly cursor: Cursor \| null; readonly limit: number }`
  - `toPageParams(query: PaginationQuery): PageParams`
  - `PAGINATION_SHAPE` / `paginationQuerySchema` / `applicationListQuerySchema` / `reviewNoteSchema` / `reviewDecisionBodySchema` / `REVIEW_NOTE_MAX_LENGTH` / `OVERVIEW_WINDOW_DAYS` / `MILLISECONDS_PER_DAY`
  - `statsRoutes` / `applicationRoutes` / `adminRoutes`
  - `createAdminTestApp(): Hono<AppEnv>` / `signInAsAdmin(world): Promise<TestUser>` / `requestAdmin(world, path, init?, cookie?): Promise<Response>`（`route-harness.test.ts` から export。以降のルートテストが使う）

**HTTP への写し方（この表がルート層の唯一の規則）:**

| リポジトリの戻り値                         | HTTP                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `AdminWriteOutcome` の `'ok'`              | 200（作成系だけ 201）                                          |
| `AdminWriteOutcome` の `'not-found'`       | 404 `notFound()`                                               |
| `AdminWriteOutcome` の `'conflict'`        | 409 `conflict()`                                               |
| 読み取り系の `null`                        | 404 `notFound()`                                               |
| `AnnouncementOutcome` の `'already-sent'`  | 409 `conflict()`                                               |
| `AnnouncementOutcome` の `'no-recipients'` | 422 `invalidInput()`（宛先指定が誰にも当たらない＝入力の問題） |
| zod の `safeParse` 失敗                    | 422 `invalidInput()`                                           |
| カーソル文字列の復号失敗                   | 422 `invalidInput()`                                           |

404 と 409 の切り分けは**リポジトリ側ですでに決まっている**。ルート層は写すだけで、ここで新しい判断を足さない。足すと「どこで 404 になったのか」が 2 箇所に散る。

- [ ] **Step 1: 応答変換の失敗するテストを書く**

`apps/api/src/routes/admin/respond.test.ts`

```ts
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ADMIN_WRITE_OUTCOME } from '../../lib/admin-outcome';
import { encodeCursor, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../../lib/cursor';
import {
  ERROR_MESSAGE_CONFLICT,
  ERROR_MESSAGE_INVALID_INPUT,
  ERROR_MESSAGE_NOT_FOUND,
} from '../../lib/http-error';
import {
  assertFound,
  assertWriteSucceeded,
  parseOrThrow,
  readJsonBody,
  toPageParams,
} from './respond';

/** throw された値から status と message を取り出す。HTTPException でなければテストを落とす */
function readHttpException(run: () => unknown): { status: number; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof HTTPException) {
      return { status: error.status, message: error.message };
    }
    throw error;
  }
  throw new Error('例外が投げられなかった');
}

describe('assertWriteSucceeded', () => {
  it('ok なら何も投げない', () => {
    expect(() => assertWriteSucceeded(ADMIN_WRITE_OUTCOME.ok)).not.toThrow();
  });

  it('not-found なら 404 を投げる', () => {
    expect(readHttpException(() => assertWriteSucceeded(ADMIN_WRITE_OUTCOME.notFound))).toEqual({
      status: 404,
      message: ERROR_MESSAGE_NOT_FOUND,
    });
  });

  it('conflict なら 409 を投げる', () => {
    expect(readHttpException(() => assertWriteSucceeded(ADMIN_WRITE_OUTCOME.conflict))).toEqual({
      status: 409,
      message: ERROR_MESSAGE_CONFLICT,
    });
  });
});

describe('assertFound', () => {
  it('値があればそのまま返す', () => {
    expect(assertFound({ id: 'app_0001' })).toEqual({ id: 'app_0001' });
  });

  it('null なら 404 を投げる', () => {
    expect(readHttpException(() => assertFound(null))).toEqual({
      status: 404,
      message: ERROR_MESSAGE_NOT_FOUND,
    });
  });

  it('0 や空文字は「見つかった」として扱う（falsy を null と混同しない）', () => {
    expect(assertFound(0)).toBe(0);
    expect(assertFound('')).toBe('');
  });
});

describe('parseOrThrow', () => {
  const schema = z.object({ note: z.string().min(1) });

  it('通れば parse 済みの値を返す', () => {
    expect(parseOrThrow(schema, { note: 'ok' })).toEqual({ note: 'ok' });
  });

  it('落ちれば 422 を投げる', () => {
    expect(readHttpException(() => parseOrThrow(schema, { note: '' }))).toEqual({
      status: 422,
      message: ERROR_MESSAGE_INVALID_INPUT,
    });
  });

  it('どのフィールドが悪いかは応答に含めない', () => {
    expect(readHttpException(() => parseOrThrow(schema, { note: '' })).message).not.toContain(
      'note',
    );
  });
});

describe('toPageParams', () => {
  it('cursor 未指定なら null、limit 未指定なら既定値', () => {
    expect(toPageParams({ cursor: null, limit: null })).toEqual({
      cursor: null,
      limit: PAGE_SIZE_DEFAULT,
    });
  });

  it('limit は上限で丸める', () => {
    expect(toPageParams({ cursor: null, limit: PAGE_SIZE_MAX + 1 }).limit).toBe(PAGE_SIZE_MAX);
  });

  it('正しい cursor は復号される', () => {
    const cursor = { createdAtMs: 1_789_500_000_000, id: 'aud_0001' };

    expect(toPageParams({ cursor: encodeCursor(cursor), limit: null }).cursor).toEqual(cursor);
  });

  it('壊れた cursor は 422（黙って 1 ページ目に戻さない）', () => {
    expect(readHttpException(() => toPageParams({ cursor: 'broken', limit: null }))).toEqual({
      status: 422,
      message: ERROR_MESSAGE_INVALID_INPUT,
    });
  });
});

describe('readJsonBody', () => {
  it('JSON を読む', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'ok' }),
    });

    expect(await readJsonBody(request)).toEqual({ note: 'ok' });
  });

  it('壊れた本文でも投げずに null を返す（500 にしないため）', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(await readJsonBody(request)).toBeNull();
  });

  it('本文が空でも投げずに null を返す', async () => {
    const request = new Request('http://localhost/x', { method: 'POST' });

    expect(await readJsonBody(request)).toBeNull();
  });
});
```

「壊れた cursor は 422」は**意図的な選択**。黙って 1 ページ目を返すと、クライアントは無限ループで同じページを取り続ける（`nextCursor` を渡しているのに先頭が返るため）。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/respond`
Expected: FAIL。`Failed to resolve import "./respond"`。

- [ ] **Step 3: 応答変換を実装する**

`apps/api/src/routes/admin/respond.ts`

```ts
import type { z } from 'zod';
import { ADMIN_WRITE_OUTCOME } from '../../lib/admin-outcome';
import type { AdminWriteOutcome } from '../../lib/admin-outcome';
import { clampPageSize, decodeCursor } from '../../lib/cursor';
import type { Cursor } from '../../lib/cursor';
import { conflict, invalidInput, notFound } from '../../lib/http-error';

/**
 * 書き込みの結果を HTTP に写す唯一の場所。
 *
 * `AdminWriteOutcome` に値が増えたとき、戻り値が void なので
 * 「どの HTTP にするか決めないまま」でもコンパイルは通ってしまう。
 * そこを守るのは respond.test.ts の 3 ケースなので、値を増やしたら必ずテストも足すこと。
 */
export function assertWriteSucceeded(outcome: AdminWriteOutcome): void {
  switch (outcome) {
    case ADMIN_WRITE_OUTCOME.ok:
      return;
    case ADMIN_WRITE_OUTCOME.notFound:
      throw notFound();
    case ADMIN_WRITE_OUTCOME.conflict:
      throw conflict();
  }
}

/**
 * 読み取りの `null` を 404 に写す。
 * `value === null` の厳密比較にしてあるのは、0 や空文字を「見つからなかった」に
 * 化けさせないため（件数 0 を返す読み取りが将来増えても壊れない）。
 */
export function assertFound<T>(value: T | null): T {
  if (value === null) {
    throw notFound();
  }
  return value;
}

/**
 * zod で検証し、落ちたら 422 を投げる。
 * 失敗理由は一切外へ出さない（スキーマ構造が漏れるため）。
 * 原因を追う必要があるときはサーバ側のログを見ること。
 */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidInput();
  }
  return result.data;
}

/**
 * 本文を JSON として読む。
 * `Request.json()` は本文が壊れていると投げるので、握って null にする。
 * null はこのあとのスキーマ検証（object を要求している）で必ず落ち、422 になる。
 * ここで invalidInput を投げないのは、「本文が無いことが正常」なルートを将来足せるようにするため。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** クエリ文字列を検証した直後の形。まだリポジトリには渡せない */
export type PaginationQuery = {
  readonly cursor: string | null;
  readonly limit: number | null;
};

/** リポジトリの `ListXxxParams` にそのまま埋められる形 */
export type PageParams = {
  readonly cursor: Cursor | null;
  readonly limit: number;
};

/**
 * カーソルの復号と件数の丸めをまとめる。
 *
 * 壊れたカーソルを黙って null に落とさないのが要点。
 * null にすると 1 ページ目が返り、クライアントは `nextCursor` を渡しているのに
 * 先頭へ戻される。無限ループになるうえ、原因が見えない。
 */
export function toPageParams(query: PaginationQuery): PageParams {
  const limit = clampPageSize(query.limit);
  if (query.cursor === null) {
    return { cursor: null, limit };
  }
  const cursor = decodeCursor(query.cursor);
  if (cursor === null) {
    throw invalidInput();
  }
  return { cursor, limit };
}
```

`z` を `import type` にしているのは `verbatimModuleSyntax` 対策。値としての `z` はここでは使わない（スキーマは `schemas.ts` 側にある）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/respond && npm run typecheck -w @meshimap/api`
Expected: 両方 PASS（テスト 16 件）

- [ ] **Step 5: わざと壊して、網羅がテストでしか守れていないことを確認する**

`assertWriteSucceeded` の `case ADMIN_WRITE_OUTCOME.conflict:` を丸ごと消す。

Run: `npm run typecheck -w @meshimap/api`
Expected: **通ってしまう**（戻り値が void なので網羅が型で強制されない）。

Run: `npm test -w @meshimap/api -- routes/admin/respond`
Expected: FAIL。「conflict なら 409 を投げる」が `例外が投げられなかった` で落ちる。

次に `assertFound` の `value === null` を `!value` に書き換える。

Run: `npm test -w @meshimap/api -- routes/admin/respond`
Expected: FAIL。「0 や空文字は「見つかった」として扱う」が落ちる。

両方確認したら戻す。

- [ ] **Step 6: 入力スキーマの失敗するテストを書く**

`apps/api/src/routes/admin/schemas.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUS_APPROVED } from '../../db/constants';
import {
  applicationListQuerySchema,
  paginationQuerySchema,
  REVIEW_NOTE_MAX_LENGTH,
  reviewDecisionBodySchema,
  reviewNoteSchema,
} from './schemas';

describe('paginationQuerySchema', () => {
  it('何も指定しなければ両方 null になる', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ cursor: null, limit: null });
  });

  it('limit は数値へ変換される', () => {
    expect(paginationQuerySchema.parse({ limit: '30' })).toEqual({ cursor: null, limit: 30 });
  });

  it('数字以外の limit は弾く', () => {
    expect(paginationQuerySchema.safeParse({ limit: '30件' }).success).toBe(false);
  });

  it('負数・小数・空文字は弾く（正規表現が数字 1 文字以上だけを許すため）', () => {
    expect(paginationQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '' }).success).toBe(false);
  });

  it('上限を超える limit も通す（丸めるのは toPageParams の仕事）', () => {
    expect(paginationQuerySchema.parse({ limit: '100000' }).limit).toBe(100_000);
  });

  it('cursor は文字列のまま通す（復号の失敗は toPageParams が扱う）', () => {
    expect(paginationQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });

  it('空の cursor は弾く（`?cursor=` を「先頭から」と解釈させない）', () => {
    expect(paginationQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('知らないクエリが混ざっても落ちない', () => {
    expect(paginationQuerySchema.parse({ limit: '5', sort: 'name' })).toEqual({
      cursor: null,
      limit: 5,
    });
  });
});

describe('applicationListQuerySchema', () => {
  it('status 未指定は null', () => {
    expect(applicationListQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: null,
      status: null,
    });
  });

  it('語彙にある status は通る', () => {
    expect(applicationListQuerySchema.parse({ status: APPLICATION_STATUS_APPROVED }).status).toBe(
      APPLICATION_STATUS_APPROVED,
    );
  });

  it('語彙に無い status は弾く', () => {
    expect(applicationListQuerySchema.safeParse({ status: 'pendinng' }).success).toBe(false);
  });
});

describe('reviewNoteSchema', () => {
  it('空文字は弾く（差し戻し理由が空だと申請者が何も分からない）', () => {
    expect(reviewNoteSchema.safeParse('').success).toBe(false);
  });

  it('上限ちょうどは通る', () => {
    expect(reviewNoteSchema.safeParse('あ'.repeat(REVIEW_NOTE_MAX_LENGTH)).success).toBe(true);
  });

  it('上限を 1 文字超えると弾く', () => {
    expect(reviewNoteSchema.safeParse('あ'.repeat(REVIEW_NOTE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('reviewDecisionBodySchema', () => {
  it('reviewNote を持つ object だけを通す', () => {
    expect(reviewDecisionBodySchema.parse({ reviewNote: '書類が不足しています' })).toEqual({
      reviewNote: '書類が不足しています',
    });
  });

  it('null（本文が壊れていたとき readJsonBody が返す値）は弾く', () => {
    expect(reviewDecisionBodySchema.safeParse(null).success).toBe(false);
  });
});
```

- [ ] **Step 7: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。`Failed to resolve import "./schemas"`。

- [ ] **Step 8: 入力スキーマを実装する**

`apps/api/src/routes/admin/schemas.ts`

```ts
import { z } from 'zod';
import { APPLICATION_STATUSES } from '../../db/constants';

/**
 * `shop_applications.review_note` の上限。
 * この列に長さの CHECK は無い（`apps/api/src/db/schema/admin.ts` を読んで確認済み）ので、
 * ここが唯一の歯止めになる。差し戻し理由として十分な長さを取りつつ、行を膨らませない値。
 */
export const REVIEW_NOTE_MAX_LENGTH = 500;

/**
 * すべての一覧系が共通で持つクエリ列。
 *
 * `z.coerce.number()` を使わないのは、`Number('')` が 0、`Number(' 1 ')` が 1 になるなど
 * 空白と空文字の扱いが暗黙になるため。数字 1 文字以上だけを明示的に許す。
 * `.optional()` のまま受けて後段の transform で null に寄せるのは、
 * ZodPipe を object の値に置いたときのキー省略可否を暗黙に頼らないため。
 */
export const PAGINATION_SHAPE = {
  cursor: z.string().min(1).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
} as const;

/** `PAGINATION_SHAPE` を通した直後の生の形 */
type RawPaginationQuery = {
  readonly cursor?: string | undefined;
  readonly limit?: string | undefined;
};

/**
 * 未指定を `null` に正規化する。
 * `undefined` を残さないのは、`exactOptionalPropertyTypes` の下で
 * `{ cursor?: string }` と `{ cursor: string | null }` の変換が呼び出し側に散るため。
 */
function toPaginationQuery(input: RawPaginationQuery): {
  cursor: string | null;
  limit: number | null;
} {
  return {
    cursor: input.cursor ?? null,
    limit: input.limit === undefined ? null : Number.parseInt(input.limit, 10),
  };
}

export const paginationQuerySchema = z.object(PAGINATION_SHAPE).transform(toPaginationQuery);

/** 申請一覧のクエリ。`status` は `APPLICATION_STATUSES` の語彙だけ */
export const applicationListQuerySchema = z
  .object({ ...PAGINATION_SHAPE, status: z.enum(APPLICATION_STATUSES).optional() })
  .transform((input) => ({ ...toPaginationQuery(input), status: input.status ?? null }));

/** 差し戻し・却下の理由。申請者に見えるので空を許さない */
export const reviewNoteSchema = z.string().min(1).max(REVIEW_NOTE_MAX_LENGTH);

/** 差し戻し・却下のリクエストボディ */
export const reviewDecisionBodySchema = z.object({ reviewNote: reviewNoteSchema });

/**
 * overview の集計期間。クライアントからは変えられないようにする。
 * ダッシュボードの数値の意味が人によって変わると、運用の会話が噛み合わなくなる。
 */
export const OVERVIEW_WINDOW_DAYS = 30;

/** 1 日のミリ秒 */
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
```

`z.enum(APPLICATION_STATUSES)` が `readonly string[]` を受けることは `node_modules/zod/v4/classic/schemas.d.cts:610`（`declare function _enum<const T extends readonly string[]>(values: T, ...)`）で確認した。

- [ ] **Step 9: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: PASS（16 件）

- [ ] **Step 10: 検査用ハーネスと、その自己テストを書く**

以降のルートテストはすべてこれを import する。**本物の認証経路（Better Auth のサインアップ → Cookie）を通す**のが要点で、`viewer` を差し込むフェイクにすると「認証ミドルウェアを付け忘れたルート」を見逃す。

`apps/api/src/routes/admin/route-harness.test.ts`

```ts
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_ADMIN } from '../../db/constants';
import type { AppEnv } from '../../lib/app-env';
import { ERROR_MESSAGE_NOT_FOUND, ERROR_MESSAGE_UNAUTHORIZED } from '../../lib/http-error';
import { authMiddleware } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/error-handler';
import {
  createTestBindings,
  createTestWorld,
  signUpAs,
  type TestUser,
  type TestWorld,
} from '../../test/fixtures';
import { adminRoutes } from './index';

/**
 * 本番の src/index.ts と同じ順序でミドルウェアを積んだアプリ。
 *
 * 認証 → ルート → エラー変換の並びが本番と同じであることがこのテストの前提なので、
 * Phase 4 の src/index.ts を変えたらここも合わせること。
 * ずれていないことは Task 9-17 で src/index.ts と突き合わせて確認する。
 */
export function createAdminTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.use('*', authMiddleware);
  app.route('/admin', adminRoutes);
  return app;
}

/** 管理者として本当にサインアップし、Cookie 付きのユーザーを返す */
export async function signInAsAdmin(world: TestWorld): Promise<TestUser> {
  return await signUpAs(world, 'admin@example.test', ROLE_ADMIN);
}

/**
 * Cookie を付けて `/admin` 配下を叩く。
 * bindings の渡し忘れと Headers の組み立て忘れを防ぐため、入口を 1 本にまとめる。
 */
export async function requestAdmin(
  world: TestWorld,
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return await createAdminTestApp().request(path, { ...init, headers }, createTestBindings(world));
}

/** JSON ボディ付きのリクエストを組み立てる。content-type の付け忘れを防ぐ */
export function jsonBody(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('ルートテスト用ハーネス', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('Cookie なしで /admin 配下を叩くと 401 になる', async () => {
    const response = await requestAdmin(world, '/admin/stats/overview');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { status: 401, message: ERROR_MESSAGE_UNAUTHORIZED },
    });
  });

  it('管理者でも存在しない /admin のパスは 404 で、401 と応答の形が同じ', async () => {
    const admin = await signInAsAdmin(world);
    const response = await requestAdmin(world, '/admin/nope', {}, admin.cookie);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND },
    });
  });

  it('未ログインで存在しないパスを叩くと 404 ではなく 401（存在の有無を漏らさない）', async () => {
    // H-5 の実測どおり、use('*') は未定義パスでも走る。
    // これは仕様として意図しているので、変わったら気付けるように固定しておく
    const response = await requestAdmin(world, '/admin/nope');

    expect(response.status).toBe(401);
  });

  it('管理者の Cookie なら通る', async () => {
    const admin = await signInAsAdmin(world);
    const response = await requestAdmin(world, '/admin/stats/overview', {}, admin.cookie);

    expect(response.status).toBe(200);
  });
});
```

`route-harness.test.ts` という `.test.ts` の中にヘルパを置いているのは、`vitest.config.ts` の `coverage.exclude` が `src/**/*.test.ts` を除いており、`stryker.config.mjs` の `mutate` も同じものを除いているため。**除外設定を増やさずに**テスト専用コードを置ける唯一の場所がここになる。同じ理由で Task 9-3 も `admin-audit-convention.test.ts` から AST ヘルパを export している。

- [ ] **Step 11: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- route-harness`
Expected: FAIL。`Failed to resolve import "./index"`。

- [ ] **Step 12: stats ルートと `/admin` の集約を実装する**

`apps/api/src/routes/admin/stats.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import { getOverviewStats } from '../../repositories/admin-stats-repository';
import { MILLISECONDS_PER_DAY, OVERVIEW_WINDOW_DAYS } from './schemas';

export const statsRoutes = new Hono<AppEnv>().get('/overview', async (c) => {
  const actor = requireAdminActor(c);
  // 「いつからか」を決めるのはルート層の責務。リポジトリは Date.now() を呼ばない
  const sinceMs = Date.now() - OVERVIEW_WINDOW_DAYS * MILLISECONDS_PER_DAY;
  const stats = await getOverviewStats(createDatabase(c.env.DB), actor, sinceMs);

  return c.json({ windowDays: OVERVIEW_WINDOW_DAYS, ...stats });
});
```

`apps/api/src/routes/admin/index.ts`

```ts
import { Hono } from 'hono';
import { ROLE_ADMIN } from '../../db/constants';
import type { AppEnv } from '../../lib/app-env';
import { roleGuard } from '../../middleware/role-guard';
import { applicationRoutes } from './applications';
import { statsRoutes } from './stats';

/**
 * `/admin` 配下の集約。
 *
 * **門番はここ 1 箇所だけ**に置く。個々のルートファイルで roleGuard を呼ばないこと。
 * ルートごとに書くと新しいルートで付け忘れが起き、しかもそれは「動いてしまう」ので
 * 手で気づけない。付け忘れが無いことは Task 9-16 の権限行列 128 ケースが機械的に保証する。
 *
 * use('*') は route() より **先に** 登録すること（H-4 の実測どおり、
 * 先に登録すれば子ルータ配下でも走る）。
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', roleGuard(ROLE_ADMIN));
adminRoutes.route('/stats', statsRoutes);
adminRoutes.route('/applications', applicationRoutes);
```

- [ ] **Step 13: applications の失敗するテストを書く**

`apps/api/src/routes/admin/applications.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUS_APPROVED,
  APPLICATION_STATUS_PENDING,
  ROLE_OWNER,
  SHOP_STATUS_DRAFT,
} from '../../db/constants';
import {
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestUser,
  type TestWorld,
} from '../../test/fixtures';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

const APPLICATION_ID = 'app_0001';
const SHOP_ID = 'shp_0001';
const APPLICANT_ID = 'usr_applicant_0001';

/** 申請 1 件と、その対象店舗・申請者を用意する */
async function seedApplication(world: TestWorld): Promise<void> {
  await seedMasters(world);
  await seedUser(world, { userId: APPLICANT_ID, role: ROLE_OWNER, displayName: '申請 三郎' });
  await seedShop(world, { id: SHOP_ID, ownerId: null, status: SHOP_STATUS_DRAFT });
  // shop_applications に updated_at 列は無い（apps/api/src/db/schema/admin.ts:105-128 で実測）
  await runWrite(
    world,
    'INSERT INTO shop_applications (id, applicant_id, shop_id, documents, status, reviewed_by, review_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    APPLICATION_ID,
    APPLICANT_ID,
    SHOP_ID,
    '[]',
    APPLICATION_STATUS_PENDING,
    null,
    null,
    0,
  );
}

describe('/admin/applications', () => {
  let world: TestWorld;
  let admin: TestUser;

  beforeEach(async () => {
    world = await createTestWorld();
    admin = await signInAsAdmin(world);
    await seedApplication(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('一覧はカーソル付きで返る', async () => {
    const response = await requestAdmin(world, '/admin/applications', {}, admin.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{
      items: readonly { applicationId: string }[];
      nextCursor: string | null;
    }>();
    expect(body.items.map((item) => item.applicationId)).toEqual([APPLICATION_ID]);
    expect(body.nextCursor).toBeNull();
  });

  it('status で絞り込める', async () => {
    const response = await requestAdmin(
      world,
      `/admin/applications?status=${APPLICATION_STATUS_APPROVED}`,
      {},
      admin.cookie,
    );

    const body = await response.json<{ items: readonly unknown[] }>();
    expect(body.items).toEqual([]);
  });

  it('limit に数字以外を渡すと 422', async () => {
    const response = await requestAdmin(world, '/admin/applications?limit=abc', {}, admin.cookie);

    expect(response.status).toBe(422);
  });

  it('壊れた cursor は 422', async () => {
    const response = await requestAdmin(world, '/admin/applications?cursor=zzz', {}, admin.cookie);

    expect(response.status).toBe(422);
  });

  it('詳細は 200、存在しない ID は 404', async () => {
    const found = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}`,
      {},
      admin.cookie,
    );
    const missing = await requestAdmin(world, '/admin/applications/app_missing', {}, admin.cookie);

    expect(found.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('承認すると 200 になり、申請と店舗の状態が変わる', async () => {
    const response = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}/approve`,
      { method: 'POST' },
      admin.cookie,
    );

    expect(response.status).toBe(200);
    const application = await readRow(
      world,
      'SELECT status FROM shop_applications WHERE id = ?',
      APPLICATION_ID,
    );
    expect(application?.status).toBe(APPLICATION_STATUS_APPROVED);
    const shop = await readRow(world, 'SELECT owner_id FROM shops WHERE id = ?', SHOP_ID);
    expect(shop?.owner_id).toBe(APPLICANT_ID);
  });

  it('二重承認は 409 になる', async () => {
    const path = `/admin/applications/${APPLICATION_ID}/approve`;
    await requestAdmin(world, path, { method: 'POST' }, admin.cookie);
    const second = await requestAdmin(world, path, { method: 'POST' }, admin.cookie);

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: { status: 409, message: '対象の状態が変わっています' },
    });
  });

  it('差し戻しは理由が要る。空なら 422 で、監査ログも増えない', async () => {
    const before = await readRow(world, 'SELECT COUNT(*) AS count FROM audit_logs');
    const response = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}/return`,
      jsonBody('POST', { reviewNote: '' }),
      admin.cookie,
    );
    const after = await readRow(world, 'SELECT COUNT(*) AS count FROM audit_logs');

    expect(response.status).toBe(422);
    expect(after?.count).toBe(before?.count);
  });

  it('理由を付けた差し戻しは 200 で、理由が保存される', async () => {
    const response = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}/return`,
      jsonBody('POST', { reviewNote: '営業許可証が読めません' }),
      admin.cookie,
    );

    expect(response.status).toBe(200);
    const application = await readRow(
      world,
      'SELECT review_note FROM shop_applications WHERE id = ?',
      APPLICATION_ID,
    );
    expect(application?.review_note).toBe('営業許可証が読めません');
  });

  it('却下も理由が要る', async () => {
    const response = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}/reject`,
      jsonBody('POST', {}),
      admin.cookie,
    );

    expect(response.status).toBe(422);
  });

  it('本文が JSON でないときも 422（500 にしない）', async () => {
    const response = await requestAdmin(
      world,
      `/admin/applications/${APPLICATION_ID}/return`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
      admin.cookie,
    );

    expect(response.status).toBe(422);
  });
});
```

- [ ] **Step 14: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/applications`
Expected: FAIL。`Failed to resolve import "./applications"`。

- [ ] **Step 15: applications ルートを実装する**

`apps/api/src/routes/admin/applications.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  approveApplication,
  getApplication,
  listApplications,
  rejectApplication,
  returnApplication,
} from '../../repositories/admin-application-repository';
import {
  assertFound,
  assertWriteSucceeded,
  parseOrThrow,
  readJsonBody,
  toPageParams,
} from './respond';
import { applicationListQuerySchema, reviewDecisionBodySchema } from './schemas';

export const applicationRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(applicationListQuerySchema, c.req.query());
    const page = await listApplications(createDatabase(c.env.DB), actor, {
      ...toPageParams(query),
      status: query.status,
    });

    return c.json(page);
  })
  .get('/:applicationId', async (c) => {
    const actor = requireAdminActor(c);
    const detail = await getApplication(
      createDatabase(c.env.DB),
      actor,
      c.req.param('applicationId'),
    );

    return c.json(assertFound(detail));
  })
  .post('/:applicationId/approve', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await approveApplication(
      createDatabase(c.env.DB),
      actor,
      c.req.param('applicationId'),
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .post('/:applicationId/return', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(reviewDecisionBodySchema, await readJsonBody(c.req.raw));
    const outcome = await returnApplication(
      createDatabase(c.env.DB),
      actor,
      c.req.param('applicationId'),
      body.reviewNote,
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .post('/:applicationId/reject', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(reviewDecisionBodySchema, await readJsonBody(c.req.raw));
    const outcome = await rejectApplication(
      createDatabase(c.env.DB),
      actor,
      c.req.param('applicationId'),
      body.reviewNote,
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  });
```

`c.req.query()` は全クエリを `Record<string, string>` で返す。zod の既定は未知キーを落とす（strip）ので、余計なクエリが付いても落ちない。

- [ ] **Step 16: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin && npm run typecheck -w @meshimap/api`
Expected: PASS（respond 16 + schemas 16 + harness 4 + applications 11 = 47 件）

- [ ] **Step 17: わざと壊して、検証・門番・監査が効いていることを確認する**

1. `readJsonBody` の `try` / `catch` を外して `await request.json()` を直接返す → 「本文が JSON でないときも 422」が `expected 500 to be 422` で落ちる。
2. `applications.ts` の `assertWriteSucceeded(outcome);` を 5 箇所すべてから消す → 「二重承認は 409」が `expected 200 to be 409` で落ちる。
3. `index.ts` の `adminRoutes.use('*', roleGuard(ROLE_ADMIN));` を消す → ハーネスの「Cookie なしで /admin 配下を叩くと 401 になる」は**通ったままになるはず**である。ハンドラが先頭で `requireAdminActor(c)` を呼んでおり、`middleware/role-guard.ts:39` のコメントどおり「`roleGuard` を付け忘れても同じ 403 を投げる」二重の防御になっているため、**ステータスだけを見るテストでは門番の有無を判別できない**。実際にどうなったかを記録すること。**門番が `/admin` 全体に 1 つだけ掛かっていることを機械的に保証しているのは、Task 9-16 Step 1 の「門番は /admin/\* に 1 つだけ掛かっている」（`app.routes` の `ALL` のパス一覧を `toEqual` で固定する静的検査）ただ 1 本**なので、Task 9-16 を飛ばしてはならない。ここで落ちた場合は二重防御のどちらかに穴があるということなので、先にそちらを調べる。
4. `index.ts` の `adminRoutes.use(...)` を `adminRoutes.route('/stats', statsRoutes);` の**後ろ**へ移す → H-4 の前提（先に登録すれば走る）が崩れるので、Cookie なしの 401 テストが落ちるか確認する。

4 つとも確認したら戻す。

```bash
git diff --stat
```

Expected: 壊した箇所が残っていないこと。

- [ ] **Step 18: コミットする**

```bash
cd /Users/hattori/Downloads/alee
npm test -w @meshimap/api && npm run typecheck -w @meshimap/api && npm run lint
git add apps/api/src/routes/admin
git commit -m "feat(api): 管理 API のルート土台と stats・applications を追加"
```

---

### Task 9-14: 通報 / ユーザー / 店舗のルート

Task 9-13 で決めた写し方に、残り 3 つのリポジトリを流し込む。**新しい規則をここで作らない**のが合格条件で、`assertWriteSucceeded` / `assertFound` / `parseOrThrow` / `toPageParams` 以外の分岐がルートに現れたら設計を戻すこと。

**Files:**

- Create: `apps/api/src/routes/admin/reports.ts`
- Create: `apps/api/src/routes/admin/reports.test.ts`
- Create: `apps/api/src/routes/admin/users.ts`
- Create: `apps/api/src/routes/admin/users.test.ts`
- Create: `apps/api/src/routes/admin/shops.ts`
- Create: `apps/api/src/routes/admin/shops.test.ts`
- Modify: `apps/api/src/routes/admin/schemas.ts`（一覧クエリ 3 つと本文 3 つを追加）
- Modify: `apps/api/src/routes/admin/schemas.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts`（3 つ mount する）

**Interfaces:**

- Consumes: Task 9-13 の `respond.ts` / `schemas.ts` / `route-harness.test.ts`、Task 9-3 の `createAdminWorld` / `AdminWorld`、Task 9-6 の `listReports` / `getReport` / `resolveReport` / `rejectReport` / `REPORT_DECISIONS`、Task 9-7 の `listUsers` / `getUser` / `suspendUser` / `restoreUser` / `changeUserRole`、Task 9-8 の `listShops` / `getShopForAdmin` / `suspendShop` / `restoreShop` / `assignShopOwner`
- Produces:
  - `SEARCH_KEYWORD_MAX_LENGTH` / `keywordShape`
  - `reportListQuerySchema` / `reportResolveBodySchema`
  - `userListQuerySchema` / `roleChangeBodySchema`
  - `shopListQuerySchema` / `ownerAssignBodySchema`
  - `reportRoutes` / `userRoutes` / `shopRoutes`

**このタスクで守る境界:**

- **`PATCH` を使うのはロール変更とオーナー付け替えの 2 本だけ。** どちらも「対象の属性を 1 つ差し替える」操作で、冪等。`suspend` / `restore` / `resolve` は「状態遷移を 1 回起こす」操作なので `POST` にする（二重送信が 409 になるのが正しい挙動で、冪等ではない）。
- **`ownerId` の `null` は省略で表さない。** 本文は `{ "ownerId": null }` を必須にする。省略を「外す」と読むと、クライアントのバグでキーが落ちただけのときにオーナーが消える。
- **検索語は 1 文字以上。** `?keyword=` を「絞り込み無し」と同じにすると、クエリの組み立てミスが全件返却として表に出ない。

- [ ] **Step 1: 追加する入力スキーマの失敗するテストを書く**

`apps/api/src/routes/admin/schemas.test.ts` の末尾に追記する。

```ts
describe('reportListQuerySchema', () => {
  it('未指定は両方 null', () => {
    expect(reportListQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: null,
      status: null,
      targetType: null,
    });
  });

  it('語彙にある値は通る', () => {
    expect(
      reportListQuerySchema.parse({
        status: REPORT_STATUS_OPEN,
        targetType: REPORT_TARGET_TYPE_REVIEW,
      }),
    ).toEqual({
      cursor: null,
      limit: null,
      status: REPORT_STATUS_OPEN,
      targetType: REPORT_TARGET_TYPE_REVIEW,
    });
  });

  it('語彙に無い targetType は弾く', () => {
    expect(reportListQuerySchema.safeParse({ targetType: 'comment' }).success).toBe(false);
  });
});

describe('reportResolveBodySchema', () => {
  it('決着の 3 つはすべて通る', () => {
    for (const decision of Object.values(REPORT_DECISIONS)) {
      expect(reportResolveBodySchema.safeParse({ decision }).success).toBe(true);
    }
  });

  it('知らない決着は弾く', () => {
    expect(reportResolveBodySchema.safeParse({ decision: 'delete' }).success).toBe(false);
  });

  it('decision が無いと弾く', () => {
    expect(reportResolveBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('userListQuerySchema', () => {
  it('未指定はすべて null', () => {
    expect(userListQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: null,
      keyword: null,
      role: null,
      status: null,
    });
  });

  it('空の keyword は弾く（全件返却をクエリ組み立てミスで起こさないため）', () => {
    expect(userListQuerySchema.safeParse({ keyword: '' }).success).toBe(false);
  });

  it('長すぎる keyword は弾く', () => {
    expect(
      userListQuerySchema.safeParse({ keyword: 'あ'.repeat(SEARCH_KEYWORD_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('role と status は語彙を検査する', () => {
    expect(
      userListQuerySchema.parse({ role: ROLE_OWNER, status: PROFILE_STATUS_SUSPENDED }),
    ).toEqual({
      cursor: null,
      limit: null,
      keyword: null,
      role: ROLE_OWNER,
      status: PROFILE_STATUS_SUSPENDED,
    });
    expect(userListQuerySchema.safeParse({ role: 'superadmin' }).success).toBe(false);
  });
});

describe('roleChangeBodySchema', () => {
  it('3 つのロールはすべて通る', () => {
    for (const role of ROLES) {
      expect(roleChangeBodySchema.safeParse({ role }).success).toBe(true);
    }
  });

  it('知らないロールは弾く', () => {
    expect(roleChangeBodySchema.safeParse({ role: 'moderator' }).success).toBe(false);
  });
});

describe('shopListQuerySchema', () => {
  it('status は語彙を検査する', () => {
    expect(shopListQuerySchema.parse({ status: SHOP_STATUS_SUSPENDED }).status).toBe(
      SHOP_STATUS_SUSPENDED,
    );
    expect(shopListQuerySchema.safeParse({ status: 'hidden' }).success).toBe(false);
  });
});

describe('ownerAssignBodySchema', () => {
  it('ownerId を渡せる', () => {
    expect(ownerAssignBodySchema.parse({ ownerId: 'usr_owner_0001' })).toEqual({
      ownerId: 'usr_owner_0001',
    });
  });

  it('null を明示すればオーナーを外せる', () => {
    expect(ownerAssignBodySchema.parse({ ownerId: null })).toEqual({ ownerId: null });
  });

  it('キーの省略は弾く（うっかり外れるのを防ぐ）', () => {
    expect(ownerAssignBodySchema.safeParse({}).success).toBe(false);
  });

  it('空文字は弾く', () => {
    expect(ownerAssignBodySchema.safeParse({ ownerId: '' }).success).toBe(false);
  });
});
```

import 文も先頭に足す。

```ts
import {
  PROFILE_STATUS_SUSPENDED,
  REPORT_STATUS_OPEN,
  REPORT_TARGET_TYPE_REVIEW,
  ROLE_OWNER,
  ROLES,
  SHOP_STATUS_SUSPENDED,
} from '../../db/constants';
import { REPORT_DECISIONS } from '../../repositories/admin-report-repository';
import {
  ownerAssignBodySchema,
  reportListQuerySchema,
  reportResolveBodySchema,
  roleChangeBodySchema,
  SEARCH_KEYWORD_MAX_LENGTH,
  shopListQuerySchema,
  userListQuerySchema,
} from './schemas';
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。`reportListQuerySchema is not exported by ./schemas` 相当のエラー。

- [ ] **Step 3: 入力スキーマを追加する**

`apps/api/src/routes/admin/schemas.ts` の末尾に追記する。

```ts
/**
 * 検索語の上限。
 * 検索対象で一番長い名前は `shops.name`（CHECK は 100 文字。`apps/api/src/db/schema/shop.ts` で確認済み）なので、
 * それより長い語は必ず 0 件になる。弾いても機能は落ちない。
 */
export const SEARCH_KEYWORD_MAX_LENGTH = 100;

/**
 * 検索語のクエリ列。
 * `.min(1)` にして `?keyword=` を弾く。空を「絞り込み無し」と同じにすると、
 * クエリ組み立てのバグで全件が返っても異常として現れない。
 */
export const keywordShape = {
  keyword: z.string().min(1).max(SEARCH_KEYWORD_MAX_LENGTH).optional(),
} as const;

/** 通報一覧のクエリ */
export const reportListQuerySchema = z
  .object({
    ...PAGINATION_SHAPE,
    status: z.enum(REPORT_STATUSES).optional(),
    targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  })
  .transform((input) => ({
    ...toPaginationQuery(input),
    status: input.status ?? null,
    targetType: input.targetType ?? null,
  }));

/**
 * 通報への対応。
 * `z.enum` はオブジェクトも受ける（`node_modules/zod/v4/classic/schemas.d.cts:611`
 * の `_enum<const T extends util.EnumLike>(entries: T, ...)` オーバーロード）ので、
 * 値の配列を別に作らずに `REPORT_DECISIONS` をそのまま渡せる。
 */
export const reportResolveBodySchema = z.object({ decision: z.enum(REPORT_DECISIONS) });

/** ユーザー一覧のクエリ */
export const userListQuerySchema = z
  .object({
    ...PAGINATION_SHAPE,
    ...keywordShape,
    role: z.enum(ROLES).optional(),
    status: z.enum(PROFILE_STATUSES).optional(),
  })
  .transform((input) => ({
    ...toPaginationQuery(input),
    keyword: input.keyword ?? null,
    role: input.role ?? null,
    status: input.status ?? null,
  }));

/** ロール変更の本文 */
export const roleChangeBodySchema = z.object({ role: z.enum(ROLES) });

/** 店舗一覧のクエリ */
export const shopListQuerySchema = z
  .object({
    ...PAGINATION_SHAPE,
    ...keywordShape,
    status: z.enum(SHOP_STATUSES).optional(),
  })
  .transform((input) => ({
    ...toPaginationQuery(input),
    keyword: input.keyword ?? null,
    status: input.status ?? null,
  }));

/**
 * オーナー付け替えの本文。
 * `.nullable()` のままキーを必須にしてあるのが要点。`.optional()` にすると
 * 「キーを送り忘れた」と「オーナーを外したい」が区別できなくなる。
 */
export const ownerAssignBodySchema = z.object({
  ownerId: z.string().min(1).max(IDENTIFIER_MAX_LENGTH).nullable(),
});
```

先頭の import を差し替える。

```ts
import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  IDENTIFIER_MAX_LENGTH,
  PROFILE_STATUSES,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  ROLES,
  SHOP_STATUSES,
} from '../../db/constants';
import { REPORT_DECISIONS } from '../../repositories/admin-report-repository';
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas && npm run typecheck -w @meshimap/api`
Expected: 両方 PASS（schemas 33 件。Task 9-13 の 16 件 + このタスクで足した 17 件）

- [ ] **Step 5: わざと壊して、語彙検査が効いていることを確認する**

`userListQuerySchema` の `role: z.enum(ROLES).optional()` を `role: z.string().optional()` に書き換える。

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。「role と status は語彙を検査する」が `expected true to be false` で落ちる。

次に `ownerAssignBodySchema` の `.nullable()` を `.nullish()` に書き換える。

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。「キーの省略は弾く」が落ちる。

両方戻す。

- [ ] **Step 6: 通報ルートの失敗するテストを書く**

`apps/api/src/routes/admin/reports.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_STATUS_REJECTED,
  REPORT_STATUS_RESOLVED,
  REVIEW_STATUS_HIDDEN,
} from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { countRows, readRow, type TestUser } from '../../test/fixtures';
import { REPORT_DECISIONS } from '../../repositories/admin-report-repository';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

describe('/admin/reports', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('一覧が返る', async () => {
    const response = await requestAdmin(admin.world, '/admin/reports', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{ items: readonly { reportId: string }[] }>();
    expect(body.items.map((item) => item.reportId)).toEqual([admin.ids.reportId]);
  });

  it('targetType で絞り込める', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/reports?targetType=shop',
      {},
      signedIn.cookie,
    );

    expect((await response.json<{ items: readonly unknown[] }>()).items).toEqual([]);
  });

  it('詳細は 200、無い ID は 404', async () => {
    const found = await requestAdmin(
      admin.world,
      `/admin/reports/${admin.ids.reportId}`,
      {},
      signedIn.cookie,
    );
    const missing = await requestAdmin(
      admin.world,
      '/admin/reports/rep_missing',
      {},
      signedIn.cookie,
    );

    expect(found.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('hide-content で対応するとレビューが非表示になり、監査ログが増える', async () => {
    const before = await countRows(admin.world, 'SELECT COUNT(*) AS count FROM audit_logs');
    const response = await requestAdmin(
      admin.world,
      `/admin/reports/${admin.ids.reportId}/resolve`,
      jsonBody('POST', { decision: REPORT_DECISIONS.hideContent }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    const review = await readRow(
      admin.world,
      'SELECT status FROM reviews WHERE id = ?',
      admin.ids.reviewId,
    );
    expect(review?.status).toBe(REVIEW_STATUS_HIDDEN);
    const report = await readRow(
      admin.world,
      'SELECT status FROM reports WHERE id = ?',
      admin.ids.reportId,
    );
    expect(report?.status).toBe(REPORT_STATUS_RESOLVED);
    expect(
      await countRows(admin.world, 'SELECT COUNT(*) AS count FROM audit_logs'),
    ).toBeGreaterThan(before);
  });

  it('決着の値が語彙外なら 422 で、何も変わらない', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/reports/${admin.ids.reportId}/resolve`,
      jsonBody('POST', { decision: 'delete' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
    const report = await readRow(
      admin.world,
      'SELECT status FROM reports WHERE id = ?',
      admin.ids.reportId,
    );
    expect(report?.status).not.toBe(REPORT_STATUS_RESOLVED);
    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM audit_logs')).toBe(0);
  });

  it('却下は 200。二度目は 409', async () => {
    const path = `/admin/reports/${admin.ids.reportId}/reject`;
    const first = await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);
    const second = await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    const report = await readRow(
      admin.world,
      'SELECT status FROM reports WHERE id = ?',
      admin.ids.reportId,
    );
    expect(report?.status).toBe(REPORT_STATUS_REJECTED);
  });
});
```

- [ ] **Step 7: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/reports`
Expected: FAIL。`Failed to resolve import "./reports"`。

- [ ] **Step 8: 通報ルートを実装する**

`apps/api/src/routes/admin/reports.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  getReport,
  listReports,
  rejectReport,
  resolveReport,
} from '../../repositories/admin-report-repository';
import {
  assertFound,
  assertWriteSucceeded,
  parseOrThrow,
  readJsonBody,
  toPageParams,
} from './respond';
import { reportListQuerySchema, reportResolveBodySchema } from './schemas';

export const reportRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(reportListQuerySchema, c.req.query());
    const page = await listReports(createDatabase(c.env.DB), actor, {
      ...toPageParams(query),
      status: query.status,
      targetType: query.targetType,
    });

    return c.json(page);
  })
  .get('/:reportId', async (c) => {
    const actor = requireAdminActor(c);
    const detail = await getReport(createDatabase(c.env.DB), actor, c.req.param('reportId'));

    return c.json(assertFound(detail));
  })
  .post('/:reportId/resolve', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(reportResolveBodySchema, await readJsonBody(c.req.raw));
    const outcome = await resolveReport(
      createDatabase(c.env.DB),
      actor,
      c.req.param('reportId'),
      body.decision,
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .post('/:reportId/reject', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await rejectReport(createDatabase(c.env.DB), actor, c.req.param('reportId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  });
```

`apps/api/src/routes/admin/index.ts` に 1 行足す。

```ts
adminRoutes.route('/reports', reportRoutes);
```

- [ ] **Step 9: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/reports`
Expected: PASS（6 件）

- [ ] **Step 10: ユーザールートの失敗するテストを書く**

`apps/api/src/routes/admin/users.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_STATUS_ACTIVE, PROFILE_STATUS_SUSPENDED, ROLE_OWNER } from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { countRows, readRow, type TestUser } from '../../test/fixtures';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

describe('/admin/users', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('一覧にシード済みのユーザーが含まれる', async () => {
    const response = await requestAdmin(admin.world, '/admin/users', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{ items: readonly { userId: string }[] }>();
    const userIds = body.items.map((item) => item.userId);
    // signInAsAdmin が作った本物のサインアップ行も混ざるので、包含で見る
    expect(userIds).toContain(admin.ids.normalUserId);
    expect(userIds).toContain(admin.ids.ownerUserId);
  });

  it('keyword で絞り込める', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users?keyword=${encodeURIComponent('利用')}`,
      {},
      signedIn.cookie,
    );

    const body = await response.json<{ items: readonly { userId: string }[] }>();
    expect(body.items.map((item) => item.userId)).toEqual([admin.ids.normalUserId]);
  });

  it('空の keyword は 422（全件返却にしない）', async () => {
    const response = await requestAdmin(admin.world, '/admin/users?keyword=', {}, signedIn.cookie);

    expect(response.status).toBe(422);
  });

  it('role で絞り込める', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users?role=${ROLE_OWNER}`,
      {},
      signedIn.cookie,
    );

    const body = await response.json<{ items: readonly { userId: string }[] }>();
    expect(body.items.map((item) => item.userId)).toEqual([admin.ids.ownerUserId]);
  });

  it('詳細は 200、無い ID は 404', async () => {
    const found = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}`,
      {},
      signedIn.cookie,
    );
    const missing = await requestAdmin(
      admin.world,
      '/admin/users/usr_missing',
      {},
      signedIn.cookie,
    );

    expect(found.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('停止して復帰できる（状態が往復する＝物理削除していない）', async () => {
    const suspend = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/suspend`,
      { method: 'POST' },
      signedIn.cookie,
    );
    expect(suspend.status).toBe(200);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT status FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.status,
    ).toBe(PROFILE_STATUS_SUSPENDED);

    const restore = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/restore`,
      { method: 'POST' },
      signedIn.cookie,
    );
    expect(restore.status).toBe(200);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT status FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.status,
    ).toBe(PROFILE_STATUS_ACTIVE);
  });

  it('自分自身の停止は 409', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users/${signedIn.userId}/suspend`,
      { method: 'POST' },
      signedIn.cookie,
    );

    expect(response.status).toBe(409);
  });

  it('ロール変更は PATCH で 200', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/role`,
      jsonBody('PATCH', { role: ROLE_OWNER }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT role FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.role,
    ).toBe(ROLE_OWNER);
  });

  it('語彙外のロールは 422 で、監査ログも増えない', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/role`,
      jsonBody('PATCH', { role: 'moderator' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM audit_logs')).toBe(0);
  });

  it('POST でロール変更を投げると 404（メソッドを取り違えたら気付ける）', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/role`,
      jsonBody('POST', { role: ROLE_OWNER }),
      signedIn.cookie,
    );

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 11: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/users`
Expected: FAIL。`Failed to resolve import "./users"`。

- [ ] **Step 12: ユーザールートを実装する**

`apps/api/src/routes/admin/users.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  changeUserRole,
  getUser,
  listUsers,
  restoreUser,
  suspendUser,
} from '../../repositories/admin-user-repository';
import {
  assertFound,
  assertWriteSucceeded,
  parseOrThrow,
  readJsonBody,
  toPageParams,
} from './respond';
import { roleChangeBodySchema, userListQuerySchema } from './schemas';

export const userRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(userListQuerySchema, c.req.query());
    const page = await listUsers(createDatabase(c.env.DB), actor, {
      ...toPageParams(query),
      keyword: query.keyword,
      role: query.role,
      status: query.status,
    });

    return c.json(page);
  })
  .get('/:userId', async (c) => {
    const actor = requireAdminActor(c);
    const detail = await getUser(createDatabase(c.env.DB), actor, c.req.param('userId'));

    return c.json(assertFound(detail));
  })
  .post('/:userId/suspend', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await suspendUser(createDatabase(c.env.DB), actor, c.req.param('userId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .post('/:userId/restore', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await restoreUser(createDatabase(c.env.DB), actor, c.req.param('userId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .patch('/:userId/role', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(roleChangeBodySchema, await readJsonBody(c.req.raw));
    const outcome = await changeUserRole(
      createDatabase(c.env.DB),
      actor,
      c.req.param('userId'),
      body.role,
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  });
```

`apps/api/src/routes/admin/index.ts` に 1 行足す。

```ts
adminRoutes.route('/users', userRoutes);
```

- [ ] **Step 13: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/users`
Expected: PASS（10 件）

- [ ] **Step 14: 店舗ルートの失敗するテストを書く**

`apps/api/src/routes/admin/shops.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_STATUS_PUBLISHED, SHOP_STATUS_SUSPENDED } from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { readRow, type TestUser } from '../../test/fixtures';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

/** 店舗 1 行を読む小さなヘルパー。同じ SQL を 5 回書かないため */
async function readShop(admin: AdminWorld): Promise<Record<string, unknown> | null> {
  return await readRow(
    admin.world,
    'SELECT status, owner_id FROM shops WHERE id = ?',
    admin.ids.shopId,
  );
}

describe('/admin/shops', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('一覧が返る', async () => {
    const response = await requestAdmin(admin.world, '/admin/shops', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{ items: readonly { shopId: string }[] }>();
    expect(body.items.map((item) => item.shopId)).toEqual([admin.ids.shopId]);
  });

  it('status で絞り込める', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/shops?status=${SHOP_STATUS_SUSPENDED}`,
      {},
      signedIn.cookie,
    );

    expect((await response.json<{ items: readonly unknown[] }>()).items).toEqual([]);
  });

  it('詳細は 200、無い ID は 404', async () => {
    const found = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}`,
      {},
      signedIn.cookie,
    );
    const missing = await requestAdmin(
      admin.world,
      '/admin/shops/shp_missing',
      {},
      signedIn.cookie,
    );

    expect(found.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('強制非公開にしても行は残り、再公開で元へ戻る', async () => {
    const suspend = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/suspend`,
      { method: 'POST' },
      signedIn.cookie,
    );
    expect(suspend.status).toBe(200);
    expect((await readShop(admin))?.status).toBe(SHOP_STATUS_SUSPENDED);

    const restore = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/restore`,
      { method: 'POST' },
      signedIn.cookie,
    );
    expect(restore.status).toBe(200);
    expect((await readShop(admin))?.status).toBe(SHOP_STATUS_PUBLISHED);
  });

  it('二重の強制非公開は 409', async () => {
    const path = `/admin/shops/${admin.ids.shopId}/suspend`;
    await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);
    const second = await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);

    expect(second.status).toBe(409);
  });

  it('オーナーを付け替えられる', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/owner`,
      jsonBody('PATCH', { ownerId: admin.ids.normalUserId }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    expect((await readShop(admin))?.owner_id).toBe(admin.ids.normalUserId);
  });

  it('null を明示すればオーナーを外せる', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/owner`,
      jsonBody('PATCH', { ownerId: null }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    expect((await readShop(admin))?.owner_id).toBeNull();
  });

  it('ownerId を省いた本文は 422 で、オーナーは変わらない', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/owner`,
      jsonBody('PATCH', {}),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
    expect((await readShop(admin))?.owner_id).toBe(admin.ids.ownerUserId);
  });

  it('存在しないユーザーへの付け替えは 404', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}/owner`,
      jsonBody('PATCH', { ownerId: 'usr_missing' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(404);
    expect((await readShop(admin))?.owner_id).toBe(admin.ids.ownerUserId);
  });
});
```

「存在しないユーザーへの付け替えは 404」が通るのは、Task 9-8 の `assignShopOwner` が `nextOwnerId` の実在を確かめて `not-found` を返すと決めてあるため。もしこのテストが 200 で落ちたら、直すのは**ルートではなく Task 9-8 のリポジトリ**。ルート層に実在確認を足さないこと（同じ判断が 2 箇所に散る）。

- [ ] **Step 15: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/shops`
Expected: FAIL。`Failed to resolve import "./shops"`。

- [ ] **Step 16: 店舗ルートを実装する**

`apps/api/src/routes/admin/shops.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  assignShopOwner,
  getShopForAdmin,
  listShops,
  restoreShop,
  suspendShop,
} from '../../repositories/admin-shop-repository';
import {
  assertFound,
  assertWriteSucceeded,
  parseOrThrow,
  readJsonBody,
  toPageParams,
} from './respond';
import { ownerAssignBodySchema, shopListQuerySchema } from './schemas';

export const shopRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(shopListQuerySchema, c.req.query());
    const page = await listShops(createDatabase(c.env.DB), actor, {
      ...toPageParams(query),
      keyword: query.keyword,
      status: query.status,
    });

    return c.json(page);
  })
  .get('/:shopId', async (c) => {
    const actor = requireAdminActor(c);
    const detail = await getShopForAdmin(createDatabase(c.env.DB), actor, c.req.param('shopId'));

    return c.json(assertFound(detail));
  })
  .post('/:shopId/suspend', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await suspendShop(createDatabase(c.env.DB), actor, c.req.param('shopId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .post('/:shopId/restore', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await restoreShop(createDatabase(c.env.DB), actor, c.req.param('shopId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  })
  .patch('/:shopId/owner', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(ownerAssignBodySchema, await readJsonBody(c.req.raw));
    const outcome = await assignShopOwner(
      createDatabase(c.env.DB),
      actor,
      c.req.param('shopId'),
      body.ownerId,
    );
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  });
```

`apps/api/src/routes/admin/index.ts` の最終形。

```ts
import { Hono } from 'hono';
import { ROLE_ADMIN } from '../../db/constants';
import type { AppEnv } from '../../lib/app-env';
import { roleGuard } from '../../middleware/role-guard';
import { applicationRoutes } from './applications';
import { reportRoutes } from './reports';
import { shopRoutes } from './shops';
import { statsRoutes } from './stats';
import { userRoutes } from './users';

/**
 * `/admin` 配下の集約。
 *
 * **門番はここ 1 箇所だけ**に置く。個々のルートファイルで roleGuard を呼ばないこと。
 * 付け忘れが無いことは Task 9-16 の権限行列 128 ケースが機械的に保証する。
 *
 * use('*') は route() より **先に** 登録すること（H-4 の実測どおり）。
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', roleGuard(ROLE_ADMIN));
adminRoutes.route('/stats', statsRoutes);
adminRoutes.route('/applications', applicationRoutes);
adminRoutes.route('/reports', reportRoutes);
adminRoutes.route('/users', userRoutes);
adminRoutes.route('/shops', shopRoutes);
```

- [ ] **Step 17: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin && npm run typecheck -w @meshimap/api`
Expected: PASS

- [ ] **Step 18: わざと壊して、ルートの取り違えが見つかることを確認する**

1. `users.ts` の `.patch('/:userId/role', ...)` を `.post('/:userId/role', ...)` に変える → 「ロール変更は PATCH で 200」が `expected 404 to be 200` で落ち、「POST でロール変更を投げると 404」も落ちる。
2. `shops.ts` の `body.ownerId` を `body.ownerId ?? null` に変える → 何も落ちない（`null` のときは同じ値）。**つまり `??` を足しても検出できない**ので、`.nullable()` を `.nullish()` にしない規律は Step 5 のスキーマテストだけが守っている。この事実を記録してから戻すこと。
3. `reports.ts` の `resolve` から `body.decision` の代わりに `REPORT_DECISIONS.warn` を直接渡す → 「hide-content で対応するとレビューが非表示になり、監査ログが増える」が落ちる。
4. `index.ts` から `adminRoutes.route('/shops', shopRoutes);` を消す → shops のテストが全部 404 で落ちる。

4 つとも確認したら戻す。

```bash
git diff --stat
```

Expected: 壊した箇所が残っていないこと。

- [ ] **Step 19: コミットする**

```bash
cd /Users/hattori/Downloads/alee
npm test -w @meshimap/api && npm run typecheck -w @meshimap/api && npm run lint
git add apps/api/src/routes/admin
git commit -m "feat(api): 通報・ユーザー・店舗の管理ルートを追加"
```

---

### Task 9-15: マスタ / お知らせ / 監査ログのルート

残り 12 エンドポイント。ここで `/admin` 配下が全部そろう。

このタスクには **DB の CHECK 制約と入力検証をつなぐ**という固有の仕事がある。`genres.name` の上限（50）や `notifications.title` の上限（100）は `src/db/schema/` の中でモジュール private な定数になっていて外から見えない。**同じ数字を `schemas.ts` に書き写すと必ずずれる**ので、定数を export して 1 箇所に保つ。

**Files:**

- Modify: `apps/api/src/db/schema/master.ts`（3 つの定数を export する）
- Modify: `apps/api/src/db/schema/admin.ts`（2 つの定数を export する）
- Create: `apps/api/src/routes/admin/masters.ts`
- Create: `apps/api/src/routes/admin/masters.test.ts`
- Create: `apps/api/src/routes/admin/announcements.ts`
- Create: `apps/api/src/routes/admin/announcements.test.ts`
- Create: `apps/api/src/routes/admin/audit-logs.ts`
- Create: `apps/api/src/routes/admin/audit-logs.test.ts`
- Modify: `apps/api/src/routes/admin/schemas.ts`
- Modify: `apps/api/src/routes/admin/schemas.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts`

**Interfaces:**

- Consumes: Task 9-13 / 9-14 の成果物、Task 9-4 の `createPrefixedId` / `ID_PREFIXES` / `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES`、Task 9-10 の `listGenres` / `createGenre` / `updateGenre` / `deleteGenre` / `listAreas` / `createArea` / `updateArea` / `deleteArea`、Task 9-11 の `sendAnnouncement` / `listAnnouncementHistory` / `createAnnouncementId` / `ANNOUNCEMENT_OUTCOME`、Task 9-12 の `listAuditLogs` / `undoAuditLog`
- Produces:
  - `MASTER_NAME_MAX_LENGTH` / `PREFECTURE_MAX_LENGTH` / `SLUG_ALLOWED_CHARACTERS`（`src/db/schema/master.ts` から export）
  - `NOTIFICATION_TITLE_MAX_LENGTH` / `NOTIFICATION_BODY_MAX_LENGTH`（`src/db/schema/admin.ts` から export）
  - `genreFieldsSchema` / `genreCreateBodySchema` / `areaFieldsSchema` / `areaCreateBodySchema`
  - `announcementBodySchema` / `ANNOUNCEMENT_ID_PATTERN` / `ANNOUNCEMENT_MAX_EXPLICIT_RECIPIENTS`
  - `auditLogListQuerySchema`
  - `genreRoutes` / `areaRoutes` / `announcementRoutes` / `auditLogRoutes`

**このタスクで決めること:**

- **マスタの ID はサーバが振る。** `POST /admin/genres` の本文に `id` を入れさせない。クライアントが ID を決められると、既存 ID をぶつけて他人のジャンルの存在を探れる（列挙攻撃）うえ、`gnr_` 以外の接頭辞が混ざる。応答で採番結果を返す。
- **`PATCH` の本文にも `id` を入れさせない。** 更新対象はパスの `:genreId` だけで決まる。Task 9-10 の `updateGenre` は内部で `{ ...input, id: genreId }` としているので、ルートで `{ ...fields, id: genreId }` を組んで渡す。
- **お知らせ ID はクライアントが「やり直し用に」指定できる。** 途中で落ちた配信を同じ ID で呼び直すと残りだけが入る（Task 9-11 の設計）。ただし形は `createAnnouncementId()` が作るものと**完全に同じ**でなければならない。長い ID を受けると `buildNotificationId` が 64 文字を超えて throw し、500 になる。
- **監査ログの `action` / `targetType` は語彙で検査する。** 自由文字列のまま通すと、綴り間違いが「0 件」として返り、画面上は「その操作は一度も行われていない」に見える。

- [ ] **Step 1: スキーマ定数を export する**

`apps/api/src/db/schema/master.ts` の 3 行を書き換える。

```ts
/** ジャンル名・エリア名の上限 */
export const MASTER_NAME_MAX_LENGTH = 50;
/** 都道府県名の上限（「神奈川県」など最長 4 文字だが余裕を持たせる） */
export const PREFECTURE_MAX_LENGTH = 20;
/** slug に使える文字。URL とフィルタのクエリ文字列にそのまま出るため小文字英数字とハイフンのみ */
export const SLUG_ALLOWED_CHARACTERS = 'a-z0-9-';
```

`apps/api/src/db/schema/admin.ts` の 2 行を書き換える。`apps/api/src/db/schema/admin.ts:23` と `:25` にある。

```ts
export const NOTIFICATION_TITLE_MAX_LENGTH = 100;
export const NOTIFICATION_BODY_MAX_LENGTH = 500;
```

`export` を足すだけで値も型も変えないので、既存のテストは 1 件も落ちない。`src/db/schema/**` は `vitest.config.ts` の `coverage.exclude` と `stryker.config.mjs` の `mutate` の両方で除外されているため、スコアにも影響しない。

Run: `npm test -w @meshimap/api -- schema && npm run typecheck -w @meshimap/api`
Expected: PASS（この時点では何も増減しない）

- [ ] **Step 2: 追加する入力スキーマの失敗するテストを書く**

`apps/api/src/routes/admin/schemas.test.ts` の末尾に追記する。

```ts
describe('genreCreateBodySchema', () => {
  const valid = { name: 'ラーメン', slug: 'ramen', iconKey: 'ramen', sortOrder: 10 };

  it('妥当な本文は通る', () => {
    expect(genreCreateBodySchema.parse(valid)).toEqual(valid);
  });

  it('id を送っても落とされる（採番はサーバの責任）', () => {
    expect(genreCreateBodySchema.parse({ ...valid, id: 'gnr_attack' })).toEqual(valid);
  });

  it('name の上限は DB の CHECK と同じ', () => {
    expect(
      genreCreateBodySchema.safeParse({ ...valid, name: 'あ'.repeat(MASTER_NAME_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      genreCreateBodySchema.safeParse({ ...valid, name: 'あ'.repeat(MASTER_NAME_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('slug に大文字・記号・空文字は入れられない', () => {
    expect(genreCreateBodySchema.safeParse({ ...valid, slug: 'Ramen' }).success).toBe(false);
    expect(genreCreateBodySchema.safeParse({ ...valid, slug: 'ra men' }).success).toBe(false);
    expect(genreCreateBodySchema.safeParse({ ...valid, slug: '' }).success).toBe(false);
  });

  it('slug にハイフンと数字は入れられる', () => {
    expect(genreCreateBodySchema.safeParse({ ...valid, slug: 'ramen-2' }).success).toBe(true);
  });

  it('iconKey は null を明示できる', () => {
    expect(genreCreateBodySchema.parse({ ...valid, iconKey: null }).iconKey).toBeNull();
  });

  it('sortOrder は 0 以上の整数だけ', () => {
    expect(genreCreateBodySchema.safeParse({ ...valid, sortOrder: SORT_ORDER_MIN }).success).toBe(
      true,
    );
    expect(genreCreateBodySchema.safeParse({ ...valid, sortOrder: -1 }).success).toBe(false);
    expect(genreCreateBodySchema.safeParse({ ...valid, sortOrder: 1.5 }).success).toBe(false);
    expect(genreCreateBodySchema.safeParse({ ...valid, sortOrder: '10' }).success).toBe(false);
  });
});

describe('areaCreateBodySchema', () => {
  const valid = { name: '渋谷', parentId: null, prefecture: '東京都' };

  it('妥当な本文は通る', () => {
    expect(areaCreateBodySchema.parse(valid)).toEqual(valid);
  });

  it('parentId のキー省略は弾く（親を意図せず外さないため）', () => {
    expect(areaCreateBodySchema.safeParse({ name: '渋谷', prefecture: '東京都' }).success).toBe(
      false,
    );
  });

  it('prefecture の上限は DB の CHECK と同じ', () => {
    expect(
      areaCreateBodySchema.safeParse({ ...valid, prefecture: 'あ'.repeat(PREFECTURE_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      areaCreateBodySchema.safeParse({
        ...valid,
        prefecture: 'あ'.repeat(PREFECTURE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('announcementBodySchema', () => {
  const valid = {
    title: 'メンテナンスのお知らせ',
    body: '3 月 1 日 0 時から 2 時まで停止します',
    audience: { kind: 'all' },
  };

  it('全員宛は通る', () => {
    expect(announcementBodySchema.parse(valid).audience).toEqual({ kind: 'all' });
  });

  it('ロール宛はロールの語彙を検査する', () => {
    expect(
      announcementBodySchema.parse({ ...valid, audience: { kind: 'role', role: ROLE_OWNER } })
        .audience,
    ).toEqual({ kind: 'role', role: ROLE_OWNER });
    expect(
      announcementBodySchema.safeParse({ ...valid, audience: { kind: 'role', role: 'boss' } })
        .success,
    ).toBe(false);
  });

  it('個別宛は 1 件以上が要る', () => {
    expect(
      announcementBodySchema.safeParse({ ...valid, audience: { kind: 'users', userIds: [] } })
        .success,
    ).toBe(false);
  });

  it('個別宛の人数には上限がある', () => {
    const userIds = Array.from(
      { length: ANNOUNCEMENT_MAX_EXPLICIT_RECIPIENTS + 1 },
      (_unused, index) => `usr_${index}`,
    );

    expect(
      announcementBodySchema.safeParse({ ...valid, audience: { kind: 'users', userIds } }).success,
    ).toBe(false);
  });

  it('知らない kind は弾く', () => {
    expect(
      announcementBodySchema.safeParse({ ...valid, audience: { kind: 'everyone' } }).success,
    ).toBe(false);
  });

  it('title と body の上限は notifications の CHECK と同じ', () => {
    expect(
      announcementBodySchema.safeParse({
        ...valid,
        title: 'あ'.repeat(NOTIFICATION_TITLE_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      announcementBodySchema.safeParse({
        ...valid,
        title: 'あ'.repeat(NOTIFICATION_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      announcementBodySchema.safeParse({
        ...valid,
        body: 'あ'.repeat(NOTIFICATION_BODY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('announcementId は省略でき、指定するなら採番と同じ形だけ通る', () => {
    expect(announcementBodySchema.parse(valid).announcementId).toBeNull();
    expect(
      announcementBodySchema.parse({ ...valid, announcementId: 'ann_0123456789ab' }).announcementId,
    ).toBe('ann_0123456789ab');
    // 長すぎる／接頭辞違い／16 進以外
    expect(
      announcementBodySchema.safeParse({ ...valid, announcementId: 'ann_0123456789abcd' }).success,
    ).toBe(false);
    expect(
      announcementBodySchema.safeParse({ ...valid, announcementId: 'ntf_0123456789ab' }).success,
    ).toBe(false);
    expect(
      announcementBodySchema.safeParse({ ...valid, announcementId: 'ann_0123456789zz' }).success,
    ).toBe(false);
  });

  it('採番した ID は必ず自分のパターンに合う', () => {
    expect(ANNOUNCEMENT_ID_PATTERN.test(createAnnouncementId())).toBe(true);
  });
});

describe('auditLogListQuerySchema', () => {
  it('未指定はすべて null', () => {
    expect(auditLogListQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: null,
      actorId: null,
      action: null,
      targetType: null,
      targetId: null,
    });
  });

  it('語彙にある action と targetType は通る', () => {
    expect(
      auditLogListQuerySchema.parse({
        action: AUDIT_ACTIONS.userSuspend,
        targetType: AUDIT_TARGET_TYPES.user,
      }),
    ).toMatchObject({ action: AUDIT_ACTIONS.userSuspend, targetType: AUDIT_TARGET_TYPES.user });
  });

  it('綴り間違いの action は 0 件ではなく検証エラーにする', () => {
    expect(auditLogListQuerySchema.safeParse({ action: 'user.suspended' }).success).toBe(false);
  });
});
```

import を足す。

```ts
import { SORT_ORDER_MIN } from '../../db/constants';
import { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH } from '../../db/schema/admin';
import { MASTER_NAME_MAX_LENGTH, PREFECTURE_MAX_LENGTH } from '../../db/schema/master';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../../lib/audit-log';
import { createAnnouncementId } from '../../repositories/admin-announcement-repository';
import {
  announcementBodySchema,
  ANNOUNCEMENT_ID_PATTERN,
  ANNOUNCEMENT_MAX_EXPLICIT_RECIPIENTS,
  areaCreateBodySchema,
  auditLogListQuerySchema,
  genreCreateBodySchema,
} from './schemas';
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。`genreCreateBodySchema is not exported by ./schemas` 相当。

- [ ] **Step 4: 入力スキーマを追加する**

`apps/api/src/routes/admin/schemas.ts` の末尾に追記する。

```ts
/**
 * ジャンルの編集可能な列。`id` は含めない。
 * `slug` の文字種は DB の `ck_genres_slug_format` と同じ集合を使い回す
 * （`consistsOf()` は「空でない」も要求するので `.min(1)` を付ける）。
 */
export const genreFieldsSchema = z.object({
  name: z.string().min(1).max(MASTER_NAME_MAX_LENGTH),
  slug: z
    .string()
    .min(1)
    .regex(new RegExp(`^[${SLUG_ALLOWED_CHARACTERS}]+$`)),
  iconKey: z.string().min(1).max(IDENTIFIER_MAX_LENGTH).nullable(),
  sortOrder: z.number().int().min(SORT_ORDER_MIN),
});

/** 作成も編集と同じ列。ID を受け取らないので同一でよい */
export const genreCreateBodySchema = genreFieldsSchema;

/** エリアの編集可能な列。`parentId` はキー必須の nullable */
export const areaFieldsSchema = z.object({
  name: z.string().min(1).max(MASTER_NAME_MAX_LENGTH),
  parentId: z.string().min(1).max(IDENTIFIER_MAX_LENGTH).nullable(),
  prefecture: z.string().min(1).max(PREFECTURE_MAX_LENGTH),
});

export const areaCreateBodySchema = areaFieldsSchema;

/**
 * 明示指定できる宛先の上限。
 * これを超える配信はロール宛か全員宛でやる想定。
 * 上限が無いと、1 リクエストで巨大な配列を送られて Workers の CPU 時間を食い潰せる。
 */
export const ANNOUNCEMENT_MAX_EXPLICIT_RECIPIENTS = 500;

/**
 * お知らせ ID の形。`createAnnouncementId()`（= `ann_` + UUID の 16 進 12 文字）と完全に一致させる。
 *
 * 長い ID を受けてしまうと `buildNotificationId()` が 64 文字を超えて throw し、500 になる。
 * 形を固定しておけば、通知 ID は必ず `ntf_` + 16 + `_` + userId に収まる。
 * 採番結果がこのパターンに合うことは schemas.test.ts で毎回確かめている。
 */
export const ANNOUNCEMENT_ID_PATTERN = /^ann_[0-9a-f]{12}$/;

/** お知らせの宛先 */
const announcementAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('role'), role: z.enum(ROLES) }),
  z.object({
    kind: z.literal('users'),
    userIds: z
      .array(z.string().min(1).max(IDENTIFIER_MAX_LENGTH))
      .min(1)
      .max(ANNOUNCEMENT_MAX_EXPLICIT_RECIPIENTS),
  }),
]);

/**
 * お知らせ配信の本文。
 * `title` / `body` の上限は `notifications` の CHECK をそのまま使う。
 * ここを緩めると DB 側で落ちて batch ごと巻き戻り、原因が 500 としてしか見えない。
 */
export const announcementBodySchema = z
  .object({
    announcementId: z.string().regex(ANNOUNCEMENT_ID_PATTERN).optional(),
    title: z.string().min(1).max(NOTIFICATION_TITLE_MAX_LENGTH),
    body: z.string().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
    audience: announcementAudienceSchema,
  })
  .transform((input) => ({
    announcementId: input.announcementId ?? null,
    title: input.title,
    body: input.body,
    audience: input.audience,
  }));

/** 監査ログ一覧のクエリ。action と targetType は語彙で縛る */
export const auditLogListQuerySchema = z
  .object({
    ...PAGINATION_SHAPE,
    actorId: z.string().min(1).max(IDENTIFIER_MAX_LENGTH).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
    targetId: z.string().min(1).max(IDENTIFIER_MAX_LENGTH).optional(),
  })
  .transform((input) => ({
    ...toPaginationQuery(input),
    actorId: input.actorId ?? null,
    action: input.action ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
  }));
```

`schemas.ts` 先頭の import を足す。

```ts
import { IDENTIFIER_MAX_LENGTH, SORT_ORDER_MIN } from '../../db/constants';
import { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH } from '../../db/schema/admin';
import {
  MASTER_NAME_MAX_LENGTH,
  PREFECTURE_MAX_LENGTH,
  SLUG_ALLOWED_CHARACTERS,
} from '../../db/schema/master';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../../lib/audit-log';
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/schemas && npm run typecheck -w @meshimap/api`
Expected: 両方 PASS（schemas 54 件。Task 9-14 までの 33 件 + このタスクで足した 21 件）

- [ ] **Step 6: わざと壊して、CHECK 制約との連動を確認する**

`apps/api/src/db/schema/admin.ts` の `NOTIFICATION_TITLE_MAX_LENGTH` を `100` から `120` にする。

Run: `npm test -w @meshimap/api -- schemas check-constraints`
Expected: FAIL。`check-constraints.test.ts` の `ck_notifications_title_length` のケースが落ちる。**`schemas.test.ts` は落ちない**（定数を共有しているので上限が一緒に動くため）。これが意図した設計で、数字を 2 箇所に書いていたらここで気づけない。

戻したうえで、今度は `schemas.ts` の `.max(NOTIFICATION_TITLE_MAX_LENGTH)` を `.max(120)` に書き換える。

Run: `npm test -w @meshimap/api -- routes/admin/schemas`
Expected: FAIL。「title と body の上限は notifications の CHECK と同じ」が落ちる。

戻す。

- [ ] **Step 7: マスタのルートの失敗するテストを書く**

`apps/api/src/routes/admin/masters.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { countRows, readRow, type TestUser } from '../../test/fixtures';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

const NEW_GENRE = { name: 'カレー', slug: 'curry', iconKey: null, sortOrder: 20 };
const NEW_AREA = { name: '北区', parentId: null, prefecture: '東京都' };

describe('/admin/genres', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('一覧はページングせず全件返る（マスタは件数が少なく、選択肢として全部要る）', async () => {
    const response = await requestAdmin(admin.world, '/admin/genres', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{ items: readonly { id: string }[] }>();
    expect(body.items.map((item) => item.id)).toContain(admin.ids.genreId);
  });

  it('作成は 201 で、採番された ID が返る', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/genres',
      jsonBody('POST', NEW_GENRE),
      signedIn.cookie,
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ genreId: string }>();
    expect(body.genreId).toMatch(/^gnr_/);
    const row = await readRow(admin.world, 'SELECT name FROM genres WHERE id = ?', body.genreId);
    expect(row?.name).toBe(NEW_GENRE.name);
  });

  it('本文に id を入れても無視され、サーバの採番が使われる', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/genres',
      jsonBody('POST', { ...NEW_GENRE, id: 'gnr_injected' }),
      signedIn.cookie,
    );

    const body = await response.json<{ genreId: string }>();
    expect(body.genreId).not.toBe('gnr_injected');
    expect(
      await countRows(
        admin.world,
        'SELECT COUNT(*) AS count FROM genres WHERE id = ?',
        'gnr_injected',
      ),
    ).toBe(0);
  });

  it('slug が既存とぶつかると 409', async () => {
    await requestAdmin(admin.world, '/admin/genres', jsonBody('POST', NEW_GENRE), signedIn.cookie);
    const second = await requestAdmin(
      admin.world,
      '/admin/genres',
      jsonBody('POST', NEW_GENRE),
      signedIn.cookie,
    );

    expect(second.status).toBe(409);
  });

  it('更新はパスの ID が効き、本文の id は効かない', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/genres/${admin.ids.genreId}`,
      jsonBody('PATCH', { ...NEW_GENRE, id: 'gnr_injected' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    const row = await readRow(
      admin.world,
      'SELECT name FROM genres WHERE id = ?',
      admin.ids.genreId,
    );
    expect(row?.name).toBe(NEW_GENRE.name);
  });

  it('無い ID の更新は 404', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/genres/gnr_missing',
      jsonBody('PATCH', NEW_GENRE),
      signedIn.cookie,
    );

    expect(response.status).toBe(404);
  });

  it('使われているジャンルは削除できず 409。行は残る', async () => {
    const response = await requestAdmin(
      admin.world,
      `/admin/genres/${admin.ids.genreId}`,
      { method: 'DELETE' },
      signedIn.cookie,
    );

    expect(response.status).toBe(409);
    expect(
      await countRows(
        admin.world,
        'SELECT COUNT(*) AS count FROM genres WHERE id = ?',
        admin.ids.genreId,
      ),
    ).toBe(1);
  });

  it('使われていないジャンルは削除できる', async () => {
    const created = await requestAdmin(
      admin.world,
      '/admin/genres',
      jsonBody('POST', NEW_GENRE),
      signedIn.cookie,
    );
    const { genreId } = await created.json<{ genreId: string }>();

    const response = await requestAdmin(
      admin.world,
      `/admin/genres/${genreId}`,
      { method: 'DELETE' },
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    expect(
      await countRows(admin.world, 'SELECT COUNT(*) AS count FROM genres WHERE id = ?', genreId),
    ).toBe(0);
  });

  it('不正な slug は 422 で、行は増えない', async () => {
    const before = await countRows(admin.world, 'SELECT COUNT(*) AS count FROM genres');
    const response = await requestAdmin(
      admin.world,
      '/admin/genres',
      jsonBody('POST', { ...NEW_GENRE, slug: 'Curry Rice' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM genres')).toBe(before);
  });
});

describe('/admin/areas', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('一覧が返る', async () => {
    const response = await requestAdmin(admin.world, '/admin/areas', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{ items: readonly { id: string }[] }>();
    expect(body.items.map((item) => item.id)).toContain(admin.ids.areaId);
  });

  it('作成は 201、更新は 200、削除は 200', async () => {
    const created = await requestAdmin(
      admin.world,
      '/admin/areas',
      jsonBody('POST', NEW_AREA),
      signedIn.cookie,
    );
    expect(created.status).toBe(201);
    const { areaId } = await created.json<{ areaId: string }>();

    const updated = await requestAdmin(
      admin.world,
      `/admin/areas/${areaId}`,
      jsonBody('PATCH', { ...NEW_AREA, name: '赤羽' }),
      signedIn.cookie,
    );
    expect(updated.status).toBe(200);
    expect((await readRow(admin.world, 'SELECT name FROM areas WHERE id = ?', areaId))?.name).toBe(
      '赤羽',
    );

    const deleted = await requestAdmin(
      admin.world,
      `/admin/areas/${areaId}`,
      { method: 'DELETE' },
      signedIn.cookie,
    );
    expect(deleted.status).toBe(200);
  });

  it('parentId を省いた本文は 422', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/areas',
      jsonBody('POST', { name: '北区', prefecture: '東京都' }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
  });
});
```

- [ ] **Step 8: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/masters`
Expected: FAIL。`Failed to resolve import "./masters"`。

- [ ] **Step 9: マスタのルートを実装する**

`apps/api/src/routes/admin/masters.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { createPrefixedId, ID_PREFIXES } from '../../lib/identifier';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  createArea,
  createGenre,
  deleteArea,
  deleteGenre,
  listAreas,
  listGenres,
  updateArea,
  updateGenre,
} from '../../repositories/admin-master-repository';
import { assertWriteSucceeded, parseOrThrow, readJsonBody } from './respond';
import { areaFieldsSchema, genreFieldsSchema } from './schemas';

/** 作成時の HTTP ステータス。201 を数字の直書きにしない */
const STATUS_CREATED = 201;

export const genreRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const items = await listGenres(createDatabase(c.env.DB), actor);

    // 一覧の形を他のエンドポイントとそろえる。マスタは件数が少ないのでカーソルは持たない
    return c.json({ items });
  })
  .post('/', async (c) => {
    const actor = requireAdminActor(c);
    const fields = parseOrThrow(genreFieldsSchema, await readJsonBody(c.req.raw));
    // ID はサーバが振る。クライアントに決めさせると既存 ID の存在を探れる
    const genreId = createPrefixedId(ID_PREFIXES.genre);
    const outcome = await createGenre(createDatabase(c.env.DB), actor, { ...fields, id: genreId });
    assertWriteSucceeded(outcome);

    return c.json({ genreId, result: outcome }, STATUS_CREATED);
  })
  .patch('/:genreId', async (c) => {
    const actor = requireAdminActor(c);
    const genreId = c.req.param('genreId');
    const fields = parseOrThrow(genreFieldsSchema, await readJsonBody(c.req.raw));
    const outcome = await updateGenre(createDatabase(c.env.DB), actor, genreId, {
      ...fields,
      id: genreId,
    });
    assertWriteSucceeded(outcome);

    return c.json({ genreId, result: outcome });
  })
  .delete('/:genreId', async (c) => {
    const actor = requireAdminActor(c);
    const genreId = c.req.param('genreId');
    const outcome = await deleteGenre(createDatabase(c.env.DB), actor, genreId);
    assertWriteSucceeded(outcome);

    return c.json({ genreId, result: outcome });
  });

export const areaRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const items = await listAreas(createDatabase(c.env.DB), actor);

    return c.json({ items });
  })
  .post('/', async (c) => {
    const actor = requireAdminActor(c);
    const fields = parseOrThrow(areaFieldsSchema, await readJsonBody(c.req.raw));
    const areaId = createPrefixedId(ID_PREFIXES.area);
    const outcome = await createArea(createDatabase(c.env.DB), actor, { ...fields, id: areaId });
    assertWriteSucceeded(outcome);

    return c.json({ areaId, result: outcome }, STATUS_CREATED);
  })
  .patch('/:areaId', async (c) => {
    const actor = requireAdminActor(c);
    const areaId = c.req.param('areaId');
    const fields = parseOrThrow(areaFieldsSchema, await readJsonBody(c.req.raw));
    const outcome = await updateArea(createDatabase(c.env.DB), actor, areaId, {
      ...fields,
      id: areaId,
    });
    assertWriteSucceeded(outcome);

    return c.json({ areaId, result: outcome });
  })
  .delete('/:areaId', async (c) => {
    const actor = requireAdminActor(c);
    const areaId = c.req.param('areaId');
    const outcome = await deleteArea(createDatabase(c.env.DB), actor, areaId);
    assertWriteSucceeded(outcome);

    return c.json({ areaId, result: outcome });
  });
```

`apps/api/src/routes/admin/index.ts` に 2 行足す。

```ts
adminRoutes.route('/genres', genreRoutes);
adminRoutes.route('/areas', areaRoutes);
```

- [ ] **Step 10: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/masters`
Expected: PASS（12 件）

- [ ] **Step 11: お知らせと監査ログの失敗するテストを書く**

`apps/api/src/routes/admin/announcements.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPE_ANNOUNCEMENT, ROLE_OWNER } from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { countRows, type TestUser } from '../../test/fixtures';
import { jsonBody, requestAdmin, signInAsAdmin } from './route-harness.test';

const ANNOUNCEMENT = {
  title: 'メンテナンスのお知らせ',
  body: '3 月 1 日 0 時から 2 時まで停止します',
};

describe('/admin/announcements', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('全員宛に配信すると、有効なユーザー全員に通知が入る', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', { ...ANNOUNCEMENT, audience: { kind: 'all' } }),
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ announcementId: string; recipientCount: number }>();
    expect(body.announcementId).toMatch(/^ann_/);
    // シードの 3 人 + サインアップした管理者
    expect(body.recipientCount).toBe(4);
    expect(
      await countRows(
        admin.world,
        'SELECT COUNT(*) AS count FROM notifications WHERE type = ?',
        NOTIFICATION_TYPE_ANNOUNCEMENT,
      ),
    ).toBe(4);
  });

  it('ロール宛は該当ロールだけに届く', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', { ...ANNOUNCEMENT, audience: { kind: 'role', role: ROLE_OWNER } }),
      signedIn.cookie,
    );

    expect((await response.json<{ recipientCount: number }>()).recipientCount).toBe(1);
  });

  it('個別宛は指定した人だけに届く', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', {
        ...ANNOUNCEMENT,
        audience: { kind: 'users', userIds: [admin.ids.normalUserId] },
      }),
      signedIn.cookie,
    );

    expect((await response.json<{ recipientCount: number }>()).recipientCount).toBe(1);
  });

  it('宛先が 1 人もいなければ 422 で、通知は 1 件も入らない', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', {
        ...ANNOUNCEMENT,
        audience: { kind: 'users', userIds: ['usr_missing'] },
      }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('同じ announcementId で二重に送ると 409 になり、通知は増えない', async () => {
    const announcementId = 'ann_0123456789ab';
    const payload = jsonBody('POST', {
      ...ANNOUNCEMENT,
      announcementId,
      audience: { kind: 'all' },
    });
    const first = await requestAdmin(admin.world, '/admin/announcements', payload, signedIn.cookie);
    const countAfterFirst = await countRows(
      admin.world,
      'SELECT COUNT(*) AS count FROM notifications',
    );
    const second = await requestAdmin(
      admin.world,
      '/admin/announcements',
      payload,
      signedIn.cookie,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(
      countAfterFirst,
    );
  });

  it('形の違う announcementId は 422（通知 ID が 64 文字を超えて 500 になるのを防ぐ）', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', {
        ...ANNOUNCEMENT,
        announcementId: `ann_${'a'.repeat(60)}`,
        audience: { kind: 'all' },
      }),
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
  });

  it('配信履歴が新しい順に返る', async () => {
    await requestAdmin(
      admin.world,
      '/admin/announcements',
      jsonBody('POST', { ...ANNOUNCEMENT, audience: { kind: 'all' } }),
      signedIn.cookie,
    );
    const response = await requestAdmin(admin.world, '/admin/announcements', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    const body = await response.json<{
      items: readonly { title: string; recipientCount: number }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe(ANNOUNCEMENT.title);
    expect(body.items[0]?.recipientCount).toBe(4);
  });
});
```

`apps/api/src/routes/admin/audit-logs.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_STATUS_ACTIVE, PROFILE_STATUS_SUSPENDED } from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '../../lib/audit-log';
import { readRow, type TestUser } from '../../test/fixtures';
import { requestAdmin, signInAsAdmin } from './route-harness.test';

/** 取り消せる操作を 1 つ起こして、その監査ログの ID を返す */
async function suspendAndReadAuditLogId(admin: AdminWorld, cookie: string): Promise<string> {
  const response = await requestAdmin(
    admin.world,
    `/admin/users/${admin.ids.normalUserId}/suspend`,
    { method: 'POST' },
    cookie,
  );
  expect(response.status).toBe(200);
  const row = await readRow(
    admin.world,
    'SELECT id FROM audit_logs WHERE action = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    AUDIT_ACTIONS.userSuspend,
  );
  return String(row?.id);
}

describe('/admin/audit-logs', () => {
  let admin: AdminWorld;
  let signedIn: TestUser;

  beforeEach(async () => {
    admin = await createAdminWorld();
    signedIn = await signInAsAdmin(admin.world);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it('何も操作していなければ空', async () => {
    const response = await requestAdmin(admin.world, '/admin/audit-logs', {}, signedIn.cookie);

    expect(response.status).toBe(200);
    expect((await response.json<{ items: readonly unknown[] }>()).items).toEqual([]);
  });

  it('操作すると 1 件記録され、actor と target が引ける', async () => {
    await suspendAndReadAuditLogId(admin, signedIn.cookie);
    const response = await requestAdmin(
      admin.world,
      `/admin/audit-logs?action=${encodeURIComponent(AUDIT_ACTIONS.userSuspend)}&targetType=${AUDIT_TARGET_TYPES.user}`,
      {},
      signedIn.cookie,
    );

    const body = await response.json<{
      items: readonly { actorId: string; targetId: string; undoable: boolean }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.actorId).toBe(signedIn.userId);
    expect(body.items[0]?.targetId).toBe(admin.ids.normalUserId);
    expect(body.items[0]?.undoable).toBe(true);
  });

  it('綴り間違いの action は 422（0 件と区別する）', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/audit-logs?action=user.suspended',
      {},
      signedIn.cookie,
    );

    expect(response.status).toBe(422);
  });

  it('取り消すと状態が戻り、取り消したこと自体も記録される', async () => {
    const auditLogId = await suspendAndReadAuditLogId(admin, signedIn.cookie);
    const response = await requestAdmin(
      admin.world,
      `/admin/audit-logs/${auditLogId}/undo`,
      { method: 'POST' },
      signedIn.cookie,
    );

    expect(response.status).toBe(200);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT status FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.status,
    ).toBe(PROFILE_STATUS_ACTIVE);
    const undoLog = await readRow(
      admin.world,
      'SELECT target_id FROM audit_logs WHERE action = ?',
      AUDIT_ACTIONS.auditUndo,
    );
    expect(undoLog?.target_id).toBe(auditLogId);
  });

  it('同じ監査ログを二度取り消すと 409 で、状態は戻ったまま', async () => {
    const auditLogId = await suspendAndReadAuditLogId(admin, signedIn.cookie);
    const path = `/admin/audit-logs/${auditLogId}/undo`;
    await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);
    const second = await requestAdmin(admin.world, path, { method: 'POST' }, signedIn.cookie);

    expect(second.status).toBe(409);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT status FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.status,
    ).toBe(PROFILE_STATUS_ACTIVE);
  });

  it('無い監査ログの取り消しは 404', async () => {
    const response = await requestAdmin(
      admin.world,
      '/admin/audit-logs/aud_missing/undo',
      { method: 'POST' },
      signedIn.cookie,
    );

    expect(response.status).toBe(404);
  });

  it('取り消し対象外の操作は 409（停止のままであることも確かめる）', async () => {
    await requestAdmin(
      admin.world,
      `/admin/users/${admin.ids.normalUserId}/suspend`,
      { method: 'POST' },
      signedIn.cookie,
    );
    await requestAdmin(
      admin.world,
      '/admin/announcements',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'お知らせ', body: '本文', audience: { kind: 'all' } }),
      },
      signedIn.cookie,
    );
    const sendLog = await readRow(
      admin.world,
      'SELECT id FROM audit_logs WHERE action = ?',
      AUDIT_ACTIONS.announcementSend,
    );

    const response = await requestAdmin(
      admin.world,
      `/admin/audit-logs/${String(sendLog?.id)}/undo`,
      { method: 'POST' },
      signedIn.cookie,
    );

    expect(response.status).toBe(409);
    expect(
      (
        await readRow(
          admin.world,
          'SELECT status FROM profiles WHERE user_id = ?',
          admin.ids.normalUserId,
        )
      )?.status,
    ).toBe(PROFILE_STATUS_SUSPENDED);
  });
});
```

- [ ] **Step 12: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- routes/admin/announcements routes/admin/audit-logs`
Expected: FAIL。`Failed to resolve import "./announcements"`。

- [ ] **Step 13: お知らせと監査ログのルートを実装する**

`apps/api/src/routes/admin/announcements.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { conflict, invalidInput } from '../../lib/http-error';
import { requireAdminActor } from '../../middleware/role-guard';
import {
  ANNOUNCEMENT_OUTCOME,
  createAnnouncementId,
  listAnnouncementHistory,
  sendAnnouncement,
} from '../../repositories/admin-announcement-repository';
import type { AnnouncementOutcome } from '../../repositories/admin-announcement-repository';
import { parseOrThrow, readJsonBody, toPageParams } from './respond';
import { announcementBodySchema, paginationQuerySchema } from './schemas';

/**
 * 配信結果を HTTP に写す。
 *
 * `assertWriteSucceeded` と同じ理由で戻り値は void にしてあり、網羅は
 * announcements.test.ts の 3 ケース（200 / 409 / 422）が守っている。
 * `AnnouncementOutcome` に値を足したらテストも足すこと。
 */
function assertAnnouncementSucceeded(outcome: AnnouncementOutcome): void {
  switch (outcome) {
    case ANNOUNCEMENT_OUTCOME.ok:
      return;
    case ANNOUNCEMENT_OUTCOME.alreadySent:
      // 同じお知らせ ID はすでに配り終えている。再送ではなく重複なので 409
      throw conflict();
    case ANNOUNCEMENT_OUTCOME.noRecipients:
      // 宛先の指定が誰にも当たらない。対象不在ではなく入力の問題なので 422
      throw invalidInput();
  }
}

export const announcementRoutes = new Hono<AppEnv>()
  .post('/', async (c) => {
    const actor = requireAdminActor(c);
    const body = parseOrThrow(announcementBodySchema, await readJsonBody(c.req.raw));
    // やり直し用に同じ ID を指定できる。省略時はサーバが振る
    const announcementId = body.announcementId ?? createAnnouncementId();
    const outcome = await sendAnnouncement(createDatabase(c.env.DB), actor, {
      announcementId,
      title: body.title,
      body: body.body,
      audience: body.audience,
    });
    assertAnnouncementSucceeded(outcome);

    // 実際に届いた人数は履歴から引かず、この場で数え直さない。
    // sendAnnouncement が監査ログに書いた件数を履歴経由で返す
    const history = await listAnnouncementHistory(createDatabase(c.env.DB), actor, {
      cursor: null,
      limit: 1,
    });
    const latest = history.items[0];

    return c.json({
      announcementId,
      result: outcome,
      recipientCount: latest?.recipientCount ?? 0,
    });
  })
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(paginationQuerySchema, c.req.query());
    const page = await listAnnouncementHistory(
      createDatabase(c.env.DB),
      actor,
      toPageParams(query),
    );

    return c.json(page);
  });
```

`apps/api/src/routes/admin/audit-logs.ts`

```ts
import { Hono } from 'hono';
import { createDatabase } from '../../db/client';
import type { AppEnv } from '../../lib/app-env';
import { requireAdminActor } from '../../middleware/role-guard';
import { listAuditLogs, undoAuditLog } from '../../repositories/admin-audit-repository';
import { assertWriteSucceeded, parseOrThrow, toPageParams } from './respond';
import { auditLogListQuerySchema } from './schemas';

export const auditLogRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const actor = requireAdminActor(c);
    const query = parseOrThrow(auditLogListQuerySchema, c.req.query());
    const page = await listAuditLogs(createDatabase(c.env.DB), actor, {
      ...toPageParams(query),
      actorId: query.actorId,
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
    });

    return c.json(page);
  })
  .post('/:auditLogId/undo', async (c) => {
    const actor = requireAdminActor(c);
    const outcome = await undoAuditLog(createDatabase(c.env.DB), actor, c.req.param('auditLogId'));
    assertWriteSucceeded(outcome);

    return c.json({ result: outcome });
  });
```

`apps/api/src/routes/admin/index.ts` の最終形。

```ts
import { Hono } from 'hono';
import { ROLE_ADMIN } from '../../db/constants';
import type { AppEnv } from '../../lib/app-env';
import { roleGuard } from '../../middleware/role-guard';
import { announcementRoutes } from './announcements';
import { applicationRoutes } from './applications';
import { auditLogRoutes } from './audit-logs';
import { areaRoutes, genreRoutes } from './masters';
import { reportRoutes } from './reports';
import { shopRoutes } from './shops';
import { statsRoutes } from './stats';
import { userRoutes } from './users';

/**
 * `/admin` 配下の集約。
 *
 * **門番はここ 1 箇所だけ**に置く。個々のルートファイルで roleGuard を呼ばないこと。
 * 付け忘れが無いことは Task 9-16 の権限行列 128 ケースが機械的に保証する。
 *
 * use('*') は route() より **先に** 登録すること（H-4 の実測どおり）。
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', roleGuard(ROLE_ADMIN));
adminRoutes.route('/stats', statsRoutes);
adminRoutes.route('/applications', applicationRoutes);
adminRoutes.route('/reports', reportRoutes);
adminRoutes.route('/users', userRoutes);
adminRoutes.route('/shops', shopRoutes);
adminRoutes.route('/genres', genreRoutes);
adminRoutes.route('/areas', areaRoutes);
adminRoutes.route('/announcements', announcementRoutes);
adminRoutes.route('/audit-logs', auditLogRoutes);
```

- [ ] **Step 14: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- routes/admin && npm run typecheck -w @meshimap/api`
Expected: PASS

- [ ] **Step 15: わざと壊して、3 つの分岐が守られていることを確認する**

1. `assertAnnouncementSucceeded` の `case ANNOUNCEMENT_OUTCOME.noRecipients:` を `throw conflict();` に変える → 「宛先が 1 人もいなければ 422」が `expected 409 to be 422` で落ちる。
2. `announcements.ts` の `body.announcementId ?? createAnnouncementId()` を `createAnnouncementId()` だけにする → 「同じ announcementId で二重に送ると 409」が `expected 200 to be 409` で落ちる。
3. `masters.ts` の `createPrefixedId(ID_PREFIXES.genre)` を `createPrefixedId(ID_PREFIXES.area)` に変える → 「作成は 201 で、採番された ID が返る」が `gnr_` の正規表現で落ちる。
4. `audit-logs.ts` の `action: query.action` を `action: null` に変える → 「操作すると 1 件記録され、actor と target が引ける」は**落ちない**（この世界には他の監査ログが無いため）。絞り込みの取りこぼしを見つけるには 2 種類の action を作る必要がある。**このテストを 1 件足してから次へ進むこと**:

```ts
it('action で絞り込むと、別の action は混ざらない', async () => {
  await suspendAndReadAuditLogId(admin, signedIn.cookie);
  await requestAdmin(
    admin.world,
    `/admin/users/${admin.ids.normalUserId}/restore`,
    { method: 'POST' },
    signedIn.cookie,
  );

  const response = await requestAdmin(
    admin.world,
    `/admin/audit-logs?action=${encodeURIComponent(AUDIT_ACTIONS.userRestore)}`,
    {},
    signedIn.cookie,
  );

  const body = await response.json<{ items: readonly { action: string }[] }>();
  expect(body.items.map((item) => item.action)).toEqual([AUDIT_ACTIONS.userRestore]);
});
```

足したうえで 4 をもう一度壊すと、今度は落ちる。4 つとも確認したら戻す。

```bash
git diff --stat
```

Expected: 追加したテスト 1 件以外に差分が無いこと。

- [ ] **Step 16: コミットする**

```bash
cd /Users/hattori/Downloads/alee
npm test -w @meshimap/api && npm run typecheck -w @meshimap/api && npm run lint
git add apps/api/src/routes/admin apps/api/src/db/schema/master.ts apps/api/src/db/schema/admin.ts
git commit -m "feat(api): マスタ・お知らせ・監査ログの管理ルートを追加"
```

---

### Task 9-16: 権限行列 128 ケースと、登録パス集合の照合

Phase 9 の 2 本目の機械的な歯止め。**「管理 API に user / owner のトークンが絶対に届かない」を全エンドポイントについて実測で示す**のがこのタスクの目的。Phase 4 の Task 4-12 が `/shops` などで作った権限行列を、`/admin` 配下 32 本へ拡張する。

**表を手で書く以上、表そのものが古びる**のが最大の弱点なので、`Hono` が実際に登録したパスの集合と表のパスの集合が一致することを同じテストで確かめる。ルートを足して表に書き忘れると落ち、表に書いたルートを消し忘れても落ちる。

**Files:**

- Create: `apps/api/src/routes/admin/permission-matrix.test.ts`

**Interfaces:**

- Consumes: Task 9-13 の `createAdminTestApp` / `requestAdmin` / `jsonBody`、Task 9-15 までの `adminRoutes`、Task 9-3 の `createAdminWorld` / `AdminWorld`、Phase 4 の `signUpAs` / `readRow` / `countRows`
- Produces: なし（テストのみ）

**このテストが主張すること:**

| 視点      | 期待                          | なぜ                                                                                    |
| --------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| anonymous | すべて 401                    | 未ログインは「権限が無い」ではなく「誰か分からない」                                    |
| user      | すべて 403                    | ロールだけで決まる拒否。対象の有無を漏らさないため 404 にしない                         |
| owner     | すべて 403                    | 同上。オーナーでも管理 API には一切触れない                                             |
| admin     | 表どおりの成功系（200 / 201） | 正しく叩けば通ることも同時に示す。403 しか見ないと「全部 403 にすれば通るテスト」になる |

さらに **user / owner / anonymous の 96 ケースを流したあと `audit_logs` が 0 行であること**を確かめる。403 を返しつつ裏で書き込んでいた場合、ステータスだけ見ていては気づけない。

- [ ] **Step 1: 表と照合だけを書いて、失敗することを確認する**

`apps/api/src/routes/admin/permission-matrix.test.ts`

```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../lib/app-env';
import { adminRoutes } from './index';

/** 権限行列の 1 行。`pattern` は Hono に登録されるパスと 1 文字も違ってはいけない */
type AdminEndpoint = {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly pattern: string;
  /** 管理者が正しいリクエストを投げたときのステータス */
  readonly adminStatus: number;
};

const STATUS_OK = 200;
const STATUS_CREATED = 201;

/**
 * 設計書 5.1 の 13 画面が必要とする 32 エンドポイント。
 * 計画書「管理 API のエンドポイント一覧と期待ステータス」の表をそのまま写したもの。
 */
const ADMIN_ENDPOINTS: readonly AdminEndpoint[] = [
  { method: 'GET', pattern: '/admin/stats/overview', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/applications', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/applications/:applicationId', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/applications/:applicationId/approve', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/applications/:applicationId/return', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/applications/:applicationId/reject', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/reports', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/reports/:reportId', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/reports/:reportId/resolve', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/reports/:reportId/reject', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/users', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/users/:userId', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/users/:userId/suspend', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/users/:userId/restore', adminStatus: STATUS_OK },
  { method: 'PATCH', pattern: '/admin/users/:userId/role', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/shops', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/shops/:shopId', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/shops/:shopId/suspend', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/shops/:shopId/restore', adminStatus: STATUS_OK },
  { method: 'PATCH', pattern: '/admin/shops/:shopId/owner', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/genres', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/genres', adminStatus: STATUS_CREATED },
  { method: 'PATCH', pattern: '/admin/genres/:genreId', adminStatus: STATUS_OK },
  { method: 'DELETE', pattern: '/admin/genres/:genreId', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/areas', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/areas', adminStatus: STATUS_CREATED },
  { method: 'PATCH', pattern: '/admin/areas/:areaId', adminStatus: STATUS_OK },
  { method: 'DELETE', pattern: '/admin/areas/:areaId', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/announcements', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/announcements', adminStatus: STATUS_OK },
  { method: 'GET', pattern: '/admin/audit-logs', adminStatus: STATUS_OK },
  { method: 'POST', pattern: '/admin/audit-logs/:auditLogId/undo', adminStatus: STATUS_OK },
];

/** `GET /admin/users` のような 1 本を表す文字列。集合の比較に使う */
function toKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Hono が実際に登録したルートを取り出す。
 *
 * `use('*', ...)` は `{ method: 'ALL', path: '/admin/*' }` として現れる（このフェーズの H-3 で実測）。
 * 門番はエンドポイントではないので取り除く。
 */
function collectRegisteredKeys(): readonly string[] {
  const app = new Hono<AppEnv>().route('/admin', adminRoutes);
  return app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => toKey(route.method, route.path));
}

describe('管理 API の登録パス集合', () => {
  it('表に 32 本ある', () => {
    expect(ADMIN_ENDPOINTS).toHaveLength(32);
  });

  it('表と Hono の登録内容が完全に一致する', () => {
    const expected = [...new Set(ADMIN_ENDPOINTS.map((e) => toKey(e.method, e.pattern)))].sort();
    const actual = [...new Set(collectRegisteredKeys())].sort();

    // ルートを足して表に書き忘れたら actual 側に余り、
    // 表にあるのに実装していなければ expected 側に余る
    expect(actual).toEqual(expected);
  });

  it('門番は /admin/* に 1 つだけ掛かっている', () => {
    const app = new Hono<AppEnv>().route('/admin', adminRoutes);
    const guards = app.routes.filter((route) => route.method === 'ALL');

    expect(guards.map((route) => route.path)).toEqual(['/admin/*']);
  });
});
```

Run: `npm test -w @meshimap/api -- permission-matrix`
Expected: PASS（Task 9-15 まで終わっていれば一致する）。**ここで落ちたら、落ちた側を直してから次へ進むこと。**表と実装のずれを抱えたまま権限テストを書いても意味がない。

- [ ] **Step 2: わざと壊して、集合の照合が効いていることを確認する**

`apps/api/src/routes/admin/index.ts` から `adminRoutes.route('/areas', areaRoutes);` を消す。

Run: `npm test -w @meshimap/api -- permission-matrix`
Expected: FAIL。「表と Hono の登録内容が完全に一致する」で `/admin/areas` 系 4 本が expected 側に残る差分が出る。

戻したうえで、今度は `stats.ts` の `get('/overview', ...)` を `get('/summary', ...)` に変える。

Run: `npm test -w @meshimap/api -- permission-matrix`
Expected: FAIL。`GET /admin/stats/summary` が actual 側に、`GET /admin/stats/overview` が expected 側に出る。

戻す。

- [ ] **Step 3: 非管理者 96 ケースの失敗するテストを書く**

同じファイルに追記する。

```ts
import { afterEach, beforeEach } from 'vitest';
import { ROLE_OWNER, ROLE_USER } from '../../db/constants';
import { createAdminWorld, type AdminWorld } from '../../db/testing/admin-world';
import { countRows, signUpAs, type TestUser } from '../../test/fixtures';
import { requestAdmin } from './route-harness.test';

const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;

/** パスパラメータを実在しない ID で埋める。門番は対象を見る前に落とすので中身は何でもよい */
function toSamplePath(pattern: string): string {
  return pattern
    .replaceAll(':applicationId', 'app_sample')
    .replaceAll(':reportId', 'rep_sample')
    .replaceAll(':userId', 'usr_sample')
    .replaceAll(':shopId', 'shp_sample')
    .replaceAll(':genreId', 'gnr_sample')
    .replaceAll(':areaId', 'are_sample')
    .replaceAll(':auditLogId', 'aud_sample');
}

describe('管理 API の権限行列（非管理者）', () => {
  let admin: AdminWorld;
  let user: TestUser;
  let owner: TestUser;

  // 96 ケースは 1 つの世界を共有する。どれも書き込みに到達しないはずなので、
  // 最後に audit_logs が 0 行であることをまとめて確かめられる
  beforeEach(async () => {
    admin = await createAdminWorld();
    user = await signUpAs(admin.world, 'user@example.test', ROLE_USER);
    owner = await signUpAs(admin.world, 'owner@example.test', ROLE_OWNER);
  });

  afterEach(async () => {
    await admin.dispose();
  });

  it.each(ADMIN_ENDPOINTS)('$method $pattern は未ログインだと 401', async ({ method, pattern }) => {
    const response = await requestAdmin(admin.world, toSamplePath(pattern), { method });

    expect(response.status).toBe(STATUS_UNAUTHORIZED);
  });

  it.each(ADMIN_ENDPOINTS)('$method $pattern は利用者だと 403', async ({ method, pattern }) => {
    const response = await requestAdmin(
      admin.world,
      toSamplePath(pattern),
      { method },
      user.cookie,
    );

    expect(response.status).toBe(STATUS_FORBIDDEN);
  });

  it.each(ADMIN_ENDPOINTS)('$method $pattern は店舗管理者だと 403', async ({ method, pattern }) => {
    const response = await requestAdmin(
      admin.world,
      toSamplePath(pattern),
      { method },
      owner.cookie,
    );

    expect(response.status).toBe(STATUS_FORBIDDEN);
  });

  it('非管理者のリクエストを全部流しても監査ログは 1 行も増えない', async () => {
    for (const endpoint of ADMIN_ENDPOINTS) {
      const path = toSamplePath(endpoint.pattern);
      await requestAdmin(admin.world, path, { method: endpoint.method });
      await requestAdmin(admin.world, path, { method: endpoint.method }, user.cookie);
      await requestAdmin(admin.world, path, { method: endpoint.method }, owner.cookie);
    }

    expect(await countRows(admin.world, 'SELECT COUNT(*) AS count FROM audit_logs')).toBe(0);
  });

  it('403 の本文は対象の有無を漏らさない', async () => {
    // 実在する店舗 ID と、実在しない店舗 ID で応答が 1 バイトも変わらないこと
    const existing = await requestAdmin(
      admin.world,
      `/admin/shops/${admin.ids.shopId}`,
      {},
      user.cookie,
    );
    const missing = await requestAdmin(admin.world, '/admin/shops/shp_nope', {}, user.cookie);

    expect(existing.status).toBe(missing.status);
    expect(await existing.text()).toBe(await missing.text());
  });
});
```

`it.each` にオブジェクトの配列を渡すと `$method` / `$pattern` がテスト名に展開される。どのエンドポイントで落ちたかが名前から分かる。

- [ ] **Step 4: テストを実行する**

Run: `npm test -w @meshimap/api -- permission-matrix`
Expected: PASS（**3 + 96 + 2 = 101 件**）。内訳は Step 1 の `describe('管理 API の登録パス集合')` が 3 件、Step 3 の `it.each(ADMIN_ENDPOINTS)` 3 本 × 32 行 = 96 件、同じ `describe` の単発 2 件（「監査ログは 1 行も増えない」「403 の本文は対象の有無を漏らさない」）。

ここで落ちるなら、落ちたエンドポイントが `adminRoutes` の外に生えている（`use('*')` の内側にいない）。ルートファイル側で `roleGuard` を呼んで直さないこと。`index.ts` の mount を直す。

- [ ] **Step 5: わざと壊して、門番の一括適用が守られていることを確認する**

**先に、この壊し方で何が落ちて何が落ちないかを正しく理解しておくこと。** 32 本のハンドラはすべて先頭で `requireAdminActor(c)` を呼んでいる。`apps/api/src/middleware/role-guard.ts:39` のコメントが言うとおり「`roleGuard` を付け忘れても同じ 403 を投げる」二重の防御になっているので、**門番を外しても 96 ケースのステータスは 401 / 403 のまま変わらない。** ステータスだけを見るテストでは門番の有無を判別できない。判別できるのは Step 1 の**静的な検査**のほうである。

`apps/api/src/routes/admin/index.ts` の `adminRoutes.use('*', roleGuard(ROLE_ADMIN));` を `adminRoutes.use('/users/*', roleGuard(ROLE_ADMIN));` に変える。

Run: `npm test -w @meshimap/api -- routes/admin/permission-matrix`
Expected: FAIL 1 本。落ちるのは Step 1 の**「門番は /admin/\* に 1 つだけ掛かっている」**で、`['/admin/users/*']` と `['/admin/*']` の差分が出る（`use('/users/*', …)` は `{ method: 'ALL', path: '/admin/users/*' }` として登録されることを実測済み）。

**96 ケースの 401 / 403 は 1 件も落ちない。** これは穴ではなく、二重防御が効いていることの裏返しである。「27 本が 403 にならずに落ちるはず」と考えて落ちなかった場合に、テストが壊れていると誤診しないこと。**門番が `/admin` 全体に 1 つだけ掛かっていることを機械的に保証しているのは、この静的検査ただ 1 本である。**

戻したうえで、次に `adminRoutes.use(...)` の行を `adminRoutes.route('/stats', statsRoutes);` の後ろへ移す。

Run: `npm test -w @meshimap/api -- routes/admin/permission-matrix`
Expected: FAIL または PASS。H-4 の実測では「先に登録すれば走る」ことしか確かめていない。**後ろに置いたときの挙動は未確認**なので、ここで実測して結果を計画書ではなくコード内コメントに残すこと。なおこの壊し方でも登録パスは `/admin/*` のままなので Step 1 の静的検査は通る。落ちるとすれば 96 ケース側だが、上と同じ理由で**二重防御のせいで落ちない可能性が高い**。PASS した場合でも `use` は先頭に戻すこと（Hono の内部順序に依存した書き方を残さない）。

最後に、門番そのものを消す壊し方も試す。`adminRoutes.use('*', roleGuard(ROLE_ADMIN));` の行を丸ごと消す。

Run: `npm test -w @meshimap/api -- routes/admin/permission-matrix`
Expected: FAIL 1 本。「門番は /admin/\* に 1 つだけ掛かっている」が `[]` と `['/admin/*']` の差分で落ちる。**ここでも 96 ケースは落ちない。** Task 9-13 Step 17 の 3 で「ハーネスだけでは検出できないかもしれない」と書いた穴が、**ステータスではなく登録パスの集合を見ることで**塞がっていることの確認。

3 つとも戻す。

- [ ] **Step 6: 管理者 32 ケースの失敗するテストを書く**

管理者の成功系は**前準備が要るものがある**（復帰は停止済みであること、削除は使われていないこと、取り消しは取り消せる監査ログがあること）。ケースごとに世界を作り直す。

同じファイルに追記する。

```ts
import { REPORT_DECISIONS } from '../../repositories/admin-report-repository';
import { jsonBody, signInAsAdmin } from './route-harness.test';

/** 管理者として実際に投げるリクエスト */
type RequestPlan = {
  readonly path: string;
  readonly body?: unknown;
};

/** 成功系を成立させるための前準備と、実際に叩くパスを作る */
type AdminSuccessCase = AdminEndpoint & {
  readonly prepare: (world: AdminWorld, cookie: string) => Promise<RequestPlan>;
};

const NEW_GENRE = { name: 'カレー', slug: 'curry', iconKey: null, sortOrder: 20 };
const NEW_AREA = { name: '北区', parentId: null, prefecture: '東京都' };
const ANNOUNCEMENT = { title: 'お知らせ', body: '本文', audience: { kind: 'all' } };

/** 前準備の要らないケース用 */
function plainPath(path: string, body?: unknown): (world: AdminWorld) => Promise<RequestPlan> {
  return async () => (body === undefined ? { path } : { path, body });
}

/** 直前に書かれた監査ログの ID を読む */
async function readLatestAuditLogId(world: AdminWorld, action: string): Promise<string> {
  const row = await readRow(
    world.world,
    'SELECT id FROM audit_logs WHERE action = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    action,
  );
  if (row === null) {
    throw new Error(`監査ログが見つからない: ${action}`);
  }
  return String(row.id);
}

const ADMIN_SUCCESS_CASES: readonly AdminSuccessCase[] = ADMIN_ENDPOINTS.map((endpoint) => {
  const { method, pattern } = endpoint;
  const key = toKey(method, pattern);

  const prepare: AdminSuccessCase['prepare'] = async (world, cookie) => {
    const { ids } = world;
    switch (key) {
      case 'GET /admin/stats/overview':
      case 'GET /admin/applications':
      case 'GET /admin/reports':
      case 'GET /admin/users':
      case 'GET /admin/shops':
      case 'GET /admin/genres':
      case 'GET /admin/areas':
      case 'GET /admin/announcements':
      case 'GET /admin/audit-logs':
        return { path: pattern };

      case 'GET /admin/applications/:applicationId':
        return { path: `/admin/applications/${ids.applicationId}` };
      case 'POST /admin/applications/:applicationId/approve':
        return { path: `/admin/applications/${ids.applicationId}/approve` };
      case 'POST /admin/applications/:applicationId/return':
        return {
          path: `/admin/applications/${ids.applicationId}/return`,
          body: { reviewNote: '書類が不足しています' },
        };
      case 'POST /admin/applications/:applicationId/reject':
        return {
          path: `/admin/applications/${ids.applicationId}/reject`,
          body: { reviewNote: '要件を満たしません' },
        };

      case 'GET /admin/reports/:reportId':
        return { path: `/admin/reports/${ids.reportId}` };
      case 'POST /admin/reports/:reportId/resolve':
        return {
          path: `/admin/reports/${ids.reportId}/resolve`,
          body: { decision: REPORT_DECISIONS.hideContent },
        };
      case 'POST /admin/reports/:reportId/reject':
        return { path: `/admin/reports/${ids.reportId}/reject` };

      case 'GET /admin/users/:userId':
        return { path: `/admin/users/${ids.normalUserId}` };
      case 'POST /admin/users/:userId/suspend':
        return { path: `/admin/users/${ids.normalUserId}/suspend` };
      case 'POST /admin/users/:userId/restore': {
        // 復帰は停止済みでないと 409 になる
        await requestAdmin(
          world.world,
          `/admin/users/${ids.normalUserId}/suspend`,
          { method: 'POST' },
          cookie,
        );
        return { path: `/admin/users/${ids.normalUserId}/restore` };
      }
      case 'PATCH /admin/users/:userId/role':
        return { path: `/admin/users/${ids.normalUserId}/role`, body: { role: ROLE_OWNER } };

      case 'GET /admin/shops/:shopId':
        return { path: `/admin/shops/${ids.shopId}` };
      case 'POST /admin/shops/:shopId/suspend':
        return { path: `/admin/shops/${ids.shopId}/suspend` };
      case 'POST /admin/shops/:shopId/restore': {
        await requestAdmin(
          world.world,
          `/admin/shops/${ids.shopId}/suspend`,
          { method: 'POST' },
          cookie,
        );
        return { path: `/admin/shops/${ids.shopId}/restore` };
      }
      case 'PATCH /admin/shops/:shopId/owner':
        return { path: `/admin/shops/${ids.shopId}/owner`, body: { ownerId: ids.normalUserId } };

      case 'POST /admin/genres':
        return { path: '/admin/genres', body: NEW_GENRE };
      case 'PATCH /admin/genres/:genreId':
        return { path: `/admin/genres/${ids.genreId}`, body: NEW_GENRE };
      case 'DELETE /admin/genres/:genreId': {
        // シード済みのジャンルは店舗に使われているので消せない。使われていないものを作る
        const created = await requestAdmin(
          world.world,
          '/admin/genres',
          jsonBody('POST', NEW_GENRE),
          cookie,
        );
        const { genreId } = await created.json<{ genreId: string }>();
        return { path: `/admin/genres/${genreId}` };
      }

      case 'POST /admin/areas':
        return { path: '/admin/areas', body: NEW_AREA };
      case 'PATCH /admin/areas/:areaId':
        return { path: `/admin/areas/${ids.areaId}`, body: NEW_AREA };
      case 'DELETE /admin/areas/:areaId': {
        const created = await requestAdmin(
          world.world,
          '/admin/areas',
          jsonBody('POST', NEW_AREA),
          cookie,
        );
        const { areaId } = await created.json<{ areaId: string }>();
        return { path: `/admin/areas/${areaId}` };
      }

      case 'POST /admin/announcements':
        return { path: '/admin/announcements', body: ANNOUNCEMENT };

      case 'POST /admin/audit-logs/:auditLogId/undo': {
        await requestAdmin(
          world.world,
          `/admin/users/${ids.normalUserId}/suspend`,
          { method: 'POST' },
          cookie,
        );
        const auditLogId = await readLatestAuditLogId(world, AUDIT_ACTIONS.userSuspend);
        return { path: `/admin/audit-logs/${auditLogId}/undo` };
      }

      default:
        throw new Error(`前準備が未定義のエンドポイント: ${key}`);
    }
  };

  return { ...endpoint, prepare };
});

describe('管理 API の権限行列（管理者の成功系）', () => {
  it.each(ADMIN_SUCCESS_CASES)(
    '$method $pattern は管理者なら $adminStatus',
    async ({ method, adminStatus, prepare }) => {
      // 前準備が状態を変えるため、ケースごとに世界を作り直す
      const world = await createAdminWorld();
      try {
        const signedIn = await signInAsAdmin(world.world);
        const plan = await prepare(world, signedIn.cookie);
        const init =
          plan.body === undefined
            ? { method }
            : {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(plan.body),
              };

        const response = await requestAdmin(world.world, plan.path, init, signedIn.cookie);

        expect(response.status).toBe(adminStatus);
      } finally {
        await world.dispose();
      }
    },
  );
});
```

`plainPath` は結局使わなかったので定義しないこと（`noUnusedLocals` で落ちる）。上の switch で全部さばいている。

`default:` の `throw` があるおかげで、表に行を足して前準備を書き忘れると、そのケースだけが「前準備が未定義のエンドポイント」で落ちる。**書き忘れが静かに素通りしない**のがこの形の理由。

- [ ] **Step 7: テストを実行する**

Run: `npm test -w @meshimap/api -- permission-matrix`
Expected: PASS（3 + 96 + 2 + 32 = 133 件）

世界を 32 個作るので時間がかかる。`vitest.config.ts` の `testTimeout` は 30 秒、`hookTimeout` は 60 秒なので、1 ケースあたりは収まる。全体が遅すぎる場合でも**ケース数を減らさないこと**。減らした瞬間にこのテストの価値が消える。

- [ ] **Step 8: わざと壊して、成功系が本当に成功を見ていることを確認する**

1. `applications.ts` の `assertWriteSucceeded(outcome);` を `approve` から消す → 承認のケースは 200 のまま通ってしまう（元々 200 期待）。**つまり成功系だけでは書き込みの正しさは測れない**。それを測っているのは Task 9-13 / 9-14 / 9-15 の各テストと Task 9-3 の監査ログ網羅表であることを確認して戻す。
2. `masters.ts` の `c.json({ genreId, result: outcome }, STATUS_CREATED)` を `c.json({ genreId, result: outcome })` にする → 「POST /admin/genres は管理者なら 201」が `expected 200 to be 201` で落ちる。
3. `middleware/role-guard.ts` の `roleGuard` が 403 ではなく 404 を投げるように変える → user / owner の 64 ケースが全部落ちる。

3 つとも確認したら戻す。

```bash
git diff --stat
```

Expected: 差分なし。

- [ ] **Step 9: コミットする**

```bash
cd /Users/hattori/Downloads/alee
npm test -w @meshimap/api && npm run typecheck -w @meshimap/api && npm run lint
git add apps/api/src/routes/admin/permission-matrix.test.ts
git commit -m "test(api): 管理 API の権限行列 128 ケースと登録パス照合を追加"
```

---

### Task 9-17: API の仕上げ（エントリポイント接続・変異テスト・網羅率）

ルートは全部そろったが、**本番のエントリポイントにまだ繋がっていない**。ここで繋いで、Phase 9 が API 側で課している品質基準を通す。

**Files:**

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`
- Modify: `apps/api/src/routes/admin/route-harness.test.ts`（本番との並び順を機械的に照合する）
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 のルート棚卸し。`/admin` を生やすと**必ず落ちる**）

**Interfaces:**

- Consumes: Task 9-16 までのすべて
- Produces: なし（既存の `app` に `/admin` が生える）

**着手順序の前提（Step 5 の必読事項）。** `apps/api/src/routes/permission-matrix.test.ts` は Phase 4 が作り、Phase 7（予約 9 本）と Phase 8（オーナー 32 本）が育てている**共有ファイル**である。`declaredRoutePatterns()` の結果を `toEqual` で固定しているので、`/admin` を 32 本生やした瞬間に落ちる。**Phase 9 は Phase 7 → Phase 8 の後に着手する**前提で Step 5 を書いた。着手前に必ず実物を開いて、いま下の表のどの列にいるかを数えること。

| 実物の宣言                 | Phase 4 | Phase 7 後   | Phase 8 後（＝ Phase 9 の着手時点の想定） | この Task 9-17 の後           | Task 9-26 の後（＝ Phase 9 後） |
| -------------------------- | ------- | ------------ | ----------------------------------------- | ----------------------------- | ------------------------------- |
| `EXPECTED_ROUTE_PATTERNS`  | 10 本   | 19 本        | **51 本**                                 | **83 本**                     | **87 本**                       |
| `DELEGATED_ROUTE_PATTERNS` | 無い    | 9 本（予約） | 9 本                                      | **41 本**（予約 9 + 管理 32） | 41 本のまま                     |
| `DELEGATABLE_PATH_PATTERN` | 無い    | 予約系 3 語  | 同左                                      | 予約系 3 語 + `admin` の 4 語 | 同左                            |

**この Task が足すのは 32 本まで。**残り 4 本（初回店舗申請）は Task 9-26 が足す。`/admin/**` ではないので委譲もしない。

**数が違っていたら「実物の本数 + 32」に読み替える。** Phase 9 が決めているのは増分 32 だけで、土台の本数ではない。`DELEGATED_ROUTE_PATTERNS` と `DELEGATABLE_PATH_PATTERN` がまだ無い（Phase 7 を飛ばしている）場合は、Phase 7 計画書 2494-2530 行の定義をそのまま先に持ち込んでから Step 5 の (2) 以降を行う。

**Phase 8 の引き継ぎ表との関係。** Phase 8 計画書 16287 行は `/admin/**` について「同じファイルに行を足す。**新しい突合テストファイルを作らない**」と書いている。Phase 9 はこれを次のように分けて満たす。

| 何を                                                            | どこが持つ                                                   | Phase 8 の指示との関係                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ルートの棚卸し**（`app.routes` に何本生えているか）           | Phase 4 の `src/routes/permission-matrix.test.ts` 1 本のまま | 指示どおり。`EXPECTED_ROUTE_PATTERNS` を 51 → 83 にする                                                                                                                                                                    |
| **主体ごとの期待ステータスの表**（32 本 × 4 視点 = 128 ケース） | Task 9-16 の `src/routes/admin/permission-matrix.test.ts`    | Phase 7 が `reservation-permission-matrix.test.ts` で作った**委譲の前例**に乗る。`ENDPOINT_CASES` に 128 ケースぶんを足すと Phase 4 のファイルが 4 視点 × 83 本に膨らみ、1 ファイルで実 D1 を 300 回以上叩くことになるため |

委譲した経路が誰にも検証されないまま残ることは無い。**「Phase 4 側: `DELEGATED_ROUTE_PATTERNS` == `app.routes` の `/admin` 系」と「Task 9-16 側: `ADMIN_ENDPOINTS` == `adminRoutes` の登録内容」の 2 本が同時に緑なら、両者は推移的に一致する。** Phase 7 計画書 7856-7861 行と同じ論法で、テストファイル同士を `import` しない（向こうの `describe` がこちらの実行に混ざるため）。

- [ ] **Step 1: ハーネスと本番の並び順がずれていないことを確かめるテストを書く**

Task 9-13 の `createAdminTestApp()` は「本番と同じ順序でミドルウェアを積む」と書いたが、**そう書いてあるだけ**で機械的な保証が無い。ここで塞ぐ。

**実物の形を先に押さえること。** `apps/api/src/index.ts` の 20-31 行は**単一のメソッドチェーン**である（実測）。

```ts
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
```

つまり **`app` という識別子はチェーンの中に 1 度も現れない。** したがって「レシーバが `app` という名前の Identifier である呼び出しを集める」実装は**必ず空配列を返す**。同様に「`app.route('/admin', adminRoutes)` という文字列がソースに含まれるか」で見るのも通らない（実物には `app.` の接頭辞が付かない）。18 行目に「メソッドチェーンを途中で変数に切らないこと。切ると型が積み上がらず `AppType` が痩せる」と明記があり、`rpc-contract.test.ts` がその `AppType` に依存しているので、**index.ts を独立文に書き換えて検査器に合わせる逃げは使えない。検査器の側を実物に合わせる。**

並び順の取り方にも落とし穴がある。`ts.forEachChild` で `.xxx(` を素朴に集めると、いちばん外側の呼び出しから内側へ降りるため**ソースと逆順**に並ぶ（実測値: `["route","route","route","get","use","on","notFound","onError"]`）。下の実装は末尾のリンクから `expression.expression` を辿って根まで巻き戻し、最後に `reverse()` してソース順に直している（実測値: `["onError","notFound","on","use","get","route","route","route"]`）。

`apps/api/src/routes/admin/route-harness.test.ts` に追記する。既存の import に足りないものだけ足すこと。

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * `src/index.ts` の絶対パス。
 *
 * `new URL('../../index.ts', import.meta.url)` と書かないこと。この tsconfig のグローバル `URL` は
 * @cloudflare/workers-types のものに差し替わっており、`node:url` の `fileURLToPath` に渡すと TS2769 になる
 * （`repositories/repository-convention.test.ts:13-15` と `db/constants-parity.test.ts:12-16` に同じ注記がある）。
 */
const ENTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'index.ts',
);

/** チェーンの根。`new Hono<AppEnv>()` のコンストラクタ名 */
const HONO_CONSTRUCTOR_NAME = 'Hono';

/** `Array#findIndex` が「見つからない」を返す値 */
const NOT_FOUND_INDEX = -1;

/** チェーンの 1 リンク。`.route('/admin', adminRoutes)` なら `{ name: 'route', firstArgument: '/admin' }` */
type ChainLink = {
  readonly name: string;
  /** 第 1 引数が文字列リテラルならその値。配列やテンプレートリテラルなら `undefined` */
  readonly firstArgument: string | undefined;
};

/**
 * `new Hono(...)` を根に持つメソッドチェーンを、**ソースに現れた順**で返す。
 * 根が `new Hono` でなければ `undefined`（＝このノードはチェーンの先頭ではない）。
 *
 * `.on(...)` の引数の中にある `auth.handler(c.req.raw)` や `c.json(...)` は、
 * 巻き戻した先が Identifier で `new Hono` ではないので自然に外れる。
 */
function collectHonoChainLinks(node: ts.Node): readonly ChainLink[] | undefined {
  const reversed: ChainLink[] = [];
  let current: ts.Node = node;

  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const [firstArgument] = current.arguments;
    reversed.push({
      name: current.expression.name.text,
      firstArgument:
        firstArgument !== undefined && ts.isStringLiteral(firstArgument)
          ? firstArgument.text
          : undefined,
    });
    current = current.expression.expression;
  }

  if (
    !ts.isNewExpression(current) ||
    !ts.isIdentifier(current.expression) ||
    current.expression.text !== HONO_CONSTRUCTOR_NAME
  ) {
    return undefined;
  }
  return [...reversed].reverse();
}

/** `src/index.ts` の `new Hono()` チェーンを読む。1 本に見つからなければ投げる（静かな空配列にしない） */
function readEntryChainLinks(): readonly ChainLink[] {
  const source = ts.createSourceFile(
    ENTRY_PATH,
    readFileSync(ENTRY_PATH, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const chains: (readonly ChainLink[])[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const links = collectHonoChainLinks(node);
      if (links !== undefined) {
        chains.push(links);
        // レシーバ側は巻き戻して消化済み。引数の中だけを続けて見る（部分チェーンの二重採取を防ぐ）
        node.arguments.forEach(visit);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const [firstChain, ...rest] = chains;
  if (firstChain === undefined || rest.length !== 0) {
    throw new Error(`src/index.ts の new Hono() チェーンは 1 本であるべき: ${chains.length} 本`);
  }
  return firstChain;
}

describe('ハーネスと本番のミドルウェア順序', () => {
  it('src/index.ts は onError → notFound → use → route の順で積んでいる', () => {
    const names = readEntryChainLinks().map((link) => link.name);

    // createAdminTestApp() と同じ並び。ここが変わったらハーネスも直すこと
    expect(names).toContain('onError');
    expect(names).toContain('notFound');
    expect(names.indexOf('onError')).toBeLessThan(names.indexOf('use'));
    expect(names.indexOf('use')).toBeLessThan(names.indexOf('route'));
  });

  it('src/index.ts が mount しているルータは /me → /shops → /reviews → /admin の 4 本', () => {
    const mountPaths = readEntryChainLinks()
      .filter((link) => link.name === 'route')
      .map((link) => link.firstArgument);

    // ソース文字列の toContain ではなく、並びごと固定する。`/admin` は必ず末尾に足す
    expect(mountPaths).toEqual(['/me', '/shops', '/reviews', '/admin']);
  });

  it('/admin の mount が authMiddleware の use より後ろにある', () => {
    const links = readEntryChainLinks();
    const useIndex = links.findIndex((link) => link.name === 'use');
    const adminIndex = links.findIndex(
      (link) => link.name === 'route' && link.firstArgument === '/admin',
    );

    // 前に出すと認証前に管理ルータが走り、c.get('viewer') が未設定のまま roleGuard に入る
    expect(useIndex).not.toBe(NOT_FOUND_INDEX);
    expect(adminIndex).toBeGreaterThan(useIndex);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/api -- route-harness`
Expected: FAIL。「mount しているルータは /me → /shops → /reviews → /admin の 4 本」が `['/me','/shops','/reviews']` と `['/me','/shops','/reviews','/admin']` の差分で落ち、「/admin の mount が authMiddleware の use より後ろにある」が `adminIndex` = -1 で落ちる。**「onError → notFound → use → route の順」は先に通っているはず**で、ここが空配列で落ちるなら検査器の巻き戻しが効いていない。

- [ ] **Step 3: エントリポイントに繋ぐ**

`apps/api/src/index.ts` を 2 箇所直す。**`app.route('/admin', adminRoutes);` という独立文を足してはいけない。** 18 行目のコメントどおり、チェーンを途中で切ると型が積み上がらず `AppType` が痩せ、`src/routes/rpc-contract.test.ts` が落ちる。

(1) import を足す。既存の import はパスの辞書順に並んでいるので、`./routes/admin` は `./routes/me` の**前**に入る:

```ts
import { adminRoutes } from './routes/admin';
import { meRoutes } from './routes/me';
import { reviewRoutes } from './routes/reviews';
import { shopRoutes } from './routes/shops';
```

(2) チェーンの**末尾**に `.route('/admin', adminRoutes)` を足す。`.route('/reviews', reviewRoutes)` のセミコロンを外して 1 行下げる:

```ts
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
  .route('/reviews', reviewRoutes)
  .route('/admin', adminRoutes);
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/api -- route-harness && npm run typecheck -w @meshimap/api`
Expected: 両方 PASS（route-harness は Task 9-13 の 4 件 + ここの 3 件 = 7 件）

- [ ] **Step 5: Phase 4 のルート棚卸し（`src/routes/permission-matrix.test.ts`）を直す**

Step 3 で `/admin` が生えたので、このファイルは**いま落ちている**。先に落ちていることを見る。

Run: `npm test -w @meshimap/api -- routes/permission-matrix`
Expected: FAIL。「app に登録されたエンドポイントは 51 本で、想定どおりの並びである」が 32 本ぶんの差分で落ち、「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」が `権限マトリクスに無いエンドポイント: DELETE /admin/areas/:areaId` 以下 32 行を並べる。

**この 32 本は、上の「管理 API のエンドポイント一覧と期待ステータス」の表・Task 9-16 の `ADMIN_ENDPOINTS`・ここの 3 箇所で同じ文字列でなければならない。**

(1) `EXPECTED_ROUTE_PATTERNS` に 32 本足す。**この配列は `collectEndpointPatterns` が `.sort()` した結果と `toEqual` で比較される**ので、配列全体が昇順でなければならない。`/admin` は `/health` / `/me` / `/owner` / `/reservation-slots` / `/reservations` / `/reviews` / `/shops` のどれよりも小さいので、**4 つのメソッド群それぞれの先頭**に入る。

`DELETE` 群の先頭に 2 本:

```ts
  'DELETE /admin/areas/:areaId',
  'DELETE /admin/genres/:genreId',
```

`GET` 群の先頭に 13 本:

```ts
  'GET /admin/announcements',
  'GET /admin/applications',
  'GET /admin/applications/:applicationId',
  'GET /admin/areas',
  'GET /admin/audit-logs',
  'GET /admin/genres',
  'GET /admin/reports',
  'GET /admin/reports/:reportId',
  'GET /admin/shops',
  'GET /admin/shops/:shopId',
  'GET /admin/stats/overview',
  'GET /admin/users',
  'GET /admin/users/:userId',
```

`PATCH` 群の先頭に 4 本:

```ts
  'PATCH /admin/areas/:areaId',
  'PATCH /admin/genres/:genreId',
  'PATCH /admin/shops/:shopId/owner',
  'PATCH /admin/users/:userId/role',
```

`POST` 群の先頭に 13 本:

```ts
  'POST /admin/announcements',
  'POST /admin/applications/:applicationId/approve',
  'POST /admin/applications/:applicationId/reject',
  'POST /admin/applications/:applicationId/return',
  'POST /admin/areas',
  'POST /admin/audit-logs/:auditLogId/undo',
  'POST /admin/genres',
  'POST /admin/reports/:reportId/reject',
  'POST /admin/reports/:reportId/resolve',
  'POST /admin/shops/:shopId/restore',
  'POST /admin/shops/:shopId/suspend',
  'POST /admin/users/:userId/restore',
  'POST /admin/users/:userId/suspend',
```

並びで迷ったら比較規則を思い出すこと。JavaScript の既定ソートは UTF-16 コード単位の辞書順で、`/` は 0x2F、`-` は 0x2D、英小文字は 0x61 以降。だから `'GET /admin/reports'` は `'GET /admin/reports/:reportId'` より前（短いほうが前）、`'GET /admin/shops/:shopId'` は `'GET /admin/stats/overview'` より前（`h` < `t`）、`'POST /admin/reports/:reportId/reject'` は `'…/resolve'` より前（`j` < `s`）になる。

配列の直前のコメントの本数も直す:

```ts
/** 権限マトリクスが責任を持つ 83 本。ここを増減させるときは必ず ENDPOINT_CASES か DELEGATED_ROUTE_PATTERNS も直す */
```

(2) `DELEGATED_ROUTE_PATTERNS` に**同じ 32 本**を足す。**`ENDPOINT_CASES` には管理系の行を足さない**（128 ケースは Task 9-16 が持つ）。この配列は比較の直前に `[...DELEGATED_ROUTE_PATTERNS].sort()` されるので配列全体が昇順である必要は無い。予約系 9 本の下に、コメントで区切って管理系 32 本をまとめて置く:

```ts
const DELEGATED_ROUTE_PATTERNS: readonly string[] = [
  // Phase 7: reservation-permission-matrix.test.ts が持つ 9 本
  'GET /owner/reservations',
  'GET /owner/reservations/:reservationId',
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'PATCH /owner/reservations/:reservationId/memo',
  'POST /owner/reservations/:reservationId/status',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
  // Phase 9: routes/admin/permission-matrix.test.ts が持つ 32 本（4 視点 × 32 = 128 ケース）
  'DELETE /admin/areas/:areaId',
  'DELETE /admin/genres/:genreId',
  'GET /admin/announcements',
  'GET /admin/applications',
  'GET /admin/applications/:applicationId',
  'GET /admin/areas',
  'GET /admin/audit-logs',
  'GET /admin/genres',
  'GET /admin/reports',
  'GET /admin/reports/:reportId',
  'GET /admin/shops',
  'GET /admin/shops/:shopId',
  'GET /admin/stats/overview',
  'GET /admin/users',
  'GET /admin/users/:userId',
  'PATCH /admin/areas/:areaId',
  'PATCH /admin/genres/:genreId',
  'PATCH /admin/shops/:shopId/owner',
  'PATCH /admin/users/:userId/role',
  'POST /admin/announcements',
  'POST /admin/applications/:applicationId/approve',
  'POST /admin/applications/:applicationId/reject',
  'POST /admin/applications/:applicationId/return',
  'POST /admin/areas',
  'POST /admin/audit-logs/:auditLogId/undo',
  'POST /admin/genres',
  'POST /admin/reports/:reportId/reject',
  'POST /admin/reports/:reportId/resolve',
  'POST /admin/shops/:shopId/restore',
  'POST /admin/shops/:shopId/suspend',
  'POST /admin/users/:userId/restore',
  'POST /admin/users/:userId/suspend',
];
```

（Phase 7 の 9 本は実物から写すこと。ここに書いたのは Phase 7 計画書 7694-7704 行の内容で、実物が違っていれば**実物を優先する**。）

(3) `DELEGATABLE_PATH_PATTERN` に `admin` を足す。**Phase 9 はこの 1 語だけを足し、予約系の 3 語には触らない**:

```ts
/** 委譲を許すパスの形。Phase 7 は reservation-permission-matrix.test.ts、Phase 9 は routes/admin/permission-matrix.test.ts が受ける */
const DELEGATABLE_PATH_PATTERN =
  /^\/(admin|reservation-slots|reservations|owner\/reservations)(\/|$)/;
```

(4) `describe('ルート表と実装の突合')` の中の it 名と、委譲の it を直す。**本数はテスト名にも書いてあるので、配列だけ直すと名前が嘘になる**:

```ts
it('app に登録されたエンドポイントは 83 本で、想定どおりの並びである', () => {
  expect(declaredRoutePatterns()).toEqual(EXPECTED_ROUTE_PATTERNS);
});

it('委譲しているのは予約系と管理系だけで、どちらも 1 本残らず委譲されている', () => {
  // 「面倒だから委譲リストに入れておく」を防ぐ。それ以外はこのファイルで検証し切る
  const delegatedPatterns = collectEndpointPatterns(app.routes, AUTH_BASE_PATH).filter((pattern) =>
    DELEGATABLE_PATH_PATTERN.test(pattern.slice(pattern.indexOf(' ') + 1)),
  );
  expect([...DELEGATED_ROUTE_PATTERNS].sort()).toEqual(delegatedPatterns);
});
```

(5) `declaredRoutePatterns()` の上の JSDoc は Phase 4 時点の実測値（生 22 / 重複を潰すと 13 / 除くと 10）のまま古びている。**機械検査されないコメントなので手で数え直す。** 落ちたテストの差分に出る実際の本数を書き写すこと。

Run: `npm test -w @meshimap/api -- routes/permission-matrix routes/admin/permission-matrix`
Expected: 両方 PASS

- [ ] **Step 6: わざと壊して、ルート棚卸しと委譲が効いていることを確認する**

1 つずつ壊して、1 つずつ戻す。

1. `EXPECTED_ROUTE_PATTERNS` から `'GET /admin/audit-logs'` の 1 行を消す → FAIL。「app に登録されたエンドポイントは 83 本で、想定どおりの並びである」が 82 本 vs 83 本の差分で落ちる。戻す。
2. `DELEGATED_ROUTE_PATTERNS` から `'GET /admin/audit-logs'` の 1 行を消す → FAIL が 2 本。「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」が `権限マトリクスに無いエンドポイント: GET /admin/audit-logs` を出し、「委譲しているのは予約系と管理系だけで…」が 40 本 vs 41 本で落ちる。**委譲リストに入れ忘れた経路が黙って素通りしないこと**の確認。戻す。
3. `DELEGATABLE_PATH_PATTERN` から `admin|` を消す → FAIL。「委譲しているのは予約系と管理系だけで…」が、`delegatedPatterns` から管理系 32 本が落ちて 41 本 vs 9 本で落ちる。**委譲を許す範囲を勝手に広げられないこと**の確認。戻す。

```bash
git diff --stat
```

Expected: 壊した箇所が残っていないこと。

- [ ] **Step 7: 本番の app 経由でも 401 / 403 / 200 が変わらないことを確かめる**

`apps/api/src/index.test.ts` に追記する。ハーネスではなく**本番の `app`** を直接叩く。

```ts
it('/admin は未ログインで 401', async () => {
  const world = await createTestWorld();
  try {
    const response = await app.request('/admin/stats/overview', {}, createTestBindings(world));

    expect(response.status).toBe(401);
  } finally {
    await world.dispose();
  }
});

it('/admin は利用者で 403', async () => {
  const world = await createTestWorld();
  try {
    const user = await signUpAs(world, 'user@example.test', ROLE_USER);
    const response = await app.request(
      '/admin/stats/overview',
      { headers: { cookie: user.cookie } },
      createTestBindings(world),
    );

    expect(response.status).toBe(403);
  } finally {
    await world.dispose();
  }
});

it('/admin は管理者で 200', async () => {
  const world = await createTestWorld();
  try {
    const admin = await signUpAs(world, 'admin@example.test', ROLE_ADMIN);
    const response = await app.request(
      '/admin/stats/overview',
      { headers: { cookie: admin.cookie } },
      createTestBindings(world),
    );

    expect(response.status).toBe(200);
  } finally {
    await world.dispose();
  }
});
```

Run: `npm test -w @meshimap/api -- index`
Expected: PASS

- [ ] **Step 8: わざと壊して、本番経路が測れていることを確認する**

`apps/api/src/index.ts` の `.route('/admin', adminRoutes)` の**リンクごと** `.use('*', authMiddleware)` より前へ移す（独立文に切り出さないこと。切ると `AppType` が痩せて別の理由で落ち、何を測っているのか分からなくなる）:

```ts
export const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .notFound(notFoundHandler)
  .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => {
    const auth = createAuth(createDatabase(c.env.DB), c.env);
    return auth.handler(c.req.raw);
  })
  .route('/admin', adminRoutes)
  .use('*', authMiddleware)
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/me', meRoutes)
  .route('/shops', shopRoutes)
  .route('/reviews', reviewRoutes);
```

Run: `npm test -w @meshimap/api -- index route-harness`
Expected: FAIL が 3 本。静的検査側は「mount しているルータは /me → /shops → /reviews → /admin の 4 本」（実際は `['/admin','/me','/shops','/reviews']`。実測で確認済み）と「/admin の mount が authMiddleware の use より後ろにある」が落ちる。実行側は「/admin は管理者で 200」が 401 で落ちる（認証が走っていないので `c.get('viewer')` が未設定のまま門番に入る）。**3 本のうちどれが落ちたかを記録してから戻すこと。** 静的検査だけが落ちて実行側が通ったなら、それは「順序を守らなくても動く」という意味ではなく、**Hono の内部順序に依存した状態**なので必ず戻す。

- [ ] **Step 9: 網羅率を確認する**

Run: `npm run test -w @meshimap/api -- --coverage`
Expected: `src/routes/admin/**` と `src/repositories/admin-*.ts` と `src/lib/audit-log.ts` が **statements / branches / functions / lines すべて 100%**。

100% に届かない行が出たら、**その行を消すかテストを足すかの二択**。`/* v8 ignore */` や `coverage.exclude` への追加で通さないこと。よくある未到達は次の 3 つ。

| 未到達になりがちな箇所                    | 足すテスト                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `assertWriteSucceeded` の `conflict` 分岐 | すでに respond.test.ts にある。届いていないなら import 経路を確認                            |
| `buildNotificationId` の throw            | お知らせ ID を長くして呼ぶ単体テスト（`sendAnnouncement` 経由では 422 で止まるので届かない） |
| `withAuditLogChunked` の 2 チャンク目     | 宛先 101 人のお知らせを配るテスト                                                            |

- [ ] **Step 10: 変異テストを流す**

Run: `npm run test:mutation -w @meshimap/api`
Expected: mutation score が `stryker.base.mjs` の閾値（break 85 / low 85 / high 95）を超える。

**生き残った変異を除外で通さないこと。**`stryker.config.mjs` の `mutate` に `!` を足す変更は、`apps/api/stryker.config.mjs` のコメントが定めた「サンドボックス外を読むから」以外の理由では認めない。生き残ったら、次の順で対処する。

1. その変異が**本当に振る舞いを変えない**なら、そのコードは不要。消す。
2. 振る舞いを変えるのにテストが落ちないなら、テストが足りない。足す。

Phase 9 で生き残りやすい変異と、殺すテストの当て方:

| 生き残りやすい変異                                   | 殺し方                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `clampPageSize` の `>` → `>=`                        | 上限ちょうどの値でテストする（Task 9-4 にある）              |
| `ANNOUNCEMENT_CHUNK_SIZE` の `100` → `101` など      | 100 件ちょうどと 101 件の両方で「監査ログが 1 行」を確かめる |
| `if (existing.length > NO_REFERENCES)` の `>` → `>=` | 0 件のとき（作成が通る）と 1 件のとき（409）の両方を持つ     |
| `describeAudience` の文字列                          | 監査ログの `diff` に入る文字列を `toBe` で照合する           |
| `toSamplePath` の `replaceAll`                       | このファイルはテストなので変異対象外（`!src/**/*.test.ts`）  |

- [ ] **Step 11: 全ワークスペースで通ることを確認する**

```bash
cd /Users/hattori/Downloads/alee
npm test && npm run typecheck && npm run lint && npm run format:check
```

Expected: すべて PASS

- [ ] **Step 12: コミットする**

```bash
cd /Users/hattori/Downloads/alee
git add apps/api/src
git commit -m "feat(api): 管理 API をエントリポイントに接続し品質基準を通す"
```

---

### Task 9-18: 管理画面に足りない UI プリミティブ 3 つ

`apps/mobile/src/components/ui/` には badge / button / card / empty-state / error-state / icon / input / skeleton の 8 つがある（2026-09-15 に `ls` で確認）。管理画面が要る操作は次の 3 つで、どれも既存では作れない。

| 要る操作                       | 既存で足りない理由                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「本当に停止しますか？」の確認 | RN の `Alert.alert` は iOS / Android で見た目もボタン順も違い、RNTL からは押せない（ネイティブモジュール）。テストできない操作を破壊的操作に使わない |
| ロール・ジャンル・エリアの選択 | `Input` は自由文字列。語彙が決まっているものを自由入力にすると 422 をユーザーに見せることになる                                                      |
| 一覧の状態フィルタ             | 3〜4 択を常時表示したい。モーダルを開かせるのは操作が重い                                                                                            |

**既存の 8 つを作り直さない。**`ConfirmDialog` は内部で `Button` を、`SelectField` と `SegmentedControl` は文言に既存のタイポグラフィクラスを使う。

**Files:**

- Create: `apps/mobile/src/components/ui/confirm-dialog.tsx`
- Create: `apps/mobile/src/components/ui/confirm-dialog.test.tsx`
- Create: `apps/mobile/src/components/ui/select-field.tsx`
- Create: `apps/mobile/src/components/ui/select-field.test.tsx`
- Create: `apps/mobile/src/components/ui/segmented-control.tsx`
- Create: `apps/mobile/src/components/ui/segmented-control.test.tsx`
- Modify: `apps/mobile/src/app/_dev/catalog.tsx`
- Modify: `apps/mobile/src/app/_dev/catalog.test.tsx`

**Interfaces:**

- Consumes: 既存の `Button` / `ButtonVariant`、`COLORS`
- Produces:
  - `ConfirmDialogProps` / `ConfirmDialog`
  - `SelectOption<TValue extends string>` / `SelectFieldProps<TValue>` / `SelectField`
  - `SegmentOption<TValue extends string>` / `SegmentedControlProps<TValue>` / `SegmentedControl`

- [ ] **Step 1: ConfirmDialog の失敗するテストを書く**

`apps/mobile/src/components/ui/confirm-dialog.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ConfirmDialog } from './confirm-dialog';

const BASE_PROPS = {
  isVisible: true,
  title: 'このユーザーを停止しますか？',
  message: '停止するとログインできなくなります。あとから復帰できます。',
  confirmLabel: '停止する',
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

describe('ConfirmDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isVisible が false なら本文を出さない', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} isVisible={false} />);

    expect(screen.queryByText(BASE_PROPS.title)).toBeNull();
  });

  it('タイトルと本文と取り消せる旨を表示する', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} />);

    expect(screen.getByText(BASE_PROPS.title)).toBeOnTheScreen();
    expect(screen.getByText(BASE_PROPS.message)).toBeOnTheScreen();
  });

  it('確認を押すと onConfirm が呼ばれる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} />);

    await fireEvent.press(screen.getByText(BASE_PROPS.confirmLabel));

    expect(BASE_PROPS.onConfirm).toHaveBeenCalledTimes(1);
    expect(BASE_PROPS.onCancel).not.toHaveBeenCalled();
  });

  it('取消を押すと onCancel が呼ばれる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} />);

    await fireEvent.press(screen.getByText('キャンセル'));

    expect(BASE_PROPS.onCancel).toHaveBeenCalledTimes(1);
    expect(BASE_PROPS.onConfirm).not.toHaveBeenCalled();
  });

  it('cancelLabel を変えられる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} cancelLabel="やめる" />);

    expect(screen.getByText('やめる')).toBeOnTheScreen();
    expect(screen.queryByText('キャンセル')).toBeNull();
  });

  it('isDestructive のとき確認ボタンが danger になる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} isDestructive />);

    // Button の danger は bg-red-500。className をそのまま読める（NativeWind はテストでは変換しない）
    const confirmButton = screen.getByTestId('confirm-dialog-confirm');
    expect(String(confirmButton.props.className)).toContain('bg-red-500');
  });

  it('既定では確認ボタンが primary になる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} />);

    expect(String(screen.getByTestId('confirm-dialog-confirm').props.className)).toContain(
      'bg-primary-500',
    );
  });

  it('isLoading のとき確認は二度押せず、取消も押せない', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} isLoading />);

    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));

    expect(BASE_PROPS.onConfirm).not.toHaveBeenCalled();
    expect(BASE_PROPS.onCancel).not.toHaveBeenCalled();
  });

  it('Android の戻る操作（Modal の onRequestClose）で onCancel が呼ばれる', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} />);

    await fireEvent(screen.getByTestId('confirm-dialog'), 'requestClose');

    expect(BASE_PROPS.onCancel).toHaveBeenCalledTimes(1);
  });

  it('読み込み中は戻る操作でも閉じない', async () => {
    await render(<ConfirmDialog {...BASE_PROPS} isLoading />);

    await fireEvent(screen.getByTestId('confirm-dialog'), 'requestClose');

    expect(BASE_PROPS.onCancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- confirm-dialog`
Expected: FAIL。`Cannot find module './confirm-dialog'`。

- [ ] **Step 3: ConfirmDialog を実装する**

`apps/mobile/src/components/ui/confirm-dialog.tsx`

```tsx
import { Modal, Text, View } from 'react-native';

import { Button, type ButtonVariant } from './button';

export interface ConfirmDialogProps {
  isVisible: boolean;
  title: string;
  /** 何が起きるかと、取り消せるかどうかを必ず書く */
  message: string;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** 停止・削除など、押したら状態が変わる操作に立てる */
  isDestructive?: boolean | undefined;
  /** 送信中。二度押しと誤操作での離脱を止める */
  isLoading?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  testID?: string | undefined;
}

/**
 * `Alert.alert` を使わない理由:
 * ネイティブモジュール経由なので RNTL から押せず、破壊的操作の導線をテストできなくなる。
 * また iOS と Android でボタンの並び順が逆になり、「取消のつもりで実行」が起きる。
 */
const DEFAULT_CANCEL_LABEL = 'キャンセル';

/** 破壊的かどうかで確認ボタンの色を変える。押す前に色で気づけるようにする */
const CONFIRM_VARIANTS: Record<'destructive' | 'normal', ButtonVariant> = {
  destructive: 'danger',
  normal: 'primary',
};

/** テストと呼び出し側が参照する testID。変えると参照が壊れる */
const ROOT_TEST_ID = 'confirm-dialog';
const CONFIRM_TEST_ID = 'confirm-dialog-confirm';
const CANCEL_TEST_ID = 'confirm-dialog-cancel';

export function ConfirmDialog({
  isVisible,
  title,
  message,
  confirmLabel,
  cancelLabel = DEFAULT_CANCEL_LABEL,
  isDestructive = false,
  isLoading = false,
  onConfirm,
  onCancel,
  testID = ROOT_TEST_ID,
}: ConfirmDialogProps) {
  // 送信中に閉じられると、結果が分からないまま一覧へ戻ることになる
  const handleCancel = (): void => {
    if (isLoading) {
      return;
    }
    onCancel();
  };

  return (
    <Modal
      animationType="fade"
      // Android のハードウェアバックキー。指定しないと閉じられないダイアログになる
      onRequestClose={handleCancel}
      testID={testID}
      transparent
      visible={isVisible}
    >
      <View className="flex-1 items-center justify-center bg-black/50 px-lg">
        <View accessibilityRole="alert" className="w-full gap-md rounded-card bg-white p-lg">
          <Text className="font-heading text-lg text-neutral-900">{title}</Text>
          <Text className="font-body text-sm text-neutral-700">{message}</Text>
          <View className="gap-sm">
            <Button
              isDisabled={isLoading}
              isLoading={isLoading}
              label={confirmLabel}
              onPress={onConfirm}
              testID={CONFIRM_TEST_ID}
              variant={isDestructive ? CONFIRM_VARIANTS.destructive : CONFIRM_VARIANTS.normal}
            />
            <Button
              isDisabled={isLoading}
              label={cancelLabel}
              onPress={handleCancel}
              testID={CANCEL_TEST_ID}
              variant="ghost"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
```

`isVisible={false}` のとき本文が出ないのは `Modal` の `visible` が false だと子を描画しないため。RN の `Modal` は `visible=false` で `null` を返す（`node_modules/react-native/Libraries/Modal/Modal.js`）。**この挙動に依存していることを覚えておくこと**。テストの 1 件目がこれを固定している。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- confirm-dialog && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（10 件）

- [ ] **Step 5: わざと壊して、二度押し防止と色分けが効いていることを確認する**

1. `isDisabled={isLoading}` を確認ボタンから消す → 「isLoading のとき確認は二度押せず」が落ちる。
2. `CONFIRM_VARIANTS.destructive` を `'primary'` にする → 「isDestructive のとき確認ボタンが danger になる」が落ちる。
3. `handleCancel` の早期 return を消す → 「読み込み中は戻る操作でも閉じない」が落ちる。

3 つとも確認したら戻す。

- [ ] **Step 6: SelectField の失敗するテストを書く**

`apps/mobile/src/components/ui/select-field.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SelectField, type SelectOption } from './select-field';

type RoleValue = 'user' | 'owner' | 'admin';

const OPTIONS: readonly SelectOption<RoleValue>[] = [
  { value: 'user', label: '利用者' },
  { value: 'owner', label: '店舗管理者' },
  { value: 'admin', label: 'システム管理者' },
];

describe('SelectField', () => {
  it('選択中の値のラベルを表示する', async () => {
    await render(
      <SelectField label="ロール" onChange={jest.fn()} options={OPTIONS} value="owner" />,
    );

    expect(screen.getByText('店舗管理者')).toBeOnTheScreen();
  });

  it('未選択なら placeholder を表示する', async () => {
    await render(
      <SelectField
        label="ロール"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="選択してください"
        value={null}
      />,
    );

    expect(screen.getByText('選択してください')).toBeOnTheScreen();
  });

  it('語彙に無い値が来てもクラッシュせず placeholder を出す', async () => {
    await render(
      <SelectField
        label="ロール"
        onChange={jest.fn()}
        options={OPTIONS}
        placeholder="選択してください"
        // サーバが新しいロールを返し始めた場合を想定する
        value={'moderator' as RoleValue}
      />,
    );

    expect(screen.getByText('選択してください')).toBeOnTheScreen();
  });

  it('押すと選択肢が開き、選ぶと onChange が呼ばれて閉じる', async () => {
    const onChange = jest.fn();
    await render(
      <SelectField
        label="ロール"
        onChange={onChange}
        options={OPTIONS}
        testID="role"
        value="user"
      />,
    );

    await fireEvent.press(screen.getByTestId('role-trigger'));
    expect(screen.getByText('システム管理者')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('role-option-admin'));

    expect(onChange).toHaveBeenCalledWith('admin');
    expect(screen.queryByTestId('role-option-admin')).toBeNull();
  });

  it('開いた状態で取り消すと onChange を呼ばずに閉じる', async () => {
    const onChange = jest.fn();
    await render(
      <SelectField
        label="ロール"
        onChange={onChange}
        options={OPTIONS}
        testID="role"
        value="user"
      />,
    );

    await fireEvent.press(screen.getByTestId('role-trigger'));
    await fireEvent.press(screen.getByTestId('role-dismiss'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('role-option-admin')).toBeNull();
  });

  it('isDisabled なら開かない', async () => {
    await render(
      <SelectField
        isDisabled
        label="ロール"
        onChange={jest.fn()}
        options={OPTIONS}
        testID="role"
        value="user"
      />,
    );

    await fireEvent.press(screen.getByTestId('role-trigger'));

    expect(screen.queryByTestId('role-option-admin')).toBeNull();
  });

  it('選択中の選択肢には accessibilityState.selected が立つ', async () => {
    await render(
      <SelectField
        label="ロール"
        onChange={jest.fn()}
        options={OPTIONS}
        testID="role"
        value="owner"
      />,
    );

    await fireEvent.press(screen.getByTestId('role-trigger'));

    expect(screen.getByTestId('role-option-owner').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('role-option-user').props.accessibilityState.selected).toBe(false);
  });

  it('errorMessage があれば読み上げ対象として出す', async () => {
    await render(
      <SelectField
        errorMessage="ロールを選んでください"
        label="ロール"
        onChange={jest.fn()}
        options={OPTIONS}
        value={null}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('ロールを選んでください');
  });
});
```

- [ ] **Step 7: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- select-field`
Expected: FAIL。`Cannot find module './select-field'`。

- [ ] **Step 8: SelectField を実装する**

`apps/mobile/src/components/ui/select-field.tsx`

```tsx
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

/** 語彙が決まっている値の選択肢。value は必ず文字列（クエリにもそのまま載るため） */
export interface SelectOption<TValue extends string> {
  value: TValue;
  label: string;
}

export interface SelectFieldProps<TValue extends string> {
  label: string;
  value: TValue | null;
  options: readonly SelectOption<TValue>[];
  onChange: (value: TValue) => void;
  placeholder?: string | undefined;
  errorMessage?: string | undefined;
  isDisabled?: boolean | undefined;
  testID?: string | undefined;
}

/** placeholder の既定。管理画面のフィルタは「指定なし」が既定になることが多い */
const DEFAULT_PLACEHOLDER = '指定なし';

/** 選択肢一覧の最大の高さ（px）。エリアのように数十件になっても画面を覆い尽くさない */
const OPTION_LIST_MAX_HEIGHT_PX = 320;

const DEFAULT_TEST_ID = 'select-field';

/**
 * 語彙の決まった値を選ばせる。
 *
 * `Input`（自由文字列）と使い分けること。語彙が決まっているものを自由入力にすると、
 * 綴り間違いがそのままサーバへ飛んで 422 になり、ユーザーには理由が分からない。
 */
export function SelectField<TValue extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = DEFAULT_PLACEHOLDER,
  errorMessage,
  isDisabled = false,
  testID = DEFAULT_TEST_ID,
}: SelectFieldProps<TValue>) {
  const [isOpen, setIsOpen] = useState(false);
  // サーバが語彙を増やしたとき、知らない値で落ちないように find で引く
  const selected = options.find((option) => option.value === value);
  const hasError = errorMessage !== undefined && errorMessage !== '';

  const handleSelect = (next: TValue): void => {
    onChange(next);
    setIsOpen(false);
  };

  return (
    <View className="gap-xs">
      <Text className="font-body-medium text-sm text-neutral-700">{label}</Text>

      <Pressable
        accessibilityLabel={`${label}、${selected?.label ?? placeholder}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled }}
        className={[
          'rounded-card border bg-white px-md py-sm',
          hasError ? 'border-red-500' : 'border-neutral-300',
          isDisabled ? 'opacity-50' : 'active:bg-neutral-50',
        ].join(' ')}
        disabled={isDisabled}
        onPress={() => {
          setIsOpen(true);
        }}
        testID={`${testID}-trigger`}
      >
        <Text
          className={[
            'font-body text-base',
            selected === undefined ? 'text-neutral-400' : 'text-neutral-900',
          ].join(' ')}
        >
          {selected?.label ?? placeholder}
        </Text>
      </Pressable>

      {hasError ? (
        <Text accessibilityRole="alert" className="font-body text-xs text-red-700">
          {errorMessage}
        </Text>
      ) : null}

      <Modal
        animationType="slide"
        onRequestClose={() => {
          setIsOpen(false);
        }}
        transparent
        visible={isOpen}
      >
        <Pressable
          accessibilityLabel="閉じる"
          accessibilityRole="button"
          className="flex-1 justify-end bg-black/50"
          onPress={() => {
            setIsOpen(false);
          }}
          testID={`${testID}-dismiss`}
        >
          <View className="gap-sm rounded-t-card bg-white p-lg">
            <Text className="font-heading text-base text-neutral-900">{label}</Text>
            <ScrollView style={{ maxHeight: OPTION_LIST_MAX_HEIGHT_PX }}>
              {options.map((option) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: option.value === value }}
                  className="rounded-card px-md py-sm active:bg-neutral-50"
                  key={option.value}
                  onPress={() => {
                    handleSelect(option.value);
                  }}
                  testID={`${testID}-option-${option.value}`}
                >
                  <Text
                    className={[
                      'font-body text-base',
                      option.value === value ? 'text-primary-600' : 'text-neutral-900',
                    ].join(' ')}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
```

- [ ] **Step 9: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- select-field && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（8 件）

- [ ] **Step 10: わざと壊して、語彙外の値と閉じる導線が守られていることを確認する**

1. `options.find(...)` を `options[options.findIndex((o) => o.value === value)]` に……ではなく、`selected?.label ?? placeholder` を `options.find((o) => o.value === value)!.label` に書き換える（`!` は lint で落ちるはずなので、落ちること自体も確認する）。lint が通ってしまう書き方にした場合は「語彙に無い値が来てもクラッシュせず」が落ちる。
2. `handleSelect` の `setIsOpen(false)` を消す → 「選ぶと onChange が呼ばれて閉じる」が落ちる。
3. `disabled={isDisabled}` を消す → 「isDisabled なら開かない」が落ちる。

3 つとも確認したら戻す。

- [ ] **Step 11: SegmentedControl の失敗するテストを書く**

`apps/mobile/src/components/ui/segmented-control.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { SegmentedControl, type SegmentOption } from './segmented-control';

type StatusValue = 'all' | 'pending' | 'approved';

const OPTIONS: readonly SegmentOption<StatusValue>[] = [
  { value: 'all', label: 'すべて' },
  { value: 'pending', label: '未処理' },
  { value: 'approved', label: '承認済' },
];

describe('SegmentedControl', () => {
  it('選択肢をすべて表示する', async () => {
    await render(<SegmentedControl onChange={jest.fn()} options={OPTIONS} value="all" />);

    for (const option of OPTIONS) {
      expect(screen.getByText(option.label)).toBeOnTheScreen();
    }
  });

  it('押すと onChange が呼ばれる', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl onChange={onChange} options={OPTIONS} testID="status" value="all" />,
    );

    await fireEvent.press(screen.getByTestId('status-segment-pending'));

    expect(onChange).toHaveBeenCalledWith('pending');
  });

  it('選択中を押しても onChange は呼ばれない（無駄な再取得を起こさない）', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl onChange={onChange} options={OPTIONS} testID="status" value="all" />,
    );

    await fireEvent.press(screen.getByTestId('status-segment-all'));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('選択中のセグメントに accessibilityState.selected が立つ', async () => {
    await render(
      <SegmentedControl onChange={jest.fn()} options={OPTIONS} testID="status" value="pending" />,
    );

    expect(screen.getByTestId('status-segment-pending').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('status-segment-all').props.accessibilityState.selected).toBe(false);
  });

  it('選択中と非選択で見た目が変わる', async () => {
    await render(
      <SegmentedControl onChange={jest.fn()} options={OPTIONS} testID="status" value="pending" />,
    );

    expect(String(screen.getByTestId('status-segment-pending').props.className)).toContain(
      'bg-white',
    );
    expect(String(screen.getByTestId('status-segment-all').props.className)).not.toContain(
      'bg-white',
    );
  });

  it('accessibilityRole は tablist / tab になる', async () => {
    await render(
      <SegmentedControl onChange={jest.fn()} options={OPTIONS} testID="status" value="all" />,
    );

    expect(screen.getByTestId('status').props.accessibilityRole).toBe('tablist');
    expect(screen.getByTestId('status-segment-all').props.accessibilityRole).toBe('tab');
  });
});
```

- [ ] **Step 12: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- segmented-control`
Expected: FAIL。`Cannot find module './segmented-control'`。

- [ ] **Step 13: SegmentedControl を実装する**

`apps/mobile/src/components/ui/segmented-control.tsx`

```tsx
import { Pressable, Text, View } from 'react-native';

export interface SegmentOption<TValue extends string> {
  value: TValue;
  label: string;
}

export interface SegmentedControlProps<TValue extends string> {
  value: TValue;
  options: readonly SegmentOption<TValue>[];
  onChange: (value: TValue) => void;
  testID?: string | undefined;
}

const DEFAULT_TEST_ID = 'segmented-control';

/** 選択中のセグメント。地の neutral-100 から白を持ち上げて現在地を示す */
const SELECTED_SEGMENT_STYLE = 'bg-white shadow-sm';
const UNSELECTED_SEGMENT_STYLE = 'active:bg-neutral-200';

/**
 * 3〜4 択を常時見せる切り替え。
 *
 * `SelectField` と使い分けること。モーダルを開かせると
 * 「今どれで絞り込んでいるか」が一覧を見ただけでは分からなくなる。
 * 選択肢が 5 つを超えるなら SelectField を使う。
 */
export function SegmentedControl<TValue extends string>({
  value,
  options,
  onChange,
  testID = DEFAULT_TEST_ID,
}: SegmentedControlProps<TValue>) {
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row gap-xs rounded-card bg-neutral-100 p-xs"
      testID={testID}
    >
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            className={[
              'flex-1 items-center rounded-card px-sm py-xs',
              isSelected ? SELECTED_SEGMENT_STYLE : UNSELECTED_SEGMENT_STYLE,
            ].join(' ')}
            key={option.value}
            onPress={() => {
              // 同じ値で onChange を呼ぶと、useQuery のキーは変わらないのに
              // 上位の setState が走って一覧が再描画される。押しても何も起きないのが正しい
              if (isSelected) {
                return;
              }
              onChange(option.value);
            }}
            testID={`${testID}-segment-${option.value}`}
          >
            <Text
              className={[
                'font-body-medium text-sm',
                isSelected ? 'text-neutral-900' : 'text-neutral-600',
              ].join(' ')}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
```

- [ ] **Step 14: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- segmented-control && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（6 件）

- [ ] **Step 15: わざと壊して確認する**

1. `if (isSelected) { return; }` を消す → 「選択中を押しても onChange は呼ばれない」が落ちる。
2. `accessibilityState={{ selected: isSelected }}` を `{{ selected: true }}` にする → 「選択中のセグメントに accessibilityState.selected が立つ」が落ちる。

両方戻す。

- [ ] **Step 16: カタログに 3 つを追加する**

`apps/mobile/src/app/_dev/catalog.tsx` は 8 つのプリミティブの見本を並べている。新しい 3 つも同じ形で足す。足さないと、次の担当者が既存プリミティブの存在に気づかず同じものを作り直す。

`catalog.tsx` の import に足す。

```tsx
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SegmentedControl, type SegmentOption } from '@/components/ui/segmented-control';
import { SelectField, type SelectOption } from '@/components/ui/select-field';
```

定数と見本セクションを足す。

```tsx
/** 見本用の選択肢。実際のロール語彙と同じ 3 つにする */
const CATALOG_ROLE_OPTIONS: readonly SelectOption<'user' | 'owner' | 'admin'>[] = [
  { value: 'user', label: '利用者' },
  { value: 'owner', label: '店舗管理者' },
  { value: 'admin', label: 'システム管理者' },
];

const CATALOG_STATUS_OPTIONS: readonly SegmentOption<'all' | 'pending' | 'approved'>[] = [
  { value: 'all', label: 'すべて' },
  { value: 'pending', label: '未処理' },
  { value: 'approved', label: '承認済' },
];
```

`CatalogScreen` の JSX に 3 セクションを足す。カタログは状態を持たないので `value` は固定、ハンドラは既存の `noop` を使う。

```tsx
      <Section title="SelectField">
        <SelectField
          label="ロール"
          onChange={noop}
          options={CATALOG_ROLE_OPTIONS}
          value="owner"
        />
      </Section>

      <Section title="SegmentedControl">
        <SegmentedControl onChange={noop} options={CATALOG_STATUS_OPTIONS} value="pending" />
      </Section>

      <Section title="ConfirmDialog">
        <ConfirmDialog
          confirmLabel="停止する"
          isDestructive
          isVisible={false}
          message="停止するとログインできなくなります。あとから復帰できます。"
          onCancel={noop}
          onConfirm={noop}
          title="このユーザーを停止しますか？"
        />
      </Section>
```

`ConfirmDialog` は `isVisible={false}` で置く。カタログを開いた瞬間にモーダルが全画面を覆うと、他の見本が見えなくなるため。

`apps/mobile/src/app/_dev/catalog.test.tsx` に見出しの存在確認を 3 件足す。

```tsx
it.each(['SelectField', 'SegmentedControl', 'ConfirmDialog'])(
  '%s のセクションがある',
  async (title) => {
    await render(<CatalogScreen />);

    expect(screen.getByText(title)).toBeOnTheScreen();
  },
);
```

- [ ] **Step 17: 全部通ることを確認する**

Run: `npm test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint -w @meshimap/mobile`
Expected: PASS。カバレッジは `src/app/**` を除く全ファイルで 100%（`jest.config.js` の `coverageThreshold.global` が 4 指標とも 100）。

- [ ] **Step 18: コミットする**

```bash
cd /Users/hattori/Downloads/alee
git add apps/mobile/src/components/ui apps/mobile/src/app/_dev
git commit -m "feat(mobile): 確認ダイアログ・選択フィールド・セグメント切替を追加"
```

---

### Task 9-19: モバイルの型・API 呼び出し・クエリ層

13 画面が触る 32 エンドポイントを、画面より先に 1 か所へ固める。画面ごとに `apiFetch` を直接呼ぶと、パスとクエリ名が 13 通りに散り、サーバ側でパスを変えたときに壊れる画面を探せなくなる。

**この層の方針を 4 つ決めておく。**

1. **応答は必ず zod で検査してから画面へ渡す。** `apiFetch` が返すのは JSON.parse の結果で、型は誰も保証していない。`as` で型を名乗らせると、サーバが列を消したときに画面の中で `undefined` を描画して気づけない。
2. **型の定義元は zod スキーマ 1 つ。** `z.output<typeof schema>` で TS 型を導く。手書きの型とスキーマを二重に持つと必ずずれる。
3. **語彙（状態の文字列）はサーバの `apps/api/src/db/constants.ts` と突き合わせる。** モバイルから api のソースは import できない（別アプリ）ので値は書き写すしかないが、**書き写しのずれはテストで機械的に落とす**。
4. **表示名は `Record<語彙, string>` で持つ。** 語彙に値を足した瞬間に型エラーになるので、ラベルの付け忘れがコンパイルで止まる。

**Files:**

- Create: `apps/mobile/src/features/admin/types.ts`
- Create: `apps/mobile/src/features/admin/types.test.ts`
- Create: `apps/mobile/src/features/admin/labels.ts`
- Create: `apps/mobile/src/features/admin/labels.test.ts`
- Create: `apps/mobile/src/features/admin/api.ts`
- Create: `apps/mobile/src/features/admin/api.test.ts`
- Create: `apps/mobile/src/features/admin/queries.ts`
- Create: `apps/mobile/src/features/admin/queries.test.tsx`
- Modify: `apps/mobile/src/constants/http.ts`
- Modify: `apps/mobile/src/constants/http.test.ts`

**Interfaces:**

- Consumes:
  - `@/lib/api-client` の `apiFetch`（Phase 5。**このタスクの着手条件**）
  - `@meshimap/core` の `ROLES` / `Role`
  - `@/constants/http` の `HTTP_STATUS`
  - `@tanstack/react-query` の `useQuery` / `useInfiniteQuery` / `useMutation` / `useQueryClient`
- Produces:
  - `types.ts`: `APPLICATION_STATUSES` / `REPORT_STATUSES` / `REPORT_TARGET_TYPES` / `PROFILE_STATUSES` / `SHOP_STATUSES` / `REPORT_DECISIONS` / `APPLICATION_DECISIONS` / `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES` と、同名の単数形の型。`AdminOverview` / `AdminApplicationSummary` / `AdminApplicationDetail` / `AdminReportSummary` / `AdminReportDetail` / `AdminUserSummary` / `AdminUserDetail` / `AdminShopSummary` / `AdminShopDetail` / `AdminGenre` / `AdminArea` / `AnnouncementHistoryItem` / `AuditLogItem` / `AnnouncementAudience` / `CursorPage<TItem>`
  - `labels.ts`: `APPLICATION_STATUS_LABELS` ほか 10 個の `Record` と `toSelectOptions`
  - `api.ts`: 32 エンドポイントに対応する関数、`AdminResponseError`、`statusOf`、`toAdminErrorMessage`
  - `queries.ts`: `adminQueryKeys` と 30 個のフック（取得系 13 / 書き込み系 17）

- [ ] **Step 1: 着手条件を確かめる**

```bash
cd /Users/hattori/Downloads/alee
cat apps/mobile/src/lib/api-client.ts
```

`apiFetch` の実シグネチャを**目で読む**こと。この計画は次の 2 点だけを前提にしている。

- 第 1 引数がパス文字列
- 第 2 引数が `{ method, searchParams?, body? }` のオブジェクト

戻り値は `Promise<unknown>` でも `<T>(...): Promise<T>` でもこのタスクのコードは通る（`const payload: unknown = await apiFetch(...)` と書くので、ジェネリックなら `T` が `unknown` に推論される）。**`apiFetch<Foo>(...)` のように型引数で型を名乗らせる書き方はしない。**検証していない型を名乗ることになるため。

第 2 引数のキー名が違った場合は、この計画のキー名を実装に合わせて読み替えること。**逆に api-client を書き換えないこと**（Phase 5 の他の利用者が壊れる）。

- [ ] **Step 2: 語彙の突き合わせテストを書く**

`apps/mobile/src/features/admin/types.test.ts`

```tsx
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '@meshimap/core';

import {
  APPLICATION_STATUSES,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  PROFILE_STATUSES,
  REPORT_DECISIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  SHOP_STATUSES,
} from './types';

/**
 * サーバ側の定義元。
 *
 * `import.meta.url` ではなく `__dirname` を使う。jest-expo は babel で
 * CommonJS に変換するため、テストの中で `import.meta` は使えない。
 */
const API_SRC_DIR = join(__dirname, '..', '..', '..', '..', 'api', 'src');
const dbConstantsSource = readFileSync(join(API_SRC_DIR, 'db', 'constants.ts'), 'utf8');
const auditLogSource = readFileSync(join(API_SRC_DIR, 'lib', 'audit-log.ts'), 'utf8');
const reportRepositorySource = readFileSync(
  join(API_SRC_DIR, 'repositories', 'admin-report-repository.ts'),
  'utf8',
);

/** `export const NAME = '値';` の値を取り出す */
function readLiteral(source: string, name: string): string {
  const matched = new RegExp(`export const ${name} = '([^']+)';`).exec(source);
  const value = matched?.[1];
  if (value === undefined) {
    throw new Error(`定数 ${name} の文字列リテラルを読み取れませんでした`);
  }
  return value;
}

/** `開始` と `終端` に挟まれた中身を返す */
function sliceBlock(source: string, opening: string, closing: string): string {
  const start = source.indexOf(opening);
  if (start < 0) {
    throw new Error(`${opening} が見つかりませんでした`);
  }
  const end = source.indexOf(closing, start);
  if (end < 0) {
    throw new Error(`${opening} に対応する ${closing} が見つかりませんでした`);
  }
  return source.slice(start + opening.length, end);
}

/**
 * `export const XXXS = [A, B] as const;` の要素をたどり、
 * それぞれの `export const A = '値';` を引いて値の配列にする。
 *
 * 定数宣言を総当たりで拾うのではなく配列の中身をたどるのは、
 * 「宣言はあるが配列に入っていない」値を語彙に数えないため。
 */
function readApiVocabulary(source: string, arrayName: string): readonly string[] {
  const body = sliceBlock(source, `export const ${arrayName} = [`, '] as const;');
  return body
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => readLiteral(source, name));
}

/** `export const NAME = { key: '値', ... } as const;` の値の配列 */
function readApiObjectValues(source: string, objectName: string): readonly string[] {
  const body = sliceBlock(source, `export const ${objectName} = {`, '} as const;');
  return [...body.matchAll(/:\s*'([^']+)'/g)].map((matched) => {
    const value = matched[1];
    if (value === undefined) {
      throw new Error(`${objectName} の値を読み取れませんでした`);
    }
    return value;
  });
}

describe('サーバの語彙との一致', () => {
  it.each([
    ['APPLICATION_STATUSES', APPLICATION_STATUSES],
    ['REPORT_STATUSES', REPORT_STATUSES],
    ['REPORT_TARGET_TYPES', REPORT_TARGET_TYPES],
    ['PROFILE_STATUSES', PROFILE_STATUSES],
    ['SHOP_STATUSES', SHOP_STATUSES],
  ])('%s が apps/api/src/db/constants.ts と一致する', (arrayName, mobileValues) => {
    expect([...mobileValues].sort()).toEqual(
      [...readApiVocabulary(dbConstantsSource, arrayName)].sort(),
    );
  });

  it('AUDIT_ACTIONS が apps/api/src/lib/audit-log.ts と一致する', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [...readApiObjectValues(auditLogSource, 'AUDIT_ACTIONS')].sort(),
    );
  });

  it('AUDIT_TARGET_TYPES が apps/api/src/lib/audit-log.ts と一致する', () => {
    expect([...AUDIT_TARGET_TYPES].sort()).toEqual(
      [...readApiObjectValues(auditLogSource, 'AUDIT_TARGET_TYPES')].sort(),
    );
  });

  it('REPORT_DECISIONS が admin-report-repository.ts と一致する', () => {
    expect([...REPORT_DECISIONS].sort()).toEqual(
      [...readApiObjectValues(reportRepositorySource, 'REPORT_DECISIONS')].sort(),
    );
  });

  it('ROLES は @meshimap/core を共有していて書き写していない', () => {
    // ロールだけは共有パッケージにあるので、モバイル側で再定義してはいけない。
    // types.ts に ROLES が現れたらこのテストが落ちる
    const typesSource = readFileSync(join(__dirname, 'types.ts'), 'utf8');
    expect(typesSource).not.toContain('ROLES = [');
    expect(ROLES.length).toBeGreaterThan(0);
  });
});

describe('語彙そのもの', () => {
  it.each([
    ['APPLICATION_STATUSES', APPLICATION_STATUSES],
    ['REPORT_STATUSES', REPORT_STATUSES],
    ['REPORT_TARGET_TYPES', REPORT_TARGET_TYPES],
    ['PROFILE_STATUSES', PROFILE_STATUSES],
    ['SHOP_STATUSES', SHOP_STATUSES],
    ['REPORT_DECISIONS', REPORT_DECISIONS],
    ['AUDIT_ACTIONS', AUDIT_ACTIONS],
    ['AUDIT_TARGET_TYPES', AUDIT_TARGET_TYPES],
  ])('%s に重複が無い', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });
});
```

**この突き合わせの弱点を明記しておく。** api のソースを正規表現で読むので、api 側が書式を変えると（たとえば `export const SHOP_STATUS_DRAFT = "draft";` とダブルクォートにする）テストは**値のずれではなく読み取り失敗で落ちる**。落ちたときにテストを緩めず、`readLiteral` の正規表現を実際の書式に合わせること。prettier の設定（ルート `.prettierrc` の `singleQuote`）がある限りシングルクォートは安定している。

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/types`
Expected: FAIL。`Cannot find module './types'`。

- [ ] **Step 4: types.ts を書く**

`apps/mobile/src/features/admin/types.ts`

```ts
import { ROLES } from '@meshimap/core';
import { z } from 'zod';

/**
 * 管理画面が扱う語彙と、API 応答の形。
 *
 * 型はすべて zod スキーマから `z.output` で導く。手書きの型を別に置くと、
 * スキーマだけ直して型を直し忘れたときに「検査は通るのに画面が古い型で動く」状態になる。
 *
 * 値（状態の文字列）は apps/api/src/db/constants.ts の写し。別アプリなので import できない。
 * 写し間違いは types.test.ts がサーバのソースと突き合わせて落とす。
 *
 * DTO のプロパティに `readonly` を付けていないのは、スキーマから導いた型に
 * readonly を足すには `.readonly()` を挟んだ別スキーマが要り、
 * 「検査に使うスキーマ」と「型を導くスキーマ」が二重になるため。
 * この層が返す値は画面が描画するだけで、変更は必ず mutation 経由でサーバに送る。
 */

export const APPLICATION_STATUSES = ['pending', 'approved', 'rejected', 'returned'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const REPORT_STATUSES = ['open', 'in_review', 'resolved', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TARGET_TYPES = ['shop', 'review', 'user'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const PROFILE_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const SHOP_STATUSES = ['draft', 'pending', 'published', 'suspended', 'closed'] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];

/** 通報への対応。値はサーバの REPORT_DECISIONS と同じ */
export const REPORT_DECISIONS = ['hide-content', 'suspend-user', 'warn'] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

/**
 * 申請の審査結果。サーバ側は 3 本のエンドポイントに分かれていて語彙としては存在しないが、
 * URL の末尾がこの 3 語そのものなので、画面側では 1 つの語彙として扱う。
 */
export const APPLICATION_DECISIONS = ['approve', 'return', 'reject'] as const;
export type ApplicationDecision = (typeof APPLICATION_DECISIONS)[number];

/** 監査ログの action。サーバの AUDIT_ACTIONS と同じ */
export const AUDIT_ACTIONS = [
  'application.approve',
  'application.return',
  'application.reject',
  'report.resolve',
  'report.reject',
  'report.warn',
  'review.hide',
  'review.restore',
  'user.suspend',
  'user.restore',
  'user.role_change',
  'shop.suspend',
  'shop.restore',
  'shop.owner_assign',
  'genre.create',
  'genre.update',
  'genre.delete',
  'area.create',
  'area.update',
  'area.delete',
  'announcement.send',
  'audit.undo',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 監査ログの targetType。サーバの AUDIT_TARGET_TYPES と同じ */
export const AUDIT_TARGET_TYPES = [
  'shop_application',
  'report',
  'review',
  'user',
  'shop',
  'genre',
  'area',
  'announcement',
  'audit_log',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * カーソルページの共通形。
 * `nextCursor` が null なら次のページは無い。TanStack Query の `getNextPageParam` は
 * 戻り値が `!= null` のときだけ次ページ有りと判定する
 * （node_modules/@tanstack/query-core/build/modern/infiniteQueryBehavior.js:84 で確認）ので、
 * null をそのまま返せる。
 */
export function cursorPageSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export type CursorPage<TItem> = { items: TItem[]; nextCursor: string | null };

export const overviewSchema = z.object({
  windowDays: z.number(),
  newShopCount: z.number(),
  newReviewCount: z.number(),
  newUserCount: z.number(),
  pendingApplicationCount: z.number(),
  openReportCount: z.number(),
});
export type AdminOverview = z.output<typeof overviewSchema>;

export const applicationSummarySchema = z.object({
  applicationId: z.string(),
  shopId: z.string(),
  shopName: z.string(),
  applicantId: z.string(),
  applicantName: z.string(),
  status: z.enum(APPLICATION_STATUSES),
  documentCount: z.number(),
  createdAtMs: z.number(),
});
export type AdminApplicationSummary = z.output<typeof applicationSummarySchema>;

const applicationDocumentSchema = z.object({ kind: z.string(), r2Key: z.string() });
export type ApplicationDocument = z.output<typeof applicationDocumentSchema>;

export const applicationDetailSchema = applicationSummarySchema.extend({
  documents: z.array(applicationDocumentSchema),
  reviewNote: z.string().nullable(),
  reviewedBy: z.string().nullable(),
});
export type AdminApplicationDetail = z.output<typeof applicationDetailSchema>;

export const reportSummarySchema = z.object({
  reportId: z.string(),
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string(),
  reason: z.string(),
  status: z.enum(REPORT_STATUSES),
  reporterId: z.string().nullable(),
  createdAtMs: z.number(),
});
export type AdminReportSummary = z.output<typeof reportSummarySchema>;

export const reportDetailSchema = reportSummarySchema.extend({
  detail: z.string().nullable(),
  targetSummary: z.string().nullable(),
  handledBy: z.string().nullable(),
  handledAtMs: z.number().nullable(),
});
export type AdminReportDetail = z.output<typeof reportDetailSchema>;

export const userSummarySchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  status: z.enum(PROFILE_STATUSES),
  createdAtMs: z.number(),
});
export type AdminUserSummary = z.output<typeof userSummarySchema>;

export const userDetailSchema = userSummarySchema.extend({
  bio: z.string().nullable(),
  reviewCount: z.number(),
  shopCount: z.number(),
});
export type AdminUserDetail = z.output<typeof userDetailSchema>;

export const shopSummarySchema = z.object({
  shopId: z.string(),
  name: z.string(),
  status: z.enum(SHOP_STATUSES),
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  createdAtMs: z.number(),
});
export type AdminShopSummary = z.output<typeof shopSummarySchema>;

export const shopDetailSchema = shopSummarySchema.extend({
  address: z.string(),
  reviewCount: z.number(),
  openReportCount: z.number(),
});
export type AdminShopDetail = z.output<typeof shopDetailSchema>;

export const genreSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  iconKey: z.string().nullable(),
  sortOrder: z.number(),
});
export type AdminGenre = z.output<typeof genreSchema>;

export const areaSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  prefecture: z.string(),
});
export type AdminArea = z.output<typeof areaSchema>;

export const announcementHistorySchema = z.object({
  announcementId: z.string(),
  title: z.string(),
  audience: z.string(),
  recipientCount: z.number(),
  sentBy: z.string().nullable(),
  sentAtMs: z.number(),
});
export type AnnouncementHistoryItem = z.output<typeof announcementHistorySchema>;

/**
 * 監査ログの差分。列名 → [変更前, 変更後]。
 * 中身の型はサーバの列の型次第なので `unknown` のまま受け、画面では文字列化して見せる。
 */
const auditLogDiffSchema = z.record(z.string(), z.tuple([z.unknown(), z.unknown()]));
export type AuditLogDiff = z.output<typeof auditLogDiffSchema>;

/**
 * 監査ログ。
 *
 * `action` と `targetType` を `z.enum` で縛らない唯一の場所。過去のログは当時の語彙で
 * 残っているので、語彙を増減したときに古いログが表示できなくなるのを避ける。
 * 絞り込みの選択肢だけは `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES` から作る。
 */
export const auditLogSchema = z.object({
  auditLogId: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  diff: auditLogDiffSchema.nullable(),
  createdAtMs: z.number(),
  undoable: z.boolean(),
});
export type AuditLogItem = z.output<typeof auditLogSchema>;

/** お知らせの宛先。全員 / ロール指定 / 個別指定の 3 択 */
export const announcementAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('role'), role: z.enum(ROLES) }),
  z.object({ kind: z.literal('users'), userIds: z.array(z.string()).min(1) }),
]);
export type AnnouncementAudience = z.output<typeof announcementAudienceSchema>;
```

`z.enum(ROLES)` に `readonly ['user','owner','admin']` を渡せることは Task 9-13 で確認済み（`node_modules/zod/v4/classic/schemas.d.cts:610` の `_enum<const T extends readonly string[]>`）。`ZodObject.extend(shape)` も同ファイル 502 行に定義がある（`extend<U extends core.$ZodLooseShape>(shape: U): ZodObject<util.Extend<Shape, util.Writeable<U>>, Config>`）ので、詳細スキーマは一覧スキーマを伸ばして書ける。列名を 2 度書かないこと自体が、一覧と詳細のずれを防ぐ。

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/types && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**17 件**）。`it.each` が展開されるので `it` の行数（6 行）とは一致しない。内訳は `describe('サーバの語彙との一致')` が `it.each` 5 行ぶん + 単発 4 件 = 9 件、`describe('語彙そのもの')` が `it.each` 8 行ぶん = 8 件。

- [ ] **Step 6: わざと壊して、語彙の突き合わせが効いていることを確認する**

1. `types.ts` の `REPORT_STATUSES` から `'in_review'` を消す → 「REPORT_STATUSES が apps/api/src/db/constants.ts と一致する」が落ちる。
2. `AUDIT_ACTIONS` の `'user.role_change'` を `'user.roleChange'` にする → 「AUDIT_ACTIONS が … と一致する」が落ちる。**サーバの `ck_audit_logs_action` は大文字を弾くので、これを見逃すと実機で 422 になる。**
3. `SHOP_STATUSES` に `'archived'` を足す → 一致テストが落ちる。

3 つとも確認したら戻す。

- [ ] **Step 7: 表示名の失敗するテストを書く**

`apps/mobile/src/features/admin/labels.test.ts`

```tsx
import { ROLES } from '@meshimap/core';

import {
  APPLICATION_DECISION_LABELS,
  APPLICATION_STATUS_LABELS,
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_TYPE_LABELS,
  PROFILE_STATUS_LABELS,
  REPORT_DECISION_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TARGET_TYPE_LABELS,
  ROLE_LABELS,
  SHOP_STATUS_LABELS,
  toSelectOptions,
} from './labels';
import {
  APPLICATION_DECISIONS,
  APPLICATION_STATUSES,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  PROFILE_STATUSES,
  REPORT_DECISIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  SHOP_STATUSES,
} from './types';

/** 語彙とラベル表の組。ここに足し忘れると新しい語彙が検査されないので、数も突き合わせる */
const LABEL_TABLES: ReadonlyArray<
  readonly [name: string, values: readonly string[], labels: Readonly<Record<string, string>>]
> = [
  ['APPLICATION_STATUS', APPLICATION_STATUSES, APPLICATION_STATUS_LABELS],
  ['REPORT_STATUS', REPORT_STATUSES, REPORT_STATUS_LABELS],
  ['REPORT_TARGET_TYPE', REPORT_TARGET_TYPES, REPORT_TARGET_TYPE_LABELS],
  ['PROFILE_STATUS', PROFILE_STATUSES, PROFILE_STATUS_LABELS],
  ['SHOP_STATUS', SHOP_STATUSES, SHOP_STATUS_LABELS],
  ['REPORT_DECISION', REPORT_DECISIONS, REPORT_DECISION_LABELS],
  ['APPLICATION_DECISION', APPLICATION_DECISIONS, APPLICATION_DECISION_LABELS],
  ['AUDIT_ACTION', AUDIT_ACTIONS, AUDIT_ACTION_LABELS],
  ['AUDIT_TARGET_TYPE', AUDIT_TARGET_TYPES, AUDIT_TARGET_TYPE_LABELS],
  ['ROLE', ROLES, ROLE_LABELS],
];

describe('表示名', () => {
  it.each(LABEL_TABLES)('%s のキーが語彙とちょうど一致する', (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
  });

  it.each(LABEL_TABLES)('%s のラベルが空でない', (_name, _values, labels) => {
    for (const label of Object.values(labels)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it.each(LABEL_TABLES)('%s のラベルに重複が無い', (_name, _values, labels) => {
    // 同じ表の中で同じ日本語が 2 つあると、画面を見ても区別が付かない
    const labelValues = Object.values(labels);
    expect(new Set(labelValues).size).toBe(labelValues.length);
  });

  it('日本語で書かれている（英語のまま出していない）', () => {
    // 値をそのまま表示名にすると運用者が読めない。値と同じ文字列はラベルとして認めない
    for (const [, values, labels] of LABEL_TABLES) {
      for (const value of values) {
        expect(labels[value]).not.toBe(value);
      }
    }
  });
});

describe('toSelectOptions', () => {
  it('語彙の並び順のまま value と label の組にする', () => {
    expect(toSelectOptions(REPORT_TARGET_TYPES, REPORT_TARGET_TYPE_LABELS)).toEqual([
      { value: 'shop', label: '店舗' },
      { value: 'review', label: 'レビュー' },
      { value: 'user', label: 'ユーザー' },
    ]);
  });

  it('語彙の一部だけでも組にできる', () => {
    expect(toSelectOptions(['open'], REPORT_STATUS_LABELS)).toEqual([
      { value: 'open', label: '未対応' },
    ]);
  });
});
```

- [ ] **Step 8: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/labels`
Expected: FAIL。`Cannot find module './labels'`。

- [ ] **Step 9: labels.ts を書く**

`apps/mobile/src/features/admin/labels.ts`

```ts
import type { Role } from '@meshimap/core';

import type { SelectOption } from '@/components/ui/select-field';

import type {
  ApplicationDecision,
  ApplicationStatus,
  AuditAction,
  AuditTargetType,
  ProfileStatus,
  ReportDecision,
  ReportStatus,
  ReportTargetType,
  ShopStatus,
} from './types';

/**
 * 語彙 → 画面に出す日本語。
 *
 * `Record<語彙, string>` にしてあるのが肝で、types.ts の語彙に値を足した瞬間に
 * 「キーが足りない」でコンパイルが止まる。ラベルの付け忘れを目視に頼らない。
 * 逆に語彙に無いキーを書くと余剰プロパティとしてこれも止まる。
 */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  pending: '審査待ち',
  approved: '承認済み',
  rejected: '却下',
  returned: '差し戻し',
};

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  open: '未対応',
  in_review: '確認中',
  resolved: '対応済み',
  rejected: '却下',
};

export const REPORT_TARGET_TYPE_LABELS: Record<ReportTargetType, string> = {
  shop: '店舗',
  review: 'レビュー',
  user: 'ユーザー',
};

export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  active: '利用中',
  suspended: '停止中',
  deleted: '退会済み',
};

export const SHOP_STATUS_LABELS: Record<ShopStatus, string> = {
  draft: '下書き',
  pending: '審査中',
  published: '公開中',
  suspended: '停止中',
  closed: '閉店',
};

export const ROLE_LABELS: Record<Role, string> = {
  user: '利用者',
  owner: '店舗管理者',
  admin: 'システム管理者',
};

export const REPORT_DECISION_LABELS: Record<ReportDecision, string> = {
  'hide-content': '投稿を非公開にする',
  'suspend-user': '投稿者を停止する',
  warn: '警告を送る',
};

export const APPLICATION_DECISION_LABELS: Record<ApplicationDecision, string> = {
  approve: '承認する',
  return: '差し戻す',
  reject: '却下する',
};

/** 監査ログの action。運用者が「誰が何をしたか」を読める文にする */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'application.approve': '申請を承認',
  'application.return': '申請を差し戻し',
  'application.reject': '申請を却下',
  'report.resolve': '通報に対応',
  'report.reject': '通報を却下',
  'report.warn': '利用者へ警告',
  'review.hide': 'レビューを非公開',
  'review.restore': 'レビューを再公開',
  'user.suspend': 'ユーザーを停止',
  'user.restore': 'ユーザーを復帰',
  'user.role_change': 'ロールを変更',
  'shop.suspend': '店舗を非公開',
  'shop.restore': '店舗を再公開',
  'shop.owner_assign': '店舗のオーナーを変更',
  'genre.create': 'ジャンルを追加',
  'genre.update': 'ジャンルを更新',
  'genre.delete': 'ジャンルを削除',
  'area.create': 'エリアを追加',
  'area.update': 'エリアを更新',
  'area.delete': 'エリアを削除',
  'announcement.send': 'お知らせを配信',
  'audit.undo': '操作を取り消し',
};

export const AUDIT_TARGET_TYPE_LABELS: Record<AuditTargetType, string> = {
  shop_application: '店舗申請',
  report: '通報',
  review: 'レビュー',
  user: 'ユーザー',
  shop: '店舗',
  genre: 'ジャンル',
  area: 'エリア',
  announcement: 'お知らせ',
  audit_log: '監査ログ',
};

/**
 * 語彙とラベル表から選択肢を作る。
 *
 * 戻り値は `SelectOption` だが `SegmentOption` と同じ形なので、
 * `SegmentedControl` にもそのまま渡せる（どちらも `{ value, label }`）。
 */
export function toSelectOptions<TValue extends string>(
  values: readonly TValue[],
  labels: Record<TValue, string>,
): SelectOption<TValue>[] {
  return values.map((value) => ({ value, label: labels[value] }));
}
```

- [ ] **Step 10: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/labels && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**33 件**）。`it.each` が展開されるので `it` の行数（6 行）とは一致しない。内訳は `describe('表示名')` が `it.each(LABEL_TABLES)` 3 本 × `LABEL_TABLES` の 10 行 = 30 件 + 単発 1 件 = 31 件、`describe('toSelectOptions')` が 2 件。**`LABEL_TABLES` に表を 1 つ足すたびにこの件数は 3 ずつ増える。**

わざと壊す。

1. `AUDIT_ACTION_LABELS` から `'audit.undo'` の行を消す。
   Run: `npm run typecheck -w @meshimap/mobile`
   Expected: FAIL。`Property 'audit.undo' is missing`。**テストを走らせる前にコンパイルで止まる**のがこの設計の狙い。
2. 戻してから `REPORT_STATUS_LABELS.resolved` を `'却下'` にする（`rejected` と同じ文言にする）。
   Run: `npm test -w @meshimap/mobile -- features/admin/labels`
   Expected: FAIL。「REPORT_STATUS のラベルに重複が無い」が落ちる。
3. 戻してから `SHOP_STATUS_LABELS.draft` を `'draft'` にする。
   Expected: FAIL。「日本語で書かれている」が落ちる。

3 つとも戻す。

- [ ] **Step 11: HTTP ステータスの定数を 2 つ足す**

管理画面は 404（対象が消えている）と 422（入力が通らない）を利用者に説明し分ける必要がある。`apps/mobile/src/constants/http.ts` を書き換える。

```ts
/** 認証・認可・管理操作の分岐に使う HTTP ステータス。数値の直書きを避けるために名前を付ける */
export const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessableEntity: 422,
  tooManyRequests: 429,
} as const;
```

`apps/mobile/src/constants/http.test.ts` の 1 件目の期待値を合わせる。

```tsx
it('認証・認可と管理操作の分岐で使う 6 つのステータスを持つ', () => {
  expect(HTTP_STATUS).toEqual({
    unauthorized: 401,
    forbidden: 403,
    notFound: 404,
    conflict: 409,
    unprocessableEntity: 422,
    tooManyRequests: 429,
  });
});
```

2 件目の「すべてクライアントエラー（4xx）の範囲に収まる」はそのままで、足した 2 つも自動的に検査される。

Run: `npm test -w @meshimap/mobile -- constants/http`
Expected: PASS（2 件）

- [ ] **Step 12: API 呼び出しの失敗するテストを書く**

`apps/mobile/src/features/admin/api.test.ts`

```tsx
import { ROLE_OWNER } from '@meshimap/core';

import { HTTP_STATUS } from '@/constants/http';
import { apiFetch } from '@/lib/api-client';

import {
  AdminResponseError,
  assignShopOwner,
  changeUserRole,
  createArea,
  createGenre,
  deleteArea,
  deleteGenre,
  fetchAnnouncementHistory,
  fetchApplication,
  fetchApplications,
  fetchAreas,
  fetchAuditLogs,
  fetchGenres,
  fetchOverview,
  fetchReport,
  fetchReports,
  fetchShop,
  fetchShops,
  fetchUser,
  fetchUsers,
  rejectReport,
  resolveReport,
  restoreShop,
  restoreUser,
  reviewApplication,
  sendAnnouncement,
  statusOf,
  suspendShop,
  suspendUser,
  toAdminErrorMessage,
  toSearchParams,
  undoAuditLog,
  updateArea,
  updateGenre,
} from './api';

// babel-plugin-jest-hoist が jest.mock を import より上へ巻き上げるので、
// 上の import には差し替え後の実体が入る（先に書く必要はない）
jest.mock('@/lib/api-client', () => ({ apiFetch: jest.fn() }));

const apiFetchMock = jest.mocked(apiFetch);

const OVERVIEW = {
  windowDays: 30,
  newShopCount: 1,
  newReviewCount: 2,
  newUserCount: 3,
  pendingApplicationCount: 4,
  openReportCount: 5,
};

const APPLICATION_SUMMARY = {
  applicationId: 'app_1',
  shopId: 'shp_1',
  shopName: '一番亭',
  applicantId: 'usr_1',
  applicantName: '田中',
  status: 'pending',
  documentCount: 2,
  createdAtMs: 1_700_000_000_000,
};

const APPLICATION_DETAIL = {
  ...APPLICATION_SUMMARY,
  documents: [{ kind: 'license', r2Key: 'apps/app_1/license.pdf' }],
  reviewNote: null,
  reviewedBy: null,
};

const REPORT_SUMMARY = {
  reportId: 'rpt_1',
  targetType: 'review',
  targetId: 'rvw_1',
  reason: 'spam',
  status: 'open',
  reporterId: 'usr_2',
  createdAtMs: 1_700_000_000_000,
};

const REPORT_DETAIL = {
  ...REPORT_SUMMARY,
  detail: '同じ文が繰り返されている',
  targetSummary: '安い！安い！安い！',
  handledBy: null,
  handledAtMs: null,
};

const USER_SUMMARY = {
  userId: 'usr_1',
  displayName: '田中',
  email: 'tanaka@example.com',
  role: 'user',
  status: 'active',
  createdAtMs: 1_700_000_000_000,
};

const USER_DETAIL = { ...USER_SUMMARY, bio: null, reviewCount: 3, shopCount: 0 };

const SHOP_SUMMARY = {
  shopId: 'shp_1',
  name: '一番亭',
  status: 'published',
  ownerId: 'usr_9',
  ownerName: '佐藤',
  createdAtMs: 1_700_000_000_000,
};

const SHOP_DETAIL = {
  ...SHOP_SUMMARY,
  address: '東京都渋谷区1-1',
  reviewCount: 5,
  openReportCount: 0,
};

const GENRE = { id: 'gnr_ramen', name: 'ラーメン', slug: 'ramen', iconKey: 'ramen', sortOrder: 10 };
const AREA = { id: 'are_shibuya', name: '渋谷', parentId: null, prefecture: '東京都' };

const ANNOUNCEMENT_HISTORY = {
  announcementId: 'ann_0123456789ab',
  title: 'メンテナンス',
  audience: 'all',
  recipientCount: 120,
  sentBy: 'usr_admin',
  sentAtMs: 1_700_000_000_000,
};

const AUDIT_LOG = {
  auditLogId: 'aud_1',
  actorId: 'usr_admin',
  actorName: '管理者',
  action: 'user.suspend',
  targetType: 'user',
  targetId: 'usr_1',
  diff: { status: ['active', 'suspended'] },
  createdAtMs: 1_700_000_000_000,
  undoable: true,
};

const page = (item: unknown) => ({ items: [item], nextCursor: null });
const OK = { result: 'ok' };

/** 呼び出し 1 件ぶんの期待。path と options をまるごと突き合わせる */
type CallCase = {
  readonly name: string;
  readonly run: () => Promise<unknown>;
  readonly payload: unknown;
  readonly path: string;
  readonly options: Record<string, unknown>;
};

const CALL_CASES: readonly CallCase[] = [
  {
    name: 'fetchOverview',
    run: () => fetchOverview(),
    payload: OVERVIEW,
    path: '/admin/stats/overview',
    options: { method: 'GET' },
  },
  {
    name: 'fetchApplications（絞り込み無し）',
    run: () => fetchApplications({ status: null, cursor: null }),
    payload: page(APPLICATION_SUMMARY),
    path: '/admin/applications',
    options: { method: 'GET', searchParams: {} },
  },
  {
    name: 'fetchApplications（状態とカーソル付き）',
    run: () => fetchApplications({ status: 'pending', cursor: '100:app_9' }),
    payload: page(APPLICATION_SUMMARY),
    path: '/admin/applications',
    options: { method: 'GET', searchParams: { status: 'pending', cursor: '100:app_9' } },
  },
  {
    name: 'fetchApplication',
    run: () => fetchApplication('app_1'),
    payload: APPLICATION_DETAIL,
    path: '/admin/applications/app_1',
    options: { method: 'GET' },
  },
  {
    name: 'reviewApplication（承認は本文を送らない）',
    run: () => reviewApplication('app_1', { decision: 'approve' }),
    payload: OK,
    path: '/admin/applications/app_1/approve',
    options: { method: 'POST' },
  },
  {
    name: 'reviewApplication（差し戻しは理由を送る）',
    run: () => reviewApplication('app_1', { decision: 'return', reviewNote: '書類が不鮮明です' }),
    payload: OK,
    path: '/admin/applications/app_1/return',
    options: { method: 'POST', body: { reviewNote: '書類が不鮮明です' } },
  },
  {
    name: 'reviewApplication（却下も理由を送る）',
    run: () =>
      reviewApplication('app_1', { decision: 'reject', reviewNote: '実在を確認できません' }),
    payload: OK,
    path: '/admin/applications/app_1/reject',
    options: { method: 'POST', body: { reviewNote: '実在を確認できません' } },
  },
  {
    name: 'fetchReports',
    run: () => fetchReports({ status: 'open', targetType: 'review', cursor: null }),
    payload: page(REPORT_SUMMARY),
    path: '/admin/reports',
    options: { method: 'GET', searchParams: { status: 'open', targetType: 'review' } },
  },
  {
    name: 'fetchReport',
    run: () => fetchReport('rpt_1'),
    payload: REPORT_DETAIL,
    path: '/admin/reports/rpt_1',
    options: { method: 'GET' },
  },
  {
    name: 'resolveReport',
    run: () => resolveReport('rpt_1', 'hide-content'),
    payload: OK,
    path: '/admin/reports/rpt_1/resolve',
    options: { method: 'POST', body: { decision: 'hide-content' } },
  },
  {
    name: 'rejectReport',
    run: () => rejectReport('rpt_1'),
    payload: OK,
    path: '/admin/reports/rpt_1/reject',
    options: { method: 'POST' },
  },
  {
    name: 'fetchUsers',
    run: () => fetchUsers({ keyword: '田中', role: 'user', status: 'active', cursor: null }),
    payload: page(USER_SUMMARY),
    path: '/admin/users',
    options: {
      method: 'GET',
      searchParams: { keyword: '田中', role: 'user', status: 'active' },
    },
  },
  {
    name: 'fetchUser',
    run: () => fetchUser('usr_1'),
    payload: USER_DETAIL,
    path: '/admin/users/usr_1',
    options: { method: 'GET' },
  },
  {
    name: 'suspendUser',
    run: () => suspendUser('usr_1'),
    payload: OK,
    path: '/admin/users/usr_1/suspend',
    options: { method: 'POST' },
  },
  {
    name: 'restoreUser',
    run: () => restoreUser('usr_1'),
    payload: OK,
    path: '/admin/users/usr_1/restore',
    options: { method: 'POST' },
  },
  {
    name: 'changeUserRole',
    run: () => changeUserRole('usr_1', ROLE_OWNER),
    payload: OK,
    path: '/admin/users/usr_1/role',
    options: { method: 'PATCH', body: { role: 'owner' } },
  },
  {
    name: 'fetchShops',
    run: () => fetchShops({ keyword: null, status: 'suspended', cursor: null }),
    payload: page(SHOP_SUMMARY),
    path: '/admin/shops',
    options: { method: 'GET', searchParams: { status: 'suspended' } },
  },
  {
    name: 'fetchShop',
    run: () => fetchShop('shp_1'),
    payload: SHOP_DETAIL,
    path: '/admin/shops/shp_1',
    options: { method: 'GET' },
  },
  {
    name: 'suspendShop',
    run: () => suspendShop('shp_1'),
    payload: OK,
    path: '/admin/shops/shp_1/suspend',
    options: { method: 'POST' },
  },
  {
    name: 'restoreShop',
    run: () => restoreShop('shp_1'),
    payload: OK,
    path: '/admin/shops/shp_1/restore',
    options: { method: 'POST' },
  },
  {
    name: 'assignShopOwner（付け替え）',
    run: () => assignShopOwner('shp_1', 'usr_9'),
    payload: OK,
    path: '/admin/shops/shp_1/owner',
    options: { method: 'PATCH', body: { ownerId: 'usr_9' } },
  },
  {
    name: 'assignShopOwner（外す）',
    run: () => assignShopOwner('shp_1', null),
    payload: OK,
    path: '/admin/shops/shp_1/owner',
    options: { method: 'PATCH', body: { ownerId: null } },
  },
  {
    name: 'fetchGenres',
    run: () => fetchGenres(),
    payload: { items: [GENRE] },
    path: '/admin/genres',
    options: { method: 'GET' },
  },
  {
    name: 'createGenre',
    run: () => createGenre({ name: 'ラーメン', slug: 'ramen', iconKey: 'ramen', sortOrder: 10 }),
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    path: '/admin/genres',
    options: {
      method: 'POST',
      body: { name: 'ラーメン', slug: 'ramen', iconKey: 'ramen', sortOrder: 10 },
    },
  },
  {
    name: 'updateGenre',
    run: () =>
      updateGenre('gnr_ramen', { name: '拉麺', slug: 'ramen', iconKey: null, sortOrder: 10 }),
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    path: '/admin/genres/gnr_ramen',
    options: {
      method: 'PATCH',
      body: { name: '拉麺', slug: 'ramen', iconKey: null, sortOrder: 10 },
    },
  },
  {
    name: 'deleteGenre',
    run: () => deleteGenre('gnr_ramen'),
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    path: '/admin/genres/gnr_ramen',
    options: { method: 'DELETE' },
  },
  {
    name: 'fetchAreas',
    run: () => fetchAreas(),
    payload: { items: [AREA] },
    path: '/admin/areas',
    options: { method: 'GET' },
  },
  {
    name: 'createArea',
    run: () => createArea({ name: '渋谷', parentId: null, prefecture: '東京都' }),
    payload: { areaId: 'are_shibuya', result: 'ok' },
    path: '/admin/areas',
    options: { method: 'POST', body: { name: '渋谷', parentId: null, prefecture: '東京都' } },
  },
  {
    name: 'updateArea',
    run: () => updateArea('are_shibuya', { name: '渋谷区', parentId: null, prefecture: '東京都' }),
    payload: { areaId: 'are_shibuya', result: 'ok' },
    path: '/admin/areas/are_shibuya',
    options: { method: 'PATCH', body: { name: '渋谷区', parentId: null, prefecture: '東京都' } },
  },
  {
    name: 'deleteArea',
    run: () => deleteArea('are_shibuya'),
    payload: { areaId: 'are_shibuya', result: 'ok' },
    path: '/admin/areas/are_shibuya',
    options: { method: 'DELETE' },
  },
  {
    name: 'sendAnnouncement',
    run: () =>
      sendAnnouncement({
        title: 'メンテナンス',
        body: '3 月 1 日 0 時から停止します',
        audience: { kind: 'all' },
      }),
    payload: { announcementId: 'ann_0123456789ab', result: 'ok', recipientCount: 120 },
    path: '/admin/announcements',
    options: {
      method: 'POST',
      body: {
        title: 'メンテナンス',
        body: '3 月 1 日 0 時から停止します',
        audience: { kind: 'all' },
      },
    },
  },
  {
    name: 'fetchAnnouncementHistory',
    run: () => fetchAnnouncementHistory({ cursor: null }),
    payload: page(ANNOUNCEMENT_HISTORY),
    path: '/admin/announcements',
    options: { method: 'GET', searchParams: {} },
  },
  {
    name: 'fetchAuditLogs',
    run: () =>
      fetchAuditLogs({
        actorId: 'usr_admin',
        action: 'user.suspend',
        targetType: 'user',
        targetId: 'usr_1',
        cursor: null,
      }),
    payload: page(AUDIT_LOG),
    path: '/admin/audit-logs',
    options: {
      method: 'GET',
      searchParams: {
        actorId: 'usr_admin',
        action: 'user.suspend',
        targetType: 'user',
        targetId: 'usr_1',
      },
    },
  },
  {
    name: 'undoAuditLog',
    run: () => undoAuditLog('aud_1'),
    payload: OK,
    path: '/admin/audit-logs/aud_1/undo',
    options: { method: 'POST' },
  },
];

describe('管理 API の呼び出し', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it.each(CALL_CASES)('$name が正しいパスとオプションで apiFetch を呼ぶ', async (testCase) => {
    apiFetchMock.mockResolvedValue(testCase.payload);

    await testCase.run();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(testCase.path, testCase.options);
  });

  it('32 エンドポイントぶんの呼び出しを網羅している', () => {
    // 権限行列テスト（apps/api の permission-matrix.test.ts）と同じ 32 本。
    // 画面から呼べないエンドポイントが生まれていないかをここで数える
    const uniquePaths = new Set(
      CALL_CASES.map((testCase) => `${String(testCase.options['method'])} ${testCase.path}`),
    );
    expect(uniquePaths.size).toBe(32);
  });

  it('ID はパスに入れる前にエスケープする', async () => {
    apiFetchMock.mockResolvedValue(APPLICATION_DETAIL);

    await fetchApplication('app/../secret');

    expect(apiFetchMock).toHaveBeenCalledWith('/admin/applications/app%2F..%2Fsecret', {
      method: 'GET',
    });
  });

  it('一覧は items をそのまま返す', async () => {
    apiFetchMock.mockResolvedValue(page(USER_SUMMARY));

    const result = await fetchUsers({ keyword: null, role: null, status: null, cursor: null });

    expect(result).toEqual({ items: [USER_SUMMARY], nextCursor: null });
  });

  it('マスタ一覧は items の中身だけを返す', async () => {
    apiFetchMock.mockResolvedValue({ items: [GENRE] });

    expect(await fetchGenres()).toEqual([GENRE]);
  });
});

describe('応答の形が違うとき', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('AdminResponseError になり、どの列が違うかを持つ', async () => {
    apiFetchMock.mockResolvedValue({ ...OVERVIEW, openReportCount: '5' });

    const caught: unknown = await fetchOverview().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AdminResponseError);
    expect((caught as AdminResponseError).path).toBe('/stats/overview');
    expect((caught as AdminResponseError).issues).toEqual(['openReportCount: invalid_type']);
  });

  it('応答そのものが配列だと (root) として報告する', async () => {
    apiFetchMock.mockResolvedValue([]);

    const caught: unknown = await fetchOverview().catch((error: unknown) => error);

    expect((caught as AdminResponseError).issues).toEqual(['(root): invalid_type']);
  });

  it('知らない状態が混ざっていたら弾く（画面で未定義のラベルを引かせない）', async () => {
    apiFetchMock.mockResolvedValue(page({ ...REPORT_SUMMARY, status: 'escalated' }));

    await expect(
      fetchReports({ status: null, targetType: null, cursor: null }),
    ).rejects.toBeInstanceOf(AdminResponseError);
  });
});

describe('toSearchParams', () => {
  it('null のキーは送らない', () => {
    expect(toSearchParams({ status: 'open', cursor: null })).toEqual({ status: 'open' });
  });

  it('空文字は値として送る（サーバ側で 422 になるので握り潰さない）', () => {
    expect(toSearchParams({ keyword: '' })).toEqual({ keyword: '' });
  });
});

describe('statusOf', () => {
  it.each([
    ['status を持つオブジェクト', { status: HTTP_STATUS.conflict }, HTTP_STATUS.conflict],
    ['status が数値でない', { status: '409' }, null],
    ['status を持たない', new Error('boom'), null],
    ['null', null, null],
    ['文字列', 'boom', null],
  ])('%s から取り出す', (_name, error, expected) => {
    expect(statusOf(error)).toBe(expected);
  });
});

describe('toAdminErrorMessage', () => {
  it.each([
    [HTTP_STATUS.unauthorized, 'ログインし直してください。'],
    [HTTP_STATUS.forbidden, 'この操作の権限がありません。'],
    [HTTP_STATUS.notFound, '対象が見つかりません。すでに削除された可能性があります。'],
    [HTTP_STATUS.conflict, '他の管理者が先に処理しました。画面を更新してください。'],
    [HTTP_STATUS.unprocessableEntity, '入力内容を確認してください。'],
    [HTTP_STATUS.tooManyRequests, '操作が多すぎます。少し待ってからやり直してください。'],
  ])('%i には専用の文言を返す', (status, expected) => {
    expect(toAdminErrorMessage({ status })).toBe(expected);
  });

  it('知らないステータスは既定の文言になる', () => {
    expect(toAdminErrorMessage({ status: 500 })).toBe(
      '通信に失敗しました。時間をおいてやり直してください。',
    );
  });

  it('ステータスが取れないときも既定の文言になる', () => {
    expect(toAdminErrorMessage(new Error('offline'))).toBe(
      '通信に失敗しました。時間をおいてやり直してください。',
    );
  });

  it('応答の形が違うときは別の文言になる', () => {
    expect(toAdminErrorMessage(new AdminResponseError('/stats/overview', []))).toBe(
      'サーバの応答を読み取れませんでした。アプリの更新が必要かもしれません。',
    );
  });
});
```

`issues` の期待値の `invalid_type` は zod 4 の issue code で、`node_modules/zod/v4/core/errors.d.cts:14` の `$ZodIssueInvalidType` が `readonly code: "invalid_type"` を持つことを確認済み。`path` の型が `PropertyKey[]`（同ファイル 10 行）なので、文字列に落とすときは `.map(String)` を挟む必要がある。語彙違い（`status: 'escalated'`）は `invalid_value`（同 84 行）になるので、そのテストでは code まで固定せず `AdminResponseError` であることだけを見る。

- [ ] **Step 13: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/api`
Expected: FAIL。`Cannot find module './api'`。

- [ ] **Step 14: api.ts を書く**

`apps/mobile/src/features/admin/api.ts`

```ts
import type { Role } from '@meshimap/core';
import { z } from 'zod';

import { HTTP_STATUS } from '@/constants/http';
import { apiFetch } from '@/lib/api-client';

import {
  announcementHistorySchema,
  applicationDetailSchema,
  applicationSummarySchema,
  areaSchema,
  auditLogSchema,
  cursorPageSchema,
  genreSchema,
  overviewSchema,
  reportDetailSchema,
  reportSummarySchema,
  shopDetailSchema,
  shopSummarySchema,
  userDetailSchema,
  userSummarySchema,
} from './types';
import type {
  AdminApplicationDetail,
  AdminApplicationSummary,
  AdminArea,
  AdminGenre,
  AdminOverview,
  AdminReportDetail,
  AdminReportSummary,
  AdminShopDetail,
  AdminShopSummary,
  AdminUserDetail,
  AdminUserSummary,
  AnnouncementAudience,
  AnnouncementHistoryItem,
  ApplicationStatus,
  AuditAction,
  AuditLogItem,
  AuditTargetType,
  CursorPage,
  ProfileStatus,
  ReportDecision,
  ReportStatus,
  ReportTargetType,
  ShopStatus,
} from './types';

/** 管理 API の共通接頭辞。apps/api/src/index.ts の `app.route('/admin', adminRoutes)` と対 */
const ADMIN_BASE_PATH = '/admin';

/** 応答の形がスキーマと合わなかったときのエラー。通信エラー（HTTP）とは別物として扱う */
export class AdminResponseError extends Error {
  readonly path: string;
  /** どの列がどう違ったか。利用者には見せず、開発時の手がかりにする */
  readonly issues: readonly string[];

  constructor(path: string, issues: readonly string[]) {
    super(`管理 API の応答が想定と違います: ${path}`);
    this.name = 'AdminResponseError';
    this.path = path;
    this.issues = issues;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type AdminRequest = {
  readonly method: HttpMethod;
  /** ADMIN_BASE_PATH より後ろ。先頭のスラッシュを含める */
  readonly path: string;
  readonly searchParams?: Record<string, string>;
  readonly body?: unknown;
};

/**
 * 管理 API を 1 回叩き、応答を zod で検査して返す唯一の経路。
 *
 * `apiFetch<Foo>(...)` のように型引数で型を名乗らせない。JSON.parse の結果に
 * 型注釈を付けるのは「検査した」ことにはならず、サーバが列を消しても
 * 画面の中で undefined を描画するまで誰も気づけない。
 */
async function requestAdmin<TSchema extends z.ZodType>(
  schema: TSchema,
  request: AdminRequest,
): Promise<z.output<TSchema>> {
  // exactOptionalPropertyTypes の下では `searchParams: undefined` を渡せないので、
  // キーごと消す。条件付きスプレッドはこのための書き方
  const payload: unknown = await apiFetch(`${ADMIN_BASE_PATH}${request.path}`, {
    method: request.method,
    ...(request.searchParams === undefined ? {} : { searchParams: request.searchParams }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      // path は PropertyKey[]（zod 4）なので文字列に落としてから連結する
      const location = issue.path.map(String).join('.');
      return location === '' ? `(root): ${issue.code}` : `${location}: ${issue.code}`;
    });
    throw new AdminResponseError(request.path, issues);
  }

  return parsed.data;
}

/**
 * 絞り込みの値をクエリに変換する。
 * `null` は「指定なし」なのでキーごと落とす。空文字は落とさない
 * （サーバの `keyword` は `.min(1)` なので 422 になる。握り潰すとバグが見えなくなる）。
 */
export function toSearchParams(
  values: Readonly<Record<string, string | null>>,
): Record<string, string> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) {
      searchParams[key] = value;
    }
  }
  return searchParams;
}

/** 書き込み系の応答。サーバは失敗時に HTTP エラーを投げるので、ここは 'ok' しか来ない */
const writeResultSchema = z.object({ result: z.literal('ok') });
export type WriteResult = z.output<typeof writeResultSchema>;

// ───────────────────────── ダッシュボード ─────────────────────────

export function fetchOverview(): Promise<AdminOverview> {
  return requestAdmin(overviewSchema, { method: 'GET', path: '/stats/overview' });
}

// ───────────────────────── 店舗申請 ─────────────────────────

const applicationPageSchema = cursorPageSchema(applicationSummarySchema);

export type ApplicationListParams = {
  readonly status: ApplicationStatus | null;
  readonly cursor: string | null;
};

export function fetchApplications(
  params: ApplicationListParams,
): Promise<CursorPage<AdminApplicationSummary>> {
  return requestAdmin(applicationPageSchema, {
    method: 'GET',
    path: '/applications',
    searchParams: toSearchParams({ status: params.status, cursor: params.cursor }),
  });
}

export function fetchApplication(applicationId: string): Promise<AdminApplicationDetail> {
  return requestAdmin(applicationDetailSchema, {
    method: 'GET',
    path: `/applications/${encodeURIComponent(applicationId)}`,
  });
}

/**
 * 審査の結果。
 * 承認は本文を取らず、差し戻しと却下は理由が必須（サーバの `reviewNoteSchema` が `.min(1)`）。
 * 判別可能ユニオンにしてあるので、理由を渡し忘れた差し戻しはコンパイルで止まる。
 */
export type ApplicationReview =
  | { readonly decision: 'approve' }
  | { readonly decision: 'return'; readonly reviewNote: string }
  | { readonly decision: 'reject'; readonly reviewNote: string };

export function reviewApplication(
  applicationId: string,
  review: ApplicationReview,
): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/applications/${encodeURIComponent(applicationId)}/${review.decision}`,
    ...(review.decision === 'approve' ? {} : { body: { reviewNote: review.reviewNote } }),
  });
}

// ───────────────────────── 通報 ─────────────────────────

const reportPageSchema = cursorPageSchema(reportSummarySchema);

export type ReportListParams = {
  readonly status: ReportStatus | null;
  readonly targetType: ReportTargetType | null;
  readonly cursor: string | null;
};

export function fetchReports(params: ReportListParams): Promise<CursorPage<AdminReportSummary>> {
  return requestAdmin(reportPageSchema, {
    method: 'GET',
    path: '/reports',
    searchParams: toSearchParams({
      status: params.status,
      targetType: params.targetType,
      cursor: params.cursor,
    }),
  });
}

export function fetchReport(reportId: string): Promise<AdminReportDetail> {
  return requestAdmin(reportDetailSchema, {
    method: 'GET',
    path: `/reports/${encodeURIComponent(reportId)}`,
  });
}

export function resolveReport(reportId: string, decision: ReportDecision): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/reports/${encodeURIComponent(reportId)}/resolve`,
    body: { decision },
  });
}

export function rejectReport(reportId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/reports/${encodeURIComponent(reportId)}/reject`,
  });
}

// ───────────────────────── ユーザー ─────────────────────────

const userPageSchema = cursorPageSchema(userSummarySchema);

export type UserListParams = {
  readonly keyword: string | null;
  readonly role: Role | null;
  readonly status: ProfileStatus | null;
  readonly cursor: string | null;
};

export function fetchUsers(params: UserListParams): Promise<CursorPage<AdminUserSummary>> {
  return requestAdmin(userPageSchema, {
    method: 'GET',
    path: '/users',
    searchParams: toSearchParams({
      keyword: params.keyword,
      role: params.role,
      status: params.status,
      cursor: params.cursor,
    }),
  });
}

export function fetchUser(userId: string): Promise<AdminUserDetail> {
  return requestAdmin(userDetailSchema, {
    method: 'GET',
    path: `/users/${encodeURIComponent(userId)}`,
  });
}

export function suspendUser(userId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/users/${encodeURIComponent(userId)}/suspend`,
  });
}

export function restoreUser(userId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/users/${encodeURIComponent(userId)}/restore`,
  });
}

export function changeUserRole(userId: string, role: Role): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'PATCH',
    path: `/users/${encodeURIComponent(userId)}/role`,
    body: { role },
  });
}

// ───────────────────────── 店舗 ─────────────────────────

const shopPageSchema = cursorPageSchema(shopSummarySchema);

export type ShopListParams = {
  readonly keyword: string | null;
  readonly status: ShopStatus | null;
  readonly cursor: string | null;
};

export function fetchShops(params: ShopListParams): Promise<CursorPage<AdminShopSummary>> {
  return requestAdmin(shopPageSchema, {
    method: 'GET',
    path: '/shops',
    searchParams: toSearchParams({
      keyword: params.keyword,
      status: params.status,
      cursor: params.cursor,
    }),
  });
}

export function fetchShop(shopId: string): Promise<AdminShopDetail> {
  return requestAdmin(shopDetailSchema, {
    method: 'GET',
    path: `/shops/${encodeURIComponent(shopId)}`,
  });
}

export function suspendShop(shopId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/shops/${encodeURIComponent(shopId)}/suspend`,
  });
}

export function restoreShop(shopId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/shops/${encodeURIComponent(shopId)}/restore`,
  });
}

/** `ownerId` に null を渡すとオーナーを外す。キーを省略しないのはサーバの契約に合わせるため */
export function assignShopOwner(shopId: string, ownerId: string | null): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'PATCH',
    path: `/shops/${encodeURIComponent(shopId)}/owner`,
    body: { ownerId },
  });
}

// ───────────────────────── マスタ ─────────────────────────

const genreListSchema = z.object({ items: z.array(genreSchema) });
const genreWriteSchema = z.object({ genreId: z.string(), result: z.literal('ok') });
const areaListSchema = z.object({ items: z.array(areaSchema) });
const areaWriteSchema = z.object({ areaId: z.string(), result: z.literal('ok') });

/** 作成・更新で送る列。`id` は送らない（採番はサーバの責任） */
export type GenreInput = {
  readonly name: string;
  readonly slug: string;
  readonly iconKey: string | null;
  readonly sortOrder: number;
};

export type AreaInput = {
  readonly name: string;
  readonly parentId: string | null;
  readonly prefecture: string;
};

export async function fetchGenres(): Promise<AdminGenre[]> {
  // マスタは件数が少ないのでカーソルを持たない。items だけを返して画面を単純にする
  const response = await requestAdmin(genreListSchema, { method: 'GET', path: '/genres' });
  return response.items;
}

export function createGenre(input: GenreInput): Promise<z.output<typeof genreWriteSchema>> {
  return requestAdmin(genreWriteSchema, { method: 'POST', path: '/genres', body: input });
}

export function updateGenre(
  genreId: string,
  input: GenreInput,
): Promise<z.output<typeof genreWriteSchema>> {
  return requestAdmin(genreWriteSchema, {
    method: 'PATCH',
    path: `/genres/${encodeURIComponent(genreId)}`,
    body: input,
  });
}

export function deleteGenre(genreId: string): Promise<z.output<typeof genreWriteSchema>> {
  return requestAdmin(genreWriteSchema, {
    method: 'DELETE',
    path: `/genres/${encodeURIComponent(genreId)}`,
  });
}

export async function fetchAreas(): Promise<AdminArea[]> {
  const response = await requestAdmin(areaListSchema, { method: 'GET', path: '/areas' });
  return response.items;
}

export function createArea(input: AreaInput): Promise<z.output<typeof areaWriteSchema>> {
  return requestAdmin(areaWriteSchema, { method: 'POST', path: '/areas', body: input });
}

export function updateArea(
  areaId: string,
  input: AreaInput,
): Promise<z.output<typeof areaWriteSchema>> {
  return requestAdmin(areaWriteSchema, {
    method: 'PATCH',
    path: `/areas/${encodeURIComponent(areaId)}`,
    body: input,
  });
}

export function deleteArea(areaId: string): Promise<z.output<typeof areaWriteSchema>> {
  return requestAdmin(areaWriteSchema, {
    method: 'DELETE',
    path: `/areas/${encodeURIComponent(areaId)}`,
  });
}

// ───────────────────────── お知らせ ─────────────────────────

const announcementSendSchema = z.object({
  announcementId: z.string(),
  result: z.literal('ok'),
  recipientCount: z.number(),
});
const announcementPageSchema = cursorPageSchema(announcementHistorySchema);

export type AnnouncementInput = {
  readonly title: string;
  readonly body: string;
  readonly audience: AnnouncementAudience;
};

/**
 * お知らせを配信する。
 *
 * サーバは冪等キーとして `announcementId` を受け取れるが、**ここでは送らない**。
 * クライアントが採番して再送すると、2 回目は「他の管理者が先に処理しました」と
 * 同じ 409 になり、利用者には区別が付かないため。
 * 二重配信はこの層ではなく画面側で防ぐ（送信中はボタンを押せなくする。Task 9-22）。
 * 残るリスクは「送信中にアプリが落ちて、届いたかどうか分からない」場合で、
 * そのときは配信履歴（`fetchAnnouncementHistory`）で確認する運用にする。
 */
export function sendAnnouncement(
  input: AnnouncementInput,
): Promise<z.output<typeof announcementSendSchema>> {
  return requestAdmin(announcementSendSchema, {
    method: 'POST',
    path: '/announcements',
    body: input,
  });
}

export function fetchAnnouncementHistory(params: {
  readonly cursor: string | null;
}): Promise<CursorPage<AnnouncementHistoryItem>> {
  return requestAdmin(announcementPageSchema, {
    method: 'GET',
    path: '/announcements',
    searchParams: toSearchParams({ cursor: params.cursor }),
  });
}

// ───────────────────────── 監査ログ ─────────────────────────

const auditLogPageSchema = cursorPageSchema(auditLogSchema);

export type AuditLogListParams = {
  readonly actorId: string | null;
  readonly action: AuditAction | null;
  readonly targetType: AuditTargetType | null;
  readonly targetId: string | null;
  readonly cursor: string | null;
};

export function fetchAuditLogs(params: AuditLogListParams): Promise<CursorPage<AuditLogItem>> {
  return requestAdmin(auditLogPageSchema, {
    method: 'GET',
    path: '/audit-logs',
    searchParams: toSearchParams({
      actorId: params.actorId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      cursor: params.cursor,
    }),
  });
}

export function undoAuditLog(auditLogId: string): Promise<WriteResult> {
  return requestAdmin(writeResultSchema, {
    method: 'POST',
    path: `/audit-logs/${encodeURIComponent(auditLogId)}/undo`,
  });
}

// ───────────────────────── エラーの読み替え ─────────────────────────

/** 通信エラーから HTTP ステータスを取り出す。形が違えば null */
export function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }
  const { status } = error;
  return typeof status === 'number' ? status : null;
}

/**
 * 利用者に見せる文言。
 * 409 に専用の文を持つのが管理画面の要点で、「他の管理者が先に処理した」ことが
 * 伝わらないと、同じ操作を何度も試すことになる。
 */
const ADMIN_ERROR_MESSAGES: Record<number, string> = {
  [HTTP_STATUS.unauthorized]: 'ログインし直してください。',
  [HTTP_STATUS.forbidden]: 'この操作の権限がありません。',
  [HTTP_STATUS.notFound]: '対象が見つかりません。すでに削除された可能性があります。',
  [HTTP_STATUS.conflict]: '他の管理者が先に処理しました。画面を更新してください。',
  [HTTP_STATUS.unprocessableEntity]: '入力内容を確認してください。',
  [HTTP_STATUS.tooManyRequests]: '操作が多すぎます。少し待ってからやり直してください。',
};

const FALLBACK_ERROR_MESSAGE = '通信に失敗しました。時間をおいてやり直してください。';
const RESPONSE_SHAPE_ERROR_MESSAGE =
  'サーバの応答を読み取れませんでした。アプリの更新が必要かもしれません。';

export function toAdminErrorMessage(error: unknown): string {
  if (error instanceof AdminResponseError) {
    return RESPONSE_SHAPE_ERROR_MESSAGE;
  }
  const status = statusOf(error);
  if (status === null) {
    return FALLBACK_ERROR_MESSAGE;
  }
  return ADMIN_ERROR_MESSAGES[status] ?? FALLBACK_ERROR_MESSAGE;
}
```

- [ ] **Step 15: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/api && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**57 件**）。`it.each` が展開されるので `it` の行数（15 行）とは一致しない。内訳は `it.each(CALL_CASES)` が **34 件**（`CALL_CASES` の行数。`METHOD path` に潰すと 32 本になるので、同じエンドポイントを 2 通りの引数で叩いている行が 2 つある）+ 単発 12 件 + `statusOf` の `it.each` 5 件 + `toAdminErrorMessage` の `it.each` 6 件。

`apiFetchMock.mockResolvedValue(...)` で型エラーが出た場合、**キャストで黙らせないこと。**原因は Phase 5 の `apiFetch` が `<T>(path, options): Promise<T>` のように呼び出し側へ型を名乗らせる形になっていることなので、Phase 5 側の戻り値を `Promise<unknown>` に直す。検査していない型を名乗る API は、この層の存在意義（応答を検査してから画面へ渡す）を無効化する。

- [ ] **Step 16: わざと壊して、パスと検査が効いていることを確認する**

1. `fetchReport` のパスを `/reports/${reportId}`（エスケープなし）にする → 「ID はパスに入れる前にエスケープする」は `fetchApplication` のテストなので落ちない。**そこで `fetchApplication` のほうを直接壊す**：`encodeURIComponent` を外す → 落ちる。`fetchReport` 側が守られていないことに気づいたら、エスケープ漏れが 1 か所でもあると検出できないということなので、Step 12 の網羅テストに次を足す。

```tsx
it('すべての ID 付きパスで encodeURIComponent を通している', () => {
  // ソースを読んで、テンプレートリテラルの中に素の変数が無いことを確かめる。
  // 目視だと新しいエンドポイントを足したときに必ず漏れる
  const source = readFileSync(join(__dirname, 'api.ts'), 'utf8');
  const rawInterpolations = [
    ...source.matchAll(/\$\{(?!ADMIN_BASE_PATH|encodeURIComponent|review\.decision)([^}]*)\}/g),
  ];

  expect(rawInterpolations.map((matched) => matched[1])).toEqual([]);
});
```

このテストを足すには `api.test.ts` の先頭に `import { readFileSync } from 'node:fs';` と `import { join } from 'node:path';` が要る。`review.decision` を除外に入れているのは、審査のパス末尾が語彙（`approve` / `return` / `reject`）で、外から来た文字列ではないため。

2. `requestAdmin` の `schema.safeParse(payload)` を消して `payload as z.output<TSchema>` にする → 「応答の形が違うとき」の 3 件が落ちる。
3. `toSearchParams` の `value !== null` を `value != null` にする → この時点では落ちない（`undefined` を渡す経路が無い）。**落ちないことを確認したうえで戻すこと。**型が `string | null` なので `!=` でも等価だが、`null` 以外の falsy（空文字）まで落とす書き方（`if (value)`）に変えると「空文字は値として送る」が落ちる。こちらも試す。

3 つとも戻す。

- [ ] **Step 17: クエリ層の設計を 3 つ決めてから書く**

1. **すべての mutation フックは引数を 1 個のオブジェクトで受ける。**`mutate(userId)` と `mutate({ userId, role })` が混ざると、呼び出し側が毎回シグネチャを確認することになる。
2. **すべての mutation は監査ログのキーを無効化する。**Phase 9 の書き込みは例外なく監査ログを 1 行増やす（Task 9-2 の規約）。画面側でも同じ不変条件を持たせ、**表で機械的に検査する**。
3. **詳細クエリは ID が空文字なら投げない。**expo-router の `useLocalSearchParams` は型の上では文字列を返すが、遷移の途中で空になりうる。`/admin/applications/` を投げても意味のある応答は返らない。

- [ ] **Step 18: クエリ層の失敗するテストを書く**

`apps/mobile/src/features/admin/queries.test.tsx`

```tsx
import { ROLE_OWNER } from '@meshimap/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { apiFetch } from '@/lib/api-client';

import {
  adminQueryKeys,
  useAnnouncementHistory,
  useApplication,
  useApplications,
  useAreas,
  useAssignShopOwner,
  useAuditLogs,
  useChangeUserRole,
  useCreateArea,
  useCreateGenre,
  useDeleteArea,
  useDeleteGenre,
  useGenres,
  useOverview,
  useRejectReport,
  useReport,
  useReports,
  useResolveReport,
  useRestoreShop,
  useRestoreUser,
  useReviewApplication,
  useSendAnnouncement,
  useShop,
  useShops,
  useSuspendShop,
  useSuspendUser,
  useUndoAuditLog,
  useUpdateArea,
  useUpdateGenre,
  useUser,
  useUsers,
} from './queries';

jest.mock('@/lib/api-client', () => ({ apiFetch: jest.fn() }));

const apiFetchMock = jest.mocked(apiFetch);

const OVERVIEW = {
  windowDays: 30,
  newShopCount: 1,
  newReviewCount: 2,
  newUserCount: 3,
  pendingApplicationCount: 4,
  openReportCount: 5,
};
const APPLICATION_SUMMARY = {
  applicationId: 'app_1',
  shopId: 'shp_1',
  shopName: '一番亭',
  applicantId: 'usr_1',
  applicantName: '田中',
  status: 'pending',
  documentCount: 2,
  createdAtMs: 1_700_000_000_000,
};
const APPLICATION_DETAIL = {
  ...APPLICATION_SUMMARY,
  documents: [],
  reviewNote: null,
  reviewedBy: null,
};
const REPORT_SUMMARY = {
  reportId: 'rpt_1',
  targetType: 'review',
  targetId: 'rvw_1',
  reason: 'spam',
  status: 'open',
  reporterId: null,
  createdAtMs: 1_700_000_000_000,
};
const REPORT_DETAIL = {
  ...REPORT_SUMMARY,
  detail: null,
  targetSummary: null,
  handledBy: null,
  handledAtMs: null,
};
const USER_SUMMARY = {
  userId: 'usr_1',
  displayName: '田中',
  email: 'tanaka@example.com',
  role: 'user',
  status: 'active',
  createdAtMs: 1_700_000_000_000,
};
const USER_DETAIL = { ...USER_SUMMARY, bio: null, reviewCount: 0, shopCount: 0 };
const SHOP_SUMMARY = {
  shopId: 'shp_1',
  name: '一番亭',
  status: 'published',
  ownerId: null,
  ownerName: null,
  createdAtMs: 1_700_000_000_000,
};
const SHOP_DETAIL = {
  ...SHOP_SUMMARY,
  address: '東京都渋谷区1-1',
  reviewCount: 0,
  openReportCount: 0,
};
const GENRE = { id: 'gnr_ramen', name: 'ラーメン', slug: 'ramen', iconKey: null, sortOrder: 10 };
const AREA = { id: 'are_shibuya', name: '渋谷', parentId: null, prefecture: '東京都' };
const ANNOUNCEMENT_HISTORY = {
  announcementId: 'ann_0123456789ab',
  title: 'メンテナンス',
  audience: 'all',
  recipientCount: 1,
  sentBy: null,
  sentAtMs: 1_700_000_000_000,
};
const AUDIT_LOG = {
  auditLogId: 'aud_1',
  actorId: null,
  actorName: null,
  action: 'user.suspend',
  targetType: 'user',
  targetId: 'usr_1',
  diff: null,
  createdAtMs: 1_700_000_000_000,
  undoable: true,
};
const OK = { result: 'ok' };
const page = (item: unknown) => ({ items: [item], nextCursor: null });

/** テストごとに新しい QueryClient を作る。使い回すとキャッシュが次のテストへ漏れる */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // 失敗を 3 回再試行されるとテストがタイムアウトするだけで、何も検証できない
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('adminQueryKeys', () => {
  it('一覧と詳細は同じ接頭辞を共有する', () => {
    // 書き込み後に接頭辞ひとつで両方を無効化できるようにしてある
    expect(adminQueryKeys.applicationList({ status: null })[1]).toBe(
      adminQueryKeys.application('app_1')[1],
    );
  });

  it('一覧のキーは絞り込み条件を含む', () => {
    expect(adminQueryKeys.applicationList({ status: 'pending' })).not.toEqual(
      adminQueryKeys.applicationList({ status: null }),
    );
  });

  it('すべてのキーが admin で始まる', () => {
    const keys = [
      adminQueryKeys.overview(),
      adminQueryKeys.applications(),
      adminQueryKeys.reports(),
      adminQueryKeys.users(),
      adminQueryKeys.shops(),
      adminQueryKeys.genres(),
      adminQueryKeys.areas(),
      adminQueryKeys.announcements(),
      adminQueryKeys.auditLogs(),
    ];

    for (const key of keys) {
      expect(key[0]).toBe('admin');
    }
  });
});

/** 取得系フック 1 件ぶんの期待 */
type QueryCase = {
  readonly name: string;
  readonly useHook: () => { readonly isSuccess: boolean };
  readonly payload: unknown;
};

const QUERY_CASES: readonly QueryCase[] = [
  { name: 'useOverview', useHook: () => useOverview(), payload: OVERVIEW },
  {
    name: 'useApplications',
    useHook: () => useApplications({ status: null }),
    payload: page(APPLICATION_SUMMARY),
  },
  { name: 'useApplication', useHook: () => useApplication('app_1'), payload: APPLICATION_DETAIL },
  {
    name: 'useReports',
    useHook: () => useReports({ status: null, targetType: null }),
    payload: page(REPORT_SUMMARY),
  },
  { name: 'useReport', useHook: () => useReport('rpt_1'), payload: REPORT_DETAIL },
  {
    name: 'useUsers',
    useHook: () => useUsers({ keyword: null, role: null, status: null }),
    payload: page(USER_SUMMARY),
  },
  { name: 'useUser', useHook: () => useUser('usr_1'), payload: USER_DETAIL },
  {
    name: 'useShops',
    useHook: () => useShops({ keyword: null, status: null }),
    payload: page(SHOP_SUMMARY),
  },
  { name: 'useShop', useHook: () => useShop('shp_1'), payload: SHOP_DETAIL },
  { name: 'useGenres', useHook: () => useGenres(), payload: { items: [GENRE] } },
  { name: 'useAreas', useHook: () => useAreas(), payload: { items: [AREA] } },
  {
    name: 'useAnnouncementHistory',
    useHook: () => useAnnouncementHistory(),
    payload: page(ANNOUNCEMENT_HISTORY),
  },
  {
    name: 'useAuditLogs',
    useHook: () => useAuditLogs({ actorId: null, action: null, targetType: null, targetId: null }),
    payload: page(AUDIT_LOG),
  },
];

describe('取得系フック', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it.each(QUERY_CASES)('$name が成功状態になる', async (testCase) => {
    apiFetchMock.mockResolvedValue(testCase.payload);
    const queryClient = createTestQueryClient();

    const { result } = await renderHook(testCase.useHook, {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('13 本の取得系フックを網羅している', () => {
    expect(QUERY_CASES).toHaveLength(13);
  });

  it.each([
    ['useApplication', () => useApplication('')],
    ['useReport', () => useReport('')],
    ['useUser', () => useUser('')],
    ['useShop', () => useShop('')],
  ])('%s は ID が空なら通信しない', async (_name, useHook) => {
    const queryClient = createTestQueryClient();

    await renderHook(useHook, { wrapper: createWrapper(queryClient) });

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('一覧は nextCursor を次ページのカーソルとして扱う', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [USER_SUMMARY], nextCursor: '100:usr_1' });
    const queryClient = createTestQueryClient();

    const { result } = await renderHook(
      () => useUsers({ keyword: null, role: null, status: null }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true);
    });
  });

  it('nextCursor が null なら次ページは無い', async () => {
    apiFetchMock.mockResolvedValue(page(USER_SUMMARY));
    const queryClient = createTestQueryClient();

    const { result } = await renderHook(
      () => useUsers({ keyword: null, role: null, status: null }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.hasNextPage).toBe(false);
  });
});

/** 書き込み系フック 1 件ぶんの期待 */
type MutationCase = {
  readonly name: string;
  readonly useHook: () => {
    readonly mutate: (variables: never) => void;
    readonly isSuccess: boolean;
  };
  readonly variables: unknown;
  readonly payload: unknown;
  readonly expectedKeys: readonly (readonly string[])[];
};

const APPLICATION_KEYS = [
  ['admin', 'applications'],
  ['admin', 'overview'],
  ['admin', 'audit-logs'],
];
const REPORT_KEYS = [
  ['admin', 'reports'],
  ['admin', 'overview'],
  ['admin', 'audit-logs'],
];
const USER_KEYS = [
  ['admin', 'users'],
  ['admin', 'audit-logs'],
];
const SHOP_KEYS = [
  ['admin', 'shops'],
  ['admin', 'audit-logs'],
];
const GENRE_KEYS = [
  ['admin', 'genres'],
  ['admin', 'audit-logs'],
];
const AREA_KEYS = [
  ['admin', 'areas'],
  ['admin', 'audit-logs'],
];
/** オーナー付け替えは店舗の ownerId とユーザー詳細の shopCount の両方を動かす */
const SHOP_OWNER_KEYS = [
  ['admin', 'shops'],
  ['admin', 'users'],
  ['admin', 'audit-logs'],
];
/** 何が変わるか引数から決まらない操作。管理配下をまるごと捨てる */
const ALL_ADMIN_KEYS = [['admin']];

const MUTATION_CASES: readonly MutationCase[] = [
  {
    name: 'useReviewApplication',
    useHook: useReviewApplication,
    variables: {
      applicationId: 'app_1',
      review: { decision: 'return', reviewNote: '営業許可証が読めません' },
    },
    payload: OK,
    expectedKeys: APPLICATION_KEYS,
  },
  {
    name: 'useResolveReport',
    useHook: useResolveReport,
    variables: { reportId: 'rpt_1', decision: 'hide-content' },
    payload: OK,
    // 対処の対象がレビューか店舗かユーザーかは引数から分からない
    expectedKeys: ALL_ADMIN_KEYS,
  },
  {
    name: 'useRejectReport',
    useHook: useRejectReport,
    variables: { reportId: 'rpt_1' },
    payload: OK,
    expectedKeys: REPORT_KEYS,
  },
  {
    name: 'useSuspendUser',
    useHook: useSuspendUser,
    variables: { userId: 'usr_1' },
    payload: OK,
    expectedKeys: USER_KEYS,
  },
  {
    name: 'useRestoreUser',
    useHook: useRestoreUser,
    variables: { userId: 'usr_1' },
    payload: OK,
    expectedKeys: USER_KEYS,
  },
  {
    name: 'useChangeUserRole',
    useHook: useChangeUserRole,
    variables: { userId: 'usr_1', role: ROLE_OWNER },
    payload: OK,
    expectedKeys: USER_KEYS,
  },
  {
    name: 'useSuspendShop',
    useHook: useSuspendShop,
    variables: { shopId: 'shp_1' },
    payload: OK,
    expectedKeys: SHOP_KEYS,
  },
  {
    name: 'useRestoreShop',
    useHook: useRestoreShop,
    variables: { shopId: 'shp_1' },
    payload: OK,
    expectedKeys: SHOP_KEYS,
  },
  {
    name: 'useAssignShopOwner',
    useHook: useAssignShopOwner,
    variables: { shopId: 'shp_1', ownerId: null },
    payload: OK,
    expectedKeys: SHOP_OWNER_KEYS,
  },
  {
    name: 'useCreateGenre',
    useHook: useCreateGenre,
    variables: { input: { name: 'ラーメン', slug: 'ramen', iconKey: null, sortOrder: 10 } },
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    expectedKeys: GENRE_KEYS,
  },
  {
    name: 'useUpdateGenre',
    useHook: useUpdateGenre,
    variables: {
      genreId: 'gnr_ramen',
      input: { name: '拉麺', slug: 'ramen', iconKey: null, sortOrder: 10 },
    },
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    expectedKeys: GENRE_KEYS,
  },
  {
    name: 'useDeleteGenre',
    useHook: useDeleteGenre,
    variables: { genreId: 'gnr_ramen' },
    payload: { genreId: 'gnr_ramen', result: 'ok' },
    expectedKeys: GENRE_KEYS,
  },
  {
    name: 'useCreateArea',
    useHook: useCreateArea,
    variables: { input: { name: '渋谷', parentId: null, prefecture: '東京都' } },
    payload: { areaId: 'are_shibuya', result: 'ok' },
    expectedKeys: AREA_KEYS,
  },
  {
    name: 'useUpdateArea',
    useHook: useUpdateArea,
    variables: {
      areaId: 'are_shibuya',
      input: { name: '渋谷区', parentId: null, prefecture: '東京都' },
    },
    payload: { areaId: 'are_shibuya', result: 'ok' },
    expectedKeys: AREA_KEYS,
  },
  {
    name: 'useDeleteArea',
    useHook: useDeleteArea,
    variables: { areaId: 'are_shibuya' },
    payload: { areaId: 'are_shibuya', result: 'ok' },
    expectedKeys: AREA_KEYS,
  },
  {
    name: 'useSendAnnouncement',
    useHook: useSendAnnouncement,
    variables: {
      input: { title: 'メンテナンス', body: '停止します', audience: { kind: 'all' } },
    },
    payload: { announcementId: 'ann_0123456789ab', result: 'ok', recipientCount: 1 },
    expectedKeys: [
      ['admin', 'announcements'],
      ['admin', 'audit-logs'],
    ],
  },
  {
    name: 'useUndoAuditLog',
    useHook: useUndoAuditLog,
    variables: { auditLogId: 'aud_1' },
    payload: OK,
    // 取り消しは何が戻るか分からないので、管理配下をまるごと無効化する
    expectedKeys: ALL_ADMIN_KEYS,
  },
];

describe('書き込み系フック', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it.each(MUTATION_CASES)('$name が成功し、想定のキーを無効化する', async (testCase) => {
    apiFetchMock.mockResolvedValue(testCase.payload);
    const queryClient = createTestQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(testCase.useHook, {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate(testCase.variables as never);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toEqual(
      testCase.expectedKeys,
    );
  });

  it.each(MUTATION_CASES)('$name は監査ログを必ず無効化する', (testCase) => {
    // Phase 9 の書き込みは例外なく監査ログを 1 行増やす。
    // 画面が古い監査ログを映したままにならないことを、表で機械的に確かめる
    const invalidatesAuditLog = testCase.expectedKeys.some(
      (key) => key.join('/') === 'admin/audit-logs' || key.join('/') === 'admin',
    );

    expect(invalidatesAuditLog).toBe(true);
  });

  it('17 本の書き込み系フックを網羅している', () => {
    // apps/api の権限行列 32 本のうち、GET 13 本を除いた 19 本が書き込み。
    // 画面からは approve / return / reject を 1 つのフックにまとめているので 17 本になる
    expect(MUTATION_CASES).toHaveLength(17);
  });

  it('承認は管理配下をまるごと無効化する', async () => {
    // 承認は店舗を公開し、申請者を owner に上げる。申請一覧だけ捨てても画面が古いままになる
    apiFetchMock.mockResolvedValue(OK);
    const queryClient = createTestQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(useReviewApplication, {
      wrapper: createWrapper(queryClient),
    });
    result.current.mutate({ applicationId: 'app_1', review: { decision: 'approve' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toEqual(ALL_ADMIN_KEYS);
  });

  it('失敗したときは無効化しない', async () => {
    apiFetchMock.mockRejectedValue({ status: 409 });
    const queryClient = createTestQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(useSuspendUser, { wrapper: createWrapper(queryClient) });
    result.current.mutate({ userId: 'usr_1' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 19: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/queries`
Expected: FAIL。`Cannot find module './queries'`。

- [ ] **Step 20: クエリ層を実装する**

`apps/mobile/src/features/admin/queries.ts`

```ts
import type { Role } from '@meshimap/core';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from '@tanstack/react-query';

import {
  assignShopOwner,
  changeUserRole,
  createArea,
  createGenre,
  deleteArea,
  deleteGenre,
  fetchAnnouncementHistory,
  fetchApplication,
  fetchApplications,
  fetchAreas,
  fetchAuditLogs,
  fetchGenres,
  fetchOverview,
  fetchReport,
  fetchReports,
  fetchShop,
  fetchShops,
  fetchUser,
  fetchUsers,
  rejectReport,
  resolveReport,
  restoreShop,
  restoreUser,
  reviewApplication,
  sendAnnouncement,
  suspendShop,
  suspendUser,
  undoAuditLog,
  updateArea,
  updateGenre,
  type AnnouncementInput,
  type ApplicationListParams,
  type ApplicationReview,
  type AreaInput,
  type AuditLogListParams,
  type GenreInput,
  type ReportListParams,
  type ShopListParams,
  type UserListParams,
} from './api';
import type { CursorPage, ReportDecision } from './types';

/**
 * 絞り込み条件。API の引数からカーソルだけを取り除いたもの。
 *
 * カーソルは「どのページを読むか」であって「何を読むか」ではないので、
 * クエリキーにも画面の状態にも入れない。ページ送りは useInfiniteQuery が持つ。
 * 手で書き写すと api.ts と必ずずれるので Omit で導出する。
 */
export type ApplicationFilter = Omit<ApplicationListParams, 'cursor'>;
export type ReportFilter = Omit<ReportListParams, 'cursor'>;
export type UserFilter = Omit<UserListParams, 'cursor'>;
export type ShopFilter = Omit<ShopListParams, 'cursor'>;
export type AuditLogFilter = Omit<AuditLogListParams, 'cursor'>;

const ADMIN_QUERY_SCOPE = 'admin';

/**
 * 管理画面のクエリキー。
 *
 * 一覧と詳細は `[scope, entity, 'list' | 'detail', ...]` という形を共有する。
 * こうしておくと `[scope, entity]` の 2 要素だけで両方をまとめて無効化できる
 * （TanStack Query の無効化は前方一致）。
 */
export const adminQueryKeys = {
  /** 管理配下すべて。何が変わるか引数から決まらない操作で使う */
  root: () => [ADMIN_QUERY_SCOPE] as const,
  overview: () => [ADMIN_QUERY_SCOPE, 'overview'] as const,

  applications: () => [ADMIN_QUERY_SCOPE, 'applications'] as const,
  applicationList: (filter: ApplicationFilter) =>
    [ADMIN_QUERY_SCOPE, 'applications', 'list', filter] as const,
  application: (applicationId: string) =>
    [ADMIN_QUERY_SCOPE, 'applications', 'detail', applicationId] as const,

  reports: () => [ADMIN_QUERY_SCOPE, 'reports'] as const,
  reportList: (filter: ReportFilter) => [ADMIN_QUERY_SCOPE, 'reports', 'list', filter] as const,
  report: (reportId: string) => [ADMIN_QUERY_SCOPE, 'reports', 'detail', reportId] as const,

  users: () => [ADMIN_QUERY_SCOPE, 'users'] as const,
  userList: (filter: UserFilter) => [ADMIN_QUERY_SCOPE, 'users', 'list', filter] as const,
  user: (userId: string) => [ADMIN_QUERY_SCOPE, 'users', 'detail', userId] as const,

  shops: () => [ADMIN_QUERY_SCOPE, 'shops'] as const,
  shopList: (filter: ShopFilter) => [ADMIN_QUERY_SCOPE, 'shops', 'list', filter] as const,
  shop: (shopId: string) => [ADMIN_QUERY_SCOPE, 'shops', 'detail', shopId] as const,

  genres: () => [ADMIN_QUERY_SCOPE, 'genres'] as const,
  areas: () => [ADMIN_QUERY_SCOPE, 'areas'] as const,

  announcements: () => [ADMIN_QUERY_SCOPE, 'announcements'] as const,
  announcementList: () => [ADMIN_QUERY_SCOPE, 'announcements', 'list'] as const,

  auditLogs: () => [ADMIN_QUERY_SCOPE, 'audit-logs'] as const,
  auditLogList: (filter: AuditLogFilter) =>
    [ADMIN_QUERY_SCOPE, 'audit-logs', 'list', filter] as const,
} as const;

/**
 * カーソル送りの一覧を読む共通フック。
 *
 * `getNextPageParam` が `null` を返したら次ページ無しになる。TanStack Query の
 * 判定は `getNextPageParam(...) != null`（`@tanstack/query-core` の
 * `build/modern/infiniteQueryBehavior.js:84`）なので、`undefined` に変換する必要はない。
 * サーバの `nextCursor` をそのまま渡せる。
 */
function useAdminCursorQuery<TItem>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | null) => Promise<CursorPage<TItem>>,
) {
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: CursorPage<TItem>) => lastPage.nextCursor,
  });
}

/**
 * 管理画面の書き込みが必ず通る 1 本の道。
 *
 * 成功したときだけキャッシュを捨てる。失敗時に捨てると、409（他の管理者が先に処理した）で
 * 一覧が再取得されて「押したのに何も起きていないように見える」画面になる。
 * 再取得は利用者がエラーを読んでから自分で選ぶ。
 *
 * `toInvalidatedKeys` が引数を受け取るのは、同じフックでも渡した値で影響範囲が変わるため
 * （申請の承認は店舗とユーザーにも波及するが、差し戻しは申請だけで閉じる）。
 */
function useAdminMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  toInvalidatedKeys: (variables: TVariables) => readonly QueryKey[],
): UseMutationResult<TResult, Error, TVariables> {
  const queryClient = useQueryClient();

  return useMutation<TResult, Error, TVariables>({
    mutationFn,
    onSuccess: async (_result, variables) => {
      await Promise.all(
        toInvalidatedKeys(variables).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

/** すべての書き込みが増やすので、どの mutation もここを捨てる */
const AUDIT_LOG_KEYS: readonly QueryKey[] = [adminQueryKeys.auditLogs()];

// ───────────────────────── 概況 ─────────────────────────

export function useOverview() {
  return useQuery({ queryKey: adminQueryKeys.overview(), queryFn: fetchOverview });
}

// ───────────────────────── 申請 ─────────────────────────

export function useApplications(filter: ApplicationFilter) {
  return useAdminCursorQuery(adminQueryKeys.applicationList(filter), (cursor) =>
    fetchApplications({ ...filter, cursor }),
  );
}

export function useApplication(applicationId: string) {
  return useQuery({
    queryKey: adminQueryKeys.application(applicationId),
    queryFn: () => fetchApplication(applicationId),
    // 画面遷移の途中で ID が空になることがある。`/admin/applications/` を投げても意味がない
    enabled: applicationId !== '',
  });
}

export function useReviewApplication() {
  return useAdminMutation(
    (variables: { readonly applicationId: string; readonly review: ApplicationReview }) =>
      reviewApplication(variables.applicationId, variables.review),
    (variables) =>
      variables.review.decision === 'approve'
        ? // 承認は店舗を公開し、申請者を owner に上げる。波及先が広いのでまとめて捨てる
          [adminQueryKeys.root()]
        : [adminQueryKeys.applications(), adminQueryKeys.overview(), ...AUDIT_LOG_KEYS],
  );
}

// ───────────────────────── 通報 ─────────────────────────

export function useReports(filter: ReportFilter) {
  return useAdminCursorQuery(adminQueryKeys.reportList(filter), (cursor) =>
    fetchReports({ ...filter, cursor }),
  );
}

export function useReport(reportId: string) {
  return useQuery({
    queryKey: adminQueryKeys.report(reportId),
    queryFn: () => fetchReport(reportId),
    enabled: reportId !== '',
  });
}

export function useResolveReport() {
  return useAdminMutation(
    (variables: { readonly reportId: string; readonly decision: ReportDecision }) =>
      resolveReport(variables.reportId, variables.decision),
    // 対処の対象がレビューか店舗かユーザーかは引数から分からない。まとめて捨てる
    () => [adminQueryKeys.root()],
  );
}

export function useRejectReport() {
  return useAdminMutation(
    (variables: { readonly reportId: string }) => rejectReport(variables.reportId),
    // 却下は通報の行だけを閉じる。他の実体は動かない
    () => [adminQueryKeys.reports(), adminQueryKeys.overview(), ...AUDIT_LOG_KEYS],
  );
}

// ───────────────────────── ユーザー ─────────────────────────

export function useUsers(filter: UserFilter) {
  return useAdminCursorQuery(adminQueryKeys.userList(filter), (cursor) =>
    fetchUsers({ ...filter, cursor }),
  );
}

export function useUser(userId: string) {
  return useQuery({
    queryKey: adminQueryKeys.user(userId),
    queryFn: () => fetchUser(userId),
    enabled: userId !== '',
  });
}

/** ユーザーの状態・ロールを変えたときに捨てるキー */
const USER_WRITE_KEYS: readonly QueryKey[] = [adminQueryKeys.users(), ...AUDIT_LOG_KEYS];

export function useSuspendUser() {
  return useAdminMutation(
    (variables: { readonly userId: string }) => suspendUser(variables.userId),
    () => USER_WRITE_KEYS,
  );
}

export function useRestoreUser() {
  return useAdminMutation(
    (variables: { readonly userId: string }) => restoreUser(variables.userId),
    () => USER_WRITE_KEYS,
  );
}

export function useChangeUserRole() {
  return useAdminMutation(
    (variables: { readonly userId: string; readonly role: Role }) =>
      changeUserRole(variables.userId, variables.role),
    () => USER_WRITE_KEYS,
  );
}

// ───────────────────────── 店舗 ─────────────────────────

export function useShops(filter: ShopFilter) {
  return useAdminCursorQuery(adminQueryKeys.shopList(filter), (cursor) =>
    fetchShops({ ...filter, cursor }),
  );
}

export function useShop(shopId: string) {
  return useQuery({
    queryKey: adminQueryKeys.shop(shopId),
    queryFn: () => fetchShop(shopId),
    enabled: shopId !== '',
  });
}

/** 店舗の状態を変えたときに捨てるキー */
const SHOP_WRITE_KEYS: readonly QueryKey[] = [adminQueryKeys.shops(), ...AUDIT_LOG_KEYS];

export function useSuspendShop() {
  return useAdminMutation(
    (variables: { readonly shopId: string }) => suspendShop(variables.shopId),
    () => SHOP_WRITE_KEYS,
  );
}

export function useRestoreShop() {
  return useAdminMutation(
    (variables: { readonly shopId: string }) => restoreShop(variables.shopId),
    () => SHOP_WRITE_KEYS,
  );
}

export function useAssignShopOwner() {
  return useAdminMutation(
    (variables: { readonly shopId: string; readonly ownerId: string | null }) =>
      assignShopOwner(variables.shopId, variables.ownerId),
    // 付け替えは店舗の ownerId とユーザー詳細の shopCount の両方を動かす
    () => [adminQueryKeys.shops(), adminQueryKeys.users(), ...AUDIT_LOG_KEYS],
  );
}

// ───────────────────────── マスタ ─────────────────────────

export function useGenres() {
  return useQuery({ queryKey: adminQueryKeys.genres(), queryFn: fetchGenres });
}

const GENRE_WRITE_KEYS: readonly QueryKey[] = [adminQueryKeys.genres(), ...AUDIT_LOG_KEYS];

export function useCreateGenre() {
  return useAdminMutation(
    (variables: { readonly input: GenreInput }) => createGenre(variables.input),
    () => GENRE_WRITE_KEYS,
  );
}

export function useUpdateGenre() {
  return useAdminMutation(
    (variables: { readonly genreId: string; readonly input: GenreInput }) =>
      updateGenre(variables.genreId, variables.input),
    () => GENRE_WRITE_KEYS,
  );
}

export function useDeleteGenre() {
  return useAdminMutation(
    (variables: { readonly genreId: string }) => deleteGenre(variables.genreId),
    () => GENRE_WRITE_KEYS,
  );
}

export function useAreas() {
  return useQuery({ queryKey: adminQueryKeys.areas(), queryFn: fetchAreas });
}

const AREA_WRITE_KEYS: readonly QueryKey[] = [adminQueryKeys.areas(), ...AUDIT_LOG_KEYS];

export function useCreateArea() {
  return useAdminMutation(
    (variables: { readonly input: AreaInput }) => createArea(variables.input),
    () => AREA_WRITE_KEYS,
  );
}

export function useUpdateArea() {
  return useAdminMutation(
    (variables: { readonly areaId: string; readonly input: AreaInput }) =>
      updateArea(variables.areaId, variables.input),
    () => AREA_WRITE_KEYS,
  );
}

export function useDeleteArea() {
  return useAdminMutation(
    (variables: { readonly areaId: string }) => deleteArea(variables.areaId),
    () => AREA_WRITE_KEYS,
  );
}

// ───────────────────────── お知らせ ─────────────────────────

export function useAnnouncementHistory() {
  return useAdminCursorQuery(adminQueryKeys.announcementList(), (cursor) =>
    fetchAnnouncementHistory({ cursor }),
  );
}

export function useSendAnnouncement() {
  return useAdminMutation(
    (variables: { readonly input: AnnouncementInput }) => sendAnnouncement(variables.input),
    () => [adminQueryKeys.announcements(), ...AUDIT_LOG_KEYS],
  );
}

// ───────────────────────── 監査ログ ─────────────────────────

export function useAuditLogs(filter: AuditLogFilter) {
  return useAdminCursorQuery(adminQueryKeys.auditLogList(filter), (cursor) =>
    fetchAuditLogs({ ...filter, cursor }),
  );
}

export function useUndoAuditLog() {
  return useAdminMutation(
    (variables: { readonly auditLogId: string }) => undoAuditLog(variables.auditLogId),
    // 取り消しは元の操作次第で何が戻るか分からない。管理配下をまるごと捨てる
    () => [adminQueryKeys.root()],
  );
}
```

**`AUDIT_LOG_KEYS` を毎回スプレッドで展開している理由**：`[adminQueryKeys.users(), AUDIT_LOG_KEYS]` と書き間違えると入れ子の配列になるが、`QueryKey` は `readonly unknown[]` なので**型では止まらない**。スプレッドで平らにしておけば、実行時のキー比較テスト（Step 18 の `expectedKeys`）が必ず落ちる。

- [ ] **Step 21: テストが通ることを確認する**

Run:

```bash
npm test -w @meshimap/mobile -- features/admin/queries
npm run typecheck -w @meshimap/mobile
```

Expected: PASS（`adminQueryKeys` 3 件 + 取得系 13 + 網羅 1 + 空 ID 4 + カーソル 2 + 書き込み系 17 + 監査ログ 17 + 網羅 1 + 承認 1 + 失敗 1 = 60 件）。

`renderHook` に `await` が付いていないと「An update to QueryWrapper inside a test was not wrapped in act(...)」が出る。RNTL 14 では `render` / `fireEvent` / `renderHook` がすべて非同期なので、**警告を消すために `act` で囲むのではなく `await` を付ける**こと。

- [ ] **Step 22: わざと壊して、テストが落ちることを確認する**

1 つずつ戻しながら試す。

| 壊し方                                                                              | 落ちるべきテスト                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getNextPageParam` を `() => null` にする                                           | 「一覧は nextCursor を次ページのカーソルとして扱う」                                                                                                                                                                                                                                                                                                                                                                                       |
| `initialPageParam` を `null as string \| null` から `'' as string \| null` に変える | 取得系の `useUsers`（`toSearchParams` が空文字を落とさず `cursor=` を送る。api.test.ts 側の期待と食い違う）→ **未確認**: 空文字は `toSearchParams` の `value === null` 判定を通り抜けるため `cursor=''` が送られるが、`apiFetch` をモックしている queries.test.tsx では検出できない。実際に落ちるのは `api.test.ts` ではなく型チェックでもないので、**この壊し方は queries.test.tsx では検出できない**。検出のため、下の追加テストを入れる |
| `useSuspendUser` の無効化キーから `AUDIT_LOG_KEYS` を外す                           | 「useSuspendUser が成功し、想定のキーを無効化する」と「useSuspendUser は監査ログを必ず無効化する」                                                                                                                                                                                                                                                                                                                                         |
| `onSuccess` を `onSettled` に変える                                                 | 「失敗したときは無効化しない」                                                                                                                                                                                                                                                                                                                                                                                                             |
| `useApplication` の `enabled` を消す                                                | 「useApplication は ID が空なら通信しない」                                                                                                                                                                                                                                                                                                                                                                                                |
| `useResolveReport` の無効化を `[adminQueryKeys.reports()]` にする                   | 「useResolveReport が成功し、想定のキーを無効化する」                                                                                                                                                                                                                                                                                                                                                                                      |
| `adminQueryKeys.applicationList` の `'applications'` を `'application-list'` にする | 「一覧と詳細は同じ接頭辞を共有する」                                                                                                                                                                                                                                                                                                                                                                                                       |
| `adminQueryKeys.applicationList` から `filter` を落とす                             | 「一覧のキーは絞り込み条件を含む」                                                                                                                                                                                                                                                                                                                                                                                                         |

2 行目が検出できなかったので、`queries.test.tsx` の「取得系フック」に次を足す。

```tsx
it('最初のページはカーソル無しで取りに行く', async () => {
  apiFetchMock.mockResolvedValue(page(USER_SUMMARY));
  const queryClient = createTestQueryClient();

  const { result } = await renderHook(() => useUsers({ keyword: null, role: null, status: null }), {
    wrapper: createWrapper(queryClient),
  });

  await waitFor(() => {
    expect(result.current.isSuccess).toBe(true);
  });
  // 空文字のカーソルを渡すと `cursor=` が付いた URL になり、サーバの
  // `cursorSchema` が 422 を返す。初回は必ず null でなければならない
  expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/admin/users');
});
```

これで `initialPageParam` を `''` にすると `'/admin/users?cursor='` になって落ちる。追加後、もう一度 2 行目の壊し方を試して落ちることを確認してから戻す。

- [ ] **Step 23: モバイル全体のテストとカバレッジを確認する**

Run:

```bash
npm run test:coverage -w @meshimap/mobile
npm run lint
npm run format:check
```

Expected: PASS。`features/admin/{types,labels,api,queries}.ts` の 4 本が statements / branches / functions / lines すべて 100%。

100% に届かない場合、**閾値を下げたり `collectCoverageFrom` から除外したりしない**。届いていない行は「呼ばれ方が 1 通りしかない分岐」なので、その分岐を消すか、テストを足すかのどちらかを選ぶ。

- [ ] **Step 24: コミットする**

```bash
git add apps/mobile/src/features/admin/types.ts \
        apps/mobile/src/features/admin/types.test.ts \
        apps/mobile/src/features/admin/labels.ts \
        apps/mobile/src/features/admin/labels.test.ts \
        apps/mobile/src/features/admin/api.ts \
        apps/mobile/src/features/admin/api.test.ts \
        apps/mobile/src/features/admin/queries.ts \
        apps/mobile/src/features/admin/queries.test.tsx \
        apps/mobile/src/constants/http.ts \
        apps/mobile/src/constants/http.test.ts
git commit -m "feat(mobile): 管理画面の型・API 呼び出し・クエリ層を追加"
```

---

### Task 9-20: 画面の共有スキャフォールド（一覧 / 詳細 / 操作行 / KPI カード）

管理画面 13 枚のうち、**一覧が 6 枚（申請・通報・ユーザー・店舗・お知らせ履歴・監査ログ）、詳細が 4 枚**ある。どれも「読み込み中 / 失敗 / 空 / 本体 / 追加読み込み」の 5 状態を持つ。13 枚それぞれに書くと、5 状態 × 13 のテストを書くことになり、しかも 1 枚だけ空状態を忘れても誰も気づかない。

ここで**状態の出し分けを 1 箇所に閉じ込め**、各画面は「何を並べるか」だけを書くようにする。この Task の成果物は画面を 1 枚も含まないが、独立してテストでき、レビュアーはここだけを差し戻せる。

**Files:**

- Create: `apps/mobile/src/features/admin/testing/query-wrapper.tsx`
- Modify: `apps/mobile/src/features/admin/queries.test.tsx`
- Create: `apps/mobile/src/features/admin/components/admin-list-screen.tsx`
- Test: `apps/mobile/src/features/admin/components/admin-list-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/components/admin-detail-screen.tsx`
- Test: `apps/mobile/src/features/admin/components/admin-detail-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/components/action-row.tsx`
- Test: `apps/mobile/src/features/admin/components/action-row.test.tsx`
- Create: `apps/mobile/src/features/admin/components/stat-card.tsx`
- Test: `apps/mobile/src/features/admin/components/stat-card.test.tsx`

**Interfaces:**

- Consumes:
  - `@/components/ui/{button,card,empty-state,error-state,icon,skeleton}`（Task 9-18 より前から実在。props は実ファイルで確認済み）
  - `@/constants/theme` の `COLORS` / `SPACING`
  - `./types` の `CursorPage<TItem>`（Task 9-19）
- Produces:
  - `createTestQueryClient(): QueryClient` / `wrapperFor(queryClient): ComponentType<{ children: ReactNode }>` / `renderWithQuery(ui): Promise<RenderResult & { queryClient: QueryClient }>`
  - `AdminListQuery<TItem>` / `AdminListScreen<TItem>(props)`
  - `AdminDetailQuery<TData>` / `AdminDetailScreen<TData>(props)`
  - `ActionRow(props)`
  - `StatCard(props)`

- [ ] **Step 1: 4 つの設計を先に決める**

1. **`isPending` を使わない。**`data === undefined` で読み込み中を判定する。`isPending` と `data` の両方で分岐すると「`isPending` が false で `data` が `undefined`」という**到達しない枝**ができ、カバレッジ 100% が永久に達成できなくなる。TanStack Query では取得前・`enabled: false` のどちらも `data` が `undefined` なので、1 つの条件で足りる。
2. **無限スクロールにしない。**末尾に「もっと読む」ボタンを置く。理由は 2 つ。審査キューは「流し読みして眺めるもの」ではなく「1 件ずつ処理するもの」なので、勝手に次が読まれるより押して進む方が制御しやすい。もう 1 つは、`FlatList` の `onEndReached` を RNTL から発火させるにはスクロール座標を捏造する必要があり、テストがレイアウトの実装詳細に張り付くため。
3. **クエリ結果は丸ごと渡す。**画面が `isError` / `hasNextPage` … と 6 個をばらして渡すと、6 枚の一覧で 36 行の同じ受け渡しが増える。必要な形だけを書いた `AdminListQuery<TItem>` を用意し、`UseInfiniteQueryResult` をそのまま代入する。
4. **空でもヘッダは出す。**絞り込みチップが空状態で消えると、条件を戻せなくなって手詰まりになる。

- [ ] **Step 2: テスト用の QueryClient ラッパを切り出す**

`apps/mobile/src/features/admin/testing/query-wrapper.tsx`

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react-native';
import type { ComponentType, ReactElement, ReactNode } from 'react';

/**
 * テスト専用の QueryClient。
 *
 * 再試行を切るのは、失敗系のテストが 3 回ぶんの待ち時間で
 * 「何を検証しているのか分からないタイムアウト」として落ちるのを防ぐため。
 * テストごとに新しく作る。使い回すとキャッシュが次のテストへ漏れる。
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/** `renderHook` の `wrapper` に渡すコンポーネントを作る */
export function wrapperFor(queryClient: QueryClient): ComponentType<{ children: ReactNode }> {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/**
 * 画面テスト用の描画。
 * RNTL 14 の `render` は非同期なので await が要る。
 * 作った QueryClient も返すので、キャッシュの中身を後から確かめられる。
 */
export async function renderWithQuery(
  ui: ReactElement,
): Promise<RenderResult & { queryClient: QueryClient }> {
  const queryClient = createTestQueryClient();
  const result = await render(ui, { wrapper: wrapperFor(queryClient) });

  return { ...result, queryClient };
}
```

**`src/features/admin/testing/` に置く理由。**`apps/mobile/jest.config.js` の `collectCoverageFrom` は `src/**/*.{ts,tsx}` から `*.test.*` と `src/app/**` だけを除く。つまりこのファイルもカバレッジの対象になる。3 つの export はすべてどこかのテストから呼ばれるので 100% になる。**「テスト用だから」と除外設定を足さないこと**（除外を 1 つ許すと、次から実装コードも同じ理由で除外される）。

- [ ] **Step 3: `queries.test.tsx` の重複を消す**

Task 9-19 で `queries.test.tsx` に書いた `createTestQueryClient` と `createWrapper` を削除し、共有のものに差し替える。

```tsx
// 削除する（ファイル内の定義）
// function createTestQueryClient(): QueryClient { ... }
// function createWrapper(queryClient: QueryClient) { ... }

// import に足す
import { createTestQueryClient, wrapperFor } from './testing/query-wrapper';
```

呼び出し側 `wrapper: createWrapper(queryClient)` を `wrapper: wrapperFor(queryClient)` に一括置換する。`QueryClient` / `QueryClientProvider` / `ReactNode` の import が未使用になるので消す（`noUnusedLocals` で落ちる）。

Run: `npm test -w @meshimap/mobile -- features/admin/queries`
Expected: PASS（**61 件**）。内訳は Task 9-19 Step 21 の 60 件 + Step 22 で `queries.test.tsx` に足した「最初のページはカーソル無しで取りに行く」1 件。**Step 21 の 60 件のままだと思い込まないこと。** 61 件から変わったら差し替えを間違えている。

- [ ] **Step 4: 一覧スキャフォールドの失敗するテストを書く**

`apps/mobile/src/features/admin/components/admin-list-screen.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Inbox } from 'lucide-react-native';
import { Text } from 'react-native';

import { AdminListScreen, type AdminListQuery } from './admin-list-screen';

type TestItem = { readonly id: string; readonly name: string };

const ITEM_A: TestItem = { id: 'a', name: 'あんこ' };
const ITEM_B: TestItem = { id: 'b', name: 'ばなな' };

const EMPTY_TITLE = '対象がありません';
const EMPTY_DESCRIPTION = '条件を変えて探してください';
const ERROR_TITLE = '一覧を読み込めませんでした';
const TEST_ID = 'test-list';

/**
 * 既定は「1 件だけ取得済み・次ページ無し・失敗していない」。
 * 各テストは変えたい 1 項目だけを上書きする（何を試しているかが差分で読める）。
 */
function buildQuery(overrides: Partial<AdminListQuery<TestItem>> = {}): AdminListQuery<TestItem> {
  return {
    data: { pages: [{ items: [ITEM_A], nextCursor: null }] },
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    ...overrides,
  };
}

function renderList(query: AdminListQuery<TestItem>, header?: React.ReactElement) {
  return render(
    <AdminListScreen
      query={query}
      keyOf={(item) => item.id}
      renderItem={(item) => <Text testID={`row-${item.id}`}>{item.name}</Text>}
      emptyIcon={Inbox}
      emptyTitle={EMPTY_TITLE}
      emptyDescription={EMPTY_DESCRIPTION}
      errorTitle={ERROR_TITLE}
      header={header}
      testID={TEST_ID}
    />,
  );
}

describe('AdminListScreen', () => {
  it('データが未取得なら骨組みを出す', async () => {
    await renderList(buildQuery({ data: undefined }));

    expect(screen.getByTestId(`${TEST_ID}-loading`)).toBeOnTheScreen();
    expect(screen.queryByTestId(TEST_ID)).not.toBeOnTheScreen();
  });

  it('失敗したらエラー表示を出す', async () => {
    await renderList(buildQuery({ isError: true, data: undefined }));

    expect(screen.getByText(ERROR_TITLE)).toBeOnTheScreen();
  });

  it('取得済みでも失敗していればエラーを優先する', async () => {
    // 背面での再取得が失敗したときに、古いデータを黙って見せ続けない
    await renderList(buildQuery({ isError: true }));

    expect(screen.getByText(ERROR_TITLE)).toBeOnTheScreen();
    expect(screen.queryByTestId('row-a')).not.toBeOnTheScreen();
  });

  it('再試行を押すと refetch を呼ぶ', async () => {
    const query = buildQuery({ isError: true, data: undefined });
    await renderList(query);

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-error-retry-button`));

    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('0 件なら空表示を出す', async () => {
    await renderList(buildQuery({ data: { pages: [{ items: [], nextCursor: null }] } }));

    expect(screen.getByText(EMPTY_TITLE)).toBeOnTheScreen();
    expect(screen.getByText(EMPTY_DESCRIPTION)).toBeOnTheScreen();
  });

  it('0 件でもヘッダは残す', async () => {
    // ヘッダに絞り込みが乗る。空のときに消すと条件を戻せなくなる
    await renderList(
      buildQuery({ data: { pages: [{ items: [], nextCursor: null }] } }),
      <Text testID="list-header">絞り込み</Text>,
    );

    expect(screen.getByTestId('list-header')).toBeOnTheScreen();
  });

  it('行を描画する', async () => {
    await renderList(buildQuery());

    expect(screen.getByText('あんこ')).toBeOnTheScreen();
  });

  it('複数ページを 1 本のリストにつなぐ', async () => {
    await renderList(
      buildQuery({
        data: {
          pages: [
            { items: [ITEM_A], nextCursor: '1:a' },
            { items: [ITEM_B], nextCursor: null },
          ],
        },
      }),
    );

    expect(screen.getByText('あんこ')).toBeOnTheScreen();
    expect(screen.getByText('ばなな')).toBeOnTheScreen();
  });

  it('一覧のときもヘッダを出す', async () => {
    await renderList(buildQuery(), <Text testID="list-header">絞り込み</Text>);

    expect(screen.getByTestId('list-header')).toBeOnTheScreen();
  });

  it('次ページがあれば追加読み込みのボタンを出す', async () => {
    const query = buildQuery({ hasNextPage: true });
    await renderList(query);

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-load-more`));

    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('次ページが無ければ追加読み込みのボタンを出さない', async () => {
    await renderList(buildQuery());

    expect(screen.queryByTestId(`${TEST_ID}-load-more`)).not.toBeOnTheScreen();
  });

  it('追加読み込み中はボタンを押せない', async () => {
    const query = buildQuery({ hasNextPage: true, isFetchingNextPage: true });
    await renderList(query);

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-load-more`));

    // Button は isLoading を押下不可として扱う（components/ui/button.tsx の isInteractionBlocked）
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/admin-list-screen`
Expected: FAIL。`Cannot find module './admin-list-screen'`。

- [ ] **Step 6: 一覧スキャフォールドを実装する**

`apps/mobile/src/features/admin/components/admin-list-screen.tsx`

```tsx
import type { LucideIcon } from 'lucide-react-native';
import type { ReactElement } from 'react';
import { FlatList, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { SPACING } from '@/constants/theme';

import type { CursorPage } from '../types';

/**
 * 一覧画面が `useInfiniteQuery` の戻り値から必要とする最小の形。
 *
 * `UseInfiniteQueryResult<CursorPage<TItem>, Error>` はこれを満たすので、
 * 画面側は `query={useUsers(filter)}` と渡すだけでよい。
 * `refetch` / `fetchNextPage` の戻り値が Promise でも、`() => void` を要求する
 * この型には代入できる（TypeScript は void 戻りの関数型に任意の戻り値を許す）。
 */
export interface AdminListQuery<TItem> {
  readonly data: { readonly pages: readonly CursorPage<TItem>[] } | undefined;
  readonly isError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly refetch: () => void;
  readonly fetchNextPage: () => void;
}

export interface AdminListScreenProps<TItem> {
  query: AdminListQuery<TItem>;
  /** 行の key。ID を返す */
  keyOf: (item: TItem) => string;
  renderItem: (item: TItem) => ReactElement;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  errorTitle: string;
  /** 絞り込みなど、一覧の上に固定で出すもの。空のときも消さない */
  header?: ReactElement | undefined;
  testID: string;
}

/** 読み込み中に見せる骨組みの行。多すぎると読み込みが遅く見えるので 1 画面ぶんに収める */
const SKELETON_ROW_KEYS = [1, 2, 3, 4, 5] as const;
const SKELETON_ROW_HEIGHT_PX = 88;

const LOAD_MORE_LABEL = 'もっと読む';

/** FlatList の中身の余白。className ではなく style で渡す（contentContainer は className を受けない） */
const CONTENT_CONTAINER_STYLE = { gap: SPACING.sm, padding: SPACING.md };

export function AdminListScreen<TItem>({
  query,
  keyOf,
  renderItem,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  errorTitle,
  header,
  testID,
}: AdminListScreenProps<TItem>) {
  // 失敗を最優先で出す。取得済みのデータが残っていても、
  // 「再取得に失敗した古い一覧」を黙って見せると、処理済みの申請をもう一度開くことになる
  if (query.isError) {
    return <ErrorState title={errorTitle} onRetry={query.refetch} testID={`${testID}-error`} />;
  }

  if (query.data === undefined) {
    return (
      <View style={CONTENT_CONTAINER_STYLE} testID={`${testID}-loading`}>
        {SKELETON_ROW_KEYS.map((rowKey) => (
          <Skeleton key={rowKey} height={SKELETON_ROW_HEIGHT_PX} />
        ))}
      </View>
    );
  }

  const items = query.data.pages.flatMap((page) => page.items);

  if (items.length === 0) {
    return (
      <View style={CONTENT_CONTAINER_STYLE} testID={`${testID}-empty-container`}>
        {header}
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          testID={`${testID}-empty`}
        />
      </View>
    );
  }

  return (
    <FlatList
      testID={testID}
      data={items}
      keyExtractor={keyOf}
      renderItem={({ item }) => renderItem(item)}
      ListHeaderComponent={header}
      contentContainerStyle={CONTENT_CONTAINER_STYLE}
      ListFooterComponent={
        query.hasNextPage ? (
          <Button
            label={LOAD_MORE_LABEL}
            variant="outline"
            onPress={query.fetchNextPage}
            isLoading={query.isFetchingNextPage}
            testID={`${testID}-load-more`}
          />
        ) : null
      }
    />
  );
}
```

- [ ] **Step 7: テストが通ることを確認する**

Run:

```bash
npm test -w @meshimap/mobile -- features/admin/components/admin-list-screen
npm run typecheck -w @meshimap/mobile
```

Expected: PASS（12 件）。

型チェックで `AdminListQuery` に `UseInfiniteQueryResult` を代入できないと分かった場合（この Task では実型を代入していないので**未確認**）、**`AdminListQuery` を緩めて `unknown` や `any` を入れないこと**。代わりに Task 9-21 の画面側で必要な 6 つを明示的に渡す形に変え、`AdminListScreenProps` から `query` を 6 個の props に展開する。テストの `buildQuery` は同じ形のまま使える。

- [ ] **Step 8: わざと壊して、テストが落ちることを確認する**

| 壊し方                                                                          | 落ちるべきテスト                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `if (query.isError)` を `if (query.isError && query.data === undefined)` にする | 「取得済みでも失敗していればエラーを優先する」       |
| 空のときの `{header}` を消す                                                    | 「0 件でもヘッダは残す」                             |
| `ListHeaderComponent` を消す                                                    | 「一覧のときもヘッダを出す」                         |
| `flatMap` を `query.data.pages[0]?.items ?? []` にする                          | 「複数ページを 1 本のリストにつなぐ」                |
| `isLoading={query.isFetchingNextPage}` を消す                                   | 「追加読み込み中はボタンを押せない」                 |
| `query.hasNextPage ? ... : null` を常に Button にする                           | 「次ページが無ければ追加読み込みのボタンを出さない」 |

- [ ] **Step 9: 詳細スキャフォールドの失敗するテストを書く**

`apps/mobile/src/features/admin/components/admin-detail-screen.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AdminDetailScreen, type AdminDetailQuery } from './admin-detail-screen';

type TestData = { readonly name: string };

const TITLE = '申請の詳細';
const ERROR_TITLE = '詳細を読み込めませんでした';
const TEST_ID = 'test-detail';

function buildQuery(
  overrides: Partial<AdminDetailQuery<TestData>> = {},
): AdminDetailQuery<TestData> {
  return { data: { name: '一番亭' }, isError: false, refetch: jest.fn(), ...overrides };
}

function renderDetail(query: AdminDetailQuery<TestData>) {
  return render(
    <AdminDetailScreen
      query={query}
      title={TITLE}
      errorTitle={ERROR_TITLE}
      renderContent={(data) => <Text testID="detail-body">{data.name}</Text>}
      testID={TEST_ID}
    />,
  );
}

describe('AdminDetailScreen', () => {
  it('見出しはどの状態でも出す', async () => {
    // 読み込み中に見出しが消えると、戻るまで何の画面か分からなくなる
    await renderDetail(buildQuery({ data: undefined }));

    expect(screen.getByText(TITLE)).toBeOnTheScreen();
  });

  it('データが未取得なら骨組みを出す', async () => {
    await renderDetail(buildQuery({ data: undefined }));

    expect(screen.getByTestId(`${TEST_ID}-loading`)).toBeOnTheScreen();
    expect(screen.queryByTestId('detail-body')).not.toBeOnTheScreen();
  });

  it('失敗したらエラー表示を出す', async () => {
    await renderDetail(buildQuery({ isError: true, data: undefined }));

    expect(screen.getByText(ERROR_TITLE)).toBeOnTheScreen();
  });

  it('取得済みでも失敗していればエラーを優先する', async () => {
    await renderDetail(buildQuery({ isError: true }));

    expect(screen.queryByTestId('detail-body')).not.toBeOnTheScreen();
  });

  it('再試行を押すと refetch を呼ぶ', async () => {
    const query = buildQuery({ isError: true, data: undefined });
    await renderDetail(query);

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-error-retry-button`));

    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it('取得できたら本体を描画する', async () => {
    await renderDetail(buildQuery());

    expect(screen.getByText('一番亭')).toBeOnTheScreen();
  });
});
```

- [ ] **Step 10: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/admin-detail-screen`
Expected: FAIL。`Cannot find module './admin-detail-screen'`。

- [ ] **Step 11: 詳細スキャフォールドを実装する**

`apps/mobile/src/features/admin/components/admin-detail-screen.tsx`

```tsx
import type { ReactElement } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { SPACING } from '@/constants/theme';

/** 詳細画面が `useQuery` の戻り値から必要とする最小の形 */
export interface AdminDetailQuery<TData> {
  readonly data: TData | undefined;
  readonly isError: boolean;
  readonly refetch: () => void;
}

export interface AdminDetailScreenProps<TData> {
  query: AdminDetailQuery<TData>;
  title: string;
  errorTitle: string;
  renderContent: (data: TData) => ReactElement;
  testID: string;
}

/** 骨組みの行。見出し・本文 2 行・操作 1 つ、という詳細画面の骨格に合わせる */
const SKELETON_ROWS = [
  { key: 'title', height: 24 },
  { key: 'body-1', height: 16 },
  { key: 'body-2', height: 16 },
  { key: 'action', height: 44 },
] as const;

const CONTENT_CONTAINER_STYLE = { gap: SPACING.md, padding: SPACING.md };

export function AdminDetailScreen<TData>({
  query,
  title,
  errorTitle,
  renderContent,
  testID,
}: AdminDetailScreenProps<TData>) {
  return (
    <ScrollView testID={testID} contentContainerStyle={CONTENT_CONTAINER_STYLE}>
      <Text className="font-display text-xl text-neutral-900">{title}</Text>
      {renderBody({ query, errorTitle, renderContent, testID })}
    </ScrollView>
  );
}

/**
 * 本体の出し分け。
 * 三項演算子を重ねると「失敗していないのにデータが無い」という到達しない枝ができるので、
 * early return を並べた関数に切り出す。
 */
function renderBody<TData>({
  query,
  errorTitle,
  renderContent,
  testID,
}: Omit<AdminDetailScreenProps<TData>, 'title'>): ReactElement {
  if (query.isError) {
    return <ErrorState title={errorTitle} onRetry={query.refetch} testID={`${testID}-error`} />;
  }

  if (query.data === undefined) {
    return (
      <View className="gap-sm" testID={`${testID}-loading`}>
        {SKELETON_ROWS.map((row) => (
          <Skeleton key={row.key} height={row.height} />
        ))}
      </View>
    );
  }

  return renderContent(query.data);
}
```

- [ ] **Step 12: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/admin-detail-screen`
Expected: PASS（6 件）。

わざと壊す: `renderBody` の 2 つの `if` の順番を入れ替える → 「取得済みでも失敗していればエラーを優先する」は通るが、「失敗したらエラー表示を出す」が落ちる（`data` が `undefined` なので骨組みが出る）。確認したら戻す。

- [ ] **Step 13: 操作行と KPI カードの失敗するテストを書く**

`apps/mobile/src/features/admin/components/action-row.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ActionRow } from './action-row';

const TITLE = '強制非公開';
const DESCRIPTION = '検索と地図から外します。あとで戻せます';
const ACTION_LABEL = '非公開にする';
const TEST_ID = 'suspend-shop';

describe('ActionRow', () => {
  it('見出し・説明・ボタンを出す', async () => {
    await render(
      <ActionRow
        title={TITLE}
        description={DESCRIPTION}
        actionLabel={ACTION_LABEL}
        onPress={jest.fn()}
        testID={TEST_ID}
      />,
    );

    expect(screen.getByText(TITLE)).toBeOnTheScreen();
    expect(screen.getByText(DESCRIPTION)).toBeOnTheScreen();
    expect(screen.getByTestId(`${TEST_ID}-button`)).toBeOnTheScreen();
  });

  it('押すと onPress を呼ぶ', async () => {
    const onPress = jest.fn();
    await render(
      <ActionRow
        title={TITLE}
        description={DESCRIPTION}
        actionLabel={ACTION_LABEL}
        onPress={onPress}
        testID={TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-button`));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('送信中は押せない', async () => {
    const onPress = jest.fn();
    await render(
      <ActionRow
        title={TITLE}
        description={DESCRIPTION}
        actionLabel={ACTION_LABEL}
        onPress={onPress}
        isLoading
        testID={TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-button`));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('無効なときは押せない', async () => {
    const onPress = jest.fn();
    await render(
      <ActionRow
        title={TITLE}
        description={DESCRIPTION}
        actionLabel={ACTION_LABEL}
        onPress={onPress}
        isDisabled
        testID={TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-button`));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('破壊的な操作は danger の見た目にする', async () => {
    await render(
      <ActionRow
        title={TITLE}
        description={DESCRIPTION}
        actionLabel={ACTION_LABEL}
        onPress={jest.fn()}
        variant="danger"
        testID={TEST_ID}
      />,
    );

    // Button の danger は bg-red-500。className の中身で確かめる
    expect(screen.getByTestId(`${TEST_ID}-button`).props.className).toContain('bg-red-500');
  });
});
```

`apps/mobile/src/features/admin/components/stat-card.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { FileText } from 'lucide-react-native';

import { StatCard } from './stat-card';

const TEST_ID = 'stat-pending';

describe('StatCard', () => {
  it('ラベルと数値を出す', async () => {
    await render(<StatCard label="未処理の申請" value={12} icon={FileText} testID={TEST_ID} />);

    expect(screen.getByText('未処理の申請')).toBeOnTheScreen();
    expect(screen.getByTestId(`${TEST_ID}-value`)).toHaveTextContent('12');
  });

  it('押せるときは onPress を呼ぶ', async () => {
    const onPress = jest.fn();
    await render(
      <StatCard
        label="未処理の申請"
        value={12}
        icon={FileText}
        onPress={onPress}
        testID={TEST_ID}
      />,
    );

    await fireEvent.press(screen.getByTestId(TEST_ID));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('注意指標が 1 件以上なら赤くする', async () => {
    await render(
      <StatCard label="未処理の通報" value={3} icon={FileText} isAlert testID={TEST_ID} />,
    );

    expect(screen.getByTestId(`${TEST_ID}-value`).props.className).toContain('text-red-700');
  });

  it('注意指標でも 0 件なら赤くしない', async () => {
    // 0 件は「片付いている」状態。赤くすると赤が意味を失う
    await render(
      <StatCard label="未処理の通報" value={0} icon={FileText} isAlert testID={TEST_ID} />,
    );

    expect(screen.getByTestId(`${TEST_ID}-value`).props.className).not.toContain('text-red-700');
  });

  it('注意指標でなければ赤くしない', async () => {
    await render(<StatCard label="新規店舗" value={9} icon={FileText} testID={TEST_ID} />);

    expect(screen.getByTestId(`${TEST_ID}-value`).props.className).not.toContain('text-red-700');
  });
});
```

- [ ] **Step 14: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/action-row features/admin/components/stat-card`
Expected: FAIL。両方とも `Cannot find module`。

- [ ] **Step 15: 操作行と KPI カードを実装する**

`apps/mobile/src/features/admin/components/action-row.tsx`

```tsx
import { Text, View } from 'react-native';

import { Button, type ButtonVariant } from '@/components/ui/button';

export interface ActionRowProps {
  title: string;
  /** 何が起きるか・戻せるかを 1 文で書く。管理者は取り返しがつくかどうかで手が止まる */
  description: string;
  actionLabel: string;
  onPress: () => void;
  variant?: ButtonVariant | undefined;
  isDisabled?: boolean | undefined;
  isLoading?: boolean | undefined;
  testID: string;
}

/** 既定の見た目。取り消せない操作の呼び出し側は 'danger' を明示する */
const DEFAULT_VARIANT: ButtonVariant = 'secondary';

export function ActionRow({
  title,
  description,
  actionLabel,
  onPress,
  variant = DEFAULT_VARIANT,
  isDisabled,
  isLoading,
  testID,
}: ActionRowProps) {
  return (
    <View className="gap-xs border-t border-neutral-200 pt-md" testID={testID}>
      <Text className="font-body-medium text-base text-neutral-900">{title}</Text>
      <Text className="font-body text-sm text-neutral-600">{description}</Text>
      <Button
        label={actionLabel}
        onPress={onPress}
        variant={variant}
        isDisabled={isDisabled}
        isLoading={isLoading}
        testID={`${testID}-button`}
      />
    </View>
  );
}
```

`apps/mobile/src/features/admin/components/stat-card.tsx`

```tsx
import type { LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

export interface StatCardProps {
  label: string;
  value: number;
  icon: LucideIcon;
  /** 押すと対応するキューへ移動する。移動先が無い指標では省く */
  onPress?: (() => void) | undefined;
  /** 未処理件数のように、0 でないこと自体が仕事の残りを意味する指標に立てる */
  isAlert?: boolean | undefined;
  testID: string;
}

const ALERT_VALUE_STYLE = 'text-red-700';
const NORMAL_VALUE_STYLE = 'text-neutral-900';

/** ラベルに添えるアイコンの色。数値より目立たせない */
const ICON_COLOR = COLORS.neutral[500];

/**
 * 数値の色。
 * 0 件は「片付いている」状態なので、注意指標でも赤くしない。
 * 常に赤いと赤が「未処理あり」の合図として機能しなくなる。
 */
function toValueStyle(isAlert: boolean, value: number): string {
  return isAlert && value > 0 ? ALERT_VALUE_STYLE : NORMAL_VALUE_STYLE;
}

export function StatCard({ label, value, icon, onPress, isAlert = false, testID }: StatCardProps) {
  return (
    <Card onPress={onPress} testID={testID}>
      <View className="gap-xs">
        <View className="flex-row items-center gap-xs">
          <Icon icon={icon} size="sm" color={ICON_COLOR} />
          <Text className="font-body text-sm text-neutral-600">{label}</Text>
        </View>
        <Text
          className={`font-display text-xxl ${toValueStyle(isAlert, value)}`}
          testID={`${testID}-value`}
        >
          {value}
        </Text>
      </View>
    </Card>
  );
}
```

- [ ] **Step 16: テストが通ることを確認する**

Run:

```bash
npm test -w @meshimap/mobile -- features/admin/components
npm run typecheck -w @meshimap/mobile
```

Expected: PASS（12 + 6 + 5 + 5 = 28 件）。

- [ ] **Step 17: わざと壊して、テストが落ちることを確認する**

| 壊し方                                                                    | 落ちるべきテスト                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionRow` の `variant = DEFAULT_VARIANT` を `variant = 'danger'` にする | 「破壊的な操作は danger の見た目にする」は通るが、既定が danger になっても落ちるテストが無い → **テストを 1 件足す**（既定は `bg-neutral-100`、下記） |
| `Button` に `isLoading` を渡すのをやめる                                  | 「送信中は押せない」                                                                                                                                  |
| `toValueStyle` の `value > 0` を消す                                      | 「注意指標でも 0 件なら赤くしない」                                                                                                                   |
| `toValueStyle` の `isAlert &&` を消す                                     | 「注意指標でなければ赤くしない」                                                                                                                      |
| `Card` の `onPress={onPress}` を消す                                      | 「押せるときは onPress を呼ぶ」                                                                                                                       |

1 行目が検出できないので、`action-row.test.tsx` に足す。

```tsx
it('既定は目立たない見た目にする', async () => {
  // 詳細画面には破壊的でない操作も並ぶ。既定が danger だと赤が意味を失う
  await render(
    <ActionRow
      title={TITLE}
      description={DESCRIPTION}
      actionLabel={ACTION_LABEL}
      onPress={jest.fn()}
      testID={TEST_ID}
    />,
  );

  expect(screen.getByTestId(`${TEST_ID}-button`).props.className).toContain('bg-neutral-100');
});
```

追加後にもう一度 1 行目の壊し方を試し、落ちることを確認してから戻す。

- [ ] **Step 18: `_dev/catalog.tsx` には足さない**

カタログは `components/ui/` のプリミティブ見本市（実ファイルの冒頭コメントに「プリミティブを足したらここにも追加する」と書いてある）。この Task で作った 4 つは `features/admin/` に属する画面部品で、単体では意味のあるデータを持たない。**カタログには足さない。**代わりに Task 9-21 以降の画面テストで実データとともに検証する。

- [ ] **Step 19: モバイル全体のテストとカバレッジを確認する**

Run:

```bash
npm run test:coverage -w @meshimap/mobile
npm run lint
npm run format:check
```

Expected: PASS。`features/admin/components/*.tsx` と `features/admin/testing/query-wrapper.tsx` が 4 指標すべて 100%。

- [ ] **Step 20: コミットする**

```bash
git add apps/mobile/src/features/admin/testing/query-wrapper.tsx \
        apps/mobile/src/features/admin/queries.test.tsx \
        apps/mobile/src/features/admin/components/
git commit -m "feat(mobile): 管理画面の共有スキャフォールド（一覧 / 詳細 / 操作行 / KPI）を追加"
```

---

### Task 9-21: 画面共通部品（ルート定義 / 日時整形 / 絞り込み選択肢 / 状態バッジ）

Task 9-20 で「一覧の骨」「詳細の骨」は用意できた。ここから先の 13 画面は、どれも次の 4 つを同じように使う。

| 要るもの                 | 13 画面のうち使う画面                                            | ここに切り出さないとどうなるか                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 他画面への遷移先         | 一覧 5 画面 → 詳細 4 画面、more → マスタ 2 / お知らせ / 監査ログ | パス文字列が 13 ファイルに散る。`experiments.typedRoutes` が効いている環境では、ルートを 1 本足しただけで型エラーが十数箇所に散る                                         |
| 日時の表示               | 申請 / 通報 / ユーザー / 店舗 / 監査ログの全一覧・全詳細         | `toLocaleString` を各画面で呼ぶと、端末のロケール設定によって `2026/9/16 9:05` にも `9/16/2026, 9:05 AM` にもなる。監査ログは時刻を突き合わせる画面なので揺れてはいけない |
| 「すべて」を含む絞り込み | approvals / reports / users                                      | `'all'` を語彙型に混ぜる実装が各画面に生えて、いつか `status=all` が API に飛んで 422 になる                                                                              |
| 状態バッジ               | 一覧 5 画面 + 詳細 4 画面                                        | 同じ `pending` が画面ごとに違う色で出る。`Badge` の tone を呼び出し側が毎回決めることになる                                                                               |

**この Task の設計判断は 4 つ。**

**(1) パス文字列を書いてよいのは `routes.ts` だけにする。**`apps/mobile/app.json` に `experiments: { typedRoutes: true }` があるので、`router.push` に渡す文字列は `.expo/types/router.d.ts` に生成されたリテラル合併型と照合される **— されるはずだが、いまはされていない。**確認済みの事実 E-6 / E-7 / E-8 のとおり、`Href` は `.expo/types/router.d.ts` が無いと `string | HrefObject` に退化し、`'/this/route/does/not/exist'` でも `tsc` は exit 0 を返す（実測）。`.expo/` は gitignore されているので、CI や新規クローンでは常にこの退化した状態になる。

したがって「型が守ってくれる」とは書かない。ここでやるのは 2 つ。

- `as const satisfies Record<string, Href>` を付けておく（`.expo/types` がある手元の環境では綴り間違いを捕まえる。無い環境では何もしない）。
- **ルート文字列と `src/app/` 配下の実ファイルの対応をテストで確かめる。**ただしこのテストは 13 本のルートファイルが揃ってからでないと書けないので、**Task 9-24 で `routes.test.ts` に追加する**。この Task で書くのは、実ファイルに依存せず今すぐ検査できること（`/(admin)/` で始まるか、動的ルートのプレースホルダと `params` のキーが一致するか）だけにする。

**(2) 日時は date-fns の `format` で固定の並びにする。**`date-fns@4.4.0` は既に `apps/mobile/package.json` の依存にある（実ファイルで確認）。`format(new Date(2026, 8, 16, 9, 5), 'yyyy/MM/dd HH:mm')` が `2026/09/16 09:05` を返すことは実測済み。タイムゾーンは端末のものを使う（運用者は自分の時計と突き合わせるので、UTC 固定にすると逆に読みにくい）。テストは**ローカル時刻を指定して `Date` を作る**（`new Date(2026, 8, 16, 9, 5)`）ことで、テストを走らせる機械の `TZ` に依存しないようにする。`new Date(0)` と epoch 定数で書くと TZ で結果が変わり、CI で落ちる。

**(3) `'all'` を語彙型に混ぜない。**`WithAll<TValue> = TValue | 'all'` という別の型を作り、API へ渡す直前に `toFilterValue` で `TValue | null` に落とす。`toFilterValue` の第 1 引数は `WithAll<TValue>` ではなく **`string`** にする。理由は 2 つある。

- 将来 `useLocalSearchParams` から絞り込み状態を受けるようになったとき、そこから来る値は `string` で、語彙に無い値が混ざりうる。
- 引数を合併型に絞ると、「語彙に無い値は `null` になる」という肝心の振る舞いをテストで書けない（型で弾かれて、テストファイルがコンパイルできない）。

戻り値は `values.find(...) ?? null` で作る。`filter as TValue` と書くと `'all'` がそのままサーバへ飛んでも型は通ってしまう。**キャストしない実装にすること自体が防御になっている。**

**(4) 状態バッジは 5 種類あるが、実装は 1 つの factory にする。**`Record<語彙, BadgeTone>` の表を 5 つ持ち、`createStatusBadge(labels, tones)` が部品を返す。語彙が増えたら表が `Record` を満たさなくなってコンパイルが止まるので、色の付け忘れが「見た目が地味なだけ」で通り抜けない。5 回書き写すと、`Badge` の props が変わったときに 5 箇所直すことになる。

**未確認:** React Compiler（`app.json` の `experiments.reactCompiler: true`）が factory の内側で定義された関数コンポーネントを最適化対象にするかは確認していない。最適化されなくても描画結果は変わらない（`Badge` は `memo` していない）。もし React Compiler が警告を出すようなら、factory をやめて 5 つ書き下し、`Badge` への props の組み立てだけを共通関数に切り出すこと（**表を 5 つ持つ構造は変えない**。そこが語彙の網羅を保証している部分なので）。

**Files:**

- Create: `apps/mobile/src/features/admin/routes.ts`
- Create: `apps/mobile/src/features/admin/routes.test.ts`
- Create: `apps/mobile/src/features/admin/format.ts`
- Create: `apps/mobile/src/features/admin/format.test.ts`
- Create: `apps/mobile/src/features/admin/components/filter-options.ts`
- Create: `apps/mobile/src/features/admin/components/filter-options.test.ts`
- Create: `apps/mobile/src/features/admin/components/status-badge.tsx`
- Create: `apps/mobile/src/features/admin/components/status-badge.test.tsx`

**Interfaces:**

- Consumes:
  - `Href`（`expo-router`。E-6 のとおり `.expo/types` の有無で強さが変わる）
  - `Badge` / `BadgeTone`（`@/components/ui/badge`）
  - `SelectOption<TValue>`（`@/components/ui/select-field`、Task 9-18）
  - `toSelectOptions` と `APPLICATION_STATUS_LABELS` / `REPORT_STATUS_LABELS` / `PROFILE_STATUS_LABELS` / `SHOP_STATUS_LABELS` / `ROLE_LABELS`（`../labels`、Task 9-19）
  - `APPLICATION_STATUSES` / `REPORT_STATUSES` / `PROFILE_STATUSES` / `SHOP_STATUSES` と各語彙型（`../types`、Task 9-19）、`ROLES` / `Role`（`@meshimap/core`）
  - `date-fns` の `format`
- Produces:
  - `routes.ts`: `ADMIN_ROUTES`（引数のいらない 9 本）、`ADMIN_DETAIL_ROUTES`（ID を取る 4 本 `application` / `report` / `user` / `shop`、いずれも `(id: string) => Href`）
  - `format.ts`: `formatDateTime(epochMs: number): string`、`formatDiffValue(value: unknown): string`、`EMPTY_VALUE_LABEL`
  - `filter-options.ts`: `ALL_FILTER_VALUE`（`'all'`）、`ALL_FILTER_LABEL`（`'すべて'`）、`WithAll<TValue extends string>`、`toFilterOptions(values, labels): SelectOption<WithAll<TValue>>[]`、`toFilterValue(filter: string, values): TValue | null`
  - `status-badge.tsx`: `StatusBadgeProps<TStatus>`、`ApplicationStatusBadge` / `ReportStatusBadge` / `ProfileStatusBadge` / `ShopStatusBadge` / `RoleBadge`

- [ ] **Step 1: ルート定義の失敗するテストを書く**

`apps/mobile/src/features/admin/routes.test.ts`

```ts
import { ADMIN_DETAIL_ROUTES, ADMIN_ROUTES } from './routes';

/** 詳細ルートの関数に渡す、記号を含む ID。パスに直接埋め込んでいたらここで壊れる */
const NASTY_ID = 'a/b?c#d';

describe('ADMIN_ROUTES', () => {
  it('9 本を宣言の順どおり持つ', () => {
    expect(Object.keys(ADMIN_ROUTES)).toEqual([
      'overview',
      'approvals',
      'reports',
      'users',
      'more',
      'genres',
      'areas',
      'announcements',
      'auditLog',
    ]);
  });

  it('すべて (admin) グループの絶対パスになっている', () => {
    for (const pathname of Object.values(ADMIN_ROUTES)) {
      expect(pathname.startsWith('/(admin)/')).toBe(true);
    }
  });

  it('タブの 5 本は (tabs) グループの中を指す', () => {
    const tabRoutes = [
      ADMIN_ROUTES.overview,
      ADMIN_ROUTES.approvals,
      ADMIN_ROUTES.reports,
      ADMIN_ROUTES.users,
      ADMIN_ROUTES.more,
    ];

    for (const pathname of tabRoutes) {
      expect(pathname).toContain('/(tabs)/');
    }
  });

  it('タブ以外の 4 本は (tabs) グループの外を指す', () => {
    // more タブから push する画面。(tabs) の中に置くとタブバーが出たままになり、
    // 「戻る」でタブ切り替えの履歴を遡ってしまう
    const stackRoutes = [
      ADMIN_ROUTES.genres,
      ADMIN_ROUTES.areas,
      ADMIN_ROUTES.announcements,
      ADMIN_ROUTES.auditLog,
    ];

    for (const pathname of stackRoutes) {
      expect(pathname).not.toContain('/(tabs)/');
    }
  });

  it('同じパスを 2 つのキーに割り当てていない', () => {
    const pathnames = Object.values(ADMIN_ROUTES);

    expect(new Set(pathnames).size).toBe(pathnames.length);
  });
});

describe('ADMIN_DETAIL_ROUTES', () => {
  it('4 本を宣言の順どおり持つ', () => {
    expect(Object.keys(ADMIN_DETAIL_ROUTES)).toEqual(['application', 'report', 'user', 'shop']);
  });

  it('ID を params に載せた Href を返す', () => {
    expect(ADMIN_DETAIL_ROUTES.application('app_01')).toEqual({
      pathname: '/(admin)/approvals/[applicationId]',
      params: { applicationId: 'app_01' },
    });
    expect(ADMIN_DETAIL_ROUTES.report('rep_01')).toEqual({
      pathname: '/(admin)/reports/[reportId]',
      params: { reportId: 'rep_01' },
    });
    expect(ADMIN_DETAIL_ROUTES.user('usr_01')).toEqual({
      pathname: '/(admin)/users/[userId]',
      params: { userId: 'usr_01' },
    });
    expect(ADMIN_DETAIL_ROUTES.shop('shp_01')).toEqual({
      pathname: '/(admin)/shops/[shopId]',
      params: { shopId: 'shp_01' },
    });
  });

  it('ID をパス文字列に埋め込まない', () => {
    // 埋め込むと ID の中の / や ? がパスとして解釈される。
    // params に載せておけば expo-router 側が符号化する
    for (const [name, toHref] of Object.entries(ADMIN_DETAIL_ROUTES)) {
      const href = toHref(NASTY_ID);

      if (typeof href === 'string') {
        throw new Error(`${name} が文字列を返した。ID は params に載せること`);
      }
      expect(href.pathname).not.toContain(NASTY_ID);
      expect(Object.values(href.params ?? {})).toEqual([NASTY_ID]);
    }
  });

  it('pathname のプレースホルダと params のキーが一致する', () => {
    for (const [name, toHref] of Object.entries(ADMIN_DETAIL_ROUTES)) {
      const href = toHref('id_01');

      if (typeof href === 'string') {
        throw new Error(`${name} が文字列を返した。ID は params に載せること`);
      }

      // '/(admin)/users/[userId]' → ['[userId]']
      const placeholders = href.pathname.split('/').filter((segment) => segment.startsWith('['));
      const paramKeys = Object.keys(href.params ?? {}).map((key) => `[${key}]`);

      expect(placeholders).toEqual(paramKeys);
    }
  });

  it('すべて (admin) グループの絶対パスになっている', () => {
    for (const toHref of Object.values(ADMIN_DETAIL_ROUTES)) {
      const href = toHref('id_01');

      if (typeof href === 'string') {
        throw new Error('詳細ルートが文字列を返した。ID は params に載せること');
      }
      expect(href.pathname.startsWith('/(admin)/')).toBe(true);
    }
  });
});
```

`typeof href === 'string'` で弾いているのは、`Href` が `string | HrefObject` の合併だから（E-6）。ここで `as HrefObject` とキャストしてしまうと、実装がうっかり文字列を返すようになったときにテストが素通りする。**キャストではなく分岐にして、文字列が来たら落ちるようにする。**

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/routes`
Expected: FAIL、`Cannot find module './routes' from 'src/features/admin/routes.test.ts'`

- [ ] **Step 3: ルート定義を実装する**

`apps/mobile/src/features/admin/routes.ts`

```ts
import type { Href } from 'expo-router';

/**
 * 管理画面のルート。**パス文字列を書いてよいのはこのファイルだけ。**
 *
 * `app.json` の `experiments.typedRoutes` が true なので、pathname は
 * `.expo/types/router.d.ts` に生成されたリテラル合併型と照合される……のだが、
 * `.expo/` は gitignore されていて CI には存在しない。その環境では
 * `Href` は `string | HrefObject` に退化し、存在しないパスも型検査を通る
 * （expo-router 57.0.21 の build/typed-routes/types.d.ts で実測）。
 *
 * だから `satisfies` は「手元で綴りを間違えたら気づける」程度の保険でしかない。
 * パスと実ファイルの対応は routes.test.ts の実ファイル検査で担保する。
 */
export const ADMIN_ROUTES = {
  overview: '/(admin)/(tabs)/overview',
  approvals: '/(admin)/(tabs)/approvals',
  reports: '/(admin)/(tabs)/reports',
  users: '/(admin)/(tabs)/users',
  more: '/(admin)/(tabs)/more',
  genres: '/(admin)/masters/genres',
  areas: '/(admin)/masters/areas',
  announcements: '/(admin)/announcements',
  auditLog: '/(admin)/audit-log',
} as const satisfies Record<string, Href>;

/**
 * ID を受け取るルート。
 *
 * `/(admin)/users/${userId}` のようにテンプレートリテラルで組まない。
 * ID に `/` や `?` が混ざったときにパスとして解釈されてしまう。
 * `params` に載せれば expo-router 側が符号化する。
 */
export const ADMIN_DETAIL_ROUTES = {
  application: (applicationId: string): Href => ({
    pathname: '/(admin)/approvals/[applicationId]',
    params: { applicationId },
  }),
  report: (reportId: string): Href => ({
    pathname: '/(admin)/reports/[reportId]',
    params: { reportId },
  }),
  user: (userId: string): Href => ({
    pathname: '/(admin)/users/[userId]',
    params: { userId },
  }),
  shop: (shopId: string): Href => ({
    pathname: '/(admin)/shops/[shopId]',
    params: { shopId },
  }),
} as const;
```

- [ ] **Step 4: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/routes && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**10 件**。`describe('ADMIN_ROUTES')` が 5 本、`describe('ADMIN_DETAIL_ROUTES')` が 5 本）

わざと壊す。

1. `ADMIN_DETAIL_ROUTES.user` を、パスに ID を埋め込む形に変える。

```ts
  user: (userId: string): Href => `/(admin)/users/${userId}`,
```

→ 「ID をパス文字列に埋め込まない」と「pathname のプレースホルダと params のキーが一致する」の 2 つが落ちる。**`typeof href === 'string'` の分岐が `throw` するので、キャストで書いていたら気づけなかった壊し方。** 2. 戻してから `ADMIN_ROUTES.auditLog` を `'/(admin)/(tabs)/audit-log'` にする → 「タブ以外の 4 本は (tabs) グループの外を指す」が落ちる。3. 戻してから `ADMIN_ROUTES.more` を `ADMIN_ROUTES.users` と同じ `'/(admin)/(tabs)/users'` にする → 「同じパスを 2 つのキーに割り当てていない」が落ちる。4. 戻してから `ADMIN_ROUTES.genres` を `'/masters/genres'`（`(admin)` 抜け）にする → 「すべて (admin) グループの絶対パスになっている」が落ちる。**この壊し方は `tsc` では捕まらない**（E-8）ことも同時に確認する: `npm run typecheck -w @meshimap/mobile` は PASS のままになる。

4 つとも確認したら戻す。

- [ ] **Step 5: 日時と差分の整形の失敗するテストを書く**

`apps/mobile/src/features/admin/format.test.ts`

```ts
import { EMPTY_VALUE_LABEL, formatDateTime, formatDiffValue } from './format';

describe('formatDateTime', () => {
  // Date をローカル時刻の組で作る。epoch 定数で書くと機械の TZ で結果が変わる
  it('yyyy/MM/dd HH:mm の並びで出す', () => {
    expect(formatDateTime(new Date(2026, 8, 16, 9, 5).getTime())).toBe('2026/09/16 09:05');
  });

  it('月・日・時・分を 2 桁に 0 詰めする', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026/01/02 03:04');
  });

  it('24 時間表記にする（午後 1 時が 13 になる）', () => {
    expect(formatDateTime(new Date(2026, 8, 16, 13, 0).getTime())).toBe('2026/09/16 13:00');
  });

  it('秒は出さない（一覧が横に伸びるだけで、運用の判断には使わない）', () => {
    expect(formatDateTime(new Date(2026, 8, 16, 13, 0, 59).getTime())).toBe('2026/09/16 13:00');
  });
});

describe('formatDiffValue', () => {
  it('文字列はそのまま返す', () => {
    expect(formatDiffValue('published')).toBe('published');
  });

  it('null は「なし」と出す', () => {
    expect(formatDiffValue(null)).toBe(EMPTY_VALUE_LABEL);
  });

  it('undefined は「なし」と出す', () => {
    // 差分の before 側は「その項目が無かった」場合に undefined で来る
    expect(formatDiffValue(undefined)).toBe(EMPTY_VALUE_LABEL);
  });

  it('空文字は「なし」と出す', () => {
    // 空文字をそのまま出すと、行が空白になって「消えた」のか「元から無い」のか読めない
    expect(formatDiffValue('')).toBe(EMPTY_VALUE_LABEL);
  });

  it('0 を「なし」にしない', () => {
    // if (!value) と書いた実装はここで落ちる。0 は「値がある」
    expect(formatDiffValue(0)).toBe('0');
  });

  it('false を「なし」にしない', () => {
    expect(formatDiffValue(false)).toBe('false');
  });

  it('数値を 10 進の文字列にする', () => {
    expect(formatDiffValue(1500)).toBe('1500');
  });

  it('配列を JSON 表記にする', () => {
    expect(formatDiffValue(['izakaya', 'ramen'])).toBe('["izakaya","ramen"]');
  });

  it('入れ子のオブジェクトを JSON 表記にする', () => {
    expect(formatDiffValue({ lat: 35.6, lng: 139.7 })).toBe('{"lat":35.6,"lng":139.7}');
  });
});
```

- [ ] **Step 6: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/format`
Expected: FAIL、`Cannot find module './format' from 'src/features/admin/format.test.ts'`

- [ ] **Step 7: 整形を実装する**

`apps/mobile/src/features/admin/format.ts`

```ts
import { format } from 'date-fns';

/**
 * 一覧・詳細で使う日時の並び。
 *
 * `toLocaleString` を使わない理由: 端末のロケール設定で書式が変わり、
 * 同じ操作ログが `2026/9/16 9:05` にも `9/16/2026, 9:05 AM` にもなる。
 * 監査ログは「いつ何が起きたか」を他の記録と突き合わせる画面なので、
 * 端末に関係なく同じ並びで出す。
 *
 * タイムゾーンは端末のものを使う（運用者は自分の時計と突き合わせるので、
 * UTC 固定にすると 9 時間ずれた時刻を毎回暗算することになる）。
 */
const DATE_TIME_FORMAT = 'yyyy/MM/dd HH:mm';

/** epoch ミリ秒を「2026/09/16 09:05」の形にする */
export function formatDateTime(epochMs: number): string {
  return format(new Date(epochMs), DATE_TIME_FORMAT);
}

/** 値が空のときの表示。空文字のままだと行が空白になり、読み手が判断できない */
export const EMPTY_VALUE_LABEL = '（なし）';

/**
 * 監査ログの差分 1 項目を読める文字にする。
 *
 * API は差分を JSON で返すので、来る型は事前に決められない（`unknown`）。
 * 文字列はそのまま、それ以外は JSON 表記にする。
 * `0` や `false` は「値がある」ので「なし」にしないこと。
 */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) {
    return EMPTY_VALUE_LABEL;
  }
  if (typeof value === 'string') {
    return value === '' ? EMPTY_VALUE_LABEL : value;
  }
  return JSON.stringify(value);
}
```

- [ ] **Step 8: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/format`
Expected: PASS（13 件）

わざと壊す。

1. `DATE_TIME_FORMAT` を `'yyyy/M/d H:mm'` にする → 「月・日・時・分を 2 桁に 0 詰めする」が落ちる。
2. 戻してから `'yyyy/MM/dd hh:mm'`（小文字の h）にする → 「24 時間表記にする」が落ちる（`13:00` が `01:00` になる）。
3. 戻してから `formatDiffValue` の先頭を `if (!value) { return EMPTY_VALUE_LABEL; }` にまとめる → 「0 を「なし」にしない」と「false を「なし」にしない」の 2 つが落ちる。
4. 戻してから `typeof value === 'string'` の分岐を消す → 「文字列はそのまま返す」が落ちる（`"published"` と引用符付きになる）。

4 つとも確認したら戻す。

- [ ] **Step 9: 絞り込み選択肢の失敗するテストを書く**

`apps/mobile/src/features/admin/components/filter-options.test.ts`

```ts
import { APPLICATION_STATUS_LABELS, REPORT_STATUS_LABELS } from '../labels';
import { APPLICATION_STATUSES, REPORT_STATUSES } from '../types';
import {
  ALL_FILTER_LABEL,
  ALL_FILTER_VALUE,
  toFilterOptions,
  toFilterValue,
} from './filter-options';

describe('toFilterOptions', () => {
  it('先頭に「すべて」を置く', () => {
    expect(toFilterOptions(APPLICATION_STATUSES, APPLICATION_STATUS_LABELS)[0]).toEqual({
      value: ALL_FILTER_VALUE,
      label: ALL_FILTER_LABEL,
    });
  });

  it('「すべて」の後ろに語彙を宣言順で並べる', () => {
    expect(toFilterOptions(APPLICATION_STATUSES, APPLICATION_STATUS_LABELS)).toEqual([
      { value: 'all', label: 'すべて' },
      { value: 'pending', label: '審査待ち' },
      { value: 'approved', label: '承認済み' },
      { value: 'rejected', label: '却下' },
      { value: 'returned', label: '差し戻し' },
    ]);
  });

  it('語彙の数 + 1 個になる', () => {
    expect(toFilterOptions(REPORT_STATUSES, REPORT_STATUS_LABELS)).toHaveLength(
      REPORT_STATUSES.length + 1,
    );
  });

  it('渡した語彙の一部だけでも組める', () => {
    // 通報一覧の「未対応 / 確認中」だけを出したい場面で使う
    expect(toFilterOptions(['open', 'in_review'], REPORT_STATUS_LABELS)).toEqual([
      { value: 'all', label: 'すべて' },
      { value: 'open', label: '未対応' },
      { value: 'in_review', label: '確認中' },
    ]);
  });
});

describe('toFilterValue', () => {
  it('語彙の値はそのまま返す', () => {
    expect(toFilterValue('pending', APPLICATION_STATUSES)).toBe('pending');
  });

  it('「すべて」は null になる', () => {
    // API のクエリに status=all を載せないための変換。載せると 422 になる
    expect(toFilterValue(ALL_FILTER_VALUE, APPLICATION_STATUSES)).toBeNull();
  });

  it('語彙に無い値も null になる', () => {
    // 画面の状態が壊れていても、知らない値をサーバへ送らない
    expect(toFilterValue('pending', REPORT_STATUSES)).toBeNull();
  });

  it('空文字も null になる', () => {
    expect(toFilterValue('', APPLICATION_STATUSES)).toBeNull();
  });

  it('語彙の全値を素通しする', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(toFilterValue(status, APPLICATION_STATUSES)).toBe(status);
    }
  });
});
```

`toFilterValue('pending', REPORT_STATUSES)` が書けるのは、第 1 引数を `string` にしたから。`WithAll<ReportStatus>` に絞っていたらこのテストはコンパイルできず、**「語彙に無い値は null」という一番大事な振る舞いを検査できなくなる**。

- [ ] **Step 10: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/filter-options`
Expected: FAIL、`Cannot find module './filter-options'`

- [ ] **Step 11: 絞り込み選択肢を実装する**

`apps/mobile/src/features/admin/components/filter-options.ts`

```ts
import type { SelectOption } from '@/components/ui/select-field';

import { toSelectOptions } from '../labels';

/**
 * 「すべて」を表す値。
 *
 * **サーバの語彙に混ぜないこと。**`ApplicationStatus` に `'all'` を足すと、
 * 型の上では API のクエリにも `'all'` を載せられるようになり、
 * 実機で 422 を見るまで誰も気づかない。画面の状態としてだけ持ち、
 * API へ渡す直前に toFilterValue で null に落とす。
 */
export const ALL_FILTER_VALUE = 'all';

/** 「すべて」の表示名 */
export const ALL_FILTER_LABEL = 'すべて';

/** 語彙に「すべて」を足した、画面の絞り込み状態の型 */
export type WithAll<TValue extends string> = TValue | typeof ALL_FILTER_VALUE;

/**
 * 先頭に「すべて」を置いた選択肢を作る。
 *
 * 戻り値は SelectField にも SegmentedControl にも渡せる（どちらも `{ value, label }`）。
 */
export function toFilterOptions<TValue extends string>(
  values: readonly TValue[],
  labels: Record<TValue, string>,
): SelectOption<WithAll<TValue>>[] {
  return [{ value: ALL_FILTER_VALUE, label: ALL_FILTER_LABEL }, ...toSelectOptions(values, labels)];
}

/**
 * 画面の絞り込み状態を、API へ渡す値に落とす。
 *
 * 第 1 引数が `WithAll<TValue>` ではなく `string` なのは意図的。
 * 語彙に無い値が来る経路（将来 useLocalSearchParams から受ける場合など）を
 * 型で閉じてしまうと、「知らない値は null」という振る舞いをテストで書けなくなる。
 *
 * `filter as TValue` とキャストしないこと。キャストすると 'all' が
 * そのままサーバへ飛んでも型検査は通る。find で引いているから安全になっている。
 */
export function toFilterValue<TValue extends string>(
  filter: string,
  values: readonly TValue[],
): TValue | null {
  return values.find((value) => value === filter) ?? null;
}
```

- [ ] **Step 12: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/components/filter-options && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（9 件）

わざと壊す。

1. `toFilterOptions` の先頭要素を末尾に移す → 「先頭に「すべて」を置く」と「「すべて」の後ろに語彙を宣言順で並べる」が落ちる。
2. 戻してから `toFilterValue` の本体を `return filter as TValue;` にする → 「「すべて」は null になる」「語彙に無い値も null になる」「空文字も null になる」の 3 つが落ちる。**`tsc` は通ってしまう**ことも確認する（キャストが型検査を黙らせている実例）。
3. 戻してから `values.find((value) => value === filter) ?? null` の `?? null` を消す → 戻り値が `undefined` になり、`toBeNull()` の 3 つが落ちる。**`tsc` も戻り値型の不一致で落ちる**ことを確認する。

3 つとも確認したら戻す。

- [ ] **Step 13: 状態バッジの失敗するテストを書く**

`apps/mobile/src/features/admin/components/status-badge.test.tsx`

```tsx
import { ROLES } from '@meshimap/core';
import { render, screen } from '@testing-library/react-native';

import { APPLICATION_STATUSES, PROFILE_STATUSES, REPORT_STATUSES, SHOP_STATUSES } from '../types';
import {
  ApplicationStatusBadge,
  ProfileStatusBadge,
  ReportStatusBadge,
  RoleBadge,
  ShopStatusBadge,
} from './status-badge';

const TEST_ID = 'status';

/** Badge の tone が実際に当てる背景クラス。badge.tsx の CONTAINER_STYLES と対応する */
const TONE_CLASSES = {
  neutral: 'bg-neutral-100',
  success: 'bg-green-50',
  warning: 'bg-amber-50',
  danger: 'bg-red-50',
  brand: 'bg-primary-50',
} as const;

describe('ApplicationStatusBadge', () => {
  it('審査待ちを日本語で出す', async () => {
    await render(<ApplicationStatusBadge status="pending" testID={TEST_ID} />);

    expect(screen.getByText('審査待ち')).toBeTruthy();
  });

  it.each([
    ['pending', TONE_CLASSES.warning],
    ['approved', TONE_CLASSES.success],
    ['rejected', TONE_CLASSES.danger],
    ['returned', TONE_CLASSES.brand],
  ] as const)('%s を %s で塗る', async (status, containerClass) => {
    await render(<ApplicationStatusBadge status={status} testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID).props.className).toContain(containerClass);
  });

  it('語彙の全値を描画できる', async () => {
    for (const status of APPLICATION_STATUSES) {
      const view = await render(<ApplicationStatusBadge status={status} testID={TEST_ID} />);

      expect(screen.getByTestId(TEST_ID)).toBeTruthy();
      view.unmount();
    }
  });
});

describe('ReportStatusBadge', () => {
  it('未対応を日本語で出す', async () => {
    await render(<ReportStatusBadge status="open" testID={TEST_ID} />);

    expect(screen.getByText('未対応')).toBeTruthy();
  });

  it.each([
    ['open', TONE_CLASSES.warning],
    ['in_review', TONE_CLASSES.brand],
    ['resolved', TONE_CLASSES.success],
    // 通報の却下は「通報が妥当でなかった」で、対象には何も起きていない。
    // 申請の却下（danger）とは意味が違うので色も変える
    ['rejected', TONE_CLASSES.neutral],
  ] as const)('%s を %s で塗る', async (status, containerClass) => {
    await render(<ReportStatusBadge status={status} testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID).props.className).toContain(containerClass);
  });

  it('語彙の全値を描画できる', async () => {
    for (const status of REPORT_STATUSES) {
      const view = await render(<ReportStatusBadge status={status} testID={TEST_ID} />);

      expect(screen.getByTestId(TEST_ID)).toBeTruthy();
      view.unmount();
    }
  });
});

describe('ProfileStatusBadge', () => {
  it('停止中を日本語で出す', async () => {
    await render(<ProfileStatusBadge status="suspended" testID={TEST_ID} />);

    expect(screen.getByText('停止中')).toBeTruthy();
  });

  it.each([
    ['active', TONE_CLASSES.success],
    ['suspended', TONE_CLASSES.danger],
    ['deleted', TONE_CLASSES.neutral],
  ] as const)('%s を %s で塗る', async (status, containerClass) => {
    await render(<ProfileStatusBadge status={status} testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID).props.className).toContain(containerClass);
  });

  it('語彙の全値を描画できる', async () => {
    for (const status of PROFILE_STATUSES) {
      const view = await render(<ProfileStatusBadge status={status} testID={TEST_ID} />);

      expect(screen.getByTestId(TEST_ID)).toBeTruthy();
      view.unmount();
    }
  });
});

describe('ShopStatusBadge', () => {
  it('公開中を日本語で出す', async () => {
    await render(<ShopStatusBadge status="published" testID={TEST_ID} />);

    expect(screen.getByText('公開中')).toBeTruthy();
  });

  it.each([
    ['draft', TONE_CLASSES.neutral],
    ['pending', TONE_CLASSES.warning],
    ['published', TONE_CLASSES.success],
    ['suspended', TONE_CLASSES.danger],
    ['closed', TONE_CLASSES.neutral],
  ] as const)('%s を %s で塗る', async (status, containerClass) => {
    await render(<ShopStatusBadge status={status} testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID).props.className).toContain(containerClass);
  });

  it('語彙の全値を描画できる', async () => {
    for (const status of SHOP_STATUSES) {
      const view = await render(<ShopStatusBadge status={status} testID={TEST_ID} />);

      expect(screen.getByTestId(TEST_ID)).toBeTruthy();
      view.unmount();
    }
  });
});

describe('RoleBadge', () => {
  it('システム管理者を日本語で出す', async () => {
    await render(<RoleBadge status="admin" testID={TEST_ID} />);

    expect(screen.getByText('システム管理者')).toBeTruthy();
  });

  it.each([
    ['user', TONE_CLASSES.neutral],
    ['owner', TONE_CLASSES.brand],
    // admin は権限が強い。一覧で見落とさないよう danger を当てる（異常の意味ではない）
    ['admin', TONE_CLASSES.danger],
  ] as const)('%s を %s で塗る', async (role, containerClass) => {
    await render(<RoleBadge status={role} testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID).props.className).toContain(containerClass);
  });

  it('語彙の全値を描画できる', async () => {
    for (const role of ROLES) {
      const view = await render(<RoleBadge status={role} testID={TEST_ID} />);

      expect(screen.getByTestId(TEST_ID)).toBeTruthy();
      view.unmount();
    }
  });
});
```

`TONE_CLASSES` を作り直しているのは、`badge.tsx` の `CONTAINER_STYLES` が非公開だから。**ここで手で書き写した値がずれると、テストは「存在しないクラス名」を探して落ちる**ので、写し間違いは黙って通り抜けない。

`view.unmount()` を挟んでいるのは、同じ `testID` で繰り返し描画すると `getByTestId` が「複数見つかった」で落ちるため。

- [ ] **Step 14: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/status-badge`
Expected: FAIL、`Cannot find module './status-badge'`

- [ ] **Step 15: 状態バッジを実装する**

`apps/mobile/src/features/admin/components/status-badge.tsx`

```tsx
import type { Role } from '@meshimap/core';

import { Badge, type BadgeTone } from '@/components/ui/badge';

import {
  APPLICATION_STATUS_LABELS,
  PROFILE_STATUS_LABELS,
  REPORT_STATUS_LABELS,
  ROLE_LABELS,
  SHOP_STATUS_LABELS,
} from '../labels';
import type { ApplicationStatus, ProfileStatus, ReportStatus, ShopStatus } from '../types';

/**
 * 色の意味を 5 つに固定する。画面ごとに解釈がぶれると一覧を流し読みできなくなる。
 *
 * - warning: 運営の手が要る（審査待ち・未対応・審査中）
 * - brand:   運営が手を付けた途中の状態（差し戻し・確認中）
 * - success: 正常に片付いた状態（承認済み・対応済み・利用中・公開中）
 * - danger:  こちらが止めた・退けた状態（申請の却下・停止中）
 * - neutral: 上のどれでもない（下書き・退会済み・閉店・通報の却下）
 *
 * 表を Record<語彙, BadgeTone> にしてあるのが肝で、types.ts の語彙に値を足すと
 * ここでコンパイルが止まる。色の付け忘れが「見た目が地味なだけ」で通り抜けない。
 */
const APPLICATION_STATUS_TONES: Record<ApplicationStatus, BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  returned: 'brand',
};

const REPORT_STATUS_TONES: Record<ReportStatus, BadgeTone> = {
  open: 'warning',
  in_review: 'brand',
  resolved: 'success',
  // 通報の却下は「通報が妥当でなかった」。対象には何も起きていないので danger にしない
  rejected: 'neutral',
};

const PROFILE_STATUS_TONES: Record<ProfileStatus, BadgeTone> = {
  active: 'success',
  suspended: 'danger',
  deleted: 'neutral',
};

const SHOP_STATUS_TONES: Record<ShopStatus, BadgeTone> = {
  draft: 'neutral',
  pending: 'warning',
  published: 'success',
  suspended: 'danger',
  closed: 'neutral',
};

/** admin の danger は「異常」ではなく「権限が強いので一覧で見落とすな」の意味 */
const ROLE_TONES: Record<Role, BadgeTone> = {
  user: 'neutral',
  owner: 'brand',
  admin: 'danger',
};

export interface StatusBadgeProps<TStatus extends string> {
  status: TStatus;
  testID?: string | undefined;
}

/**
 * 語彙 → バッジ部品を作る。
 *
 * 5 種類とも「ラベル表と色表を引いて Badge を描く」だけで、違うのは表だけ。
 * 5 回書き写すと Badge の props が変わったときに 5 箇所直すことになる。
 */
function createStatusBadge<TStatus extends string>(
  labels: Record<TStatus, string>,
  tones: Record<TStatus, BadgeTone>,
) {
  return function StatusBadge({ status, testID }: StatusBadgeProps<TStatus>) {
    return <Badge label={labels[status]} testID={testID} tone={tones[status]} />;
  };
}

export const ApplicationStatusBadge = createStatusBadge(
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
);
export const ReportStatusBadge = createStatusBadge(REPORT_STATUS_LABELS, REPORT_STATUS_TONES);
export const ProfileStatusBadge = createStatusBadge(PROFILE_STATUS_LABELS, PROFILE_STATUS_TONES);
export const ShopStatusBadge = createStatusBadge(SHOP_STATUS_LABELS, SHOP_STATUS_TONES);
export const RoleBadge = createStatusBadge(ROLE_LABELS, ROLE_TONES);
```

`RoleBadge` の props 名が `role` ではなく `status` なのは、factory を 1 つにしているため。呼び出し側は `<RoleBadge status={profile.role} />` と書く。**props 名を揃えることと引き換えに、5 つの部品の実装が 1 箇所に収まっている。**

- [ ] **Step 16: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/components/status-badge && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**29 件**）。`it.each` が展開されるので `it` の行数（15 行）とは一致しない。内訳は 5 つの `describe` それぞれが「日本語で出す」1 件 + 「語彙の全値を描画できる」1 件 = 単発 10 件、これに `it.each` の行数 `ApplicationStatusBadge` 4 + `ReportStatusBadge` 4 + `ProfileStatusBadge` 3 + `ShopStatusBadge` 5 + `RoleBadge` 3 = 19 件を足して 29 件。

わざと壊す。

1. `APPLICATION_STATUS_TONES.rejected` を `'neutral'` にする → 「rejected を bg-red-50 で塗る」が落ちる。
2. 戻してから `REPORT_STATUS_TONES.rejected` を `'danger'` にする → 「rejected を bg-neutral-100 で塗る」が落ちる。**申請と通報で却下の意味が違うという判断が、テストで固定されていることの確認。**
3. 戻してから `createStatusBadge` の `tone={tones[status]}` を消す → `Badge` の既定の `neutral` になるので（`apps/mobile/src/components/ui/badge.tsx` の `tone = 'neutral'`）、warning / success / danger / brand を期待している **14 件**が落ちる。内訳は 申請 4（pending / approved / rejected / returned）+ 通報 3（open / in_review / resolved）+ プロフィール 2（active / suspended）+ 店舗 3（pending / published / suspended）+ ロール 2（owner / admin）。`neutral` を期待している 5 件（通報の rejected / プロフィールの deleted / 店舗の draft と closed / ロールの user）は既定と一致するので落ちない。
4. 戻してから `label={labels[status]}` を `label={status}` にする → 「〜を日本語で出す」の 5 件が落ちる。

4 つとも確認したら戻す。

- [ ] **Step 17: 語彙を増やして、表の埋め忘れでコンパイルが止まることを確認する**

`apps/mobile/src/features/admin/types.ts` の `SHOP_STATUSES` に `'archived'` を足す。

Run: `npm run typecheck -w @meshimap/mobile`
Expected: FAIL。少なくとも次の 2 つが出る。

- `labels.ts` の `SHOP_STATUS_LABELS` が `Record<ShopStatus, string>` を満たさない（`archived` が無い）
- `status-badge.tsx` の `SHOP_STATUS_TONES` が `Record<ShopStatus, BadgeTone>` を満たさない

Run: `npm test -w @meshimap/mobile -- features/admin/constants-parity`
Expected: FAIL（`SHOP_STATUSES` が `apps/api/src/db/constants.ts` と一致しない）

**3 つとも落ちることを確認してから戻す。**語彙を増やす作業が「ラベルと色を埋めるまでコンパイルが通らない」形になっていることが、この Task の成果物。

- [ ] **Step 18: モバイル全体のテストとカバレッジを確認する**

Run:

```bash
npm run test:coverage -w @meshimap/mobile
```

Expected: PASS。`features/admin/routes.ts` / `format.ts` / `components/filter-options.ts` / `components/status-badge.tsx` が statements・branches・functions・lines の 4 指標すべて 100%。

`coverageThreshold.global` が 4 指標とも 100 なので、1 行でも通っていなければここで落ちる。落ちたら**テストを足す**。`collectCoverageFrom` から外すのは選択肢にない。

- [ ] **Step 19: lint と format を通す**

Run:

```bash
npm run lint
npm run format:check
```

Expected: 両方 PASS

`format:check` が落ちたら `npm run format` を実行してから差分を確認する。`status-badge.tsx` は `prettier-plugin-tailwindcss` がクラス名の並び替えを行う対象なので、手で書いた順と変わることがある。

- [ ] **Step 20: コミットする**

```bash
git add apps/mobile/src/features/admin/routes.ts \
        apps/mobile/src/features/admin/routes.test.ts \
        apps/mobile/src/features/admin/format.ts \
        apps/mobile/src/features/admin/format.test.ts \
        apps/mobile/src/features/admin/components/filter-options.ts \
        apps/mobile/src/features/admin/components/filter-options.test.ts \
        apps/mobile/src/features/admin/components/status-badge.tsx \
        apps/mobile/src/features/admin/components/status-badge.test.tsx
git commit -m "feat(mobile): 管理画面のルート定義・日時整形・絞り込み・状態バッジを追加"
```

---

### Task 9-22: タブ 5 画面（概況 / 審査 / 通報 / ユーザー / その他）

Task 9-20 の骨と Task 9-21 の部品を組んで、管理タブの中身を作る。**タブのシェル（`src/app/(admin)/(tabs)/_layout.tsx`）は Phase 5 の成果物なので触らない。**この Task で作るのは 5 つの画面本体と、それを指す薄いルートファイル 5 本。

**この Task の設計判断は 5 つ。**

**(1) 画面本体は `src/features/admin/screens/` に置き、`src/app/(admin)/(tabs)/*.tsx` は 1 行の再輸出にする。**`apps/mobile/jest.config.js` の `collectCoverageFrom` が `'!src/app/**'` で除外しているので、`src/app/` に中身を書くとカバレッジの網から外れる（実ファイルで確認）。ルートファイルは次の 1 行だけにする。

```tsx
export { ApprovalsScreen as default } from '@/features/admin/screens/approvals-screen';
```

**(2) 絞り込みの部品は選択肢の数で決める。**`SegmentedControl` の doc コメントに「選択肢が 5 つを超えるなら SelectField を使う」と書いたが、日本語ラベルでは 5 つでも横幅が足りない。`tailwind.config.js` の `fontSize.sm` は **13px**（実ファイルで確認）。4 文字のラベルは約 52px、左右の `px-sm` が 8px ずつで 1 区画 68px。5 区画だと 340px、区画の隙間 `gap-xs`（4px）が 4 つで 16px、合わせて 356px。iPhone の 375pt 幅から左右の余白 32pt を引いた 343pt に収まらない。

**未計測:** 上は Tailwind の設定値と日本語の全角幅から出した机上の見積りで、実機やシミュレータでは測っていない。そこで **4 択までは `SegmentedControl`、5 択以上は `SelectField`** と決める。

| 画面      | 絞り込み     | 選択肢の数     | 使う部品                                                                       |
| --------- | ------------ | -------------- | ------------------------------------------------------------------------------ |
| approvals | 申請の状態   | すべて + 4 = 5 | `SelectField`                                                                  |
| reports   | 通報の対象   | すべて + 3 = 4 | `SegmentedControl`                                                             |
| reports   | 通報の状態   | すべて + 4 = 5 | `SelectField`                                                                  |
| users     | ロール       | すべて + 3 = 4 | `SelectField`（「システム管理者」が 7 文字で `SegmentedControl` に収まらない） |
| users     | 利用者の状態 | すべて + 3 = 4 | `SegmentedControl`（「利用中」「停止中」「退会済み」は 3〜4 文字）             |

**(3) ユーザー検索は debounce ではなく「検索」ボタンにする。**入力のたびに投げると `useState` の更新ごとにクエリキーが変わり、1 文字打つたびに D1 の LIKE 検索が走る。debounce を入れるとタイマーが要り、`jest.useFakeTimers()` と RNTL の非同期 `act` が絡んで壊れやすいテストになる。**ボタンなら押した回数だけ投げるので、テストも実装も決定的になる。**入力中の文字列と、検索に使う確定した文字列を別々の state で持つ。

**(4) 絞り込み条件のオブジェクトは毎回作り直してよい。**`useApplications({ status })` は描画のたびに新しいオブジェクトを作るが、TanStack Query のキー比較は参照ではなくハッシュで行う。`hashKey` は `JSON.stringify` にオブジェクトのキーを並べ替える replacer を噛ませたもの（`node_modules/@tanstack/query-core/build/modern/utils.js:56-61` で実測）。中身が同じなら同じハッシュになるので、`useMemo` で包む必要はない。

**(5) 行の本文は JSX で継ぎ足さず、1 本の文字列にしてから描画する。**`<Text>申請者 {name}・書類 {count} 件</Text>` と書くと `Text` の子が 5 つに分かれ、`getByText('申請者 田中 太郎・書類 2 件')` で引けなくなる（関数マッチャが要る）。**テンプレートリテラルで組んでから 1 つの子として渡す。**

**Files:**

- Create: `apps/mobile/src/features/admin/screens/overview-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/overview-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/approvals-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/approvals-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/reports-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/reports-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/users-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/users-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/more-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/more-screen.test.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/overview.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/approvals.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/reports.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/users.tsx`
- Create: `apps/mobile/src/app/(admin)/(tabs)/more.tsx`

**Interfaces:**

- Consumes:
  - `AdminListScreen` / `AdminDetailScreen` / `StatCard`（Task 9-20）
  - `ADMIN_ROUTES` / `ADMIN_DETAIL_ROUTES` / `formatDateTime` / `toFilterOptions` / `toFilterValue` / `WithAll` / 5 つの状態バッジ（Task 9-21）
  - `useOverview` / `useApplications` / `useReports` / `useUsers`（Task 9-19）
  - `fetchApplications` / `fetchReports` / `fetchUsers` / `fetchOverview`（テストでのモック対象、Task 9-19）
  - `SelectField` / `SegmentedControl` / `Card` / `Input` / `Button` / `Icon`（Task 9-18 と既存プリミティブ）
  - `renderWithQuery`（Task 9-20）
- Produces: `OverviewScreen` / `ApprovalsScreen` / `ReportsScreen` / `UsersScreen` / `MoreScreen`（いずれも props なし）。`src/app/(admin)/(tabs)/` の 5 本がこれらを default として再輸出する

- [ ] **Step 1: 概況画面の失敗するテストを書く**

`apps/mobile/src/features/admin/screens/overview-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchOverview } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminOverview } from '../types';
import { OverviewScreen } from './overview-screen';

const mockPush = jest.fn();

// jest-setup.ts に expo-router のモックは無いので、画面ごとにここで差し替える。
// 変数名を mock で始めているのは、jest.mock の factory がホイストされるため
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../api');

const fetchOverviewMock = jest.mocked(fetchOverview);

const OVERVIEW: AdminOverview = {
  windowDays: 7,
  newShopCount: 3,
  newReviewCount: 12,
  newUserCount: 8,
  pendingApplicationCount: 2,
  openReportCount: 0,
};

beforeEach(() => {
  mockPush.mockClear();
  fetchOverviewMock.mockReset();
  fetchOverviewMock.mockResolvedValue(OVERVIEW);
});

describe('OverviewScreen', () => {
  it('集計期間と 5 つの指標を出す', async () => {
    await renderWithQuery(<OverviewScreen />);

    expect(await screen.findByText('直近 7 日間')).toBeTruthy();
    expect(screen.getByTestId('admin-overview-pending-applications-value')).toHaveTextContent('2');
    expect(screen.getByTestId('admin-overview-open-reports-value')).toHaveTextContent('0');
    expect(screen.getByTestId('admin-overview-new-shops-value')).toHaveTextContent('3');
    expect(screen.getByTestId('admin-overview-new-reviews-value')).toHaveTextContent('12');
    expect(screen.getByTestId('admin-overview-new-users-value')).toHaveTextContent('8');
  });

  it('残っている仕事は赤く、片付いている仕事は赤くしない', async () => {
    await renderWithQuery(<OverviewScreen />);

    // 審査待ち 2 件は残っている仕事
    expect(
      (await screen.findByTestId('admin-overview-pending-applications-value')).props.className,
    ).toContain('text-red-700');
    // 未対応の通報 0 件は片付いている。常に赤いと赤が合図として働かなくなる
    expect(screen.getByTestId('admin-overview-open-reports-value').props.className).toContain(
      'text-neutral-900',
    );
  });

  it('審査待ちのカードを押すと審査タブへ移動する', async () => {
    await renderWithQuery(<OverviewScreen />);
    await fireEvent.press(await screen.findByTestId('admin-overview-pending-applications'));

    expect(mockPush).toHaveBeenCalledWith('/(admin)/(tabs)/approvals');
  });

  it('未対応の通報のカードを押すと通報タブへ移動する', async () => {
    await renderWithQuery(<OverviewScreen />);
    await fireEvent.press(await screen.findByTestId('admin-overview-open-reports'));

    expect(mockPush).toHaveBeenCalledWith('/(admin)/(tabs)/reports');
  });

  it('新しい利用者のカードを押すとユーザータブへ移動する', async () => {
    await renderWithQuery(<OverviewScreen />);
    await fireEvent.press(await screen.findByTestId('admin-overview-new-users'));

    expect(mockPush).toHaveBeenCalledWith('/(admin)/(tabs)/users');
  });

  it('行き先の無い指標は押せない', async () => {
    await renderWithQuery(<OverviewScreen />);
    // Card は onPress が無いと Pressable ではなく View になる（accessibilityRole が付かない）
    const card = await screen.findByTestId('admin-overview-new-shops');

    expect(card.props.accessibilityRole).toBeUndefined();
  });

  it('取得に失敗したら再試行できるエラーを出す', async () => {
    fetchOverviewMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<OverviewScreen />);

    expect(await screen.findByTestId('admin-overview-error')).toBeTruthy();
    expect(screen.getByTestId('admin-overview-error-retry-button')).toBeTruthy();
  });

  it('読み込み中は骨組みを出す', async () => {
    fetchOverviewMock.mockReturnValue(new Promise(() => undefined));
    await renderWithQuery(<OverviewScreen />);

    expect(screen.getByTestId('admin-overview-loading')).toBeTruthy();
  });
});
```

`fetchOverviewMock.mockReturnValue(new Promise(() => undefined))` は「いつまでも解決しない Promise」。読み込み中の見た目を固定するための書き方で、タイマーを使わない。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/overview-screen`
Expected: FAIL、`Cannot find module './overview-screen'`

- [ ] **Step 3: 概況画面を実装する**

`apps/mobile/src/features/admin/screens/overview-screen.tsx`

```tsx
import { useRouter } from 'expo-router';
import { ClipboardList, Flag, MessageSquare, Store, Users } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { AdminDetailScreen } from '../components/admin-detail-screen';
import { StatCard } from '../components/stat-card';
import { useOverview } from '../queries';
import { ADMIN_ROUTES } from '../routes';

const TEST_ID = 'admin-overview';

/**
 * 管理者が最初に見る画面。
 *
 * 「残っている仕事」を上に、「増えた実体」を下に置く。
 * 上の 2 つだけが isAlert で、0 件でなければ赤く出る。
 */
export function OverviewScreen() {
  const router = useRouter();
  const query = useOverview();

  return (
    <AdminDetailScreen
      query={query}
      title="概況"
      errorTitle="概況を取得できませんでした"
      testID={TEST_ID}
      renderContent={(overview) => (
        <View className="gap-sm">
          <Text className="font-body text-sm text-neutral-600">
            {`直近 ${overview.windowDays} 日間`}
          </Text>

          <StatCard
            label="審査待ちの申請"
            value={overview.pendingApplicationCount}
            icon={ClipboardList}
            isAlert
            onPress={() => {
              router.push(ADMIN_ROUTES.approvals);
            }}
            testID={`${TEST_ID}-pending-applications`}
          />
          <StatCard
            label="未対応の通報"
            value={overview.openReportCount}
            icon={Flag}
            isAlert
            onPress={() => {
              router.push(ADMIN_ROUTES.reports);
            }}
            testID={`${TEST_ID}-open-reports`}
          />
          <StatCard
            label="新しい店舗"
            value={overview.newShopCount}
            icon={Store}
            testID={`${TEST_ID}-new-shops`}
          />
          <StatCard
            label="新しいレビュー"
            value={overview.newReviewCount}
            icon={MessageSquare}
            testID={`${TEST_ID}-new-reviews`}
          />
          <StatCard
            label="新しい利用者"
            value={overview.newUserCount}
            icon={Users}
            onPress={() => {
              router.push(ADMIN_ROUTES.users);
            }}
            testID={`${TEST_ID}-new-users`}
          />
        </View>
      )}
    />
  );
}
```

「新しい店舗」と「新しいレビュー」に `onPress` を付けていないのは、Phase 9 に店舗一覧タブもレビュー一覧タブも無いから（店舗詳細には通報からしか入らない）。**押せそうに見えて何も起きないカードを作らない。**

- [ ] **Step 4: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/overview-screen`
Expected: PASS（8 件）

わざと壊す。

1. 「未対応の通報」の `isAlert` を消す → 「残っている仕事は赤く…」は通ってしまう（0 件なので元から赤くない）。**代わりに `OVERVIEW.openReportCount` を `3` に変えてからもう一度走らせ、落ちることを確認する。**そのうえで両方戻す。これは「0 件のときは赤くない」というテストが `isAlert` の消し忘れを隠す例で、**注意指標のテストには必ず 0 でない値の場合も要る**ことの確認。
2. 「新しい店舗」に `onPress` を足す → 「行き先の無い指標は押せない」が落ちる。
3. `ADMIN_ROUTES.approvals` を `ADMIN_ROUTES.reports` にする → 「審査待ちのカードを押すと審査タブへ移動する」が落ちる。

3 つとも確認したら戻す。

- [ ] **Step 5: 審査タブの失敗するテストを書く**

`apps/mobile/src/features/admin/screens/approvals-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchApplications } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminApplicationSummary } from '../types';
import { ApprovalsScreen } from './approvals-screen';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../api');

const fetchApplicationsMock = jest.mocked(fetchApplications);

const APPLICATION: AdminApplicationSummary = {
  applicationId: 'app_01',
  shopId: 'shp_01',
  shopName: '炭火焼 とり源',
  applicantId: 'usr_01',
  applicantName: '田中 太郎',
  status: 'pending',
  documentCount: 2,
  // ローカル時刻で作る。epoch 定数だと機械の TZ で表示が変わる
  createdAtMs: new Date(2026, 8, 16, 9, 5).getTime(),
};

beforeEach(() => {
  mockPush.mockClear();
  fetchApplicationsMock.mockReset();
  fetchApplicationsMock.mockResolvedValue({ items: [APPLICATION], nextCursor: null });
});

describe('ApprovalsScreen', () => {
  it('最初は審査待ちだけを取りに行く', async () => {
    await renderWithQuery(<ApprovalsScreen />);
    await screen.findByText('炭火焼 とり源');

    expect(fetchApplicationsMock).toHaveBeenCalledWith({ status: 'pending', cursor: null });
  });

  it('店舗名・申請者・書類の数・申請日時・状態を出す', async () => {
    await renderWithQuery(<ApprovalsScreen />);

    expect(await screen.findByText('炭火焼 とり源')).toBeTruthy();
    expect(screen.getByText('申請者 田中 太郎・書類 2 件')).toBeTruthy();
    expect(screen.getByText('2026/09/16 09:05')).toBeTruthy();
    expect(screen.getByText('審査待ち')).toBeTruthy();
  });

  it('行を押すと申請詳細へ移動する', async () => {
    await renderWithQuery(<ApprovalsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-approvals-row-app_01'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(admin)/approvals/[applicationId]',
      params: { applicationId: 'app_01' },
    });
  });

  it('絞り込みを「すべて」にすると status を送らない', async () => {
    await renderWithQuery(<ApprovalsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-approvals-filter-trigger'));
    await fireEvent.press(screen.getByTestId('admin-approvals-filter-option-all'));

    expect(fetchApplicationsMock).toHaveBeenLastCalledWith({ status: null, cursor: null });
  });

  it('絞り込みを承認済みにすると status=approved で取りに行く', async () => {
    await renderWithQuery(<ApprovalsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-approvals-filter-trigger'));
    await fireEvent.press(screen.getByTestId('admin-approvals-filter-option-approved'));

    expect(fetchApplicationsMock).toHaveBeenLastCalledWith({ status: 'approved', cursor: null });
  });

  it('0 件でも絞り込みは残す', async () => {
    fetchApplicationsMock.mockResolvedValue({ items: [], nextCursor: null });
    await renderWithQuery(<ApprovalsScreen />);

    expect(await screen.findByTestId('admin-approvals-empty')).toBeTruthy();
    // ここが消えると、絞り込みを変えて抜け出す手段が無くなる
    expect(screen.getByTestId('admin-approvals-filter-trigger')).toBeTruthy();
  });

  it('次のページがあるときだけ「もっと読む」を出す', async () => {
    fetchApplicationsMock.mockResolvedValueOnce({ items: [APPLICATION], nextCursor: 'cur_1' });
    await renderWithQuery(<ApprovalsScreen />);

    await fireEvent.press(await screen.findByTestId('admin-approvals-load-more'));

    expect(fetchApplicationsMock).toHaveBeenLastCalledWith({ status: 'pending', cursor: 'cur_1' });
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchApplicationsMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<ApprovalsScreen />);

    expect(await screen.findByTestId('admin-approvals-error')).toBeTruthy();
  });
});
```

- [ ] **Step 6: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/approvals-screen`
Expected: FAIL、`Cannot find module './approvals-screen'`

- [ ] **Step 7: 審査タブを実装する**

`apps/mobile/src/features/admin/screens/approvals-screen.tsx`

```tsx
import { useRouter } from 'expo-router';
import { Inbox } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { SelectField } from '@/components/ui/select-field';

import { AdminListScreen } from '../components/admin-list-screen';
import { toFilterOptions, toFilterValue, type WithAll } from '../components/filter-options';
import { ApplicationStatusBadge } from '../components/status-badge';
import { formatDateTime } from '../format';
import { APPLICATION_STATUS_LABELS } from '../labels';
import { useApplications } from '../queries';
import { ADMIN_DETAIL_ROUTES } from '../routes';
import {
  APPLICATION_STATUSES,
  type AdminApplicationSummary,
  type ApplicationStatus,
} from '../types';

const TEST_ID = 'admin-approvals';

/**
 * 最初に見せる絞り込み。
 *
 * 型注釈を `ApplicationStatus` にしてあるので、語彙に無い値を既定にすると
 * コンパイルが止まる。'all' を既定にしたくなったら WithAll<ApplicationStatus> に変える。
 */
const DEFAULT_STATUS: ApplicationStatus = 'pending';

const STATUS_OPTIONS = toFilterOptions(APPLICATION_STATUSES, APPLICATION_STATUS_LABELS);

function ApplicationRow({
  application,
  onPress,
}: {
  application: AdminApplicationSummary;
  onPress: () => void;
}) {
  // Text の子を分割すると getByText で引けなくなるので、1 本の文字列にしてから渡す
  const metaText = `申請者 ${application.applicantName}・書類 ${application.documentCount} 件`;

  return (
    <Card onPress={onPress} testID={`${TEST_ID}-row-${application.applicationId}`}>
      <View className="gap-xs">
        <View className="flex-row items-center justify-between gap-sm">
          <Text className="flex-1 font-body-medium text-base text-neutral-900" numberOfLines={1}>
            {application.shopName}
          </Text>
          <ApplicationStatusBadge status={application.status} />
        </View>
        <Text className="font-body text-sm text-neutral-600">{metaText}</Text>
        <Text className="font-body text-xs text-neutral-500">
          {formatDateTime(application.createdAtMs)}
        </Text>
      </View>
    </Card>
  );
}

export function ApprovalsScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<WithAll<ApplicationStatus>>(DEFAULT_STATUS);
  // 毎回新しいオブジェクトになるが、クエリキーの比較はハッシュ（中身）なので再取得は起きない
  const query = useApplications({ status: toFilterValue(status, APPLICATION_STATUSES) });

  return (
    <AdminListScreen
      query={query}
      keyOf={(application) => application.applicationId}
      renderItem={(application) => (
        <ApplicationRow
          application={application}
          onPress={() => {
            router.push(ADMIN_DETAIL_ROUTES.application(application.applicationId));
          }}
        />
      )}
      emptyIcon={Inbox}
      emptyTitle="該当する申請はありません"
      emptyDescription="絞り込みを変えると、他の状態の申請を確認できます。"
      errorTitle="申請一覧を取得できませんでした"
      header={
        <SelectField
          label="状態"
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
          testID={`${TEST_ID}-filter`}
        />
      }
      testID={TEST_ID}
    />
  );
}
```

- [ ] **Step 8: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/approvals-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（8 件）

わざと壊す。

1. `toFilterValue(status, APPLICATION_STATUSES)` を `status === 'all' ? null : status` に書き換える → コンパイルは通るが、`status` の型が `WithAll<ApplicationStatus>` のままなので `ApplicationStatus | null` に代入できず `tsc` が落ちる。**キャストで黙らせないこと。**
2. 戻してから `DEFAULT_STATUS` を `'approved'` にする → 「最初は審査待ちだけを取りに行く」が落ちる。
3. 戻してから `DEFAULT_STATUS` を `'審査待ち'` にする → **`tsc` が落ちる**（`ApplicationStatus` に無い値）。型注釈が既定値を語彙に縛っていることの確認。
4. 戻してから `metaText` をやめて `<Text>申請者 {application.applicantName}・書類 {application.documentCount} 件</Text>` に書き換える → 「店舗名・申請者・書類の数…」が落ちる（`getByText` が分割された子を引けない）。**設計判断 (5) の実地確認。**

4 つとも確認したら戻す。

- [ ] **Step 9: 通報タブの失敗するテストを書く**

`apps/mobile/src/features/admin/screens/reports-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchReports } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminReportSummary } from '../types';
import { ReportsScreen } from './reports-screen';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../api');

const fetchReportsMock = jest.mocked(fetchReports);

const REPORT: AdminReportSummary = {
  reportId: 'rep_01',
  targetType: 'review',
  targetId: 'rev_01',
  reason: '事実と異なる内容が書かれている',
  status: 'open',
  reporterId: 'usr_02',
  createdAtMs: new Date(2026, 8, 16, 18, 30).getTime(),
};

beforeEach(() => {
  mockPush.mockClear();
  fetchReportsMock.mockReset();
  fetchReportsMock.mockResolvedValue({ items: [REPORT], nextCursor: null });
});

describe('ReportsScreen', () => {
  it('最初は未対応だけを取りに行く', async () => {
    await renderWithQuery(<ReportsScreen />);
    await screen.findByText('事実と異なる内容が書かれている');

    expect(fetchReportsMock).toHaveBeenCalledWith({
      status: 'open',
      targetType: null,
      cursor: null,
    });
  });

  it('理由・対象の種別・通報日時・状態を出す', async () => {
    await renderWithQuery(<ReportsScreen />);

    expect(await screen.findByText('事実と異なる内容が書かれている')).toBeTruthy();
    expect(screen.getByText('対象 レビュー')).toBeTruthy();
    expect(screen.getByText('2026/09/16 18:30')).toBeTruthy();
    expect(screen.getByText('未対応')).toBeTruthy();
  });

  it('行を押すと通報詳細へ移動する', async () => {
    await renderWithQuery(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-reports-row-rep_01'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(admin)/reports/[reportId]',
      params: { reportId: 'rep_01' },
    });
  });

  it('対象の種別で絞り込める', async () => {
    await renderWithQuery(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-reports-target-filter-segment-shop'));

    expect(fetchReportsMock).toHaveBeenLastCalledWith({
      status: 'open',
      targetType: 'shop',
      cursor: null,
    });
  });

  it('対象の絞り込みを「すべて」に戻すと targetType を送らない', async () => {
    await renderWithQuery(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-reports-target-filter-segment-shop'));
    await fireEvent.press(screen.getByTestId('admin-reports-target-filter-segment-all'));

    expect(fetchReportsMock).toHaveBeenLastCalledWith({
      status: 'open',
      targetType: null,
      cursor: null,
    });
  });

  it('状態の絞り込みを対応済みにできる', async () => {
    await renderWithQuery(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-reports-status-filter-trigger'));
    await fireEvent.press(screen.getByTestId('admin-reports-status-filter-option-resolved'));

    expect(fetchReportsMock).toHaveBeenLastCalledWith({
      status: 'resolved',
      targetType: null,
      cursor: null,
    });
  });

  it('2 つの絞り込みは同時に効く', async () => {
    await renderWithQuery(<ReportsScreen />);
    await fireEvent.press(await screen.findByTestId('admin-reports-target-filter-segment-user'));
    await fireEvent.press(screen.getByTestId('admin-reports-status-filter-trigger'));
    await fireEvent.press(screen.getByTestId('admin-reports-status-filter-option-all'));

    expect(fetchReportsMock).toHaveBeenLastCalledWith({
      status: null,
      targetType: 'user',
      cursor: null,
    });
  });

  it('0 件でも絞り込みは残す', async () => {
    fetchReportsMock.mockResolvedValue({ items: [], nextCursor: null });
    await renderWithQuery(<ReportsScreen />);

    expect(await screen.findByTestId('admin-reports-empty')).toBeTruthy();
    expect(screen.getByTestId('admin-reports-target-filter')).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchReportsMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<ReportsScreen />);

    expect(await screen.findByTestId('admin-reports-error')).toBeTruthy();
  });
});
```

- [ ] **Step 10: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/reports-screen`
Expected: FAIL、`Cannot find module './reports-screen'`

- [ ] **Step 11: 通報タブを実装する**

`apps/mobile/src/features/admin/screens/reports-screen.tsx`

```tsx
import { useRouter } from 'expo-router';
import { Flag } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectField } from '@/components/ui/select-field';

import { AdminListScreen } from '../components/admin-list-screen';
import { toFilterOptions, toFilterValue, type WithAll } from '../components/filter-options';
import { ReportStatusBadge } from '../components/status-badge';
import { formatDateTime } from '../format';
import { REPORT_STATUS_LABELS, REPORT_TARGET_TYPE_LABELS } from '../labels';
import { useReports } from '../queries';
import { ADMIN_DETAIL_ROUTES } from '../routes';
import {
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type AdminReportSummary,
  type ReportStatus,
  type ReportTargetType,
} from '../types';

const TEST_ID = 'admin-reports';

/** 未対応から見せる。管理者がこのタブを開く理由は「残っている通報を減らすこと」 */
const DEFAULT_STATUS: ReportStatus = 'open';

const STATUS_OPTIONS = toFilterOptions(REPORT_STATUSES, REPORT_STATUS_LABELS);
const TARGET_TYPE_OPTIONS = toFilterOptions(REPORT_TARGET_TYPES, REPORT_TARGET_TYPE_LABELS);

function ReportRow({ report, onPress }: { report: AdminReportSummary; onPress: () => void }) {
  const targetText = `対象 ${REPORT_TARGET_TYPE_LABELS[report.targetType]}`;

  return (
    <Card onPress={onPress} testID={`${TEST_ID}-row-${report.reportId}`}>
      <View className="gap-xs">
        <View className="flex-row items-center justify-between gap-sm">
          <Text className="flex-1 font-body-medium text-base text-neutral-900" numberOfLines={2}>
            {report.reason}
          </Text>
          <ReportStatusBadge status={report.status} />
        </View>
        <Text className="font-body text-sm text-neutral-600">{targetText}</Text>
        <Text className="font-body text-xs text-neutral-500">
          {formatDateTime(report.createdAtMs)}
        </Text>
      </View>
    </Card>
  );
}

export function ReportsScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<WithAll<ReportStatus>>(DEFAULT_STATUS);
  const [targetType, setTargetType] = useState<WithAll<ReportTargetType>>('all');
  const query = useReports({
    status: toFilterValue(status, REPORT_STATUSES),
    targetType: toFilterValue(targetType, REPORT_TARGET_TYPES),
  });

  return (
    <AdminListScreen
      query={query}
      keyOf={(report) => report.reportId}
      renderItem={(report) => (
        <ReportRow
          report={report}
          onPress={() => {
            router.push(ADMIN_DETAIL_ROUTES.report(report.reportId));
          }}
        />
      )}
      emptyIcon={Flag}
      emptyTitle="該当する通報はありません"
      emptyDescription="絞り込みを変えると、他の状態の通報を確認できます。"
      errorTitle="通報一覧を取得できませんでした"
      header={
        <View className="gap-sm">
          <SelectField
            label="状態"
            value={status}
            options={STATUS_OPTIONS}
            onChange={setStatus}
            testID={`${TEST_ID}-status-filter`}
          />
          <SegmentedControl
            value={targetType}
            options={TARGET_TYPE_OPTIONS}
            onChange={setTargetType}
            testID={`${TEST_ID}-target-filter`}
          />
        </View>
      }
      testID={TEST_ID}
    />
  );
}
```

`targetType` の既定が `'all'` なのは、通報の対象は絞らずに全部見たいから。**`'all'` を直接書ける唯一の場所がここで、型は `WithAll<ReportTargetType>` なので語彙と混ざっていない。**

- [ ] **Step 12: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/reports-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（9 件）

わざと壊す。

1. `useReports` に渡す `targetType` を落として `{ status: ... }` だけにする → **`tsc` が落ちる**（`ReportFilter` は 2 つとも必須）。API のパラメータを増やしたときに画面が置いていかれないことの確認。
2. 戻してから `SegmentedControl` の `onChange` を `() => undefined` にする → 「対象の種別で絞り込める」ほか 3 件が落ちる。
3. 戻してから `toFilterValue(targetType, REPORT_TARGET_TYPES)` の第 2 引数を `REPORT_STATUSES` にする → **`tsc` が落ちる**（戻り値 `ReportStatus | null` を `ReportTargetType | null` に代入できない）。語彙の取り違えが型で止まることの確認。

3 つとも確認したら戻す。

- [ ] **Step 13: ユーザータブの失敗するテストを書く**

`apps/mobile/src/features/admin/screens/users-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchUsers } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminUserSummary } from '../types';
import { UsersScreen } from './users-screen';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../api');

const fetchUsersMock = jest.mocked(fetchUsers);

const USER: AdminUserSummary = {
  userId: 'usr_01',
  displayName: '田中 太郎',
  email: 'tanaka@example.com',
  role: 'owner',
  status: 'active',
  createdAtMs: new Date(2026, 8, 16, 9, 5).getTime(),
};

const NO_FILTER = { keyword: null, role: null, status: null, cursor: null };

beforeEach(() => {
  mockPush.mockClear();
  fetchUsersMock.mockReset();
  fetchUsersMock.mockResolvedValue({ items: [USER], nextCursor: null });
});

describe('UsersScreen', () => {
  it('最初は絞り込み無しで取りに行く', async () => {
    await renderWithQuery(<UsersScreen />);
    await screen.findByText('田中 太郎');

    expect(fetchUsersMock).toHaveBeenCalledWith(NO_FILTER);
  });

  it('表示名・メール・登録日時・ロール・状態を出す', async () => {
    await renderWithQuery(<UsersScreen />);

    expect(await screen.findByText('田中 太郎')).toBeTruthy();
    expect(screen.getByText('tanaka@example.com')).toBeTruthy();
    expect(screen.getByText('2026/09/16 09:05')).toBeTruthy();
    expect(screen.getByText('店舗管理者')).toBeTruthy();
    expect(screen.getByText('利用中')).toBeTruthy();
  });

  it('行を押すとユーザー詳細へ移動する', async () => {
    await renderWithQuery(<UsersScreen />);
    await fireEvent.press(await screen.findByTestId('admin-users-row-usr_01'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(admin)/users/[userId]',
      params: { userId: 'usr_01' },
    });
  });

  it('入力しただけでは検索しない', async () => {
    await renderWithQuery(<UsersScreen />);
    await screen.findByText('田中 太郎');
    await fireEvent.changeText(screen.getByTestId('admin-users-keyword'), 'tanaka');

    // 1 文字ごとに LIKE 検索を投げないための設計。最初の 1 回だけのはず
    expect(fetchUsersMock).toHaveBeenCalledTimes(1);
  });

  it('検索ボタンを押したときだけ keyword を送る', async () => {
    await renderWithQuery(<UsersScreen />);
    await screen.findByText('田中 太郎');
    await fireEvent.changeText(screen.getByTestId('admin-users-keyword'), 'tanaka');
    await fireEvent.press(screen.getByTestId('admin-users-search-button'));

    expect(fetchUsersMock).toHaveBeenLastCalledWith({ ...NO_FILTER, keyword: 'tanaka' });
  });

  it('前後の空白を落としてから送る', async () => {
    await renderWithQuery(<UsersScreen />);
    await screen.findByText('田中 太郎');
    await fireEvent.changeText(screen.getByTestId('admin-users-keyword'), '  tanaka  ');
    await fireEvent.press(screen.getByTestId('admin-users-search-button'));

    expect(fetchUsersMock).toHaveBeenLastCalledWith({ ...NO_FILTER, keyword: 'tanaka' });
  });

  it('空の検索語は送らない', async () => {
    await renderWithQuery(<UsersScreen />);
    await screen.findByText('田中 太郎');
    await fireEvent.changeText(screen.getByTestId('admin-users-keyword'), '   ');
    await fireEvent.press(screen.getByTestId('admin-users-search-button'));

    // keyword='' を送ると、サーバ側で「空文字に LIKE」する意味のないクエリになる
    expect(fetchUsersMock).toHaveBeenLastCalledWith(NO_FILTER);
  });

  it('ロールで絞り込める', async () => {
    await renderWithQuery(<UsersScreen />);
    await fireEvent.press(await screen.findByTestId('admin-users-role-filter-trigger'));
    await fireEvent.press(screen.getByTestId('admin-users-role-filter-option-admin'));

    expect(fetchUsersMock).toHaveBeenLastCalledWith({ ...NO_FILTER, role: 'admin' });
  });

  it('状態で絞り込める', async () => {
    await renderWithQuery(<UsersScreen />);
    await fireEvent.press(await screen.findByTestId('admin-users-status-filter-segment-suspended'));

    expect(fetchUsersMock).toHaveBeenLastCalledWith({ ...NO_FILTER, status: 'suspended' });
  });

  it('0 件でも検索欄は残す', async () => {
    fetchUsersMock.mockResolvedValue({ items: [], nextCursor: null });
    await renderWithQuery(<UsersScreen />);

    expect(await screen.findByTestId('admin-users-empty')).toBeTruthy();
    expect(screen.getByTestId('admin-users-keyword')).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchUsersMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<UsersScreen />);

    expect(await screen.findByTestId('admin-users-error')).toBeTruthy();
  });
});
```

- [ ] **Step 14: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/users-screen`
Expected: FAIL、`Cannot find module './users-screen'`

- [ ] **Step 15: ユーザータブを実装する**

`apps/mobile/src/features/admin/screens/users-screen.tsx`

```tsx
import { ROLES, type Role } from '@meshimap/core';
import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectField } from '@/components/ui/select-field';

import { AdminListScreen } from '../components/admin-list-screen';
import { toFilterOptions, toFilterValue, type WithAll } from '../components/filter-options';
import { ProfileStatusBadge, RoleBadge } from '../components/status-badge';
import { formatDateTime } from '../format';
import { PROFILE_STATUS_LABELS, ROLE_LABELS } from '../labels';
import { useUsers } from '../queries';
import { ADMIN_DETAIL_ROUTES } from '../routes';
import { PROFILE_STATUSES, type AdminUserSummary, type ProfileStatus } from '../types';

const TEST_ID = 'admin-users';

const ROLE_OPTIONS = toFilterOptions(ROLES, ROLE_LABELS);
const STATUS_OPTIONS = toFilterOptions(PROFILE_STATUSES, PROFILE_STATUS_LABELS);

const SEARCH_LABEL = '検索';
const KEYWORD_PLACEHOLDER = '表示名またはメールアドレス';

function UserRow({ user, onPress }: { user: AdminUserSummary; onPress: () => void }) {
  return (
    <Card onPress={onPress} testID={`${TEST_ID}-row-${user.userId}`}>
      <View className="gap-xs">
        <View className="flex-row items-center justify-between gap-sm">
          <Text className="flex-1 font-body-medium text-base text-neutral-900" numberOfLines={1}>
            {user.displayName}
          </Text>
          <ProfileStatusBadge status={user.status} />
        </View>
        <Text className="font-body text-sm text-neutral-600" numberOfLines={1}>
          {user.email}
        </Text>
        <View className="flex-row items-center justify-between gap-sm">
          <RoleBadge status={user.role} />
          <Text className="font-body text-xs text-neutral-500">
            {formatDateTime(user.createdAtMs)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

export function UsersScreen() {
  const router = useRouter();
  // 入力中の文字列と、検索に使う確定した文字列を分ける。
  // 1 つにすると 1 文字ごとにクエリキーが変わり、打つたびに LIKE 検索が飛ぶ
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState<WithAll<Role>>('all');
  const [status, setStatus] = useState<WithAll<ProfileStatus>>('all');

  const query = useUsers({
    keyword: keyword === '' ? null : keyword,
    role: toFilterValue(role, ROLES),
    status: toFilterValue(status, PROFILE_STATUSES),
  });

  return (
    <AdminListScreen
      query={query}
      keyOf={(user) => user.userId}
      renderItem={(user) => (
        <UserRow
          user={user}
          onPress={() => {
            router.push(ADMIN_DETAIL_ROUTES.user(user.userId));
          }}
        />
      )}
      emptyIcon={Users}
      emptyTitle="該当する利用者はいません"
      emptyDescription="検索語や絞り込みを変えて、もう一度お試しください。"
      errorTitle="利用者一覧を取得できませんでした"
      header={
        <View className="gap-sm">
          <Input
            label="検索"
            value={keywordInput}
            onChangeText={setKeywordInput}
            placeholder={KEYWORD_PLACEHOLDER}
            testID={`${TEST_ID}-keyword`}
          />
          <Button
            label={SEARCH_LABEL}
            variant="secondary"
            onPress={() => {
              setKeyword(keywordInput.trim());
            }}
            testID={`${TEST_ID}-search-button`}
          />
          <SelectField
            label="ロール"
            value={role}
            options={ROLE_OPTIONS}
            onChange={setRole}
            testID={`${TEST_ID}-role-filter`}
          />
          <SegmentedControl
            value={status}
            options={STATUS_OPTIONS}
            onChange={setStatus}
            testID={`${TEST_ID}-status-filter`}
          />
        </View>
      }
      testID={TEST_ID}
    />
  );
}
```

- [ ] **Step 16: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/users-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（11 件）

わざと壊す。

1. `Input` の `onChangeText` を `setKeyword` に変える（state を 1 本にする） → 「入力しただけでは検索しない」が落ちる。**debounce 無しで即時検索にした場合に何が起きるかの実地確認。**
2. 戻してから `setKeyword(keywordInput.trim())` の `.trim()` を消す → 「前後の空白を落としてから送る」と「空の検索語は送らない」が落ちる。
3. 戻してから `keyword === '' ? null : keyword` を `keyword` にする → 「最初は絞り込み無しで取りに行く」が落ちる（`keyword: ''` を送ってしまう）。

3 つとも確認したら戻す。

- [ ] **Step 17: その他タブの失敗するテストを書く**

`apps/mobile/src/features/admin/screens/more-screen.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { MoreScreen } from './more-screen';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

beforeEach(() => {
  mockPush.mockClear();
});

describe('MoreScreen', () => {
  it('4 つの行き先を出す', async () => {
    await render(<MoreScreen />);

    expect(screen.getByText('ジャンルの管理')).toBeTruthy();
    expect(screen.getByText('エリアの管理')).toBeTruthy();
    expect(screen.getByText('お知らせの配信')).toBeTruthy();
    expect(screen.getByText('監査ログ')).toBeTruthy();
  });

  it('それぞれに何ができるかを添える', async () => {
    await render(<MoreScreen />);

    expect(screen.getByText('店舗に付けるジャンルを追加・編集・削除します。')).toBeTruthy();
    expect(screen.getByText('店舗を分類するエリアを追加・編集・削除します。')).toBeTruthy();
    expect(screen.getByText('利用者へ一斉にお知らせを送ります。')).toBeTruthy();
    expect(screen.getByText('管理者の操作履歴を確認し、取り消せます。')).toBeTruthy();
  });

  it.each([
    ['genres', '/(admin)/masters/genres'],
    ['areas', '/(admin)/masters/areas'],
    ['announcements', '/(admin)/announcements'],
    ['audit-log', '/(admin)/audit-log'],
  ])('%s を押すと %s へ移動する', async (key, pathname) => {
    await render(<MoreScreen />);
    await fireEvent.press(screen.getByTestId(`admin-more-${key}`));

    expect(mockPush).toHaveBeenCalledWith(pathname);
  });

  it('押した行き先だけを開く', async () => {
    await render(<MoreScreen />);
    await fireEvent.press(screen.getByTestId('admin-more-audit-log'));

    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});
```

この画面はクエリを使わないので `renderWithQuery` ではなく素の `render` でよい。

- [ ] **Step 18: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/more-screen`
Expected: FAIL、`Cannot find module './more-screen'`

- [ ] **Step 19: その他タブを実装する**

`apps/mobile/src/features/admin/screens/more-screen.tsx`

```tsx
import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';
import {
  ChevronRight,
  Map,
  Megaphone,
  ScrollText,
  Tags,
  type LucideIcon,
} from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { COLORS, SPACING } from '@/constants/theme';

import { ADMIN_ROUTES } from '../routes';

const TEST_ID = 'admin-more';

/** 行き先の一覧。ここに足すだけで 1 行増える */
const MENU_ITEMS: readonly {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  href: Href;
}[] = [
  {
    key: 'genres',
    title: 'ジャンルの管理',
    description: '店舗に付けるジャンルを追加・編集・削除します。',
    icon: Tags,
    href: ADMIN_ROUTES.genres,
  },
  {
    key: 'areas',
    title: 'エリアの管理',
    description: '店舗を分類するエリアを追加・編集・削除します。',
    icon: Map,
    href: ADMIN_ROUTES.areas,
  },
  {
    key: 'announcements',
    title: 'お知らせの配信',
    description: '利用者へ一斉にお知らせを送ります。',
    icon: Megaphone,
    href: ADMIN_ROUTES.announcements,
  },
  {
    key: 'audit-log',
    title: '監査ログ',
    description: '管理者の操作履歴を確認し、取り消せます。',
    icon: ScrollText,
    href: ADMIN_ROUTES.auditLog,
  },
];

const CONTENT_CONTAINER_STYLE = { gap: SPACING.sm, padding: SPACING.md };

/** 行末の山括弧。本文より目立たせない */
const CHEVRON_COLOR = COLORS.neutral[400];

export function MoreScreen() {
  const router = useRouter();

  return (
    <ScrollView contentContainerStyle={CONTENT_CONTAINER_STYLE} testID={TEST_ID}>
      {MENU_ITEMS.map((item) => (
        <Card
          key={item.key}
          onPress={() => {
            router.push(item.href);
          }}
          testID={`${TEST_ID}-${item.key}`}
        >
          <View className="flex-row items-center gap-md">
            <Icon icon={item.icon} size="md" />
            <View className="flex-1 gap-xs">
              <Text className="font-body-medium text-base text-neutral-900">{item.title}</Text>
              <Text className="font-body text-sm text-neutral-600">{item.description}</Text>
            </View>
            <Icon icon={ChevronRight} size="sm" color={CHEVRON_COLOR} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}
```

アイコン名は `node_modules/lucide-react-native/dist/types/icons.d.ts` で実在を確認したものだけを使っている。**`History` は `declare const` として輸出されていない**（`icons/history.d.ts` は `rotate-ccw-clock.js` の再輸出）ので、監査ログには `ScrollText` を当てた。`Trash2` も同様に `trash.js` の別名なので、削除操作には `Trash` を使うこと（Task 9-24 で使う）。

- [ ] **Step 20: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/more-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**7 件**）。内訳は単発 3 件 + `it.each` の行き先 4 件（`genres` / `areas` / `announcements` / `audit-log`）。

わざと壊す。

1. `audit-log` の `href` を `ADMIN_ROUTES.announcements` にする → 「audit-log を押すと /(admin)/audit-log へ移動する」が落ちる。
2. 戻してから `MENU_ITEMS` から `announcements` の項目を消す → 「4 つの行き先を出す」「それぞれに何ができるかを添える」「announcements を押すと…」の 3 件が落ちる。
3. 戻してから `Icon` の `icon={ChevronRight}` を `icon={History}` にする → **`tsc` が落ちる**（`History` は lucide-react-native から輸出されていない）。

3 つとも確認したら戻す。

- [ ] **Step 21: 薄いルートファイルを 5 本作る**

いずれも 1 行。**ここにロジックを書かないこと**（`collectCoverageFrom` の `'!src/app/**'` でカバレッジの網から外れる）。

`apps/mobile/src/app/(admin)/(tabs)/overview.tsx`

```tsx
export { OverviewScreen as default } from '@/features/admin/screens/overview-screen';
```

`apps/mobile/src/app/(admin)/(tabs)/approvals.tsx`

```tsx
export { ApprovalsScreen as default } from '@/features/admin/screens/approvals-screen';
```

`apps/mobile/src/app/(admin)/(tabs)/reports.tsx`

```tsx
export { ReportsScreen as default } from '@/features/admin/screens/reports-screen';
```

`apps/mobile/src/app/(admin)/(tabs)/users.tsx`

```tsx
export { UsersScreen as default } from '@/features/admin/screens/users-screen';
```

`apps/mobile/src/app/(admin)/(tabs)/more.tsx`

```tsx
export { MoreScreen as default } from '@/features/admin/screens/more-screen';
```

- [ ] **Step 22: Task 9-20 で未確認だった代入が通ったことを確かめる**

Task 9-20 Step 7 に「`UseInfiniteQueryResult` を `AdminListQuery` に代入できるかは未検証」と書いた。この Task の 3 画面が `query={useApplications(...)}` の形で実型を渡しているので、**`npm run typecheck -w @meshimap/mobile` が通った時点で確認済みになる。**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: PASS

落ちた場合の対処（Task 9-20 に書いたとおり）。**`AdminListQuery` に `unknown` や `any` を入れて緩めないこと。**`AdminListScreenProps` から `query` を外し、`data` / `isError` / `hasNextPage` / `isFetchingNextPage` / `refetch` / `fetchNextPage` の 6 つの props に展開する。各画面の呼び出しは次の形になる。

```tsx
const query = useApplications({ status: toFilterValue(status, APPLICATION_STATUSES) });

return (
  <AdminListScreen
    data={query.data}
    isError={query.isError}
    hasNextPage={query.hasNextPage}
    isFetchingNextPage={query.isFetchingNextPage}
    refetch={query.refetch}
    fetchNextPage={query.fetchNextPage}
    /* 以下は変わらない */
  />
);
```

**通った場合は Task 9-20 Step 7 の「未確認」の但し書きを消し、「Task 9-22 で実型を代入して確認済み」に書き換える。**

- [ ] **Step 23: モバイル全体のテストとカバレッジを確認する**

Run:

```bash
npm run test:coverage -w @meshimap/mobile
```

Expected: PASS。`features/admin/screens/*.tsx` が 4 指標すべて 100%。

落ちやすいのは行コンポーネント（`ApplicationRow` / `ReportRow` / `UserRow`）の分岐。**分岐を持たせていない**ので、1 件でも描画すれば 100% になるはず。落ちたらテストを足す。`collectCoverageFrom` から外すのは選択肢にない。

- [ ] **Step 24: lint と format を通す**

Run:

```bash
npm run lint
npm run format:check
```

Expected: 両方 PASS

`src/app/(admin)/(tabs)/` の 5 本は `expo lint`（eslint-config-expo）の対象。1 行の再輸出なので、default export に関する規則には引っかからない。

- [ ] **Step 25: コミットする**

```bash
git add apps/mobile/src/features/admin/screens/ \
        "apps/mobile/src/app/(admin)/(tabs)/"
git commit -m "feat(mobile): 管理タブの 5 画面（概況 / 審査 / 通報 / ユーザー / その他）を追加"
```

`(admin)` と `(tabs)` は丸括弧を含むので、`git add` ではクオートで囲むこと。囲まないと zsh が glob として解釈して失敗する。

---

### Task 9-23: 詳細 4 画面（申請 / 通報 / ユーザー / 店舗）

Phase 9 の危ない操作は全部この 4 画面に集まる。店舗の強制非公開、ユーザーの停止、ロール変更、申請の却下。**押し間違いが本番のデータを動かす画面**なので、ここだけは「確認を出し忘れた画面が 1 枚ある」という事故を仕組みで塞ぐ。

**この Task の設計判断は 5 つ。**

**(1) 画面から直接 mutation を呼ばせない。**`ActionPanel` に操作の一覧を宣言として渡し、**パネルだけが `run` を呼ぶ**。パネルは確認ダイアログを通らない限り `run` を呼ばないので、「この画面だけ確認を忘れた」が起きない。各画面のテストで確認導線を 4 回書き直す必要も無くなる。

**(2) 確認ダイアログは常に 1 枚しか mount しない。**`ConfirmDialog` の確定ボタンと取消ボタンの testID は `confirm-dialog-confirm` / `confirm-dialog-cancel` の**固定値**（Task 9-18 の実装で `CONFIRM_TEST_ID` / `CANCEL_TEST_ID` として定数化されている）。2 枚同時に mount すると `getByTestId` が「複数見つかった」で落ちる。`ActionPanel` は `pendingKey` を 1 つだけ持ち、開いている操作のぶんだけをその場で mount する。

**(3) 確認したらダイアログは閉じ、送信中は操作行のボタンで示す。**ダイアログを開いたまま送信完了を待つには「mutation が終わったら閉じる」を `useEffect` で書くことになる。そこを避けて、確定を押したら即座に閉じ、進行中は `ActionRow` のボタンが `isLoading` で押せなくなる形にする。二度押しは `Button` 側が止める（`isInteractionBlocked`）。

**(4) 強調（色）は 1 つの値から両方を導く。**`emphasis` を `'primary' | 'normal' | 'destructive'` の 3 値にし、**ボタンの variant とダイアログの `isDestructive` の両方をここから決める**。別々に渡せるようにすると「赤いボタンなのにダイアログは青い」組み合わせが作れてしまう。

**(5) 成功後の行き先はキューかどうかで変える。**申請と通報は「1 件ずつ処理して次へ進む」キューなので、成功したら `router.back()` で一覧へ戻る。ユーザーと店舗は「1 人 / 1 店舗にいくつか操作する」管理画面なので、成功しても留まる。

**既知の弱点（Phase 9 の範囲外）。**Task 9-7 で決めたとおり、サーバは**自分自身の停止とロール変更を 409 で拒む**。ところがモバイルの `toAdminErrorMessage` は 409 を「他の管理者が先に処理しました。画面を更新してください。」に読み替えるので、自分を停止しようとしたときの文言が実態と合わない。正しく出し分けるには (a) ログイン中の管理者の ID を画面が知る（Phase 6 のセッションフックの名前と形は**未確認**）か、(b) 409 応答に機械可読な `code` を足す（Task 9-0 / 9-13 / 9-19 に波及）かのどちらかが要る。**Phase 9 ではどちらもやらず、汎用文言のままにして「次フェーズへの引き継ぎ」に残す。**

**Files:**

- Modify: `apps/mobile/src/features/admin/routes.ts`（`toRouteParam` を追加）
- Modify: `apps/mobile/src/features/admin/routes.test.ts`
- Modify: `apps/mobile/src/features/admin/types.ts`（`REVIEW_NOTE_MAX_LENGTH` を追加）
- Modify: `apps/mobile/src/features/admin/types.test.ts`
- Create: `apps/mobile/src/features/admin/components/action-panel.tsx`
- Create: `apps/mobile/src/features/admin/components/action-panel.test.tsx`
- Create: `apps/mobile/src/features/admin/components/detail-field.tsx`
- Create: `apps/mobile/src/features/admin/components/detail-field.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/approval-detail-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/approval-detail-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/report-detail-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/report-detail-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/user-detail-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/user-detail-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/shop-detail-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/shop-detail-screen.test.tsx`
- Create: `apps/mobile/src/app/(admin)/approvals/[applicationId].tsx`
- Create: `apps/mobile/src/app/(admin)/reports/[reportId].tsx`
- Create: `apps/mobile/src/app/(admin)/users/[userId].tsx`
- Create: `apps/mobile/src/app/(admin)/shops/[shopId].tsx`

`[applicationId].tsx` のような角括弧つきの名前は expo-router の動的セグメントの決まりで、**ファイル名 kebab-case の規約より優先する**（規約に合わせて改名するとルートが消える）。

**Interfaces:**

- Consumes:
  - `ConfirmDialog` / `SelectField`（Task 9-18）
  - `ActionRow` / `AdminDetailScreen`（Task 9-20）
  - `formatDiffValue` / `formatDateTime` / 5 つの状態バッジ / `ADMIN_DETAIL_ROUTES`（Task 9-21）
  - `useApplication` / `useReviewApplication` / `useReport` / `useResolveReport` / `useRejectReport` / `useUser` / `useSuspendUser` / `useRestoreUser` / `useChangeUserRole` / `useShop` / `useSuspendShop` / `useRestoreShop` / `useAssignShopOwner`（Task 9-19）
  - `toAdminErrorMessage` / `fetchApplication` / `reviewApplication` / `fetchReport` / `resolveReport` / `rejectReport` / `fetchUser` / `suspendUser` / `restoreUser` / `changeUserRole` / `fetchShop` / `suspendShop` / `restoreShop` / `assignShopOwner`（Task 9-19）
  - `toSelectOptions` と各ラベル表（Task 9-19）
  - `expo-router` の `useLocalSearchParams` / `useRouter`
- Produces:
  - `routes.ts`: `toRouteParam(value: string | string[] | undefined): string`
  - `types.ts`: `REVIEW_NOTE_MAX_LENGTH`
  - `action-panel.tsx`: `ActionEmphasis` / `AdminAction` / `ActionPanelProps` / `ActionPanel`
  - `detail-field.tsx`: `DetailFieldProps` / `DetailField`
  - `ApprovalDetailScreen` / `ReportDetailScreen` / `UserDetailScreen` / `ShopDetailScreen`（いずれも props なし。`src/app/(admin)/` の 4 本が default として再輸出する）

- [ ] **Step 1: 動的セグメントの読み取りに失敗するテストを書く**

`apps/mobile/src/features/admin/routes.test.ts` に追記する。

```tsx
import { ADMIN_DETAIL_ROUTES, ADMIN_ROUTES, toRouteParam } from './routes';

describe('toRouteParam', () => {
  it('文字列はそのまま返す', () => {
    expect(toRouteParam('usr_01')).toBe('usr_01');
  });

  it('配列は先頭を返す', () => {
    // 同じ名前のセグメントが 2 つ並んだときに expo-router は配列で返す
    expect(toRouteParam(['usr_01', 'usr_02'])).toBe('usr_01');
  });

  it('空配列は空文字にする', () => {
    expect(toRouteParam([])).toBe('');
  });

  it('未定義は空文字にする', () => {
    // 画面遷移の途中や、ルート外での描画で起きる
    expect(toRouteParam(undefined)).toBe('');
  });

  it('空文字はそのまま空文字', () => {
    expect(toRouteParam('')).toBe('');
  });
});
```

**空文字に寄せる理由。**Task 9-19 の詳細フックはどれも `enabled: id !== ''` を持つ。ID が取れないときに空文字へ正規化しておけば、`/admin/users/undefined` のような無意味なリクエストが飛ばない。`null` ではなく空文字にするのは、フック側の条件を 1 つに保つため。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/routes`
Expected: FAIL、`toRouteParam is not a function`

- [ ] **Step 3: `toRouteParam` を実装する**

`apps/mobile/src/features/admin/routes.ts` の末尾に足す。

```tsx
/**
 * `useLocalSearchParams()` が返す値を 1 本の文字列にする。
 *
 * 戻り値の型は `Record<string, string | string[]>`
 * （`node_modules/expo-router/build/typed-routes/types.d.ts:89` の `UnknownOutputParams`）だが、
 * tsconfig の `noUncheckedIndexedAccess` により取り出した値には `undefined` が付く。
 * 実際、ルート外で描画されたときや遷移の途中では値が無い。
 * 取れなかったときは空文字にして、詳細フックの `enabled: id !== ''` に載せる。
 */
export function toRouteParam(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return '';
}
```

- [ ] **Step 4: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/routes && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**10 + 5 = 15 件**。Task 9-21 の 10 件 + このタスクで `toRouteParam` に足した 5 件）

わざと壊す。

1. `return value[0] ?? '';` を `return value[0];` にする → **`tsc` が落ちる**（`string | undefined` を `string` に返せない）。`noUncheckedIndexedAccess` が効いていることの確認。
2. 戻してから最後の `return '';` を `return String(value);` にする → 「未定義は空文字にする」が落ちる（`'undefined'` が返る）。**これが `/admin/users/undefined` を投げる実装そのもの。**

2 つとも確認したら戻す。

- [ ] **Step 5: 審査理由の上限値の突き合わせテストを書く**

`apps/mobile/src/features/admin/types.test.ts` に追記する。モバイルからサーバのソースは import できないので値は書き写すしかないが、**書き写しのずれは機械的に落とす**（Task 9-19 で語彙に対してやったのと同じ手口）。

```tsx
import { APPLICATION_STATUSES, REVIEW_NOTE_MAX_LENGTH } from './types';

/** `export const NAME = 123;` の数値を取り出す */
function readNumberLiteral(source: string, name: string): number {
  const matched = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  const value = matched?.[1];
  if (value === undefined) {
    throw new Error(`定数 ${name} の数値リテラルを読み取れませんでした`);
  }
  return Number(value);
}

describe('サーバの上限値との一致', () => {
  it('REVIEW_NOTE_MAX_LENGTH が apps/api/src/routes/admin/schemas.ts と一致する', () => {
    const schemasSource = readFileSync(join(API_SRC_DIR, 'routes', 'admin', 'schemas.ts'), 'utf8');

    expect(REVIEW_NOTE_MAX_LENGTH).toBe(readNumberLiteral(schemasSource, 'REVIEW_NOTE_MAX_LENGTH'));
  });
});
```

`readFileSync` / `join` / `API_SRC_DIR` は Task 9-19 で同じファイルの先頭に定義済み。**import 行と定数をもう一度書かないこと**（`noUnusedLocals` と重複宣言で落ちる）。

- [ ] **Step 6: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/types`
Expected: FAIL、`REVIEW_NOTE_MAX_LENGTH` が `undefined`

- [ ] **Step 7: 上限値を実装する**

`apps/mobile/src/features/admin/types.ts` に足す。

```tsx
/**
 * 差し戻し・却下の理由の上限。
 * サーバの `reviewNoteSchema` が `.max(REVIEW_NOTE_MAX_LENGTH)` なので、
 * ここを超えさせると 422 を利用者に見せることになる。入力欄の maxLength に渡して超えさせない。
 */
export const REVIEW_NOTE_MAX_LENGTH = 500;
```

Run: `npm test -w @meshimap/mobile -- features/admin/types`
Expected: PASS

わざと壊す: `500` を `501` にする → 突き合わせテストが落ちる。確認したら戻す。

- [ ] **Step 8: 詳細行と操作パネルの失敗するテストを書く**

`apps/mobile/src/features/admin/components/detail-field.test.tsx`

```tsx
import { render, screen } from '@testing-library/react-native';

import { DetailField } from './detail-field';

describe('DetailField', () => {
  it('ラベルと値を出す', async () => {
    await render(<DetailField label="申請者" value="田中 太郎" testID="applicant" />);

    expect(screen.getByText('申請者')).toBeOnTheScreen();
    expect(screen.getByText('田中 太郎')).toBeOnTheScreen();
  });

  it('null は「（なし）」にする', async () => {
    await render(<DetailField label="審査メモ" value={null} testID="review-note" />);

    expect(screen.getByText('（なし）')).toBeOnTheScreen();
  });

  it('空文字も「（なし）」にする', async () => {
    // サーバが '' を返したときに、ラベルだけが浮いた行にならないようにする
    await render(<DetailField label="審査メモ" value="" testID="review-note" />);

    expect(screen.getByText('（なし）')).toBeOnTheScreen();
  });
});
```

`apps/mobile/src/features/admin/components/action-panel.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ActionPanel, type AdminAction } from './action-panel';

const TEST_ID = 'test-actions';

const runSuspend = jest.fn();
const runRestore = jest.fn();

/** 既定は「破壊的な操作 1 つと、ふつうの操作 1 つ」。テストごとに必要な項目だけ上書きする */
function buildActions(overrides: Partial<AdminAction> = {}): readonly AdminAction[] {
  return [
    {
      key: 'suspend',
      title: 'このユーザーを停止する',
      description: 'ログインできなくなります。あとから復帰できます。',
      actionLabel: '停止する',
      confirmTitle: 'このユーザーを停止しますか？',
      confirmMessage: 'ログインできなくなります。あとから復帰できます。',
      emphasis: 'destructive',
      run: runSuspend,
      ...overrides,
    },
    {
      key: 'restore',
      title: 'このユーザーを復帰させる',
      description: 'ふたたびログインできるようになります。',
      actionLabel: '復帰させる',
      confirmTitle: 'このユーザーを復帰させますか？',
      confirmMessage: 'ふたたびログインできるようになります。',
      emphasis: 'normal',
      run: runRestore,
    },
  ];
}

beforeEach(() => {
  runSuspend.mockClear();
  runRestore.mockClear();
});

describe('ActionPanel', () => {
  it('操作の数だけ行を出す', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);

    expect(screen.getByText('このユーザーを停止する')).toBeOnTheScreen();
    expect(screen.getByText('このユーザーを復帰させる')).toBeOnTheScreen();
  });

  it('ボタンを押しただけでは run を呼ばない', async () => {
    // この Task でいちばん大事な保証。確認を通らずに本番のデータが動かないこと
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));

    expect(runSuspend).not.toHaveBeenCalled();
    expect(screen.getByText('このユーザーを停止しますか？')).toBeOnTheScreen();
  });

  it('確認を押すと run を呼ぶ', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(runSuspend).toHaveBeenCalledTimes(1);
    expect(runRestore).not.toHaveBeenCalled();
  });

  it('確認したらダイアログを閉じる', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeOnTheScreen();
  });

  it('取消を押すと run を呼ばずに閉じる', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));

    expect(runSuspend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeOnTheScreen();
  });

  it('開いている確認は常に 1 つ', async () => {
    // ConfirmDialog のボタンの testID は固定値なので、2 枚出ると getByTestId が落ちる
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));

    expect(screen.getAllByTestId('confirm-dialog')).toHaveLength(1);
  });

  it('破壊的な操作はボタンも確認も赤くする', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);

    expect(screen.getByTestId(`${TEST_ID}-suspend-button`).props.className).toContain('bg-red-500');

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));

    expect(screen.getByTestId('confirm-dialog-confirm').props.className).toContain('bg-red-500');
  });

  it('破壊的でない操作は赤くしない', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-restore-button`));

    expect(screen.getByTestId('confirm-dialog-confirm').props.className).not.toContain(
      'bg-red-500',
    );
  });

  it('主要な操作は primary の見た目にする', async () => {
    await render(<ActionPanel actions={buildActions({ emphasis: 'primary' })} testID={TEST_ID} />);

    expect(screen.getByTestId(`${TEST_ID}-suspend-button`).props.className).toContain(
      'bg-primary-500',
    );
  });

  it('無効な操作は確認を開かない', async () => {
    await render(<ActionPanel actions={buildActions({ isDisabled: true })} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));

    expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeOnTheScreen();
  });

  it('送信中の操作は確認を開かない', async () => {
    await render(<ActionPanel actions={buildActions({ isLoading: true })} testID={TEST_ID} />);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-suspend-button`));

    expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeOnTheScreen();
  });

  it('失敗した操作の行にだけエラーを出す', async () => {
    await render(
      <ActionPanel
        actions={buildActions({ errorMessage: '他の管理者が先に処理しました。' })}
        testID={TEST_ID}
      />,
    );

    expect(screen.getByTestId(`${TEST_ID}-suspend-error`)).toHaveTextContent(
      '他の管理者が先に処理しました。',
    );
    expect(screen.queryByTestId(`${TEST_ID}-restore-error`)).not.toBeOnTheScreen();
  });

  it('エラーが無ければエラー行を出さない', async () => {
    await render(<ActionPanel actions={buildActions()} testID={TEST_ID} />);

    expect(screen.queryByTestId(`${TEST_ID}-suspend-error`)).not.toBeOnTheScreen();
  });
});
```

- [ ] **Step 9: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/detail-field features/admin/components/action-panel`
Expected: FAIL、両方 `Cannot find module`

- [ ] **Step 10: 詳細行と操作パネルを実装する**

`apps/mobile/src/features/admin/components/detail-field.tsx`

```tsx
import { Text, View } from 'react-native';

import { formatDiffValue } from '../format';

export interface DetailFieldProps {
  label: string;
  /** サーバが null や空文字を返しうる列は、そのまま渡してよい */
  value: string | null;
  testID: string;
}

/**
 * 詳細画面のラベル + 値の 1 行。
 *
 * 空の表し方は `formatDiffValue`（Task 9-21）に任せる。
 * 監査ログの差分と同じ「（なし）」で揃えておくと、同じ管理画面の中で表記がぶれない。
 */
export function DetailField({ label, value, testID }: DetailFieldProps) {
  return (
    <View className="gap-xs" testID={testID}>
      <Text className="font-body text-xs text-neutral-500">{label}</Text>
      <Text className="font-body text-base text-neutral-900">{formatDiffValue(value)}</Text>
    </View>
  );
}
```

`apps/mobile/src/features/admin/components/action-panel.tsx`

```tsx
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { ButtonVariant } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import { ActionRow } from './action-row';

/**
 * 操作の強さ。
 * ボタンの色と確認ダイアログの色を**この 1 つの値から導く**。
 * 別々に渡せるようにすると「赤いボタンなのに確認は青い」組み合わせが作れてしまう。
 */
export type ActionEmphasis = 'primary' | 'normal' | 'destructive';

export interface AdminAction {
  /** 行の testID と React の key に使う。画面の中で一意にする */
  readonly key: string;
  readonly title: string;
  /** 何が起きるか・戻せるかを 1 文で書く */
  readonly description: string;
  readonly actionLabel: string;
  readonly confirmTitle: string;
  readonly confirmMessage: string;
  readonly emphasis: ActionEmphasis;
  readonly isDisabled?: boolean | undefined;
  readonly isLoading?: boolean | undefined;
  /** この操作が失敗したときだけ渡す。全部の行に同じ文が並ぶと、どれが失敗したのか分からない */
  readonly errorMessage?: string | undefined;
  /** 確認を通ったときだけ呼ばれる */
  readonly run: () => void;
}

export interface ActionPanelProps {
  actions: readonly AdminAction[];
  testID: string;
}

const EMPHASIS_VARIANTS: Record<ActionEmphasis, ButtonVariant> = {
  primary: 'primary',
  normal: 'secondary',
  destructive: 'danger',
};

const DESTRUCTIVE_EMPHASIS: ActionEmphasis = 'destructive';

/**
 * 破壊的操作の唯一の入口。
 *
 * 画面は「何ができるか」を宣言するだけで、mutation を直接呼ばない。
 * `run` を呼ぶのはここの確認後の 1 行だけなので、
 * 「この画面だけ確認ダイアログを出し忘れた」が起きない。
 *
 * ダイアログを 1 枚しか mount しないのは、`ConfirmDialog` のボタンの testID が
 * 固定値（confirm-dialog-confirm / confirm-dialog-cancel）だから。
 * 2 枚出ると getByTestId が「複数見つかった」で落ちる。
 */
export function ActionPanel({ actions, testID }: ActionPanelProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingAction = actions.find((action) => action.key === pendingKey) ?? null;

  return (
    <View className="gap-md" testID={testID}>
      {actions.map((action) => (
        <View className="gap-xs" key={action.key}>
          <ActionRow
            title={action.title}
            description={action.description}
            actionLabel={action.actionLabel}
            variant={EMPHASIS_VARIANTS[action.emphasis]}
            isDisabled={action.isDisabled}
            isLoading={action.isLoading}
            onPress={() => {
              setPendingKey(action.key);
            }}
            testID={`${testID}-${action.key}`}
          />
          {action.errorMessage === undefined ? null : (
            <Text
              accessibilityRole="alert"
              className="font-body text-sm text-red-700"
              testID={`${testID}-${action.key}-error`}
            >
              {action.errorMessage}
            </Text>
          )}
        </View>
      ))}

      {pendingAction === null ? null : (
        <ConfirmDialog
          isVisible
          title={pendingAction.confirmTitle}
          message={pendingAction.confirmMessage}
          confirmLabel={pendingAction.actionLabel}
          isDestructive={pendingAction.emphasis === DESTRUCTIVE_EMPHASIS}
          onConfirm={() => {
            // 先に閉じてから走らせる。開いたまま待つには「終わったら閉じる」を
            // useEffect で書くことになり、mutation の状態と画面の状態が二重管理になる
            setPendingKey(null);
            pendingAction.run();
          }}
          onCancel={() => {
            setPendingKey(null);
          }}
        />
      )}
    </View>
  );
}
```

`ActionRow` は `isDisabled` / `isLoading` を `Button` にそのまま渡す（Task 9-20）。押せない行は `onPress` 自体が呼ばれないので、`setPendingKey` に届かない。**`ActionPanel` 側で「無効なら開かない」を二重に書かない**こと（Button の判定と食い違う枝ができる）。

- [ ] **Step 11: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/components && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**45 件**）。内訳は Task 9-20 の 29 件（Step 16 時点の 28 件 + Step 17 の破壊検証で `action-row.test.tsx` に足した 1 件）+ 3 + 13。**Task 9-20 Step 16 の 28 件のままだと思い込まないこと**

わざと壊す。

1. `onConfirm` の中身を `pendingAction.run();` だけにする（`setPendingKey(null)` を消す） → 「確認したらダイアログを閉じる」が落ちる。
2. 戻してから `ActionRow` の `onPress` を `() => { action.run(); }` にする → **「ボタンを押しただけでは run を呼ばない」が落ちる**。この Task の中心的な保証が効いていることの確認。
3. 戻してから `isDestructive` を `false` 固定にする → 「破壊的な操作はボタンも確認も赤くする」が落ちる。
4. 戻してから `EMPHASIS_VARIANTS` から `primary` の行を消す → **`tsc` が落ちる**（`Record<ActionEmphasis, ButtonVariant>` に穴が空く）。強調の値を足したときにボタンの色の対応を忘れられないことの確認。
5. 戻してから `actions.find(...)` を `actions[0] ?? null` にする → 「破壊的でない操作は赤くしない」が落ちる（復帰を押しても停止のダイアログが出る）。

5 つとも確認したら戻す。

---

### Task 9-24: 残り 4 画面と総仕上げ

Phase 9 の最後。マスタ 2 枚（ジャンル / エリア）、お知らせ配信、監査ログの 4 画面を作り、**13 本のルートが実ファイルと 1 対 1 で対応していること**と**`src/app/(admin)/**` が全部 1 行の再輸出であること**を機械で検査して締める。

**先に 1 つ訂正しておく。**計画書 301〜302 行目の部品表に `master-editor.tsx`（ジャンル / エリアで共有する一覧 + 編集フォーム）と `audit-log-row.tsx`（監査ログ 1 行）が載っているが、**この 2 つの props は Task 9-18〜9-23 のどこにも定義されていない**（`grep -n 'master-editor\|MasterEditor\|audit-log-row\|AuditLogRow' docs/superpowers/plans/2026-09-15-phase-9-admin.md` が部品表の 2 行しか返さないことを 2026-09-16 に実測）。表に名前があるだけなので、**この Task で新規に定義して作る**。共有部品を先に作ってから画面を組む順にする。

**この Task の設計判断は 7 つ。**

**(1) ジャンルとエリアは同じ部品の 2 つの設定にする。**どちらも「一覧を出す / 追加する / 直す / 消す」しかしない。画面を 2 枚別々に書くと、確認ダイアログの出し方も失敗時の文言の置き場所も 2 通りになる。`MasterEditor` に**一覧と編集の骨**を持たせ、画面は「行をどう見せるか」「下書きを API の入力にどう変換するか」だけを渡す。

**(2) 入力の検査は「文言を返す関数」ではなく「入力そのものを返す関数」にする。**`validate(draft): string | null` と `onSubmit(draft)` に分けると、`onSubmit` の中でもう一度 `Number(draft.sortOrderText)` を解き直すことになり、そこに `?? 0` のような**到達しない枝**が生まれてカバレッジ 100% が永久に届かなくなる。`toInput(draft): DraftResult<TInput>` が `{ kind: 'ok', input }` か `{ kind: 'error', message }` のどちらかを返す形にすれば、成功の枝には解析済みの値しか流れない。

**(3) 保存に失敗したらフォームを残し、削除に失敗したらダイアログは閉じる。**フォームは 3〜4 個の入力を抱えているので、失敗のたびに閉じると打ち直しになる。だから `onSubmit` は「成功したら呼ぶ」コールバックを第 3 引数で受け取り、**閉じる判断を画面（= mutation の結果を知っている側）に渡す**。削除は入力が無く押し直すだけなので、Task 9-23 の `ActionPanel` と同じく確定した瞬間に閉じる。

**(4) 一覧の中の危ない操作に `ActionPanel` を使わない。**`ActionPanel` は詳細画面の縦積みパネル用で、1 操作につきタイトル・説明・ボタンの 3 行を使う。監査ログの行に埋めると 1 行が 3 倍の高さになる。そのうえ `ConfirmDialog` の確定ボタンの testID は `confirm-dialog-confirm` の**固定値**（Task 9-18）なので、行ごとにパネルを持たせると「2 枚 mount され得る木」ができてしまう。**確認ダイアログは画面が 1 枚だけ持つ。**行は「押されたことを親へ伝える」だけにする。

**(5) 配信先の既定は一番狭いものにする。**`announcementAudienceSchema` は `all` / `role` / `users` の 3 択（Task 9-19）。`all` を既定にすると、題名と本文だけ書いて送信を押した人が全利用者へ配ってしまう。既定は `users`（ユーザー ID を打つまで送信ボタンが動かない）にする。**ロールの選択だけは 3 択でも `SelectField` を使う**。Task 9-22 の「4 択以下は `SegmentedControl`」に反するが、`SegmentedControl` の `value` は `TValue` で null を取れず、**必ずどれかが選ばれた状態**になる。「まだ選んでいない」を表せない部品を宛先の選択に使わない。

**(6) 画面の絞り込みの空欄は `null` に落とす。**監査ログは実行者 ID と対象 ID を文字入力で受ける。空文字のままクエリに載せると `actorId=` が飛び、サーバ側で「空文字の実行者」を探すことになる。前後の空白を落として空なら `null` にする関数を `format.ts` に 1 つ置き、ジャンルのアイコンキー（`string | null`）でも同じものを使う。

**(7) ルートの検査に `existsSync` を使わない。**macOS の APFS は既定で大文字小文字を区別せず、`src/app/(admin)/AUDIT-LOG.tsx` を渡しても `existsSync` が true を返す（2026-09-16 実測）。Linux の CI では別ファイル扱いになってルートが 404 になる。`readdirSync(dir, { recursive: true })` で取った一覧を `Set` にして綴りごと突き合わせる。**グループ（`(admin)` / `(tabs)`）も動的セグメント（`[applicationId]`）もパス文字列にそのまま現れる**ので、特別扱いは要らない（`'/(admin)/(tabs)/overview'` → `'(tabs)/overview.tsx'`。2026-09-16 実測）。

**Files:**

- Modify: `apps/mobile/src/features/admin/format.ts`（`toNullableText` を追加）
- Modify: `apps/mobile/src/features/admin/format.test.ts`
- Modify: `apps/mobile/src/features/admin/types.ts`（`DraftResult<TInput>` を追加）
- Modify: `apps/mobile/src/features/admin/routes.test.ts`（ルート ↔ 実ファイルと薄さの検査を追加）
- Create: `apps/mobile/src/features/admin/components/master-editor.tsx`
- Create: `apps/mobile/src/features/admin/components/master-editor.test.tsx`
- Create: `apps/mobile/src/features/admin/components/audit-log-row.tsx`
- Create: `apps/mobile/src/features/admin/components/audit-log-row.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/genres-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/genres-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/areas-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/areas-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/announcements-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/announcements-screen.test.tsx`
- Create: `apps/mobile/src/features/admin/screens/audit-log-screen.tsx`
- Create: `apps/mobile/src/features/admin/screens/audit-log-screen.test.tsx`
- Create: `apps/mobile/src/app/(admin)/masters/genres.tsx`
- Create: `apps/mobile/src/app/(admin)/masters/areas.tsx`
- Create: `apps/mobile/src/app/(admin)/announcements.tsx`
- Create: `apps/mobile/src/app/(admin)/audit-log.tsx`

`types.ts` に足すのは型だけなので、テストは足さない（babel が型を消すと 1 文も残らず、カバレッジの分母にも分子にも乗らない。`apps/mobile/jest.config.js` のコメントにある取り扱いと同じ）。

**Interfaces:**

- Consumes:
  - `@/components/ui/{badge,button,card,empty-state,error-state,icon,input,skeleton}`（実ファイルで props 確認済み。`Input` は `label` / `value` / `onChangeText` / `placeholder?` / `errorMessage?` / `isRequired?` / `isMultiline?` / `maxLength?` / `testID?` のみで、**`keyboardType` を受け取らない**）
  - `@/components/ui/confirm-dialog` の `ConfirmDialog`、`@/components/ui/select-field` の `SelectField` / `SelectOption`、`@/components/ui/segmented-control` の `SegmentedControl`（Task 9-18）
  - `@/constants/theme` の `COLORS` / `SPACING`
  - `@meshimap/core` の `ROLES` / `Role`
  - Task 9-19: `AdminGenre` / `AdminArea` / `AnnouncementHistoryItem` / `AuditLogItem` / `AnnouncementAudience` / `AUDIT_ACTIONS` / `AUDIT_TARGET_TYPES` / `AuditAction` / `AuditTargetType`、`GenreInput` / `AreaInput` / `AnnouncementInput`、`fetchGenres` ほか 12 本の API 関数、`toAdminErrorMessage`、`useGenres` / `useCreateGenre` / `useUpdateGenre` / `useDeleteGenre` / `useAreas` / `useCreateArea` / `useUpdateArea` / `useDeleteArea` / `useAnnouncementHistory` / `useSendAnnouncement` / `useAuditLogs` / `useUndoAuditLog`、`AUDIT_ACTION_LABELS` / `AUDIT_TARGET_TYPE_LABELS` / `ROLE_LABELS` / `toSelectOptions`
  - Task 9-20: `AdminListScreen` / `AdminListQuery`、`renderWithQuery`（`../testing/query-wrapper`）
  - `expo-router` の `Href` 型（routes.test.ts でルートの pathname を取り出すため）
  - Task 9-21: `ADMIN_ROUTES` / `ADMIN_DETAIL_ROUTES`、`formatDateTime` / `formatDiffValue` / `EMPTY_VALUE_LABEL`、`toFilterOptions` / `toFilterValue` / `WithAll` / `ALL_FILTER_VALUE`
- Produces:
  - `format.ts`: `toNullableText(value: string): string | null`
  - `types.ts`: `DraftResult<TInput>`
  - `master-editor.tsx`: `MasterQuery<TItem>` / `MasterRow` / `MasterEditorProps<TItem, TDraft, TInput>` / `MasterEditor` / `toWriteErrorMessage`
  - `audit-log-row.tsx`: `AuditLogRowProps` / `AuditLogRow` / `toActionLabel(action: string): string`（監査ログ画面の確認ダイアログでも使うので export する）
  - `GenresScreen` / `AreasScreen` / `AnnouncementsScreen` / `AuditLogScreen`（いずれも props なし。`src/app/(admin)/` の 4 本が default として再輸出する）

- [ ] **Step 1: 空欄を null に落とす関数の失敗するテストを書く**

`apps/mobile/src/features/admin/format.test.ts` に追記する。

```ts
import { EMPTY_VALUE_LABEL, formatDateTime, formatDiffValue, toNullableText } from './format';

describe('toNullableText', () => {
  it('文字が入っていればそのまま返す', () => {
    expect(toNullableText('usr_01')).toBe('usr_01');
  });

  it('前後の空白を落とす', () => {
    // ID を貼り付けると前後に空白が付いてくることがある
    expect(toNullableText('  usr_01  ')).toBe('usr_01');
  });

  it('空文字は null にする', () => {
    expect(toNullableText('')).toBeNull();
  });

  it('空白だけも null にする', () => {
    expect(toNullableText('   ')).toBeNull();
  });

  it('中の空白は残す', () => {
    // 店名など空白を含む値を壊さない
    expect(toNullableText(' 炭火焼 とり源 ')).toBe('炭火焼 とり源');
  });

  it('0 という文字は null にしない', () => {
    // 空判定を falsy で書くと '0' が消える
    expect(toNullableText('0')).toBe('0');
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/format`
Expected: FAIL、`toNullableText is not a function`

- [ ] **Step 3: `toNullableText` を実装する**

`apps/mobile/src/features/admin/format.ts` の末尾に足す。

```ts
/**
 * 入力欄の値を API の `string | null` に落とす。
 *
 * 空文字のまま送ると「空文字の実行者を探す」「アイコンキーが空文字の行を作る」といった、
 * 誰も意図していない値がサーバに残る。`null` は「指定なし」を表す正規の値なので、
 * 画面の「何も書かなかった」をそこへ寄せる。
 *
 * `value.trim() ? value.trim() : null` と書かないこと。'0' が falsy ではないので
 * 今は通るが、数値を文字で受ける欄（並び順）に流用した瞬間に '0' が消える。
 */
export function toNullableText(value: string): string | null {
  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}
```

- [ ] **Step 4: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/format && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（Task 9-21 の 13 件 + 6 = 19 件）

わざと壊す。

1. `value.trim()` を `value` にする → 「前後の空白を落とす」と「空白だけも null にする」の 2 つが落ちる。
2. 戻してから本体を `return value === '' ? null : value;` にする → 「空白だけも null にする」と「前後の空白を落とす」が落ちる。
3. 戻してから本体を `return trimmed || null;` にする → **`'0'` を返すので 6 件目は通ってしまう**ことを確認する（`'0'` は truthy）。そのうえで返り値の型が `string | null` のままであることも見る。**このテストが「今は」守れていないことを知ったうえで、コメントの警告を残す。**

3 つとも確認したら戻す。

- [ ] **Step 5: `DraftResult` を型だけ足す**

`apps/mobile/src/features/admin/types.ts` の末尾に足す。

```ts
/**
 * 画面の下書きを API の入力に変換した結果。
 *
 * 「検査する関数」と「送る関数」を分けない。分けると送る側でもう一度解析することになり、
 * `Number(text) ?? 0` のような**到達しない枝**が生まれてカバレッジ 100% に届かなくなる。
 * 成功の枝には解析済みの値しか流れない形にする。
 */
export type DraftResult<TInput> =
  | { readonly kind: 'ok'; readonly input: TInput }
  | { readonly kind: 'error'; readonly message: string };
```

型だけなのでテストは足さない。使われ方は Step 6 以降のテストで縛る。

Run: `npm run typecheck -w @meshimap/mobile`
Expected: PASS

- [ ] **Step 6: マスタ編集部品の失敗するテストを書く**

`apps/mobile/src/features/admin/components/master-editor.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Input } from '@/components/ui/input';
import { Tags } from 'lucide-react-native';

import type { DraftResult } from '../types';
import { MasterEditor, type MasterQuery } from './master-editor';

/** 部品だけを試すための最小の語彙。実際の AdminGenre に依存させない */
interface TestItem {
  readonly id: string;
  readonly name: string;
}

interface TestDraft {
  readonly name: string;
}

interface TestInput {
  readonly name: string;
}

const ITEM: TestItem = { id: 'gen_01', name: '居酒屋' };
const NEW_DRAFT: TestDraft = { name: '' };
const TEST_ID = 'master';
const ENTITY_LABEL = 'ジャンル';
const NAME_REQUIRED_MESSAGE = '名前を入力してください';

const onSubmit = jest.fn();
const onDelete = jest.fn();
const refetch = jest.fn();

function buildQuery(overrides: Partial<MasterQuery<TestItem>> = {}): MasterQuery<TestItem> {
  return { data: [ITEM], isError: false, refetch, ...overrides };
}

function toInput(draft: TestDraft): DraftResult<TestInput> {
  const name = draft.name.trim();

  return name === ''
    ? { kind: 'error', message: NAME_REQUIRED_MESSAGE }
    : { kind: 'ok', input: { name } };
}

function renderEditor(
  overrides: {
    query?: MasterQuery<TestItem>;
    isSubmitting?: boolean;
    isDeleting?: boolean;
    errorMessage?: string;
  } = {},
) {
  return render(
    <MasterEditor<TestItem, TestDraft, TestInput>
      entityLabel={ENTITY_LABEL}
      query={overrides.query ?? buildQuery()}
      toRow={(item) => ({
        id: item.id,
        title: item.name,
        subtitle: `ID ${item.id}`,
      })}
      emptyIcon={Tags}
      newDraft={NEW_DRAFT}
      toDraft={(item) => ({ name: item.name })}
      toInput={toInput}
      renderFields={(draft, onChange) => (
        <Input
          label="名前"
          value={draft.name}
          onChangeText={(name) => {
            onChange({ name });
          }}
          testID={`${TEST_ID}-field-name`}
        />
      )}
      onSubmit={onSubmit}
      onDelete={onDelete}
      isSubmitting={overrides.isSubmitting ?? false}
      isDeleting={overrides.isDeleting ?? false}
      errorMessage={overrides.errorMessage}
      testID={TEST_ID}
    />,
  );
}

beforeEach(() => {
  onSubmit.mockClear();
  onDelete.mockClear();
  refetch.mockClear();
});

describe('MasterEditor', () => {
  it('読み込み中は骨組みを出す', async () => {
    await renderEditor({ query: buildQuery({ data: undefined }) });

    expect(screen.getByTestId(`${TEST_ID}-loading`)).toBeTruthy();
  });

  it('取得に失敗したら再試行できる', async () => {
    await renderEditor({
      query: buildQuery({ isError: true, data: undefined }),
    });
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-error-retry-button`));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('取得済みでも失敗していればエラーを優先する', async () => {
    // 古い一覧を黙って見せると、消えたはずの行をもう一度消しに行くことになる
    await renderEditor({ query: buildQuery({ isError: true }) });

    expect(screen.getByTestId(`${TEST_ID}-error`)).toBeTruthy();
  });

  it('一覧の行に見出しと副題を出す', async () => {
    await renderEditor();

    expect(screen.getByText('居酒屋')).toBeTruthy();
    expect(screen.getByText('ID gen_01')).toBeTruthy();
  });

  it('0 件でも追加ボタンは残す', async () => {
    // ここが消えると、空の一覧から抜け出す手段が無くなる
    await renderEditor({ query: buildQuery({ data: [] }) });

    expect(screen.getByTestId(`${TEST_ID}-empty`)).toBeTruthy();
    expect(screen.getByTestId(`${TEST_ID}-add-button`)).toBeTruthy();
  });

  it('追加を押すと空の下書きでフォームが開く', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));

    expect(screen.getByTestId(`${TEST_ID}-field-name`).props.value).toBe('');
  });

  it('編集を押すと既存の値が入ったフォームが開く', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-row-gen_01-edit-button`));

    expect(screen.getByTestId(`${TEST_ID}-field-name`).props.value).toBe('居酒屋');
  });

  it('新規で保存すると itemId は null で渡る', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(onSubmit).toHaveBeenCalledWith(null, { name: 'ラーメン' }, expect.any(Function));
  });

  it('編集して保存すると itemId が渡る', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-row-gen_01-edit-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '大衆酒場');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(onSubmit).toHaveBeenCalledWith('gen_01', { name: '大衆酒場' }, expect.any(Function));
  });

  it('変換に失敗したら理由を出して送らない', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent(NAME_REQUIRED_MESSAGE);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('直して保存すると理由が消えて送る', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.queryByTestId(`${TEST_ID}-form-error`)).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('保存の第 3 引数を呼ぶとフォームが閉じる', async () => {
    // 書き込みが成功したときだけ閉じる。失敗して閉じると入力の打ち直しになる
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    const onSucceeded: unknown = onSubmit.mock.calls[0]?.[2];
    if (typeof onSucceeded !== 'function') {
      throw new Error('onSubmit の第 3 引数が関数でない');
    }
    await act(() => {
      onSucceeded();
    });

    expect(screen.queryByTestId(`${TEST_ID}-form`)).toBeNull();
  });

  it('保存が終わっていなければフォームは開いたまま', async () => {
    await renderEditor({ isSubmitting: true });
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form`)).toBeTruthy();
  });

  it('やめるを押すとフォームが閉じる', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-add-button`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-cancel-button`));

    expect(screen.queryByTestId(`${TEST_ID}-form`)).toBeNull();
  });

  it('削除ボタンを押しただけでは消さない', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-row-gen_01-delete-button`));

    expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('確認して初めて消す', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-row-gen_01-delete-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(onDelete).toHaveBeenCalledWith('gen_01');
    // 入力が無い操作なので、失敗しても押し直せる。確定した時点で閉じる
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('取消すと消さない', async () => {
    await renderEditor();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-row-gen_01-delete-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('書き込みに失敗した文言を出す', async () => {
    await renderEditor({
      errorMessage: '他の管理者が先に処理しました。画面を更新してください。',
    });

    expect(screen.getByTestId(`${TEST_ID}-write-error`)).toHaveTextContent(
      '他の管理者が先に処理しました。画面を更新してください。',
    );
  });
});
```

`act` は `@testing-library/react-native` から import する（`import { act, fireEvent, render, screen } from '@testing-library/react-native';`）。第 3 引数のコールバックは React の外から呼ぶので、囲わないと「更新が act に包まれていない」警告が出る。

`screen.getByTestId(...).props.value` で `TextInput` の値を読んでいるのは、`Input` が `value` をそのまま `TextInput` に渡しているため（実ファイルで確認済み）。`getByDisplayValue` でも引けるが、**空文字は `getByDisplayValue('')` で引けない**ので、新規のときと編集のときを同じ書き方で確かめられる `props.value` にそろえる。

- [ ] **Step 7: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/master-editor`
Expected: FAIL、`Cannot find module './master-editor' from 'src/features/admin/components/master-editor.test.tsx'`

- [ ] **Step 8: `MasterEditor` を実装する**

`apps/mobile/src/features/admin/components/master-editor.tsx`

```tsx
import type { LucideIcon } from 'lucide-react-native';
import { Pencil, Plus, Trash } from 'lucide-react-native';
import { type ReactElement, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { COLORS, SPACING } from '@/constants/theme';

import { toAdminErrorMessage } from '../api';
import type { DraftResult } from '../types';

/**
 * マスタ一覧が `useQuery` の戻り値から必要とする最小の形。
 * `AdminListQuery` のカーソル無し版。ジャンルもエリアも件数が少なく、
 * API 側もページを切っていない（Task 9-19 の `fetchGenres` / `fetchAreas` は `items` だけを返す）。
 */
export interface MasterQuery<TItem> {
  readonly data: readonly TItem[] | undefined;
  readonly isError: boolean;
  readonly refetch: () => void;
}

/** 一覧 1 行の見え方。どの列を出すかを画面ごとに決めさせず、3 つに畳む */
export interface MasterRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface MasterEditorProps<TItem, TDraft, TInput> {
  /** 「ジャンル」「エリア」。見出しと確認の文言はここから組み立てる */
  entityLabel: string;
  query: MasterQuery<TItem>;
  toRow: (item: TItem) => MasterRow;
  emptyIcon: LucideIcon;
  /** 「追加」を押したときの初期値 */
  newDraft: TDraft;
  toDraft: (item: TItem) => TDraft;
  /** 下書きを API の入力に変換する。通らない下書きは理由の文言になる */
  toInput: (draft: TDraft) => DraftResult<TInput>;
  renderFields: (draft: TDraft, onChange: (next: TDraft) => void) => ReactElement;
  /**
   * 保存。`itemId` が null なら新規。
   * 第 3 引数は**成功したときだけ**呼ぶ。呼ばれた時点でフォームを閉じる。
   * 失敗したときに閉じると、3〜4 個の入力を打ち直すことになる。
   */
  onSubmit: (itemId: string | null, input: TInput, onSucceeded: () => void) => void;
  /** 削除。確認を通ったときだけ呼ばれる */
  onDelete: (itemId: string) => void;
  isSubmitting: boolean;
  isDeleting: boolean;
  /** 書き込みが失敗したときだけ渡す */
  errorMessage?: string | undefined;
  testID: string;
}

interface EditingState<TDraft> {
  /** 新規は null */
  readonly itemId: string | null;
  readonly draft: TDraft;
}

/** 読み込み中の骨組み。マスタは 1 画面に収まる件数なので 3 行で足りる */
const SKELETON_ROW_KEYS = [1, 2, 3] as const;
const SKELETON_ROW_HEIGHT_PX = 72;

/** ScrollView の中身の余白。contentContainer は className を受けないので style で渡す */
const CONTENT_CONTAINER_STYLE = { gap: SPACING.md, padding: SPACING.md };

const ADD_LABEL_SUFFIX = 'を追加';
const EDIT_LABEL = '編集';
const DELETE_LABEL = '削除';
const SAVE_LABEL = '保存';
const CANCEL_LABEL = 'やめる';
const DELETE_CONFIRM_LABEL = '削除する';

/**
 * 並んだ mutation のうち、最初に失敗しているものの文言を返す。
 *
 * ジャンルもエリアも「追加 / 更新 / 削除」の 3 本を同時に持つので、
 * 3 つぶんの `isError` を画面に書き写さないためにここへ畳む。
 */
export function toWriteErrorMessage(
  mutations: readonly {
    readonly isError: boolean;
    readonly error: Error | null;
  }[],
): string | undefined {
  const failed = mutations.find((mutation) => mutation.isError);

  return failed === undefined ? undefined : toAdminErrorMessage(failed.error);
}

export function MasterEditor<TItem, TDraft, TInput>({
  entityLabel,
  query,
  toRow,
  emptyIcon,
  newDraft,
  toDraft,
  toInput,
  renderFields,
  onSubmit,
  onDelete,
  isSubmitting,
  isDeleting,
  errorMessage,
  testID,
}: MasterEditorProps<TItem, TDraft, TInput>) {
  const [editing, setEditing] = useState<EditingState<TDraft> | null>(null);
  const [formErrorMessage, setFormErrorMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 失敗を最優先で出す。取得済みの一覧が残っていても、
  // 「再取得に失敗した古い一覧」から削除を押すと、もう消えている行を消しに行く
  if (query.isError) {
    return (
      <ErrorState
        title={`${entityLabel}を取得できませんでした`}
        onRetry={query.refetch}
        testID={`${testID}-error`}
      />
    );
  }

  if (query.data === undefined) {
    return (
      <View style={CONTENT_CONTAINER_STYLE} testID={`${testID}-loading`}>
        {SKELETON_ROW_KEYS.map((rowKey) => (
          <Skeleton key={rowKey} height={SKELETON_ROW_HEIGHT_PX} />
        ))}
      </View>
    );
  }

  const items = query.data;

  function openEditor(next: EditingState<TDraft>) {
    setEditing(next);
    setFormErrorMessage(null);
  }

  function closeEditor() {
    setEditing(null);
    setFormErrorMessage(null);
  }

  function submit(current: EditingState<TDraft>) {
    const result = toInput(current.draft);

    if (result.kind === 'error') {
      setFormErrorMessage(result.message);
      return;
    }

    setFormErrorMessage(null);
    onSubmit(current.itemId, result.input, closeEditor);
  }

  /**
   * フォーム。`editing` を引数で受け取るのは、JSX の三項演算子の中で絞り込んだ型を
   * そのまま持ち回るため。中で `editing !== null` をもう一度書くと到達しない枝ができる。
   */
  function renderEditorForm(current: EditingState<TDraft>): ReactElement {
    return (
      <Card testID={`${testID}-form`}>
        <View className="gap-md">
          {renderFields(current.draft, (draft) => {
            setEditing({ itemId: current.itemId, draft });
          })}

          {formErrorMessage === null ? null : (
            <Text
              accessibilityRole="alert"
              className="font-body text-sm text-red-700"
              testID={`${testID}-form-error`}
            >
              {formErrorMessage}
            </Text>
          )}

          <View className="flex-row gap-sm">
            <View className="flex-1">
              <Button
                label={SAVE_LABEL}
                onPress={() => {
                  submit(current);
                }}
                isLoading={isSubmitting}
                testID={`${testID}-form-save-button`}
              />
            </View>
            <View className="flex-1">
              <Button
                label={CANCEL_LABEL}
                variant="outline"
                onPress={closeEditor}
                testID={`${testID}-form-cancel-button`}
              />
            </View>
          </View>
        </View>
      </Card>
    );
  }

  function renderDeleteDialog(itemId: string): ReactElement {
    return (
      <ConfirmDialog
        isVisible
        title={`この${entityLabel}を削除しますか？`}
        message={`この${entityLabel}を参照している店舗があると失敗します。削除した場合、元に戻すには作り直しが必要です。`}
        confirmLabel={DELETE_CONFIRM_LABEL}
        isDestructive
        isLoading={isDeleting}
        onConfirm={() => {
          // 先に閉じてから走らせる（Task 9-23 の ActionPanel と同じ理由）。
          // 削除は入力を持たないので、失敗しても押し直すだけで済む
          setDeletingId(null);
          onDelete(itemId);
        }}
        onCancel={() => {
          setDeletingId(null);
        }}
      />
    );
  }

  return (
    <ScrollView testID={testID} contentContainerStyle={CONTENT_CONTAINER_STYLE}>
      <Button
        label={`${entityLabel}${ADD_LABEL_SUFFIX}`}
        leadingIcon={<Icon icon={Plus} size="sm" color={COLORS.white} />}
        onPress={() => {
          openEditor({ itemId: null, draft: newDraft });
        }}
        testID={`${testID}-add-button`}
      />

      {editing === null ? null : renderEditorForm(editing)}

      {errorMessage === undefined ? null : (
        <Text
          accessibilityRole="alert"
          className="font-body text-sm text-red-700"
          testID={`${testID}-write-error`}
        >
          {errorMessage}
        </Text>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={emptyIcon}
          title={`${entityLabel}がまだありません`}
          description={`上の「${entityLabel}${ADD_LABEL_SUFFIX}」から登録できます。`}
          testID={`${testID}-empty`}
        />
      ) : (
        items.map((item) => {
          const row = toRow(item);

          return (
            <Card key={row.id} testID={`${testID}-row-${row.id}`}>
              <View className="flex-row items-center gap-sm">
                <View className="flex-1 gap-xs">
                  <Text className="font-body-medium text-base text-neutral-900" numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text className="font-body text-sm text-neutral-600">{row.subtitle}</Text>
                </View>
                <Button
                  label={EDIT_LABEL}
                  variant="outline"
                  size="sm"
                  leadingIcon={<Icon icon={Pencil} size="sm" />}
                  onPress={() => {
                    openEditor({ itemId: row.id, draft: toDraft(item) });
                  }}
                  testID={`${testID}-row-${row.id}-edit-button`}
                />
                <Button
                  label={DELETE_LABEL}
                  variant="danger"
                  size="sm"
                  leadingIcon={<Icon icon={Trash} size="sm" color={COLORS.white} />}
                  onPress={() => {
                    setDeletingId(row.id);
                  }}
                  testID={`${testID}-row-${row.id}-delete-button`}
                />
              </View>
            </Card>
          );
        })
      )}

      {deletingId === null ? null : renderDeleteDialog(deletingId)}
    </ScrollView>
  );
}
```

`Trash2` ではなく `Trash` を使っている。Task 9-22 Step 19 の注記どおり、`Trash2` は `trash.js` の別名で `declare const` として輸出されていない（`node_modules/lucide-react-native/dist/types/icons.d.ts` を 2026-09-16 に実測。`Trash` / `Pencil` / `Plus` / `Tags` / `MapPin` / `Megaphone` / `ScrollText` / `Undo2` / `ListFilter` / `Inbox` は輸出あり、`Trash2` / `Filter` / `History` は無し）。

- [ ] **Step 9: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/components/master-editor && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**18 件**。Step 6 で書いた `describe('MasterEditor')` の `it` がちょうど 18 本。内訳は 取得の状態 3 + 一覧の見え方 2 + フォームを開く 2 + 保存 6 + やめる 1 + 削除 3 + 書き込み失敗 1）

わざと壊す。

1. `submit` の `if (result.kind === 'error')` の中の `return;` を消す → 「変換に失敗したら理由を出して送らない」が落ちる（`result.input` が無いので `tsc` も落ちる）。**型で先に止まる**ことを確認する。
2. 戻してから `onSubmit(current.itemId, result.input, closeEditor)` を `onSubmit(current.itemId, result.input, () => undefined)` にする → 「保存の第 3 引数を呼ぶとフォームが閉じる」が落ちる。
3. 戻してから `submit` の中で `closeEditor()` を呼んでから `onSubmit` する → 「保存が終わっていなければフォームは開いたまま」が落ちる。**失敗したときに入力が消える設計になっていない**ことの確認。
4. 戻してから削除ボタンの `onPress` を `() => { onDelete(row.id); }` にする → 「削除ボタンを押しただけでは消さない」が落ちる。確認を挟んでいることの確認。
5. 戻してから `items.length === 0` の枝から `EmptyState` だけを返し、追加ボタンを `items.length > 0` のときだけ出すようにする → 「0 件でも追加ボタンは残す」が落ちる。

5 つとも確認したら戻す。

- [ ] **Step 10: ジャンル画面の失敗するテストを書く**

`apps/mobile/src/features/admin/screens/genres-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { createGenre, deleteGenre, fetchGenres, updateGenre } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminGenre } from '../types';
import { GenresScreen } from './genres-screen';

jest.mock('../api');

const fetchGenresMock = jest.mocked(fetchGenres);
const createGenreMock = jest.mocked(createGenre);
const updateGenreMock = jest.mocked(updateGenre);
const deleteGenreMock = jest.mocked(deleteGenre);

const GENRE: AdminGenre = {
  id: 'gen_01',
  name: '居酒屋',
  slug: 'izakaya',
  iconKey: 'beer',
  sortOrder: 10,
};

const TEST_ID = 'admin-genres';

beforeEach(() => {
  fetchGenresMock.mockReset();
  createGenreMock.mockReset();
  updateGenreMock.mockReset();
  deleteGenreMock.mockReset();
  fetchGenresMock.mockResolvedValue([GENRE]);
  createGenreMock.mockResolvedValue({ genreId: 'gen_02', result: 'ok' });
  updateGenreMock.mockResolvedValue({ genreId: 'gen_01', result: 'ok' });
  deleteGenreMock.mockResolvedValue({ genreId: 'gen_01', result: 'ok' });
});

describe('GenresScreen', () => {
  it('名前とスラッグ・並び順を出す', async () => {
    await renderWithQuery(<GenresScreen />);

    expect(await screen.findByText('居酒屋')).toBeTruthy();
    expect(screen.getByText('izakaya・並び順 10')).toBeTruthy();
  });

  it('追加して保存すると createGenre を呼ぶ', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-sort-order`), '20');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(createGenreMock).toHaveBeenCalledWith({
      name: 'ラーメン',
      slug: 'ramen',
      // アイコンキーは任意。空欄は null で送る（空文字の行を作らない）
      iconKey: null,
      sortOrder: 20,
    });
  });

  it('保存に成功したらフォームが閉じる', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(await screen.findByTestId(`${TEST_ID}-add-button`)).toBeTruthy();
    expect(screen.queryByTestId(`${TEST_ID}-form`)).toBeNull();
  });

  it('編集して保存すると updateGenre を ID つきで呼ぶ', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-gen_01-edit-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '大衆酒場');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(updateGenreMock).toHaveBeenCalledWith('gen_01', {
      name: '大衆酒場',
      slug: 'izakaya',
      iconKey: 'beer',
      sortOrder: 10,
    });
  });

  it('並び順が整数でないと送らずに理由を出す', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-sort-order`), '1.5');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent(
      '並び順は整数で入力してください',
    );
    expect(createGenreMock).not.toHaveBeenCalled();
  });

  it('並び順が空でも送らない', async () => {
    // Number('') は 0 なので、空文字を弾き忘れると 0 が登録される
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-sort-order`), '');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(createGenreMock).not.toHaveBeenCalled();
  });

  it('名前が空でも送らない', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent('名前を入力してください');
    expect(createGenreMock).not.toHaveBeenCalled();
  });

  it('スラッグが空でも送らない', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent(
      'スラッグを入力してください',
    );
    expect(createGenreMock).not.toHaveBeenCalled();
  });

  it('確認してから deleteGenre を呼ぶ', async () => {
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-gen_01-delete-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(deleteGenreMock).toHaveBeenCalledWith('gen_01');
  });

  it('書き込みに失敗したら文言を出す', async () => {
    createGenreMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<GenresScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), 'ラーメン');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-slug`), 'ramen');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(await screen.findByTestId(`${TEST_ID}-write-error`)).toBeTruthy();
    // 失敗したのだから入力は残す
    expect(screen.getByTestId(`${TEST_ID}-form`)).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchGenresMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<GenresScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-error`)).toBeTruthy();
  });
});
```

- [ ] **Step 11: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/genres-screen`
Expected: FAIL、`Cannot find module './genres-screen'`

- [ ] **Step 12: ジャンル画面を実装する**

`apps/mobile/src/features/admin/screens/genres-screen.tsx`

```tsx
import { Tags } from 'lucide-react-native';
import { View } from 'react-native';

import { Input } from '@/components/ui/input';

import type { GenreInput } from '../api';
import { MasterEditor, toWriteErrorMessage } from '../components/master-editor';
import { toNullableText } from '../format';
import { useCreateGenre, useDeleteGenre, useGenres, useUpdateGenre } from '../queries';
import type { AdminGenre, DraftResult } from '../types';

const TEST_ID = 'admin-genres';
const ENTITY_LABEL = 'ジャンル';

const NAME_REQUIRED_MESSAGE = '名前を入力してください';
const SLUG_REQUIRED_MESSAGE = 'スラッグを入力してください';
const SORT_ORDER_MESSAGE = '並び順は整数で入力してください';

/** 追加を開いたときの初期値。並び順は末尾に置きたくなるので大きめの既定にしない */
const NEW_SORT_ORDER_TEXT = '0';

/** 入力欄の下書き。並び順は文字で持つ（Input は数値を受け取れない） */
interface GenreDraft {
  readonly name: string;
  readonly slug: string;
  readonly iconKey: string;
  readonly sortOrderText: string;
}

const NEW_GENRE_DRAFT: GenreDraft = {
  name: '',
  slug: '',
  iconKey: '',
  sortOrderText: NEW_SORT_ORDER_TEXT,
};

function toGenreDraft(genre: AdminGenre): GenreDraft {
  return {
    name: genre.name,
    slug: genre.slug,
    iconKey: genre.iconKey ?? '',
    sortOrderText: String(genre.sortOrder),
  };
}

/**
 * 並び順の文字を整数にする。整数でなければ null。
 *
 * `Number('')` と `Number('  ')` はどちらも 0 なので、空欄を先に弾く。
 * 弾き忘れると「並び順を消して保存」が「並び順 0 で保存」になる。
 */
function toSortOrder(text: string): number | null {
  const trimmed = text.trim();

  if (trimmed === '') {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * 下書きを API の入力にする。
 *
 * **綴りの規則（半角英小文字とハイフンだけ、など）はここで見ない。**
 * サーバが 422 で返すので（Task 9-4 のスキーマ）、画面の検査は
 * 「送っても必ず落ちるもの」＝空欄と数値でない並び順だけに絞る。
 * 二重に持つと、サーバの規則が変わったときに画面だけ古い規則で弾き続ける。
 */
function toGenreInput(draft: GenreDraft): DraftResult<GenreInput> {
  const name = draft.name.trim();

  if (name === '') {
    return { kind: 'error', message: NAME_REQUIRED_MESSAGE };
  }

  const slug = draft.slug.trim();

  if (slug === '') {
    return { kind: 'error', message: SLUG_REQUIRED_MESSAGE };
  }

  const sortOrder = toSortOrder(draft.sortOrderText);

  if (sortOrder === null) {
    return { kind: 'error', message: SORT_ORDER_MESSAGE };
  }

  return {
    kind: 'ok',
    input: { name, slug, iconKey: toNullableText(draft.iconKey), sortOrder },
  };
}

export function GenresScreen() {
  const query = useGenres();
  const createGenre = useCreateGenre();
  const updateGenre = useUpdateGenre();
  const deleteGenre = useDeleteGenre();

  return (
    <MasterEditor<AdminGenre, GenreDraft, GenreInput>
      entityLabel={ENTITY_LABEL}
      query={query}
      toRow={(genre) => ({
        id: genre.id,
        title: genre.name,
        // Text の子を分割すると getByText で引けなくなるので 1 本の文字列にする（Task 9-22 と同じ）
        subtitle: `${genre.slug}・並び順 ${genre.sortOrder}`,
      })}
      emptyIcon={Tags}
      newDraft={NEW_GENRE_DRAFT}
      toDraft={toGenreDraft}
      toInput={toGenreInput}
      renderFields={(draft, onChange) => (
        <View className="gap-md">
          <Input
            label="名前"
            isRequired
            value={draft.name}
            onChangeText={(name) => {
              onChange({ ...draft, name });
            }}
            testID={`${TEST_ID}-field-name`}
          />
          <Input
            label="スラッグ"
            isRequired
            placeholder="izakaya"
            value={draft.slug}
            onChangeText={(slug) => {
              onChange({ ...draft, slug });
            }}
            testID={`${TEST_ID}-field-slug`}
          />
          <Input
            label="アイコンキー"
            placeholder="指定しない場合は空のまま"
            value={draft.iconKey}
            onChangeText={(iconKey) => {
              onChange({ ...draft, iconKey });
            }}
            testID={`${TEST_ID}-field-icon-key`}
          />
          {/*
            Input は keyboardType を受け取らない（実ファイルで確認）。数値キーボードを出すには
            Task 9-18 と同じ手順で prop を足すことになるので Phase 9 ではやらない。
            文字で受けて toSortOrder で弾く。
          */}
          <Input
            label="並び順"
            isRequired
            value={draft.sortOrderText}
            onChangeText={(sortOrderText) => {
              onChange({ ...draft, sortOrderText });
            }}
            testID={`${TEST_ID}-field-sort-order`}
          />
        </View>
      )}
      onSubmit={(genreId, input, onSucceeded) => {
        if (genreId === null) {
          createGenre.mutate({ input }, { onSuccess: onSucceeded });
          return;
        }
        updateGenre.mutate({ genreId, input }, { onSuccess: onSucceeded });
      }}
      onDelete={(genreId) => {
        deleteGenre.mutate({ genreId });
      }}
      isSubmitting={createGenre.isPending || updateGenre.isPending}
      isDeleting={deleteGenre.isPending}
      errorMessage={toWriteErrorMessage([createGenre, updateGenre, deleteGenre])}
      testID={TEST_ID}
    />
  );
}
```

- [ ] **Step 13: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/genres-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（11 件）

わざと壊す。

1. `toSortOrder` の `if (trimmed === '')` を消す → 「並び順が空でも送らない」が落ちる（`Number('')` が 0 で通ってしまう）。
2. 戻してから `Number.isInteger(parsed)` を `!Number.isNaN(parsed)` にする → 「並び順が整数でないと送らずに理由を出す」が落ちる（1.5 が通る）。
3. 戻してから `iconKey: toNullableText(draft.iconKey)` を `iconKey: draft.iconKey` にする → **`tsc` が落ちる**（`GenreInput.iconKey` は `string | null` なので `string` は入るが、テストの `iconKey: null` が `''` になり「追加して保存すると createGenre を呼ぶ」が落ちる）。型では止まらないことも合わせて確認する。
4. 戻してから `onSubmit` の `if (genreId === null)` の中の `return;` を消す → 新規のときに `createGenre` と `updateGenre` の両方が走り、「編集して保存すると updateGenre を ID つきで呼ぶ」は通るが「追加して保存すると…」が `updateGenre(null, ...)` の型不一致で `tsc` が落ちる。
5. 戻してから `onSuccess: onSucceeded` を消す → 「保存に成功したらフォームが閉じる」が落ちる。

5 つとも確認したら戻す。

- [ ] **Step 14: エリア画面の失敗するテストを書く**

`apps/mobile/src/features/admin/screens/areas-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { createArea, deleteArea, fetchAreas, updateArea } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AdminArea } from '../types';
import { AreasScreen } from './areas-screen';

jest.mock('../api');

const fetchAreasMock = jest.mocked(fetchAreas);
const createAreaMock = jest.mocked(createArea);
const updateAreaMock = jest.mocked(updateArea);
const deleteAreaMock = jest.mocked(deleteArea);

const PARENT_AREA: AdminArea = {
  id: 'are_01',
  name: '東京都',
  parentId: null,
  prefecture: '東京都',
};

const CHILD_AREA: AdminArea = {
  id: 'are_02',
  name: '渋谷区',
  parentId: 'are_01',
  prefecture: '東京都',
};

const TEST_ID = 'admin-areas';

beforeEach(() => {
  fetchAreasMock.mockReset();
  createAreaMock.mockReset();
  updateAreaMock.mockReset();
  deleteAreaMock.mockReset();
  fetchAreasMock.mockResolvedValue([PARENT_AREA, CHILD_AREA]);
  createAreaMock.mockResolvedValue({ areaId: 'are_03', result: 'ok' });
  updateAreaMock.mockResolvedValue({ areaId: 'are_02', result: 'ok' });
  deleteAreaMock.mockResolvedValue({ areaId: 'are_02', result: 'ok' });
});

describe('AreasScreen', () => {
  it('都道府県と親エリアを副題に出す', async () => {
    await renderWithQuery(<AreasScreen />);

    expect(await screen.findByText('渋谷区')).toBeTruthy();
    expect(screen.getByText('東京都・親 東京都')).toBeTruthy();
  });

  it('親が無いエリアは「親なし」と出す', async () => {
    await renderWithQuery(<AreasScreen />);

    expect(await screen.findByText('東京都・親 （なし）')).toBeTruthy();
  });

  it('追加して保存すると parentId が null で渡る', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '新宿区');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-prefecture`), '東京都');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(createAreaMock).toHaveBeenCalledWith({
      name: '新宿区',
      parentId: null,
      prefecture: '東京都',
    });
  });

  it('親エリアを選ぶと ID で渡る', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '新宿区');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-prefecture`), '東京都');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-field-parent-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-field-parent-option-id:are_01`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(createAreaMock).toHaveBeenCalledWith({
      name: '新宿区',
      parentId: 'are_01',
      prefecture: '東京都',
    });
  });

  it('選んだ親を「（親なし）」に戻せる', async () => {
    // 選択肢に戻す先が無いと、一度付けた親を外せなくなる
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-are_02-edit-button`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-field-parent-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-field-parent-option-none`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(updateAreaMock).toHaveBeenCalledWith('are_02', {
      name: '渋谷区',
      parentId: null,
      prefecture: '東京都',
    });
  });

  it('編集して保存すると updateArea を ID つきで呼ぶ', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-are_02-edit-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '渋谷');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(updateAreaMock).toHaveBeenCalledWith('are_02', {
      name: '渋谷',
      parentId: 'are_01',
      prefecture: '東京都',
    });
  });

  it('名前が空でも送らない', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-prefecture`), '東京都');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent('名前を入力してください');
    expect(createAreaMock).not.toHaveBeenCalled();
  });

  it('都道府県が空でも送らない', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-add-button`));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-field-name`), '新宿区');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-form-save-button`));

    expect(screen.getByTestId(`${TEST_ID}-form-error`)).toHaveTextContent(
      '都道府県を入力してください',
    );
    expect(createAreaMock).not.toHaveBeenCalled();
  });

  it('確認してから deleteArea を呼ぶ', async () => {
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-are_02-delete-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(deleteAreaMock).toHaveBeenCalledWith('are_02');
  });

  it('書き込みに失敗したら文言を出す', async () => {
    deleteAreaMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AreasScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-are_02-delete-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId(`${TEST_ID}-write-error`)).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchAreasMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AreasScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-error`)).toBeTruthy();
  });
});
```

- [ ] **Step 15: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/areas-screen`
Expected: FAIL、`Cannot find module './areas-screen'`

- [ ] **Step 16: エリア画面を実装する**

`apps/mobile/src/features/admin/screens/areas-screen.tsx`

```tsx
import { MapPin } from 'lucide-react-native';
import { View } from 'react-native';

import { Input } from '@/components/ui/input';
import { SelectField, type SelectOption } from '@/components/ui/select-field';

import type { AreaInput } from '../api';
import { MasterEditor, toWriteErrorMessage } from '../components/master-editor';
import { EMPTY_VALUE_LABEL } from '../format';
import { useAreas, useCreateArea, useDeleteArea, useUpdateArea } from '../queries';
import type { AdminArea, DraftResult } from '../types';

const TEST_ID = 'admin-areas';
const ENTITY_LABEL = 'エリア';

const NAME_REQUIRED_MESSAGE = '名前を入力してください';
const PREFECTURE_REQUIRED_MESSAGE = '都道府県を入力してください';

/**
 * 「親なし」を表す選択肢の値。
 *
 * エリア ID と衝突させないため、**実エリアの側に接頭辞を付ける**。
 * `'none'` という ID のエリアが作られても `id:none` になるので、
 * サーバの ID がどう採番されるかを知らなくても取り違えが起きない。
 */
const NO_PARENT_VALUE = 'none';
const NO_PARENT_LABEL = '（親なし）';
const PARENT_ID_PREFIX = 'id:';

function toParentOptionValue(areaId: string): string {
  return `${PARENT_ID_PREFIX}${areaId}`;
}

function toParentId(optionValue: string): string | null {
  return optionValue.startsWith(PARENT_ID_PREFIX)
    ? optionValue.slice(PARENT_ID_PREFIX.length)
    : null;
}

interface AreaDraft {
  readonly name: string;
  readonly parentOptionValue: string;
  readonly prefecture: string;
}

const NEW_AREA_DRAFT: AreaDraft = {
  name: '',
  parentOptionValue: NO_PARENT_VALUE,
  prefecture: '',
};

function toAreaDraft(area: AdminArea): AreaDraft {
  return {
    name: area.name,
    parentOptionValue:
      area.parentId === null ? NO_PARENT_VALUE : toParentOptionValue(area.parentId),
    prefecture: area.prefecture,
  };
}

function toAreaInput(draft: AreaDraft): DraftResult<AreaInput> {
  const name = draft.name.trim();

  if (name === '') {
    return { kind: 'error', message: NAME_REQUIRED_MESSAGE };
  }

  const prefecture = draft.prefecture.trim();

  if (prefecture === '') {
    return { kind: 'error', message: PREFECTURE_REQUIRED_MESSAGE };
  }

  return {
    kind: 'ok',
    input: { name, parentId: toParentId(draft.parentOptionValue), prefecture },
  };
}

export function AreasScreen() {
  const query = useAreas();
  const createArea = useCreateArea();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();

  const areas = query.data ?? [];
  const areaNameById = new Map(areas.map((area) => [area.id, area.name]));

  /**
   * 親エリアの選択肢。先頭に「（親なし）」を置く。
   *
   * **編集中のエリア自身を外していない。**外すには編集中の ID を renderFields へ渡す
   * 引数が要り、部品の props が 1 つ増える。自分を親にする更新は **Task 9-9 の
   * `updateArea` が `input.parentId === areaId` で弾き**、`ADMIN_WRITE_OUTCOME.conflict`
   * を返す（ルート層が 409 に写す）。テストも Task 9-9 に「自分自身を親にはできない」がある。
   * だから画面側で選択肢を削る必要は無い。409 の文言は `toAdminErrorMessage` の汎用文
   * （「他の管理者が先に処理しました。」）になり実態とずれるが、これは引き継ぎの宿題 2 と同じ論点。
   *
   * **A を B の親にしてから B を A の親にする 2 段の循環は誰も弾いていない。**
   * `listAreas` は `parentId === null` を「区」として扱うだけなので表示は壊れないが、
   * Step 36 で実装を開いて「1 段しか見ていない」ことを確かめ、コミットメッセージに残す。
   */
  const parentOptions: SelectOption<string>[] = [
    { value: NO_PARENT_VALUE, label: NO_PARENT_LABEL },
    ...areas.map((area) => ({
      value: toParentOptionValue(area.id),
      label: area.name,
    })),
  ];

  return (
    <MasterEditor<AdminArea, AreaDraft, AreaInput>
      entityLabel={ENTITY_LABEL}
      query={query}
      toRow={(area) => ({
        id: area.id,
        title: area.name,
        subtitle: `${area.prefecture}・親 ${
          area.parentId === null
            ? EMPTY_VALUE_LABEL
            : (areaNameById.get(area.parentId) ?? EMPTY_VALUE_LABEL)
        }`,
      })}
      emptyIcon={MapPin}
      newDraft={NEW_AREA_DRAFT}
      toDraft={toAreaDraft}
      toInput={toAreaInput}
      renderFields={(draft, onChange) => (
        <View className="gap-md">
          <Input
            label="名前"
            isRequired
            value={draft.name}
            onChangeText={(name) => {
              onChange({ ...draft, name });
            }}
            testID={`${TEST_ID}-field-name`}
          />
          {/*
            都道府県は自由入力。47 個の定数表を画面に持つと、サーバの語彙
            （Task 9-19 の areaSchema は prefecture: z.string()）と二重管理になる
          */}
          <Input
            label="都道府県"
            isRequired
            placeholder="東京都"
            value={draft.prefecture}
            onChangeText={(prefecture) => {
              onChange({ ...draft, prefecture });
            }}
            testID={`${TEST_ID}-field-prefecture`}
          />
          <SelectField
            label="親エリア"
            value={draft.parentOptionValue}
            options={parentOptions}
            onChange={(parentOptionValue) => {
              onChange({ ...draft, parentOptionValue });
            }}
            testID={`${TEST_ID}-field-parent`}
          />
        </View>
      )}
      onSubmit={(areaId, input, onSucceeded) => {
        if (areaId === null) {
          createArea.mutate({ input }, { onSuccess: onSucceeded });
          return;
        }
        updateArea.mutate({ areaId, input }, { onSuccess: onSucceeded });
      }}
      onDelete={(areaId) => {
        deleteArea.mutate({ areaId });
      }}
      isSubmitting={createArea.isPending || updateArea.isPending}
      isDeleting={deleteArea.isPending}
      errorMessage={toWriteErrorMessage([createArea, updateArea, deleteArea])}
      testID={TEST_ID}
    />
  );
}
```

`areaNameById.get(...)` に `?? EMPTY_VALUE_LABEL` が付いているのは `noUncheckedIndexedAccess` ではなく `Map.get` の戻りが `string | undefined` だから。親 ID が一覧に無い（削除済み・別ページ）場合に `undefined` と出さないための枝で、テストからも届く（`fetchAreas` が子だけを返す場合）。**この枝に到達するテストが無いとカバレッジが落ちる**ので、Step 17 で落ちたら「親が一覧に無いときも（なし）と出す」を足す。

- [ ] **Step 17: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/areas-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（11 件）

わざと壊す。

1. `toParentOptionValue` を `(areaId) => areaId` にし、`toParentId` を `(value) => (value === NO_PARENT_VALUE ? null : value)` にする → テストは通ってしまう。そのうえで `fetchAreasMock` に `{ id: 'none', ... }` のエリアを足すと「親エリアを選ぶと ID で渡る」が壊れることを確かめる。**接頭辞が何を守っているかの実地確認。**確認したら戻し、足したデータも消す。
2. `parentOptions` の先頭要素を消す → 「選んだ親を「（親なし）」に戻せる」が落ちる。
3. 戻してから `toAreaInput` の `prefecture` の検査を消す → 「都道府県が空でも送らない」が落ちる。
4. 戻してから `subtitle` を `${area.prefecture}・親 ${area.parentId}` にする → 「都道府県と親エリアを副題に出す」と「親が無いエリアは「親なし」と出す」の 2 つが落ちる（ID がそのまま出る）。
5. 戻してから `deleteArea.mutate({ areaId })` を `deleteArea.mutate({ areaId: '' })` にする → 「確認してから deleteArea を呼ぶ」が落ちる。

5 つとも確認したら戻す。

- [ ] **Step 18: お知らせ画面の失敗するテストを書く**

`apps/mobile/src/features/admin/screens/announcements-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchAnnouncementHistory, sendAnnouncement } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AnnouncementHistoryItem } from '../types';
import { AnnouncementsScreen } from './announcements-screen';

jest.mock('../api');

const fetchAnnouncementHistoryMock = jest.mocked(fetchAnnouncementHistory);
const sendAnnouncementMock = jest.mocked(sendAnnouncement);

const HISTORY_ITEM: AnnouncementHistoryItem = {
  announcementId: 'ann_01',
  title: 'メンテナンスのお知らせ',
  audience: 'all',
  recipientCount: 120,
  sentBy: 'usr_admin',
  // epoch 定数で書くと機械の TZ で結果が変わる（Task 9-21 の formatDateTime のテストと同じ理由）
  sentAtMs: new Date(2026, 8, 15, 12, 0).getTime(),
};

const TEST_ID = 'admin-announcements';
const FORM_TEST_ID = `${TEST_ID}-form`;

async function fillTitleAndBody(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId(`${FORM_TEST_ID}-title`), '臨時メンテナンス');
  await fireEvent.changeText(screen.getByTestId(`${FORM_TEST_ID}-body`), '23 時から停止します');
}

beforeEach(() => {
  fetchAnnouncementHistoryMock.mockReset();
  sendAnnouncementMock.mockReset();
  fetchAnnouncementHistoryMock.mockResolvedValue({
    items: [HISTORY_ITEM],
    nextCursor: null,
  });
  sendAnnouncementMock.mockResolvedValue({
    announcementId: 'ann_02',
    result: 'ok',
    recipientCount: 3,
  });
});

describe('AnnouncementsScreen', () => {
  it('配信履歴を出す', async () => {
    await renderWithQuery(<AnnouncementsScreen />);

    expect(await screen.findByText('メンテナンスのお知らせ')).toBeTruthy();
    expect(screen.getByText('all・120 人・2026/09/15 12:00')).toBeTruthy();
  });

  it('既定の宛先は個別指定にする', async () => {
    // 既定を「全員」にすると、押し間違いの被害が最大になる
    await renderWithQuery(<AnnouncementsScreen />);

    expect(
      screen.getByTestId(`${FORM_TEST_ID}-audience-segment-users`).props.accessibilityState
        .selected,
    ).toBe(true);
  });

  it('全員あてに送ると kind: all で渡る', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-all`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(sendAnnouncementMock).toHaveBeenCalledWith({
      title: '臨時メンテナンス',
      body: '23 時から停止します',
      audience: { kind: 'all' },
    });
  });

  it('確認に宛先を出す', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-all`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));

    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('全員に配信します');
  });

  it('確認を取り消すと送らない', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-all`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));

    expect(sendAnnouncementMock).not.toHaveBeenCalled();
  });

  it('ロール指定でロールを選ぶと kind: role で渡る', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-role`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-role-trigger`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-role-option-owner`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(sendAnnouncementMock).toHaveBeenCalledWith({
      title: '臨時メンテナンス',
      body: '23 時から停止します',
      audience: { kind: 'role', role: 'owner' },
    });
  });

  it('ロール指定でロールを選ばないと送らない', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-role`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));

    expect(screen.getByTestId(`${FORM_TEST_ID}-error`)).toHaveTextContent('ロールを選んでください');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('個別指定は空白と読点で ID を分ける', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.changeText(
      screen.getByTestId(`${FORM_TEST_ID}-user-ids`),
      'usr_01 usr_02、usr_03,usr_04\nusr_05',
    );
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(sendAnnouncementMock).toHaveBeenCalledWith({
      title: '臨時メンテナンス',
      body: '23 時から停止します',
      audience: {
        kind: 'users',
        userIds: ['usr_01', 'usr_02', 'usr_03', 'usr_04', 'usr_05'],
      },
    });
  });

  it('個別指定で ID が 1 件も無いと送らない', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.changeText(screen.getByTestId(`${FORM_TEST_ID}-user-ids`), '  、 ');
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));

    expect(screen.getByTestId(`${FORM_TEST_ID}-error`)).toHaveTextContent(
      '宛先のユーザー ID を入力してください',
    );
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('件名が空だと送らない', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fireEvent.changeText(screen.getByTestId(`${FORM_TEST_ID}-body`), '本文');
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));

    expect(screen.getByTestId(`${FORM_TEST_ID}-error`)).toHaveTextContent('件名を入力してください');
  });

  it('本文が空だと送らない', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fireEvent.changeText(screen.getByTestId(`${FORM_TEST_ID}-title`), '件名');
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));

    expect(screen.getByTestId(`${FORM_TEST_ID}-error`)).toHaveTextContent('本文を入力してください');
  });

  it('送信に成功したら入力を空に戻す', async () => {
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-all`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId(`${FORM_TEST_ID}-title`)).toHaveProp('value', '');
    expect(screen.getByTestId(`${FORM_TEST_ID}-body`)).toHaveProp('value', '');
  });

  it('送信に失敗したら文言を出し、入力は残す', async () => {
    sendAnnouncementMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AnnouncementsScreen />);
    await fillTitleAndBody();
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-audience-segment-all`));
    await fireEvent.press(screen.getByTestId(`${FORM_TEST_ID}-send-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId(`${FORM_TEST_ID}-write-error`)).toBeTruthy();
    expect(screen.getByTestId(`${FORM_TEST_ID}-title`)).toHaveProp('value', '臨時メンテナンス');
  });

  it('履歴が空でもフォームは出す', async () => {
    fetchAnnouncementHistoryMock.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    await renderWithQuery(<AnnouncementsScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-empty`)).toBeTruthy();
    expect(screen.getByTestId(`${FORM_TEST_ID}-send-button`)).toBeTruthy();
  });

  it('履歴の取得に失敗したらエラーを出す', async () => {
    fetchAnnouncementHistoryMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AnnouncementsScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-error`)).toBeTruthy();
  });
});
```

`toHaveProp` は `@testing-library/jest-native` ではなく RNTL 14 に同梱の matcher（Task 9-22 で `toHaveTextContent` とともに使っている）。使えなければ `screen.getByTestId(...).props.value` に書き換える。**どちらが入っているかは Step 19 の FAIL 出力で分かる**ので、そこで確定させる。

- [ ] **Step 19: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/announcements-screen`
Expected: FAIL、`Cannot find module './announcements-screen'`

- [ ] **Step 20: お知らせ画面を実装する**

`apps/mobile/src/features/admin/screens/announcements-screen.tsx`

```tsx
import { ROLES, type Role } from '@meshimap/core';
import { Megaphone, Send } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectField } from '@/components/ui/select-field';

import type { AnnouncementInput } from '../api';
import { AdminListScreen } from '../components/admin-list-screen';
import { toWriteErrorMessage } from '../components/master-editor';
import { formatDateTime } from '../format';
import { ROLE_LABELS, toSelectOptions } from '../labels';
import { useAnnouncementHistory, useSendAnnouncement } from '../queries';
import type { AnnouncementAudience, AnnouncementHistoryItem, DraftResult } from '../types';

const TEST_ID = 'admin-announcements';
const FORM_TEST_ID = `${TEST_ID}-form`;

const TITLE_REQUIRED_MESSAGE = '件名を入力してください';
const BODY_REQUIRED_MESSAGE = '本文を入力してください';
const ROLE_REQUIRED_MESSAGE = 'ロールを選んでください';
const USER_IDS_REQUIRED_MESSAGE = '宛先のユーザー ID を入力してください';

type AudienceKind = AnnouncementAudience['kind'];

/**
 * 宛先の並び。**狭いものから並べ、先頭を既定にする。**
 * 既定が「全員」だと、件名だけ入れて送ったときの被害が最大になる。
 */
const AUDIENCE_KINDS = ['users', 'role', 'all'] as const satisfies readonly AudienceKind[];

const AUDIENCE_KIND_LABELS: Record<AudienceKind, string> = {
  users: '個別指定',
  role: 'ロール指定',
  all: '全員',
};

const AUDIENCE_OPTIONS = toSelectOptions(AUDIENCE_KINDS, AUDIENCE_KIND_LABELS);
const ROLE_OPTIONS = toSelectOptions(ROLES, ROLE_LABELS);

/** ユーザー ID の区切り。空白・改行・半角読点・全角読点のどれで貼られても分ける */
const USER_ID_SEPARATOR_PATTERN = /[\s,、]+/;

interface AnnouncementDraft {
  readonly title: string;
  readonly body: string;
  readonly audienceKind: AudienceKind;
  readonly role: Role | null;
  readonly userIdsText: string;
}

const NEW_ANNOUNCEMENT_DRAFT: AnnouncementDraft = {
  title: '',
  body: '',
  audienceKind: 'users',
  role: null,
  userIdsText: '',
};

function toUserIds(text: string): string[] {
  return text.split(USER_ID_SEPARATOR_PATTERN).filter((userId) => userId !== '');
}

function toAudience(draft: AnnouncementDraft): DraftResult<AnnouncementAudience> {
  // 3 つの kind を網羅しているので default は要らない（足すと到達しない行になる）
  switch (draft.audienceKind) {
    case 'all':
      return { kind: 'ok', input: { kind: 'all' } };
    case 'role':
      return draft.role === null
        ? { kind: 'error', message: ROLE_REQUIRED_MESSAGE }
        : { kind: 'ok', input: { kind: 'role', role: draft.role } };
    case 'users': {
      const userIds = toUserIds(draft.userIdsText);

      return userIds.length === 0
        ? { kind: 'error', message: USER_IDS_REQUIRED_MESSAGE }
        : { kind: 'ok', input: { kind: 'users', userIds } };
    }
  }
}

function toAnnouncementInput(draft: AnnouncementDraft): DraftResult<AnnouncementInput> {
  const title = draft.title.trim();

  if (title === '') {
    return { kind: 'error', message: TITLE_REQUIRED_MESSAGE };
  }

  const body = draft.body.trim();

  if (body === '') {
    return { kind: 'error', message: BODY_REQUIRED_MESSAGE };
  }

  const audience = toAudience(draft);

  if (audience.kind === 'error') {
    return audience;
  }

  return { kind: 'ok', input: { title, body, audience: audience.input } };
}

/** 確認ダイアログに出す宛先。「誰に届くか」を押す前に必ず見せる */
function toAudienceSummary(audience: AnnouncementAudience): string {
  switch (audience.kind) {
    case 'all':
      return '全員';
    case 'role':
      return `${ROLE_LABELS[audience.role]}のみ`;
    case 'users':
      return `${audience.userIds.length} 人`;
  }
}

interface AnnouncementFormProps {
  /** 送信後に呼ばれるコールバックを第 2 引数で受け取る（成功したときだけ入力を消す） */
  onSend: (input: AnnouncementInput, onSucceeded: () => void) => void;
  isSending: boolean;
  errorMessage: string | undefined;
}

/**
 * フォームは**モジュールの最上位**で定義する。
 *
 * `AnnouncementsScreen` の中で定義すると、画面が再描画されるたびに
 * 別の関数（＝別のコンポーネント型）になり、React が作り直す。
 * `TextInput` が作り直されると 1 文字打つたびにフォーカスが外れる。
 */
function AnnouncementForm({ onSend, isSending, errorMessage }: AnnouncementFormProps) {
  const [draft, setDraft] = useState<AnnouncementDraft>(NEW_ANNOUNCEMENT_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  // 確認待ちの入力。null なら確認は出ていない
  const [pendingInput, setPendingInput] = useState<AnnouncementInput | null>(null);

  const handleSendPress = (): void => {
    const result = toAnnouncementInput(draft);

    if (result.kind === 'error') {
      setDraftError(result.message);
      return;
    }

    setDraftError(null);
    setPendingInput(result.input);
  };

  const handleConfirm = (): void => {
    if (pendingInput === null) {
      return;
    }

    const input = pendingInput;

    // 確認はここで閉じる。結果を待って閉じると、失敗したときにダイアログが出たまま残る
    setPendingInput(null);
    onSend(input, () => {
      setDraft(NEW_ANNOUNCEMENT_DRAFT);
    });
  };

  return (
    <Card testID={FORM_TEST_ID}>
      <View className="gap-md">
        <Input
          label="件名"
          isRequired
          value={draft.title}
          onChangeText={(title) => {
            setDraft({ ...draft, title });
          }}
          testID={`${FORM_TEST_ID}-title`}
        />
        <Input
          label="本文"
          isRequired
          isMultiline
          value={draft.body}
          onChangeText={(body) => {
            setDraft({ ...draft, body });
          }}
          testID={`${FORM_TEST_ID}-body`}
        />

        <View className="gap-xs">
          <Text className="font-body-medium text-sm text-neutral-700">宛先</Text>
          <SegmentedControl
            value={draft.audienceKind}
            options={AUDIENCE_OPTIONS}
            onChange={(audienceKind) => {
              setDraft({ ...draft, audienceKind });
            }}
            testID={`${FORM_TEST_ID}-audience`}
          />
        </View>

        {draft.audienceKind === 'role' ? (
          <SelectField
            label="ロール"
            value={draft.role}
            options={ROLE_OPTIONS}
            onChange={(role) => {
              setDraft({ ...draft, role });
            }}
            testID={`${FORM_TEST_ID}-role`}
          />
        ) : null}

        {draft.audienceKind === 'users' ? (
          <Input
            label="ユーザー ID"
            isRequired
            isMultiline
            placeholder="usr_01 usr_02（空白・改行・読点で区切る）"
            value={draft.userIdsText}
            onChangeText={(userIdsText) => {
              setDraft({ ...draft, userIdsText });
            }}
            testID={`${FORM_TEST_ID}-user-ids`}
          />
        ) : null}

        {draftError === null ? null : (
          <Text
            accessibilityRole="alert"
            className="font-body text-sm text-red-700"
            testID={`${FORM_TEST_ID}-error`}
          >
            {draftError}
          </Text>
        )}

        {errorMessage === undefined ? null : (
          <Text
            accessibilityRole="alert"
            className="font-body text-sm text-red-700"
            testID={`${FORM_TEST_ID}-write-error`}
          >
            {errorMessage}
          </Text>
        )}

        <Button
          label="配信する"
          leadingIcon={<Send color="white" size={16} />}
          onPress={handleSendPress}
          isLoading={isSending}
          testID={`${FORM_TEST_ID}-send-button`}
        />
      </View>

      <ConfirmDialog
        isVisible={pendingInput !== null}
        title="お知らせを配信しますか？"
        message={
          pendingInput === null
            ? ''
            : `${toAudienceSummary(pendingInput.audience)}に配信します。配信後は取り消せません。`
        }
        confirmLabel="配信する"
        isDestructive
        isLoading={isSending}
        onConfirm={handleConfirm}
        onCancel={() => {
          setPendingInput(null);
        }}
      />
    </Card>
  );
}

export function AnnouncementsScreen() {
  const query = useAnnouncementHistory();
  const sendAnnouncement = useSendAnnouncement();

  return (
    <AdminListScreen<AnnouncementHistoryItem>
      query={query}
      keyOf={(item) => item.announcementId}
      renderItem={(item) => (
        <Card testID={`${TEST_ID}-row-${item.announcementId}`}>
          <View className="gap-xs">
            <Text className="font-body-medium text-base text-neutral-900">{item.title}</Text>
            {/*
              audience はサーバが組み立てた文字列をそのまま出す（Task 9-19 の履歴スキーマは
              audience: z.string()）。どんな値が来るかは **未確認**。Step 36 で
              apps/api/src/routes/admin/announcements.ts を開いて確かめ、
              語彙が決まっているなら labels.ts に表を足して和訳する
            */}
            <Text className="font-body text-sm text-neutral-600">
              {`${item.audience}・${item.recipientCount} 人・${formatDateTime(item.sentAtMs)}`}
            </Text>
          </View>
        </Card>
      )}
      emptyIcon={Megaphone}
      emptyTitle="配信履歴はまだありません"
      emptyDescription="上のフォームから最初のお知らせを配信できます。"
      errorTitle="配信履歴を読み込めませんでした"
      header={
        <AnnouncementForm
          onSend={(input, onSucceeded) => {
            sendAnnouncement.mutate({ input }, { onSuccess: onSucceeded });
          }}
          isSending={sendAnnouncement.isPending}
          errorMessage={toWriteErrorMessage([sendAnnouncement])}
        />
      }
      testID={TEST_ID}
    />
  );
}
```

`toSelectOptions(AUDIENCE_KINDS, AUDIENCE_KIND_LABELS)` の戻りは `SelectOption<AudienceKind>[]` だが、`SegmentOption` と同じ形（`{ value, label }`）なので `SegmentedControl` にそのまま渡せる。Task 9-19 のコメントが明言している。

件名・本文の最大文字数は `Input` の `maxLength` で出せるが、**サーバ側の上限が未確認**なので付けない。Step 36 で `apps/api/src/routes/admin/announcements.ts` の Zod スキーマを見て、`.max(n)` があればその値を定数にして `maxLength` に渡す（無ければ付けないままにする）。画面だけに上限を置くと、サーバが緩めたときに画面が古い上限で止め続ける。

- [ ] **Step 21: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/announcements-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**15 件**。Step 18 で書いた `describe('AnnouncementsScreen')` の `it` がちょうど 15 本。内訳は 履歴 3 + 宛先 6 + 入力の検査 2 + 送信の成否 2 + 確認ダイアログ 2）

わざと壊す。

1. `NEW_ANNOUNCEMENT_DRAFT.audienceKind` を `'all'` にする → 「既定の宛先は個別指定にする」が落ちる。
2. 戻してから `AnnouncementForm` を `AnnouncementsScreen` の**内側**へ移す（`function AnnouncementsScreen() { function AnnouncementForm() {...} ... }`）→ テストは通るが、`fillTitleAndBody` の直後に `screen.getByTestId(...).props.value` を見ると 1 文字目しか残っていないはず。**実機と同じ症状をテストで踏めるか**を確認する。踏めない場合は「テストでは検出できない」と分かったこと自体が収穫なので、コメントに追記して戻す。
3. 戻してから `handleConfirm` の `setPendingInput(null)` を `onSend` の後ろへ動かす → テストは通る。次に `sendAnnouncementMock` を失敗させる「送信に失敗したら文言を出し、入力は残す」に `expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull()` を足すと落ちることを確かめてから戻す（この行はテストにも残す）。
4. 戻してから `USER_ID_SEPARATOR_PATTERN` を `/,/` にする → 「個別指定は空白と読点で ID を分ける」が落ちる。
5. 戻してから `toAudience` の `users` の `userIds.length === 0` を `draft.userIdsText === ''` にする → 「個別指定で ID が 1 件も無いと送らない」が落ちる（空白と読点だけの入力が通り、`userIds` が空配列でサーバへ飛ぶ）。
6. 戻してから `onSend` の `{ onSuccess: onSucceeded }` を消す → 「送信に成功したら入力を空に戻す」が落ちる。

6 つとも確認したら戻す。

- [ ] **Step 22: 監査ログ 1 行の失敗するテストを書く**

`apps/mobile/src/features/admin/components/audit-log-row.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import type { AuditLogItem } from '../types';
import { AuditLogRow } from './audit-log-row';

const TEST_ID = 'audit-log-row';

const ITEM: AuditLogItem = {
  auditLogId: 'aud_01',
  actorId: 'usr_admin',
  actorName: '管理 太郎',
  action: 'shop.suspend',
  targetType: 'shop',
  targetId: 'shp_01',
  diff: { status: ['published', 'suspended'] },
  createdAtMs: new Date(2026, 8, 16, 9, 5).getTime(),
  undoable: true,
};

function renderRow(overrides: Partial<AuditLogItem> = {}, isUndoing = false) {
  const onUndo = jest.fn();

  return {
    onUndo,
    ...render(
      <AuditLogRow
        item={{ ...ITEM, ...overrides }}
        onUndo={onUndo}
        isUndoing={isUndoing}
        testID={TEST_ID}
      />,
    ),
  };
}

describe('AuditLogRow', () => {
  it('操作を和訳して出す', async () => {
    await renderRow();

    expect(screen.getByText('店舗を非公開')).toBeTruthy();
  });

  it('表にない操作はそのままの文字で出す', async () => {
    // 語彙を増やす前のログが残っていても、行が空白にならないこと
    await renderRow({ action: 'shop.archive' });

    expect(screen.getByText('shop.archive')).toBeTruthy();
  });

  it('実行者と日時を出す', async () => {
    await renderRow();

    expect(screen.getByText('管理 太郎・2026/09/16 09:05')).toBeTruthy();
  });

  it('実行者が分からないときは「（なし）」と出す', async () => {
    // 自動処理やアカウント削除済みの管理者のログ
    await renderRow({ actorId: null, actorName: null });

    expect(screen.getByText('（なし）・2026/09/16 09:05')).toBeTruthy();
  });

  it('対象の種類と ID を出す', async () => {
    await renderRow();

    expect(screen.getByText('店舗 shp_01')).toBeTruthy();
  });

  it('表にない対象の種類もそのままの文字で出す', async () => {
    await renderRow({ targetType: 'coupon' });

    expect(screen.getByText('coupon shp_01')).toBeTruthy();
  });

  it('差分を「変更前 → 変更後」で出す', async () => {
    await renderRow();

    expect(screen.getByTestId(`${TEST_ID}-diff-status`)).toHaveTextContent(
      'status: published → suspended',
    );
  });

  it('差分が複数あれば全部出す', async () => {
    await renderRow({ diff: { name: ['旧', '新'], sortOrder: [0, 10] } });

    expect(screen.getByTestId(`${TEST_ID}-diff-name`)).toHaveTextContent('name: 旧 → 新');
    expect(screen.getByTestId(`${TEST_ID}-diff-sortOrder`)).toHaveTextContent('sortOrder: 0 → 10');
  });

  it('差分が無ければ差分の欄を出さない', async () => {
    await renderRow({ diff: null });

    expect(screen.queryByTestId(`${TEST_ID}-diff-list`)).toBeNull();
  });

  it('差分が空オブジェクトでも差分の欄を出さない', async () => {
    // サーバが `{}` を返しても、見出しだけの空欄を作らない
    await renderRow({ diff: {} });

    expect(screen.queryByTestId(`${TEST_ID}-diff-list`)).toBeNull();
  });

  it('取り消せるログには取り消しボタンを出す', async () => {
    const { onUndo } = await renderRow();
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-undo-button`));

    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('取り消せないログにはボタンを出さない', async () => {
    await renderRow({ undoable: false });

    expect(screen.queryByTestId(`${TEST_ID}-undo-button`)).toBeNull();
  });

  it('取り消し中はボタンを押せなくする', async () => {
    await renderRow({}, true);

    expect(screen.getByTestId(`${TEST_ID}-undo-button`).props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('取り消しに失敗した文言を出す', async () => {
    const onUndo = jest.fn();
    await render(
      <AuditLogRow
        item={ITEM}
        onUndo={onUndo}
        isUndoing={false}
        errorMessage="この操作はもう取り消せません。"
        testID={TEST_ID}
      />,
    );

    expect(screen.getByTestId(`${TEST_ID}-error`)).toHaveTextContent(
      'この操作はもう取り消せません。',
    );
  });

  it('失敗していないときは文言の欄を出さない', async () => {
    await renderRow();

    expect(screen.queryByTestId(`${TEST_ID}-error`)).toBeNull();
  });
});
```

- [ ] **Step 23: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/components/audit-log-row`
Expected: FAIL、`Cannot find module './audit-log-row' from 'src/features/admin/components/audit-log-row.test.tsx'`

- [ ] **Step 24: 監査ログ 1 行を実装する**

`apps/mobile/src/features/admin/components/audit-log-row.tsx`

```tsx
import { Undo2 } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { COLORS } from '@/constants/theme';

import { EMPTY_VALUE_LABEL, formatDateTime, formatDiffValue } from '../format';
import { AUDIT_ACTION_LABELS, AUDIT_TARGET_TYPE_LABELS } from '../labels';
import type { AuditLogItem } from '../types';

/**
 * ラベル表を `Record<string, string>` として読み直す。
 *
 * `AuditLogItem.action` / `targetType` は `z.enum` で縛っていない（Task 9-19）。
 * 語彙を増やす前のログが残っているので、**知らないキーで落ちないこと**が要件。
 * `Record<AuditAction, string>` のまま引くと `tsc` が通らず、`as` で黙らせると
 * `noUncheckedIndexedAccess` の恩恵まで消える。広い型で受け直すのが素直。
 */
const ACTION_LABELS: Readonly<Record<string, string>> = AUDIT_ACTION_LABELS;
const TARGET_TYPE_LABELS: Readonly<Record<string, string>> = AUDIT_TARGET_TYPE_LABELS;

const UNDO_LABEL = '取り消す';
const UNDO_ICON_SIZE_PX = 16;
const DIFF_ARROW = '→';

/** 監査ログ画面の確認ダイアログでも使うので export する（Step 28）*/
export function toActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function toTargetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] ?? targetType;
}

export interface AuditLogRowProps {
  item: AuditLogItem;
  /** 取り消しの確認は画面側が持つ。行は押されたことだけを伝える */
  onUndo: () => void;
  isUndoing: boolean;
  errorMessage?: string | undefined;
  testID: string;
}

export function AuditLogRow({ item, onUndo, isUndoing, errorMessage, testID }: AuditLogRowProps) {
  // Object.entries は `[string, [unknown, unknown]][]` を返す。
  // タプルの分割代入は noUncheckedIndexedAccess の対象外なので undefined が混ざらない
  const diffEntries = item.diff === null ? [] : Object.entries(item.diff);

  return (
    <Card testID={testID}>
      <View className="gap-xs">
        <Text className="font-body-medium text-base text-neutral-900">
          {toActionLabel(item.action)}
        </Text>

        {/* Text の子を分けると getByText で引けなくなるため 1 本のテンプレート文字列にする */}
        <Text className="font-body text-sm text-neutral-600">
          {`${item.actorName ?? EMPTY_VALUE_LABEL}・${formatDateTime(item.createdAtMs)}`}
        </Text>

        <Text className="font-body text-sm text-neutral-600">
          {`${toTargetTypeLabel(item.targetType)} ${item.targetId}`}
        </Text>

        {diffEntries.length === 0 ? null : (
          <View className="gap-px rounded-card bg-neutral-50 p-sm" testID={`${testID}-diff-list`}>
            {diffEntries.map(([key, [before, after]]) => (
              <Text
                className="font-body text-xs text-neutral-700"
                key={key}
                testID={`${testID}-diff-${key}`}
              >
                {`${key}: ${formatDiffValue(before)} ${DIFF_ARROW} ${formatDiffValue(after)}`}
              </Text>
            ))}
          </View>
        )}

        {errorMessage === undefined ? null : (
          <Text
            accessibilityRole="alert"
            className="font-body text-sm text-red-700"
            testID={`${testID}-error`}
          >
            {errorMessage}
          </Text>
        )}

        {item.undoable ? (
          <Button
            label={UNDO_LABEL}
            variant="danger"
            size="sm"
            leadingIcon={<Undo2 color={COLORS.white} size={UNDO_ICON_SIZE_PX} />}
            onPress={onUndo}
            isLoading={isUndoing}
            testID={`${testID}-undo-button`}
          />
        ) : null}
      </View>
    </Card>
  );
}
```

`lucide-react-native` に `Undo2` があることは `node_modules/lucide-react-native/dist/types/icons.d.ts` を `grep '^declare const Undo2:'` して確認した（**実測 2026-09-16**）。`Trash2` / `Filter` / `History` は**無い**ので、Task 9-24 では `Trash` / `ListFilter` / `ScrollText` を使う（これも同じ方法で存在を確認済み）。

`Button` は `isLoading` のとき `disabled` を立てる（`isInteractionBlocked = isDisabled || isLoading`、実ファイルで確認）。`fireEvent.press` が disabled の `Pressable` を無視することに寄りかからず、`accessibilityState.disabled` を直接見るテストにしてある。

- [ ] **Step 25: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/components/audit-log-row && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（15 件）

わざと壊す。

1. `toActionLabel` の `?? action` を消す → `tsc` が落ちる（`string | undefined` を `Text` の子に渡せる点は問題にならないが、戻り値の型注釈 `: string` に合わない）。型で止まることを確認する。
2. 戻してから `ACTION_LABELS` の宣言を消して `AUDIT_ACTION_LABELS[item.action]` を直接書く → `tsc` が落ちる（`string` で `Record<AuditAction, string>` を引けない）。**`as` を使いたくなる場所がここだと分かる。**
3. 戻してから `item.actorName ?? EMPTY_VALUE_LABEL` を `item.actorId ?? EMPTY_VALUE_LABEL` にする → 「実行者と日時を出す」が落ちる（ID が出る）。
4. 戻してから `diffEntries.length === 0` を `item.diff === null` にする → 「差分が空オブジェクトでも差分の欄を出さない」が落ちる。
5. 戻してから `item.undoable ?` の条件を消して常にボタンを出す → 「取り消せないログにはボタンを出さない」が落ちる。

5 つとも確認したら戻す。

- [ ] **Step 26: 監査ログ画面の失敗するテストを書く**

`apps/mobile/src/features/admin/screens/audit-log-screen.test.tsx`

```tsx
import { fireEvent, screen } from '@testing-library/react-native';

import { fetchAuditLogs, undoAuditLog } from '../api';
import { renderWithQuery } from '../testing/query-wrapper';
import type { AuditLogItem } from '../types';
import { AuditLogScreen } from './audit-log-screen';

jest.mock('../api');

const fetchAuditLogsMock = jest.mocked(fetchAuditLogs);
const undoAuditLogMock = jest.mocked(undoAuditLog);

const UNDOABLE_LOG: AuditLogItem = {
  auditLogId: 'aud_01',
  actorId: 'usr_admin',
  actorName: '管理 太郎',
  action: 'shop.suspend',
  targetType: 'shop',
  targetId: 'shp_01',
  diff: { status: ['published', 'suspended'] },
  createdAtMs: new Date(2026, 8, 16, 9, 5).getTime(),
  undoable: true,
};

const OTHER_LOG: AuditLogItem = {
  ...UNDOABLE_LOG,
  auditLogId: 'aud_02',
  action: 'genre.create',
  targetType: 'genre',
  targetId: 'gen_01',
  diff: null,
};

const TEST_ID = 'admin-audit-log';

/** 絞り込み無しのとき API に渡るはずの引数。ここを 1 か所にしておくと差分が読める */
const NO_FILTER_PARAMS = {
  actorId: null,
  action: null,
  targetType: null,
  targetId: null,
  cursor: null,
};

beforeEach(() => {
  fetchAuditLogsMock.mockReset();
  undoAuditLogMock.mockReset();
  fetchAuditLogsMock.mockResolvedValue({
    items: [UNDOABLE_LOG, OTHER_LOG],
    nextCursor: null,
  });
  undoAuditLogMock.mockResolvedValue({ auditLogId: 'aud_01', result: 'ok' });
});

describe('AuditLogScreen', () => {
  it('監査ログを出す', async () => {
    await renderWithQuery(<AuditLogScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-row-aud_01`)).toBeTruthy();
    expect(screen.getByTestId(`${TEST_ID}-row-aud_02`)).toBeTruthy();
  });

  it('最初は絞り込み無しで取りに行く', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);

    expect(fetchAuditLogsMock).toHaveBeenCalledWith(NO_FILTER_PARAMS);
  });

  it('ID を打っただけでは絞り込まない', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-actor-id`), 'usr_admin');

    expect(fetchAuditLogsMock).toHaveBeenCalledTimes(1);
  });

  it('絞り込むを押すと実行者 ID と対象 ID を同時に送る', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-actor-id`), '  usr_admin  ');
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-target-id`), 'shp_01');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-apply-button`));

    expect(fetchAuditLogsMock).toHaveBeenLastCalledWith({
      ...NO_FILTER_PARAMS,
      actorId: 'usr_admin',
      targetId: 'shp_01',
    });
  });

  it('空白だけの ID は絞り込みに使わない', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-actor-id`), '   ');
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-apply-button`));

    // 引数が変わらないので再取得も起きない
    expect(fetchAuditLogsMock).toHaveBeenCalledTimes(1);
    expect(fetchAuditLogsMock).toHaveBeenLastCalledWith(NO_FILTER_PARAMS);
  });

  it('操作で絞り込む', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-option-shop.suspend`));

    expect(fetchAuditLogsMock).toHaveBeenLastCalledWith({
      ...NO_FILTER_PARAMS,
      action: 'shop.suspend',
    });
  });

  it('対象の種類で絞り込む', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-target-type-filter-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-target-type-filter-option-shop`));

    expect(fetchAuditLogsMock).toHaveBeenLastCalledWith({
      ...NO_FILTER_PARAMS,
      targetType: 'shop',
    });
  });

  it('「すべて」に戻すと絞り込みを外す', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await screen.findByTestId(`${TEST_ID}-row-aud_01`);
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-option-shop.suspend`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-trigger`));
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-action-filter-option-all`));

    expect(fetchAuditLogsMock).toHaveBeenLastCalledWith(NO_FILTER_PARAMS);
  });

  it('確認してから取り消す', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-aud_01-undo-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(undoAuditLogMock).toHaveBeenCalledWith('aud_01');
  });

  it('確認に操作の内容を出す', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-aud_01-undo-button`));

    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('店舗を非公開');
  });

  it('確認を取り消すと何も起きない', async () => {
    await renderWithQuery(<AuditLogScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-aud_01-undo-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));

    expect(undoAuditLogMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('取り消しに失敗した文言は押した行にだけ出す', async () => {
    undoAuditLogMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AuditLogScreen />);
    await fireEvent.press(await screen.findByTestId(`${TEST_ID}-row-aud_01-undo-button`));
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId(`${TEST_ID}-row-aud_01-error`)).toBeTruthy();
    expect(screen.queryByTestId(`${TEST_ID}-row-aud_02-error`)).toBeNull();
  });

  it('取得に失敗したらエラーを出す', async () => {
    fetchAuditLogsMock.mockRejectedValue(new Error('boom'));
    await renderWithQuery(<AuditLogScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-error`)).toBeTruthy();
  });

  it('続きがあれば「もっと読む」を出す', async () => {
    fetchAuditLogsMock.mockResolvedValue({
      items: [UNDOABLE_LOG],
      nextCursor: 'aud_00',
    });
    await renderWithQuery(<AuditLogScreen />);

    expect(await screen.findByTestId(`${TEST_ID}-load-more`)).toBeTruthy();
  });
});
```

`aud_02` は `undoable: true` のままにしてある（`UNDOABLE_LOG` のスプレッド）。2 行とも取り消しボタンを持つので、「失敗の文言が押した行にだけ出る」を本当に確かめられる。片方を `undoable: false` にすると、そもそもボタンが無いせいで通ってしまう。

- [ ] **Step 27: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/audit-log-screen`
Expected: FAIL、`Cannot find module './audit-log-screen'`

- [ ] **Step 28: 監査ログ画面を実装する**

`apps/mobile/src/features/admin/screens/audit-log-screen.tsx`

```tsx
import { ScrollText } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';

import { toAdminErrorMessage } from '../api';
import { AdminListScreen } from '../components/admin-list-screen';
import { AuditLogRow, toActionLabel } from '../components/audit-log-row';
import { toFilterOptions, toFilterValue, type WithAll } from '../components/filter-options';
import { toNullableText } from '../format';
import { AUDIT_ACTION_LABELS, AUDIT_TARGET_TYPE_LABELS } from '../labels';
import { useAuditLogs, useUndoAuditLog } from '../queries';
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditLogItem,
  type AuditTargetType,
} from '../types';

const TEST_ID = 'admin-audit-log';

const ACTION_OPTIONS = toFilterOptions(AUDIT_ACTIONS, AUDIT_ACTION_LABELS);
const TARGET_TYPE_OPTIONS = toFilterOptions(AUDIT_TARGET_TYPES, AUDIT_TARGET_TYPE_LABELS);

const APPLY_LABEL = '絞り込む';
const ACTOR_ID_LABEL = '実行者 ID';
const TARGET_ID_LABEL = '対象 ID';
const ID_PLACEHOLDER = '完全一致で探します';

const UNDO_DIALOG_TITLE = 'この操作を取り消しますか？';
const UNDO_CONFIRM_LABEL = '取り消す';

/**
 * 取り消し確認に出す説明。**何が元に戻るかを操作名で示す。**
 * 「取り消しますか？」だけだと、どの行のボタンを押したのか分からなくなる。
 */
function toUndoMessage(actionLabel: string): string {
  return `「${actionLabel}」を取り消します。取り消しの操作自体も監査ログに残ります。`;
}

export function AuditLogScreen() {
  // 入力中の文字列と、絞り込みに使う確定した値を分ける（Task 9-22 の利用者一覧と同じ理由）
  const [actorIdInput, setActorIdInput] = useState('');
  const [targetIdInput, setTargetIdInput] = useState('');
  const [actorId, setActorId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [action, setAction] = useState<WithAll<AuditAction>>('all');
  const [targetType, setTargetType] = useState<WithAll<AuditTargetType>>('all');
  // 取り消し待ちのログ。null なら確認は出ていない
  const [pendingLog, setPendingLog] = useState<AuditLogItem | null>(null);

  const query = useAuditLogs({
    actorId,
    action: toFilterValue(action, AUDIT_ACTIONS),
    targetType: toFilterValue(targetType, AUDIT_TARGET_TYPES),
    targetId,
  });
  const undoAuditLog = useUndoAuditLog();

  // どの行を取り消し中か。mutation は 1 つしか無いので、変数から押した行を引く
  const undoingAuditLogId = undoAuditLog.isPending ? undoAuditLog.variables?.auditLogId : undefined;
  const failedAuditLogId = undoAuditLog.isError ? undoAuditLog.variables?.auditLogId : undefined;
  const undoErrorMessage = undoAuditLog.isError
    ? toAdminErrorMessage(undoAuditLog.error)
    : undefined;

  const handleApply = (): void => {
    setActorId(toNullableText(actorIdInput));
    setTargetId(toNullableText(targetIdInput));
  };

  const handleConfirmUndo = (): void => {
    if (pendingLog === null) {
      return;
    }

    const { auditLogId } = pendingLog;

    // 結果を待たずに閉じる。待つと、失敗したときにダイアログが残って行の文言が読めない
    setPendingLog(null);
    undoAuditLog.mutate({ auditLogId });
  };

  return (
    <View className="flex-1">
      <AdminListScreen<AuditLogItem>
        query={query}
        keyOf={(item) => item.auditLogId}
        renderItem={(item) => (
          <AuditLogRow
            item={item}
            onUndo={() => {
              setPendingLog(item);
            }}
            isUndoing={undoingAuditLogId === item.auditLogId}
            errorMessage={failedAuditLogId === item.auditLogId ? undoErrorMessage : undefined}
            testID={`${TEST_ID}-row-${item.auditLogId}`}
          />
        )}
        emptyIcon={ScrollText}
        emptyTitle="該当する操作履歴はありません"
        emptyDescription="絞り込みを変えて、もう一度お試しください。"
        errorTitle="操作履歴を取得できませんでした"
        header={
          <View className="gap-sm">
            <Input
              label={ACTOR_ID_LABEL}
              value={actorIdInput}
              onChangeText={setActorIdInput}
              placeholder={ID_PLACEHOLDER}
              testID={`${TEST_ID}-actor-id`}
            />
            <Input
              label={TARGET_ID_LABEL}
              value={targetIdInput}
              onChangeText={setTargetIdInput}
              placeholder={ID_PLACEHOLDER}
              testID={`${TEST_ID}-target-id`}
            />
            <Button
              label={APPLY_LABEL}
              variant="secondary"
              onPress={handleApply}
              testID={`${TEST_ID}-apply-button`}
            />
            {/*
              操作は 22 種類、対象は 9 種類ある。SegmentedControl は 5 つを超えると
              横に潰れるので（Task 9-18 の使い分け）どちらも SelectField にする
            */}
            <SelectField
              label="操作"
              value={action}
              options={ACTION_OPTIONS}
              onChange={setAction}
              testID={`${TEST_ID}-action-filter`}
            />
            <SelectField
              label="対象の種類"
              value={targetType}
              options={TARGET_TYPE_OPTIONS}
              onChange={setTargetType}
              testID={`${TEST_ID}-target-type-filter`}
            />
          </View>
        }
        testID={TEST_ID}
      />

      {/*
        確認は画面が 1 つだけ持つ。ConfirmDialog の testID は既定値が固定なので、
        行ごとに置くと `confirm-dialog-confirm` が行数ぶん現れて getByTestId が落ちる
      */}
      <ConfirmDialog
        isVisible={pendingLog !== null}
        title={UNDO_DIALOG_TITLE}
        message={pendingLog === null ? '' : toUndoMessage(toActionLabel(pendingLog.action))}
        confirmLabel={UNDO_CONFIRM_LABEL}
        isDestructive
        isLoading={undoAuditLog.isPending}
        onConfirm={handleConfirmUndo}
        onCancel={() => {
          setPendingLog(null);
        }}
      />
    </View>
  );
}
```

`toActionLabel` は Step 24 で `audit-log-row.tsx` に `export` 付きで定義してある（1 つの表を 2 か所で引くため）。画面からは `import { AuditLogRow, toActionLabel } from '../components/audit-log-row';` で引く。2 か所目が現れた時点で共通化する、というだけのこと。`toTargetTypeLabel` は行の中でしか使わないので export しない。

**`undoAuditLog.variables` の型**：`useAdminMutation` は `UseMutationResult<TResult, Error, TVariables>` を返す（Task 9-19）ので `variables` は `{ readonly auditLogId: string } | undefined`。`?.` で引いた結果は `string | undefined` になり、`undefined === item.auditLogId` は常に false なので、取り消していない行には何も出ない。

- [ ] **Step 29: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/screens/audit-log-screen && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（14 件）

わざと壊す。

1. `handleApply` の `toNullableText(actorIdInput)` を `actorIdInput` にする → 「空白だけの ID は絞り込みに使わない」と「絞り込むを押すと実行者 ID と対象 ID を同時に送る」の 2 つが落ちる。
2. 戻してから `Input` の `onChangeText` を `(text) => { setActorId(text); }` に変える → 「ID を打っただけでは絞り込まない」が落ちる。
3. 戻してから `failedAuditLogId === item.auditLogId` を `undoAuditLog.isError` にする → 「取り消しに失敗した文言は押した行にだけ出す」が落ちる（`aud_02` にも出る）。
4. 戻してから `toFilterValue(action, AUDIT_ACTIONS)` を `action` にする → `tsc` が落ちる（`WithAll<AuditAction>` は `AuditAction | null` ではない）。「すべて」が絞り込み値として飛ぶ事故が型で止まることを確認する。
5. 戻してから `ConfirmDialog` を `renderItem` の中（`AuditLogRow` の隣）へ移す → 「確認してから取り消す」が落ちる（`getByTestId('confirm-dialog-confirm')` が 2 つ見つかる）。**画面が 1 つだけ持つ理由の実地確認。**
6. 戻してから `handleConfirmUndo` の `setPendingLog(null)` を `undoAuditLog.mutate` の後ろへ動かす → 「確認を取り消すと何も起きない」は通るが、「取り消しに失敗した文言は押した行にだけ出す」で `findByTestId` がダイアログに隠れて落ちる（Modal が前面に残る）ことを確認する。

6 つとも確認したら戻す。

- [ ] **Step 30: ルートと実ファイルの対応を確かめるテストを書く**

`apps/mobile/src/features/admin/routes.test.ts` に追記する。Task 9-21 が書いた「宣言の形」のテストの下に、**宣言と実ファイルの突き合わせ**を足す。

ここまでの Task では `ADMIN_ROUTES.genres` が `'/(admin)/masters/genres'` という**文字列として正しいか**しか見ていない。ファイルが無ければ実行時に 404 になるが、テストは全部通る。ここで塞ぐ。

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Href } from 'expo-router';

import { ADMIN_DETAIL_ROUTES, ADMIN_ROUTES } from './routes';

/** routes.ts は src/features/admin/ にあるので、2 つ上が src/ */
const ADMIN_APP_DIR = join(__dirname, '..', '..', 'app', '(admin)');
const ADMIN_ROUTE_PREFIX = '/(admin)/';
const SCREEN_FILE_EXTENSION = '.tsx';
const LAYOUT_FILE_NAME = '_layout.tsx';

/** (admin) 配下の画面ファイル数。タブ 5 + 詳細 4 + マスタ 2 + お知らせ 1 + 監査ログ 1 */
const ADMIN_SCREEN_COUNT = 13;

/** ルートファイルに許す唯一の中身。1 行の再輸出だけ */
const RE_EXPORT_PATTERN =
  /^export \{ [A-Z][A-Za-z]*Screen as default \} from '@\/features\/admin\/screens\/[a-z0-9-]+';$/;

/** 詳細ルートに渡す ID。どれを渡しても pathname は変わらない */
const DETAIL_ROUTE_SAMPLE_ID = 'id_01';

/**
 * `(admin)` 配下のファイル一覧。`readdirSync(dir, { recursive: true })` は
 * `'masters/genres.tsx'` のように区切り文字入りの**文字列**を返す（実測 2026-09-16）。
 * ディレクトリ名も混ざるので拡張子で絞る。
 *
 * **`existsSync` を使わない。**macOS の既定のファイルシステムは大文字小文字を区別しないので、
 * `AUDIT-LOG.tsx` でも `existsSync` は `true` を返す（実測 2026-09-16）。
 * それだと Linux の CI だけが落ちる。`Set.has` は区別するので、手元で先に落ちる。
 */
const adminAppFiles = readdirSync(ADMIN_APP_DIR, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith(SCREEN_FILE_EXTENSION));

const adminAppFileSet = new Set(adminAppFiles);

/**
 * ルートの pathname を `(admin)` からの相対ファイル名にする。
 *
 * グループ `(tabs)` も動的セグメント `[applicationId]` も、expo-router では
 * ディレクトリ名・ファイル名がそのまま pathname に出る。つまり
 * 末尾に `.tsx` を足すだけで実ファイル名になる（4 パターンで実測 2026-09-16）。
 * 特別扱いを書かないこと自体が、規約と実装がずれていない証拠になる。
 */
function toAdminAppFile(pathname: string): string {
  if (!pathname.startsWith(ADMIN_ROUTE_PREFIX)) {
    throw new Error(`${pathname} が (admin) グループの外を指している`);
  }

  return `${pathname.slice(ADMIN_ROUTE_PREFIX.length)}${SCREEN_FILE_EXTENSION}`;
}

/**
 * `Href` から pathname を取り出す。
 *
 * `Href` は `string | HrefObject` で、`HrefObject.pathname` は `string`
 * （`node_modules/expo-router/build/typed-routes/types.d.ts` の 11 行目と 51 行目で確認、
 * 2026-09-16）。typedRoutes で `.expo/types` が生成されるとオブジェクト側は
 * 文字列リテラルの union になるが、`pathname` を持つことは変わらない。
 */
function toPathname(href: Href): string {
  if (typeof href === 'string') {
    throw new Error(`${href} が文字列で返っている（params 付きのオブジェクトを期待）`);
  }

  return href.pathname;
}

describe('ルート定義と実ファイルの対応', () => {
  it('ADMIN_ROUTES の 9 本すべてに画面ファイルがある', () => {
    for (const [name, pathname] of Object.entries(ADMIN_ROUTES)) {
      const relativePath = toAdminAppFile(pathname);

      // 落ちたときに「どのルートのどのファイルが無いか」がそのまま読めるようにする
      expect({
        name,
        relativePath,
        exists: adminAppFileSet.has(relativePath),
      }).toEqual({
        name,
        relativePath,
        exists: true,
      });
    }
  });

  it('ADMIN_DETAIL_ROUTES の 4 本すべてに画面ファイルがある', () => {
    for (const [name, toHref] of Object.entries(ADMIN_DETAIL_ROUTES)) {
      const relativePath = toAdminAppFile(toPathname(toHref(DETAIL_ROUTE_SAMPLE_ID)));

      expect({
        name,
        relativePath,
        exists: adminAppFileSet.has(relativePath),
      }).toEqual({
        name,
        relativePath,
        exists: true,
      });
    }
  });

  it('(admin) 配下の画面ファイルはちょうど 13 本', () => {
    const screenFiles = adminAppFiles.filter((file) => !file.endsWith(LAYOUT_FILE_NAME));

    expect(screenFiles).toHaveLength(ADMIN_SCREEN_COUNT);
  });

  it('宣言されていない画面ファイルが (admin) 配下に無い', () => {
    // 宣言から作った集合の外にあるファイルは、どこからも遷移できない迷子
    const declared = new Set([
      ...Object.values(ADMIN_ROUTES).map(toAdminAppFile),
      ...Object.values(ADMIN_DETAIL_ROUTES).map((toHref) =>
        toAdminAppFile(toPathname(toHref(DETAIL_ROUTE_SAMPLE_ID))),
      ),
    ]);
    const undeclared = adminAppFiles.filter(
      (file) => !file.endsWith(LAYOUT_FILE_NAME) && !declared.has(file),
    );

    expect(undeclared).toEqual([]);
  });

  it('画面ファイルはどれも 1 行の再輸出だけ', () => {
    // src/app/** はカバレッジの対象外（jest.config.js）。
    // 中身が 1 行の再輸出だけなら、測らないことが問題にならない
    for (const file of adminAppFiles) {
      if (file.endsWith(LAYOUT_FILE_NAME)) {
        continue;
      }

      const lines = readFileSync(join(ADMIN_APP_DIR, file), 'utf8').trimEnd().split('\n');

      expect({ file, lines }).toEqual({
        file,
        lines: [expect.stringMatching(RE_EXPORT_PATTERN)],
      });
    }
  });

  it('_layout.tsx 以外に _ で始まるファイルを置いていない', () => {
    // `_helpers.tsx` のような名前を作ると、上の「1 行だけ」検査をすり抜けて
    // カバレッジ対象外のディレクトリにロジックが溜まる
    const underscoreFiles = adminAppFiles.filter(
      (file) =>
        file.split('/').some((segment) => segment.startsWith('_')) &&
        !file.endsWith(LAYOUT_FILE_NAME),
    );

    expect(underscoreFiles).toEqual([]);
  });
});
```

`__dirname` は jest-expo（babel-jest で CJS に変換される）で使える。Task 9-18 の `catalog.test.tsx` が `require('../../app.json')` を使えているのと同じ理由。使えなかった場合は `expect.getState().testPath` から組み立てる。

- [ ] **Step 31: テストが落ちることを確認する**

Run: `npm test -w @meshimap/mobile -- features/admin/routes`
Expected: FAIL。`ADMIN_ROUTES の 9 本すべてに画面ファイルがある` が

```
- Expected  - 1
+ Received  + 1

  Object {
    "exists": false,   ← 受け取った側
    "name": "genres",
    "relativePath": "masters/genres.tsx",
  }
```

の形で落ちる（`masters/genres.tsx` / `masters/areas.tsx` / `announcements.tsx` / `audit-log.tsx` の 4 本が無い）。`(admin) 配下の画面ファイルはちょうど 13 本` も 9 本で落ちる。

- [ ] **Step 32: 残り 4 本のルートファイルを作る**

どれも 1 行だけ。**expo-router の画面ファイルは default export が要る**ので、「default export 禁止」の唯一の例外になる（Task 9-22 と同じ扱い）。

`apps/mobile/src/app/(admin)/masters/genres.tsx`

```tsx
export { GenresScreen as default } from '@/features/admin/screens/genres-screen';
```

`apps/mobile/src/app/(admin)/masters/areas.tsx`

```tsx
export { AreasScreen as default } from '@/features/admin/screens/areas-screen';
```

`apps/mobile/src/app/(admin)/announcements.tsx`

```tsx
export { AnnouncementsScreen as default } from '@/features/admin/screens/announcements-screen';
```

`apps/mobile/src/app/(admin)/audit-log.tsx`

```tsx
export { AuditLogScreen as default } from '@/features/admin/screens/audit-log-screen';
```

`masters/` に `_layout.tsx` は置かない。`(admin)/_layout.tsx` の Stack がそのまま効く（**Phase 5 の成果物**。Task 9-21 はルート定義 `routes.ts` を作る Task であってレイアウトは作らない）。置くと 13 本の数え方が変わるので、置きたくなったら `ADMIN_SCREEN_COUNT` ではなく除外条件のほうを直す。

- [ ] **Step 33: テストが通ることを確認し、わざと壊す**

Run: `npm test -w @meshimap/mobile -- features/admin/routes && npm run typecheck -w @meshimap/mobile`
Expected: 両方 PASS（**15 + 6 = 21 件**。Task 9-23 までの 15 件 + Step 30 で足した `describe('ルート定義と実ファイルの対応')` の 6 件）

わざと壊す。

1. `src/app/(admin)/audit-log.tsx` の名前を `audit_log.tsx` に変える → 「ADMIN_ROUTES の 9 本すべてに画面ファイルがある」が `relativePath: 'audit-log.tsx'` で落ち、「宣言されていない画面ファイルが無い」も `['audit_log.tsx']` で落ちる。**両方向から挟めていることの確認。**
2. 戻してから `audit-log.tsx` を `AUDIT-LOG.tsx` に変える（macOS では `git mv` を 2 段階で）→ `Set.has` が区別するので手元で落ちる。`existsSync` を使っていたら通ってしまう場所。確認したら戻す。
3. 戻してから `announcements.tsx` に 2 行目（`// メモ`）を足す → 「画面ファイルはどれも 1 行の再輸出だけ」が落ちる。
4. 戻してから `masters/genres.tsx` を `export default function GenresScreen() { return null; }` に書き換える → 同じテストが `stringMatching` で落ちる。**カバレッジ対象外の場所にロジックを書けないことの確認。**
5. 戻してから `src/app/(admin)/_helpers.tsx` を空で作る → 「_layout.tsx 以外に _ で始まるファイルを置いていない」と「ちょうど 13 本」が落ちる。確認したら消す。
6. 戻してから `routes.ts` の `announcements` を `'/(admin)/announcement'`（単数）に変える → 「ADMIN_ROUTES の 9 本すべてに画面ファイルがある」が落ちる。Task 9-21 の「(admin) の絶対パスである」テストは通ってしまうことも合わせて確認する。

6 つとも確認したら戻す。

- [ ] **Step 34: モバイル全体のカバレッジを 100% にする**

Run: `npm run test:coverage -w @meshimap/mobile`
Expected: PASS。`jest.config.js` の `coverageThreshold` は global 100（statements / branches / functions / lines）なので、1 行でも通っていなければここで落ちる。**`npm test` は `jest` でカバレッジを取らないため、しきい値も効かない**（`apps/mobile/package.json` の scripts で確認）。この Task の締めは必ず `test:coverage` で行う。

落ちるとしたら、この Task で足した次の枝が濃厚。落ちた行の番号を見てテストを足す（**しきい値を下げない**）。

| 落ちそうな箇所                                                         | 足すテスト                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `areas-screen.tsx` の `areaNameById.get(...) ?? EMPTY_VALUE_LABEL`     | 「親が一覧に無いときも（なし）と出す」（`fetchAreas` が子だけを返す）           |
| `audit-log-row.tsx` の `?? action` / `?? targetType`                   | Step 22 の「表にない操作/対象の種類」で通る。通っていなければ書き方を見直す     |
| `announcements-screen.tsx` の `pendingInput === null ? '' : ...`       | 確認を開かずに描画した初回で通る。通っていなければ `message` の組み立てを見直す |
| `audit-log-screen.tsx` の `handleConfirmUndo` の `pendingLog === null` | 到達しないなら**ガードを消す**（`pendingLog` を引数で渡す形に変える）           |

最後の行だけ方針が逆なのは、これが「起こりえない状態」を守るガードだからで、テストで作れない状態のためにコードを残すとカバレッジを落とし続ける。`ConfirmDialog` の `onConfirm` は `isVisible` が false のときには呼ばれないので、**Step 29 の時点で到達不能と分かったら `handleConfirmUndo(item: AuditLogItem)` に変え、`onConfirm={() => { handleConfirmUndo(pendingLog); }}` …とは書けない**（`pendingLog` が null かもしれない）。その場合は `ConfirmDialog` 自体を `pendingLog === null ? null : <ConfirmDialog ... />` で囲み、中で `pendingLog` を narrow 済みの値として使う。`AnnouncementForm` の `pendingInput` も同じ形にそろえる。**どちらの形にするかは Step 34 の実測で決める**（先に決めない）。

- [ ] **Step 35: 型・lint・書式を通す**

Run:

```bash
npm run typecheck -w @meshimap/mobile
npm run lint
npm run format:check
```

Expected: 3 つとも PASS。

`npm run lint` はルートの `eslint .` と `expo lint`（モバイル）の両方を走らせる（ルート `package.json` で確認）。引っかかりやすいのは次の 3 つ。

1. **import の並び** — `@meshimap/core` は外部パッケージ扱いで、`lucide-react-native` / `react` / `react-native` と同じ先頭グループに入る（`apps/mobile/src/constants/auth.test.ts` が先頭で import しているのを確認、2026-09-16）。`@/` は次のグループ、`../` はその次。
2. **`noUnusedLocals`** — `audit-log-row.tsx` の `toTargetTypeLabel` は export しないので、使い忘れると `tsc` が落ちる。
3. **未使用の import** — `announcements-screen.tsx` で `SelectField` を消したのに import が残る、など。

- [ ] **Step 36: 未確認だったサーバ側の 3 点を確かめ、必要なら直す**

ここまでで「サーバに任せた」と書いた箇所を、**実ファイルを開いて**確かめる。Task 9-0〜9-12 で作られているはず。

1. `apps/api/src/repositories/admin-master-repository.ts` — **自分自身を親エリアに指定する更新を弾いているか。**計画書どおりなら `updateArea` の先頭に `if (input.parentId === areaId) { return ADMIN_WRITE_OUTCOME.conflict; }` があり、ルート層が **409**（422 ではない）に写す。Task 9-9 のテスト「自分自身を親にはできない」も通っているはず。**別エージェントが `apps/api` を実装しているので、入っていなければサーバ側に足す**（画面ではなくサーバに置く。API は画面以外からも叩ける）。あわせて **A→B→A の 2 段の循環は誰も弾いていない**ことを確認し、実害（`listAreas` は `parentId === null` だけを「区」として扱うので表示は壊れない）とともにコミットメッセージに 1 行残す。塞ぐなら Phase 10。
2. `apps/api/src/routes/admin/announcements.ts` — **件名・本文の最大長。**Zod に `.max(n)` があれば、その `n` を `announcements-screen.tsx` の定数にして `Input` の `maxLength` に渡す（文字数カウンタが出る）。無ければ何もしない。
3. 同ファイル — **配信履歴の `audience` に入る文字列。**語彙が決まっていれば `labels.ts` に表を足し、`audit-log-row.tsx` の `toActionLabel` と同じ「知らないキーはそのまま出す」やり方で和訳する。決まっていない（宛先を説明する自由文）なら、そのまま出す今のままでよい。

あわせて `src/app/(admin)/_layout.tsx` と `src/app/(admin)/(tabs)/_layout.tsx` を開く。**`src/app/**` はカバレッジ対象外**なので、ここに条件分岐（ロールを見て弾く、など）があるとテストされないまま残る。分岐があれば `features/admin/` 側の関数に切り出し、レイアウトは呼ぶだけにする。Step 30 の「1 行だけ」検査は `_layout.tsx` を除外しているので、**ここは人が見るしかない**。

1〜3 と レイアウト 2 本、確かめた結果をこの Task のコミットメッセージに 1 行ずつ書く（「確かめた」という記録を残さないと、次の人がまた同じ場所を疑う）。

- [ ] **Step 37: 全ワークスペースのテストと変異テストを通す**

Run:

```bash
npm test
npm run test:mutation
```

Expected: 両方 PASS。

- `npm test` は `npm run test --workspaces --if-present`。`@meshimap/mobile`（jest）、`@meshimap/core` / `@meshimap/geo` / `@meshimap/api`（vitest）が走る。
- `npm run test:mutation` も `--workspaces --if-present` で、**`test:mutation` を持つのは core / geo / api の 3 つだけ。`apps/mobile/package.json` に `test:mutation` は無い**（実測 2026-09-16）。つまりこの Task で足したコードは変異テストの対象外。**mobile に Stryker を入れる話はここでしない**（新しい依存を足さない方針、かつ jest ランナーの選定は別の判断）。
- しきい値は `stryker.base.mjs` の `THRESHOLDS = { high: 95, low: 85, break: 85 }`。85 を下回るとコマンドが失敗する。この Task はサーバ側のコードを変えないので、下がったなら**別の原因**（他の Task の取りこぼし）を疑う。
- 変異テストは時間がかかる。手元で様子を見るときは `perl -e 'alarm 1800; exec @ARGV' npm run test:mutation` のように上限を付ける（`timeout` コマンドはこの環境に無い）。

- [ ] **Step 38: コミットする**

```bash
git add "apps/mobile/src/features/admin" "apps/mobile/src/app/(admin)"
git commit
```

`(admin)` を含むパスは**必ず引用符で囲む**。zsh は `(` `)` をグロブの記号として読むので、裸で書くと `zsh: no matches found` になる。

コミットメッセージには Step 36 で確かめた 4 点（親エリアの循環、件名・本文の最大長、履歴の `audience`、レイアウト 2 本）を 1 行ずつ残す。

**わざと壊す（Task 9-24 の総仕上げとして）。**

1. `apps/mobile/jest.config.js` の `collectCoverageFrom` から `'!src/app/**'` を消して `npm run test:coverage -w @meshimap/mobile` を走らせる → ルートファイル 13 本が「関数 0 / 行 1」で計上される。**しきい値 100% を割るかどうかを実測する。**割らなければ除外を外したままにできる（jest.config.js のコメントが「いずれ外す」と書いている状態を解消できる）。割るなら、なぜ割るのか（`_layout.tsx` の中身か、再輸出行そのものか）をコミットメッセージに残して除外を戻す。**ここを測らずに除外を残し続けない。**
2. 戻してから `apps/mobile/src/features/admin/screens/genres-screen.tsx` の `export` を消す → `src/app/(admin)/masters/genres.tsx` の再輸出が `tsc` で落ちる。ルートファイルが 1 行でも型検査の網には入っていることの確認。
3. 戻してから `ADMIN_SCREEN_COUNT` を `14` にする → 「ちょうど 13 本」が落ちる。数え間違いを数えさせていないことの確認。
4. 戻してから `npm run format:check` の前に `announcements-screen.tsx` の import を 1 行入れ替える → `format:check` は通る（Prettier は import を並べ替えない）が `npm run lint` が落ちる。**どちらのコマンドが何を見ているかの確認。**
5. 戻してから `apps/mobile/src/features/admin/screens/audit-log-screen.test.tsx` の `NO_FILTER_PARAMS` から `cursor: null` を消す → 「最初は絞り込み無しで取りに行く」が落ちる。`useAdminCursorQuery` が `cursor` を足して渡していることを、画面のテストからも押さえられていることの確認。

5 つとも確認したら戻し、`npm run test:coverage -w @meshimap/mobile` と `npm run typecheck -w @meshimap/mobile` をもう一度通してからコミットする。

---

## 追補: 初回店舗申請（`user` → `owner`）を Phase 9 が引き取る

**2026-09-16 に追加。** 設計書 §4（120 行）は「`user` から店舗申請を出し、審査通過で `owner` へ昇格する遷移は**実装する**」と書き、§5.1 は `(user)/settings/shop-application.tsx`（174 行）と `(owner)/onboarding/apply.tsx`（201 行・書類アップロード含む）を挙げている。ところが

- **Phase 5** は Task 5-19 で「API が無い・`shop_applications` と噛み合わない・ルート本数が他フェーズと衝突する」の 3 点を理由に**初回申請をスコープ外**にした
- **Phase 8** は `/owner/**` の 3 本（`GET /owner/application` / `POST /owner/application/documents` / `POST /owner/application/resubmit`）しか作らず、どれも `owner` 以外は 403

となり、**初回申請を担当するフェーズが 1 つも無い**状態だった。ここで Phase 9 が引き取る。

### なぜ Phase 9 か（他フェーズと比べた根拠）

| 候補    | 追加で要るもの                                                                                                                                                        | 判定                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Phase 5 | 認証とルーティングのフェーズにエンドポイント 4 本と R2 の書類アップロードが乗る。Task 5-19 が挙げた 3 つの阻害要因はどれも解消していない                              | ×。Phase 5 は「ルートを 1 本も足さない」ことで Phase 7/8/9 の積み上げ表を無傷に保つと決めている |
| Phase 8 | `(owner)` グループの画面しか持たないフェーズに `(user)` の画面が混ざる。申請者はまだ `owner` ではないので `roleGuard(ROLE_OWNER)` の名前空間に置けない                | ×。Phase 8 の「`/owner/**` に門番を 1 回だけ掛ける」構造が崩れる                                |
| Phase 9 | **審査側（承認 / 差し戻し / 却下 / ロール昇格）を既に全部持っている**（Task 9-5 `approveApplication`）。申請側を同じフェーズに置けば、申請から昇格までが 1 本で閉じる | ○                                                                                               |

Phase 9 を選ぶ決め手は 3 つ。**どれも実ファイル / 実計画書で確認した事実である。**

1. **承認の相手方がここにしかいない。** Task 9-5 の `approveApplication` は `shop_applications` → `shops` → `profiles` を `innerJoin` して読み、`profiles.role` を `user` → `owner` へ上げる。申請を作る側が別フェーズだと、「どんな行を作れば承認が通るか」の契約が 2 つの計画書に割れる。
2. **画面部品がここで揃う。** 申請フォームに要る選択 UI（`SelectField`）は Task 9-18 が作る。Phase 5 / Phase 8 の時点では存在しない（`apps/mobile/src/components/ui/` は badge / button / card / empty-state / error-state / icon / input / skeleton の 8 つだけ。2026-09-16 に `ls` で確認）。
3. **`shop_applications` に触るタスクが既にある。** Task 9-5 のテストは `seedShop(world, { id: SHOP_ID, ownerId: null, status: SHOP_STATUS_DRAFT })` で「オーナー未定の下書き店舗」を作っている。**申請側が作るべき行の形は、Phase 9 の既存テストが既に前提として書いている形そのものである。**

> `apps/api/src/db/schema/admin.ts:100-103` のコメントは「ロール昇格の実処理は Phase 10」と書いているが、**Phase 10 計画書にロール昇格の実装は無い**（`grep -n 'ROLE_OWNER' 2026-09-15-phase-10-polish.md` は 1 件も返さない）。昇格は Task 9-5 が実装する。スキーマのコメントのほうが古い。**実ファイルのコメントは変更しない**（このフェーズでコードは書かない）が、Task 9-5 の実装時に 1 行直すこと。

### 実装形の比較（案 A / 案 B / 案 C）

固定されている制約（すべて 2026-09-16 に実ファイルで確認）:

| 事実                                                                                                                                  | 実ファイル                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `shop_applications.shop_id` は `.notNull()` で `shops.id` を参照（`onDelete: 'cascade'`）                                             | `apps/api/src/db/schema/admin.ts:112-114` |
| `shop_applications` に `updated_at` 列は**無い**                                                                                      | 同 `admin.ts:105-128`                     |
| 申請ステータスは 4 値 `pending` / `approved` / `rejected` / `returned`                                                                | `apps/api/src/db/constants.ts:144-159`    |
| **`shops.owner_id` は NULL 可**（`references(..., { onDelete: 'set null' })`）。コメントに「申請前やオーナー付け替え中は NULL」とある | `apps/api/src/db/schema/shop.ts`          |
| `shops` は `genre_id` / `area_id` / `address` / `lat` / `lng` / `geohash` が NOT NULL                                                 | 同上                                      |
| `POST /shops` は `roleGuard(ROLE_ADMIN)` で admin 専用                                                                                | `apps/api/src/routes/shops.ts:59`         |
| `uq_shop_applications_shop_pending` は `shop_id` の部分ユニーク索引（`WHERE status = 'pending'`）                                     | `apps/api/src/db/schema/admin.ts` 末尾    |

| 案                                                                                                                               | 何が起きるか                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 判定     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **案 A** 申請時にサーバが `shops`（`owner_id = NULL` / `status = 'draft'`）と `shop_applications` を**同じ `db.batch()` で**作る | `shop_id` の NOT NULL をそのまま満たす。マイグレーション不要。`POST /shops` は admin 専用のまま（申請の経路は別のエンドポイント）。承認時は Task 9-5 が `shops.owner_id` を埋めて `published` にするだけ                                                                                                                                                                                                                                                                                                                                                           | **採用** |
| **案 B** `shop_id` を NULL 許容にするマイグレーションを切り、承認時に店舗を作る                                                  | (1) `0000_init.sql` は Phase 3 の完了済み成果物で、`apps/api/src/db/migrations.test.ts` 系（`check-constraints.test.ts` / `index.test.ts`）が**マイグレーション SQL の CHECK 名の集合**と Drizzle 定義を突き合わせている。列定義の変更は追加マイグレーションになり、SQLite は `ALTER TABLE ... ALTER COLUMN` を持たないので**テーブル再作成**になる。(2) `uq_shop_applications_shop_pending` が NULL 行に効かなくなり、同一人物が pending を何本でも作れる。(3) Task 9-5 の `approveApplication` が `innerJoin(shops, ...)` を前提にしているので**書き直しになる** | ×        |
| **案 C** admin が先に店舗を作り、申請者がそれを claim する                                                                       | `createShopAsAdmin(db, actor, input, ownerId: UserId, ...)` は `ownerId` が**非 NULL の必須引数**で、オーナー未定の店舗を作る API 経路が存在しない。さらに `visibilityCondition`（`shop-repository.ts:19-29`）により draft は admin 以外から見えないので、申請者は claim 対象を一覧できない                                                                                                                                                                                                                                                                        | ×        |

**案 A を選ぶ。** 追加の判断を 2 つ添える。

- **再提出も `POST /shop-applications` が受ける。** 差し戻し（`returned`）は「フォームを直して出し直す」操作で、送るデータは初回とまったく同じ（店舗情報一式）。別のエンドポイントにすると同じ検証が 2 か所になる。`returned` のときは**新しい `shops` 行を作らず**、既存の下書き店舗を UPDATE して申請を `pending` に戻す（行が増えると孤児の下書きが溜まる）。
- **`rejected` からは再申請させない。** `apps/api/src/db/constants.ts:150-151` のコメント「却下。再申請はできない」に従う。`pending` / `approved` / `rejected` はいずれも 409。

### 追加するエンドポイント（4 本）

| #   | Method | Path                              | 匿名 | user    | owner | admin | 備考                                           |
| --- | ------ | --------------------------------- | ---- | ------- | ----- | ----- | ---------------------------------------------- |
| 33  | GET    | `/masters`                        | 200  | 200     | 200   | 200   | ジャンル / エリアの選択肢。門番なし（公開）    |
| 34  | POST   | `/shop-applications`              | 401  | **201** | 403   | 403   | 初回申請と再提出。下書き店舗 + 申請行を作る    |
| 35  | GET    | `/shop-applications/me`           | 401  | **200** | 403   | 403   | 自分の最新申請（無ければ `application: null`） |
| 36  | POST   | `/shop-applications/me/documents` | 401  | **201** | 403   | 403   | 書類 1 件の追加（R2）。multipart/form-data     |

**この 4 本は `/admin/**` ではないので `DELEGATED_ROUTE_PATTERNS` には入れない。**Phase 4 の `ENDPOINT_CASES` に 4 行足す（Phase 8 と同じやり方）。`DELEGATED_ROUTE_PATTERNS` は 41 本のままである。

### タスク

| #    | 層       | 内容                                                     |
| ---- | -------- | -------------------------------------------------------- |
| 9-25 | API      | 初回申請のリポジトリとマスタ参照                         |
| 9-26 | API      | ルート 4 本・権限行列（83 本 → **87 本**）               |
| 9-27 | モバイル | 申請フォーム画面（Phase 5 のプレースホルダを置き換える） |

---

### Task 9-25: 初回申請のリポジトリ（下書き店舗 + 申請行を 1 バッチで作る）

**Files:**

- Create: `apps/api/src/repositories/shop-application-repository.ts`
- Create: `apps/api/src/repositories/shop-application-repository.test.ts`
- Create: `apps/api/src/repositories/master-repository.ts`
- Create: `apps/api/src/repositories/master-repository.test.ts`

**Interfaces:**

- Consumes:
  - `Database`（`../db/client`）/ `UserActor` / `Viewer`（`../auth/actor`）
  - `shops` / `shopApplications` / `genres` / `areas`（`../db/schema`）、`ApplicationDocument`（`../db/schema/admin`）
  - `APPLICATION_STATUS_PENDING` / `APPLICATION_STATUS_APPROVED` / `APPLICATION_STATUS_REJECTED` / `APPLICATION_STATUS_RETURNED` / `SHOP_STATUS_DRAFT` / `SHOP_GEOHASH_PRECISION`（`../db/constants`）
  - `ShopCreateInput` / `ShopId`（`@meshimap/core`）、`coordinate` / `encodeGeohash`（`@meshimap/geo`）
  - Task 8-2 の `buildApplicationDocumentKey` / `detectMediaType` / `putMediaObject` / `UPLOAD_MAX_BYTES` / `UPLOADABLE_DOCUMENT_MIME_TYPES`（`../lib/media`）
  - `createMigratedD1` / `LocalD1`（`../db/testing/local-d1`）、`buildActorForTest` / `userActorOrThrow`（`../test/fixtures`）
- Produces:
  - `type ShopApplicationRow = typeof shopApplications.$inferSelect`
  - `type SubmitBlockedReason = 'pending' | 'approved' | 'rejected'`
  - `type SubmitOutcome = { readonly ok: true; readonly application: ShopApplicationRow } | { readonly ok: false; readonly reason: SubmitBlockedReason }`
  - `async function findMyLatestApplication(db: Database, actor: UserActor): Promise<ShopApplicationRow | null>`
  - `async function submitShopApplication(db: Database, actor: UserActor, input: ShopCreateInput, shopId: ShopId, applicationId: string, now: Date): Promise<SubmitOutcome>`
  - `type DocumentUploadResult = { readonly ok: true; readonly application: ShopApplicationRow } | { readonly ok: false; readonly reason: 'too-large' | 'unsupported-type' }`
  - `async function appendMyApplicationDocument(db: Database, bucket: R2Bucket, actor: UserActor, uuid: string, kind: string, body: ArrayBuffer): Promise<DocumentUploadResult | null>`
  - `async function listPublicMasters(db: Database, viewer: Viewer): Promise<PublicMasters>` / `type PublicMasters`

**この Task が守る規約（機械検査あり）:**

| 規約                                                                  | 検査しているファイル                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/repositories/*.ts` の export は第 2 引数が Actor 系の型          | `apps/api/src/repositories/repository-convention.test.ts:265` |
| `db.transaction(` を書かない（D1 に対話的トランザクションが無い）     | 同 `:26` / `:238`                                             |
| `toActor` を直接 import しない（テストは `buildActorForTest` を経由） | `apps/api/src/auth/actor-encapsulation.test.ts`               |

`withAuditLog` は使わない。**監査ログは「管理者の操作」を記録するもので、申請者自身の操作は対象外**である（Task 9-2 の静的検査は `admin-` で始まるファイルだけを見るので、このファイルは検査対象外になる）。

- [ ] **Step 1: 着手条件を確認する**

```bash
grep -n 'ownerId' apps/api/src/db/schema/shop.ts
grep -n 'shopId\|updatedAt' apps/api/src/db/schema/admin.ts
grep -n 'export' apps/api/src/lib/media.ts
grep -n 'mediaBucket' apps/api/src/db/testing/local-d1.ts
```

Expected:

- `shops.owner_id` に `.notNull()` が**付いていない**こと（付いていたら案 A は成立しない。その場合はここで止めて計画を見直す）
- `shop_applications.shop_id` に `.notNull()` があり、`updatedAt` が**無い**こと
- `buildApplicationDocumentKey` / `detectMediaType` / `putMediaObject` が export されていること（Task 8-2 の成果物）
- `LocalD1` が `mediaBucket` を持つこと（Task 8-2 の Step 9）

Task 8-2 が未着手で `src/lib/media.ts` が無い場合は、**このタスクを Phase 8 の後ろへ回す**。ここで media を作り直さない。

- [ ] **Step 2: マスタ参照の失敗するテストを書く**

`apps/api/src/repositories/master-repository.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { buildActorForTest } from '../test/fixtures';
import { listPublicMasters } from './master-repository';

let local: LocalD1;
let db: Database;

/** 匿名の閲覧者。`Viewer` は `Actor | AnonymousActor` で、未認証は `role: 'anonymous'` */
const ANONYMOUS = { role: 'anonymous' } as const;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, NULL, ?)')
    .bind('gnr_ramen', 'ラーメン', 'ramen', 1)
    .run();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, NULL, ?)')
    .bind('gnr_izakaya', '居酒屋', 'izakaya', 0)
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)')
    .bind('are_shibuya', '渋谷', null, '東京都')
    .run();
  await local.d1
    .prepare('INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)')
    .bind('are_dogenzaka', '道玄坂', 'are_shibuya', '東京都')
    .run();
});

afterEach(async () => {
  await local.dispose();
});

describe('listPublicMasters', () => {
  it('ジャンルを sort_order の昇順で返す', async () => {
    const masters = await listPublicMasters(db, ANONYMOUS);
    expect(masters.genres.map((genre) => genre.id)).toEqual(['gnr_izakaya', 'gnr_ramen']);
  });

  it('エリアを親 → 子の順で返す（親が NULL のものが先）', async () => {
    const masters = await listPublicMasters(db, ANONYMOUS);
    expect(masters.areas.map((area) => area.id)).toEqual(['are_shibuya', 'are_dogenzaka']);
  });

  it('ログイン済みの閲覧者でも同じ結果になる（公開マスタなので絞り込みが無い）', async () => {
    const actor = buildActorForTest('usr_alice', 'user');
    expect(await listPublicMasters(db, actor)).toEqual(await listPublicMasters(db, ANONYMOUS));
  });

  it('画面が使わない列（slug / icon_key）を返さない', async () => {
    const masters = await listPublicMasters(db, ANONYMOUS);
    expect(Object.keys(masters.genres[0] ?? {})).toEqual(['id', 'name']);
    expect(Object.keys(masters.areas[0] ?? {})).toEqual(['id', 'name', 'parentId', 'prefecture']);
  });
});
```

Run: `npm test -w @meshimap/api -- repositories/master-repository`
Expected: FAIL（`Cannot find module './master-repository'`）

- [ ] **Step 3: マスタ参照を実装する**

```ts
// apps/api/src/repositories/master-repository.ts
import { asc, sql } from 'drizzle-orm';
import type { Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { areas, genres } from '../db/schema';

export type PublicGenre = { readonly id: string; readonly name: string };
export type PublicArea = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly prefecture: string;
};
export type PublicMasters = {
  readonly genres: readonly PublicGenre[];
  readonly areas: readonly PublicArea[];
};

/**
 * 店舗申請フォームと検索フィルタが使う選択肢。
 * 閲覧者によって中身が変わらないので `_viewer` は使わない。
 * それでも引数に残すのは `repository-convention.test.ts` が
 * 「リポジトリの第 2 引数は Actor 系」を機械検査しているためで、
 * ここだけ例外を作ると検査そのものが緩む。
 */
export async function listPublicMasters(db: Database, _viewer: Viewer): Promise<PublicMasters> {
  const genreRows = await db
    .select({ id: genres.id, name: genres.name })
    .from(genres)
    .orderBy(asc(genres.sortOrder), asc(genres.id));
  const areaRows = await db
    .select({
      id: areas.id,
      name: areas.name,
      parentId: areas.parentId,
      prefecture: areas.prefecture,
    })
    .from(areas)
    // 親（parent_id IS NULL）を先に出す。画面は親を見出しにして子を並べる
    .orderBy(sql`${areas.parentId} is not null`, asc(areas.id));
  return { genres: genreRows, areas: areaRows };
}
```

Run: `npm test -w @meshimap/api -- repositories/master-repository`
Expected: PASS（4 件）

- [ ] **Step 4: 申請リポジトリの失敗するテストを書く（読み取りと初回申請）**

`apps/api/src/repositories/shop-application-repository.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShopCreateInput, ShopId } from '@meshimap/core';
import { toShopId } from '@meshimap/core';
import type { UserActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import {
  APPLICATION_STATUS_APPROVED,
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUS_REJECTED,
  APPLICATION_STATUS_RETURNED,
  SHOP_STATUS_DRAFT,
} from '../db/constants';
import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { buildActorForTest, userActorOrThrow } from '../test/fixtures';
import { findMyLatestApplication, submitShopApplication } from './shop-application-repository';

let local: LocalD1;
let db: Database;
let alice: UserActor;
let bob: UserActor;

const NOW = new Date('2026-09-16T03:00:00Z');
const SHOP_ID = toShopId('shp_new');
const APPLICATION_ID = 'app_new';

/** shopCreateSchema を満たす最小の入力。NOT NULL 列を全部埋める */
const INPUT: ShopCreateInput = {
  name: '申請ラーメン',
  nameKana: 'シンセイラーメン',
  genreId: 'gnr_ramen',
  areaId: 'are_shibuya',
  description: '',
  postalCode: '150-0043',
  address: '東京都渋谷区道玄坂 1-1-1',
  latitude: 35.658,
  longitude: 139.7016,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

async function seedUserRow(userId: string): Promise<void> {
  await local.d1
    .prepare(
      'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
    )
    .bind(userId, userId, `${userId}@example.com`)
    .run();
  await local.d1
    .prepare(
      "INSERT INTO profiles (user_id, role, status, display_name, created_at) VALUES (?, 'user', 'active', ?, 0)",
    )
    .bind(userId, userId)
    .run();
}

/** 既存の申請を 1 件置く。`shop_applications.shop_id` は NOT NULL なので店舗も一緒に作る */
async function seedApplication(
  applicationId: string,
  shopId: string,
  applicantId: string,
  status: string,
  createdAt: number,
): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO shops (id, owner_id, name, name_kana, genre_id, area_id, address, lat, lng, geohash, status, created_at, updated_at)
       VALUES (?, NULL, '既存店', 'キソンテン', 'gnr_ramen', 'are_shibuya', '東京都渋谷区道玄坂 1-1-1', 35.658, 139.7016, 'xn76fgr', 'draft', 0, 0)`,
    )
    .bind(shopId)
    .run();
  // updated_at 列は shop_applications に無い（db/schema/admin.ts:105-128）。足さないこと
  await local.d1
    .prepare(
      `INSERT INTO shop_applications (id, applicant_id, shop_id, documents, status, reviewed_by, review_note, created_at)
       VALUES (?, ?, ?, '[]', ?, NULL, ?, ?)`,
    )
    .bind(
      applicationId,
      applicantId,
      shopId,
      status,
      status === APPLICATION_STATUS_RETURNED ? '営業許可証が不鮮明です' : null,
      createdAt,
    )
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  await local.d1
    .prepare(
      "INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES ('gnr_ramen', 'ラーメン', 'ramen', NULL, 0)",
    )
    .run();
  await local.d1
    .prepare(
      "INSERT INTO areas (id, name, parent_id, prefecture) VALUES ('are_shibuya', '渋谷', NULL, '東京都')",
    )
    .run();
  await seedUserRow('usr_alice');
  await seedUserRow('usr_bob');
  alice = userActorOrThrow(buildActorForTest('usr_alice', 'user'));
  bob = userActorOrThrow(buildActorForTest('usr_bob', 'user'));
});

afterEach(async () => {
  await local.dispose();
});

describe('findMyLatestApplication', () => {
  it('申請が無ければ null を返す', async () => {
    expect(await findMyLatestApplication(db, alice)).toBeNull();
  });

  it('自分の最新の申請を返す', async () => {
    await seedApplication('app_old', 'shp_old', 'usr_alice', APPLICATION_STATUS_REJECTED, 1000);
    await seedApplication('app_new', 'shp_new2', 'usr_alice', APPLICATION_STATUS_RETURNED, 2000);
    expect((await findMyLatestApplication(db, alice))?.id).toBe('app_new');
  });

  it('他人の申請は見えない', async () => {
    await seedApplication('app_bob', 'shp_bob', 'usr_bob', APPLICATION_STATUS_PENDING, 1000);
    expect(await findMyLatestApplication(db, alice)).toBeNull();
  });

  it('差し戻し理由を読み取れる', async () => {
    await seedApplication('app_r', 'shp_r', 'usr_alice', APPLICATION_STATUS_RETURNED, 1000);
    expect((await findMyLatestApplication(db, alice))?.reviewNote).toBe('営業許可証が不鮮明です');
  });
});

describe('submitShopApplication（初回）', () => {
  it('下書き店舗と申請行を作る', async () => {
    const outcome = await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    expect(outcome.ok).toBe(true);
    const shop = await local.d1
      .prepare('SELECT owner_id, status, geohash FROM shops WHERE id = ?')
      .bind(SHOP_ID)
      .first<{ owner_id: string | null; status: string; geohash: string }>();
    // owner_id は承認まで NULL。承認で Task 9-5 が申請者を入れる
    expect(shop?.owner_id).toBeNull();
    expect(shop?.status).toBe(SHOP_STATUS_DRAFT);
    // geohash は入力から計算する。クライアントに送らせない
    expect(shop?.geohash).toBe('xn76fgr');
  });

  it('申請は pending で、申請者と店舗が紐づく', async () => {
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const row = await local.d1
      .prepare(
        'SELECT applicant_id, shop_id, status, documents FROM shop_applications WHERE id = ?',
      )
      .bind(APPLICATION_ID)
      .first<{ applicant_id: string; shop_id: string; status: string; documents: string }>();
    expect(row).toEqual({
      applicant_id: 'usr_alice',
      shop_id: SHOP_ID,
      status: APPLICATION_STATUS_PENDING,
      documents: '[]',
    });
  });

  it('審査待ちの申請があるときは pending で弾く', async () => {
    await seedApplication('app_p', 'shp_p', 'usr_alice', APPLICATION_STATUS_PENDING, 1000);
    expect(await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW)).toEqual({
      ok: false,
      reason: 'pending',
    });
  });

  it('承認済みなら approved で弾く（オーナーは Phase 8 の再提出経路を使う）', async () => {
    await seedApplication('app_a', 'shp_a', 'usr_alice', APPLICATION_STATUS_APPROVED, 1000);
    expect(await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW)).toEqual({
      ok: false,
      reason: 'approved',
    });
  });

  it('却下済みなら rejected で弾く（constants.ts の「再申請はできない」に従う）', async () => {
    await seedApplication('app_x', 'shp_x', 'usr_alice', APPLICATION_STATUS_REJECTED, 1000);
    expect(await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW)).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('他人が pending を持っていても自分の申請は通る', async () => {
    await seedApplication('app_bob', 'shp_bob', 'usr_bob', APPLICATION_STATUS_PENDING, 1000);
    expect((await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW)).ok).toBe(
      true,
    );
  });

  it('弾かれたときは店舗行を 1 行も作らない', async () => {
    await seedApplication('app_p', 'shp_p', 'usr_alice', APPLICATION_STATUS_PENDING, 1000);
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const row = await local.d1
      .prepare('SELECT count(*) as count FROM shops WHERE id = ?')
      .bind(SHOP_ID)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});

describe('submitShopApplication（再提出）', () => {
  it('差し戻しからは同じ店舗行を書き換えて pending に戻す', async () => {
    await seedApplication('app_r', 'shp_r', 'usr_alice', APPLICATION_STATUS_RETURNED, 1000);

    const outcome = await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    expect(outcome.ok).toBe(true);
    const application = await findMyLatestApplication(db, alice);
    // 新しい行を作らない。差し戻された申請そのものを pending に戻す
    expect(application?.id).toBe('app_r');
    expect(application?.status).toBe(APPLICATION_STATUS_PENDING);
    // 差し戻し理由は消す。次の審査結果で上書きされるまで残すと画面が古い理由を出し続ける
    expect(application?.reviewNote).toBeNull();
  });

  it('再提出では店舗行が増えない', async () => {
    await seedApplication('app_r', 'shp_r', 'usr_alice', APPLICATION_STATUS_RETURNED, 1000);
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const row = await local.d1
      .prepare('SELECT count(*) as count FROM shops')
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it('再提出で店舗の内容が入力どおりに書き換わる', async () => {
    await seedApplication('app_r', 'shp_r', 'usr_alice', APPLICATION_STATUS_RETURNED, 1000);
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const row = await local.d1
      .prepare('SELECT name, status, owner_id FROM shops WHERE id = ?')
      .bind('shp_r')
      .first<{ name: string; status: string; owner_id: string | null }>();
    expect(row).toEqual({ name: '申請ラーメン', status: SHOP_STATUS_DRAFT, owner_id: null });
  });
});
```

Run: `npm test -w @meshimap/api -- repositories/shop-application-repository`
Expected: FAIL（`Cannot find module './shop-application-repository'`）

- [ ] **Step 5: 申請リポジトリを実装する**

```ts
// apps/api/src/repositories/shop-application-repository.ts
import type { ShopCreateInput, ShopId } from '@meshimap/core';
import { coordinate, encodeGeohash } from '@meshimap/geo';
import { and, desc, eq } from 'drizzle-orm';
import type { UserActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  APPLICATION_STATUS_APPROVED,
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUS_REJECTED,
  APPLICATION_STATUS_RETURNED,
  SHOP_GEOHASH_PRECISION,
  SHOP_STATUS_DRAFT,
} from '../db/constants';
import { shopApplications, shops } from '../db/schema';
import type { ApplicationDocument } from '../db/schema/admin';
import {
  buildApplicationDocumentKey,
  detectMediaType,
  putMediaObject,
  UPLOAD_MAX_BYTES,
  UPLOADABLE_DOCUMENT_MIME_TYPES,
} from '../lib/media';

export type ShopApplicationRow = typeof shopApplications.$inferSelect;

/** 申請を受け付けられない理由。ルート層はこれをそのまま 409 に写す */
export type SubmitBlockedReason = 'pending' | 'approved' | 'rejected';

export type SubmitOutcome =
  | { readonly ok: true; readonly application: ShopApplicationRow }
  | { readonly ok: false; readonly reason: SubmitBlockedReason };

export type DocumentUploadResult =
  | { readonly ok: true; readonly application: ShopApplicationRow }
  | { readonly ok: false; readonly reason: 'too-large' | 'unsupported-type' };

/**
 * `ShopCreateInput` を shops の列へ写す。
 * プロパティ名が一致しない（latitude→lat, budgetLunchMinYen→budgetLunchMin）ため 1 対 1 で書き下す。
 * geohash は**必ずサーバで計算する**。クライアントに送らせると座標と矛盾したセルが入る。
 */
function toShopValues(input: ShopCreateInput) {
  return {
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
  };
}

export async function findMyLatestApplication(
  db: Database,
  actor: UserActor,
): Promise<ShopApplicationRow | null> {
  const rows = await db
    .select()
    .from(shopApplications)
    // 所有権は WHERE 句で表現する。取得後に絞ると書き忘れがそのまま情報漏洩になる
    .where(eq(shopApplications.applicantId, actor.userId))
    .orderBy(desc(shopApplications.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 初回申請と差し戻しからの再提出の両方を受ける。
 *
 * D1 に対話的トランザクションが無いので `db.batch()` で 1 往復にまとめる
 * （`db.transaction(` は `repository-convention.test.ts` が禁止している）。
 * 直前に読んだ状態は UPDATE の WHERE に**再掲**して、読んでから書くまでの間に
 * 審査結果が変わっていたら 0 行になるようにする。
 */
export async function submitShopApplication(
  db: Database,
  actor: UserActor,
  input: ShopCreateInput,
  shopId: ShopId,
  applicationId: string,
  now: Date,
): Promise<SubmitOutcome> {
  const latest = await findMyLatestApplication(db, actor);

  if (latest?.status === APPLICATION_STATUS_PENDING) {
    return { ok: false, reason: 'pending' };
  }
  if (latest?.status === APPLICATION_STATUS_APPROVED) {
    return { ok: false, reason: 'approved' };
  }
  if (latest?.status === APPLICATION_STATUS_REJECTED) {
    return { ok: false, reason: 'rejected' };
  }

  if (latest !== null && latest.status === APPLICATION_STATUS_RETURNED) {
    // 再提出。店舗行を作り直すと孤児の下書きが溜まるので、同じ行を書き換える
    const [, updated] = await db.batch([
      db
        .update(shops)
        .set({ ...toShopValues(input), updatedAt: now })
        .where(and(eq(shops.id, latest.shopId), eq(shops.status, SHOP_STATUS_DRAFT))),
      db
        .update(shopApplications)
        .set({ status: APPLICATION_STATUS_PENDING, reviewNote: null })
        .where(
          and(
            eq(shopApplications.id, latest.id),
            eq(shopApplications.applicantId, actor.userId),
            // 読んでから書くまでに承認されていたら 0 行になる
            eq(shopApplications.status, APPLICATION_STATUS_RETURNED),
          ),
        )
        .returning(),
    ]);
    const row = updated[0];
    return row === undefined ? { ok: false, reason: 'pending' } : { ok: true, application: row };
  }

  const [, inserted] = await db.batch([
    db.insert(shops).values({
      id: shopId,
      // 承認まで owner は決まらない。shops.owner_id は NULL 可（schema/shop.ts のコメントどおり）
      ownerId: null,
      ...toShopValues(input),
      status: SHOP_STATUS_DRAFT,
      createdAt: now,
      updatedAt: now,
    }),
    db
      .insert(shopApplications)
      .values({
        id: applicationId,
        applicantId: actor.userId,
        shopId,
        documents: [],
        status: APPLICATION_STATUS_PENDING,
        createdAt: now,
      })
      .returning(),
  ]);
  const row = inserted[0];
  if (row === undefined) {
    // INSERT ... RETURNING が 0 件を返すのは D1 側の異常。握り潰さない
    throw new Error('店舗申請の作成に失敗した');
  }
  return { ok: true, application: row };
}

/**
 * 書類を 1 件足す。Phase 8 の `appendApplicationDocumentAsOwner` と同じ検証を
 * `UserActor` に対して行う。owner 版とまとめないのは、まとめると関数の中に
 * 「どちらの WHERE を組むか」の分岐が入り、設計書 3.2 が避けたい形に戻るため。
 */
export async function appendMyApplicationDocument(
  db: Database,
  bucket: R2Bucket,
  actor: UserActor,
  uuid: string,
  kind: string,
  body: ArrayBuffer,
): Promise<DocumentUploadResult | null> {
  const application = await findMyLatestApplication(db, actor);
  if (application === null) {
    return null;
  }
  if (body.byteLength > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  const detected = detectMediaType(new Uint8Array(body));
  if (detected === null) {
    return { ok: false, reason: 'unsupported-type' };
  }
  const isUploadableDocument = UPLOADABLE_DOCUMENT_MIME_TYPES.some(
    (mime) => mime === detected.mimeType,
  );
  if (!isUploadableDocument) {
    return { ok: false, reason: 'unsupported-type' };
  }
  const key = buildApplicationDocumentKey(actor.userId, uuid, detected.extension);
  await putMediaObject(bucket, key, body, detected.mimeType);
  const nextDocuments: readonly ApplicationDocument[] = [
    ...application.documents,
    { kind, r2Key: key },
  ];
  const updated = await db
    .update(shopApplications)
    .set({ documents: nextDocuments })
    .where(
      and(
        eq(shopApplications.id, application.id),
        eq(shopApplications.applicantId, actor.userId),
        // 審査が終わった申請には足せない
        eq(shopApplications.status, APPLICATION_STATUS_PENDING),
      ),
    )
    .returning();
  const row = updated[0];
  return row === undefined ? null : { ok: true, application: row };
}
```

Run: `npm test -w @meshimap/api -- repositories/shop-application-repository`
Expected: PASS（14 件）

- [ ] **Step 6: 書類追加のテストを書いて通す**

`shop-application-repository.test.ts` に追記する。`local.mediaBucket`（Task 8-2）を使う。

```ts
function pdfBytes(totalLength: number): ArrayBuffer {
  const bytes = new Uint8Array(totalLength);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
  return bytes.buffer;
}

describe('appendMyApplicationDocument', () => {
  it('申請が無ければ null を返す', async () => {
    expect(
      await appendMyApplicationDocument(
        db,
        local.mediaBucket,
        alice,
        'dd01',
        '営業許可証',
        pdfBytes(64),
      ),
    ).toBeNull();
  });

  it('R2 に置き、documents に追記する', async () => {
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const result = await appendMyApplicationDocument(
      db,
      local.mediaBucket,
      alice,
      'dd01',
      '営業許可証',
      pdfBytes(64),
    );

    expect(result).toEqual({
      ok: true,
      application: expect.objectContaining({
        documents: [{ kind: '営業許可証', r2Key: 'application-documents/usr_alice/dd01.pdf' }],
      }),
    });
    expect(await local.mediaBucket.get('application-documents/usr_alice/dd01.pdf')).not.toBeNull();
  });

  it('大きすぎるものは too-large で断り、R2 に置かない', async () => {
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    const result = await appendMyApplicationDocument(
      db,
      local.mediaBucket,
      alice,
      'dd02',
      '営業許可証',
      pdfBytes(UPLOAD_MAX_BYTES + 1),
    );

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(await local.mediaBucket.get('application-documents/usr_alice/dd02.pdf')).toBeNull();
  });

  it('拡張子ではなくバイト列で判定する（中身が PDF でなければ断る）', async () => {
    await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW);

    expect(
      await appendMyApplicationDocument(
        db,
        local.mediaBucket,
        alice,
        'dd03',
        '営業許可証',
        new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer,
      ),
    ).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('審査が終わった申請には足せない', async () => {
    await seedApplication('app_a', 'shp_a', 'usr_alice', APPLICATION_STATUS_APPROVED, 1000);
    expect(
      await appendMyApplicationDocument(
        db,
        local.mediaBucket,
        alice,
        'dd04',
        '営業許可証',
        pdfBytes(64),
      ),
    ).toBeNull();
  });

  it('他人の申請には足せない', async () => {
    await seedApplication('app_bob', 'shp_bob', 'usr_bob', APPLICATION_STATUS_PENDING, 1000);
    expect(
      await appendMyApplicationDocument(
        db,
        local.mediaBucket,
        alice,
        'dd05',
        '営業許可証',
        pdfBytes(64),
      ),
    ).toBeNull();
  });
});
```

Run: `npm test -w @meshimap/api -- repositories/shop-application-repository`
Expected: PASS（20 件）

- [ ] **Step 7: わざと壊して、所有権と状態の門が効いていることを確かめる**

1 つずつ壊して、1 つずつ戻す。

1. `findMyLatestApplication` の `where` から `eq(shopApplications.applicantId, actor.userId)` を外す → FAIL。「他人の申請は見えない」と「他人の申請には足せない」が落ちる。**所有権が WHERE 句で効いていることの確認。**
2. `submitShopApplication` の `rejected` の分岐を消す → FAIL。「却下済みなら rejected で弾く」が `{ ok: true, ... }` を受け取って落ちる。
3. 再提出の UPDATE の WHERE から `eq(shopApplications.status, APPLICATION_STATUS_RETURNED)` を外す → **落ちない。** ここに検査が無いことが分かるので、「承認済みの申請を差し戻しと誤認して pending に戻す」テストを 1 件足してから戻す。

```ts
it('読んだあとに承認された申請は再提出で pending に戻らない', async () => {
  await seedApplication('app_r', 'shp_r', 'usr_alice', APPLICATION_STATUS_RETURNED, 1000);
  // findMyLatestApplication の直後に他所（審査画面）で承認された状況を作る
  await local.d1
    .prepare("UPDATE shop_applications SET status = 'approved' WHERE id = 'app_r'")
    .run();

  expect(await submitShopApplication(db, alice, INPUT, SHOP_ID, APPLICATION_ID, NOW)).toEqual({
    ok: false,
    reason: 'approved',
  });
});
```

4. `toShopValues` の `geohash` を `input.address` に差し替える → FAIL。`ck_shops_geohash_length` / `ck_shops_geohash_alphabet` が D1 側で落ちる。**CHECK 制約が本物の SQLite で効いていることの確認。**

```bash
git diff --stat
```

Expected: 壊した箇所が残っていないこと。

- [ ] **Step 8: 型・書式を通してコミットする**

```bash
npm run typecheck -w @meshimap/api
npm run format:check
git add apps/api/src/repositories/shop-application-repository.ts apps/api/src/repositories/shop-application-repository.test.ts apps/api/src/repositories/master-repository.ts apps/api/src/repositories/master-repository.test.ts
git commit -m "feat(api): 初回店舗申請のリポジトリと公開マスタ参照を足す"
```

---

### Task 9-26: 初回申請のルート 4 本と権限行列（83 本 → 87 本）

Task 9-17 で `EXPECTED_ROUTE_PATTERNS` は 83 本になっている。ここで 4 本足して **87 本**にする。**`DELEGATED_ROUTE_PATTERNS` は 41 本のまま**である（この 4 本は `/admin/**` ではないので、主体ごとの期待ステータスは Phase 4 の `ENDPOINT_CASES` が直接持つ）。

**Files:**

- Create: `apps/api/src/routes/shop-applications.ts`
- Create: `apps/api/src/routes/shop-applications.test.ts`
- Create: `apps/api/src/routes/masters.ts`
- Modify: `apps/api/src/index.ts`（`.route()` を 2 行足す）
- Modify: `apps/api/src/test/fixtures.ts`（`TestWorld` と `TestBindings` に R2 を足す）
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（`EXPECTED_ROUTE_PATTERNS` と `ENDPOINT_CASES`）

**Interfaces:**

- Consumes: Task 9-25 の 4 関数、`jsonBody`（`../lib/validate`）、`roleGuard` / `requireUserActor`（`../middleware/role-guard`）、`conflict`（Task 9-0）、`invalidInput` / `notFound`、`generateShopId`（`../lib/parse-id`）、`shopCreateSchema`（`@meshimap/core`）
- Produces: `shopApplicationRoutes` / `masterRoutes` / `generateApplicationId(): string`

**先に決めておくこと（後から変えると権限行列が割れる）:**

| 決めごと                                     | 内容                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 門番                                         | `shopApplicationRoutes` に `use('*', roleGuard(ROLE_USER))` を **1 回だけ**掛ける。`owner` と `admin` は 403。個々のハンドラに `roleGuard` を書かない |
| `GET /masters` の門番                        | **掛けない。** 検索フィルタも同じ選択肢を使うので公開にする。匿名 200                                                                                 |
| `GET /shop-applications/me` が申請無しのとき | **200 で `{ application: null }`**。404 にしない（「まだ出していない」は異常ではない）。Phase 8 の `GET /owner/application` と同じ扱い                |
| 409 になる 3 つの理由                        | `pending` / `approved` / `rejected`。**本文では区別しない**（`ERROR_MESSAGE_CONFLICT` の固定文言）。区別すると他人の申請状態を突くのに使える          |
| 申請 ID の採番                               | サーバ側（`generateApplicationId()`）。クライアントに決めさせると既存 ID との衝突で存在有無を探れる（`lib/parse-id.ts` の既存コメントと同じ理由）     |

- [ ] **Step 1: テスト用バインディングに R2 があることを確かめ、無ければ足す**

```bash
grep -n 'MEDIA\|mediaBucket' apps/api/src/test/fixtures.ts
```

Expected: `TestWorld` に `mediaBucket`、`TestBindings` に `MEDIA` があること。

**2026-09-16 時点の実ファイルにはどちらも無い**（`TestWorld = { d1, dispose }` / `TestBindings = Pick<AppBindings, 'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'>`）。無ければここで足す。`createMigratedD1()` は Task 8-2 で `mediaBucket` を返すようになっているので、受け取って渡すだけでよい。

```ts
// apps/api/src/test/fixtures.ts
export type TestWorld = {
  readonly d1: D1Database;
  /** Task 8-2 が miniflare に足した R2。ダミーを `as` で捏造しない */
  readonly mediaBucket: R2Bucket;
  readonly dispose: () => Promise<void>;
};

export async function createTestWorld(): Promise<TestWorld> {
  const local = await createMigratedD1();
  return { d1: local.d1, mediaBucket: local.mediaBucket, dispose: local.dispose };
}

export type TestBindings = Pick<
  AppBindings,
  'DB' | 'MEDIA' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'
>;

export function createTestBindings(world: TestWorld): TestBindings {
  return {
    DB: world.d1,
    MEDIA: world.mediaBucket,
    BETTER_AUTH_SECRET: TEST_BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    MOBILE_APP_SCHEME: TEST_MOBILE_APP_SCHEME,
  };
}
```

> `createMigratedD1()` が返すキー名は `d1`（`apps/api/src/db/testing/local-d1.ts:26-29` で実測）。Task 8-2 は `mediaBucket: R2Bucket` を**足すだけ**で `d1` は改名しない（改名すると `src/test/fixtures.ts:40` / `src/db/seed.test.ts` / `src/db/client.test.ts:43` / `src/db/queries/nearby-shops.test.ts:48` が一斉に落ちる）。この計画書のコードも `local.d1` で統一してある。

Run: `npm run typecheck -w @meshimap/api`
Expected: PASS

- [ ] **Step 2: ルートの失敗するテストを書く**

`apps/api/src/routes/shop-applications.test.ts`

```ts
import { afterEach, beforeEach, expect, describe, it } from 'vitest';
import { ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { app } from '../index';
import {
  createTestBindings,
  createTestWorld,
  seedMasters,
  signUpAs,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';

let world: TestWorld;

const BODY = {
  name: '申請ラーメン',
  nameKana: 'シンセイラーメン',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '150-0043',
  address: '東京都渋谷区道玄坂 1-1-1',
  latitude: 35.658,
  longitude: 139.7016,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

async function post(cookie: string, body: unknown): Promise<Response> {
  return await app.request(
    '/shop-applications',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    },
    createTestBindings(world),
  );
}

beforeEach(async () => {
  world = await createTestWorld();
  await seedMasters(world);
});

afterEach(async () => {
  await world.dispose();
});

describe('GET /masters', () => {
  it('未ログインでも 200 で選択肢を返す', async () => {
    const response = await app.request('/masters', {}, createTestBindings(world));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      genres: [{ id: TEST_GENRE_ID, name: 'ラーメン' }],
      areas: [{ id: TEST_AREA_ID, name: '渋谷', parentId: null, prefecture: '東京都' }],
    });
  });
});

describe('POST /shop-applications', () => {
  it('user は 201 で申請を作れる', async () => {
    const applicant = await signUpAs(world, 'applicant@example.com', ROLE_USER);
    const response = await post(applicant.cookie, BODY);

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { application: { status: string } };
    expect(payload.application.status).toBe('pending');
  });

  it('二重申請は 409 で、文言は理由を明かさない', async () => {
    const applicant = await signUpAs(world, 'applicant@example.com', ROLE_USER);
    await post(applicant.cookie, BODY);

    const response = await post(applicant.cookie, BODY);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { status: 409, message: '対象の状態が変わっています' },
    });
  });

  it('owner は 403（申請済みの人は Phase 8 の再提出経路を使う）', async () => {
    const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
    expect((await post(owner.cookie, BODY)).status).toBe(403);
  });

  it('未ログインは 401', async () => {
    const response = await app.request(
      '/shop-applications',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BODY),
      },
      createTestBindings(world),
    );
    expect(response.status).toBe(401);
  });

  it('入力が不正なら 422 で、どのフィールドが悪いかは返さない', async () => {
    const applicant = await signUpAs(world, 'applicant@example.com', ROLE_USER);
    const response = await post(applicant.cookie, { ...BODY, name: '' });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toContain('name');
  });

  it('403 で弾かれたとき shops に 1 行も増えていない', async () => {
    const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
    await post(owner.cookie, BODY);

    const row = await world.d1
      .prepare('SELECT count(*) as count FROM shops')
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});

describe('GET /shop-applications/me', () => {
  it('申請が無ければ 200 で application が null', async () => {
    const applicant = await signUpAs(world, 'applicant@example.com', ROLE_USER);
    const response = await app.request(
      '/shop-applications/me',
      { headers: { cookie: applicant.cookie } },
      createTestBindings(world),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ application: null });
  });

  it('他人の申請は見えない', async () => {
    const applicant = await signUpAs(world, 'applicant@example.com', ROLE_USER);
    await post(applicant.cookie, BODY);
    const stranger = await signUpAs(world, 'stranger@example.com', ROLE_USER);

    const response = await app.request(
      '/shop-applications/me',
      { headers: { cookie: stranger.cookie } },
      createTestBindings(world),
    );
    expect(await response.json()).toEqual({ application: null });
  });
});
```

Run: `npm test -w @meshimap/api -- routes/shop-applications`
Expected: FAIL（すべて 404。ルートがまだ無い）

- [ ] **Step 3: ルートを実装する**

```ts
// apps/api/src/routes/masters.ts
import { Hono } from 'hono';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { listPublicMasters } from '../repositories/master-repository';

/** 公開マスタ。門番を掛けない（検索フィルタも申請フォームも同じ選択肢を使う） */
export const masterRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const masters = await listPublicMasters(createDatabase(c.env.DB), c.get('viewer'));
  return c.json(masters);
});
```

```ts
// apps/api/src/routes/shop-applications.ts
import { ROLE_USER, shopCreateSchema } from '@meshimap/core';
import { Hono } from 'hono';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { conflict, invalidInput, notFound } from '../lib/http-error';
import { generateShopId } from '../lib/parse-id';
import { jsonBody } from '../lib/validate';
import { requireUserActor, roleGuard } from '../middleware/role-guard';
import {
  appendMyApplicationDocument,
  findMyLatestApplication,
  submitShopApplication,
} from '../repositories/shop-application-repository';

/** 書類アップロードのフィールド名。モバイル側と 1 語でもずれると 422 になる */
const UPLOAD_FIELD_NAME = 'file';
const KIND_FIELD_NAME = 'kind';

/**
 * 申請 ID はサーバで採番する。クライアントに決めさせると、既存 ID との衝突を試して
 * 存在有無を探れる（`lib/parse-id.ts` の `generateShopId` と同じ理由）。
 */
export function generateApplicationId(): string {
  return `app_${crypto.randomUUID()}`;
}

export const shopApplicationRoutes = new Hono<AppEnv>()
  // 門番はここに 1 回だけ。個々のハンドラに roleGuard を書かない
  .use('*', roleGuard(ROLE_USER))
  .post('/', jsonBody(shopCreateSchema), async (c) => {
    const actor = requireUserActor(c);
    const outcome = await submitShopApplication(
      createDatabase(c.env.DB),
      actor,
      c.req.valid('json'),
      generateShopId(),
      generateApplicationId(),
      new Date(),
    );
    if (!outcome.ok) {
      // pending / approved / rejected を本文で区別しない。区別すると状態を突く手掛かりになる
      throw conflict();
    }
    return c.json({ application: outcome.application }, 201);
  })
  .get('/me', async (c) => {
    const actor = requireUserActor(c);
    // 「まだ出していない」は異常ではないので 404 にしない
    const application = await findMyLatestApplication(createDatabase(c.env.DB), actor);
    return c.json({ application });
  })
  .post('/me/documents', async (c) => {
    const actor = requireUserActor(c);
    const form = await c.req.formData();
    const file = form.get(UPLOAD_FIELD_NAME);
    const kind = form.get(KIND_FIELD_NAME);
    if (!(file instanceof File) || typeof kind !== 'string' || kind === '') {
      throw invalidInput();
    }
    const result = await appendMyApplicationDocument(
      createDatabase(c.env.DB),
      c.env.MEDIA,
      actor,
      crypto.randomUUID(),
      kind,
      await file.arrayBuffer(),
    );
    // 申請が無い / 審査が終わっている / 他人のもの はすべて 404 に寄せる
    if (result === null) {
      throw notFound();
    }
    if (!result.ok) {
      throw invalidInput();
    }
    return c.json({ application: result.application }, 201);
  });
```

`apps/api/src/index.ts` のメソッドチェーンに 2 行足す。**チェーンを切らないこと**（切ると `AppType` が痩せて `rpc-contract.test.ts` が落ちる）。

```ts
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/masters', masterRoutes)
  .route('/me', meRoutes)
  .route('/shop-applications', shopApplicationRoutes)
  .route('/shops', shopRoutes)
  .route('/reviews', reviewRoutes);
```

Run: `npm test -w @meshimap/api -- routes/shop-applications`
Expected: PASS（10 件）。ただし `routes/permission-matrix` は**落ちる**（次の Step で直す）。

- [ ] **Step 4: 権限行列を 87 本にする**

Phase 7 が確立した 4 手順（Phase 7 計画書 2470-2530 行）に従う。**この Step を同じコミットに入れること。**

(1) `EXPECTED_ROUTE_PATTERNS` に 4 本足す。**ソート順を保つ**（`collectEndpointPatterns` が `.sort()` して返す）。比較は UTF-16 コード単位の辞書順で `-` は 0x2D、`/` は 0x2F、英小文字は 0x61 以降なので、

- `'GET /masters'` は `'GET /health'` の後、`'GET /me'` の前（`ma` < `me`）
- `'GET /shop-applications/me'` は `'GET /shops'` の**前**（`shop-` の `-`(0x2D) < `shops` の `s`(0x73)）
- `'POST /shop-applications'` → `'POST /shop-applications/me/documents'` → `'POST /shops'` の順

```ts
/** 権限マトリクスが責任を持つ 87 本。ここを増減させるときは必ず ENDPOINT_CASES か DELEGATED_ROUTE_PATTERNS も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  // …（管理系 32 本と既存 51 本はそのまま）
  'GET /health',
  'GET /masters',
  'GET /me',
  // …
  'GET /shop-applications/me',
  'GET /shops',
  // …
  'POST /shop-applications',
  'POST /shop-applications/me/documents',
  'POST /shops',
  // …
];
```

(2) テスト名の数字を直す。

```ts
it('app に登録されたエンドポイントは 87 本で、想定どおりの並びである', () => {
```

(3) `DELEGATED_ROUTE_PATTERNS` は**触らない**（41 本のまま）。この 4 本は `/admin/**` でも予約系でもないので、`DELEGATABLE_PATH_PATTERN` にも当たらない。当たってしまうなら正規表現が広すぎる。

(4) `ENDPOINT_CASES` に 4 行足す。`no` は既存の最後（13）の続き。

```ts
  {
    no: 14,
    label: 'GET /masters',
    method: 'GET',
    path: '/masters',
    routePattern: 'GET /masters',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 15,
    label: 'POST /shop-applications',
    method: 'POST',
    path: '/shop-applications',
    routePattern: 'POST /shop-applications',
    body: NEW_SHOP_BODY,
    expected: { anonymous: 401, user: 201, owner: 403, admin: 403 },
  },
  {
    no: 16,
    label: 'GET /shop-applications/me',
    method: 'GET',
    path: '/shop-applications/me',
    routePattern: 'GET /shop-applications/me',
    expected: { anonymous: 401, user: 200, owner: 403, admin: 403 },
  },
  {
    no: 17,
    label: 'POST /shop-applications/me/documents（申請が無い状態）',
    method: 'POST',
    path: '/shop-applications/me/documents',
    routePattern: 'POST /shop-applications/me/documents',
    expected: { anonymous: 401, user: 404, owner: 403, admin: 403 },
  },
```

**#15 の `body` に `NEW_SHOP_BODY` をそのまま使えるのは、申請の本文が `shopCreateSchema` そのものだからである。**#17 が `user: 404` なのは、`setUpWorld` が申請行を作らないため（`appendMyApplicationDocument` が `null` を返す）。**書類を持つケースは `routes/shop-applications.test.ts` が持つ。**#17 の `body` を省いているので `c.req.formData()` は空のフォームになり、`file` が `File` でないため…**とはならない。**`requireUserActor` → `findMyLatestApplication` の順で 404 が先に出るのが正しい実装で、`formData()` の検査が先に走ると 422 になる。上のハンドラは `formData()` を先に読むので **422 になる**。ここは 2 つに 1 つを選ぶ:

| 選択                                     | 結果                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| ハンドラで `formData()` の検査を先にする | #17 の期待値は `user: 422`。入力の形が先に分かるので、申請の有無を問い合わせずに弾ける |
| 申請の存在確認を先にする                 | #17 の期待値は `user: 404`。申請が無い人には R2 も触らせない                           |

**後者を選ぶ。**R2 への `put` はコストがかかる操作で、申請を出していない人に走らせない。上のハンドラの `const form = await c.req.formData();` の前に次を入れること。

```ts
// 申請が無い人には multipart の解析も R2 の put もさせない
if ((await findMyLatestApplication(createDatabase(c.env.DB), actor)) === null) {
  throw notFound();
}
```

Run: `npm test -w @meshimap/api -- routes/permission-matrix`
Expected: PASS。「app に登録されたエンドポイントは 87 本で、想定どおりの並びである」が通る。

- [ ] **Step 5: わざと壊して、棚卸しと門番が効いていることを確かめる**

1 つずつ壊して、1 つずつ戻す。

1. `EXPECTED_ROUTE_PATTERNS` から `'GET /masters'` を消す → FAIL。86 本 vs 87 本の差分で落ちる。戻す。
2. `EXPECTED_ROUTE_PATTERNS` の `'GET /shop-applications/me'` を `'GET /shops'` の**後ろ**へ動かす → FAIL。本数は合うが並びで落ちる。**ソート順の比較規則を取り違えていないことの確認。**戻す。
3. `shopApplicationRoutes` の `use('*', roleGuard(ROLE_USER))` を消す → FAIL。`ENDPOINT_CASES` の #15〜#17 が `owner` / `admin` で 403 を期待しているのに 2xx / 404 が返って落ちる。**門番が 1 箇所に閉じていることの確認。**戻す。
4. `POST /shop-applications` の `throw conflict()` を `throw invalidInput()` に変える → FAIL。「二重申請は 409」が 422 で落ちる。戻す。
5. `index.ts` の `.route('/masters', masterRoutes)` を独立した文（`app.route('/masters', masterRoutes);`）に切る → `rpc-contract.test.ts` が落ちる。**チェーンを切ってはいけないことの確認。**戻す。

```bash
git diff --stat
```

Expected: 壊した箇所が残っていないこと。

- [ ] **Step 6: 網羅率と変異テストを通してコミットする**

```bash
npm run test:coverage -w @meshimap/api
npm run test:mutation -w @meshimap/api
npm run typecheck -w @meshimap/api
npm run format:check
```

Expected: 新規 3 ファイルが 4 指標とも 100%（`/* v8 ignore */` と `coverage.exclude` の追加は 0）。変異テストは break 85 を超える。

```bash
git add apps/api/src/routes/shop-applications.ts apps/api/src/routes/shop-applications.test.ts apps/api/src/routes/masters.ts apps/api/src/index.ts apps/api/src/test/fixtures.ts apps/api/src/routes/permission-matrix.test.ts
git commit -m "feat(api): 初回店舗申請の 4 エンドポイントを足し、権限行列を 87 本にする"
```

---

### Task 9-27: 申請フォーム画面（Phase 5 のプレースホルダを置き換える）

Phase 5 Task 5-7 が置いた `(user)/settings/shop-application.tsx` は `PlaceholderScreen` のままである（Phase 5 計画書 2515-2527 行）。ここで中身を入れる。導線（`settings/index.tsx` の `settings-shop-application-link`）は Phase 5 Task 5-18 が既に付けているので**触らない**。

**Files:**

- Create: `apps/mobile/src/features/shop-application/schema.ts`
- Create: `apps/mobile/src/features/shop-application/schema.test.ts`
- Create: `apps/mobile/src/features/shop-application/api.ts`
- Create: `apps/mobile/src/features/shop-application/api.test.ts`
- Create: `apps/mobile/src/features/shop-application/queries.ts`
- Create: `apps/mobile/src/features/shop-application/queries.test.tsx`
- Create: `apps/mobile/src/features/shop-application/shop-application-screen.tsx`
- Create: `apps/mobile/src/features/shop-application/shop-application-screen.test.tsx`
- Modify: `apps/mobile/src/app/(user)/settings/shop-application.tsx`（再輸出 1 行にする）

**Interfaces:**

- Consumes: `apiFetch`（`@/lib/api-client`。**Phase 7 Task 7-14 Step 1 が足す**。Phase 5 Task 5-3 が作るのは `apiClient` / `buildAuthHeaders` だけなので、ここで実物を確認すること）、`Input` / `Button` / `ErrorState` / `EmptyState`（既存 UI）、`SelectField`（Task 9-18）、`useCurrentLocation`（Phase 6）、`APPLICATION_STATUSES`（`@meshimap/core` ではなく API の語彙。`features/admin/types.ts` と同じやり方で API のソースを読んで突き合わせる）
- Produces: `shopApplicationFormSchema` / `ShopApplicationDraft` / `toShopApplicationInput` / `fetchMasters` / `fetchMyApplication` / `submitApplication` / `useMasters` / `useMyApplication` / `useSubmitApplication` / `ShopApplicationScreen`

**この画面が満たすこと:**

| 状態       | 表示                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| 申請なし   | 入力フォーム                                                                     |
| `pending`  | 「審査中です」。フォームは出さない                                               |
| `returned` | 差し戻し理由（`reviewNote`）+ フォーム（入力済みの内容を初期値にする）           |
| `approved` | 「承認されました」。ロールが `owner` に変わるので、次回起動時は `(owner)` へ入る |
| `rejected` | 「今回は見送りとなりました」。フォームは出さない（再申請できない）               |

- [ ] **Step 1: 着手条件を確認する**

```bash
grep -rn 'export function apiFetch\|export class ApiError' apps/mobile/src/lib/api-client.ts
grep -rn 'export function SelectField' apps/mobile/src/components/ui/select-field.tsx
grep -rn 'export function useCurrentLocation' apps/mobile/src/features/
grep -n 'PHONE_PATTERN\|POSTAL_CODE_PATTERN' packages/core/src/schema.ts
```

Expected:

- `apiFetch` / `ApiError` がある（無ければ Phase 7 Task 7-14 Step 1 が未了。そこで足してから戻る）
- `SelectField` がある（Task 9-18 の成果物）
- `useCurrentLocation` がある（Phase 6）
- `PHONE_PATTERN`（30 行）と `POSTAL_CODE_PATTERN`（28 行）が `packages/core/src/schema.ts` にあり、**どちらも export されていない**こと

最後の 1 つが Phase 5 の未解決事項 #14 の中身である。**正規表現をモバイル側に書き写さないこと。**書き写すと片方だけ直したときに検証がずれる。`packages/core/src/schema.ts` の `const PHONE_PATTERN` / `const POSTAL_CODE_PATTERN` に `export` を付け、`packages/core/src/index.ts` の export 一覧と `index.test.ts` の配列に 2 行ずつ足してから使う（`index.test.ts` が export の集合を固定しているので、足さないと落ちる）。

- [ ] **Step 2: フォームのスキーマの失敗するテストを書く**

`apps/mobile/src/features/shop-application/schema.test.ts`

```ts
import { describe, expect, it } from '@jest/globals';
import { EMPTY_DRAFT, toShopApplicationInput } from './schema';

const FILLED = {
  ...EMPTY_DRAFT,
  name: '申請ラーメン',
  nameKana: 'シンセイラーメン',
  genreId: 'gnr_ramen',
  areaId: 'are_shibuya',
  postalCode: '150-0043',
  address: '東京都渋谷区道玄坂 1-1-1',
  latitude: '35.658',
  longitude: '139.7016',
};

describe('toShopApplicationInput', () => {
  it('埋まっていれば ok:true で API のボディを返す', () => {
    const result = toShopApplicationInput(FILLED);
    expect(result).toEqual({
      ok: true,
      input: expect.objectContaining({ name: '申請ラーメン', latitude: 35.658, phone: null }),
    });
  });

  it('必須が欠けていればフィールドごとのエラーを返す', () => {
    const result = toShopApplicationInput({ ...FILLED, name: '' });
    expect(result).toEqual({ ok: false, errors: { name: '店舗名を入力してください' } });
  });

  it('緯度経度は数値に変換する。数値でなければエラー', () => {
    expect(toShopApplicationInput({ ...FILLED, latitude: '北緯 35 度' })).toEqual({
      ok: false,
      errors: { latitude: '地図から位置を取得してください' },
    });
  });

  it('未入力の任意項目は空文字ではなく null にする（0 を null にしない）', () => {
    const result = toShopApplicationInput({ ...FILLED, budgetLunchMinYen: '0' });
    expect(result).toEqual({ ok: true, input: expect.objectContaining({ budgetLunchMinYen: 0 }) });
  });

  it('郵便番号は必須。空なら submit させない（shopCreateSchema は nullable ではない）', () => {
    expect(toShopApplicationInput({ ...FILLED, postalCode: '' })).toEqual({
      ok: false,
      errors: { postalCode: '郵便番号を 000-0000 の形式で入力してください' },
    });
  });

  it('電話番号は core の PHONE_PATTERN で検証する（ハイフン必須）', () => {
    expect(toShopApplicationInput({ ...FILLED, phone: '0312345678' })).toEqual({
      ok: false,
      errors: { phone: '市外局番から、ハイフン区切りで入力してください' },
    });
  });
});
```

Run: `npm test -w @meshimap/mobile -- features/shop-application/schema`
Expected: FAIL（`Cannot find module './schema'`）

- [ ] **Step 3: スキーマを実装する**

**入力検査は `toShopApplicationInput(draft): DraftResult<ShopCreateInput>` の 1 本に閉じる。**`validate` と `onSubmit` に割ると、成功側に到達しない枝が生まれてカバレッジ 100% が届かなくなる（Task 9-9 の `MasterEditor` と同じ理由）。

```ts
// apps/mobile/src/features/shop-application/schema.ts
import { PHONE_PATTERN, POSTAL_CODE_PATTERN, shopCreateSchema } from '@meshimap/core';
import type { ShopCreateInput } from '@meshimap/core';

/** フォームの下書き。RN の TextInput は文字列しか持てないので、数値も文字列で保持する */
export type ShopApplicationDraft = {
  readonly name: string;
  readonly nameKana: string;
  readonly genreId: string;
  readonly areaId: string;
  readonly description: string;
  readonly postalCode: string;
  readonly address: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly phone: string;
  readonly website: string;
  readonly budgetLunchMinYen: string;
  readonly budgetLunchMaxYen: string;
  readonly budgetDinnerMinYen: string;
  readonly budgetDinnerMaxYen: string;
};

export const EMPTY_DRAFT: ShopApplicationDraft = {
  name: '',
  nameKana: '',
  genreId: '',
  areaId: '',
  description: '',
  postalCode: '',
  address: '',
  latitude: '',
  longitude: '',
  phone: '',
  website: '',
  budgetLunchMinYen: '',
  budgetLunchMaxYen: '',
  budgetDinnerMinYen: '',
  budgetDinnerMaxYen: '',
};

export type DraftErrors = Partial<Record<keyof ShopApplicationDraft, string>>;
export type DraftResult =
  | { readonly ok: true; readonly input: ShopCreateInput }
  | { readonly ok: false; readonly errors: DraftErrors };

/** 前後の空白を落として、空なら null。`trimmed || null` と書くと '0' が null になる */
function toNullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toNullableNumber(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toShopApplicationInput(draft: ShopApplicationDraft): DraftResult {
  const errors: DraftErrors = {};
  if (draft.name.trim() === '') errors.name = '店舗名を入力してください';
  if (draft.nameKana.trim() === '') errors.nameKana = 'カナを入力してください';
  if (draft.genreId === '') errors.genreId = 'ジャンルを選んでください';
  if (draft.areaId === '') errors.areaId = 'エリアを選んでください';
  if (draft.address.trim() === '') errors.address = '住所を入力してください';
  // postalCode は shopCreateSchema:78 で `z.string().regex(...)`。nullable でも default 付きでもない
  if (!POSTAL_CODE_PATTERN.test(draft.postalCode.trim())) {
    errors.postalCode = '郵便番号を 000-0000 の形式で入力してください';
  }

  const latitude = Number(draft.latitude);
  const longitude = Number(draft.longitude);
  if (!Number.isFinite(latitude)) errors.latitude = '地図から位置を取得してください';
  if (!Number.isFinite(longitude)) errors.longitude = '地図から位置を取得してください';

  const phone = toNullableText(draft.phone);
  if (phone !== null && !PHONE_PATTERN.test(phone)) {
    errors.phone = '市外局番から、ハイフン区切りで入力してください';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const candidate = {
    name: draft.name.trim(),
    nameKana: draft.nameKana.trim(),
    genreId: draft.genreId,
    areaId: draft.areaId,
    description: draft.description.trim(),
    postalCode: draft.postalCode.trim(),
    address: draft.address.trim(),
    latitude,
    longitude,
    phone,
    website: toNullableText(draft.website),
    budgetLunchMinYen: toNullableNumber(draft.budgetLunchMinYen),
    budgetLunchMaxYen: toNullableNumber(draft.budgetLunchMaxYen),
    budgetDinnerMinYen: toNullableNumber(draft.budgetDinnerMinYen),
    budgetDinnerMaxYen: toNullableNumber(draft.budgetDinnerMaxYen),
  };

  // 最後は core のスキーマに通す。サーバと同じ定義で検証するので 422 を画面に出さずに済む
  const parsed = shopCreateSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: { name: '入力内容を確認してください' } };
  }
  return { ok: true, input: parsed.data };
}
```

Run: `npm test -w @meshimap/mobile -- features/shop-application/schema`
Expected: PASS（6 件）

- [ ] **Step 4: API 呼び出しとクエリ層を作る**

`features/admin/api.ts`（Task 9-19）と同じ規律に従う。**応答は必ず zod で検査してから画面へ渡す。**`apiFetch` が返すのは `JSON.parse` の結果で、型は誰も保証していない。

```ts
// apps/mobile/src/features/shop-application/api.ts
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import type { ShopCreateInput } from '@meshimap/core';

const mastersSchema = z.object({
  genres: z.array(z.object({ id: z.string(), name: z.string() })),
  areas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parentId: z.string().nullable(),
      prefecture: z.string(),
    }),
  ),
});
export type Masters = z.infer<typeof mastersSchema>;

/** API の語彙をそのまま写す。増えたらここがコンパイルエラーにならないので Step 7 で突き合わせる */
const APPLICATION_STATUS = ['pending', 'approved', 'rejected', 'returned'] as const;

const applicationSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  status: z.enum(APPLICATION_STATUS),
  reviewNote: z.string().nullable(),
  documents: z.array(z.object({ kind: z.string(), r2Key: z.string() })),
  createdAt: z.number(),
});
export type ShopApplication = z.infer<typeof applicationSchema>;

const myApplicationSchema = z.object({ application: applicationSchema.nullable() });
const submitResponseSchema = z.object({ application: applicationSchema });

export async function fetchMasters(): Promise<Masters> {
  return mastersSchema.parse(await apiFetch('/masters', { method: 'GET' }));
}

export async function fetchMyApplication(): Promise<ShopApplication | null> {
  const payload = await apiFetch('/shop-applications/me', { method: 'GET' });
  return myApplicationSchema.parse(payload).application;
}

export async function submitApplication(input: ShopCreateInput): Promise<ShopApplication> {
  const payload = await apiFetch('/shop-applications', { method: 'POST', body: input });
  return submitResponseSchema.parse(payload).application;
}
```

```ts
// apps/mobile/src/features/shop-application/queries.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShopCreateInput } from '@meshimap/core';
import { fetchMasters, fetchMyApplication, submitApplication } from './api';

export const SHOP_APPLICATION_QUERY_KEYS = {
  masters: ['masters'] as const,
  myApplication: ['shop-application', 'me'] as const,
};

export function useMasters() {
  // マスタは滅多に変わらない。画面を開くたびに取り直さない
  return useQuery({ queryKey: SHOP_APPLICATION_QUERY_KEYS.masters, queryFn: fetchMasters });
}

export function useMyApplication() {
  return useQuery({
    queryKey: SHOP_APPLICATION_QUERY_KEYS.myApplication,
    queryFn: fetchMyApplication,
  });
}

export function useSubmitApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ShopCreateInput) => await submitApplication(input),
    // onSettled ではなく onSuccess。失敗したのに取り直すと「審査中」に化ける
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: SHOP_APPLICATION_QUERY_KEYS.myApplication,
      });
    },
  });
}
```

テストは `features/admin/api.test.ts` と同じ形（`jest.mock('@/lib/api-client', () => ({ apiFetch: jest.fn() }))` で `apiFetch` の呼ばれ方を固定し、応答が壊れていれば `z` が投げることを確かめる）で書く。

Run: `npm test -w @meshimap/mobile -- features/shop-application`
Expected: PASS

- [ ] **Step 5: 画面の失敗するテストを書く**

`shop-application-screen.test.tsx` は 5 つの状態を 5 ケースで押さえる。

```tsx
it('申請が無ければフォームを出す', async () => {
  /* … */
});
it('審査中ならフォームを出さず「審査中です」と出す', async () => {
  /* … */
});
it('差し戻しなら理由を出し、フォームも出す', async () => {
  /* … */
});
it('却下ならフォームを出さない（再申請できない）', async () => {
  /* … */
});
it('必須が空のまま送信すると通信せずにエラーを出す', async () => {
  /* … */
});
it('送信が失敗したらフォームが開いたまま残る', async () => {
  /* … */
});
```

`testID` は `shop-application-screen` を据え置く（Phase 5 のプレースホルダと同じ）。`(user)/settings/shop-application.tsx` を再輸出 1 行にするので、Phase 5 Task 5-20 の `routing.test.tsx` がこの画面に遷移できることが変わらない。

Run: `npm test -w @meshimap/mobile -- features/shop-application/shop-application-screen`
Expected: FAIL

- [ ] **Step 6: 画面を実装し、ルートファイルを再輸出 1 行にする**

```tsx
// apps/mobile/src/app/(user)/settings/shop-application.tsx
export { ShopApplicationScreen as default } from '@/features/shop-application/shop-application-screen';
```

画面本体は `useMyApplication()` の結果で 5 分岐し、フォームを出すのは `null` と `returned` のときだけにする。**`isPending` ではなく `data === undefined` で読み込みを判定する**（Task 9-20 の `AdminListScreen` と同じ規律。`isPending` はキャッシュがあるときに false にならない場面がある）。

Run: `npm test -w @meshimap/mobile -- features/shop-application`
Expected: PASS

- [ ] **Step 7: わざと壊して、画面の分岐と語彙の同期が効いていることを確かめる**

1. `status === 'rejected'` の分岐を消す → FAIL。「却下ならフォームを出さない」が落ちる。戻す。
2. `APPLICATION_STATUS` から `'returned'` を消す → FAIL。差し戻しのケースが `z` の enum で落ちる。**4 値であることを画面のテストからも押さえていることの確認**（Phase 5 Task 5-19 が「3 値ではなく 4 値」と書き残した項目の決着）。戻す。
3. `useSubmitApplication` の `onSuccess` を `onSettled` に変える → FAIL。「送信が失敗したらフォームが開いたまま残る」が落ちる。戻す。
4. `toNullableText` を `trimmed || null` に書き換える → FAIL。「0 を null にしない」が落ちる。戻す。

- [ ] **Step 8: 網羅率・型・lint を通してコミットする**

```bash
npm run test:coverage -w @meshimap/mobile
npm run typecheck -w @meshimap/mobile
npm run lint
npm run format:check
```

Expected: `src/features/shop-application/**` が 4 指標とも 100%。

```bash
git add apps/mobile/src/features/shop-application/ apps/mobile/src/app/\(user\)/settings/shop-application.tsx packages/core/src/schema.ts packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat(mobile): 初回店舗申請のフォーム画面を実装する"
```

---

## Phase 9 完了チェックリスト

**ライブラリ土台（`src/lib`）**

- [ ] `conflict()` が 409 と `ERROR_MESSAGE_CONFLICT = '対象の状態が変わっています'` を返し、文言の並びが 404 と 422 の間に入っている
- [ ] `withAuditLog` が業務 SQL と監査 INSERT を **1 回の `db.batch()`** に入れており、監査行だけ別の `await` になっている箇所が 0
- [ ] `toNonEmptyBatch` が空配列を弾き、空 batch の `D1_ERROR: No SQL statements detected.` に到達しない
- [ ] `AUDIT_ACTIONS` が 22 個・`AUDIT_TARGET_TYPES` が 9 個で、サーバ（オブジェクト形）とモバイル（配列形）の語彙が一致している
- [ ] `createPrefixedId(prefix, randomLength?)` が UUID のハイフンを抜き、32 を超える長さを渡しても 32 文字までしか伸びない
- [ ] `ID_PREFIXES` が 5 種（`aud_` / `ntf_` / `gnr_` / `are_` / `ann_`）で、お知らせ ID は `ann_` + 12 桁 = 16 文字
- [ ] 通知 ID が `ntf_` + お知らせ ID(16) + `_` + ユーザー ID(32) = **53 文字**の決定的な値で、`onConflictDoNothing()` と対になっている
- [ ] `ADMIN_WRITE_OUTCOME` が `ok` / `not-found` / `conflict` の 3 値だけで、ルート層が 200 / 404 / 409 に 1 対 1 で写している
- [ ] 一覧がすべてキーセット（`created_at DESC, id DESC`）で、`OFFSET` を使っている箇所が 0。各関数が `limit + 1` 件取って次カーソルを決めている
- [ ] `createAdminWorld()` が `src/db/testing/` にある（`src/repositories/` だと規約検査に、`src/test/` だと変異対象に引っかかるため）

**監査ログの機械的担保**

- [ ] `findAuditViolations` が 5 種類の違反（`.run()` / `db.batch` の直呼び / `withAuditLog` 未呼び出し / ローカル定義による影 / private な書き込みヘルパ）を検出する
- [ ] 検査器自身の fixture が `__fixtures__/audit-*-repo.ts.txt` の 6 本で、拡張子が `.ts.txt` のため tsc・vitest・カバレッジ・prettier・eslint のどれにも拾われない
- [ ] `AUDITED_WRITE_CASES` が **19 行**で、`admin-*-repository.ts` の書き込み関数 19 本と**双方向に**一致する（片方にしか無い名前が 0）
- [ ] 表の `expectedAuditCount` が原則 1 で、2 になっているのは `restoreUser` と `restoreShop` だけ（前準備の停止操作を含むため）
- [ ] `src/repositories/admin-*.ts` に `db.batch(` の直接呼び出しと `.run()` が 1 つも無い
- [ ] `audit_logs` を UPDATE / DELETE する SQL が Phase 9 のどこにも無い（追記専用が守られている）
- [ ] 物理削除は「マスタの削除」と「停止時の `session` 行 DELETE」の 2 箇所だけで、申請・通報・レビュー・店舗・プロフィールは UPDATE / INSERT のみ
- [ ] `withAuditLog` を `db.batch` に置き換えると規約検査が **2 件**落ち、表から 1 行消すと網羅検査が落ちることを実際に壊して確かめた
- [ ] `suspendShop` の UPDATE を `db.delete(shops)` に書き換えるとテストが落ちる（「物理削除に変えたら落ちる」形になっている）

**リポジトリ**

- [ ] すべての UPDATE が WHERE に**観測した前状態を再掲**している（D1 に対話的トランザクションが無く、これが二重適用を防ぐ唯一の手段のため）
- [ ] 前状態を再掲していない唯一の例外は `approveApplication` の `shops` / `profiles` UPDATE で、「申請の `status = 'pending'` が門になっている」と根拠がコメントに書いてある
- [ ] 409 を返す条件が 19 通りすべて実装され、「自分自身の停止」と「自分自身のロール変更」は **SELECT より前**に判定される（存在確認をせずに 409）
- [ ] `suspendUser` が `profiles.status` の更新と `session` 行の DELETE を**同じバッチ**で流す
- [ ] `restoreUser` が `suspended` からしか戻さない（`deleted` は本人の意思なので管理者が戻さない）
- [ ] `assignShopOwner` が前のオーナーのロールを下げず、`null` への付け替えも許し、`diff.ownerId` に前後を必ず残す
- [ ] マスタ削除が外部キーに頼らず、**削除前に店舗件数を数えて** 0 件でなければ `conflict` を返す
- [ ] `buildDeletionDiff` が削除直前の全列を `{ 列名: [値, null] }` で残し、`id` も含む（同じ ID で作り直せる）
- [ ] `UNDOABLE_ACTIONS` が 7 つ（`user.suspend` / `user.restore` / `user.role_change` / `shop.suspend` / `shop.restore` / `shop.owner_assign` / `review.hide`）で、`audit.undo` 自身は取り消せない
- [ ] 二重取り消しが「`action = 'audit.undo'` かつ `target_id = 元の監査ログ ID` の行の有無」で弾かれる
- [ ] 取り消しの UPDATE が「現在値が `diff` の変更後と一致すること」を WHERE に持つ
- [ ] お知らせ専用のテーブルを作っておらず、実体が `notifications` の N 行 + `announcement.send` の監査ログ 1 行になっている
- [ ] 監査行が**最後のチャンクに同梱**され、「監査行がある ⇔ 全件流れ切った」が成り立つ
- [ ] 同じお知らせ ID で再送しても通知が二重に届かない（決定的 ID + `onConflictDoNothing`）
- [ ] `getOverviewStats` が `sinceMs` を引数で受け（中で `Date.now()` を呼ばない）、`created_at >= sinceMs` の境界が「ちょうど」と「1 ミリ秒前」の両方で検証されている
- [ ] `pendingApplicationCount` と `openReportCount` が期間で切られていない（溜まっている総数を出す）
- [ ] `admin-*-repository.ts` の全 export が `(db, actor | _actor, ...)` の順で、`repository-convention.test.ts` を通る

**API（ルート層）**

- [ ] `adminRoutes` が `use('*', roleGuard(ROLE_ADMIN))` **1 行**と `route()` **9 行**だけで構成され、`use` が `route` より先にある
- [ ] 個々のルートファイル 9 本に `roleGuard` が 1 つも出てこない（門番が 1 箇所に閉じている）
- [ ] 32 エンドポイントすべてが登録され、**201 を返すのは `POST /admin/genres` と `POST /admin/areas` の 2 本だけ**
- [ ] ルート層の分岐が `assertWriteSucceeded` / `assertFound` / `parseOrThrow` / `toPageParams`（＋お知らせ専用の `assertAnnouncementSucceeded`）以外に無い。**これは機械検査が無いのでレビューで見る**
- [ ] `assertFound` が `value === null` の厳密比較で、`0` や空文字を 404 にしない
- [ ] `readJsonBody` が壊れた本文・空本文で throw せず、結果が **422**（500 ではない）になる
- [ ] 非管理者には**対象 ID の実在によらず 403** が返り、実在 ID と架空 ID で status と本文が完全一致する
- [ ] 非管理者の **96 リクエスト**を全部流したあと `audit_logs` が **0 行**
- [ ] 権限行列の表（32 行）と `app.routes` が双方向に一致し、突き合わせ前に `method === 'ALL'` を除いている
- [ ] 門番が `/admin/*` に **1 つだけ**掛かっている（`app.routes` の `ALL` のパス一覧が `['/admin/*']` に一致）
- [ ] `src/index.ts` が**単一のメソッドチェーンのまま**で、`.route('/admin', adminRoutes)` がチェーンの末尾（`.use('*', authMiddleware)` より後ろ）にある。`app.route(...)` という独立文に切っていない（切ると `AppType` が痩せて `rpc-contract.test.ts` が落ちる）
- [ ] `route-harness.test.ts` の並び順検査が、レシーバ名ではなく `new Hono` を根とするチェーンを巻き戻して**ソース順**に読んでいる（`mountPaths` が `['/me','/shops','/reviews','/admin']` に一致する）
- [ ] Phase 4 の `src/routes/permission-matrix.test.ts` が通る。`EXPECTED_ROUTE_PATTERNS` に管理系 32 本が**ソート順を保って**入り（Phase 8 まで 51 本 → Task 9-17 で 83 本 → **Task 9-26 で 87 本**）、`DELEGATED_ROUTE_PATTERNS` にも管理系 32 本が入り（9 本 → **41 本**。初回申請の 4 本は委譲しないのでここは 41 本のまま）、`DELEGATABLE_PATH_PATTERN` に `admin` が足されている。`ENDPOINT_CASES` には管理系の行を足していない（128 ケースは `routes/admin/permission-matrix.test.ts` が持つ）が、**初回申請の 4 行は足してある**（#14〜#17）
- [ ] `rpc-contract.test.ts` が通る
- [ ] `src/routes/admin/**` / `src/repositories/admin-*.ts` / `src/lib/audit-log.ts` が 4 指標とも 100%（`/* v8 ignore */` と `coverage.exclude` の追加が 0）
- [ ] `npm run test:mutation -w @meshimap/api` が break 85 を超える（`mutate` への除外追加が 0）

**モバイル**

- [ ] 新規プリミティブが `ConfirmDialog` / `SelectField` / `SegmentedControl` の 3 つだけで、既存 8 つ（Badge / Button / Card / EmptyState / ErrorState / Icon / Input / Skeleton）を書き換えていない
- [ ] 3 つとも `src/app/_dev/catalog.tsx` に節があり、逆に `features/admin/` の部品はカタログに足していない
- [ ] `features/admin/types.ts` の語彙が API のソースを `readFileSync` で読んで突き合わされている（`AUDIT_ACTIONS` 22 / `AUDIT_TARGET_TYPES` 9 ほか）
- [ ] `apiFetch` を呼ぶのが `features/admin/api.ts` だけ。**現状は規律の明文化だけで、import 元を走査する検査が無い**
- [ ] `api.ts` のエンドポイント関数が 32 本で、パスの重複が無く、ID が必ず `encodeURIComponent` を通っている
- [ ] `queries.ts` のフックが 30 本（取得 13 / 書き込み 17）で、`invalidateQueries` が `onSuccess` でのみ走る（`onSettled` ではない）
- [ ] すべての書き込みが監査ログのキーを無効化する
- [ ] 詳細クエリが `enabled: id !== ''` で、ID が空なら通信しない
- [ ] `initialPageParam` が `null` で、最初のページ取得に `cursor` が付かないことをテストで押さえている
- [ ] `AdminListScreen` が `isPending` ではなく `data === undefined` で読み込みを判定し、`-loading` / `-empty-container` / `-empty` / `-error` / `-error-retry-button` / `-load-more` の testID を持つ
- [ ] `ActionPanel` で `run()` を呼ぶ行が `ConfirmDialog` の `onConfirm` の中の**1 箇所だけ**で、ボタンを押しただけでは呼ばれない
- [ ] 確認ダイアログが `pendingKey` により**常に 1 枚だけ** mount される（testID が固定値なので 2 枚出ると取得が落ちる）
- [ ] `MasterEditor` がジャンルとエリアの 2 画面から**同じ形で**使われている（一覧・フォーム・確認ダイアログを 2 通り書いていない）
- [ ] マスタの入力検査が `toInput(draft): DraftResult<TInput>` の 1 本になっており、`validate` と `onSubmit` に割れていない（割ると成功側に到達しない枝が生まれてカバレッジ 100% が届かなくなる）
- [ ] `MasterEditor.onSubmit` の第 3 引数（`onSucceeded`）を呼ぶのが mutation の `onSuccess` の中だけで、**保存が失敗したらフォームが開いたまま**残る
- [ ] `toNullableText` が前後の空白を落として空なら `null` を返し、`'0'` を `null` にしない（`trimmed || null` と書いていない）
- [ ] 監査ログ画面の確認ダイアログが**画面に 1 枚**で、`AuditLogRow` は押されたことを親へ伝えるだけ（行ごとに `ActionPanel` を置いていない）
- [ ] `toActionLabel` / `toTargetTypeLabel` が「表に無いキーはそのままの文字で出す」形で、サーバが語彙を増やしても画面が落ちない
- [ ] 画面本体 13 本が `src/features/admin/screens/` にあり、`src/app/(admin)/**` の 13 本は再輸出だけ（Task 9-24 で薄さを機械検査する）
- [ ] `ADMIN_ROUTES` 9 キー + `ADMIN_DETAIL_ROUTES` 4 キー = **13** で、ID がテンプレートリテラルではなく `params` に載っている
- [ ] `routes.test.ts` が `ADMIN_ROUTES` / `ADMIN_DETAIL_ROUTES` の各パスに対応する**実ファイルの存在**を照合する（Task 9-24 で追加。`.expo/types/` が無い環境では `Href` が `string | HrefObject` に退化して型検査が効かないため、綴りを守るのはこの検査だけ）
- [ ] `expo-router` から `Tabs` を import している箇所が 0（必要になったら `expo-router/js-tabs` から取る）
- [ ] 画面テストが毎回 `jest.mock('expo-router')` を書き、モック変数名が `mock` で始まっている（`babel-plugin-jest-hoist` のホイスト対策）
- [ ] `npm run test:coverage -w @meshimap/mobile` が 4 指標とも 100% を満たし、`collectCoverageFrom` に除外を足していない（`testing/query-wrapper.tsx` も除外しない）
- [ ] `any` が 1 つも無く、default export は `src/app/` 配下のルートファイルだけ

**総点検**

- [ ] `npm test && npm run typecheck && npm run lint && npm run format:check` が全ワークスペースで通る
- [ ] `apps/api` / `packages/core` / `packages/geo` の変異テストがしきい値（break 85）を超える（新規除外 0）
- [ ] 新しいテーブルもマイグレーションも足していないので、`design-doc-sync.test.ts` と `check-constraints.test.ts` が無傷で通る
- [ ] 32 エンドポイント × 4 視点 = **128 ケース**がすべて期待どおり
- [ ] 監査ログに残らない管理操作が 1 つも無い（規約検査・網羅表・実 D1 の 3 本立てが全部緑）

**初回店舗申請（Task 9-25 〜 9-27）**

- [ ] `shop_applications` に `updated_at` を書く SQL が 1 つも無い（この列は存在しない）
- [ ] 申請の作成が `db.batch()` 1 回で `shops`（`owner_id = NULL` / `status = 'draft'`）と `shop_applications`（`pending`）を同時に作り、`db.transaction(` を使っていない
- [ ] `geohash` をクライアントから受け取っていない（必ず `encodeGeohash` で計算している）
- [ ] `pending` / `approved` / `rejected` の 3 つとも 409 で、**本文で理由を区別していない**
- [ ] `returned` からの再提出が既存の店舗行を UPDATE し、`shops` の行数が増えない
- [ ] `shopApplicationRoutes` の `roleGuard(ROLE_USER)` が `use('*', ...)` の **1 箇所だけ**
- [ ] `GET /masters` に門番が掛かっていない（匿名 200）
- [ ] `GET /shop-applications/me` が申請なしで **200 / `{ application: null }`**（404 ではない）
- [ ] `EXPECTED_ROUTE_PATTERNS` が **87 本**で、4 本がソート順の正しい位置に入っている
- [ ] `apps/mobile/src/app/(user)/settings/shop-application.tsx` が再輸出 1 行になり、`testID` が `shop-application-screen` のまま
- [ ] `PHONE_PATTERN` / `POSTAL_CODE_PATTERN` を `packages/core` から import しており、モバイル側に写していない

---

## 次フェーズへの引き継ぎ

**Phase 10（仕上げ）が Phase 9 から受け取るもの:**

| 引き継ぐもの                                             | 置き場所                                                          | 使いかた                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `withAuditLog` / `withAuditLogChunked`                   | `apps/api/src/lib/audit-log.ts`                                   | 管理者の書き込みはすべてここを通る。**Phase 10 が管理者以外の書き込みを監査に載せたくなったら第 2 引数を広げる判断が要る**（下の宿題 1） |
| `conflict()` / `ERROR_MESSAGE_CONFLICT`                  | `apps/api/src/lib/http-error.ts`                                  | 「対象は見えているが今の状態ではできない」は Phase 10 も 409 に揃える                                                                    |
| カーソル（キーセット）ページング一式                     | `apps/api/src/lib/cursor.ts`                                      | 通知一覧など Phase 10 の一覧もこれを使う。`OFFSET` を足さない                                                                            |
| `createAdminWorld()`                                     | `apps/api/src/db/testing/admin-world.ts`                          | 管理系の実 D1 テストの土台。`src/test/fixtures.ts` の上に積んである                                                                      |
| admin 権限行列 32 行                                     | `apps/api/src/routes/admin/permission-matrix.test.ts`             | Phase 10 が `/admin/*` にエンドポイントを足したらここに行を足す。忘れると表と `app.routes` の双方向一致が落ちる                          |
| `ID_PREFIXES` / `createPrefixedId(prefix, randomLength)` | `apps/api/src/lib/identifier.ts`                                  | Phase 10 Task 10-2 の `push_tokens` の ID もここに接頭辞を 1 つ足して作る                                                                |
| `ConfirmDialog` / `SelectField` / `SegmentedControl`     | `apps/mobile/src/components/ui/`                                  | 通知設定・退会などの破壊的操作で再利用する。`ActionPanel` 経由なら確認が自動で付く                                                       |
| `(admin)` 13 画面                                        | `apps/mobile/src/features/admin/screens/` と `src/app/(admin)/**` | Phase 10 Task 10-13 のデモ動画の 3 ロール目。ロジックは `screens/` 側にある                                                              |
| `features/admin/api.ts` の呼び出し規律                   | `apps/mobile/src/features/admin/`                                 | 「`apiFetch` を呼ぶのは `api.ts` だけ」「ID は `encodeURIComponent`」の 2 つは Phase 10 の新機能でも守る                                 |
| `EXPECTED_ROUTE_PATTERNS` = **87 本**                    | `apps/api/src/routes/permission-matrix.test.ts`                   | Phase 10 がルートを足したらこの本数から積む。**Phase 10 は 5 本足すので 92 本になる**（下の宿題を参照）                                  |
| 初回店舗申請の 4 本と `shop-application-repository.ts`   | `apps/api/src/routes/shop-applications.ts` ほか                   | `user` → `owner` の入口。承認は Task 9-5 の `approveApplication` が受ける                                                                |
| `listPublicMasters` / `GET /masters`                     | `apps/api/src/repositories/master-repository.ts`                  | ジャンル・エリアの公開選択肢。Phase 10 で検索フィルタを作るときも新設せずこれを使う                                                      |

**Phase 10 へ送る宿題:**

- **`repository-convention.test.ts` と Task 10-4 の衝突（最優先。着手前に決める）。** この検査は `src/repositories/*.ts`（`.test.ts` は除外）の全 export に対し、第 1 引数が `db: Database`、第 2 引数名が `actor` / `_actor` / `viewer` / `_viewer` のいずれかで、型が `UserActor` / `OwnerActor` / `AdminActor` / `Actor` / `Viewer` のいずれかであることを要求する（`ACTOR_TYPE_NAMES` は 5 種、`ACTOR_PARAMETER_NAMES` は 4 種）。**除外の仕組みは無い。** Phase 10 Task 10-4 が作る `registerPushToken(database, actor, input)` / `listActivePushTokens(database, userId)` / `deactivatePushTokens(database, tokens)` / `markPushTokensUsed(database, tokens)` は 4 本とも違反する（引数名が `database`、第 2 引数が `userId` / `tokens`）。**推奨する決着は `SystemActor` を Phase 4 の `Actor` ユニオンに足すこと**で、(a) `ACTOR_TYPE_NAMES` に `SystemActor` を加え、(b) 生成点を `auth/actor.ts` に閉じて `actor-encapsulation.test.ts` の import ホワイトリストで縛る。引数名は `database` → `db` に直す。副次的な利点として、**Phase 9 の監査ログが「システムが実行した」を記録できるようになる**（現在の `withAuditLog` は `AdminActor` しか受けない）。検査を緩める・`src/repositories/` の外へ逃がすのは、規約がザルになるので採らない
- **409 の文言が実態と合わない（Phase 9 計画書 18545 行の既知の弱点）。** Task 9-7 で決めたとおりサーバは**自分自身の停止とロール変更を 409 で拒む**が、モバイルの `toAdminErrorMessage` は 409 を一律「他の管理者が先に処理しました。画面を更新してください。」に読み替える。自分を停止しようとしたときにこの文言が出るのは実態と食い違う。直すには (a) ログイン中の管理者 ID を画面が知る（**Phase 6 のセッションフックの名前と形が未確認**）か、(b) 409 応答に機械可読な `code` を足す（Task 9-0 の `conflict()` / Task 9-13 の `assertWriteSucceeded` / Task 9-19 の `toAdminErrorMessage` に波及）。**Phase 9 ではどちらもやらず、汎用文言のまま渡す**
- **`AUDIT_ACTIONS` に未使用の語彙が 2 つある。** `report.resolve` と `review.restore` は語彙表（サーバ・モバイル・`labels.ts` の 3 箇所）に載っているが、Phase 9 のどのリポジトリからも書き込まれない（通報の対応は対象コンテンツ側の action で記録し、取り消しは `audit.undo` で記録するため）。将来 UI から「レビューを再公開」を直接叩けるようにするか、語彙から落とすかを Phase 10 で決める。**語彙を落とすときはモバイル側の配列と `labels.ts` の 3 箇所が同時に変わる**
- **`push_tokens` を足すと `check-constraints.test.ts` が落ちる。** この検査は DDL 文字列・CHECK の個数・CHECK 名の一覧を固定値で持っている。Phase 10 Task 10-2 で新テーブルを足すなら、設計書 §6 の改訂と `design-doc-sync.test.ts` のテーブル名集合の更新が同じコミットに要る。Phase 9 が新規テーブルを作らなかったのは、まさにこの 3 検査をまとめて壊さないため
- **`apps/mobile` に変異テストの設定が無い。** `stryker.config.mjs` があるのは `apps/api` / `packages/core` / `packages/geo` の 3 つだけで、モバイルはカバレッジ 100% だけが頼り。Phase 9 で `features/admin/` のロジック量が一気に増えたので、モバイルにも変異テストを入れるかを Phase 10 で判断する
- **`apiFetch` の import 元ホワイトリスト検査を足す。** 「呼んでよいのは `api.ts` だけ」は計画書の文言としては 3 箇所に書いたが、走査する検査が無い。`auth/actor-encapsulation.test.ts` と同じ方式（import 元ホワイトリスト）でそのまま作れる
- **`jest.config.js` の `!src/app/**` をいつ外すか。** 現在このファイルのコメントは「画面は Phase 5 以降に作るため、実装が入るタイミングで除外を外して同じ 100% を課すこと」と書いてあるが、Phase 9 は逆に「`src/app/` は再輸出だけにして除外を維持し、ロジックを `features/admin/screens/` に置く」方針を採った。**コメントと実際の方針が食い違ったままなので、Phase 10 でコメントを現実に合わせて書き換える**
- **`apiFetch` の出どころ（2026-09-16 に確定）。** Phase 5 計画書が作るのは `apiClient`（`hc<AppType>`）と `buildAuthHeaders` だけで、`apiFetch` / `ApiError` は作らない。**実物を足すのは Phase 7 Task 7-14 Step 1**（Phase 7 計画書 8584 行に実装が載っており、同 81 行がこの名前の衝突を明記している）。Phase 6（60 箇所）・Phase 7（46 箇所）・Phase 9（48 箇所）・Phase 10（5 箇所）が前提にしているので、**Phase 6 を Phase 7 より先に着手する場合は Task 7-14 Step 1 の実装を先に持ち込むこと。**Phase 5 に足しにいかない（Phase 5 は `hc` の型推論を守るために `fetch` のラッパを持たないと決めている）
- **Phase 10 がルートを 5 本足すのに `EXPECTED_ROUTE_PATTERNS` を触る指示が無い。** Phase 10 計画書は `POST /me/push-tokens`（3062 行）/ `GET /me/notifications`（3073 行）/ `POST /me/notifications/:notificationId/read`（3092 行）/ `GET /.well-known/apple-app-site-association`（4987 行）/ `GET /.well-known/assetlinks.json`（4991 行）を足すが、`permission-matrix.test.ts` への言及が 1 つも無い（`grep -n 'EXPECTED_ROUTE_PATTERNS' 2026-09-15-phase-10-polish.md` が 0 件）。**足した瞬間に Phase 4 のテストが 87 本 vs 92 本で落ちる。**Phase 10 の着手時に、Phase 7 が確立した 4 手順（ソート順を保って行を足す / `it(...)` の数字を直す / 委譲の要否を決める / `covered` に混ぜる）を必ず実行すること。`.well-known` の 2 本は匿名 200 なので `ENDPOINT_CASES` に素直に足せる
- **マスタ削除の自動復元。** Phase 9 では `genre.delete` / `area.delete` を `UNDOABLE_ACTIONS` に入れていない（ID 衝突の扱いが複雑になるため）。`diff` には全列が残っているので手で作り直せる。自動復元が要るなら Phase 10 で設計する

---

## 未確認事項

**この計画書で「実測した」と書いた箇所は、すべて実際にコマンドを走らせるかファイルを開いて確かめたものである。** 一方、以下は確認できていない。**実装時に必ず実物を開いて確かめ、食い違っていたらこの計画書ではなく実物を優先すること。**

| 未確認のもの                                                                               | なぜ確認できなかったか                                                                                                                                                                  | いつ確かめるか                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 の `resolveViewer` が `profiles.status` を見るか                                   | Phase 6 の実装待ち。見ていない場合、停止しても発行済み Cookie がそのまま使える                                                                                                          | Task 9-7。どちらでも締め出せるよう `session` 行を同じバッチで消す設計にしてある                                                                                                                                                        |
| D1 で外部キー（`shops.genre_id` / `area_id` の `on delete restrict`）が実際に強制されるか  | スキーマに `on delete restrict` があることは `apps/api/src/db/schema/shop.ts:71-77` で確認済みだが、D1 が強制するかは走らせていない                                                     | Task 9-9 Step 7。実測して**この表の行を実測結果に書き換える**。効いていなくても事前の件数確認で守る                                                                                                                                    |
| D1 のバインドパラメータ上限                                                                | 実測していない。`ANNOUNCEMENT_CHUNK_SIZE = 100` は B-6〜B-8 で測ったが、`IN (...)` に入れる ID 数の上限は別                                                                             | Task 9-10。確実に安全な `RECIPIENT_LOOKUP_CHUNK_SIZE = 50` で刻んである                                                                                                                                                                |
| Hono の `use('*')` を `route()` の**後ろ**に登録したときの挙動                             | 事実 H-4 で確かめたのは「先に登録すれば子ルータ配下でも走る」ことだけ                                                                                                                   | Task 9-16 Step 5。実測結果は計画書ではなく**コード内コメント**に残し、PASS でも `use` は先頭に戻す                                                                                                                                     |
| `toSearchParams` が空文字カーソルを落とすか                                                | `initialPageParam` を `''` に変えると `cursor=` が送られる疑いがあるが、`apiFetch` をモックしている `queries.test.tsx` では検出できず、`api.test.ts` でも型検査でも落ちない             | Task 9-19 Step 22 で「最初のページはカーソル無しで取りに行く」テストを足し、壊して落ちることを確認                                                                                                                                     |
| `AdminListQuery` に `UseInfiniteQueryResult` を代入できるか                                | Task 9-20 の時点では実型を渡していない                                                                                                                                                  | Task 9-22 Step 22。落ちたら `unknown` / `any` で緩めず、6 つの props に展開する                                                                                                                                                        |
| React Compiler が factory の内側で定義した関数コンポーネントを最適化対象にするか           | `app.json` の `experiments.reactCompiler: true` は実ファイルで確認したが、factory 定義の扱いは確かめていない                                                                            | Task 9-21。警告が出るなら factory をやめて 5 つ書き下す（`Record<語彙, BadgeTone>` の構造は保つ）                                                                                                                                      |
| Phase 6 のセッションフック（ログイン中の管理者 ID の取り方）の名前と形                     | Phase 6 未実装。`apps/mobile/src/features/auth/` にあるのは型 `AuthState` だけで、フックの実体が無いことを実測                                                                          | Phase 10。409 の文言の出し分け（上の宿題 2）を実装するとき                                                                                                                                                                             |
| `apps/mobile/src/lib/api-client.ts` の `apiFetch`                                          | **実測: ファイルが存在しない**（`apps/mobile/src/lib/` は `logger.ts` / `logger.test.ts` / `jest-setup.test.tsx` / `babel-version.test.ts` / `metro-config.test.ts` のみ）              | Task 9-19 の着手条件。無ければ Phase 5 を先に片付ける                                                                                                                                                                                  |
| `apps/mobile/src/lib/query-client.ts` の `createQueryClient`                               | **実測: ファイルが存在しない。** `mutations.retry: false` という既定は Phase 6 計画書の記述に依る                                                                                       | Task 9-19 の着手条件                                                                                                                                                                                                                   |
| `apps/mobile/src/app/(admin)/_layout.tsx` と `(admin)/(tabs)/_layout.tsx`                  | **実測: `apps/mobile/src/app/` にあるのは `index.tsx` / `_layout.tsx` / `_dev/catalog.tsx` だけで、`(admin)` グループが無い**                                                           | Task 9-22 の着手条件。Phase 9 はタブの中身だけを作り、シェルには触らない                                                                                                                                                               |
| 親エリアの **2 段以上の循環**（A を B の親にしてから B を A の親にする）を誰も弾いていない | Task 9-9 の `createArea` / `updateArea` が弾くのは **1 段だけ**（`input.parentId === input.id` / `input.parentId === areaId` → `conflict` → 409）。多段の循環は計画書のどの検査にも無い | Task 9-24 Step 36 の 1。**1 段の検査が実装に入っていることを確かめ**、多段は「弾いていない」と分かった記録をコミットメッセージに残す。実害は小さい（`listAreas` は `parentId === null` を「区」として扱うだけ）ので、塞ぐなら Phase 10 |
| お知らせの件名・本文の最大長（Zod の `.max(n)`）                                           | Task 9-15 で `announcements.ts` のスキーマを書くが、`.max(n)` を置くかを Task 9-24 の時点では確定していない                                                                             | Task 9-24 Step 36 の 2。あれば `n` を定数にして `Input` の `maxLength` に渡す。無ければ**画面にも上限を置かない**（画面だけに置くとサーバが緩めたとき画面が古い上限で止め続ける）                                                      |
| 配信履歴の `audience` に入る文字列の語彙                                                   | Task 9-19 の履歴スキーマは `audience: z.string()` で、決まった語彙か宛先を説明する自由文かが未確定                                                                                      | Task 9-24 Step 36 の 3。語彙なら `labels.ts` に表を足し、`toActionLabel` と同じ「知らないキーはそのまま出す」やり方で和訳する。自由文ならそのまま出す今のままでよい                                                                    |

**上の表に無いものは、すべて実際に確認した。**

計画を書き終えたあとに実ファイルを開いて**確認が取れた**もの（計画書本文の記述と食い違ったものを含む）:

| 確認したもの                                      | 確認した場所                                              | 結果                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app` と `AppType`                                | `apps/api/src/index.ts`                                   | **実在する。**「他フェーズから受け取るもの」の表の「未実装」は誤りだったので**本文を修正済み**。中身は `new Hono<AppEnv>().onError(...).notFound(...).use('*', authMiddleware).route('/me', ...)` の**単一メソッドチェーン**で、18 行目に「途中で変数に切ると `AppType` が痩せる」と明記されている                                               |
| Phase 4 のルート突合テスト                        | `apps/api/src/routes/permission-matrix.test.ts`（628 行） | **実在する**（表の「未実装」は誤りだったので**本文を修正済み**）。`EXPECTED_ROUTE_PATTERNS`（10 本）を `toEqual` で固定し、`collectRouteCoverageViolations` で双方向に突き合わせている。**Task 9-17 で `/admin` を生やすと必ず落ちる**ので、**Task 9-17 の Files: に `Modify` として追加し、Step 5 / Step 6 に実際の書き換えと破壊検証を書いた** |
| リポジトリ規約検査                                | `apps/api/src/repositories/repository-convention.test.ts` | **実在する**（表の「未実装」は誤りだったので**本文を修正済み**）。export 名は `collectConventionViolations` で、`findConventionViolations` は存在しない（**本文 150 行を修正済み**）。`listRepositoryFiles()` は `.ts` かつ `.test.ts` でないものだけを見るので、`__fixtures__/` と `*.test.ts` は自然に外れる                                   |
| 409 ヘルパの不在                                  | `apps/api/src/lib/http-error.ts`                          | `unauthorized` / `forbidden` / `notFound` / `invalidInput` はあるが `conflict` が無い。Task 9-0 が必要であることの裏が取れた                                                                                                                                                                                                                     |
| 門番                                              | `apps/api/src/middleware/role-guard.ts`                   | `roleGuard` / `requireUserActor` / `requireOwnerActor` / `requireAdminActor` / `requireActor` の 5 つが実在。`requireAdminActor` は未認証で 401、非 admin で 403 を投げる                                                                                                                                                                        |
| Actor 生成のホワイトリスト                        | `apps/api/src/auth/actor-encapsulation.test.ts`           | `ACTOR_FACTORY_ALLOWLIST` は `auth/load-actor.ts` / `middleware/auth.ts` / `test/fixtures.ts` の 3 本。計画書の記述と一致                                                                                                                                                                                                                        |
| テスト道具一式                                    | `apps/api/src/test/fixtures.ts`                           | 計画書が列挙した `createTestWorld` / `seedMasters` / `seedUser` / `seedShop` / `seedReview` / `signUpAs` / `readRow` / `countRows` / `runWrite` / `buildActorForTest` / `adminActorOrThrow` などが全部実在                                                                                                                                       |
| お知らせ用テーブルの不在                          | `apps/api/src/db/schema/admin.ts`                         | export されているのは `reports` / `shopApplications` / `notifications` / `auditLogs` の 4 つで、`announcements` は無い。「お知らせ = `notifications` の N 行 + 監査 1 行」という設計判断 4 と整合する                                                                                                                                            |
| `NOTIFICATION_TYPES` に `announcement` があること | `apps/api/src/db/constants.ts:173`                        | `NOTIFICATION_TYPE_ANNOUNCEMENT = 'announcement'` が実在。警告通知を `announcement` 型に載せて action で区別する設計が成り立つ                                                                                                                                                                                                                   |
| 設計書同期テストの比較対象                        | `apps/api/src/db/schema/design-doc-sync.test.ts:72`       | テーブル名の集合だけを `toEqual` で比較している。Phase 9 は新規テーブルを作らないので影響しない                                                                                                                                                                                                                                                  |
| 既存 UI プリミティブ                              | `apps/mobile/src/components/ui/`                          | badge / button / card / empty-state / error-state / icon / input / skeleton の **8 本**が実在（計画書の記述どおり）。新規は 3 つだけで足りる                                                                                                                                                                                                     |
| expo-router のモックの不在                        | `apps/mobile/jest-setup.ts`                               | `react-native-reanimated` のモックだけ。expo-router のモックは無いので、画面テストごとに `jest.mock('expo-router')` を書く必要があるという記述の裏が取れた                                                                                                                                                                                       |
| 型付きルートと React Compiler の有効化            | `apps/mobile/app.json`                                    | `experiments: { typedRoutes: true, reactCompiler: true }` の両方が true                                                                                                                                                                                                                                                                          |
| カバレッジ閾値                                    | `apps/mobile/jest.config.js`                              | `coverageThreshold.global` は 4 指標とも 100、`collectCoverageFrom` は `!src/**/*.test.*` と `!src/app/**` の 2 つだけを除外。**ただしコメントに「実装が入るタイミングで除外を外して同じ 100% を課すこと」とあり、Phase 9 の方針と食い違う**（宿題に回した）                                                                                     |
| 変異テストのしきい値と対象ワークスペース          | `stryker.base.mjs` / 各 `stryker.config.mjs`              | `THRESHOLDS = { high: 95, low: 85, break: 85 }`。設定があるのは `apps/api` / `packages/core` / `packages/geo` の 3 つだけで、**`apps/mobile/stryker.config.mjs` は存在しない**                                                                                                                                                                   |
