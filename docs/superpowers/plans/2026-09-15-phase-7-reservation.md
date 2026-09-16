# Phase 7: 予約（利用者の申込 / 店舗の承認フロー / Durable Objects）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 利用者が店舗の空き枠を見て予約を申し込み、店舗がそれを承認・拒否し、来店またはキャンセルまで記録できる**双方向のフロー**を動かす。同じ枠を複数人が同時に押しても、席数と同時受付数を超えた予約は 1 件も成立しない。

**Architecture:** 予約の「空きを数える → 書き込む」は Durable Object `ReservationLock`（店舗 × 日付ごとに 1 インスタンス）の中で実行し、その臨界区間を `state.blockConcurrencyWhile()` で囲って直列化する。予約の正（source of truth）は D1 にあり、DO はストレージを一切持たない。状態遷移は「TypeScript の遷移表」「SQL の `WHERE` 句」「SQLite の `BEFORE UPDATE` トリガー」の 3 段で縛る。権限は Phase 4 のブランド型 Actor に乗せ、所有者判定は `if` ではなく SQL の `WHERE` 句として書く。

**Tech Stack:** Cloudflare Workers / Durable Objects / D1 / Hono 4.13.7 / Drizzle ORM 0.45.2 / Zod 4.6.5 / Wrangler 4.131.2 / miniflare 5.20260911.1-alpha / esbuild 0.28.2 / Vitest 5.0.0 / Stryker（command ランナー） / Expo SDK 57 / React Native 0.86.3 / expo-router 57.0.21 / TanStack Query 5 / React Hook Form 7.88 / Jest 30 + jest-expo 57 + @testing-library/react-native 14

## Global Constraints

- ファイル名・ディレクトリ名は **kebab-case**（例外なし）。expo-router の動的セグメントは `[reservationId]` のように具体名にする
- 型・コンポーネントは **PascalCase**、関数・変数は **camelCase**、定数は **UPPER_SNAKE_CASE**
- **`any` 禁止**。`as` によるアサーションはブランド型の生成点のみ例外
- **デフォルトエクスポート禁止**。例外は `apps/api/src/index.ts`（Workers のエントリ）と expo-router の画面ファイルだけ
- `console.log` 禁止。API 側は `apps/api/src/lib/logger.ts` の `logError`、モバイル側は `@/lib/logger` を使う
- マジックナンバー禁止。API 側は `apps/api/src/db/constants.ts` か `apps/api/src/lib/constants.ts`、モバイル側は `apps/mobile/src/constants/` に定義する
- 数値には単位を名前に含める（`slotMinutes` / `reservedAtMs` / `RESERVATION_LOCK_TIMEOUT_MS`）。真偽値は `is` / `has` / `can` / `should` で始める
- **新しい npm パッケージをインストールしない。** 本計画書が使う `esbuild` は `apps/api` の devDependencies である `tsx`（`esbuild: ~0.28.0`）と `wrangler`（`esbuild: 0.28.1`）の直接依存として既に入っている（Task 7-7 Step 1 で実在を固定する）
- リポジトリ関数の引数順は **`(db, actor, ...)`**。Actor を取らないリポジトリ関数を作らない（Phase 4 Task 4-10 の機械検査の対象）
- **リポジトリで `db.transaction()` を呼ばない**（D1 は対話型トランザクションを持たない。Phase 4 Task 4-10 の機械検査の対象）
- ハンドラに「この Actor はこの行を触ってよいか」を判定する `if` を書かない。所有者判定は必ずクエリの `WHERE` 句にする
- エラー応答は Phase 4 の `unauthorized()` / `forbidden()` / `notFound()` / `invalidInput()` だけを使い、固定文言以外を返さない
- 外部から来たデータ（HTTP ボディ・クエリ・DO の応答）は必ず Zod で `parse` してから型を信じる
- コメントは日本語で「なぜ」を書く。テスト名も日本語で振る舞いを書く
- 境界値テストは必須（上限ちょうど・下限ちょうどを必ず置く）
- **モバイル側の追加制約（Phase 6 と同じ）**: `exactOptionalPropertyTypes` / `verbatimModuleSyntax` / `noUncheckedIndexedAccess` が有効。型だけの import は `import type`。`className` は NativeWind が `cssInterop` 済みのコンポーネントにしか効かない。RNTL 14 の `render` / `fireEvent` / `renderHook` は Promise を返すので必ず `await` する
- 作業ディレクトリはリポジトリルート `/Users/hattori/Downloads/alee`。API は `-w @meshimap/api`、モバイルは `-w @meshimap/mobile`、core は `-w @meshimap/core`
- Node は 22.23.2（`.nvmrc`）。ターミナルを開くたび `nvm use`。既定の `node` は v20.19.5 なので、素のシェルからは `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"` を先に通す

---

## 着手前の前提確認（このフェーズは他フェーズの未完成物の上に乗っている）

2026-09-16 時点の `git log --oneline` と `find apps/api/src apps/mobile/src -type f` で確認した実際の状態:

| フェーズ    | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 / 2 | **実装済み**。`packages/geo/src/` `packages/core/src/` が揃っている                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase 3     | **実装済み**（`e145304 chore(api): Phase 3 の品質ゲートを通し、偽の 100% を 2 つ潰す`）。`apps/api/src/db/` 一式と `migrations/0000_init.sql` `0001_shops_fts.sql` がある                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase 4     | **着手中**（2026-09-16 時点の最新コミット `32d21f4 test(api): hc<AppType> の RPC 契約と、ルート表と実装の突合を追加`）。実ディレクトリを `ls` して確認した状態: `src/auth/`（`actor.ts` / `auth.ts` / `load-actor.ts`）、`src/middleware/`（`auth.ts` = `authMiddleware` / `error-handler.ts` / `role-guard.ts`）、`src/lib/`（`app-env.ts` / `constants.ts` / `http-error.ts` / `logger.ts` / `parse-id.ts` / `validate.ts`）、`src/routes/`（`me.ts` / `shops.ts` / `reviews.ts` と `routes.test.ts` / `permission-matrix.test.ts` / `tenant-isolation.test.ts` / `rpc-contract.test.ts`）、`src/index.ts`（`export const app` と `export default app`、`export class ReservationLock` は 501 を返す空の雛形）、`src/repositories/`（`shop-repository.ts` / `review-repository.ts` / `repository-convention.test.ts`）。**`src/services/` と `src/schemas/` だけがまだ存在しない**（Task 7-5 が最初に作る） |
| Phase 5     | **未着手**。`apps/mobile/src/app/` には `_layout.tsx` / `index.tsx` / `_dev/catalog.tsx` しか無い                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase 6     | **未着手**。`apps/mobile/src/features/` には `auth/types.ts` しか無い                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**したがって Phase 7 は Phase 4 → 5 → 6 の完了後にしか着手できない。** 本計画書は「Phase 4 / 5 / 6 が各計画書どおりに完了している」ことを前提に書いてある。前提が崩れている名前は下の受け取り表と巻末の「未確認事項」に全部挙げた。着手時はまずその表を実物と突き合わせること。

**実ファイルを開いて確定させた Phase 4 の規約（推測ではない）:**

- `src/lib/http-error.ts` の 4 関数は **`HTTPException` を返す**（`c` を受け取らない）。呼び出し側が `throw unauthorized()` のように投げる。`src/middleware/auth.ts:44` が実際に `throw forbidden()` と書いている
- **`invalidInput()` のステータスは 422**（400 ではない）。本計画書の「入力が不正」のテストはすべて `expect(response.status).toBe(422)` で書く
- エラー応答の形は `{ error: { status, message } }`（`src/middleware/error-handler.ts`）
- `Viewer = Actor | AnonymousActor`、`Actor = UserActor | OwnerActor | AdminActor`。`AnonymousActor.userId` は `null` なので、**所有者スコープの関数に匿名を渡すとコンパイルエラーになる**（型で防げている）

## 他フェーズから受け取るもの（このフェーズでは作らない）

| 提供元                                                                                 | 名前                                                                                                                                                                                                                         | 用途                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 `@meshimap/core`                                                               | `generateSlots(hours, seatSettings, date)` / `canReserve(request)` / `assertSeatSettings(seatSettings)`                                                                                                                      | 予約枠の生成と可否判定                                                                                                                                                                                                                                                                                                                  |
| Phase 2 `@meshimap/core`                                                               | 型 `SeatSettings` / `ReservationSlot` / `ExistingReservation` / `ReservationAvailability` / `ReservationBlockReason` / `ReservationRequest`                                                                                  | 同上                                                                                                                                                                                                                                                                                                                                    |
| Phase 2 `@meshimap/core`                                                               | `reservationCreateSchema` / 型 `ReservationCreateInput`                                                                                                                                                                      | 予約申込の入力検証（API とモバイルで共有）                                                                                                                                                                                                                                                                                              |
| Phase 2 `@meshimap/core`                                                               | `toReservationId` / `toShopId` / `toUserId` / 型 `ReservationId` / `ShopId` / `UserId`                                                                                                                                       | ID のブランド型                                                                                                                                                                                                                                                                                                                         |
| Phase 2 `@meshimap/core`                                                               | `toJstDate` / `addJstDays` / `dayOfWeekOf` / `toJstClock` / 型 `JstDate` / `JstClock` / `DayOfWeek`                                                                                                                          | JST の暦日と現在時刻                                                                                                                                                                                                                                                                                                                    |
| Phase 2 `@meshimap/core`                                                               | `toMinuteOfDay` / `formatMinuteOfDay` / 型 `MinuteOfDay`                                                                                                                                                                     | 時刻（0 時からの分）                                                                                                                                                                                                                                                                                                                    |
| Phase 2 `@meshimap/core`                                                               | `PARTY_SIZE_MIN` / `PARTY_SIZE_MAX` / `RESERVATION_NOTE_MAX_LENGTH` / `MINUTES_PER_DAY` / `MILLISECONDS_PER_MINUTE` / `JST_OFFSET_MINUTES` / `ROLE_USER` / `ROLE_OWNER` / `ROLE_ADMIN` / 型 `Role`                           | 定数とロール                                                                                                                                                                                                                                                                                                                            |
| Phase 3 `apps/api/src/db`                                                              | `reservations` / `seatSettings` / `shops` / `shopHours` / `shopClosures` / `notifications` / `user` のテーブル定義                                                                                                           | スキーマ                                                                                                                                                                                                                                                                                                                                |
| Phase 3 `apps/api/src/db/constants.ts`                                                 | `RESERVATION_STATUS_PENDING` ほか 6 状態 / `RESERVATION_STATUSES` / `RESERVATION_STATUSES_OCCUPYING_SEAT` / `NOTIFICATION_TYPE_RESERVATION_*` 4 種                                                                           | 状態と通知種別                                                                                                                                                                                                                                                                                                                          |
| Phase 3 `apps/api/src/db/testing/local-d1.ts`                                          | `createLocalD1()` / `createMigratedD1()` / `readMigrationSql()` / `toExecutableStatements(sql)` / `applyMigrations(d1)` / 型 `LocalD1`                                                                                       | miniflare 上の本物の D1                                                                                                                                                                                                                                                                                                                 |
| Phase 4 `apps/api/src/lib/http-error.ts`                                               | `unauthorized()` / `forbidden()` / `notFound()` / `invalidInput()` / `ERROR_MESSAGE_*`                                                                                                                                       | 固定文言のエラー                                                                                                                                                                                                                                                                                                                        |
| Phase 4 `apps/api/src/lib/app-env.ts`                                                  | 型 `AppBindings` / `AppVariables` / `AppEnv`                                                                                                                                                                                 | Hono の Env 型                                                                                                                                                                                                                                                                                                                          |
| Phase 4 `apps/api/src/lib/logger.ts`                                                   | `logError(message, cause)`                                                                                                                                                                                                   | 例外の記録                                                                                                                                                                                                                                                                                                                              |
| Phase 4 `apps/api/src/db/client.ts`                                                    | `createDatabase(d1)` / 型 `Database`                                                                                                                                                                                         | Drizzle クライアント                                                                                                                                                                                                                                                                                                                    |
| Phase 4 `apps/api/src/auth/actor.ts`                                                   | `toActor` / `isUserActor` / `isOwnerActor` / `isAdminActor` / `ANONYMOUS_VIEWER` / 型 `Actor` / `UserActor` / `OwnerActor` / `AdminActor` / `Viewer`                                                                         | ブランド型 Actor                                                                                                                                                                                                                                                                                                                        |
| Phase 4 `apps/api/src/middleware/auth.ts`                                              | `authMiddleware`（**実ファイルで確認済み**）                                                                                                                                                                                 | セッション → `viewer`                                                                                                                                                                                                                                                                                                                   |
| Phase 4 `apps/api/src/middleware/error-handler.ts`                                     | `errorHandler` / `notFoundHandler`（**実ファイルで確認済み**）                                                                                                                                                               | 例外 → HTTP 応答                                                                                                                                                                                                                                                                                                                        |
| Phase 4 `apps/api/src/middleware/role-guard.ts`                                        | `roleGuard(...roles)` / `requireUserActor(c)` / `requireOwnerActor(c)` / `requireAdminActor(c)` / `requireActor(c)`（**実ファイルで確認済み**。`require-actor.ts` という別ファイルは無い）                                   | 認証・認可                                                                                                                                                                                                                                                                                                                              |
| Phase 4 `apps/api/src/repositories/shop-repository.ts`                                 | `findVisibleShop(db, viewer, shopId)` / 型 `ShopRow`                                                                                                                                                                         | 店舗の可視性判定                                                                                                                                                                                                                                                                                                                        |
| Phase 4 `apps/api/src/lib/parse-id.ts` / `validate.ts`                                 | `parseShopId(value: string): ShopId` / `parseReviewId` / `generateShopId()` / `generateReviewId()` / `jsonBody<TSchema extends ZodType>(schema)`（**実ファイルで確認済み**。不正な ID は 422 ではなく **404** に寄せてある） | URL とボディのパース                                                                                                                                                                                                                                                                                                                    |
| Phase 4 `apps/api/src/index.ts`                                                        | `app` / 型 `AppType` / `class ReservationLock`（**空の雛形**。Phase 7 が中身を入れる）                                                                                                                                       | Workers のエントリ                                                                                                                                                                                                                                                                                                                      |
| Phase 4 `apps/api/src/test/fixtures.ts`                                                | `createTestWorld()` / `createTestBindings(world)` / `signUpAs(world, email, role)` / `seedMasters` / `seedShop` / `readRow` / `runWrite` / `countRows` / 型 `TestWorld` / `TestUser`                                         | テスト用の世界                                                                                                                                                                                                                                                                                                                          |
| Phase 5 `apps/mobile/src/lib/api-client.ts`                                            | `apiFetch(path, init): Promise<unknown>` / `ApiError`                                                                                                                                                                        | 認証ヘッダ付きの HTTP 呼び出し。**名前が食い違っている。** Phase 5 の計画書（Task 5-3）が作るのは `hc<AppType>` の `apiClient` と `buildAuthHeaders` であり、`apiFetch` / `ApiError` は Phase 6 の計画書（Task 6-8）が前提にしている名前。実ファイルは未作成なので**未確認**。Task 7-14 Step 1 で実物を確認し、無ければ同ステップで足す |
| Phase 5 `apps/mobile/src/features/auth/use-session.ts`                                 | `useSession(): { userId: UserId \| null; isAuthenticated: boolean }`                                                                                                                                                         | ログイン中のユーザー                                                                                                                                                                                                                                                                                                                    |
| Phase 5 `apps/mobile/src/app/(user)/(tabs)/_layout.tsx` / `(owner)/(tabs)/_layout.tsx` | タブレイアウト                                                                                                                                                                                                               | 本フェーズは中身の画面だけを作る                                                                                                                                                                                                                                                                                                        |
| Phase 6 `apps/mobile/src/features/shops/`                                              | `shopKeys` / `fetchShopDetail(shopId)` / 型 `ShopDetail` / `ShopSummary`                                                                                                                                                     | 予約画面のヘッダに店舗名を出す                                                                                                                                                                                                                                                                                                          |
| Phase 6 `apps/mobile/src/components/ui/`                                               | `Button` / `Card` / `Badge` / `Input` / `Skeleton` / `EmptyState` / `ErrorState` / `Icon`                                                                                                                                    | 画面の部品                                                                                                                                                                                                                                                                                                                              |

---

## 裏取りした事実（2026-09-16、実際にコードを走らせて測った）

**この節の数字はすべて実測値である。** 実行環境は macOS 24.6.0 / Node v22.23.2 / miniflare 5.20260911.1-alpha（workerd 1.20260911.1）。バージョンは `node -p "require('./node_modules/<pkg>/package.json').version"` で確認した:

```
node                         v22.23.2
miniflare                    5.20260911.1-alpha
workerd                      1.20260911.1
wrangler                     4.131.2
esbuild                      0.28.2
@cloudflare/workers-types    5.20260915.1
drizzle-orm                  0.45.2
hono                         4.13.7
zod                          4.6.5
vitest                       5.0.0
```

### 事実 1: D1 だけでは二重予約を防げない

同じ枠に対する「空き確認 → INSERT」を D1 で素直に書き、`Promise.all` で **10 本同時**に投げた。書いたのはこういうコードである:

```js
// 空きを読む
const { results } = await env.DB.prepare(
  'SELECT COALESCE(SUM(party_size), 0) AS taken FROM reservations WHERE shop_id = ? AND reserved_at = ?',
).bind(shopId, reservedAtMs).all();
// 空いていれば書く
if (results[0].taken + partySize <= capacity) {
  await env.DB.prepare('INSERT INTO reservations (...) VALUES (...)').bind(...).run();
}
```

実測結果（capacity を超えないはずの枠に 10 本同時）:

| 試行             | 1   | 2   | 3   | 4   | 5   | 6   |
| ---------------- | --- | --- | --- | --- | --- | --- |
| 成功と応答した数 | 10  | 10  | 10  | 10  | 10  | 10  |
| 実際に入った行数 | 10  | 10  | 10  | 10  | 10  | 10  |

**6 回中 6 回、10 本すべてが成功した。** 10 本の SELECT が全部 INSERT より先に走るからで、いわゆる Read-Modify-Write の競合である。

「トランザクションを張ればいい」は D1 では成立しない。実測した:

- `typeof d1.transaction` → `'undefined'`（D1Database に対話型トランザクションのメソッドが無い）
- `Object.getOwnPropertyNames(d1)` → `['alwaysPrimarySession', 'fetcher']`
- `d1.batch([select, insert])` に置き換えても **3 回中 3 回とも 10 成功 / 10 行**。`batch` は複数ステートメントを 1 往復で送るだけで、**別リクエスト同士を直列化しない**

### 事実 2: Durable Object は必要だが、それだけでは足りない

同じ処理を Durable Object（`idFromName` で店舗 × 日付ごとに 1 インスタンス）の中に移した。DO には **入力ゲート**があり、`fetch` の処理中に来た次のリクエストは待たされる……のだが、**ゲートが閉じたままなのはストレージ操作を await している間だけで、それ以外の await（D1 呼び出しはこれに当たる）はゲートを開けてしまう。**

実測（DO の中で、`blockConcurrencyWhile` を使わずに D1 の read→write をそのまま書いた場合の「成功数」）:

| 同時数 | 試行ごとの成功数                          |
| ------ | ----------------------------------------- |
| 10 本  | 1, 1, 1, **2**, 1, 1                      |
| 20 本  | 1, 1, 1, 1, 1, 1, **3**, 1, **11**, **4** |

**ほとんどの回は 1 件で正しく見えるが、20 本では 10 回中 4 回壊れた（最悪 11 件通った）。** これが一番危ない形である。手で叩く限り再現せず、負荷がかかった本番でだけ壊れる。

`state.blockConcurrencyWhile()` で read→write 全体を包むと:

| 同時数 | 試行ごとの成功数             |
| ------ | ---------------------------- |
| 10 本  | 1, 1, 1, 1, 1, 1             |
| 20 本  | 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 |

**10 回中 10 回、ちょうど 1 件。**

さらに、本番と同じ条件（実物の `0000_init.sql` + `0001_shops_fts.sql` を流し、`seat_settings` に `capacity=4 / slot_minutes=60 / max_parallel=2 / accepts_reservation=1` を入れ、DO の中で Drizzle と `canReserve()` を実際に呼ぶ）で **20 本同時 × 5 回**:

| 条件                         | 成功数 / D1 の行数    | 拒否理由               |
| ---------------------------- | --------------------- | ---------------------- |
| `blockConcurrencyWhile` あり | **2 / 2** が 5 回とも | すべて `parallel-full` |
| `blockConcurrencyWhile` なし | 17, 3, 20, 20, 20     | —                      |

`max_parallel=2` なので 2 件が正解。**ゲートありは 5 回とも仕様どおり、ゲートなしは 5 回とも壊れた。**

→ **結論: DO を使うことと `state.blockConcurrencyWhile()` で囲うことはセットであり、片方だけでは意味がない。** Task 7-6 のコードはこれを前提に書いてある。

### 事実 3: miniflare はローカルで Durable Objects を動かせる

`new Miniflare({ modules: true, script, durableObjects: { RESERVATION_LOCK: 'ReservationLock' }, d1Databases: { DB: ':memory:' } })` で DO を起動し、`await mf.getDurableObjectNamespace('RESERVATION_LOCK')` → `ns.get(ns.idFromName(name))` → `stub.fetch(...)` が動くことを確認した。上の表の数字はすべてこの経路で取ったものである。

ただし miniflare に渡せるのは**バンドル済みの 1 ファイル**なので、TypeScript の DO をテストから使うには esbuild で束ねる必要がある（Task 7-7）。

`idFromName` の挙動も確認した:

- `idFromName('shp_test_0001:2026-10-01')` を 2 回呼ぶと**同じ 64 桁の 16 進 ID**を返す（安定している）
- 日付だけ変えた `'shp_test_0001:2026-10-02'` は**別の ID** になる

→ **DO ID の決定: `env.RESERVATION_LOCK.idFromName(`${shopId}:${date}`)`。** `shopId` は `shp_` で始まる識別子、`date` は `YYYY-MM-DD` の JST 暦日。この粒度にする理由:

- **店舗ごとに分けないと**、無関係な店の予約まで 1 つの DO に直列化されて全体のスループットが落ちる
- **日付ごとに分けないと**、人気店の 1 インスタンスに全日程が集中する
- **枠（時刻）ごとまで細かくしない**のは、`canReserve()` が「同じ枠の予約件数」だけでなく「同一枠の合計人数」を見るため、同じ日の枠を跨いだ判定を将来入れる余地を残すから。また枠単位にすると 1 日 20 枠 × 店舗数ぶんの DO が増え、cold start が増える

### 事実 4: SQLite の CHECK 制約では状態遷移を縛れないが、トリガーなら縛れる

CHECK 制約は行の新しい値しか見られず `old.status` を参照できない。D1 上で実際に流して、**`BEFORE UPDATE OF status` トリガーなら縛れる**ことを確認した:

```sql
CREATE TRIGGER trg_reservations_status_transition
BEFORE UPDATE OF status ON reservations FOR EACH ROW
WHEN old.status <> new.status AND NOT (
  (old.status = 'pending' AND new.status IN ('confirmed', 'rejected', 'cancelled')) OR
  (old.status = 'confirmed' AND new.status IN ('completed', 'cancelled', 'no_show'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid reservation status transition');
END;
```

実測:

| 操作                              | 結果                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pending` → `confirmed`           | OK                                                                                                            |
| `pending` → `rejected`            | OK                                                                                                            |
| `confirmed` → `completed`         | OK                                                                                                            |
| `pending` → `completed`           | `D1_ERROR: invalid reservation status transition: SQLITE_CONSTRAINT`（extended: `SQLITE_CONSTRAINT_TRIGGER`） |
| `pending` → `no_show`             | 同上（ABORT）                                                                                                 |
| `completed` → `cancelled`         | 同上（ABORT）                                                                                                 |
| `rejected` → `confirmed`          | 同上（ABORT）                                                                                                 |
| `status = 'zzz'`（未知の値）      | 同上（ABORT）。既存の `ck_reservations_status` より前にトリガーが発火する                                     |
| `confirmed` → `confirmed`（同値） | OK（`old.status <> new.status` で除外しているため）                                                           |
| 存在しない id の UPDATE           | OK、`changes = 0`                                                                                             |

### 事実 5: 既存テーブルへの CHECK 付き列追加は D1 で通る

`owner_memo`（店舗側の内部メモ）を後から足せることを実測した:

```sql
ALTER TABLE `reservations` ADD COLUMN `owner_memo` text CONSTRAINT "ck_reservations_owner_memo_length" CHECK(length("reservations"."owner_memo") <= 500);
```

- 実行が通り、`sqlite_master` の `CREATE TABLE` 文に制約名ごと残る
- 500 文字 → OK、501 文字 → `SQLITE_CONSTRAINT`、`NULL` → OK

この DDL の文字列は Drizzle の `lengthAtMost()`（`apps/api/src/db/sql-helpers.ts`）が生成する形と一致する。だが **`apps/api/src/db/schema/check-constraints.test.ts` には罠がある**:

```ts
const MIGRATION_PATH = join(SCHEMA_DIR, '../../../migrations/0000_init.sql');
```

`constraintNamesInMigration()` はこの **`0000_init.sql` だけ**を読む（一方 `countChecksInMigration()` は `readMigrationSql()` で全マイグレーションを読む）。`0002` に CHECK を足すと「Drizzle 側の CHECK 制約名がマイグレーションと過不足なく一致する」が落ちる。Task 7-3 でこの関数を全マイグレーション読みに直す。

---

### 事実 6: リポジトリの引数順は既に機械的に強制されている

`apps/api/src/repositories/repository-convention.test.ts` を読んだ（Phase 4 Task 4-8 のコミット `41b83bd` 時点で実在）。`src/repositories/` 配下の **`.test.ts` でない `.ts` すべて**を TypeScript の AST で走査し、次を違反として拾う:

| 検査                                                                                  | 違反になる例                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 第 1 引数が `db: Database` でない                                                     | `findX(database: Database, ...)`（名前が違う）    |
| 第 2 引数の名前が `actor` / `_actor` / `viewer` / `_viewer` でない                    | `findX(db, currentUser, ...)`                     |
| 第 2 引数の型が `UserActor` / `OwnerActor` / `AdminActor` / `Actor` / `Viewer` でない | `findX(db, userId: string, ...)`                  |
| 引数が 2 つ未満                                                                       | `listAll(db)`                                     |
| `db.transaction(` を含む                                                              | D1 に対話型トランザクションが無いため文字列で禁止 |
| `export default`                                                                      | 規約どおり全面禁止                                |
| `export *` / `export * as` / 別モジュールからの再エクスポート                         | 署名が検査から外れるため                          |
| `export class`                                                                        | リポジトリ層は関数だけを export する              |
| 関数リテラルでもリテラル定数でもない `export const`                                   | 関数が隠れていても検査できないため                |
| export された関数が 1 つも無い                                                        | 空ファイルの取りこぼし防止                        |

**Phase 7 で作る 4 つのリポジトリはこの検査を必ず通る形にしてある。** `reservation-slot-repository.ts` の `findSlotContext(db, viewer, ...)`、`reservation-repository.ts` の 3 つの `(db, actor: Actor, ...)`、`owner-reservation-repository.ts` の 4 つの `(db, actor: OwnerActor, ...)`、`notification-repository.ts` の `createNotification(db, actor: Actor, input)` がそれで、非公開のヘルパ（`ownedByReader` / `ownedByWriter` / `findRecipientId`）は export しないので検査の対象外になる。

**この検査があるおかげで、Phase 7 の権限設計は「書き忘れ」では破れない。** 権限を無視したリポジトリ関数を足そうとすると、Actor 引数が無い時点でこのテストが落ちる。

### 事実 7: Hono の `app.routes` はマウント後の完全なパスを持つ

Task 7-13 の「エンドポイントを足したのに権限テストを足し忘れた」を機械的に検出するために、`app.routes` が何を返すか実測した（hono 4.13.7、`node_modules/hono/dist/types/hono-base.d.ts:75` に `routes: RouterRoute[]`、`RouterRoute` は `types.d.ts:26` で `{ basePath; path; method; handler }`）。

`.route('/owner/reservations', child)` でマウントした子アプリについて、親の `app.routes` は次を返した:

```
GET    /reservation-slots                          basePath /
POST   /reservations                               basePath /
ALL    /owner/reservations/*                       basePath /owner/reservations
GET    /owner/reservations                         basePath /owner/reservations
GET    /owner/reservations/:reservationId          basePath /owner/reservations
POST   /owner/reservations/:reservationId/status   basePath /owner/reservations
PATCH  /owner/reservations/:reservationId/memo     basePath /owner/reservations
```

読み取れること:

- `path` は**マウント後の完全なパス**。子アプリ側で書いた `/:reservationId` ではなく `/owner/reservations/:reservationId` が入る
- 子アプリの `.get('/')` は `/owner/reservations` になる（末尾スラッシュは付かない）
- `.use('*', ...)` のミドルウェアは `method: 'ALL'` で混ざる。**エンドポイントを数えるときは `method === 'ALL'` を除く**

Task 7-13 の網羅検査はこの 3 点に乗る。

**そして、この `app.routes` を突き合わせているテストが Phase 4 に既にある。** `apps/api/src/routes/permission-matrix.test.ts`（628 行、コミット `32d21f4 test(api): hc<AppType> の RPC 契約と、ルート表と実装の突合を追加`）を実際に開いて確認した。

| 名前（行番号）                                                                    | 何をするか                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectEndpointPatterns(routes, authBasePath)`（454 行）                         | `method === 'ALL' && path.endsWith('*')` のミドルウェアと `AUTH_BASE_PATH` 配下を除き、`` `${method} ${path}` `` を Set で潰して `.sort()` した配列を返す（export 済み）  |
| `collectRouteCoverageViolations(routes, coveredPatterns, authBasePath)`（468 行） | **両方向**を見る。実装にあって表に無ければ `権限マトリクスに無いエンドポイント: <pattern>`、表にあって実装に無ければ `実装に無いエンドポイント: <pattern>`（export 済み） |
| `EXPECTED_ROUTE_PATTERNS`（503 行）                                               | Phase 4 の 10 本をソート済みでベタ書きした配列                                                                                                                            |
| `ENDPOINT_CASES`（93 行）                                                         | Phase 4 の権限マトリクスをそのままデータにした配列。各要素が `routePattern: string` と `requestPath` を持ち、**実際に HTTP を叩いて**主体ごとの期待ステータスを比べる     |

**行番号は `32d21f4` 時点のもの。** Phase 4 側でこのファイルがさらに動く可能性があるので、実装時は行番号ではなく名前で探すこと。

突き合わせている `it` は 2 本ある（619 行と 623 行）:

```ts
it('app に登録されたエンドポイントは 10 本で、想定どおりの並びである', () => {
  expect(declaredRoutePatterns()).toEqual(EXPECTED_ROUTE_PATTERNS);
});

it('権限マトリクスは app のエンドポイントを 1 本残らず覆っている', () => {
  // #4 と #5 のように 1 本のルートを複数ケースで検証しているので、重複は潰して比べる
  const covered = ENDPOINT_CASES.map((endpoint) => endpoint.routePattern);
  expect(collectRouteCoverageViolations(app.routes, covered, AUTH_BASE_PATH)).toEqual([]);
});
```

そして `EXPECTED_ROUTE_PATTERNS` の直前のコメント（502 行）がこう書いてある:

```ts
/** 権限マトリクスが責任を持つ 10 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
```

**帰結: Phase 7 が `app` にエンドポイントを 1 本足した瞬間、Phase 4 のこの 2 本が落ちる。** Task 7-13 で別ファイル（`reservation-permission-matrix.test.ts`）に予約の表を作っても、この 2 本は救われない。2 つの配列は Phase 4 のファイルの中にあり、そこを直さない限り「実装だけが増えた」状態になるからである。

**そこで 7-5 / 7-8 / 7-10 / 7-12 は、ルートを登録するのと同じコミットで `apps/api/src/routes/permission-matrix.test.ts` を直す。** 4 タスクの **Files:** に `Modify` として挙げ、各ステップに「直さないと何というメッセージで落ちるか」を書いた。Phase 7 を全部終えたときの `EXPECTED_ROUTE_PATTERNS` は 10 + 9 = 19 本になる。

**`ENDPOINT_CASES` のほうには予約のケースを足さない。** 理由は 2 つある。

1. `ENDPOINT_CASES` の各行は `requestPath` を**実際に叩いて**期待ステータスを比べる。予約の行を足すには、このファイルの seed に営業時間・席設定・既存予約を増やすことになり、**Task 7-13 の 9 × 6 の表と同じものを 2 か所で育てる**ことになる
2. Phase 4 のこのファイルの責務は「全エンドポイントの棚卸し」であって、予約の権限仕様そのものではない

代わりに、**「主体ごとの総当たりを別ファイルに委ねている」ことを明示するデータ**（`DELEGATED_ROUTE_PATTERNS`）を足して `covered` に混ぜる。委譲リストは Task 7-5 で導入し、7-8 / 7-10 / 7-12 が行を足していく。

**この委譲リストは「証明」ではなく「道標」である。** 実際に 9 エンドポイント × 6 主体を叩いて検証するのは Task 7-13 の `reservation-permission-matrix.test.ts` で、そのファイルの中に「`app.routes` の予約系と `AUTHORIZATION_CASES` が集合として一致する」テストがある（Task 7-13 Step 5）。委譲リストの役目は、**後のフェーズで予約系のルートを増やした人が `permission-matrix.test.ts` で必ず一度落ちて、委譲先のファイル名を読むことになる**点にある。リストを自動生成にすると、ルートを足すだけで黙って緑になり、この道標が消える。

---

### 事実 8: DO の受け口は狭めれば `as` なしでテストできる

`DurableObjectNamespace` は `node_modules/@cloudflare/workers-types/index.d.ts:648` で **abstract class** として宣言されている。クラスなので、テスト用の偽物を `DurableObjectNamespace` 型の変数に入れるには `as unknown as DurableObjectNamespace` が要る。**`as` はコーディング規約 2 章（`docs/CODING_GUIDELINES.md:82`）で禁止**で、例外はブランド型の生成だけである。

そこで、本番コードが実際に使う 2 メソッドだけを写した型で受けることにして、それが成り立つか `tsc` で実測した。`apps/api/src/probe-lock.ts` を一時的に置いて `npx tsc --noEmit -p tsconfig.json` を通した:

```ts
export type ReservationLockStub = {
  fetch(input: string, init: RequestInit): Promise<Response>;
};
export type ReservationLockNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): ReservationLockStub;
};

declare const real: DurableObjectNamespace;
const asNarrow: ReservationLockNamespace = real; // 本物が構造的に満たすか

function fakeId(name: string): DurableObjectId {
  return { toString: () => name, equals: (other) => other.toString() === name, name };
}
const fake: ReservationLockNamespace = {
  idFromName(name: string) {
    return fakeId(name);
  },
  get() {
    return {
      async fetch(_input: string, _init: RequestInit) {
        return Response.json({ isGranted: true });
      },
    };
  },
};
```

結果: **`exit=0`（エラー 0 件）**。つまり

- 本物の `DurableObjectNamespace` はこの狭い型を構造的に満たす（`get(id, options?)` は引数が多い側なので、少ない側の型に代入できる）
- テスト用の偽物は `as` なしで書ける。`DurableObjectId` は interface（`index.d.ts:642`）なので、4 メンバを普通に実装すればよい

検査が生きていることも確かめた。`const asNarrow: ReservationLockNamespace = 42;` に書き換えると `src/probe-lock.ts(14,7): error TS2322: Type 'number' is not assignable to type 'ReservationLockNamespace'.` が出る。確認後 `probe-lock.ts` は削除した（リポジトリには残していない）。

**この型は Task 7-6 で `reservation-lock-protocol.ts` に置き、Task 7-8 の `createReservation` が受け口に使う。** 呼び出し側は `c.env.RESERVATION_LOCK` をそのまま渡せる。

---

## ファイル構成

### `packages/core`（純粋なドメイン。D1 も Workers も知らない）

| ファイル                                | 責務                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `src/jst-clock.ts`（**変更**）          | `toJstInstant(date, minute)` を追加。JST の暦日＋分 → `Date` |
| `src/reservation-status.ts`（**新規**） | 状態の一覧・遷移表・`canTransitionReservationStatus` ほか    |
| `src/index.ts`（**変更**）              | 上記の再エクスポート                                         |

### `apps/api`

| ファイル                                                           | 責務                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `migrations/0002_reservation_flow.sql`（**新規**）                 | 遷移トリガー + `owner_memo` 列                                                                                            |
| `src/db/schema/reservation.ts`（**変更**）                         | `ownerMemo` 列と CHECK を Drizzle 側にも反映                                                                              |
| `src/db/schema/check-constraints.test.ts`（**変更**）              | 制約名の読み取りを全マイグレーションに広げ、新制約のケースを足す                                                          |
| `src/db/constants.ts`（**変更**）                                  | `RESERVATION_OWNER_MEMO_MAX_LENGTH` を追加                                                                                |
| `src/repositories/reservation-slot-repository.ts`（新規）          | 枠計算に要る店舗設定・営業時間・休業日・既存予約をまとめて読む                                                            |
| `src/repositories/reservation-repository.ts`（新規）               | 予約の読み書き。所有権は全部 `WHERE` 句                                                                                   |
| `src/repositories/notification-repository.ts`（新規）              | 通知レコードの作成                                                                                                        |
| `src/services/reservation-slot-service.ts`（新規）                 | 枠の一覧と空き状況を組み立てる                                                                                            |
| `src/services/reservation-create-service.ts`（新規）               | 申込を組み立てて DO に渡す（Task 7-8）                                                                                    |
| `src/services/reservation-status-service.ts`（新規）               | 店舗側の状態遷移と通知をまとめる（Task 7-12）                                                                             |
| `src/services/reservation-notification-service.ts`（新規）         | 4 種類の通知本文を組み立てて `notifications` に落とす（Task 7-12）                                                        |
| `src/lib/parse-id.ts`（既存に追記）                                | `generateReservationId()` / `generateNotificationId()` / `parseReservationId()`（Task 7-8 / 7-10）                        |
| `src/db/schema/admin.ts`（**変更**）                               | 通知の長さ上限 2 つを export する（Task 7-12）                                                                            |
| `src/durable-objects/reservation-lock.ts`（新規）                  | `ReservationLock` 本体。臨界区間だけを持つ                                                                                |
| `src/durable-objects/reservation-lock-protocol.ts`（新規）         | DO との往復メッセージの Zod スキーマと型                                                                                  |
| `src/durable-objects/reservation-lock.concurrency.test.ts`（新規） | miniflare + esbuild で同時実行を実測するテスト                                                                            |
| `src/test/build-worker.ts`（新規）                                 | esbuild で DO 入りワーカーを束ねるテストヘルパー                                                                          |
| `src/routes/reservation-slots.ts`（新規）                          | `GET /reservation-slots`                                                                                                  |
| `src/routes/reservations.ts`（新規）                               | 利用者側の予約 API                                                                                                        |
| `src/routes/owner-reservations.ts`（新規）                         | 店舗側の予約 API（Task 7-12）                                                                                             |
| `src/routes/reservation-permission-matrix.test.ts`（新規）         | 全 9 エンドポイントの 401 / 403 / 404 の網羅テスト（Task 7-13）                                                           |
| `src/routes/permission-matrix.test.ts`（**変更**）                 | Phase 4 の棚卸し。予約 9 本ぶん `EXPECTED_ROUTE_PATTERNS` と `DELEGATED_ROUTE_PATTERNS` に追記（7-5 / 7-8 / 7-10 / 7-12） |
| `src/schemas/reservation-schema.ts`（新規）                        | API 固有の入出力スキーマ（core に無いもの）                                                                               |
| `src/index.ts`（**変更**）                                         | 3 つのルータをマウントし、`ReservationLock` を再エクスポート                                                              |

### `apps/mobile`

| ファイル                                                             | 責務                                         |
| -------------------------------------------------------------------- | -------------------------------------------- |
| `src/features/reservations/schema.ts`（新規）                        | API レスポンスの実行時検証と、そこから導く型 |
| `src/features/reservations/api.ts`（新規）                           | `apiFetch` を包んだ関数群                    |
| `src/features/reservations/query-keys.ts`（新規）                    | `reservationKeys`                            |
| `src/features/reservations/use-reservation-slots.ts`（新規）         | 空き枠の取得                                 |
| `src/features/reservations/use-reservations.ts`（新規）              | 一覧・詳細の取得                             |
| `src/features/reservations/use-create-reservation.ts`（新規）        | 申込のミューテーション                       |
| `src/features/reservations/use-cancel-reservation.ts`（新規）        | キャンセル                                   |
| `src/features/reservations/use-owner-reservations.ts`（新規）        | 店舗側の一覧・詳細                           |
| `src/features/reservations/use-update-reservation-status.ts`（新規） | 承認・拒否・来店・無断キャンセルと店舗メモ   |
| `src/features/reservations/status-label.ts`（新規）                  | 状態 → 日本語ラベルと色                      |
| `src/features/reservations/format.ts`（新規）                        | 日付・時刻・人数の表示書式                   |
| `src/test-support/reservation-fixtures.ts`（新規）                   | テスト用の予約フィクスチャ                   |
| `src/components/reservation/slot-picker.tsx`（新規）                 | 枠の選択 UI                                  |
| `src/components/reservation/reservation-card.tsx`（新規）            | 一覧の 1 行                                  |
| `src/components/reservation/reservation-status-badge.tsx`（新規）    | 状態バッジ                                   |
| `src/app/(user)/shop/[shopId]/reserve.tsx`（新規）                   | 予約申込画面                                 |
| `src/app/(user)/reservations/index.tsx`（新規）                      | 利用者の予約一覧                             |
| `src/app/(user)/reservations/[reservationId].tsx`（新規）            | 利用者の予約詳細                             |
| `src/app/(owner)/(tabs)/reservations.tsx`（新規）                    | 店舗の予約一覧                               |
| `src/app/(owner)/reservations/[reservationId].tsx`（新規）           | 店舗の予約詳細と承認操作                     |

---

## 権限マトリクス

Actor は Phase 4 のブランド型（`AnonymousActor` / `UserActor` / `OwnerActor` / `AdminActor`）。「自分の」「自店の」は**すべて SQL の `WHERE` 句で表現する**。ハンドラに所有者判定の `if` を書かない。

| 操作                                  | 匿名 | user            | owner（自店）   | owner（他店） | admin           | 実現方法                                                       |
| ------------------------------------- | ---- | --------------- | --------------- | ------------- | --------------- | -------------------------------------------------------------- |
| `GET /reservation-slots`              | 200  | 200             | 200             | 200           | 200             | 公開情報。`findVisibleShop` で非公開店だけ 404                 |
| `POST /reservations`                  | 401  | 201             | 201             | 201           | 201             | `requireUserActor` ではなく `requireActor`（誰でも客になれる） |
| `GET /reservations`（自分の一覧）     | 401  | 200（自分のみ） | 200（自分のみ） | —             | 200（自分のみ） | `where eq(reservations.userId, actor.userId)`                  |
| `GET /reservations/:id`（他人の）     | 401  | **404**         | **404**         | **404**       | **404**         | 同上の `WHERE` に id を足すだけ。0 行 → `null` → 404           |
| `POST /reservations/:id/cancel`       | 401  | 自分のみ 200    | 自分のみ 200    | **404**       | **404**         | `WHERE id = ? AND user_id = ? AND status IN (...)`             |
| `GET /owner/reservations`             | 401  | **403**         | 200（自店のみ） | 200（0 件）   | **403**         | `roleGuard(ROLE_OWNER)` + `WHERE shops.owner_id = ?`           |
| `GET /owner/reservations/:id`         | 401  | **403**         | 200             | **404**       | **403**         | `innerJoin(shops)` + `WHERE shops.owner_id = ?`                |
| `POST /owner/reservations/:id/status` | 401  | **403**         | 200             | **404**       | **403**         | `WHERE shop_id IN (SELECT id FROM shops WHERE owner_id = ?)`   |
| `PATCH /owner/reservations/:id/memo`  | 401  | **403**         | 200             | **404**       | **403**         | 同上                                                           |

**403 と 404 の使い分け（Phase 4 の規約を踏襲）:**

- **401** — 認証情報が無い / 無効
- **403** — 認証はできたがロールが違う（user が `/owner/*` を叩いた）。**行の所有者かどうかでは 403 を返さない**
- **404** — 行が無い、または自分のものではない。**この 2 つを外から区別させない**（他人の予約 ID の存在を漏らさないため）
- **422** — 入力の形が不正（`invalidInput()`）。**「その状態遷移はできない」もここに寄せる**。409 は使わない——遷移の可否は「入力が現在の状態と噛み合っていない」であって、リソースの競合ではないため

admin を Phase 7 の予約フローから外したのは、「店主の代わりに承認する admin」は運用ルールが固まっていないため。admin は Phase 10 のモデレーション範囲で扱う。

---

## 予約の状態遷移

`apps/api/src/db/constants.ts` に既にある 6 状態を使う（新しい状態は増やさない）。

| from                                               | to          | 実行できる主体 | API                                   | 意味                        |
| -------------------------------------------------- | ----------- | -------------- | ------------------------------------- | --------------------------- |
| （なし）                                           | `pending`   | user           | `POST /reservations`                  | 申込。DO の中でだけ作られる |
| `pending`                                          | `confirmed` | owner          | `POST /owner/reservations/:id/status` | 承認                        |
| `pending`                                          | `rejected`  | owner          | `POST /owner/reservations/:id/status` | 拒否                        |
| `pending`                                          | `cancelled` | user           | `POST /reservations/:id/cancel`       | 承認前の取り下げ            |
| `confirmed`                                        | `cancelled` | user           | `POST /reservations/:id/cancel`       | 承認後のキャンセル          |
| `confirmed`                                        | `completed` | owner          | `POST /owner/reservations/:id/status` | 来店した                    |
| `confirmed`                                        | `no_show`   | owner          | `POST /owner/reservations/:id/status` | 無断キャンセル              |
| `rejected` / `cancelled` / `completed` / `no_show` | —           | —              | —                                     | 終端。ここからは動かない    |

**この表を 3 段で縛る:**

1. **型**（Task 7-2）— `RESERVATION_TRANSITIONS` と `canTransitionReservationStatus(from, to, by)`。`ReservationStatusTransition` のユニオン型で、存在しない組み合わせはコンパイル時に書けない
2. **SQL の `WHERE` 句**（Task 7-10 / 7-12）— `UPDATE ... WHERE status IN (:許される from)`。0 行更新なら「その遷移はできない」なので `invalidInput()`（**422**）に寄せる。409 は使わない
3. **DB のトリガー**（Task 7-3）— 上の 2 つをすり抜けた書き込みを `RAISE(ABORT)` で止める最後の壁

1 だけだと SQL を直接書く別経路をすり抜ける。2 だけだと遷移表と `WHERE` 句がずれたときに気づけない。3 だけだとエラーメッセージが利用者に出せない。**3 つとも要る。**

`seat_settings.acceptsReservation` が false の店舗では枠は出るが `canReserve()` が `not-accepting` を返すため、`pending` すら作られない。

---

## ミューテーションテスト方針

`npm run test:mutation -w @meshimap/core` と `-w @meshimap/api` を通す。しきい値は `stryker.base.mjs` の `THRESHOLDS = { high: 95, low: 85, break: 85 }`、実質の目標は **100%**。

**生き残った変異（Survived）への対応は 3 つしかない。**「除外する」は選択肢にない。Phase 3 Task 3-14 Step 9.5 で確立した分類をそのまま使う:

1. **テストの穴** → **テストを足す。** 変異が生き残ったのは、その分岐・その境界を誰も確かめていないということ。境界値（`<=` を `<` にした変異は「ちょうど上限」のテストでしか死なない）を追加する
2. **出力を変えない最適化** → **呼び出し回数で縛る。** 例: 早期 return を消しても最終的な戻り値は同じ、という変異は値のアサーションでは死なない。`vi.fn()` のスパイを置いて「D1 に問い合わせたのは 1 回だけ」のように**回数**をアサートして殺す
3. **到達不能なコード** → **到達できる形に書き直してから殺す。** 型で潰れていて絶対に通らない分岐は、コードが余計。防御的な `if` を消すか、通る経路を作ってテストする

Phase 7 で特に生き残りやすい箇所と、あらかじめ決めた殺し方:

| 生き残りやすい変異                                  | 分類 | 殺し方                                                                                        |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `canTransitionReservationStatus` の `===` → `!==`   | 1    | 許可される 6 遷移と、禁止される組み合わせの全網羅テスト（Task 7-2）                           |
| `blockConcurrencyWhile` の呼び出しを消す変異        | 2    | `state.blockConcurrencyWhile` のスパイで「臨界区間ごとにちょうど 1 回」をアサート（Task 7-6） |
| `remainingSeats` の `Math.max(0, ...)` の `0` → `1` | 1    | 定員ちょうどのときに `remainingSeats === 0` を見る境界テスト                                  |
| ページングの `limit + 1` → `limit`                  | 1    | 「limit ちょうどの件数のとき `hasMore` が false」「limit + 1 件のとき true」の 2 本           |
| `WHERE` 句の `and(...)` の条件を 1 つ落とす変異     | 1    | 他人の予約を必ず 1 件 seed し、それが返らないことをアサート（Task 7-13）                      |
| `logError` の呼び出しを消す変異                     | 2    | `logError` のスパイで呼び出し回数をアサート                                                   |

**Durable Object のファイルは Stryker の `mutate` 対象に含める。** ただし同時実行テスト（`*.concurrency.test.ts`）は esbuild と miniflare の起動を伴い 1 変異あたり数秒かかるので、`apps/api/stryker.config.mjs` の `timeoutMS` を実測に基づいて引き上げる（Task 7-17 で `npx vitest run --silent --no-file-parallelism` の素の所要時間を測ってから決める。**現時点では未測定なので具体的な秒数は書かない**）。

`design-doc-sync.test.ts` はサンドボックス外（`docs/`）を読むため既に Stryker 対象外。**Phase 7 で新しく除外設定を足してはならない。**

---

## タスク一覧（全 17 タスク）

想定されていた 13 タスクに対して 4 つ多い。増やした理由:

- **Durable Object の本体（7-6）と同時実行テスト（7-7）を分けた** — 同時実行テストは esbuild でのバンドルという独立した仕掛けが要り、しかも「本体の設計が正しいか」を決めるのはこのテストの方である。レビューの門を別に置く価値がある
- **権限の網羅テスト（7-13）を独立させた** — Phase 4 が Task 4-12 / 4-13 で認可の横断テストを独立タスクにしたのと同じ位置づけ。各ルートのタスクに散らすと「全部のエンドポイントを他人の Actor で叩く」という網羅性が保てない
- **通知（7-12）を独立させた** — 4 種類の通知が 3 つのルートから発生するため、どこかのルートに混ぜると重複する
- **総点検（7-17）を独立させた** — 双方向フローの結合テストと品質ゲート（型・lint・ミューテーション）は、個別タスクの粒度では回せない

| #    | タスク                                    | 1 行の内容                                                                  |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------- |
| 7-1  | core: JST の暦日＋分 → 瞬間               | `toJstInstant()` を足して `reserved_at`（エポックミリ秒）を作れるようにする |
| 7-2  | core: 予約の状態遷移表                    | 遷移表と `canTransitionReservationStatus()` を型で定義する                  |
| 7-3  | DB: 遷移トリガーと `owner_memo` 列        | `0002_reservation_flow.sql` と、制約メタテストの読み取り範囲の修正          |
| 7-4  | 予約枠リポジトリ                          | 枠計算に必要な店舗設定・営業時間・休業日・既存予約を読む                    |
| 7-5  | 空き枠サービスと `GET /reservation-slots` | 枠ごとの空き状況を返す公開エンドポイント                                    |
| 7-6  | `ReservationLock` Durable Object          | `blockConcurrencyWhile` で囲った臨界区間                                    |
| 7-7  | DO の同時実行テスト                       | esbuild + miniflare + `Promise.all` で「ちょうど 1 件」を実測する           |
| 7-8  | `POST /reservations`                      | DO を経由した予約申込                                                       |
| 7-9  | 予約リポジトリ（利用者側）                | 自分の予約の一覧・詳細・キャンセルを `WHERE` 句で縛って読む                 |
| 7-10 | 利用者側ルート                            | 一覧 / 詳細 / キャンセルの 3 エンドポイント                                 |
| 7-11 | 予約リポジトリ（店舗側）                  | 自店の予約の一覧・詳細・状態遷移・メモ                                      |
| 7-12 | 店舗側ルートと通知                        | 4 エンドポイントと 4 種類の通知レコード                                     |
| 7-13 | 権限の網羅テスト                          | 全 9 エンドポイントを他人の Actor で叩いて 401/403/404 を確かめる           |
| 7-14 | モバイル: 予約の API 層とフック           | schema / api / query-keys / 9 つのフック                                    |
| 7-15 | 予約申込画面                              | `(user)/shop/[shopId]/reserve.tsx` と枠選択 UI                              |
| 7-16 | 利用者の予約一覧・詳細画面                | `(user)/reservations/index.tsx` と `[reservationId].tsx`                    |
| 7-17 | 店舗側の予約画面 2 枚と総点検             | `(owner)` の 2 画面、双方向フローの結合テスト、品質ゲート                   |

---

## Task 7-1: core に「JST の暦日 + 分 → 瞬間」を足す

`reservations.reserved_at` は `integer(..., { mode: 'timestamp_ms' })`、つまりエポックミリ秒である。一方、枠は `(JstDate, MinuteOfDay)` の組で表される。`packages/core/src/jst-clock.ts` には `toJstClock(now: Date): JstClock`（瞬間 → 暦日）**しか無く、その逆が無い**。Phase 7 は両方向を使うので、まずこれを足す。

**Files:**

- Modify: `packages/core/src/jst-clock.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/jst-clock.test.ts`（既存ファイルに追記）

**Interfaces:**

- Consumes: `JST_OFFSET_MINUTES` / `MILLISECONDS_PER_MINUTE`（`./constants`）、`MinuteOfDay`（`./minute-of-day`）、`JstDate` / `toJstDate` / `toJstClock`（同ファイル内）
- Produces:
  - `toJstInstant(date: JstDate, minuteOfDay: MinuteOfDay): Date`
  - バレル `@meshimap/core` からの再エクスポート

---

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/jst-clock.test.ts` の末尾に追記する（既存の import 行に `toJstInstant` を足すこと）:

```ts
describe('toJstInstant', () => {
  it('JST の 18:00 を UTC の 09:00 に変換する', () => {
    const instant = toJstInstant(toJstDate('2026-10-01'), toMinuteOfDay(1080));
    expect(instant.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('JST の 00:00 は前日の UTC 15:00 になる', () => {
    const instant = toJstInstant(toJstDate('2026-10-01'), toMinuteOfDay(0));
    expect(instant.toISOString()).toBe('2026-09-30T15:00:00.000Z');
  });

  it('1440 以上の翌日表記は翌日の瞬間になる', () => {
    // 1530 = 翌 01:30
    const instant = toJstInstant(toJstDate('2026-10-01'), toMinuteOfDay(1530));
    expect(instant.toISOString()).toBe('2026-10-01T16:30:00.000Z');
    expect(toJstClock(instant)).toEqual({
      date: toJstDate('2026-10-02'),
      dayOfWeek: 5,
      minuteOfDay: 90,
    });
  });

  it('toJstClock と往復する', () => {
    // 2026 年は閏年ではないので 2/29 は存在しない。月末は 2/28
    const date = toJstDate('2026-02-28');
    const minute = toMinuteOfDay(23 * 60 + 59);
    const clock = toJstClock(toJstInstant(date, minute));
    expect(clock.date).toBe(date);
    expect(clock.minuteOfDay).toBe(minute);
  });

  it('下限 0 分と上限 2879 分の両端で例外にならない', () => {
    const date = toJstDate('2026-10-01');
    expect(toJstInstant(date, toMinuteOfDay(0)).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(toJstInstant(date, toMinuteOfDay(2879)).toISOString()).toBe('2026-10-02T14:59:00.000Z');
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/core -- jst-clock
```

期待: `toJstInstant is not a function` またはインポート解決の失敗で FAIL。**このメッセージが出ることを目で見る。** 別の理由（構文エラーなど）で落ちているならテストが間違っている。

- [ ] **Step 3: 最小の実装を書く**

`packages/core/src/jst-clock.ts` の末尾に追記:

```ts
/**
 * JST の暦日と「0 時からの分」から、実際の瞬間（エポック）を求める。
 * toJstClock の逆向き。minuteOfDay が 1440 以上なら翌日に繰り上がる。
 */
export function toJstInstant(date: JstDate, minuteOfDay: MinuteOfDay): Date {
  // JST の 0:00 は UTC の前日 15:00。分から JST のオフセットを引いて UTC 深夜に足す
  const baseMs = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(baseMs + (minuteOfDay - JST_OFFSET_MINUTES) * MILLISECONDS_PER_MINUTE);
}
```

`packages/core/src/index.ts` の `jst-clock` からのエクスポートに `toJstInstant` を足す（アルファベット順を維持するため `toJstDate` の後ろ）:

```ts
export {
  addJstDays,
  dayOfWeekOf,
  previousDayOfWeek,
  toDayOfWeek,
  toJstClock,
  toJstDate,
  toJstInstant,
} from './jst-clock';
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/core -- jst-clock
```

期待: PASS。上で足した 5 本すべてが緑。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

`JST_OFFSET_MINUTES` を引く向きを足す向きに変える:

```ts
return new Date(baseMs + (minuteOfDay + JST_OFFSET_MINUTES) * MILLISECONDS_PER_MINUTE);
```

```bash
npm test -w @meshimap/core -- jst-clock
```

期待: FAIL。`Expected "2026-10-01T09:00:00.000Z" / Received "2026-10-01T27:00:00..."` のように**時刻がずれた形で落ちる**こと。落ちなければテストが符号を確かめていないということなので、テストを直す。確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/jst-clock.ts packages/core/src/jst-clock.test.ts packages/core/src/index.ts
git commit -m "feat(core): JST の暦日と分からエポックを求める toJstInstant を足す"
```

---

## Task 7-2: core に予約の状態遷移表を置く

状態そのもの（`pending` などの文字列）は `apps/api/src/db/constants.ts` にあるが、**遷移のルールはまだどこにも無い**。モバイル側も「この予約はキャンセルできるか」を知りたいので、遷移表は `packages/core` に置いて API とモバイルで共有する。

`apps/api/src/db/constants.ts` の `RESERVATION_STATUSES` と二重定義になるが、これは意図的である。core は D1 を知らないパッケージで、`db/constants.ts` は Drizzle の CHECK 制約を組み立てるためのもの。**二重定義がずれないことをパリティテストで機械的に保証する**（Step 1 の 3 本目）。

**Files:**

- Create: `packages/core/src/reservation-status.ts`
- Create: `packages/core/src/reservation-status.test.ts`
- Modify: `packages/core/src/index.ts`
- Create: `apps/api/src/db/reservation-status-parity.test.ts`

**Interfaces:**

- Consumes: `Role` / `ROLE_OWNER` / `ROLE_USER`（`./role`）
- Produces:
  - `RESERVATION_STATUS_PENDING` / `_CONFIRMED` / `_REJECTED` / `_CANCELLED` / `_COMPLETED` / `_NO_SHOW`: `string` リテラル定数
  - `RESERVATION_STATUSES: readonly ReservationStatus[]`
  - `type ReservationStatus`
  - `RESERVATION_TRANSITIONS: readonly ReservationTransition[]`
  - `type ReservationTransition = { readonly from: ReservationStatus; readonly to: ReservationStatus; readonly by: Role }`
  - `canTransitionReservationStatus(from: ReservationStatus, to: ReservationStatus, by: Role): boolean`
  - `allowedPreviousStatuses(to: ReservationStatus, by: Role): readonly ReservationStatus[]`
  - `nextReservationStatuses(from: ReservationStatus, by: Role): readonly ReservationStatus[]`
  - `isReservationStatus(value: string): value is ReservationStatus`
  - `toReservationStatus(value: string): ReservationStatus`

---

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/reservation-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from './role';
import {
  RESERVATION_STATUSES,
  RESERVATION_STATUS_CANCELLED,
  RESERVATION_STATUS_COMPLETED,
  RESERVATION_STATUS_CONFIRMED,
  RESERVATION_STATUS_NO_SHOW,
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUS_REJECTED,
  RESERVATION_TRANSITIONS,
  allowedPreviousStatuses,
  canTransitionReservationStatus,
  isReservationStatus,
  nextReservationStatuses,
  toReservationStatus,
} from './reservation-status';

describe('RESERVATION_STATUSES', () => {
  it('6 状態をこの順で持つ', () => {
    expect(RESERVATION_STATUSES).toEqual([
      'pending',
      'confirmed',
      'rejected',
      'cancelled',
      'completed',
      'no_show',
    ]);
  });
});

describe('RESERVATION_TRANSITIONS', () => {
  it('許可する遷移はちょうど 6 本', () => {
    expect(RESERVATION_TRANSITIONS).toHaveLength(6);
  });

  it('設計どおりの 6 本である', () => {
    expect(RESERVATION_TRANSITIONS).toEqual([
      { from: 'pending', to: 'confirmed', by: ROLE_OWNER },
      { from: 'pending', to: 'rejected', by: ROLE_OWNER },
      { from: 'pending', to: 'cancelled', by: ROLE_USER },
      { from: 'confirmed', to: 'cancelled', by: ROLE_USER },
      { from: 'confirmed', to: 'completed', by: ROLE_OWNER },
      { from: 'confirmed', to: 'no_show', by: ROLE_OWNER },
    ]);
  });
});

describe('canTransitionReservationStatus', () => {
  it('店主は pending を confirmed にできる', () => {
    expect(
      canTransitionReservationStatus(
        RESERVATION_STATUS_PENDING,
        RESERVATION_STATUS_CONFIRMED,
        ROLE_OWNER,
      ),
    ).toBe(true);
  });

  it('利用者は pending を confirmed にできない', () => {
    expect(
      canTransitionReservationStatus(
        RESERVATION_STATUS_PENDING,
        RESERVATION_STATUS_CONFIRMED,
        ROLE_USER,
      ),
    ).toBe(false);
  });

  it('利用者は confirmed を cancelled にできる', () => {
    expect(
      canTransitionReservationStatus(
        RESERVATION_STATUS_CONFIRMED,
        RESERVATION_STATUS_CANCELLED,
        ROLE_USER,
      ),
    ).toBe(true);
  });

  it('pending を飛ばして completed にはできない', () => {
    expect(
      canTransitionReservationStatus(
        RESERVATION_STATUS_PENDING,
        RESERVATION_STATUS_COMPLETED,
        ROLE_OWNER,
      ),
    ).toBe(false);
  });

  it('終端状態からはどこへも動かせない', () => {
    const terminals = [
      RESERVATION_STATUS_REJECTED,
      RESERVATION_STATUS_CANCELLED,
      RESERVATION_STATUS_COMPLETED,
      RESERVATION_STATUS_NO_SHOW,
    ] as const;
    for (const from of terminals) {
      for (const to of RESERVATION_STATUSES) {
        for (const by of [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const) {
          expect(canTransitionReservationStatus(from, to, by)).toBe(false);
        }
      }
    }
  });

  it('admin はどの遷移もできない', () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        expect(canTransitionReservationStatus(from, to, ROLE_ADMIN)).toBe(false);
      }
    }
  });

  it('同じ状態への遷移は許さない', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(canTransitionReservationStatus(status, status, ROLE_OWNER)).toBe(false);
      expect(canTransitionReservationStatus(status, status, ROLE_USER)).toBe(false);
    }
  });

  it('遷移表に載っている 6 組だけが true になる（全 108 通りの網羅）', () => {
    const roles = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;
    let allowed = 0;
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        for (const by of roles) {
          if (canTransitionReservationStatus(from, to, by)) {
            allowed += 1;
          }
        }
      }
    }
    expect(allowed).toBe(6);
  });
});

describe('allowedPreviousStatuses', () => {
  it('cancelled には pending と confirmed から来られる（利用者）', () => {
    expect(allowedPreviousStatuses(RESERVATION_STATUS_CANCELLED, ROLE_USER)).toEqual([
      'pending',
      'confirmed',
    ]);
  });

  it('店主は cancelled にはできないので空になる', () => {
    expect(allowedPreviousStatuses(RESERVATION_STATUS_CANCELLED, ROLE_OWNER)).toEqual([]);
  });

  it('confirmed には pending からだけ来られる', () => {
    expect(allowedPreviousStatuses(RESERVATION_STATUS_CONFIRMED, ROLE_OWNER)).toEqual(['pending']);
  });
});

describe('nextReservationStatuses', () => {
  it('店主から見た pending の行き先は confirmed と rejected', () => {
    expect(nextReservationStatuses(RESERVATION_STATUS_PENDING, ROLE_OWNER)).toEqual([
      'confirmed',
      'rejected',
    ]);
  });

  it('利用者から見た confirmed の行き先は cancelled だけ', () => {
    expect(nextReservationStatuses(RESERVATION_STATUS_CONFIRMED, ROLE_USER)).toEqual(['cancelled']);
  });

  it('終端状態の行き先は空', () => {
    expect(nextReservationStatuses(RESERVATION_STATUS_COMPLETED, ROLE_OWNER)).toEqual([]);
  });
});

describe('isReservationStatus / toReservationStatus', () => {
  it('既知の値を受け入れる', () => {
    expect(isReservationStatus('no_show')).toBe(true);
    expect(toReservationStatus('no_show')).toBe(RESERVATION_STATUS_NO_SHOW);
  });

  it('未知の値を拒む', () => {
    expect(isReservationStatus('NO_SHOW')).toBe(false);
    expect(() => toReservationStatus('NO_SHOW')).toThrow(RangeError);
  });

  it('空文字を拒む', () => {
    expect(isReservationStatus('')).toBe(false);
  });
});
```

`apps/api/src/db/reservation-status-parity.test.ts`（core と db/constants がずれないことの機械検査）:

```ts
import { RESERVATION_STATUSES as CORE_STATUSES } from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import { RESERVATION_STATUSES, RESERVATION_STATUSES_OCCUPYING_SEAT } from './constants';

describe('予約ステータスの二重定義', () => {
  it('core と db/constants で同じ並びである', () => {
    expect([...RESERVATION_STATUSES]).toEqual([...CORE_STATUSES]);
  });

  it('席を占める状態は pending と confirmed だけである', () => {
    expect([...RESERVATION_STATUSES_OCCUPYING_SEAT]).toEqual(['pending', 'confirmed']);
  });

  it('席を占める状態はすべて有効なステータスである', () => {
    for (const status of RESERVATION_STATUSES_OCCUPYING_SEAT) {
      expect(RESERVATION_STATUSES).toContain(status);
    }
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/core -- reservation-status
```

期待: `Failed to resolve import "./reservation-status"` で FAIL。

- [ ] **Step 3: 最小の実装を書く**

`packages/core/src/reservation-status.ts`:

```ts
// 予約の状態と、誰がどの遷移を起こせるかの表。
// 状態文字列そのものは apps/api/src/db/constants.ts にも定義があるが、
// あちらは D1 の CHECK 制約を組み立てるためのもの。ここは D1 を知らない
// ドメイン側の定義で、モバイルからも参照する。ずれは
// apps/api/src/db/reservation-status-parity.test.ts で機械的に検出する。

import { ROLE_OWNER, ROLE_USER } from './role';
import type { Role } from './role';

export const RESERVATION_STATUS_PENDING = 'pending';
export const RESERVATION_STATUS_CONFIRMED = 'confirmed';
export const RESERVATION_STATUS_REJECTED = 'rejected';
export const RESERVATION_STATUS_CANCELLED = 'cancelled';
export const RESERVATION_STATUS_COMPLETED = 'completed';
export const RESERVATION_STATUS_NO_SHOW = 'no_show';

export const RESERVATION_STATUSES = [
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUS_CONFIRMED,
  RESERVATION_STATUS_REJECTED,
  RESERVATION_STATUS_CANCELLED,
  RESERVATION_STATUS_COMPLETED,
  RESERVATION_STATUS_NO_SHOW,
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type ReservationTransition = {
  readonly from: ReservationStatus;
  readonly to: ReservationStatus;
  /** この遷移を起こせる主体。owner は自店のみ、user は自分の予約のみ（絞り込みは SQL 側の責務）。 */
  readonly by: Role;
};

/**
 * 許可する遷移のすべて。ここに無い組み合わせは起こせない。
 * 終端（rejected / cancelled / completed / no_show）が from に現れないのは意図的。
 */
export const RESERVATION_TRANSITIONS = [
  { from: RESERVATION_STATUS_PENDING, to: RESERVATION_STATUS_CONFIRMED, by: ROLE_OWNER },
  { from: RESERVATION_STATUS_PENDING, to: RESERVATION_STATUS_REJECTED, by: ROLE_OWNER },
  { from: RESERVATION_STATUS_PENDING, to: RESERVATION_STATUS_CANCELLED, by: ROLE_USER },
  { from: RESERVATION_STATUS_CONFIRMED, to: RESERVATION_STATUS_CANCELLED, by: ROLE_USER },
  { from: RESERVATION_STATUS_CONFIRMED, to: RESERVATION_STATUS_COMPLETED, by: ROLE_OWNER },
  { from: RESERVATION_STATUS_CONFIRMED, to: RESERVATION_STATUS_NO_SHOW, by: ROLE_OWNER },
] as const satisfies readonly ReservationTransition[];

export function isReservationStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}

export function toReservationStatus(value: string): ReservationStatus {
  if (!isReservationStatus(value)) {
    throw new RangeError(`未知の予約ステータスです: "${value}"`);
  }
  return value;
}

export function canTransitionReservationStatus(
  from: ReservationStatus,
  to: ReservationStatus,
  by: Role,
): boolean {
  return RESERVATION_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to && transition.by === by,
  );
}

/**
 * 「この状態へ移すとき、元の状態として許されるもの」。
 * UPDATE の WHERE 句（status IN (...)）にそのまま渡すための関数。
 */
export function allowedPreviousStatuses(
  to: ReservationStatus,
  by: Role,
): readonly ReservationStatus[] {
  return RESERVATION_TRANSITIONS.filter(
    (transition) => transition.to === to && transition.by === by,
  ).map((transition) => transition.from);
}

/** 画面に「次にできる操作」のボタンを出すための関数。 */
export function nextReservationStatuses(
  from: ReservationStatus,
  by: Role,
): readonly ReservationStatus[] {
  return RESERVATION_TRANSITIONS.filter(
    (transition) => transition.from === from && transition.by === by,
  ).map((transition) => transition.to);
}
```

`packages/core/src/index.ts` に追記（`reservation-availability` のエクスポートの直前）:

```ts
export {
  RESERVATION_STATUSES,
  RESERVATION_STATUS_CANCELLED,
  RESERVATION_STATUS_COMPLETED,
  RESERVATION_STATUS_CONFIRMED,
  RESERVATION_STATUS_NO_SHOW,
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUS_REJECTED,
  RESERVATION_TRANSITIONS,
  allowedPreviousStatuses,
  canTransitionReservationStatus,
  isReservationStatus,
  nextReservationStatuses,
  toReservationStatus,
} from './reservation-status';
export type { ReservationStatus, ReservationTransition } from './reservation-status';
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/core -- reservation-status
npm test -w @meshimap/api -- reservation-status-parity
```

期待: 両方 PASS。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

2 箇所を別々に壊し、**それぞれ違うテストが落ちること**を見る。

(a) 遷移表に禁止された遷移を 1 本足す:

```ts
  { from: RESERVATION_STATUS_PENDING, to: RESERVATION_STATUS_COMPLETED, by: ROLE_OWNER },
```

→ `npm test -w @meshimap/core -- reservation-status` が「許可する遷移はちょうど 6 本」「pending を飛ばして completed にはできない」「全 108 通りの網羅」の **3 本** FAIL。

(b) `canTransitionReservationStatus` から `by` の判定を落とす:

```ts
    (transition) => transition.from === from && transition.to === to,
```

→ 「利用者は pending を confirmed にできない」「admin はどの遷移もできない」「全 108 通りの網羅」が FAIL。

(c) core の `RESERVATION_STATUSES` の並びを入れ替える（`_REJECTED` と `_CANCELLED` を入れ替え）

→ `npm test -w @meshimap/api -- reservation-status-parity` が「core と db/constants で同じ並びである」で FAIL。**これが落ちなければパリティテストが機能していない。**

3 つとも確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/reservation-status.ts packages/core/src/reservation-status.test.ts packages/core/src/index.ts apps/api/src/db/reservation-status-parity.test.ts
git commit -m "feat(core): 予約の状態遷移表を型で定義し、db/constants とのパリティを機械検査する"
```

---

## Task 7-3: 遷移トリガーと `owner_memo` 列をマイグレーションで入れる

状態遷移の最後の壁を DB に置く。あわせて店舗側の内部メモ（利用者には見せない）用の列を足す。

**`npm run db:generate` に任せてはいけない。** 実際に走らせて確かめた結果を記す。`owner_memo` 列と CHECK を Drizzle スキーマに足して `npx drizzle-kit generate` を実行すると、SQLite では列に CHECK を後付けできないと判断してテーブル再構築（`__new_reservations` を作って入れ替える）の SQL を吐く。これを D1 に流すと**失敗する**:

```
0002_reservation_flow.sql: ERROR -> D1_EXEC_ERROR: Error in line 1: PRAGMA foreign_keys=OFF;:
no such column: "reserved_at" desc at offset 75: SQLITE_ERROR
```

原因は再構築の最後に吐かれる索引の再作成 SQL である:

```sql
CREATE INDEX `idx_reservations_user_reserved` ON `reservations` (`user_id`,`"reserved_at" desc`);
```

`sql`${table.reservedAt} desc`` で書いた降順指定が、識別子としてクォートされた壊れた DDL になっている。加えて再構築は `CONSTRAINT "ck_reservations_id_length" CHECK(length("__new_reservations"."id") <= 64)` のようにテーブル名が `__new_reservations` になった CHECK を 5 本吐くため、`check-constraints.test.ts` の「CHECK の総数が一致する」も 5 件ぶん狂う。

→ **手書きの custom マイグレーションにする。** `ALTER TABLE ... ADD COLUMN ... CONSTRAINT ... CHECK(...)` は D1 でそのまま通ることを実測済み（裏取り 事実 5）。

**Files:**

- Create: `apps/api/migrations/0002_reservation_flow.sql`
- Modify: `apps/api/migrations/meta/_journal.json`（`drizzle-kit generate --custom` が自動で追記する）
- Create: `apps/api/migrations/meta/0002_snapshot.json`（同上。**生成後に手で 2 箇所足す**）
- Modify: `apps/api/src/db/schema/reservation.ts`
- Modify: `apps/api/src/db/constants.ts`
- Modify: `apps/api/src/db/schema/check-constraints.test.ts`
- Create: `apps/api/src/db/schema/reservation-transition.test.ts`

**Interfaces:**

- Consumes: `lengthAtMost`（`../sql-helpers`）、`createMigratedD1` / `LocalD1`（`../testing/local-d1`）、`RESERVATION_STATUSES`（`../constants`）
- Produces:
  - `reservations.ownerMemo`: `text('owner_memo')`（nullable）
  - `RESERVATION_OWNER_MEMO_MAX_LENGTH = 500`（`apps/api/src/db/constants.ts`）
  - DB トリガー `trg_reservations_status_transition`
  - CHECK 制約 `ck_reservations_owner_memo_length`

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/db/schema/reservation-transition.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedD1, type LocalD1 } from '../testing/local-d1';
import { RESERVATION_STATUSES } from '../constants';

let local: LocalD1;

/** 予約 1 行の FK を満たすための親行。全ケースで使い回す */
const AREA_ID = 'area_trg';
const GENRE_ID = 'gnr_trg';
const USER_ID = 'usr_trg';
const SHOP_ID = 'shp_trg';
const RESERVATION_ID = 'rsv_trg';
const RESERVED_AT_MS = 1_789_500_000_000;

/** 遷移表（設計の 6 本）。同じ状態への更新はトリガーの WHEN で除外されるので常に通る */
const ALLOWED_TRANSITIONS = new Set([
  'pending>confirmed',
  'pending>rejected',
  'pending>cancelled',
  'confirmed>cancelled',
  'confirmed>completed',
  'confirmed>no_show',
]);

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare('INSERT INTO areas (id, name, prefecture) VALUES (?, ?, ?)')
    .bind(AREA_ID, 'テストエリア', '東京都')
    .run();
  await local.d1
    .prepare('INSERT INTO genres (id, name, slug) VALUES (?, ?, ?)')
    .bind(GENRE_ID, 'テストジャンル', 'genre-trg')
    .run();
  await local.d1
    .prepare(
      'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(USER_ID, 'テスト', 'trg@example.com', 1, 0, 0)
    .run();
  await local.d1
    .prepare(
      'INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      SHOP_ID,
      'テスト店',
      GENRE_ID,
      AREA_ID,
      '東京都渋谷区',
      35.658034,
      139.701636,
      'xn76fgr',
      USER_ID,
      'published',
    )
    .run();
});

afterAll(async () => {
  await local.dispose();
});

/** from の状態で予約を作り直してから to へ更新する。成功なら true */
async function tryTransition(from: string, to: string): Promise<boolean> {
  await local.d1.prepare('DELETE FROM reservations WHERE id = ?').bind(RESERVATION_ID).run();
  await local.d1
    .prepare(
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(RESERVATION_ID, SHOP_ID, USER_ID, RESERVED_AT_MS, 2, from)
    .run();
  try {
    await local.d1
      .prepare('UPDATE reservations SET status = ? WHERE id = ?')
      .bind(to, RESERVATION_ID)
      .run();
    return true;
  } catch {
    return false;
  }
}

describe('trg_reservations_status_transition', () => {
  it('36 通りの組み合わせすべてが遷移表どおりに振る舞う', async () => {
    const violations: string[] = [];
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        const succeeded = await tryTransition(from, to);
        // 同状態への更新はトリガーの WHEN で除外しているので通る
        const shouldSucceed = from === to || ALLOWED_TRANSITIONS.has(`${from}>${to}`);
        if (succeeded !== shouldSucceed) {
          violations.push(`${from} -> ${to}: ${succeeded ? '通った' : '弾かれた'}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('未知のステータスへの更新も弾く', async () => {
    expect(await tryTransition('pending', 'zzz')).toBe(false);
  });

  it('弾かれたときのメッセージで原因が分かる', async () => {
    await local.d1.prepare('DELETE FROM reservations WHERE id = ?').bind(RESERVATION_ID).run();
    await local.d1
      .prepare(
        'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(RESERVATION_ID, SHOP_ID, USER_ID, RESERVED_AT_MS, 2, 'completed')
      .run();
    await expect(
      local.d1
        .prepare('UPDATE reservations SET status = ? WHERE id = ?')
        .bind('cancelled', RESERVATION_ID)
        .run(),
    ).rejects.toThrow('invalid reservation status transition');
  });

  it('存在しない id への更新はエラーにならず 0 行更新になる', async () => {
    const result = await local.d1
      .prepare('UPDATE reservations SET status = ? WHERE id = ?')
      .bind('confirmed', 'rsv_does_not_exist')
      .run();
    expect(result.meta.changes).toBe(0);
  });

  it('owner_memo 列が存在し、500 文字ちょうどは通り 501 文字は弾かれる', async () => {
    await tryTransition('pending', 'pending');
    await local.d1
      .prepare('UPDATE reservations SET owner_memo = ? WHERE id = ?')
      .bind('a'.repeat(500), RESERVATION_ID)
      .run();
    await expect(
      local.d1
        .prepare('UPDATE reservations SET owner_memo = ? WHERE id = ?')
        .bind('a'.repeat(501), RESERVATION_ID)
        .run(),
    ).rejects.toThrow('ck_reservations_owner_memo_length');
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-transition
```

期待: 「36 通りの組み合わせすべてが遷移表どおりに振る舞う」が FAIL し、`violations` に **30 件**（許可 6 本と同状態 6 本を除いた 24 本 …… ではなく、同状態 6 本は許可側と重ならないので 36 − 6 − 6 = 24 件）が並ぶ。同時に「owner_memo 列が存在し〜」が `no such column: owner_memo` で FAIL する。**この 2 種類の失敗が出ることを目で見る。**

- [ ] **Step 3: マイグレーションを作る**

```bash
npm run db:generate -w @meshimap/api -- --custom --name reservation_flow
```

`Prepared empty file for your custom SQL migration!` と出て `apps/api/migrations/0002_reservation_flow.sql` が 1 行のコメントだけで作られる。その中身を次で置き換える:

```sql
-- Custom SQL migration file, put your code below! --

-- 店舗側の内部メモ。利用者には返さない列なので API の応答スキーマにも入れない。
--
-- drizzle-kit の自動生成には任せられない。SQLite は既存列に CHECK を後付けできないため
-- drizzle-kit はテーブル再構築（__new_reservations を作って入れ替える）を吐くが、
-- そこで再作成される idx_reservations_user_reserved の DDL が
-- `(`user_id`,`"reserved_at" desc`)` となって D1 で `no such column: "reserved_at" desc` になる。
-- ALTER TABLE ... ADD COLUMN に CONSTRAINT を添える形は D1 で通ることを確認済み。
ALTER TABLE `reservations` ADD COLUMN `owner_memo` text CONSTRAINT "ck_reservations_owner_memo_length" CHECK(length("reservations"."owner_memo") <= 500);
--> statement-breakpoint
-- 状態遷移の最後の壁。
--
-- CHECK 制約は new.* しか見られず old.status を参照できないので、遷移は表現できない。
-- BEFORE UPDATE OF status なら old と new の両方を見られる。
-- アプリ側（core の遷移表と UPDATE の WHERE 句）をすり抜けた書き込みをここで止める。
--
-- WHEN に old.status <> new.status を入れているのは、
-- 「status を変えない UPDATE（owner_memo だけ更新する等）」を通すため。
CREATE TRIGGER `trg_reservations_status_transition`
BEFORE UPDATE OF `status` ON `reservations` FOR EACH ROW
WHEN old.`status` <> new.`status` AND NOT (
  (old.`status` = 'pending' AND new.`status` IN ('confirmed', 'rejected', 'cancelled')) OR
  (old.`status` = 'confirmed' AND new.`status` IN ('completed', 'cancelled', 'no_show'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid reservation status transition');
END;
```

**`--custom` で作られた `migrations/meta/0002_snapshot.json` はスキーマの変更を記録しない**（実測: 生成直後の `tables.reservations.columns` に `owner_memo` が無い）。このままだと次に `npm run db:generate` を回したとき「`owner_memo` を足す差分」が再び検出され、上の壊れた再構築 SQL が生成される。**スナップショットを手で 2 箇所埋める。**

`apps/api/migrations/meta/0002_snapshot.json` の `tables.reservations.columns` に追加:

```json
        "owner_memo": {
          "name": "owner_memo",
          "type": "text",
          "primaryKey": false,
          "notNull": false,
          "autoincrement": false
        }
```

同ファイルの `tables.reservations.checkConstraints` に追加:

```json
        "ck_reservations_owner_memo_length": {
          "name": "ck_reservations_owner_memo_length",
          "value": "length(\"reservations\".\"owner_memo\") <= 500"
        }
```

- [ ] **Step 4: Drizzle 側のスキーマと定数を合わせる**

`apps/api/src/db/constants.ts` の `RESERVATION_NOTE_MAX_LENGTH` の隣に追記:

```ts
/** 店舗側の内部メモ。利用者には返さないが、長さの上限は note と揃える */
export const RESERVATION_OWNER_MEMO_MAX_LENGTH = 500;
```

`apps/api/src/db/schema/reservation.ts` の `note` の直後に列を足す:

```ts
    note: text('note'),
    // 店舗側の内部メモ。利用者向けの応答には絶対に含めない（routes 側の出力スキーマで保証する）
    ownerMemo: text('owner_memo'),
```

同ファイルの `ck_reservations_note_length` の直後に CHECK を足す:

```ts
    check(
      'ck_reservations_owner_memo_length',
      lengthAtMost(table.ownerMemo, RESERVATION_OWNER_MEMO_MAX_LENGTH),
    ),
```

import 文に `RESERVATION_OWNER_MEMO_MAX_LENGTH` を足すこと。

- [ ] **Step 5: `check-constraints.test.ts` のメタテストを直す**

`constraintNamesInMigration()` は `0000_init.sql` **だけ**を読んでいる。このままだと `0002` に足した制約が「マイグレーションに実在しない」と判定され、「表に載っている制約名はすべてマイグレーションに実在する」と「Drizzle 側の CHECK 制約名がマイグレーションと過不足なく一致する」の 2 本が落ちる。全マイグレーションを読むように直す:

```ts
/** マイグレーションに実際に書き出された CHECK 制約名（0000 以降すべて） */
function constraintNamesInMigration(): readonly string[] {
  // 0000 だけを読むと、後から足した列の CHECK（0002 の ck_reservations_owner_memo_length）を
  // 「実在しない制約」と誤判定する。readMigrationSql は migrations/*.sql を名前順に連結して返す
  const sql = readMigrationSql();
  // drizzle-kit は CHECK 制約を `CONSTRAINT "ck_xxx" CHECK (...)` の形で出力する
  const matches = sql.matchAll(/CONSTRAINT "(ck_[a-z0-9_]+)"/g);
  return [...new Set([...matches].map((match) => match[1] ?? ''))].sort();
}
```

この関数は `MIGRATION_SQL`（ファイル後半で定義されている `readMigrationSql()` の結果）より前にあるが、呼ばれるのは `it` の中なので `readMigrationSql()` を直接呼ぶ形にする。

**`MIGRATION_PATH` は消さない。** 「部分索引の WHERE 句」の網羅テスト（`CREATE (?:UNIQUE )?INDEX ... WHERE` を数えるもの）は `0000_init.sql` だけを対象にしており、Phase 7 は索引を足さないのでそのままでよい。

`CONSTRAINT_CASES` の `// --- reservations ---` の節、`ck_reservations_note_length` の直後に 1 件足す:

```ts
  {
    name: 'ck_reservations_owner_memo_length',
    table: 'reservations',
    column: 'owner_memo',
    accepted: chars(500),
    rejected: chars(501),
  },
```

`BASE_ROWS.reservations` に列を足す（INSERT に列が現れないとケースが動かない）:

```ts
  reservations: (index: number): Row => ({
    id: `rsv_case_${index}`,
    shop_id: fixtureShopId(index),
    user_id: fixtureUserId(index),
    reserved_at: BASE_TIMESTAMP_MS,
    party_size: 2,
    note: null,
    owner_memo: null,
  }),
```

- [ ] **Step 6: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-transition check-constraints index.test design-doc-sync
```

期待: すべて PASS。特に次の 3 本が緑であること:

- `CHECK 制約の境界値`（新ケース `ck_reservations_owner_memo_length` を含む 105 件）
- `Drizzle 側の CHECK 制約の総数がマイグレーションの CHECK の数と一致する` — 実測で `0000_init.sql` だけなら 104 件、`0002` を足すと 105 件になり、Drizzle 側も 105 件になる
- `Drizzle 側の CHECK 制約名がマイグレーションと過不足なく一致する`

スキーマ差分が残っていないことも確認する:

```bash
npm run db:generate -w @meshimap/api
```

期待: `No schema changes, nothing to migrate 😴`。**別のマイグレーションファイルが生成されたらスナップショットの手当てが足りていない。**生成されたファイルを消して Step 3 のスナップショット編集をやり直す。

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

(a) トリガーの許可リストから `'no_show'` を外す:

```sql
  (old.`status` = 'confirmed' AND new.`status` IN ('completed', 'cancelled'))
```

→ `npm test -w @meshimap/api -- reservation-transition` が「36 通り〜」で FAIL し、`violations` に `confirmed -> no_show: 弾かれた` が出る。

(b) `WHEN old.status <> new.status` を削る:

→ 同じテストが FAIL し、`violations` に `rejected -> rejected: 弾かれた` など**同状態への更新が 4 件**並ぶ。

(c) `constraintNamesInMigration()` を `MIGRATION_PATH` 読みに戻す:

→ `npm test -w @meshimap/api -- check-constraints` の「表に載っている制約名はすべてマイグレーションに実在する」が `["ck_reservations_owner_memo_length"]` で FAIL する。

3 つとも確認したら元に戻し、**ローカル D1 を作り直してマイグレーションが実機でも通ることを確かめる**:

```bash
npm run db:reset:local -w @meshimap/api
```

期待: `wrangler d1 migrations apply` が 3 つのマイグレーションを適用して完了する。

- [ ] **Step 8: コミット**

```bash
git add apps/api/migrations apps/api/src/db/schema/reservation.ts apps/api/src/db/constants.ts apps/api/src/db/schema/check-constraints.test.ts apps/api/src/db/schema/reservation-transition.test.ts
git commit -m "feat(api): 予約の状態遷移トリガーと owner_memo 列を足す"
```

---

## Task 7-4: 予約枠の計算に必要なデータを 1 回で読むリポジトリ

空き枠の計算には 4 つのテーブルが要る（`seat_settings` / `shop_hours` / `shop_closures` / `reservations`）。呼び出し側がこれを別々に呼ぶと、店舗の可視性チェックを書き忘れる箇所ができる。**可視性の判定を 1 箇所に閉じ込めるため、まとめて読む関数を 1 本だけ用意する。**

店舗の可視性（下書き・非公開の店は他人から見えない）は Phase 4 の `findVisibleShop(db, viewer, shopId)` が持っている。ここではそれを呼んで `null` なら `null` を返す。**この関数の外に「見えるか」の判断を漏らさない。**

**Files:**

- Create: `apps/api/src/repositories/reservation-slot-repository.ts`
- Test: `apps/api/src/repositories/reservation-slot-repository.test.ts`

**Interfaces:**

- Consumes:
  - `Database`（`../db/client`）、`Viewer`（`../auth/actor`）、`findVisibleShop`（`./shop-repository`）
  - `seatSettings` / `shopHours` / `shopClosures` / `reservations`（`../db/schema`）
  - `RESERVATION_STATUSES_OCCUPYING_SEAT`（`../db/constants`）
  - `toJstInstant` / `dayOfWeekOf` / `toMinuteOfDay` / `toDayOfWeek`（`@meshimap/core`）
  - 型 `SeatSettings` / `BusinessHours` / `ExistingReservation` / `JstDate` / `ShopId`
- Produces:
  - `type SlotContext = { readonly shopName: string; readonly seatSettings: SeatSettings | null; readonly hours: readonly BusinessHours[]; readonly isClosedOnDate: boolean; readonly existingReservations: readonly ExistingReservation[] }`
  - `findSlotContext(db: Database, viewer: Viewer, shopId: ShopId, date: JstDate): Promise<SlotContext | null>`

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/reservation-slot-repository.test.ts`:

```ts
import { toJstDate, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestWorld,
  seedMasters,
  seedShop,
  seedUser,
  runWrite,
  type TestWorld,
} from '../test/fixtures';
import { createDatabase } from '../db/client';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { findSlotContext } from './reservation-slot-repository';

let world: TestWorld;

/** 2026-10-01 は木曜（dayOfWeek = 4） */
const TARGET_DATE = toJstDate('2026-10-01');
const SHOP_ID = toShopId('shp_slot_0001');
const HIDDEN_SHOP_ID = toShopId('shp_slot_0002');
const CUSTOMER_ID = 'usr_slot_customer';

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: CUSTOMER_ID, role: 'user' });
  await seedShop(world, { id: SHOP_ID, ownerId: null, name: '枠テスト店', status: 'published' });
  await seedShop(world, { id: HIDDEN_SHOP_ID, ownerId: null, name: '下書き店', status: 'draft' });

  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    8,
    60,
    2,
    1,
  );
  // 木曜 18:00-22:00 の営業
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_slot_thu',
    SHOP_ID,
    4,
    1080,
    1320,
    0,
  );
  // 金曜は定休日（is_closed = 1）。曜日違いが混ざらないことを確かめるため
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_slot_fri',
    SHOP_ID,
    5,
    null,
    null,
    1,
  );
  // 2026-10-01 18:00 JST = 2026-10-01T09:00:00Z に 3 名の confirmed 予約
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_slot_1',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-01T09:00:00Z'),
    3,
    'confirmed',
  );
  // 同じ時刻のキャンセル済み。席を占めないので数に入ってはいけない
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_slot_2',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-01T09:00:00Z'),
    4,
    'cancelled',
  );
  // 翌日の予約。日付でちゃんと切れているかを確かめるため
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_slot_3',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-02T09:00:00Z'),
    2,
    'pending',
  );
});

afterAll(async () => {
  await world.dispose();
});

describe('findSlotContext', () => {
  it('公開店の席設定・営業時間・既存予約をまとめて返す', async () => {
    const db = createDatabase(world.d1);
    const context = await findSlotContext(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE);
    expect(context).not.toBeNull();
    expect(context?.shopName).toBe('枠テスト店');
    expect(context?.seatSettings).toEqual({
      capacity: 8,
      slotMinutes: 60,
      maxParallel: 2,
      acceptsReservation: true,
    });
    expect(context?.hours).toEqual([
      { dayOfWeek: 4, openMinute: 1080, closeMinute: 1320, isClosed: false },
    ]);
    expect(context?.isClosedOnDate).toBe(false);
  });

  it('席を占める状態（pending / confirmed）の予約だけを返す', async () => {
    const db = createDatabase(world.d1);
    const context = await findSlotContext(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE);
    // cancelled の 4 名と翌日の 2 名は含まない
    expect(context?.existingReservations).toEqual([{ startMinute: 1080, partySize: 3 }]);
  });

  it('指定日と違う曜日の営業時間は返さない', async () => {
    const db = createDatabase(world.d1);
    // 2026-10-02 は金曜。定休日の行は isClosed: true として返る（未登録と区別するため）
    const context = await findSlotContext(db, ANONYMOUS_VIEWER, SHOP_ID, toJstDate('2026-10-02'));
    expect(context?.hours).toEqual([
      { dayOfWeek: 5, openMinute: 0, closeMinute: 0, isClosed: true },
    ]);
  });

  it('臨時休業日なら isClosedOnDate が true になる', async () => {
    await runWrite(
      world,
      'INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)',
      'scl_slot_1',
      SHOP_ID,
      '2026-10-08',
      '設備点検',
    );
    const db = createDatabase(world.d1);
    const context = await findSlotContext(db, ANONYMOUS_VIEWER, SHOP_ID, toJstDate('2026-10-08'));
    expect(context?.isClosedOnDate).toBe(true);
  });

  it('席設定が無い店舗では seatSettings が null になる', async () => {
    await seedShop(world, {
      id: toShopId('shp_slot_0003'),
      ownerId: null,
      name: '席設定なし店',
      status: 'published',
    });
    const db = createDatabase(world.d1);
    const context = await findSlotContext(
      db,
      ANONYMOUS_VIEWER,
      toShopId('shp_slot_0003'),
      TARGET_DATE,
    );
    expect(context).not.toBeNull();
    expect(context?.seatSettings).toBeNull();
  });

  it('匿名から見えない店舗は null を返す', async () => {
    const db = createDatabase(world.d1);
    expect(await findSlotContext(db, ANONYMOUS_VIEWER, HIDDEN_SHOP_ID, TARGET_DATE)).toBeNull();
  });

  it('存在しない店舗も null を返す（見えない店と区別できない）', async () => {
    const db = createDatabase(world.d1);
    expect(
      await findSlotContext(db, ANONYMOUS_VIEWER, toShopId('shp_nope'), TARGET_DATE),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-slot-repository
```

期待: `Failed to resolve import "./reservation-slot-repository"` で FAIL。

- [ ] **Step 3: 最小の実装を書く**

`apps/api/src/repositories/reservation-slot-repository.ts`:

```ts
// 予約枠の計算に必要な 4 テーブルを 1 回で読む。
// 店舗の可視性判定をこの 1 関数に閉じ込め、呼び出し側に「見えるか」の判断を持ち出さない。

import type {
  BusinessHours,
  ExistingReservation,
  JstDate,
  SeatSettings,
  ShopId,
} from '@meshimap/core';
import {
  MINUTE_OF_DAY_MAX,
  dayOfWeekOf,
  toDayOfWeek,
  toJstInstant,
  toMinuteOfDay,
} from '@meshimap/core';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { RESERVATION_STATUSES_OCCUPYING_SEAT } from '../db/constants';
import { reservations, seatSettings, shopClosures, shopHours } from '../db/schema';
import { findVisibleShop } from './shop-repository';

export type SlotContext = {
  readonly shopName: string;
  /** 席設定が未登録の店舗では null。枠は 1 つも作れない */
  readonly seatSettings: SeatSettings | null;
  readonly hours: readonly BusinessHours[];
  /** 臨時休業日か。営業時間があっても枠を出さない */
  readonly isClosedOnDate: boolean;
  /** 指定日に席を占めている予約（pending / confirmed）だけ */
  readonly existingReservations: readonly ExistingReservation[];
};

/** 定休日の行は open/close が NULL。BusinessHours は数値を要求するので 0 で埋める */
const CLOSED_DAY_MINUTE = 0;

export async function findSlotContext(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
  date: JstDate,
): Promise<SlotContext | null> {
  // 見えない店舗・存在しない店舗はここで等しく null になる
  const shop = await findVisibleShop(db, viewer, shopId);
  if (shop === null) {
    return null;
  }

  const dayOfWeek = dayOfWeekOf(date);
  // 枠は最大 47:59（MINUTE_OF_DAY_MAX）まで伸びうるので、その分まで見る
  const fromMs = toJstInstant(date, toMinuteOfDay(0));
  const toMs = toJstInstant(date, toMinuteOfDay(MINUTE_OF_DAY_MAX));

  const [settingsRows, hourRows, closureRows, reservationRows] = await Promise.all([
    db.select().from(seatSettings).where(eq(seatSettings.shopId, shopId)).limit(1),
    db
      .select()
      .from(shopHours)
      .where(and(eq(shopHours.shopId, shopId), eq(shopHours.dayOfWeek, dayOfWeek))),
    db
      .select({ date: shopClosures.date })
      .from(shopClosures)
      .where(and(eq(shopClosures.shopId, shopId), eq(shopClosures.date, date)))
      .limit(1),
    db
      .select({ reservedAt: reservations.reservedAt, partySize: reservations.partySize })
      .from(reservations)
      .where(
        and(
          eq(reservations.shopId, shopId),
          inArray(reservations.status, RESERVATION_STATUSES_OCCUPYING_SEAT),
          gte(reservations.reservedAt, fromMs),
          lt(reservations.reservedAt, toMs),
        ),
      ),
  ]);

  const settingsRow = settingsRows[0];
  return {
    shopName: shop.name,
    seatSettings:
      settingsRow === undefined
        ? null
        : {
            capacity: settingsRow.capacity,
            slotMinutes: settingsRow.slotMinutes,
            maxParallel: settingsRow.maxParallel,
            acceptsReservation: settingsRow.acceptsReservation,
          },
    hours: hourRows.map((row) => ({
      dayOfWeek: toDayOfWeek(row.dayOfWeek),
      openMinute: toMinuteOfDay(row.openMinute ?? CLOSED_DAY_MINUTE),
      closeMinute: toMinuteOfDay(row.closeMinute ?? CLOSED_DAY_MINUTE),
      isClosed: row.isClosed,
    })),
    isClosedOnDate: closureRows.length > 0,
    existingReservations: reservationRows.map((row) => ({
      // reserved_at は timestamp_ms なので Drizzle からは Date で返る
      startMinute: minuteOfDayFrom(date, row.reservedAt),
      partySize: row.partySize,
    })),
  };
}

/** エポックの Date を「その暦日の 0 時からの分」に戻す。日跨ぎ枠は 1440 以上になる */
function minuteOfDayFrom(date: JstDate, reservedAt: Date): ExistingReservation['startMinute'] {
  const baseMs = toJstInstant(date, toMinuteOfDay(0)).getTime();
  const MILLISECONDS_PER_MINUTE = 60_000;
  return toMinuteOfDay(Math.round((reservedAt.getTime() - baseMs) / MILLISECONDS_PER_MINUTE));
}
```

`MILLISECONDS_PER_MINUTE` は関数内で宣言せず、`@meshimap/core` から import する（マジックナンバー禁止の規約に従う）。import 文に足すこと:

```ts
import {
  MILLISECONDS_PER_MINUTE,
  MINUTE_OF_DAY_MAX,
  dayOfWeekOf,
  toDayOfWeek,
  toJstInstant,
  toMinuteOfDay,
} from '@meshimap/core';
```

そして `minuteOfDayFrom` から `const MILLISECONDS_PER_MINUTE = 60_000;` の行を削る。

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-slot-repository
```

期待: 7 本すべて PASS。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

(a) `inArray(reservations.status, RESERVATION_STATUSES_OCCUPYING_SEAT)` の行を消す:

→ 「席を占める状態（pending / confirmed）の予約だけを返す」が FAIL。`cancelled` の 4 名が混ざる。

(b) `findVisibleShop` の `null` チェックを消して `shopName: ''` を返すようにする:

→ 「匿名から見えない店舗は null を返す」と「存在しない店舗も null を返す」が FAIL。

(c) `eq(shopHours.dayOfWeek, dayOfWeek)` を消す:

→ 「指定日と違う曜日の営業時間は返さない」が FAIL（木曜と金曜の 2 行が返る）。

3 つとも確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/reservation-slot-repository.ts apps/api/src/repositories/reservation-slot-repository.test.ts
git commit -m "feat(api): 予約枠の計算に必要なデータをまとめて読むリポジトリを足す"
```

---

## Task 7-5: 空き枠サービスと `GET /reservation-slots`

`findSlotContext` が返したデータを `generateSlots()` と `canReserve()` に通して、枠ごとの空き状況を組み立てる。これが予約画面の入口になる。

**`/reservations/:reservationId` と衝突しないよう、独立したパス `/reservation-slots` にする。** `/reservations/slots` にすると `:reservationId` が `slots` にマッチする曖昧さが生まれ、登録順に依存した壊れ方をする。

**Files:**

- Create: `apps/api/src/schemas/reservation-schema.ts`
- Create: `apps/api/src/services/reservation-slot-service.ts`
- Create: `apps/api/src/routes/reservation-slots.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 の突合テスト。**ルートを 1 本足したら同じコミットでここも直す。**「裏取りした事実 7」参照）
- Test: `apps/api/src/services/reservation-slot-service.test.ts`
- Test: `apps/api/src/routes/reservation-slots.test.ts`

**Interfaces:**

- Consumes: `findSlotContext` / `SlotContext`（Task 7-4）、`generateSlots` / `canReserve` / `formatMinuteOfDay` / `toJstInstant`（`@meshimap/core`）、`AppEnv`（`../lib/app-env`）、`notFound` / `invalidInput`（`../lib/http-error`）、`createDatabase`（`../db/client`）、`requireActor`（`../middleware/role-guard`）、`parseShopId`（`../lib/parse-id`）
- Produces:
  - `reservationSlotQuerySchema`: `z.object({ shopId, date, partySize })`
  - `type SlotAvailability = { readonly startMinute: number; readonly endMinute: number; readonly label: string; readonly isAvailable: boolean; readonly reason: ReservationBlockReason | null; readonly remainingSeats: number }`
  - `type DailySlots = { readonly shopId: ShopId; readonly shopName: string; readonly date: JstDate; readonly acceptsReservation: boolean; readonly isClosedOnDate: boolean; readonly slots: readonly SlotAvailability[] }`
  - `listDailySlots(db: Database, viewer: Viewer, shopId: ShopId, date: JstDate, partySize: number): Promise<DailySlots | null>`
  - `reservationSlotRoutes`: Hono ルータ（`GET /`）

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/services/reservation-slot-service.test.ts`:

```ts
import { toJstDate, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { createDatabase } from '../db/client';
import {
  createTestWorld,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import { listDailySlots } from './reservation-slot-service';

let world: TestWorld;

const SHOP_ID = toShopId('shp_svc_0001');
const CLOSED_SHOP_ID = toShopId('shp_svc_0002');
/** 2026-10-01 は木曜（dayOfWeek = 4） */
const TARGET_DATE = toJstDate('2026-10-01');
const CUSTOMER_ID = 'usr_svc_customer';

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: CUSTOMER_ID, role: 'user' });

  await seedShop(world, {
    id: SHOP_ID,
    ownerId: null,
    name: '空き枠テスト店',
    status: 'published',
  });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    4,
    60,
    2,
    1,
  );
  // 木曜 18:00-21:00 → 60 分枠が 3 つ（18:00 / 19:00 / 20:00）
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_svc_thu',
    SHOP_ID,
    4,
    1080,
    1260,
    0,
  );
  // 18:00 の枠を 2 件で埋める（max_parallel = 2 なので件数上限に達する）
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_svc_1',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-01T09:00:00Z'),
    1,
    'pending',
  );
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_svc_2',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-01T09:00:00Z'),
    1,
    'confirmed',
  );
  // 19:00 の枠は 3 席ぶん埋まる（capacity 4 なので残 1 席）
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
    'rsv_svc_3',
    SHOP_ID,
    CUSTOMER_ID,
    Date.parse('2026-10-01T10:00:00Z'),
    3,
    'confirmed',
  );

  await seedShop(world, {
    id: CLOSED_SHOP_ID,
    ownerId: null,
    name: '予約受付停止店',
    status: 'published',
  });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    CLOSED_SHOP_ID,
    4,
    60,
    2,
    0,
  );
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_svc_closed',
    CLOSED_SHOP_ID,
    4,
    1080,
    1260,
    0,
  );
});

afterAll(async () => {
  await world.dispose();
});

describe('listDailySlots', () => {
  it('営業時間から 60 分枠を 3 つ作る', async () => {
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE, 1);
    expect(daily?.slots.map((slot) => slot.label)).toEqual(['18:00', '19:00', '20:00']);
    expect(daily?.slots.map((slot) => slot.startMinute)).toEqual([1080, 1140, 1200]);
    expect(daily?.slots.map((slot) => slot.endMinute)).toEqual([1140, 1200, 1260]);
  });

  it('件数上限に達した枠は parallel-full で埋まる', async () => {
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE, 1);
    const slot = daily?.slots.find((candidate) => candidate.startMinute === 1080);
    expect(slot?.isAvailable).toBe(false);
    expect(slot?.reason).toBe('parallel-full');
    // capacity 4 に 1 + 1 = 2 名入っているので残 2 席
    expect(slot?.remainingSeats).toBe(2);
  });

  it('残席を超える人数では seats-full になる', async () => {
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE, 2);
    const slot = daily?.slots.find((candidate) => candidate.startMinute === 1140);
    expect(slot?.remainingSeats).toBe(1);
    expect(slot?.isAvailable).toBe(false);
    expect(slot?.reason).toBe('seats-full');
  });

  it('残席ちょうどの人数なら予約できる（境界）', async () => {
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, TARGET_DATE, 1);
    const slot = daily?.slots.find((candidate) => candidate.startMinute === 1140);
    expect(slot?.isAvailable).toBe(true);
    expect(slot?.reason).toBeNull();
  });

  it('受付停止の店舗では全枠が not-accepting になる', async () => {
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, CLOSED_SHOP_ID, TARGET_DATE, 2);
    expect(daily?.acceptsReservation).toBe(false);
    expect(daily?.slots).toHaveLength(3);
    expect(daily?.slots.every((slot) => slot.reason === 'not-accepting')).toBe(true);
  });

  it('営業していない曜日では枠が 0 件になる', async () => {
    const db = createDatabase(world.d1);
    // 2026-10-03 は土曜。shop_hours に行が無い
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, toJstDate('2026-10-03'), 1);
    expect(daily?.slots).toEqual([]);
  });

  it('臨時休業日は枠を 0 件にして isClosedOnDate を立てる', async () => {
    await runWrite(
      world,
      'INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)',
      'scl_svc_1',
      SHOP_ID,
      '2026-10-08',
      '設備点検',
    );
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(db, ANONYMOUS_VIEWER, SHOP_ID, toJstDate('2026-10-08'), 1);
    expect(daily?.isClosedOnDate).toBe(true);
    expect(daily?.slots).toEqual([]);
  });

  it('席設定が無い店舗は枠 0 件・受付不可として返す', async () => {
    await seedShop(world, {
      id: toShopId('shp_svc_0003'),
      ownerId: null,
      name: '席設定なし',
      status: 'published',
    });
    const db = createDatabase(world.d1);
    const daily = await listDailySlots(
      db,
      ANONYMOUS_VIEWER,
      toShopId('shp_svc_0003'),
      TARGET_DATE,
      1,
    );
    expect(daily?.acceptsReservation).toBe(false);
    expect(daily?.slots).toEqual([]);
  });

  it('見えない店舗は null を返す', async () => {
    await seedShop(world, {
      id: toShopId('shp_svc_0004'),
      ownerId: null,
      name: '下書き',
      status: 'draft',
    });
    const db = createDatabase(world.d1);
    expect(
      await listDailySlots(db, ANONYMOUS_VIEWER, toShopId('shp_svc_0004'), TARGET_DATE, 1),
    ).toBeNull();
  });
});
```

`apps/api/src/routes/reservation-slots.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { toShopId } from '@meshimap/core';
import { app } from '../index';
import {
  createTestWorld,
  createTestBindings,
  runWrite,
  seedMasters,
  seedShop,
  type TestWorld,
} from '../test/fixtures';

let world: TestWorld;
const SHOP_ID = toShopId('shp_route_0001');

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedShop(world, {
    id: SHOP_ID,
    ownerId: null,
    name: 'ルートテスト店',
    status: 'published',
  });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    4,
    60,
    2,
    1,
  );
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_route_thu',
    SHOP_ID,
    4,
    1080,
    1260,
    0,
  );
});

afterAll(async () => {
  await world.dispose();
});

describe('GET /reservation-slots', () => {
  it('匿名でも 200 で枠を返す', async () => {
    const response = await app.request(
      `/reservation-slots?shopId=${SHOP_ID}&date=2026-10-01&partySize=2`,
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ shopId: SHOP_ID, date: '2026-10-01', acceptsReservation: true });
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots).toHaveLength(3);
  });

  it('partySize を省略すると 1 名として扱う', async () => {
    const response = await app.request(
      `/reservation-slots?shopId=${SHOP_ID}&date=2026-10-01`,
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(200);
  });

  it('日付の形式が違えば 422', async () => {
    const response = await app.request(
      `/reservation-slots?shopId=${SHOP_ID}&date=2026-13-45&partySize=2`,
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(422);
  });

  it('人数が上限を超えれば 422', async () => {
    const response = await app.request(
      `/reservation-slots?shopId=${SHOP_ID}&date=2026-10-01&partySize=21`,
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(422);
  });

  it('shopId が無ければ 422', async () => {
    const response = await app.request(
      '/reservation-slots?date=2026-10-01&partySize=2',
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(422);
  });

  it('存在しない店舗は 404', async () => {
    const response = await app.request(
      '/reservation-slots?shopId=shp_nope&date=2026-10-01&partySize=2',
      {},
      createTestBindings(world),
    );
    expect(response.status).toBe(404);
  });

  it('内部メモや他人の予約者名は応答に含まれない', async () => {
    const response = await app.request(
      `/reservation-slots?shopId=${SHOP_ID}&date=2026-10-01&partySize=2`,
      {},
      createTestBindings(world),
    );
    const text = await response.text();
    expect(text).not.toContain('owner_memo');
    expect(text).not.toContain('userId');
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-slot-service reservation-slots
```

期待: どちらも `Failed to resolve import` で FAIL。

- [ ] **Step 3: 最小の実装を書く**

`apps/api/src/schemas/reservation-schema.ts`:

```ts
// 予約 API 固有の入出力スキーマ。core にあるもの（reservationCreateSchema）は再定義しない。

import {
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_STATUSES,
  identifierSchema,
} from '@meshimap/core';
import { z } from 'zod';
import { RESERVATION_OWNER_MEMO_MAX_LENGTH } from '../db/constants';

/** 人数を省略したときの既定。1 名分の空きが見たいという意味 */
const DEFAULT_PARTY_SIZE = 1;

export const reservationSlotQuerySchema = z.object({
  shopId: identifierSchema,
  date: z.iso.date(),
  // クエリ文字列は常に string なので coerce する
  partySize: z.coerce
    .number()
    .int()
    .min(PARTY_SIZE_MIN)
    .max(PARTY_SIZE_MAX)
    .default(DEFAULT_PARTY_SIZE),
});

/** 利用者の予約一覧の絞り込み。upcoming = これから、past = 済んだもの */
export const reservationScopeSchema = z.enum(['upcoming', 'past']).default('upcoming');

export const reservationListQuerySchema = z.object({
  scope: reservationScopeSchema,
});

export const ownerReservationListQuerySchema = z.object({
  date: z.iso.date().optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
});

/** 店舗側の状態変更。遷移できるかは core の遷移表が決めるのでここでは値の形だけ見る */
export const reservationStatusUpdateSchema = z.object({
  status: z.enum(RESERVATION_STATUSES),
});

export const reservationMemoUpdateSchema = z.object({
  ownerMemo: z.string().trim().max(RESERVATION_OWNER_MEMO_MAX_LENGTH),
});

export type ReservationSlotQuery = z.infer<typeof reservationSlotQuerySchema>;
export type ReservationListQuery = z.infer<typeof reservationListQuerySchema>;
export type OwnerReservationListQuery = z.infer<typeof ownerReservationListQuerySchema>;
export type ReservationStatusUpdateInput = z.infer<typeof reservationStatusUpdateSchema>;
export type ReservationMemoUpdateInput = z.infer<typeof reservationMemoUpdateSchema>;
```

`apps/api/src/services/reservation-slot-service.ts`:

```ts
// 空き枠の一覧を組み立てる。判定そのものは core の canReserve に任せ、ここは並べ替えと整形だけ。

import type { JstDate, ReservationBlockReason, SeatSettings, ShopId } from '@meshimap/core';
import { canReserve, formatMinuteOfDay, generateSlots } from '@meshimap/core';
import type { Viewer } from '../auth/actor';
import type { Database } from '../db/client';
import { findSlotContext } from '../repositories/reservation-slot-repository';

export type SlotAvailability = {
  readonly startMinute: number;
  readonly endMinute: number;
  /** 表示用の「18:00」。1440 以上は「翌 1:30」になる */
  readonly label: string;
  readonly isAvailable: boolean;
  readonly reason: ReservationBlockReason | null;
  readonly remainingSeats: number;
};

export type DailySlots = {
  readonly shopId: ShopId;
  readonly shopName: string;
  readonly date: JstDate;
  readonly acceptsReservation: boolean;
  readonly isClosedOnDate: boolean;
  readonly slots: readonly SlotAvailability[];
};

/** 席設定が無い、または臨時休業のときに返す「枠なし」の形 */
function emptySlots(
  shopId: ShopId,
  shopName: string,
  date: JstDate,
  seatSettings: SeatSettings | null,
  isClosedOnDate: boolean,
): DailySlots {
  return {
    shopId,
    shopName,
    date,
    acceptsReservation: seatSettings?.acceptsReservation ?? false,
    isClosedOnDate,
    slots: [],
  };
}

export async function listDailySlots(
  db: Database,
  viewer: Viewer,
  shopId: ShopId,
  date: JstDate,
  partySize: number,
): Promise<DailySlots | null> {
  const context = await findSlotContext(db, viewer, shopId, date);
  if (context === null) {
    return null;
  }
  const { seatSettings, isClosedOnDate } = context;
  // 席設定が無い店・臨時休業日は枠そのものを出さない。
  // 受付停止（acceptsReservation = false）はここでは落とさず、
  // 枠は出したうえで not-accepting の理由を付ける（利用者に「なぜ押せないか」を見せるため）
  if (seatSettings === null || isClosedOnDate) {
    return emptySlots(shopId, context.shopName, date, seatSettings, isClosedOnDate);
  }

  const slots = generateSlots(context.hours, seatSettings, date).map((slot) => {
    const availability = canReserve({
      slot,
      seatSettings,
      existingReservations: context.existingReservations,
      partySize,
    });
    return {
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      label: formatMinuteOfDay(slot.startMinute),
      isAvailable: availability.isAvailable,
      reason: availability.reason,
      remainingSeats: availability.remainingSeats,
    };
  });

  return {
    shopId,
    shopName: context.shopName,
    date,
    acceptsReservation: seatSettings.acceptsReservation,
    isClosedOnDate: false,
    slots,
  };
}
```

`apps/api/src/routes/reservation-slots.ts`:

```ts
// 空き枠の公開エンドポイント。/reservations/:reservationId と曖昧にならないよう別パスに置く。

import { toJstDate, toShopId } from '@meshimap/core';
import { Hono } from 'hono';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { invalidInput, notFound } from '../lib/http-error';
import { reservationSlotQuerySchema } from '../schemas/reservation-schema';
import { listDailySlots } from '../services/reservation-slot-service';

export const reservationSlotRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const parsed = reservationSlotQuerySchema.safeParse({
    shopId: c.req.query('shopId'),
    date: c.req.query('date'),
    // 未指定なら default が効くよう undefined を渡す
    partySize: c.req.query('partySize'),
  });
  if (!parsed.success) {
    // http-error.ts の関数は HTTPException を「返す」ので、呼び出し側が throw する（実ファイルで確認済み）
    throw invalidInput();
  }

  const daily = await listDailySlots(
    createDatabase(c.env.DB),
    c.get('viewer'),
    toShopId(parsed.data.shopId),
    toJstDate(parsed.data.date),
    parsed.data.partySize,
  );
  if (daily === null) {
    throw notFound();
  }
  return c.json(daily);
});
```

**`requireActor` を import していないことに注意。** このルートは匿名でも見えるので、認証を要求しない。認証情報があれば `authMiddleware` が `viewer` を積んでいるので `c.get('viewer')` をそのまま使えばよい。`requireActor` を足すと公開エンドポイントが 401 を返すようになり、Task 7-13 の権限マトリクスの 1 行目が落ちる。

`apps/api/src/index.ts` にマウントする:

```ts
import { reservationSlotRoutes } from './routes/reservation-slots';

// 既存の .route(...) の並びに足す
  .route('/reservation-slots', reservationSlotRoutes)
```

**同じコミットで `apps/api/src/routes/permission-matrix.test.ts` も直す。** 直さないと、Phase 4 のテストが 2 本落ちる（「裏取りした事実 7」で中身を確認済み）。落ち方は次のとおり:

```
FAIL  ルート表と実装の突合 > app に登録されたエンドポイントは 10 本で、想定どおりの並びである
  - Expected  10 items
  + Received  11 items
FAIL  ルート表と実装の突合 > 権限マトリクスは app のエンドポイントを 1 本残らず覆っている
  - Expected  []
  + Received  [ '権限マトリクスに無いエンドポイント: GET /reservation-slots' ]
```

直しかたは 4 か所。

(1) `EXPECTED_ROUTE_PATTERNS` に 1 行足す。**この配列はソート済みの並びで比較される**（`collectEndpointPatterns` が `.sort()` して返すため）。`'GET /me'` と `'GET /shops'` の間に入る:

```ts
/** 権限マトリクスが責任を持つ 11 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /reservation-slots',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /shops/:shopId',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];
```

(2) `it('app に登録されたエンドポイントは 10 本で、想定どおりの並びである')` の**テスト名の数字も 11 に直す**。名前と中身がずれたテストは、次に読む人を必ず騙す。

(3) 委譲リストを導入する。`EXPECTED_ROUTE_PATTERNS` の直後に置く:

```ts
/**
 * 主体ごとの総当たりを `reservation-permission-matrix.test.ts` に委ねているエンドポイント。
 * 下の突合では「覆われている」側に数えるが、期待ステータスの表は向こうが持つ。
 *
 * **自動生成にしないこと。** ここをベタ書きにしてあるのは、予約系のルートを増やした人が
 * 必ず一度このテストで落ちて、委譲先のファイル名を読むようにするため。
 */
const DELEGATED_ROUTE_PATTERNS: readonly string[] = ['GET /reservation-slots'];

/** 委譲を許すパスの形。`reservation-permission-matrix.test.ts` の PHASE_7_PATH_PATTERN と同じもの */
const DELEGATABLE_PATH_PATTERN = /^\/(reservation-slots|reservations|owner\/reservations)(\/|$)/;
```

(4) `describe('ルート表と実装の突合')` の中を直す。`covered` に委譲ぶんを混ぜ、**委譲できるのは予約系だけ**であることを縛る it を 1 本足す:

```ts
it('権限マトリクスは app のエンドポイントを 1 本残らず覆っている', () => {
  // #4 と #5 のように 1 本のルートを複数ケースで検証しているので、重複は潰して比べる
  const covered = [
    ...ENDPOINT_CASES.map((endpoint) => endpoint.routePattern),
    ...DELEGATED_ROUTE_PATTERNS,
  ];
  expect(collectRouteCoverageViolations(app.routes, covered, AUTH_BASE_PATH)).toEqual([]);
});

it('委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている', () => {
  // 「面倒だから委譲リストに入れておく」を防ぐ。予約系以外はこのファイルで検証し切る
  const reservationPatterns = collectEndpointPatterns(app.routes, AUTH_BASE_PATH).filter(
    (pattern) => DELEGATABLE_PATH_PATTERN.test(pattern.slice(pattern.indexOf(' ') + 1)),
  );
  expect([...DELEGATED_ROUTE_PATTERNS].sort()).toEqual(reservationPatterns);
});
```

`collectEndpointPatterns` は同じファイルで `export` されているので、追加の import は要らない（「裏取りした事実 7」で確認済み）。

**委譲先の `reservation-permission-matrix.test.ts` は Task 7-13 で作る。この時点ではまだ存在しない。** ここで書いているのはファイル名を指すコメントと文字列だけで、`import` も `readFileSync` もしていないので、存在しなくてもテストは走る。**実在を強制する仕掛けを入れないのは意図的である**——2 ファイルの整合は「Phase 4 側: 委譲リスト == `app.routes` の予約系」と「Task 7-13 側: `AUTHORIZATION_CASES` == `app.routes` の予約系」の 2 本が同時に緑になることで取る（Task 7-13 冒頭の表を参照）。テストファイル同士を `import` すると、向こうの `describe` がこちらの実行に混ざるため避ける。

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-slot-service reservation-slots permission-matrix
```

期待: サービス 9 本・ルート 7 本すべて PASS。加えて Phase 4 の `permission-matrix.test.ts` が**全件 PASS**（新しく足した「委譲しているのは予約系だけで…」を含む）。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

(a) `partySize` を `canReserve` に渡すのをやめ、常に 1 を渡す:

→ 「残席を超える人数では seats-full になる」が FAIL。

(b) `isClosedOnDate` の早期 return を消す:

→ 「臨時休業日は枠を 0 件にして isClosedOnDate を立てる」が FAIL。

(c) `reservationSlotQuerySchema` の `.max(PARTY_SIZE_MAX)` を消す:

→ 「人数が上限を超えれば 422」が FAIL（200 が返る）。

(d) `permission-matrix.test.ts` の `DELEGATED_ROUTE_PATTERNS` を `[]` に戻す:

→ 「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」が `['権限マトリクスに無いエンドポイント: GET /reservation-slots']` で FAIL し、「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」も FAIL する。**エンドポイントを足して棚卸しに書き忘れたときに、確かに落ちる**ことの確認。

4 つとも確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/schemas/reservation-schema.ts apps/api/src/services/reservation-slot-service.ts apps/api/src/services/reservation-slot-service.test.ts apps/api/src/routes/reservation-slots.ts apps/api/src/routes/reservation-slots.test.ts apps/api/src/routes/permission-matrix.test.ts apps/api/src/index.ts
git commit -m "feat(api): 空き枠サービスと GET /reservation-slots を足す"
```

---

## Task 7-6: `ReservationLock` Durable Object

Phase 4 Task 4-11 が `apps/api/src/index.ts` に置いた空の `ReservationLock` に中身を入れる。実装は別ファイルに出し、`index.ts` からは再エクスポートするだけにする。

**守るべき 2 つの制約:**

1. **クラシック形式で書く。** `import { DurableObject } from 'cloudflare:workers'` は使わない。Phase 4 Task 4-11 の確定事項どおり、これを import すると Node で走る Vitest が `../index` を読み込めなくなる（`Cannot find module 'cloudflare:workers'`）。`constructor(state, env)` + `fetch(request)` の素の形にし、型は `@cloudflare/workers-types` のグローバル型を使う。クラシック形式は RPC メソッドを生やせないので、呼び出しは `stub.fetch(...)` になる
2. **D1 の read→write を `state.blockConcurrencyWhile()` で囲う。** DO の入力ゲートはストレージ操作の await しか守らない。D1 の await はゲートを開けてしまうため、これが無いと 20 本同時で最大 11 件が通ってしまう（裏取り 事実 2）

**リポジトリではなく「ストア」として `src/durable-objects/` に置く理由:** `src/repositories/*` の関数は `(db, actor, ...)` を取ると決まっており、Phase 4 Task 4-10 がそれを機械検査している。DO の中には Actor が無い（ブランド型は JSON をまたげない）。しかし DO に入る時点で認可は済んでおり、残っているのは席の算術と INSERT だけなので、Actor は本質的に不要である。**認可を素通りさせているのではなく、認可の終わった後の処理**であることを示すため、`src/repositories/` には置かず `src/durable-objects/reservation-lock-store.ts` に置く。この境界が守られていることは Task 7-13 の権限テストが端から端まで確かめる。

**Files:**

- Create: `apps/api/src/durable-objects/reservation-lock-protocol.ts`
- Create: `apps/api/src/durable-objects/reservation-lock-store.ts`
- Create: `apps/api/src/durable-objects/reservation-lock.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/durable-objects/reservation-lock-store.test.ts`

**Interfaces:**

- Consumes: `canReserve` / `toMinuteOfDay` / `toJstInstant`（`@meshimap/core`）、`reservations` / `seatSettings`（`../db/schema`）、`RESERVATION_STATUSES_OCCUPYING_SEAT` / `RESERVATION_STATUS_PENDING`（`../db/constants`）、`createDatabase` / `Database`（`../db/client`）、`AppBindings`（`../lib/app-env`）、`logError`（`../lib/logger`）
- Produces:
  - `holdReservationCommandSchema` / `type HoldReservationCommand = { reservationId: string; shopId: string; userId: string; reservedAtMs: number; startMinute: number; partySize: number; note: string }`
  - `holdReservationResultSchema` / `type HoldReservationResult = { isGranted: true; reservationId: string } | { isGranted: false; reason: ReservationBlockReason }`
  - `RESERVATION_LOCK_PATH = '/hold'` / `RESERVATION_LOCK_ORIGIN = 'https://reservation-lock'`
  - `reservationLockName(shopId: string, date: string): string`
  - `type ReservationLockStub = { fetch(input: string, init: RequestInit): Promise<Response> }`
  - `type ReservationLockNamespace = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): ReservationLockStub }`
  - `readSeatSettingsForLock(db, shopId): Promise<SeatSettings | null>`
  - `readOccupyingPartySizes(db, shopId, reservedAtMs): Promise<readonly number[]>`
  - `insertHeldReservation(db, command): Promise<void>`
  - `class ReservationLock`（クラシック形式の Durable Object）

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/durable-objects/reservation-lock-store.test.ts`:

```ts
import { toShopId } from '@meshimap/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import {
  countRows,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import {
  insertHeldReservation,
  readOccupyingPartySizes,
  readSeatSettingsForLock,
  reservationLockName,
} from './reservation-lock-store';

let world: TestWorld;
const SHOP_ID = toShopId('shp_lock_0001');
const BARE_SHOP_ID = toShopId('shp_lock_0002');
const USER_ID = 'usr_lock_customer';
/** 2026-10-01 18:00 JST */
const RESERVED_AT_MS = Date.parse('2026-10-01T09:00:00Z');

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: USER_ID, role: 'user' });
  await seedShop(world, {
    id: SHOP_ID,
    ownerId: null,
    name: 'ロックテスト店',
    status: 'published',
  });
  await seedShop(world, {
    id: BARE_SHOP_ID,
    ownerId: null,
    name: '席設定なし',
    status: 'published',
  });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    4,
    60,
    2,
    1,
  );
});

afterAll(async () => {
  await world.dispose();
});

describe('reservationLockName', () => {
  it('店舗 ID と日付をコロンでつなぐ', () => {
    expect(reservationLockName('shp_abc', '2026-10-01')).toBe('shp_abc:2026-10-01');
  });

  it('日付が違えば別の名前になる', () => {
    expect(reservationLockName('shp_abc', '2026-10-01')).not.toBe(
      reservationLockName('shp_abc', '2026-10-02'),
    );
  });

  it('店舗が違えば別の名前になる', () => {
    expect(reservationLockName('shp_abc', '2026-10-01')).not.toBe(
      reservationLockName('shp_xyz', '2026-10-01'),
    );
  });
});

describe('readSeatSettingsForLock', () => {
  it('席設定を SeatSettings の形で返す', async () => {
    const db = createDatabase(world.d1);
    expect(await readSeatSettingsForLock(db, SHOP_ID)).toEqual({
      capacity: 4,
      slotMinutes: 60,
      maxParallel: 2,
      acceptsReservation: true,
    });
  });

  it('席設定が無ければ null を返す', async () => {
    const db = createDatabase(world.d1);
    expect(await readSeatSettingsForLock(db, BARE_SHOP_ID)).toBeNull();
  });
});

describe('readOccupyingPartySizes', () => {
  it('同じ時刻の pending と confirmed だけを返す', async () => {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      'rsv_lock_1',
      SHOP_ID,
      USER_ID,
      RESERVED_AT_MS,
      2,
      'pending',
    );
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      'rsv_lock_2',
      SHOP_ID,
      USER_ID,
      RESERVED_AT_MS,
      1,
      'confirmed',
    );
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      'rsv_lock_3',
      SHOP_ID,
      USER_ID,
      RESERVED_AT_MS,
      4,
      'cancelled',
    );
    const db = createDatabase(world.d1);
    const sizes = await readOccupyingPartySizes(db, SHOP_ID, RESERVED_AT_MS);
    expect([...sizes].sort()).toEqual([1, 2]);
  });

  it('1 ミリ秒でもずれた予約は数えない', async () => {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      'rsv_lock_4',
      SHOP_ID,
      USER_ID,
      RESERVED_AT_MS + 1,
      8,
      'confirmed',
    );
    const db = createDatabase(world.d1);
    const sizes = await readOccupyingPartySizes(db, SHOP_ID, RESERVED_AT_MS);
    expect(sizes).not.toContain(8);
  });

  it('別の店舗の予約は数えない', async () => {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, status) VALUES (?, ?, ?, ?, ?, ?)',
      'rsv_lock_5',
      BARE_SHOP_ID,
      USER_ID,
      RESERVED_AT_MS,
      7,
      'confirmed',
    );
    const db = createDatabase(world.d1);
    const sizes = await readOccupyingPartySizes(db, SHOP_ID, RESERVED_AT_MS);
    expect(sizes).not.toContain(7);
  });
});

describe('insertHeldReservation', () => {
  it('pending の予約を 1 行書く', async () => {
    const db = createDatabase(world.d1);
    await insertHeldReservation(db, {
      reservationId: 'rsv_lock_new',
      shopId: SHOP_ID,
      userId: USER_ID,
      reservedAtMs: Date.parse('2026-10-05T09:00:00Z'),
      startMinute: 1080,
      partySize: 2,
      note: '窓際希望',
    });
    const row = await readRow(world, 'SELECT * FROM reservations WHERE id = ?', 'rsv_lock_new');
    expect(row).toMatchObject({
      shop_id: SHOP_ID,
      user_id: USER_ID,
      party_size: 2,
      note: '窓際希望',
      status: 'pending',
    });
    expect(row?.reserved_at).toBe(Date.parse('2026-10-05T09:00:00Z'));
  });

  it('同じ id を 2 回書こうとすると失敗する（主キー衝突）', async () => {
    const db = createDatabase(world.d1);
    const command = {
      reservationId: 'rsv_lock_dup',
      shopId: SHOP_ID,
      userId: USER_ID,
      reservedAtMs: Date.parse('2026-10-06T09:00:00Z'),
      startMinute: 1080,
      partySize: 2,
      note: '',
    };
    await insertHeldReservation(db, command);
    await expect(insertHeldReservation(db, command)).rejects.toThrow();
    expect(
      await countRows(
        world,
        'SELECT COUNT(*) AS count FROM reservations WHERE id = ?',
        'rsv_lock_dup',
      ),
    ).toBe(1);
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-lock-store
```

期待: `Failed to resolve import "./reservation-lock-store"` で FAIL。

- [ ] **Step 3: プロトコルとストアを書く**

`apps/api/src/durable-objects/reservation-lock-protocol.ts`:

```ts
// Durable Object との往復メッセージ。クラシック形式の DO は RPC メソッドを持てないので
// fetch のボディで JSON をやり取りする。JSON は型を保証しないので両方向とも Zod で通す。

import {
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  identifierSchema,
  minuteOfDaySchema,
} from '@meshimap/core';
import { z } from 'zod';

/** DO の fetch に渡す URL。DO は経路を持たないので origin は何でもよいが、固定して読みやすくする */
export const RESERVATION_LOCK_ORIGIN = 'https://reservation-lock';
export const RESERVATION_LOCK_PATH = '/hold';

/**
 * DO スタブのうち、本番コードが実際に呼ぶのは fetch だけ。
 * `DurableObjectStub` を丸ごと要求すると、テストで偽物を作るのに `as` が要る。
 */
export type ReservationLockStub = {
  fetch(input: string, init: RequestInit): Promise<Response>;
};

/**
 * `DurableObjectNamespace` のうち、本番コードが実際に使う 2 つだけを写した型。
 *
 * `DurableObjectNamespace` は abstract class として宣言されている
 * （`node_modules/@cloudflare/workers-types/index.d.ts:648`）ので、
 * テストで偽物を渡すには `as unknown as DurableObjectNamespace` が要る。
 * **`as` はコーディング規約 2 章で禁止**（例外はブランド型の生成のみ）なので、
 * 受け口をこの幅に狭めて、偽物を `as` なしで作れるようにする。
 *
 * 本物の `DurableObjectNamespace` はこの型を構造的に満たすため、
 * 呼び出し側（`c.env.RESERVATION_LOCK` をそのまま渡す）は 1 文字も変わらない。
 * この代入可能性は tsc で実測済み（「裏取りした事実 8」）。
 */
export type ReservationLockNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): ReservationLockStub;
};

/** DO ID の素になる名前。店舗 × 日付の粒度で 1 インスタンスにする */
export function reservationLockName(shopId: string, date: string): string {
  return `${shopId}:${date}`;
}

export const holdReservationCommandSchema = z.object({
  reservationId: identifierSchema,
  shopId: identifierSchema,
  userId: identifierSchema,
  /** 来店時刻のエポックミリ秒。reservations.reserved_at にそのまま入る */
  reservedAtMs: z.number().int(),
  /** 枠の開始（0 時からの分）。canReserve が同一枠の判定に使う */
  startMinute: minuteOfDaySchema,
  partySize: z.number().int().min(PARTY_SIZE_MIN).max(PARTY_SIZE_MAX),
  note: z.string().max(RESERVATION_NOTE_MAX_LENGTH),
});

export const holdReservationResultSchema = z.discriminatedUnion('isGranted', [
  z.object({ isGranted: z.literal(true), reservationId: identifierSchema }),
  z.object({
    isGranted: z.literal(false),
    reason: z.enum([
      'not-accepting',
      'party-too-large',
      'parallel-full',
      'seats-full',
      'no-seat-settings',
    ]),
  }),
]);

export type HoldReservationCommand = z.infer<typeof holdReservationCommandSchema>;
export type HoldReservationResult = z.infer<typeof holdReservationResultSchema>;
```

`no-seat-settings` は core の `ReservationBlockReason` に無い理由コードである。席設定そのものが未登録の店舗は `canReserve` を呼べない（`assertSeatSettings` が投げる）ので、DO 側で独自に持つ。

`apps/api/src/durable-objects/reservation-lock-store.ts`:

```ts
// Durable Object の臨界区間から使う D1 アクセス。
//
// src/repositories/ には置かない。あちらは (db, actor, ...) を取り、
// 所有権を WHERE 句で表す層で、Phase 4 Task 4-10 がそれを機械検査している。
// ここに来る時点でルート側の認可は終わっており、残るのは席の算術と INSERT だけ。
// Actor を JSON でまたがせる代わりに、層を分けて役割の違いを明示する。

import type { SeatSettings } from '@meshimap/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { RESERVATION_STATUS_PENDING, RESERVATION_STATUSES_OCCUPYING_SEAT } from '../db/constants';
import { reservations, seatSettings } from '../db/schema';
import type { HoldReservationCommand } from './reservation-lock-protocol';

export { reservationLockName } from './reservation-lock-protocol';

export async function readSeatSettingsForLock(
  db: Database,
  shopId: string,
): Promise<SeatSettings | null> {
  const rows = await db.select().from(seatSettings).where(eq(seatSettings.shopId, shopId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    capacity: row.capacity,
    slotMinutes: row.slotMinutes,
    maxParallel: row.maxParallel,
    acceptsReservation: row.acceptsReservation,
  };
}

/** この瞬間ちょうどに席を占めている予約の人数。件数と合計人数の両方をここから数える */
export async function readOccupyingPartySizes(
  db: Database,
  shopId: string,
  reservedAtMs: number,
): Promise<readonly number[]> {
  const rows = await db
    .select({ partySize: reservations.partySize })
    .from(reservations)
    .where(
      and(
        eq(reservations.shopId, shopId),
        eq(reservations.reservedAt, new Date(reservedAtMs)),
        inArray(reservations.status, RESERVATION_STATUSES_OCCUPYING_SEAT),
      ),
    );
  return rows.map((row) => row.partySize);
}

export async function insertHeldReservation(
  db: Database,
  command: HoldReservationCommand,
): Promise<void> {
  await db.insert(reservations).values({
    id: command.reservationId,
    shopId: command.shopId,
    userId: command.userId,
    reservedAt: new Date(command.reservedAtMs),
    partySize: command.partySize,
    note: command.note,
    status: RESERVATION_STATUS_PENDING,
  });
}
```

- [ ] **Step 4: ストアのテストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-lock-store
```

期待: 10 本すべて PASS。

- [ ] **Step 5: Durable Object 本体を書く**

`apps/api/src/durable-objects/reservation-lock.ts`:

```ts
// 予約枠の二重押さえを防ぐ Durable Object。
//
// ◆ なぜ D1 だけでは足りないのか
// 「空きを数える → 書く」を D1 で素直に書くと、10 本同時に来たリクエストの
// SELECT が全部 INSERT より先に走る。実測では 6 回中 6 回、10 本すべてが通った。
// D1 には対話型トランザクションが無く（typeof d1.transaction === 'undefined'）、
// batch() も別リクエスト同士を直列化しない（実測: 3 回とも 10 成功 / 10 行）。
//
// ◆ なぜ blockConcurrencyWhile が要るのか
// DO の入力ゲートは「ストレージ操作の await」の間しか閉じない。D1 の await は
// ゲートを開けてしまうので、DO に入れただけでは直列化されない。
// 実測（20 本同時 × 10 回）: ゲート無し → 1,1,1,1,1,1,3,1,11,4 件成功。
//                          ゲート有り → 10 回とも 1 件。
// 本番同等の条件（max_parallel = 2、20 本同時 × 5 回）でも
// ゲート有りは 5 回とも 2 件、ゲート無しは 17/3/20/20/20 件だった。
//
// ◆ この DO は自分のストレージを一切使わない
// 予約の正は D1 にある。DO は「この店舗のこの日付の予約を作る順番」を決めるだけ。
// 状態を二重に持つと、DO の再起動や移動で D1 とずれる。

import { canReserve, toMinuteOfDay } from '@meshimap/core';
import { createDatabase } from '../db/client';
import type { AppBindings } from '../lib/app-env';
import { logError } from '../lib/logger';
import {
  holdReservationCommandSchema,
  type HoldReservationCommand,
  type HoldReservationResult,
} from './reservation-lock-protocol';
import {
  insertHeldReservation,
  readOccupyingPartySizes,
  readSeatSettingsForLock,
} from './reservation-lock-store';

/** 入力が壊れているときに返す HTTP ステータス。ここに来る時点でルート側が検証済みのはず */
const BAD_REQUEST_STATUS = 400;
const INTERNAL_ERROR_STATUS = 500;

/**
 * クラシック形式の Durable Object。
 *
 * `cloudflare:workers` の `DurableObject` を継承してはいけない。継承すると
 * src/index.ts が Node 上の Vitest から import できなくなる
 * （Cannot find module 'cloudflare:workers'）。Phase 4 Task 4-11 の確定事項。
 * クラシック形式は RPC メソッドを持てないので、呼び出し側は stub.fetch を使う。
 */
export class ReservationLock {
  readonly #state: DurableObjectState;
  readonly #env: AppBindings;

  constructor(state: DurableObjectState, env: AppBindings) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const parsed = holdReservationCommandSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response(null, { status: BAD_REQUEST_STATUS });
    }
    try {
      // ここが臨界区間。D1 の await はゲートを開けてしまうので、
      // read→write 全体をこの中に入れる。1 文字でも外に出したら直列化は壊れる
      const result = await this.#state.blockConcurrencyWhile(() => this.#hold(parsed.data));
      return Response.json(result);
    } catch (cause) {
      logError('予約枠の確保に失敗しました', cause);
      return new Response(null, { status: INTERNAL_ERROR_STATUS });
    }
  }

  async #hold(command: HoldReservationCommand): Promise<HoldReservationResult> {
    const db = createDatabase(this.#env.DB);
    const seatSettings = await readSeatSettingsForLock(db, command.shopId);
    if (seatSettings === null) {
      // 席設定が無い店舗は canReserve を呼べない（assertSeatSettings が投げる）
      return { isGranted: false, reason: 'no-seat-settings' };
    }

    const partySizes = await readOccupyingPartySizes(db, command.shopId, command.reservedAtMs);
    const startMinute = toMinuteOfDay(command.startMinute);
    const availability = canReserve({
      slot: { startMinute, endMinute: toMinuteOfDay(startMinute + seatSettings.slotMinutes) },
      seatSettings,
      existingReservations: partySizes.map((partySize) => ({ startMinute, partySize })),
      partySize: command.partySize,
    });
    if (!availability.isAvailable || availability.reason !== null) {
      return { isGranted: false, reason: availability.reason ?? 'seats-full' };
    }

    await insertHeldReservation(db, command);
    return { isGranted: true, reservationId: command.reservationId };
  }
}
```

`apps/api/src/index.ts` の空の `ReservationLock` を削り、再エクスポートに差し替える:

```ts
// Durable Object の実体は src/durable-objects/reservation-lock.ts。
// wrangler.jsonc の durable_objects.bindings.class_name がこの名前を探すので、
// エントリから同名で再エクスポートしないと `wrangler dev` が起動しない
export { ReservationLock } from './durable-objects/reservation-lock';
```

- [ ] **Step 6: 型検査が通ることを確認する**

```bash
npm run typecheck -w @meshimap/api
```

期待: エラー 0。`DurableObjectState` は `@cloudflare/workers-types` のグローバル型なので import 不要。**`Cannot find name 'DurableObjectState'` が出たら、`apps/api/tsconfig.json` の `types` に `@cloudflare/workers-types` が入っているかを確認する。**

```bash
npm test -w @meshimap/api -- reservation-lock-store
```

期待: PASS のまま（`index.ts` の変更で既存テストが壊れていないこと）。

- [ ] **Step 7: わざと壊してテストが落ちることを確認する**

ここは **Task 7-7 の同時実行テストが本番の検証**になる。このタスクでは「単体で動くか」だけを壊して見る。

(a) `readOccupyingPartySizes` の `inArray(...)` を消す:

→ `npm test -w @meshimap/api -- reservation-lock-store` が「同じ店舗の pending と confirmed だけを返す」で FAIL。

(b) `insertHeldReservation` の `status: RESERVATION_STATUS_PENDING` を `'confirmed'` に変える:

→ 「pending の予約を 1 行書く」が FAIL。

2 つとも確認したら元に戻す。

- [ ] **Step 8: コミット**

```bash
git add apps/api/src/durable-objects/ apps/api/src/index.ts
git commit -m "feat(api): 予約枠を直列化する ReservationLock Durable Object を実装する"
```

---

## Task 7-7: Durable Object の同時実行テスト

**このフェーズで一番大事なテスト。** 「同じ枠に N 本同時に投げて、成功するのはちょうど 1 件（正確には席と件数の上限ぶん）だけ」を実測する。

### どう書くと決めたか

1. **miniflare を直接起こす。** Vitest は Node 環境（`environment: 'node'`）で動くので、DO は Node の中では動かせない。`new Miniflare(convertV4MiniflareOptions({ modules: true, script, durableObjects: {...}, d1Databases: { DB: ':memory:' } }))` で本物の workerd を起こす。**この経路が動くことは実測で確認済み**（裏取り 事実 3）
2. **miniflare には「バンドル済みの 1 ファイル」しか渡せない**ので、esbuild で `ReservationLock` を束ねる。esbuild は `apps/api` の devDependency である `tsx` と `wrangler` の直接依存として既に入っており（0.28.2）、**新しいパッケージを足す必要はない**。エントリはファイルではなく `stdin.contents` の文字列にして、テスト専用のワーカーファイルをリポジトリに増やさない
3. **`Promise.all` で N 本を同時に投げ、成功した応答の数と D1 の実際の行数の両方を数える。** 応答だけを数えると「成功と答えたのに書けていない」を見逃す。両方が一致し、かつ `max_parallel` に等しいことを確かめる。さらに**ゲートを外した比較対象は作らない**——プロダクションコードに「ゲートの有無」を切り替えるフラグを足すのは本末転倒なので、代わりに `state.blockConcurrencyWhile` の**呼び出し回数**をスパイで縛る（ミューテーションテスト方針の分類 2）

**Files:**

- Create: `apps/api/src/test/build-worker.ts`
- Create: `apps/api/src/durable-objects/reservation-lock.concurrency.test.ts`
- Modify: `apps/api/vitest.config.ts`（このテストだけタイムアウトを延ばす）

**Interfaces:**

- Consumes: `readMigrationSql` / `toExecutableStatements`（`../db/testing/local-d1`）、`reservationLockName` / `RESERVATION_LOCK_ORIGIN` / `RESERVATION_LOCK_PATH` / `holdReservationResultSchema`（`./reservation-lock-protocol`）
- Produces:
  - `buildWorkerScript(options: { contents: string; resolveDir: string }): Promise<string>`

---

- [ ] **Step 1: esbuild が本当に入っていることを確かめる**

```bash
node -p "require('/Users/hattori/Downloads/alee/node_modules/esbuild/package.json').version"
```

期待: `0.28.2`（実測値）。**別のバージョンが出たら、この計画書の `conditions` 指定が効くかを再確認すること。** 出力が空なら `apps/api/package.json` の `devDependencies` に `"esbuild": "^0.28.2"` を足してからこのタスクを続ける。

- [ ] **Step 2: 失敗するテストを書く**

`apps/api/src/durable-objects/reservation-lock.concurrency.test.ts`:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationSql, toExecutableStatements } from '../db/testing/local-d1';
import { buildWorkerScript } from '../test/build-worker';
import {
  RESERVATION_LOCK_ORIGIN,
  RESERVATION_LOCK_PATH,
  holdReservationResultSchema,
  reservationLockName,
} from './reservation-lock-protocol';

/** wrangler.jsonc と同じ値。ずれると本番だけ挙動が変わる */
const COMPATIBILITY_DATE = '2026-09-01';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];
const LOCK_BINDING = 'RESERVATION_LOCK';

const SHOP_ID = 'shp_conc_0001';
const USER_ID = 'usr_conc_customer';
const TARGET_DATE = '2026-10-01';
/** 2026-10-01 18:00 JST */
const RESERVED_AT_MS = Date.parse('2026-10-01T09:00:00Z');
const START_MINUTE = 1080;

/** 席 4・同時受付 2 件。20 本同時に投げても通るのは 2 件だけになるはず */
const CAPACITY = 4;
const MAX_PARALLEL = 2;
const SLOT_MINUTES = 60;
const CONCURRENT_REQUESTS = 20;
/** 同じ条件を何回も繰り返す。1 回だけだと「たまたま直列になった」を掴めない */
const ROUNDS = 5;

/**
 * DO を叩くだけの最小のワーカー。ファイルにせず文字列で持つのは、
 * テスト専用の .ts をリポジトリに増やさないため。
 * ?lock= で DO の名前を、ボディで命令を渡す。
 */
const WORKER_SOURCE = `
export { ReservationLock } from './durable-objects/reservation-lock';

export default {
  async fetch(request, env) {
    const lockName = new URL(request.url).searchParams.get('lock');
    const id = env.${LOCK_BINDING}.idFromName(lockName);
    return env.${LOCK_BINDING}.get(id).fetch('${RESERVATION_LOCK_ORIGIN}${RESERVATION_LOCK_PATH}', {
      method: 'POST',
      body: await request.text(),
      headers: { 'content-type': 'application/json' },
    });
  },
};
`;

let miniflare: Miniflare;

beforeAll(async () => {
  const script = await buildWorkerScript({
    contents: WORKER_SOURCE,
    // stdin には自分のパスが無いので、import の起点を明示する
    resolveDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
  });
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: COMPATIBILITY_FLAGS,
      d1Databases: { DB: ':memory:' },
      durableObjects: { [LOCK_BINDING]: 'ReservationLock' },
    }),
  );
  const d1 = await miniflare.getD1Database('DB');
  await d1.exec(toExecutableStatements(readMigrationSql()).join('\n'));
}, 60_000);

afterAll(async () => {
  await miniflare.dispose();
});

/** 各ラウンドの前に予約を全消しして、店舗と席設定を作り直す */
async function resetWorld(): Promise<void> {
  const d1 = await miniflare.getD1Database('DB');
  await d1.exec(
    toExecutableStatements(`DELETE FROM reservations;
--> statement-breakpoint
DELETE FROM seat_settings;
--> statement-breakpoint
DELETE FROM shops;
--> statement-breakpoint
DELETE FROM user;
--> statement-breakpoint
DELETE FROM genres;
--> statement-breakpoint
DELETE FROM areas;
--> statement-breakpoint
INSERT INTO areas (id, name, prefecture) VALUES ('area_conc', 'テスト', '東京都');
--> statement-breakpoint
INSERT INTO genres (id, name, slug) VALUES ('gnr_conc', 'テスト', 'genre-conc');
--> statement-breakpoint
INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${USER_ID}', '客', 'conc@example.com', 1, 0, 0);
--> statement-breakpoint
INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash, owner_id, status) VALUES ('${SHOP_ID}', '同時実行テスト店', 'gnr_conc', 'area_conc', '東京都渋谷区', 35.658034, 139.701636, 'xn76fgr', '${USER_ID}', 'published');
--> statement-breakpoint
INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES ('${SHOP_ID}', ${CAPACITY}, ${SLOT_MINUTES}, ${MAX_PARALLEL}, 1);`).join(
      '\n',
    ),
  );
}

/** N 本を Promise.all で同時に投げ、成功数・拒否理由・D1 の行数を返す */
async function fireConcurrentHolds(count: number): Promise<{
  granted: number;
  reasons: readonly string[];
  rowCount: number;
}> {
  const lockName = reservationLockName(SHOP_ID, TARGET_DATE);
  const responses = await Promise.all(
    Array.from({ length: count }, (_unused, index) =>
      miniflare.dispatchFetch(`https://example.com/?lock=${encodeURIComponent(lockName)}`, {
        method: 'POST',
        body: JSON.stringify({
          reservationId: `rsv_conc_${index}`,
          shopId: SHOP_ID,
          userId: USER_ID,
          reservedAtMs: RESERVED_AT_MS,
          startMinute: START_MINUTE,
          partySize: 1,
          note: '',
        }),
      }),
    ),
  );
  const results = await Promise.all(
    responses.map(async (response) => holdReservationResultSchema.parse(await response.json())),
  );
  const d1 = await miniflare.getD1Database('DB');
  const row = await d1
    .prepare('SELECT COUNT(*) AS total FROM reservations WHERE shop_id = ? AND reserved_at = ?')
    .bind(SHOP_ID, RESERVED_AT_MS)
    .first<{ total: number }>();
  return {
    granted: results.filter((result) => result.isGranted).length,
    reasons: [...new Set(results.flatMap((result) => (result.isGranted ? [] : [result.reason])))],
    rowCount: row?.total ?? -1,
  };
}

describe('ReservationLock の同時実行', () => {
  it(`${CONCURRENT_REQUESTS} 本同時に投げても成立するのは max_parallel（${MAX_PARALLEL}）件だけ`, async () => {
    const outcomes: { granted: number; rowCount: number }[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetWorld();
      const outcome = await fireConcurrentHolds(CONCURRENT_REQUESTS);
      outcomes.push({ granted: outcome.granted, rowCount: outcome.rowCount });
      // 拒否理由が件数上限であることまで見る。席不足で落ちていたら条件設定が違う
      expect(outcome.reasons).toEqual(['parallel-full']);
    }
    // 全ラウンドで「成功数 = 行数 = max_parallel」。1 回でも崩れたら直列化が効いていない
    expect(outcomes).toEqual(
      Array.from({ length: ROUNDS }, () => ({ granted: MAX_PARALLEL, rowCount: MAX_PARALLEL })),
    );
  }, 120_000);

  it('席数を超える人数の同時申込は 1 件も通らない', async () => {
    await resetWorld();
    const lockName = reservationLockName(SHOP_ID, TARGET_DATE);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        miniflare.dispatchFetch(`https://example.com/?lock=${encodeURIComponent(lockName)}`, {
          method: 'POST',
          body: JSON.stringify({
            reservationId: `rsv_big_${index}`,
            shopId: SHOP_ID,
            userId: USER_ID,
            reservedAtMs: RESERVED_AT_MS,
            startMinute: START_MINUTE,
            // capacity 4 を超える 5 名
            partySize: 5,
            note: '',
          }),
        }),
      ),
    );
    const results = await Promise.all(
      responses.map(async (response) => holdReservationResultSchema.parse(await response.json())),
    );
    expect(results.every((result) => !result.isGranted)).toBe(true);
    const reasons = results.map((result) => (result.isGranted ? 'granted' : result.reason));
    expect(new Set(reasons)).toEqual(new Set(['party-too-large']));
  }, 60_000);

  it('別の日付は別の DO になるので互いをブロックしない', async () => {
    await resetWorld();
    const lockA = reservationLockName(SHOP_ID, '2026-10-01');
    const lockB = reservationLockName(SHOP_ID, '2026-10-02');
    expect(lockA).not.toBe(lockB);
    const [resultA, resultB] = await Promise.all(
      [
        { lock: lockA, reservedAtMs: RESERVED_AT_MS, id: 'rsv_day_a' },
        { lock: lockB, reservedAtMs: Date.parse('2026-10-02T09:00:00Z'), id: 'rsv_day_b' },
      ].map(async (input) => {
        const response = await miniflare.dispatchFetch(
          `https://example.com/?lock=${encodeURIComponent(input.lock)}`,
          {
            method: 'POST',
            body: JSON.stringify({
              reservationId: input.id,
              shopId: SHOP_ID,
              userId: USER_ID,
              reservedAtMs: input.reservedAtMs,
              startMinute: START_MINUTE,
              partySize: 1,
              note: '',
            }),
          },
        );
        return holdReservationResultSchema.parse(await response.json());
      }),
    );
    // 別の枠なのでどちらも成立する
    expect(resultA?.isGranted).toBe(true);
    expect(resultB?.isGranted).toBe(true);
  }, 60_000);

  it('同じ名前から取った DO ID は安定している', async () => {
    const namespace = await miniflare.getDurableObjectNamespace(LOCK_BINDING);
    const name = reservationLockName(SHOP_ID, TARGET_DATE);
    expect(namespace.idFromName(name).toString()).toBe(namespace.idFromName(name).toString());
    expect(namespace.idFromName(name).toString()).not.toBe(
      namespace.idFromName(reservationLockName(SHOP_ID, '2026-10-02')).toString(),
    );
  }, 60_000);
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-lock.concurrency
```

期待: `Failed to resolve import "../test/build-worker"` で FAIL。

- [ ] **Step 4: バンドルのヘルパーを書く**

`apps/api/src/test/build-worker.ts`:

```ts
// Durable Object を miniflare に渡すためのバンドラ。
//
// miniflare の `script` は「1 ファイルに束ねた JS」しか受け取れない。
// TypeScript の DO をテストから起動するには、まずここで束ねる必要がある。
// esbuild は tsx と wrangler の直接依存として既に入っているので追加インストールは不要。

import { build } from 'esbuild';

export type BuildWorkerOptions = {
  /** エントリのソース（ファイルではなく文字列で渡す） */
  readonly contents: string;
  /** contents の中の相対 import を解決する起点ディレクトリ */
  readonly resolveDir: string;
};

/**
 * workerd の解決条件で束ねる。
 * conditions を省略すると drizzle-orm が Node 版に解決され、
 * miniflare の中で `node:` の import が落ちる。
 */
export async function buildWorkerScript(options: BuildWorkerOptions): Promise<string> {
  const result = await build({
    stdin: { contents: options.contents, resolveDir: options.resolveDir, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error('esbuild がワーカーのバンドルを 1 つも出力しませんでした');
  }
  return output.text;
}
```

`apps/api/vitest.config.ts` の `test` に、このテストが miniflare の起動を待てるようタイムアウトを持たせる。**個々の `it` には既に第 3 引数でタイムアウトを書いてあるので、ここで延ばすのは `hookTimeout`（`beforeAll` のバンドル + 起動）だけでよい:**

```ts
    // Durable Object のテストは beforeAll で esbuild と workerd を起こすので長い
    hookTimeout: 60_000,
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-lock.concurrency
```

期待: 4 本すべて PASS。1 本目が `granted: 20` のような値で落ちる場合、`blockConcurrencyWhile` が効いていない。`reservation-lock.ts` の `#hold` 全体がゲートの中にあるかを見る。

**所要時間を測っておく**（Task 7-17 の Stryker 設定で使う）:

```bash
time npx vitest run --silent --no-file-parallelism reservation-lock.concurrency
```

出力の `real` を控えておくこと。

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

**これがこのタスクの本体。** `reservation-lock.ts` の臨界区間を外す:

```ts
const result = await this.#hold(parsed.data);
```

（`this.#state.blockConcurrencyWhile(() => ...)` の包みを外す）

```bash
npm test -w @meshimap/api -- reservation-lock.concurrency
```

期待: 1 本目が **FAIL** し、`granted` と `rowCount` が `2` ではない値（実測では 3〜20 の幅で揺れる）になる。差分の出力に `{ granted: 17, rowCount: 17 }` のような行が並ぶ。

**1 回で落ちなかったら 3 回繰り返して走らせること。** 実測では 20 本同時 × 10 回のうち 6 回は「たまたま 1 件」で正しく見えた。このテストが確率的であることを理解しないまま「落ちないからゲートは要らない」と判断してはならない。3 回走らせても落ちない場合は `ROUNDS` を 10 に増やす。

確認したらゲートを元に戻し、もう一度 PASS することを確かめる。

- [ ] **Step 7: コミット**

```bash
git add apps/api/src/test/build-worker.ts apps/api/src/durable-objects/reservation-lock.concurrency.test.ts apps/api/vitest.config.ts
git commit -m "test(api): Durable Object の同時実行を miniflare で実測するテストを足す"
```

---

## Task 7-8: `POST /reservations`（DO を経由した予約申込）

利用者の申込を受け、**Durable Object を通してだけ** `reservations` に書く。ルートから直接 INSERT する経路を作らない。作った瞬間に Task 7-7 の保証が無意味になる。

**ルートと DO の責務分担:**

| やること                           | どこで | なぜ                                             |
| ---------------------------------- | ------ | ------------------------------------------------ |
| 認証（401）                        | ルート | Actor はブランド型なので JSON をまたげない       |
| 入力の形（422）                    | ルート | 壊れた入力で DO を起こす意味がない               |
| 店舗が見えるか（404）              | ルート | `findVisibleShop` は Viewer を要る               |
| 申し込める日時か（422）            | ルート | 営業時間・休業日・過去日は席の数と無関係に決まる |
| 席と件数の空き（409 ではなく 422） | **DO** | ここだけが競合する。直列化が要る                 |
| `reservations` への INSERT         | **DO** | 判定と書き込みを離すと隙間ができる               |

**予約 ID はルート側で採番して DO に渡す。** DO 側で採番すると、DO が「成功したが応答が届かなかった」ときに呼び出し側が ID を知る手段が無くなる。ルートが採番しておけば、再送しても同じ ID で主キー衝突になり、二重作成にならない。

**Files:**

- Modify: `apps/api/src/lib/parse-id.ts`（Phase 4 が `parseShopId` / `parseReviewId` / `generateShopId` / `generateReviewId` を置いている。**同じファイル・同じ `generate*` 命名に揃える。** 実ファイルを開いて確認済み）
- Create: `apps/api/src/services/reservation-create-service.ts`
- Create: `apps/api/src/routes/reservations.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 の突合テスト。Task 7-5 で入れた 2 つの配列に 1 行ずつ足す）
- Test: `apps/api/src/lib/parse-id.test.ts`（**新規**。Phase 4 は `parse-id.ts` のテストを置いていないことを `ls apps/api/src/lib` で確認済み）
- Test: `apps/api/src/services/reservation-create-service.test.ts`
- Test: `apps/api/src/routes/reservations.create.test.ts`

**Interfaces:**

- Consumes: `findSlotContext`（Task 7-4）、`ReservationLock` / `holdReservationCommandSchema` / `holdReservationResultSchema` / `reservationLockName` / `RESERVATION_LOCK_ORIGIN` / `RESERVATION_LOCK_PATH` / `ReservationLockNamespace`（Task 7-6）、`generateSlots` / `toJstInstant` / `toJstClock` / `addJstDays` / `reservationCreateSchema` / `toShopId` / `toJstDate` / `toMinuteOfDay` / `toReservationId`（`@meshimap/core`）、`requireActor`（`../middleware/role-guard`）、`invalidInput` / `notFound`（`../lib/http-error`）
- Produces:
  - `generateReservationId(): ReservationId` / `generateNotificationId(): string`（`../lib/parse-id`）
  - `RESERVATION_ADVANCE_DAYS_MAX = 60` / `RESERVATION_LEAD_MINUTES_MIN = 30`（`../lib/constants`）
  - `type CreateReservationInput = { readonly shopId: ShopId; readonly date: JstDate; readonly startMinute: MinuteOfDay; readonly partySize: number; readonly note: string }`
  - `type CreateReservationOutcome = { readonly kind: 'created'; readonly reservationId: ReservationId; readonly reservedAt: Date } | { readonly kind: 'shop-not-found' } | { readonly kind: 'slot-unavailable'; readonly reason: string }`
  - `createReservation(db: Database, lock: ReservationLockNamespace, actor: Actor, input: CreateReservationInput, now: Date): Promise<CreateReservationOutcome>`

---

- [ ] **Step 1: ID 採番の失敗するテストを書く**

`apps/api/src/lib/parse-id.test.ts`:

```ts
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN } from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import { generateNotificationId, generateReservationId } from './parse-id';

describe('generateReservationId', () => {
  it('rsv_ で始まる', () => {
    expect(generateReservationId()).toMatch(/^rsv_/);
  });

  it('ck_reservations_id_length に収まる', () => {
    expect(generateReservationId().length).toBeLessThanOrEqual(IDENTIFIER_MAX_LENGTH);
  });

  it('identifier の文字種に収まる', () => {
    expect(IDENTIFIER_PATTERN.test(generateReservationId())).toBe(true);
  });

  it('呼ぶたびに違う値になる', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateReservationId()));
    expect(ids.size).toBe(1000);
  });
});

describe('generateNotificationId', () => {
  it('ntf_ で始まり、文字種と長さに収まる', () => {
    const id = generateNotificationId();
    expect(id).toMatch(/^ntf_/);
    expect(id.length).toBeLessThanOrEqual(IDENTIFIER_MAX_LENGTH);
    expect(IDENTIFIER_PATTERN.test(id)).toBe(true);
  });

  it('予約 ID と混ざらない', () => {
    expect(generateNotificationId().startsWith('rsv_')).toBe(false);
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- lib/parse-id
```

期待: `TypeError: generateReservationId is not a function` で FAIL。**`parse-id.ts` 自体は Phase 4 が作成済み**（`parseShopId` / `parseReviewId` / `generateShopId` / `generateReviewId` が入っている）なので、モジュールの解決には成功し、無いのは関数だけである。`npm run typecheck -w @meshimap/api` でも「`'./parse-id'` に `generateReservationId` は無い」と出ることを併せて確認する。

- [ ] **Step 3: ID 採番を書く**

`apps/api/src/lib/parse-id.ts` の末尾に足す（**既存の `generateShopId` / `generateReviewId` と同じ書き方に揃える**）:

```ts
// 新しい行の ID を作る。ここが API 側の唯一の採番点。
//
// crypto.randomUUID() を使う理由:
// Workers のランタイムにも Node 22 にも標準で入っており、依存を増やさずに済む。
// 出力は 36 文字で、ハイフンは IDENTIFIER_PATTERN（[A-Za-z0-9_-]）に含まれるため
// そのまま識別子として使える。接頭辞 4 文字を足しても 40 文字で、
// IDENTIFIER_MAX_LENGTH（64）にも ck_*_id_length にも収まる。

// 既存の import 行に足す:
//   import { toReservationId, toReviewId, toShopId } from '@meshimap/core';
//   import type { ReservationId, ReviewId, ShopId } from '@meshimap/core';

/** 予約行の接頭辞。ログを見たときに何の ID か分かるようにする */
const RESERVATION_ID_PREFIX = 'rsv_';
/** 通知行の接頭辞 */
const NOTIFICATION_ID_PREFIX = 'ntf_';

export function generateReservationId(): ReservationId {
  return toReservationId(`${RESERVATION_ID_PREFIX}${crypto.randomUUID()}`);
}

/** 通知 ID にはブランド型が無い（@meshimap/core に NotificationId は無い）ので string で返す */
export function generateNotificationId(): string {
  return `${NOTIFICATION_ID_PREFIX}${crypto.randomUUID()}`;
}
```

`apps/api/src/lib/constants.ts` に 2 つ足す:

```ts
/**
 * 予約を受け付ける先の上限（日数）。
 * 無制限にすると「1 年先の枠」を押さえられてしまい、席の在庫が凍る。
 * 個人店の運用として 2 か月先までを上限にする。
 */
export const RESERVATION_ADVANCE_DAYS_MAX = 60;

/**
 * 来店時刻までに最低限必要な猶予（分）。
 * 直前の申込は店が承認できないまま来店時刻を過ぎるので受け付けない。
 */
export const RESERVATION_LEAD_MINUTES_MIN = 30;
```

- [ ] **Step 4: ID 採番のテストが通ることを確認する**

```bash
npm test -w @meshimap/api -- lib/parse-id
```

期待: 6 本すべて PASS。

- [ ] **Step 5: 申込サービスの失敗するテストを書く**

`apps/api/src/services/reservation-create-service.test.ts`:

`Miniflare` を直接起こさず、`ReservationLockNamespace`（Task 7-6 でプロトコルに置いた狭い型）を満たす小さな偽物を渡す。**DO の中身の正しさは Task 7-7 が本物の workerd で測っており、ここで測りたいのは「ルート側の門番が正しく効くか」と「DO の応答をどう解釈するか」だけである。** 両方を 1 つのテストでやると、落ちたときにどちらが壊れたのか分からなくなる。

```ts
import { toJstDate, toMinuteOfDay, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import {
  holdReservationCommandSchema,
  type ReservationLockNamespace,
} from '../durable-objects/reservation-lock-protocol';
import {
  buildActorForTest,
  createTestWorld,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import { createReservation } from './reservation-create-service';

let world: TestWorld;

const SHOP_ID = toShopId('shp_create_0001');
const DRAFT_SHOP_ID = toShopId('shp_create_0002');
const CUSTOMER_ID = 'usr_create_customer';
const OWNER_ID = 'usr_create_owner';
/** 2026-10-01 は木曜（dayOfWeek = 4）。営業は 18:00-21:00 */
const TARGET_DATE = toJstDate('2026-10-01');
/** 申込の「いま」。2026-09-20 12:00 JST 固定 */
const NOW = new Date(Date.parse('2026-09-20T03:00:00Z'));

/**
 * DurableObjectId は interface なので、テスト側でも完全に実装できる
 * （`index.d.ts:642` の 4 メンバ。`jurisdiction` は optional なので省ける）。
 * `as` を使わずに済むのはこれが interface だからで、Namespace が abstract class
 * であるのとは事情が違う。
 */
function fakeLockId(name: string): DurableObjectId {
  return { toString: () => name, equals: (other) => other.toString() === name, name };
}

/** stub.fetch に渡った命令を記録しつつ、決めた応答を返す偽の namespace */
function createFakeLock(response: unknown): {
  namespace: ReservationLockNamespace;
  names: string[];
  commands: unknown[];
} {
  const names: string[] = [];
  const commands: unknown[] = [];
  // 型注釈を付けておくと、本番の受け口を広げたときにここが先に赤くなる
  const namespace: ReservationLockNamespace = {
    idFromName(name: string) {
      names.push(name);
      return fakeLockId(name);
    },
    get() {
      return {
        async fetch(_input: string, init: RequestInit) {
          commands.push(holdReservationCommandSchema.parse(JSON.parse(String(init.body))));
          return Response.json(response);
        },
      };
    },
  };
  return { namespace, names, commands };
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: CUSTOMER_ID, role: 'user' });
  await seedUser(world, { userId: OWNER_ID, role: 'owner' });

  await seedShop(world, {
    id: SHOP_ID,
    name: '申込テスト店',
    ownerId: OWNER_ID,
    status: 'published',
  });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    4,
    60,
    2,
    1,
  );
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_create_thu',
    SHOP_ID,
    4,
    1080,
    1260,
    0,
  );

  await seedShop(world, {
    id: DRAFT_SHOP_ID,
    name: '下書き店',
    ownerId: OWNER_ID,
    status: 'draft',
  });
});

afterAll(async () => {
  await world.dispose();
});

const BASE_INPUT = {
  shopId: SHOP_ID,
  date: TARGET_DATE,
  startMinute: toMinuteOfDay(1080),
  partySize: 2,
  note: '窓際希望',
};

describe('createReservation', () => {
  it('DO が許可したら created を返す', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      NOW,
    );
    expect(outcome.kind).toBe('created');
  });

  it('DO には店舗 ID と日付から作った名前で入る', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      NOW,
    );
    expect(lock.names).toEqual([`${SHOP_ID}:2026-10-01`]);
  });

  it('DO には 18:00 JST を指すエポックミリ秒が渡る', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      NOW,
    );
    expect(lock.commands).toEqual([
      {
        reservationId: expect.stringMatching(/^rsv_/),
        shopId: SHOP_ID,
        userId: CUSTOMER_ID,
        reservedAtMs: Date.parse('2026-10-01T09:00:00Z'),
        startMinute: 1080,
        partySize: 2,
        note: '窓際希望',
      },
    ]);
  });

  it('返す reservationId は DO の応答ではなくルート側で採番したもの', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_from_do' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      NOW,
    );
    // 採番はルート側が持つ。DO の応答をそのまま信じない
    expect(outcome.kind === 'created' && outcome.reservationId).not.toBe('rsv_from_do');
    expect(outcome.kind === 'created' && lock.commands[0]).toMatchObject({
      reservationId: outcome.kind === 'created' ? outcome.reservationId : '',
    });
  });

  it('DO が拒否したら理由をそのまま返す', async () => {
    const lock = createFakeLock({ isGranted: false, reason: 'parallel-full' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      NOW,
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'parallel-full' });
  });

  it('見えない店舗は DO を起こさずに shop-not-found', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      { ...BASE_INPUT, shopId: DRAFT_SHOP_ID },
      NOW,
    );
    expect(outcome).toEqual({ kind: 'shop-not-found' });
    expect(lock.names).toEqual([]);
  });

  it('営業時間に無い枠は DO を起こさずに弾く', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      // 15:00 は営業時間（18:00-21:00）の外
      { ...BASE_INPUT, startMinute: toMinuteOfDay(900) },
      NOW,
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'no-such-slot' });
    expect(lock.names).toEqual([]);
  });

  it('枠の途中（18:30）も弾く', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      { ...BASE_INPUT, startMinute: toMinuteOfDay(1110) },
      NOW,
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'no-such-slot' });
  });

  it('過去の日付は弾く', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      // 来店時刻（2026-10-01 18:00 JST）より後を「いま」にする
      new Date(Date.parse('2026-10-02T03:00:00Z')),
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'too-late' });
    expect(lock.names).toEqual([]);
  });

  it('来店 30 分前を切っていたら弾く', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      // 2026-10-01 17:40 JST。来店まで 20 分しかない
      new Date(Date.parse('2026-10-01T08:40:00Z')),
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'too-late' });
  });

  it('来店 30 分前ちょうどは受け付ける', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      // 2026-10-01 17:30 JST ちょうど
      new Date(Date.parse('2026-10-01T08:30:00Z')),
    );
    expect(outcome.kind).toBe('created');
  });

  it('60 日より先は弾く', async () => {
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      BASE_INPUT,
      // 2026-07-01 → 10-01 は 92 日先
      new Date(Date.parse('2026-06-30T15:00:00Z')),
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'too-far' });
  });

  it('臨時休業日は弾く', async () => {
    await runWrite(
      world,
      'INSERT INTO shop_closures (id, shop_id, date, reason) VALUES (?, ?, ?, ?)',
      'scl_create_1',
      SHOP_ID,
      '2026-10-08',
      '棚卸し',
    );
    const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
    const outcome = await createReservation(
      createDatabase(world.d1),
      lock.namespace,
      CUSTOMER_ACTOR,
      { ...BASE_INPUT, date: toJstDate('2026-10-08') },
      NOW,
    );
    expect(outcome).toEqual({ kind: 'slot-unavailable', reason: 'closed' });
    expect(lock.names).toEqual([]);
  });

  it('DO の応答が壊れていたら例外にする', async () => {
    const lock = createFakeLock({ isGranted: 'yes' });
    await expect(
      createReservation(createDatabase(world.d1), lock.namespace, CUSTOMER_ACTOR, BASE_INPUT, NOW),
    ).rejects.toThrow();
  });

  it('owner でも admin でも申し込める（客として）', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const lock = createFakeLock({ isGranted: true, reservationId: 'rsv_ignored' });
      const outcome = await createReservation(
        createDatabase(world.d1),
        lock.namespace,
        buildActorForTest(OWNER_ID, role),
        BASE_INPUT,
        NOW,
      );
      expect(outcome.kind).toBe('created');
    }
  });
});
```

- [ ] **Step 6: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-create-service
```

期待: `Failed to resolve import "./reservation-create-service"` で FAIL。

- [ ] **Step 7: 申込サービスを書く**

`apps/api/src/services/reservation-create-service.ts`:

```ts
// 予約申込の門番。席の空きだけは自分で判定せず Durable Object に委ねる。
//
// ここで先に落とすのは「席の数と無関係に決まること」だけ:
//   店舗が見えない / 営業時間に無い枠 / 臨時休業 / 過去 / 直前すぎ / 先すぎ
// これらを DO の中でやると、混雑していない店でも全部の申込が 1 本の DO に直列化される。

import { addJstDays, generateSlots, toJstDate, toJstInstant } from '@meshimap/core';
import type { JstDate, MinuteOfDay, ReservationId, ShopId } from '@meshimap/core';
import type { Actor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  RESERVATION_LOCK_ORIGIN,
  RESERVATION_LOCK_PATH,
  holdReservationResultSchema,
  reservationLockName,
  type ReservationLockNamespace,
} from '../durable-objects/reservation-lock-protocol';
import { RESERVATION_ADVANCE_DAYS_MAX, RESERVATION_LEAD_MINUTES_MIN } from '../lib/constants';
import { generateReservationId } from '../lib/parse-id';
import { findSlotContext } from '../repositories/reservation-slot-repository';

export type CreateReservationInput = {
  readonly shopId: ShopId;
  readonly date: JstDate;
  readonly startMinute: MinuteOfDay;
  readonly partySize: number;
  readonly note: string;
};

export type CreateReservationOutcome =
  | { readonly kind: 'created'; readonly reservationId: ReservationId; readonly reservedAt: Date }
  | { readonly kind: 'shop-not-found' }
  | { readonly kind: 'slot-unavailable'; readonly reason: string };

/** ミリ秒 → 分。直前判定にだけ使う */
const MILLISECONDS_PER_MINUTE_LOCAL = 60_000;

function unavailable(reason: string): CreateReservationOutcome {
  return { kind: 'slot-unavailable', reason };
}

export async function createReservation(
  db: Database,
  lock: ReservationLockNamespace,
  actor: Actor,
  input: CreateReservationInput,
  now: Date,
): Promise<CreateReservationOutcome> {
  const context = await findSlotContext(db, actor, input.shopId, input.date);
  if (context === null) {
    return { kind: 'shop-not-found' };
  }
  if (context.seatSettings === null) {
    return unavailable('not-accepting');
  }
  if (context.isClosedOnDate) {
    return unavailable('closed');
  }

  // 受付の窓（先すぎ / 直前すぎ）。日付だけでなく来店時刻そのもので判定する
  const reservedAt = toJstInstant(input.date, input.startMinute);
  const leadMinutes = (reservedAt.getTime() - now.getTime()) / MILLISECONDS_PER_MINUTE_LOCAL;
  if (leadMinutes < RESERVATION_LEAD_MINUTES_MIN) {
    return unavailable('too-late');
  }
  const horizonDate = addJstDays(toJstDate(now), RESERVATION_ADVANCE_DAYS_MAX);
  if (input.date > horizonDate) {
    // JstDate は YYYY-MM-DD 固定長なので、辞書順の比較が日付の比較と一致する
    return unavailable('too-far');
  }

  // 申し込まれた開始時刻が、その日に実在する枠の先頭と一致するか。
  // 18:30 のような「枠の途中」をここで弾かないと、同じ時間帯が
  // 別々の DO キーに散って canReserve の集計が合わなくなる
  const slots = generateSlots(context.hours, context.seatSettings, input.date);
  const slot = slots.find((candidate) => candidate.startMinute === input.startMinute);
  if (slot === undefined) {
    return unavailable('no-such-slot');
  }

  const reservationId = generateReservationId();
  const stub = lock.get(lock.idFromName(reservationLockName(input.shopId, input.date)));
  const response = await stub.fetch(`${RESERVATION_LOCK_ORIGIN}${RESERVATION_LOCK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reservationId,
      shopId: input.shopId,
      userId: actor.userId,
      reservedAtMs: reservedAt.getTime(),
      startMinute: input.startMinute,
      partySize: input.partySize,
      note: input.note,
    }),
  });

  // DO の応答も外部入力として扱う。parse が落ちれば errorHandler が 500 にする
  const result = holdReservationResultSchema.parse(await response.json());
  if (!result.isGranted) {
    return unavailable(result.reason);
  }
  // 採番はこちらが持っているので、DO の返した ID は使わない
  return { kind: 'created', reservationId, reservedAt };
}
```

- [ ] **Step 8: 申込サービスのテストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-create-service
```

期待: 15 本すべて PASS。

- [ ] **Step 9: ルートの失敗するテストを書く**

`apps/api/src/routes/reservations.create.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../index';
import {
  countRows,
  createTestBindings,
  createTestWorld,
  runWrite,
  seedMasters,
  seedShop,
  signUpAs,
  type TestUser,
  type TestWorld,
} from '../test/fixtures';

let world: TestWorld;
let customer: TestUser;

const SHOP_ID = 'shp_post_0001';
/** 2026-10-01 は木曜。営業 18:00-21:00 */
const VALID_BODY = {
  shopId: SHOP_ID,
  date: '2026-10-01',
  startMinute: 1080,
  partySize: 2,
  note: '窓際希望',
};

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  customer = await signUpAs(world, 'post@example.com', 'user');
  await seedShop(world, { id: SHOP_ID, ownerId: null, name: '申込ルート店', status: 'published' });
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    SHOP_ID,
    4,
    60,
    2,
    1,
  );
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_post_thu',
    SHOP_ID,
    4,
    1080,
    1260,
    0,
  );
});

afterAll(async () => {
  await world.dispose();
});

function post(body: unknown, cookie?: string): Promise<Response> {
  return app.request(
    '/reservations',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    createTestBindings(world),
  );
}

describe('POST /reservations', () => {
  it('未ログインは 401', async () => {
    expect((await post(VALID_BODY)).status).toBe(401);
  });

  it('未ログインでは 1 行も増えない', async () => {
    const before = await countRows(world, 'SELECT COUNT(*) AS count FROM reservations');
    await post(VALID_BODY);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM reservations')).toBe(before);
  });

  it('ボディが JSON でなければ 422', async () => {
    const response = await app.request(
      '/reservations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: customer.cookie },
        body: 'not json',
      },
      createTestBindings(world),
    );
    expect(response.status).toBe(422);
  });

  it('人数が 0 なら 422', async () => {
    expect((await post({ ...VALID_BODY, partySize: 0 }, customer.cookie)).status).toBe(422);
  });

  it('startMinute が無ければ 422', async () => {
    const { startMinute: _unused, ...rest } = VALID_BODY;
    expect((await post(rest, customer.cookie)).status).toBe(422);
  });

  it('存在しない店舗なら 404', async () => {
    expect((await post({ ...VALID_BODY, shopId: 'shp_nope' }, customer.cookie)).status).toBe(404);
  });
});
```

**このルートのテストは 6 本しか無い。** 成功系（201）は `RESERVATION_LOCK` のバインディングが要り、`createTestBindings` は D1 しか用意していないためここでは書けない。**成功系は Task 7-17 の結合テストで miniflare 込みで確かめる。** ここで「一応 201 を返すモック」を作ると、DO を経由していない偽の成功を通してしまう。

- [ ] **Step 10: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservations.create
```

期待: `Failed to resolve import "../index"`（`app` に `/reservations` が無い）または 404 で FAIL。

- [ ] **Step 11: ルートを書く**

`apps/api/src/routes/reservations.ts`:

```ts
// 利用者側の予約エンドポイント。この Task では POST だけを置き、
// 一覧・詳細・キャンセルは Task 7-10 が同じファイルに足す。

import { reservationCreateSchema, toJstDate, toMinuteOfDay, toShopId } from '@meshimap/core';
import { Hono } from 'hono';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { invalidInput, notFound } from '../lib/http-error';
import { requireActor } from '../middleware/role-guard';
import { createReservation } from '../services/reservation-create-service';

/** 作成したときの HTTP ステータス */
const CREATED_STATUS = 201;

export const reservationRoutes = new Hono<AppEnv>().post('/', async (c) => {
  const actor = requireActor(c);
  // JSON として壊れている場合も「入力が正しくない」に寄せる
  const raw = await c.req.json().catch(() => null);
  const parsed = reservationCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidInput();
  }

  const outcome = await createReservation(
    createDatabase(c.env.DB),
    c.env.RESERVATION_LOCK,
    actor,
    {
      shopId: toShopId(parsed.data.shopId),
      date: toJstDate(parsed.data.date),
      startMinute: toMinuteOfDay(parsed.data.startMinute),
      partySize: parsed.data.partySize,
      note: parsed.data.note,
    },
    new Date(),
  );

  switch (outcome.kind) {
    case 'shop-not-found':
      throw notFound();
    case 'slot-unavailable':
      // 「その枠はもう取れない」は入力が現状と噛み合っていないということ。
      // 理由コードは応答に含めない（他人の予約の埋まり具合が読めてしまうため）。
      // 利用者は GET /reservation-slots を引き直せば最新の空きが分かる
      throw invalidInput();
    case 'created':
      return c.json(
        { reservationId: outcome.reservationId, reservedAt: outcome.reservedAt.toISOString() },
        CREATED_STATUS,
      );
  }
});
```

`apps/api/src/index.ts` にマウントする:

```ts
import { reservationRoutes } from './routes/reservations';

  .route('/reservations', reservationRoutes)
```

**同じコミットで `apps/api/src/routes/permission-matrix.test.ts` の 2 つの配列に 1 行ずつ足す。** Task 7-5 で仕組みは入れてあるので、ここは行の追加だけである。足さないと次のメッセージで落ちる:

```
FAIL  ルート表と実装の突合 > app に登録されたエンドポイントは 11 本で、想定どおりの並びである
  - Expected  11 items
  + Received  12 items
FAIL  ルート表と実装の突合 > 権限マトリクスは app のエンドポイントを 1 本残らず覆っている
  - Expected  []
  + Received  [ '権限マトリクスに無いエンドポイント: POST /reservations' ]
```

`EXPECTED_ROUTE_PATTERNS` は `'PATCH /shops/:shopId'` と `'POST /shops'` の間に入る（`'POST /reservations'` の `r` は `'POST /shops'` の `s` より小さい）:

```ts
/** 権限マトリクスが責任を持つ 12 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /reservation-slots',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /shops/:shopId',
  'POST /reservations',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];
```

委譲リストも 2 本になる:

```ts
const DELEGATED_ROUTE_PATTERNS: readonly string[] = [
  'GET /reservation-slots',
  'POST /reservations',
];
```

- [ ] **Step 12: ルートのテストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservations.create permission-matrix
npm run typecheck -w @meshimap/api
```

期待: 6 本 PASS、型エラー 0。`permission-matrix.test.ts` も全件 PASS。

- [ ] **Step 13: わざと壊してテストが落ちることを確認する**

(a) `createReservation` の「枠が実在するか」の判定を消す（`slot === undefined` の分岐を削る）:

→ 「営業時間に無い枠は DO を起こさずに弾く」と「枠の途中（18:30）も弾く」が FAIL。

(b) `leadMinutes < RESERVATION_LEAD_MINUTES_MIN` を `<=` に変える:

→ 「来店 30 分前ちょうどは受け付ける」が FAIL（`slot-unavailable` が返る）。**境界のテストが効いていることの確認。**

(c) `return { kind: 'created', reservationId, reservedAt }` の `reservationId` を `result.reservationId` に変える:

→ 「返す reservationId は DO の応答ではなくルート側で採番したもの」が FAIL。

(d) ルートの `requireActor(c)` を `c.get('viewer')` に変える:

→ 「未ログインは 401」が FAIL。加えて型エラーになる（`AnonymousActor` は `Actor` に代入できない）ことも確認する。**型で止まるなら、それがこの設計の意図どおり。**

(e) `permission-matrix.test.ts` の `DELEGATED_ROUTE_PATTERNS` から `'POST /reservations'` の 1 行だけを消す:

→ 「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」と「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」が FAIL。**1 本の消し忘れが確かに見つかる**ことの確認。

5 つとも確認したら元に戻す。

- [ ] **Step 14: コミット**

```bash
git add apps/api/src/lib/parse-id.ts apps/api/src/lib/parse-id.test.ts apps/api/src/lib/constants.ts apps/api/src/services/reservation-create-service.ts apps/api/src/services/reservation-create-service.test.ts apps/api/src/routes/reservations.ts apps/api/src/routes/reservations.create.test.ts apps/api/src/routes/permission-matrix.test.ts apps/api/src/index.ts
git commit -m "feat(api): Durable Object 経由の POST /reservations を足す"
```

---

## Task 7-9: 予約リポジトリ（利用者側）

自分の予約だけを読む / 自分の予約だけを取り消す。**所有権はすべて `WHERE` 句で表す。** ハンドラやサービスに `if (row.userId !== actor.userId)` を書かない。書いた瞬間、リポジトリ単体で見たときに「誰でも読める関数」になってしまう。

**「0 行 → `null`」で 404 と 403 を同じ応答に潰す。** 他人の予約 ID を投げたときに 403 が返ると、その ID が実在することが漏れる。

**キャンセルの `WHERE` に状態も入れる理由:** `WHERE ... AND status IN ('pending', 'confirmed')` を付けておくと、「既にキャンセル済みの予約をもう一度キャンセルする」が 0 行更新になり、Task 7-3 のトリガーに到達する前に止まる。トリガーは**すり抜けたときの最後の壁**であって、日常的に踏むものではない。

**`inArray` に空配列を渡しても安全**（`node_modules/drizzle-orm/sql/expressions/conditions.js:73-81` を実際に開いて確認）:

```js
function inArray(column, values) {
  if (Array.isArray(values)) {
    if (values.length === 0) {
      return sql`false`;
    }
```

`allowedPreviousStatuses(to, by)` が `[]` を返す組み合わせ（例: owner が `cancelled` へ動かそうとする）でも例外にならず、`WHERE false` で 0 行になる。**この性質に乗るので、呼び出し側で空配列を特別扱いしない。**

**Files:**

- Create: `apps/api/src/repositories/reservation-repository.ts`
- Test: `apps/api/src/repositories/reservation-repository.test.ts`

**Interfaces:**

- Consumes: `Database`（`../db/client`）、`Actor`（`../auth/actor`）、`reservations` / `shops`（`../db/schema`）、`RESERVATION_STATUS_CANCELLED` / `RESERVATION_STATUSES_OCCUPYING_SEAT`（`../db/constants`）、`allowedPreviousStatuses` / `ROLE_USER` / `toReservationId` / `toShopId`（`@meshimap/core`）
- Produces:
  - `type ReservationRow = { readonly id: ReservationId; readonly shopId: ShopId; readonly shopName: string; readonly reservedAt: Date; readonly partySize: number; readonly note: string; readonly status: ReservationStatus; readonly createdAt: Date }`
  - `type ReservationScope = 'upcoming' | 'past'`
  - `listMyReservations(db: Database, actor: Actor, scope: ReservationScope, now: Date): Promise<readonly ReservationRow[]>`
  - `findMyReservation(db: Database, actor: Actor, reservationId: ReservationId): Promise<ReservationRow | null>`
  - `cancelMyReservation(db: Database, actor: Actor, reservationId: ReservationId): Promise<boolean>`

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/reservation-repository.test.ts`:

```ts
import { toReservationId, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import {
  buildActorForTest,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import {
  cancelMyReservation,
  findMyReservation,
  listMyReservations,
} from './reservation-repository';

let world: TestWorld;

const SHOP_ID = toShopId('shp_repo_0001');
const OTHER_SHOP_ID = toShopId('shp_repo_0002');
const ME = 'usr_repo_me';
const OTHER = 'usr_repo_other';
/** 「いま」は 2026-10-01 12:00 JST 固定 */
const NOW = new Date(Date.parse('2026-10-01T03:00:00Z'));

/** 予約を 1 件作り直す（各テストの前に呼ぶ） */
async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM reservations');
  const rows: readonly [string, string, string, number, string][] = [
    // 未来 + pending → upcoming
    ['rsv_repo_future_pending', SHOP_ID, ME, Date.parse('2026-10-02T09:00:00Z'), 'pending'],
    // 未来 + confirmed → upcoming
    ['rsv_repo_future_confirmed', SHOP_ID, ME, Date.parse('2026-10-03T09:00:00Z'), 'confirmed'],
    // 未来だが cancelled → past 扱い（もう来店しないため）
    ['rsv_repo_future_cancelled', SHOP_ID, ME, Date.parse('2026-10-04T09:00:00Z'), 'cancelled'],
    // 過去 + completed → past
    ['rsv_repo_past_completed', SHOP_ID, ME, Date.parse('2026-09-20T09:00:00Z'), 'completed'],
    // 過去 + confirmed（店が閉め忘れた）→ past
    ['rsv_repo_past_confirmed', SHOP_ID, ME, Date.parse('2026-09-25T09:00:00Z'), 'confirmed'],
    // 他人の予約
    ['rsv_repo_other', OTHER_SHOP_ID, OTHER, Date.parse('2026-10-02T09:00:00Z'), 'pending'],
  ];
  for (const [id, shopId, userId, reservedAt, status] of rows) {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      shopId,
      userId,
      reservedAt,
      2,
      'メモ',
      status,
    );
  }
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: ME, role: 'user' });
  await seedUser(world, { userId: OTHER, role: 'user' });
  await seedShop(world, {
    id: SHOP_ID,
    ownerId: null,
    name: '自分の予約の店',
    status: 'published',
  });
  await seedShop(world, {
    id: OTHER_SHOP_ID,
    ownerId: null,
    name: '他人の予約の店',
    status: 'published',
  });
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});

/** 100 桁に収めるためだけでなく、同じ Actor を使い回していることを読み手に見せる */
const ME_ACTOR = buildActorForTest(ME, 'user');

describe('listMyReservations', () => {
  it('upcoming は未来かつ席を占めている予約だけを近い順で返す', async () => {
    const rows = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'upcoming', NOW);
    expect(rows.map((row) => row.id)).toEqual([
      'rsv_repo_future_pending',
      'rsv_repo_future_confirmed',
    ]);
  });

  it('past は過去または終了した予約を新しい順で返す', async () => {
    const rows = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'past', NOW);
    expect(rows.map((row) => row.id)).toEqual([
      'rsv_repo_future_cancelled',
      'rsv_repo_past_confirmed',
      'rsv_repo_past_completed',
    ]);
  });

  it('他人の予約は一切返さない', async () => {
    const upcoming = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'upcoming', NOW);
    const past = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'past', NOW);
    for (const row of [...upcoming, ...past]) {
      expect(row.id).not.toBe('rsv_repo_other');
    }
  });

  it('店舗名を一緒に返す（画面がもう 1 回問い合わせなくて済むように）', async () => {
    const rows = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'upcoming', NOW);
    expect(rows[0]?.shopName).toBe('自分の予約の店');
  });

  it('予約が 1 件も無いユーザーには空配列を返す', async () => {
    const rows = await listMyReservations(
      createDatabase(world.d1),
      buildActorForTest('usr_repo_nobody', 'user'),
      'upcoming',
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it('reservedAt は Date で返る', async () => {
    const rows = await listMyReservations(createDatabase(world.d1), ME_ACTOR, 'upcoming', NOW);
    expect(rows[0]?.reservedAt).toBeInstanceOf(Date);
    expect(rows[0]?.reservedAt.getTime()).toBe(Date.parse('2026-10-02T09:00:00Z'));
  });
});

describe('findMyReservation', () => {
  it('自分の予約は取れる', async () => {
    const row = await findMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_future_pending'),
    );
    expect(row).toMatchObject({
      id: 'rsv_repo_future_pending',
      shopId: SHOP_ID,
      shopName: '自分の予約の店',
      partySize: 2,
      note: 'メモ',
      status: 'pending',
    });
  });

  it('他人の予約は null（404 と区別が付かない）', async () => {
    const row = await findMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_other'),
    );
    expect(row).toBeNull();
  });

  it('存在しない ID も null', async () => {
    const row = await findMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_nope'),
    );
    expect(row).toBeNull();
  });

  it('owner ロールでも「自分が客として取った予約」は取れる', async () => {
    const row = await findMyReservation(
      createDatabase(world.d1),
      buildActorForTest(ME, 'owner'),
      toReservationId('rsv_repo_future_pending'),
    );
    expect(row?.id).toBe('rsv_repo_future_pending');
  });
});

describe('cancelMyReservation', () => {
  it('pending の自分の予約は取り消せる', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_future_pending'),
    );
    expect(done).toBe(true);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_repo_future_pending',
    );
    expect(row?.status).toBe('cancelled');
  });

  it('confirmed の自分の予約も取り消せる', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_future_confirmed'),
    );
    expect(done).toBe(true);
  });

  it('既に cancelled なら false を返し、トリガーまで到達しない', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_future_cancelled'),
    );
    expect(done).toBe(false);
  });

  it('completed は取り消せない', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_past_completed'),
    );
    expect(done).toBe(false);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_repo_past_completed',
    );
    expect(row?.status).toBe('completed');
  });

  it('他人の予約は取り消せず、行も変わらない', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_other'),
    );
    expect(done).toBe(false);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_repo_other',
    );
    expect(row?.status).toBe('pending');
  });

  it('存在しない ID でも例外を投げず false', async () => {
    const done = await cancelMyReservation(
      createDatabase(world.d1),
      ME_ACTOR,
      toReservationId('rsv_repo_nope'),
    );
    expect(done).toBe(false);
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-repository
```

期待: `Failed to resolve import "./reservation-repository"` で FAIL。

- [ ] **Step 3: 最小の実装を書く**

`apps/api/src/repositories/reservation-repository.ts`:

```ts
// 利用者から見た予約。所有権は SQL の WHERE 句だけで表す。
// 呼び出し側に「この行はあなたのものか」を判断させない。

import { ROLE_USER, allowedPreviousStatuses, toReservationId, toShopId } from '@meshimap/core';
import type { ReservationId, ShopId } from '@meshimap/core';
import { and, asc, desc, eq, gte, inArray, lt, notInArray, or } from 'drizzle-orm';
import type { Actor } from '../auth/actor';
import type { Database } from '../db/client';
import { RESERVATION_STATUSES_OCCUPYING_SEAT, RESERVATION_STATUS_CANCELLED } from '../db/constants';
import type { ReservationStatus } from '../db/constants';
import { reservations, shops } from '../db/schema';

export type ReservationRow = {
  readonly id: ReservationId;
  readonly shopId: ShopId;
  readonly shopName: string;
  readonly reservedAt: Date;
  readonly partySize: number;
  readonly note: string;
  readonly status: ReservationStatus;
  readonly createdAt: Date;
};

export type ReservationScope = 'upcoming' | 'past';

/** 一覧と詳細で同じ列を返す。画面が形の違いを気にしなくて済む */
const RESERVATION_COLUMNS = {
  id: reservations.id,
  shopId: reservations.shopId,
  shopName: shops.name,
  reservedAt: reservations.reservedAt,
  partySize: reservations.partySize,
  note: reservations.note,
  status: reservations.status,
  createdAt: reservations.createdAt,
};

/** note は NULL 可の列。画面で `?? ''` を書かせないよう、ここで空文字に潰す */
function toReservationRow(row: {
  id: string;
  shopId: string;
  shopName: string;
  reservedAt: Date;
  partySize: number;
  note: string | null;
  status: ReservationStatus;
  createdAt: Date;
}): ReservationRow {
  // toReservationId / toShopId は検証付きの変換。DB の値でも素通しにしない
  return {
    id: toReservationId(row.id),
    shopId: toShopId(row.shopId),
    shopName: row.shopName,
    reservedAt: row.reservedAt,
    partySize: row.partySize,
    note: row.note ?? '',
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function listMyReservations(
  db: Database,
  actor: Actor,
  scope: ReservationScope,
  now: Date,
): Promise<readonly ReservationRow[]> {
  const mine = eq(reservations.userId, actor.userId);
  // upcoming =「これから行く」= 未来 かつ まだ生きている状態。
  // past はその否定。cancelled / rejected は日付が未来でも past に置く
  const scopeCondition =
    scope === 'upcoming'
      ? and(
          gte(reservations.reservedAt, now),
          inArray(reservations.status, RESERVATION_STATUSES_OCCUPYING_SEAT),
        )
      : or(
          lt(reservations.reservedAt, now),
          notInArray(reservations.status, RESERVATION_STATUSES_OCCUPYING_SEAT),
        );

  const rows = await db
    .select(RESERVATION_COLUMNS)
    .from(reservations)
    .innerJoin(shops, eq(shops.id, reservations.shopId))
    .where(and(mine, scopeCondition))
    // 直近から埋まる upcoming は昇順、振り返る past は降順
    .orderBy(scope === 'upcoming' ? asc(reservations.reservedAt) : desc(reservations.reservedAt));

  return rows.map(toReservationRow);
}

export async function findMyReservation(
  db: Database,
  actor: Actor,
  reservationId: ReservationId,
): Promise<ReservationRow | null> {
  const rows = await db
    .select(RESERVATION_COLUMNS)
    .from(reservations)
    .innerJoin(shops, eq(shops.id, reservations.shopId))
    .where(and(eq(reservations.id, reservationId), eq(reservations.userId, actor.userId)))
    .limit(1);
  const row = rows[0];
  // 「無い」と「自分のではない」を同じ null に潰す
  return row === undefined ? null : toReservationRow(row);
}

export async function cancelMyReservation(
  db: Database,
  actor: Actor,
  reservationId: ReservationId,
): Promise<boolean> {
  const updated = await db
    .update(reservations)
    .set({ status: RESERVATION_STATUS_CANCELLED })
    .where(
      and(
        eq(reservations.id, reservationId),
        eq(reservations.userId, actor.userId),
        // 遷移表が許す from だけを対象にする。
        // 許される from が空なら inArray は `false` になり 0 行更新（drizzle の実装で確認済み）
        inArray(
          reservations.status,
          allowedPreviousStatuses(RESERVATION_STATUS_CANCELLED, ROLE_USER),
        ),
      ),
    )
    // meta.changes ではなく RETURNING で数える。
    // 返る行数が「実際に書き換わった行」そのものなので解釈の余地がない
    .returning({ id: reservations.id });

  return updated.length > 0;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-repository
```

期待: 17 本すべて PASS。

**`ReservationStatus` の型が合わないと言われたら:** `reservations.status` は Drizzle の `text(..., { enum: RESERVATION_STATUSES })` なのでリテラルユニオンで返る。`../db/constants` の `ReservationStatus` と同じ型なので、`as` は要らない。

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

(a) `listMyReservations` の `mine`（`eq(reservations.userId, actor.userId)`）を消す:

→ 「他人の予約は一切返さない」が FAIL。

(b) `findMyReservation` の `eq(reservations.userId, actor.userId)` を消す:

→ 「他人の予約は null（404 と区別が付かない）」が FAIL。

(c) `cancelMyReservation` の `inArray(...)` を消す:

→ 「completed は取り消せない」が FAIL。加えて、トリガーが `D1_ERROR: invalid reservation status transition` を投げるので、テストは「例外」で落ちる。**エラーの文言をログで確認すること。これが Task 7-3 のトリガーが 2 枚目の壁として効いている証拠。**

(d) `cancelMyReservation` の `eq(reservations.userId, actor.userId)` を消す:

→ 「他人の予約は取り消せず、行も変わらない」が FAIL。

(e) `scope === 'upcoming'` の `asc` / `desc` を入れ替える:

→ 「upcoming は未来かつ席を占めている予約だけを近い順で返す」が FAIL（順序が逆になる）。

5 つとも確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/reservation-repository.ts apps/api/src/repositories/reservation-repository.test.ts
git commit -m "feat(api): 利用者側の予約リポジトリを足す"
```

---

## Task 7-10: 利用者側ルート（一覧 / 詳細 / キャンセル）

Task 7-8 で作った `apps/api/src/routes/reservations.ts` に 3 本足す。

**応答の形を 1 か所に固める。** リポジトリの `ReservationRow` は `Date` を持つが、JSON に載せるときは ISO 文字列にする。この変換をルートごとに書くとずれるので、`toReservationResponse` にまとめる。

**Files:**

- Modify: `apps/api/src/routes/reservations.ts`
- Create: `apps/api/src/routes/reservation-response.ts`
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 の突合テスト。**ルートが 3 本増えるので 2 つの配列に 3 行ずつ足す**）
- Test: `apps/api/src/routes/reservations.test.ts`
- Test: `apps/api/src/routes/reservation-response.test.ts`

**Interfaces:**

- Consumes: `listMyReservations` / `findMyReservation` / `cancelMyReservation` / `ReservationRow` / `ReservationScope`（Task 7-9）、`reservationListQuerySchema`（Task 7-5）、`parseReservationId`（本タスクで `../lib/parse-id.ts` に足す）
- Produces:
  - `type ReservationResponse = { readonly id: string; readonly shopId: string; readonly shopName: string; readonly reservedAt: string; readonly partySize: number; readonly note: string; readonly status: ReservationStatus; readonly createdAt: string }`
  - `toReservationResponse(row: ReservationRow): ReservationResponse`
  - `parseReservationId(value: string | undefined): ReservationId`（`../lib/parse-id`）
  - `reservationRoutes` に `GET /` / `GET /:reservationId` / `POST /:reservationId/cancel` が増える

---

- [ ] **Step 1: 応答の整形の失敗するテストを書く**

`apps/api/src/routes/reservation-response.test.ts`:

```ts
import { toReservationId, toShopId } from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import { toReservationResponse } from './reservation-response';

const ROW = {
  id: toReservationId('rsv_resp_1'),
  shopId: toShopId('shp_resp_1'),
  shopName: 'レスポンス店',
  reservedAt: new Date(Date.parse('2026-10-01T09:00:00Z')),
  partySize: 2,
  note: '窓際希望',
  status: 'pending',
  createdAt: new Date(Date.parse('2026-09-20T03:00:00Z')),
} as const;

describe('toReservationResponse', () => {
  it('Date を ISO 8601 の文字列にする', () => {
    const response = toReservationResponse(ROW);
    expect(response.reservedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(response.createdAt).toBe('2026-09-20T03:00:00.000Z');
  });

  it('列をそのまま写す', () => {
    expect(toReservationResponse(ROW)).toEqual({
      id: 'rsv_resp_1',
      shopId: 'shp_resp_1',
      shopName: 'レスポンス店',
      reservedAt: '2026-10-01T09:00:00.000Z',
      partySize: 2,
      note: '窓際希望',
      status: 'pending',
      createdAt: '2026-09-20T03:00:00.000Z',
    });
  });

  it('userId や ownerMemo は含めない', () => {
    // 内部の列が増えたときに黙って漏れないよう、キーの集合そのものを固定する
    expect(Object.keys(toReservationResponse(ROW)).sort()).toEqual([
      'createdAt',
      'id',
      'note',
      'partySize',
      'reservedAt',
      'shopId',
      'shopName',
      'status',
    ]);
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-response
```

期待: `Failed to resolve import "./reservation-response"` で FAIL。

- [ ] **Step 3: 応答の整形と ID のパースを書く**

`apps/api/src/routes/reservation-response.ts`:

```ts
// 予約の JSON 表現。Date → ISO 文字列の変換をここ 1 か所に閉じる。
//
// リポジトリの行をそのまま c.json() に渡さないのは、
// 列が増えたときに黙って外へ漏れるのを防ぐため。
// 「出すものを明示的に並べる」ことでレビューの目に入る。

import type { ReservationStatus } from '../db/constants';
import type { ReservationRow } from '../repositories/reservation-repository';

export type ReservationResponse = {
  readonly id: string;
  readonly shopId: string;
  readonly shopName: string;
  /** ISO 8601（UTC）。表示のタイムゾーン変換はモバイル側が行う */
  readonly reservedAt: string;
  readonly partySize: number;
  readonly note: string;
  readonly status: ReservationStatus;
  readonly createdAt: string;
};

export function toReservationResponse(row: ReservationRow): ReservationResponse {
  return {
    id: row.id,
    shopId: row.shopId,
    shopName: row.shopName,
    reservedAt: row.reservedAt.toISOString(),
    partySize: row.partySize,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
```

`apps/api/src/lib/parse-id.ts` に足す（Phase 4 が `parseShopId` を置いたのと同じ形）:

```ts
import { toReservationId } from '@meshimap/core';
import type { ReservationId } from '@meshimap/core';
import { notFound } from './http-error';

/**
 * URL の予約 ID をブランド型にする。
 * 形が違えば「存在しない」と同じ 404 にする。422 にすると
 * 「形は合っているが無い ID」と区別が付き、ID の書式が漏れる。
 */
export function parseReservationId(value: string | undefined): ReservationId {
  if (value === undefined) {
    throw notFound();
  }
  try {
    return toReservationId(value);
  } catch {
    // toReservationId は RangeError を投げる。中身は外に出さない
    throw notFound();
  }
}
```

- [ ] **Step 4: 応答の整形のテストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-response
```

期待: 3 本すべて PASS。

- [ ] **Step 5: ルートの失敗するテストを書く**

`apps/api/src/routes/reservations.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index';
import {
  createTestBindings,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  signUpAs,
  type TestUser,
  type TestWorld,
} from '../test/fixtures';

let world: TestWorld;
let me: TestUser;
let other: TestUser;

const SHOP_ID = 'shp_rroute_0001';

async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM reservations');
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'rsv_rroute_mine',
    SHOP_ID,
    me.userId,
    Date.parse('2099-10-02T09:00:00Z'),
    2,
    'メモ',
    'pending',
  );
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'rsv_rroute_done',
    SHOP_ID,
    me.userId,
    Date.parse('2020-10-02T09:00:00Z'),
    2,
    '',
    'completed',
  );
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'rsv_rroute_other',
    SHOP_ID,
    other.userId,
    Date.parse('2099-10-02T09:00:00Z'),
    2,
    '',
    'pending',
  );
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  me = await signUpAs(world, 'rroute-me@example.com', 'user');
  other = await signUpAs(world, 'rroute-other@example.com', 'user');
  await seedShop(world, {
    id: SHOP_ID,
    ownerId: null,
    name: 'ルートテスト店',
    status: 'published',
  });
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});

function request(path: string, cookie?: string, method = 'GET'): Promise<Response> {
  return app.request(
    path,
    { method, headers: cookie === undefined ? {} : { cookie } },
    createTestBindings(world),
  );
}

describe('GET /reservations', () => {
  it('未ログインは 401', async () => {
    expect((await request('/reservations')).status).toBe(401);
  });

  it('自分の upcoming だけを返す', async () => {
    const response = await request('/reservations?scope=upcoming', me.cookie);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservations.map((row: { id: string }) => row.id)).toEqual(['rsv_rroute_mine']);
  });

  it('scope を省略すると upcoming になる', async () => {
    const response = await request('/reservations', me.cookie);
    const body = await response.json();
    expect(body.reservations.map((row: { id: string }) => row.id)).toEqual(['rsv_rroute_mine']);
  });

  it('scope=past で過去を返す', async () => {
    const response = await request('/reservations?scope=past', me.cookie);
    const body = await response.json();
    expect(body.reservations.map((row: { id: string }) => row.id)).toEqual(['rsv_rroute_done']);
  });

  it('知らない scope は 422', async () => {
    expect((await request('/reservations?scope=all', me.cookie)).status).toBe(422);
  });

  it('応答に user_id は現れない', async () => {
    const text = await (await request('/reservations', me.cookie)).text();
    expect(text).not.toContain(me.userId);
  });
});

describe('GET /reservations/:reservationId', () => {
  it('未ログインは 401', async () => {
    expect((await request('/reservations/rsv_rroute_mine')).status).toBe(401);
  });

  it('自分の予約は 200', async () => {
    const response = await request('/reservations/rsv_rroute_mine', me.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'rsv_rroute_mine',
      shopName: 'ルートテスト店',
      status: 'pending',
      note: 'メモ',
    });
  });

  it('他人の予約は 404', async () => {
    expect((await request('/reservations/rsv_rroute_other', me.cookie)).status).toBe(404);
  });

  it('存在しない ID も 404（他人のものと区別が付かない）', async () => {
    expect((await request('/reservations/rsv_nope', me.cookie)).status).toBe(404);
  });

  it('ID の書式が壊れていても 404（422 にしない）', async () => {
    expect((await request('/reservations/..%2Fetc', me.cookie)).status).toBe(404);
  });
});

describe('POST /reservations/:reservationId/cancel', () => {
  it('未ログインは 401', async () => {
    const response = await request('/reservations/rsv_rroute_mine/cancel', undefined, 'POST');
    expect(response.status).toBe(401);
  });

  it('自分の pending は取り消せて 200', async () => {
    const response = await request('/reservations/rsv_rroute_mine/cancel', me.cookie, 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'rsv_rroute_mine', status: 'cancelled' });
  });

  it('取り消すと DB の行も cancelled になる', async () => {
    await request('/reservations/rsv_rroute_mine/cancel', me.cookie, 'POST');
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_rroute_mine',
    );
    expect(row?.status).toBe('cancelled');
  });

  it('2 回目は 422（もう取り消せる状態ではない）', async () => {
    await request('/reservations/rsv_rroute_mine/cancel', me.cookie, 'POST');
    const second = await request('/reservations/rsv_rroute_mine/cancel', me.cookie, 'POST');
    expect(second.status).toBe(422);
  });

  it('completed は 422', async () => {
    const response = await request('/reservations/rsv_rroute_done/cancel', me.cookie, 'POST');
    expect(response.status).toBe(422);
  });

  it('他人の予約は 404 で、行も変わらない', async () => {
    const response = await request('/reservations/rsv_rroute_other/cancel', me.cookie, 'POST');
    expect(response.status).toBe(404);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_rroute_other',
    );
    expect(row?.status).toBe('pending');
  });
});
```

**`cancelMyReservation` が `false` を返したとき、404 と 422 をどう分けるか。** 「行が無い / 他人のもの」なら 404、「自分のものだが状態が合わない」なら 422 にしたい。しかし `cancelMyReservation` は両方 `false` で返す。**そこでルートは、`false` のときだけ `findMyReservation` をもう 1 回引いて、行があるかどうかで 404 と 422 を分ける。** 追加の 1 クエリは失敗時にしか走らないので、成功経路のコストは増えない。

- [ ] **Step 6: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- routes/reservations.test
```

期待: すべて 404（ルート未定義）で FAIL。

- [ ] **Step 7: ルートを 3 本足す**

`apps/api/src/routes/reservations.ts`（Task 7-8 の `.post('/')` に続けてチェーンする）:

```ts
  .get('/', async (c) => {
    const actor = requireActor(c);
    const parsed = reservationListQuerySchema.safeParse({ scope: c.req.query('scope') });
    if (!parsed.success) {
      throw invalidInput();
    }
    const rows = await listMyReservations(
      createDatabase(c.env.DB),
      actor,
      parsed.data.scope,
      new Date(),
    );
    return c.json({ reservations: rows.map(toReservationResponse) });
  })
  .get('/:reservationId', async (c) => {
    const actor = requireActor(c);
    const row = await findMyReservation(
      createDatabase(c.env.DB),
      actor,
      parseReservationId(c.req.param('reservationId')),
    );
    if (row === null) {
      throw notFound();
    }
    return c.json(toReservationResponse(row));
  })
  .post('/:reservationId/cancel', async (c) => {
    const actor = requireActor(c);
    const db = createDatabase(c.env.DB);
    const reservationId = parseReservationId(c.req.param('reservationId'));

    const cancelled = await cancelMyReservation(db, actor, reservationId);
    if (!cancelled) {
      // 0 行更新の理由は 2 つある。「自分の行が無い」なら 404、
      // 「自分の行はあるが状態が合わない」なら 422。
      // 失敗時にだけ 1 回余分に引いて区別する
      const existing = await findMyReservation(db, actor, reservationId);
      throw existing === null ? notFound() : invalidInput();
    }

    // 取り消し後の姿をそのまま返す。画面が再取得しなくて済む
    const row = await findMyReservation(db, actor, reservationId);
    if (row === null) {
      // 直前に更新できた行が消えているのは整合性の崩れ。握り潰さない
      throw notFound();
    }
    return c.json(toReservationResponse(row));
  });
```

import に足すもの:

```ts
import { reservationListQuerySchema } from '../schemas/reservation-schema';
import {
  cancelMyReservation,
  findMyReservation,
  listMyReservations,
} from '../repositories/reservation-repository';
import { parseReservationId } from '../lib/parse-id';
import { toReservationResponse } from './reservation-response';
```

**同じコミットで `apps/api/src/routes/permission-matrix.test.ts` の 2 つの配列に 3 行ずつ足す。** このタスクは `index.ts` を触らないが、`reservationRoutes` に 3 本足すぶん `app.routes` は 3 本増える。**「`index.ts` を変えていないから関係ない」と考えると落ちる。** 足さないと次のメッセージになる:

```
FAIL  ルート表と実装の突合 > app に登録されたエンドポイントは 12 本で、想定どおりの並びである
  - Expected  12 items
  + Received  15 items
FAIL  ルート表と実装の突合 > 権限マトリクスは app のエンドポイントを 1 本残らず覆っている
  - Expected  []
  + Received  [
      '権限マトリクスに無いエンドポイント: GET /reservations',
      '権限マトリクスに無いエンドポイント: GET /reservations/:reservationId',
      '権限マトリクスに無いエンドポイント: POST /reservations/:reservationId/cancel',
    ]
```

`EXPECTED_ROUTE_PATTERNS` は 15 本になる。**`'GET /reservation-slots'` が `'GET /reservations'` より前**である点に注意（`-` は 0x2D、`s` は 0x73 なので `-` のほうが小さい）:

```ts
/** 権限マトリクスが責任を持つ 15 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /shops/:shopId',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];
```

委譲リストは 5 本になる:

```ts
const DELEGATED_ROUTE_PATTERNS: readonly string[] = [
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
];
```

- [ ] **Step 8: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- routes/reservations permission-matrix
npm run typecheck -w @meshimap/api
```

期待: 応答整形 3 本 + ルート 17 本 + Task 7-8 の 6 本、すべて PASS。型エラー 0。`permission-matrix.test.ts` も全件 PASS。

- [ ] **Step 9: わざと壊してテストが落ちることを確認する**

(a) `GET /:reservationId` の `row === null` の分岐を消して `c.json(row)` にする:

→ 型エラー（`ReservationRow | null` は `toReservationResponse` に渡せない）。**型で止まるのが正しい。** 無理に `!` を付けて通すと「他人の予約は 404」が FAIL（`null` が 200 で返る）。

(b) キャンセルの失敗時に必ず `invalidInput()` を投げるようにする:

→ 「他人の予約は 404 で、行も変わらない」が FAIL（422 が返る）。

(c) キャンセルの失敗時に必ず `notFound()` を投げるようにする:

→ 「2 回目は 422」と「completed は 422」が FAIL。

(d) `toReservationResponse` に `userId: row.id` のような余計なキーを足す:

→ 「userId や ownerMemo は含めない」が FAIL（キーの集合が変わる）。

(e) `parseReservationId` の `catch` を消して `toReservationId(value)` を直接返す:

→ 「ID の書式が壊れていても 404（422 にしない）」が FAIL（`RangeError` が漏れて 500 になる）。

(f) `permission-matrix.test.ts` の `EXPECTED_ROUTE_PATTERNS` から `'GET /reservations/:reservationId'` の 1 行だけを消す:

→ 「app に登録されたエンドポイントは 15 本で、想定どおりの並びである」が FAIL（14 対 15）。**`index.ts` を触らないタスクでも棚卸しが増えることが、ここで目に見える。**

6 つとも確認したら元に戻す。

- [ ] **Step 10: コミット**

```bash
git add apps/api/src/routes/reservations.ts apps/api/src/routes/reservations.test.ts apps/api/src/routes/reservation-response.ts apps/api/src/routes/reservation-response.test.ts apps/api/src/routes/permission-matrix.test.ts apps/api/src/lib/parse-id.ts
git commit -m "feat(api): 利用者側の予約一覧・詳細・キャンセルを足す"
```

---

## Task 7-11: 予約リポジトリ（店舗側）

自店の予約だけを読む / 自店の予約だけ状態を動かす / メモを書く。

**読みと書きで所有権の書き方が変わる。** SQLite には `UPDATE ... JOIN` が無いので、更新では `innerJoin` を使えない。代わりに相関のないサブクエリを `WHERE` に入れる:

```sql
UPDATE reservations SET status = ?
WHERE id = ?
  AND shop_id IN (SELECT id FROM shops WHERE owner_id = ?)
  AND status IN (?, ?)
```

Drizzle では `inArray(reservations.shopId, db.select({ id: shops.id }).from(shops).where(eq(shops.ownerId, actor.userId)))` と書ける（`inArray` の第 2 引数はサブクエリも取る）。

**状態遷移は「型 → WHERE → トリガー」の 3 段で縛る。** ここは 2 段目。`allowedPreviousStatuses(to, ROLE_OWNER)` が返した配列を `WHERE status IN (...)` に入れる。**呼び出し側で `if (row.status !== 'pending')` を書かない。** 書くと、読んでから書くまでの間に状態が変わる隙間ができる。

**Files:**

- Create: `apps/api/src/repositories/owner-reservation-repository.ts`
- Test: `apps/api/src/repositories/owner-reservation-repository.test.ts`

**Interfaces:**

- Consumes: `allowedPreviousStatuses` / `ROLE_OWNER` / `toReservationId` / `toShopId` / `toUserId` / `toJstInstant` / `toMinuteOfDay`（`@meshimap/core`）、`OwnerActor`（`../auth/actor`）、`reservations` / `shops` / `profiles`（`../db/schema`）、`ReservationStatus`（`../db/constants`）
- Produces:
  - `type OwnerReservationRow = ReservationRow & { readonly userId: UserId; readonly customerName: string; readonly ownerMemo: string }`
  - `type OwnerReservationFilter = { readonly date?: JstDate; readonly status?: ReservationStatus }`
  - `listShopReservations(db: Database, actor: OwnerActor, filter: OwnerReservationFilter): Promise<readonly OwnerReservationRow[]>`
  - `findShopReservation(db: Database, actor: OwnerActor, reservationId: ReservationId): Promise<OwnerReservationRow | null>`
  - `updateReservationStatus(db: Database, actor: OwnerActor, reservationId: ReservationId, to: ReservationStatus): Promise<boolean>`
  - `updateReservationMemo(db: Database, actor: OwnerActor, reservationId: ReservationId, memo: string): Promise<boolean>`

---

- [ ] **Step 1: 失敗するテストを書く**

`apps/api/src/repositories/owner-reservation-repository.test.ts`:

```ts
import { toJstDate, toReservationId, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import {
  buildActorForTest,
  createTestWorld,
  ownerActorOrThrow,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import {
  findShopReservation,
  listShopReservations,
  updateReservationMemo,
  updateReservationStatus,
} from './owner-reservation-repository';

let world: TestWorld;

const MY_SHOP_ID = toShopId('shp_owner_0001');
const RIVAL_SHOP_ID = toShopId('shp_owner_0002');
const ME = 'usr_owner_me';
const RIVAL = 'usr_owner_rival';
const CUSTOMER = 'usr_owner_customer';

/**
 * buildActorForTest は Actor（3 ロールの union）を返すので、owner に絞ってから渡す。
 * 絞り込みは fixtures の型ガード経由にする。ここで `as OwnerActor` と書くと、
 * ロールの取り違えがコンパイル時に素通りしてしまう。
 */
function ownerActor(userId: string): OwnerActor {
  return ownerActorOrThrow(buildActorForTest(userId, 'owner'));
}

async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM reservations');
  const rows: readonly [string, string, number, string][] = [
    // 2026-10-01 18:00 JST
    ['rsv_own_pending', MY_SHOP_ID, Date.parse('2026-10-01T09:00:00Z'), 'pending'],
    // 2026-10-01 19:00 JST
    ['rsv_own_confirmed', MY_SHOP_ID, Date.parse('2026-10-01T10:00:00Z'), 'confirmed'],
    // 2026-10-02 18:00 JST
    ['rsv_own_nextday', MY_SHOP_ID, Date.parse('2026-10-02T09:00:00Z'), 'pending'],
    ['rsv_own_done', MY_SHOP_ID, Date.parse('2026-09-01T09:00:00Z'), 'completed'],
    // よその店の予約
    ['rsv_own_rival', RIVAL_SHOP_ID, Date.parse('2026-10-01T09:00:00Z'), 'pending'],
  ];
  for (const [id, shopId, reservedAt, status] of rows) {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      shopId,
      CUSTOMER,
      reservedAt,
      2,
      '客のメモ',
      status,
    );
  }
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: ME, role: 'owner' });
  await seedUser(world, { userId: RIVAL, role: 'owner' });
  await seedUser(world, { userId: CUSTOMER, role: 'user', displayName: '山田太郎' });
  await seedShop(world, { id: MY_SHOP_ID, name: '自分の店', ownerId: ME, status: 'published' });
  await seedShop(world, {
    id: RIVAL_SHOP_ID,
    name: 'よその店',
    ownerId: RIVAL,
    status: 'published',
  });
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});

describe('listShopReservations', () => {
  it('絞り込み無しなら自店の予約を来店時刻の昇順で返す', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {});
    expect(rows.map((row) => row.id)).toEqual([
      'rsv_own_done',
      'rsv_own_pending',
      'rsv_own_confirmed',
      'rsv_own_nextday',
    ]);
  });

  it('よその店の予約は 1 件も混ざらない', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {});
    expect(rows.map((row) => row.id)).not.toContain('rsv_own_rival');
  });

  it('date で JST の 1 日に絞れる', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {
      date: toJstDate('2026-10-01'),
    });
    expect(rows.map((row) => row.id)).toEqual(['rsv_own_pending', 'rsv_own_confirmed']);
  });

  it('JST の日付境界をまたがない（10-02 09:00Z は 10-02 18:00 JST）', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {
      date: toJstDate('2026-10-02'),
    });
    expect(rows.map((row) => row.id)).toEqual(['rsv_own_nextday']);
  });

  it('status で絞れる', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {
      status: 'pending',
    });
    expect(rows.map((row) => row.id)).toEqual(['rsv_own_pending', 'rsv_own_nextday']);
  });

  it('date と status は AND で効く', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {
      date: toJstDate('2026-10-01'),
      status: 'pending',
    });
    expect(rows.map((row) => row.id)).toEqual(['rsv_own_pending']);
  });

  it('予約者の表示名を返す（店が誰か分かるように）', async () => {
    const rows = await listShopReservations(createDatabase(world.d1), ownerActor(ME), {
      status: 'confirmed',
    });
    expect(rows[0]?.customerName).toBe('山田太郎');
  });

  it('店を持たないオーナーには空配列を返す', async () => {
    const rows = await listShopReservations(
      createDatabase(world.d1),
      ownerActor('usr_owner_nobody'),
      {},
    );
    expect(rows).toEqual([]);
  });
});

describe('findShopReservation', () => {
  it('自店の予約は取れる', async () => {
    const row = await findShopReservation(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
    );
    expect(row).toMatchObject({
      id: 'rsv_own_pending',
      shopId: MY_SHOP_ID,
      customerName: '山田太郎',
      note: '客のメモ',
      ownerMemo: '',
      status: 'pending',
    });
  });

  it('よその店の予約は null', async () => {
    const row = await findShopReservation(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_rival'),
    );
    expect(row).toBeNull();
  });

  it('よその店のオーナーから見れば自分のものになる（対称性の確認）', async () => {
    const row = await findShopReservation(
      createDatabase(world.d1),
      ownerActor(RIVAL),
      toReservationId('rsv_own_rival'),
    );
    expect(row?.id).toBe('rsv_own_rival');
  });
});

describe('updateReservationStatus', () => {
  it('pending → confirmed は通る', async () => {
    const done = await updateReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
      'confirmed',
    );
    expect(done).toBe(true);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_own_pending',
    );
    expect(row?.status).toBe('confirmed');
  });

  it('pending → rejected も通る', async () => {
    expect(
      await updateReservationStatus(
        createDatabase(world.d1),
        ownerActor(ME),
        toReservationId('rsv_own_pending'),
        'rejected',
      ),
    ).toBe(true);
  });

  it('confirmed → completed / no_show は通る', async () => {
    expect(
      await updateReservationStatus(
        createDatabase(world.d1),
        ownerActor(ME),
        toReservationId('rsv_own_confirmed'),
        'completed',
      ),
    ).toBe(true);
    await resetReservations();
    expect(
      await updateReservationStatus(
        createDatabase(world.d1),
        ownerActor(ME),
        toReservationId('rsv_own_confirmed'),
        'no_show',
      ),
    ).toBe(true);
  });

  it('pending → completed は WHERE で 0 行になり false（トリガーまで行かない）', async () => {
    const done = await updateReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
      'completed',
    );
    expect(done).toBe(false);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_own_pending',
    );
    expect(row?.status).toBe('pending');
  });

  it('オーナーは cancelled へ動かせない（cancelled は利用者の権利）', async () => {
    const done = await updateReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
      'cancelled',
    );
    expect(done).toBe(false);
  });

  it('終端状態からは動かせない', async () => {
    const done = await updateReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_done'),
      'confirmed',
    );
    expect(done).toBe(false);
  });

  it('よその店の予約は動かせず、行も変わらない', async () => {
    const done = await updateReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_rival'),
      'confirmed',
    );
    expect(done).toBe(false);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_own_rival',
    );
    expect(row?.status).toBe('pending');
  });
});

describe('updateReservationMemo', () => {
  it('自店の予約にメモを書ける', async () => {
    const done = await updateReservationMemo(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
      'アレルギー: 甲殻類',
    );
    expect(done).toBe(true);
    const row = await readRow(
      world,
      'SELECT owner_memo FROM reservations WHERE id = ?',
      'rsv_own_pending',
    );
    expect(row?.owner_memo).toBe('アレルギー: 甲殻類');
  });

  it('終端状態の予約にもメモは書ける（記録として残すため）', async () => {
    expect(
      await updateReservationMemo(
        createDatabase(world.d1),
        ownerActor(ME),
        toReservationId('rsv_own_done'),
        '常連',
      ),
    ).toBe(true);
  });

  it('よその店の予約には書けず、行も変わらない', async () => {
    const done = await updateReservationMemo(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_rival'),
      '侵入',
    );
    expect(done).toBe(false);
    const row = await readRow(
      world,
      'SELECT owner_memo FROM reservations WHERE id = ?',
      'rsv_own_rival',
    );
    expect(row?.owner_memo).toBeNull();
  });

  it('空文字でメモを消せる', async () => {
    await updateReservationMemo(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_own_pending'),
      'いったん書く',
    );
    expect(
      await updateReservationMemo(
        createDatabase(world.d1),
        ownerActor(ME),
        toReservationId('rsv_own_pending'),
        '',
      ),
    ).toBe(true);
    const row = await readRow(
      world,
      'SELECT owner_memo FROM reservations WHERE id = ?',
      'rsv_own_pending',
    );
    expect(row?.owner_memo).toBe('');
  });
});
```

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- owner-reservation-repository
```

期待: `Failed to resolve import "./owner-reservation-repository"` で FAIL。

- [ ] **Step 3: 最小の実装を書く**

`apps/api/src/repositories/owner-reservation-repository.ts`:

```ts
// 店舗から見た予約。「自店の」はすべて SQL で表す。
//
// 読みと書きで所有権の書き方が違う:
//   読み  → innerJoin(shops) + WHERE shops.owner_id = ?
//   書き  → WHERE shop_id IN (SELECT id FROM shops WHERE owner_id = ?)
// SQLite の UPDATE は JOIN を取れないため。どちらも「自店以外は 0 行」で同じ意味になる。

import {
  ROLE_OWNER,
  addJstDays,
  allowedPreviousStatuses,
  toJstInstant,
  toMinuteOfDay,
  toReservationId,
  toShopId,
  toUserId,
} from '@meshimap/core';
import type { JstDate, ReservationId, UserId } from '@meshimap/core';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import type { ReservationStatus } from '../db/constants';
import { profiles, reservations, shops } from '../db/schema';
import type { ReservationRow } from './reservation-repository';

export type OwnerReservationRow = ReservationRow & {
  readonly userId: UserId;
  /** 予約者の表示名。退会済みでも profiles の行は残る（Phase 3 の方針） */
  readonly customerName: string;
  /** 店だけが見えるメモ。利用者の応答には絶対に載せない */
  readonly ownerMemo: string;
};

export type OwnerReservationFilter = {
  readonly date?: JstDate;
  readonly status?: ReservationStatus;
};

const OWNER_RESERVATION_COLUMNS = {
  id: reservations.id,
  shopId: reservations.shopId,
  shopName: shops.name,
  userId: reservations.userId,
  customerName: profiles.displayName,
  reservedAt: reservations.reservedAt,
  partySize: reservations.partySize,
  note: reservations.note,
  ownerMemo: reservations.ownerMemo,
  status: reservations.status,
  createdAt: reservations.createdAt,
};

function toOwnerReservationRow(row: {
  id: string;
  shopId: string;
  shopName: string;
  userId: string;
  customerName: string;
  reservedAt: Date;
  partySize: number;
  note: string | null;
  ownerMemo: string | null;
  status: ReservationStatus;
  createdAt: Date;
}): OwnerReservationRow {
  return {
    id: toReservationId(row.id),
    shopId: toShopId(row.shopId),
    shopName: row.shopName,
    userId: toUserId(row.userId),
    customerName: row.customerName,
    reservedAt: row.reservedAt,
    partySize: row.partySize,
    note: row.note ?? '',
    ownerMemo: row.ownerMemo ?? '',
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** 自店の予約だけを見る条件。読み取り専用（JOIN を前提にする） */
function ownedByReader(actor: OwnerActor) {
  return eq(shops.ownerId, actor.userId);
}

/** 自店の予約だけを触る条件。UPDATE でも使えるサブクエリ形 */
function ownedByWriter(db: Database, actor: OwnerActor) {
  return inArray(
    reservations.shopId,
    db.select({ id: shops.id }).from(shops).where(eq(shops.ownerId, actor.userId)),
  );
}

export async function listShopReservations(
  db: Database,
  actor: OwnerActor,
  filter: OwnerReservationFilter,
): Promise<readonly OwnerReservationRow[]> {
  const conditions = [ownedByReader(actor)];
  if (filter.date !== undefined) {
    // JST の 1 日は UTC では前日 15:00 〜 当日 15:00。
    // 文字列の日付で比較せず、両端の瞬間に直して **半開区間** [当日 00:00, 翌日 00:00) で絞る。
    // 上限を「当日 23:59」にすると 23:59:30 の予約が漏れる。`lt` + 翌日 00:00 なら漏れない
    const dayStart = toJstInstant(filter.date, toMinuteOfDay(0));
    const nextDayStart = toJstInstant(addJstDays(filter.date, 1), toMinuteOfDay(0));
    conditions.push(gte(reservations.reservedAt, dayStart));
    conditions.push(lt(reservations.reservedAt, nextDayStart));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(reservations.status, filter.status));
  }

  const rows = await db
    .select(OWNER_RESERVATION_COLUMNS)
    .from(reservations)
    .innerJoin(shops, eq(shops.id, reservations.shopId))
    .innerJoin(profiles, eq(profiles.userId, reservations.userId))
    .where(and(...conditions))
    .orderBy(asc(reservations.reservedAt));

  return rows.map(toOwnerReservationRow);
}

export async function findShopReservation(
  db: Database,
  actor: OwnerActor,
  reservationId: ReservationId,
): Promise<OwnerReservationRow | null> {
  const rows = await db
    .select(OWNER_RESERVATION_COLUMNS)
    .from(reservations)
    .innerJoin(shops, eq(shops.id, reservations.shopId))
    .innerJoin(profiles, eq(profiles.userId, reservations.userId))
    .where(and(eq(reservations.id, reservationId), ownedByReader(actor)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toOwnerReservationRow(row);
}

export async function updateReservationStatus(
  db: Database,
  actor: OwnerActor,
  reservationId: ReservationId,
  to: ReservationStatus,
): Promise<boolean> {
  const updated = await db
    .update(reservations)
    .set({ status: to })
    .where(
      and(
        eq(reservations.id, reservationId),
        ownedByWriter(db, actor),
        // 遷移表の 2 段目。許される from が無ければ inArray は false になり 0 行
        inArray(reservations.status, allowedPreviousStatuses(to, ROLE_OWNER)),
      ),
    )
    .returning({ id: reservations.id });

  return updated.length > 0;
}

export async function updateReservationMemo(
  db: Database,
  actor: OwnerActor,
  reservationId: ReservationId,
  memo: string,
): Promise<boolean> {
  // メモは状態と無関係。終わった予約にも「次回の申し送り」を書けるようにする
  const updated = await db
    .update(reservations)
    .set({ ownerMemo: memo })
    .where(and(eq(reservations.id, reservationId), ownedByWriter(db, actor)))
    .returning({ id: reservations.id });

  return updated.length > 0;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- owner-reservation-repository
```

期待: 21 本すべて PASS。

**`profiles.displayName` の列名が違うと言われたら** `apps/api/src/db/schema/master.ts`（または Phase 3 が profiles を定義したファイル）を開いて実際の列名を確認し、そちらに合わせる。**推測で `name` に書き換えない。**

- [ ] **Step 5: わざと壊してテストが落ちることを確認する**

(a) `listShopReservations` の `ownedByReader(actor)` を消す:

→ 「よその店の予約は 1 件も混ざらない」が FAIL。

(b) `updateReservationStatus` の `ownedByWriter(db, actor)` を消す:

→ 「よその店の予約は動かせず、行も変わらない」が FAIL。

(c) `updateReservationStatus` の `inArray(reservations.status, allowedPreviousStatuses(...))` を消す:

→ 「pending → completed は WHERE で 0 行になり false」が **トリガーの例外**で FAIL する。`D1_ERROR: invalid reservation status transition` が出ることをログで確認する。**WHERE を消してもデータが壊れないのは、Task 7-3 のトリガーが 3 段目の壁として立っているから。**

(d) `allowedPreviousStatuses(to, ROLE_OWNER)` の `ROLE_OWNER` を `ROLE_USER` に変える:

→ 「pending → confirmed は通る」が FAIL（user には `pending → confirmed` が無いので 0 行）。同時に「オーナーは cancelled へ動かせない」が FAIL（user には `pending → cancelled` があるので通ってしまう）。

(e) `listShopReservations` の日付の下限（`gte`）を消す:

→ 「date で JST の 1 日に絞れる」が FAIL（前日以前の `rsv_own_done` が混ざる）。

(e2) 上限を `lt(reservations.reservedAt, nextDayStart)` から `lt(reservations.reservedAt, toJstInstant(addJstDays(filter.date, 2), toMinuteOfDay(0)))` に変える（1 日ぶん広げる）:

→ 「JST の日付境界をまたがない（10-02 09:00Z は 10-02 18:00 JST）」ではなく「date で JST の 1 日に絞れる」が FAIL する（`rsv_own_nextday` が混ざる）。**境界は「翌日ちょうど」でしか守れない**ことがこれで分かる。

(f) `updateReservationMemo` の `ownedByWriter(db, actor)` を消す:

→ 「よその店の予約には書けず、行も変わらない」が FAIL。

7 つとも確認したら元に戻す。

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-reservation-repository.ts apps/api/src/repositories/owner-reservation-repository.test.ts
git commit -m "feat(api): 店舗側の予約リポジトリを足す"
```

---

## Task 7-12: 店舗側ルートと通知

店舗側の 4 エンドポイントを作り、同時に 4 種類の通知レコードを落とす。

**通知を独立させた理由。** 通知は 3 か所（申込 = Task 7-8 のサービス / キャンセル = Task 7-10 のルート / 承認・拒否 = 本タスク）から発生する。各所に `db.insert(notifications)` を書くと、文言と `data` の形が 3 通りに分かれる。組み立てを 1 ファイルに閉じ込め、呼び出し側は「何が起きたか」だけを渡す。

**通知の失敗で予約の更新を巻き戻さない。** D1 に対話型トランザクションは無い（「裏取りした事実 1」で `typeof d1.transaction === 'undefined'` を実測済み）。通知の INSERT が失敗しても予約の UPDATE は戻せない。ここで 500 を返すと、利用者は「失敗した」と思って同じ操作をやり直し、二重申込になる。**通知の例外は `logError` で記録して握る。** 予約の正は D1 の `reservations` にあり、通知は後追いで再送できる種類の情報である。

**宛先は SQL で決める。** 「オーナーのいない店には送らない」「自分の操作で自分に通知しない」をハンドラの `if` で書くと、経路が増えるたびに書き漏れる。`WHERE` 句に入れて、宛先が居なければ 0 件で終わるようにする。

**見出しに店名を入れない。** `SHOP_NAME_MAX_LENGTH` は 100（`packages/core/src/constants.ts:39` で確認）、`NOTIFICATION_TITLE_MAX_LENGTH` も 100（`apps/api/src/db/schema/admin.ts:23` で確認）。店名を見出しに入れると、上限ちょうどの店名で CHECK 制約に当たる。**見出しは固定文言、店名は本文**にする。本文の上限は 500 なので、店名 100 + 日時 16 + 人数 4 + 区切り 6 = 最大 126 文字で収まる。この計算が成り立つことを境界値テストで確かめる。

**Files:**

- Modify: `apps/api/src/db/schema/admin.ts:23-25`（長さ上限 2 つを `export` する）
- Create: `apps/api/src/repositories/notification-repository.ts`
- Test: `apps/api/src/repositories/notification-repository.test.ts`
- Create: `apps/api/src/services/reservation-notification-service.ts`
- Test: `apps/api/src/services/reservation-notification-service.test.ts`
- Create: `apps/api/src/services/reservation-status-service.ts`
- Test: `apps/api/src/services/reservation-status-service.test.ts`
- Create: `apps/api/src/routes/owner-reservations.ts`
- Test: `apps/api/src/routes/owner-reservations.test.ts`
- Modify: `apps/api/src/routes/reservation-response.ts`（店舗向けの整形を足す）
- Modify: `apps/api/src/services/reservation-create-service.ts`（申込の通知を足す）
- Modify: `apps/api/src/routes/reservations.ts`（キャンセルの通知を足す）
- Modify: `apps/api/src/index.ts`（`/owner/reservations` をマウントする）
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 の突合テスト。**ルートが 4 本増えるので 2 つの配列に 4 行ずつ足す。これで Phase 7 の 9 本が揃う**）

**Interfaces:**

- Consumes: `listShopReservations` / `findShopReservation` / `updateReservationStatus` / `updateReservationMemo` / `OwnerReservationRow`（Task 7-11）、`findMyReservation`（Task 7-9）、`toReservationResponse` / `ReservationResponse` / `parseReservationId`（Task 7-10）、`generateNotificationId`（Task 7-8）、`ownerReservationListQuerySchema` / `reservationStatusUpdateSchema` / `reservationMemoUpdateSchema`（Task 7-5）、`notifications` / `shops` / `user`（`../db/schema`）、`NOTIFICATION_TYPE_RESERVATION_*` 4 種 / `NotificationType`（`../db/constants`）、`toJstClock` / `formatMinuteOfDay` / `toUserId` / `toJstDate` / `ROLE_OWNER`（`@meshimap/core`）、`logError`（`../lib/logger`）、`roleGuard` / `requireOwnerActor`（`../middleware/role-guard`）
- Produces:
  - `NOTIFICATION_TITLE_MAX_LENGTH: number` / `NOTIFICATION_BODY_MAX_LENGTH: number`（`../db/schema/admin` の既存定数を export に変えるだけ。値は 100 / 500）
  - `type NotificationTarget = { readonly kind: 'user'; readonly userId: UserId } | { readonly kind: 'shop-owner'; readonly shopId: ShopId }`
  - `type NotificationInput = { readonly target: NotificationTarget; readonly type: NotificationType; readonly title: string; readonly body: string; readonly data: Readonly<Record<string, string>> }`
  - `createNotification(db: Database, actor: Actor, input: NotificationInput): Promise<boolean>`
  - `type ReservationNotificationType`（4 種のユニオン）
  - `RESERVATION_NOTIFICATION_TITLES: Record<ReservationNotificationType, string>`
  - `type ReservationNotificationEvent = { readonly type: ReservationNotificationType; readonly target: NotificationTarget; readonly reservationId: ReservationId; readonly shopName: string; readonly reservedAt: Date; readonly partySize: number }`
  - `buildReservationNotificationBody(event: ReservationNotificationEvent): string`
  - `notifyReservationEvent(db: Database, actor: Actor, event: ReservationNotificationEvent): Promise<void>`
  - `type ChangeStatusOutcome = { readonly kind: 'changed'; readonly row: OwnerReservationRow } | { readonly kind: 'not-found' } | { readonly kind: 'invalid-transition' }`
  - `changeReservationStatus(db: Database, actor: OwnerActor, reservationId: ReservationId, to: ReservationStatus): Promise<ChangeStatusOutcome>`
  - `type OwnerReservationResponse = ReservationResponse & { readonly userId: string; readonly customerName: string; readonly ownerMemo: string }`
  - `toOwnerReservationResponse(row: OwnerReservationRow): OwnerReservationResponse`
  - `ownerReservationRoutes`（`GET /` / `GET /:reservationId` / `POST /:reservationId/status` / `PATCH /:reservationId/memo`）

---

- [ ] **Step 1: 通知の長さ上限を export に変える**

`apps/api/src/db/schema/admin.ts` の 2 行だけを変える。値は変えない。

```ts
/** 通知タイトルの上限。プッシュ通知の表示幅に合わせる */
export const NOTIFICATION_TITLE_MAX_LENGTH = 100;
/** 通知本文の上限 */
export const NOTIFICATION_BODY_MAX_LENGTH = 500;
```

`export` に変えるのは、「本文が上限に収まる」ことをテストで**この定数と突き合わせて**確かめるため。テスト側に 500 を直書きすると、上限を変えたときにテストが嘘になる。

`apps/api/src/db/schema/index.ts` は `export * from './admin'` なので、バレル経由でも読める。

- [ ] **Step 2: 通知リポジトリの失敗するテストを書く**

`apps/api/src/repositories/notification-repository.test.ts`:

```ts
import { toShopId, toUserId } from '@meshimap/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import {
  buildActorForTest,
  countRows,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import { createNotification } from './notification-repository';

let world: TestWorld;

const OWNER_ID = 'usr_notif_owner';
const CUSTOMER_ID = 'usr_notif_customer';
const OWNED_SHOP_ID = toShopId('shp_notif_0001');
/** owner_id が NULL の店。オーナー退会後の状態を再現する */
const ORPHAN_SHOP_ID = toShopId('shp_notif_0002');

/** 毎回作り直す意味がないので定数にする。userId だけが違う 2 つの操作主体 */
const CUSTOMER_ACTOR = buildActorForTest(CUSTOMER_ID, 'user');
const OWNER_ACTOR = buildActorForTest(OWNER_ID, 'owner');

const BASE_INPUT = {
  type: 'reservation_requested',
  title: '予約の申し込みが届きました',
  body: '通知テスト店 / 2026-10-01 18:00 / 2名',
  data: { reservationId: 'rsv_notif_1' },
} as const;

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: OWNER_ID, role: 'owner' });
  await seedUser(world, { userId: CUSTOMER_ID, role: 'user' });
  await seedShop(world, {
    id: OWNED_SHOP_ID,
    ownerId: OWNER_ID,
    name: '通知テスト店',
    status: 'published',
  });
  await seedShop(world, {
    id: ORPHAN_SHOP_ID,
    ownerId: null,
    name: 'オーナー不在店',
    status: 'published',
  });
});

beforeEach(async () => {
  await runWrite(world, 'DELETE FROM notifications');
});

afterAll(async () => {
  await world.dispose();
});

describe('createNotification（宛先が店舗オーナー）', () => {
  it('オーナー宛に 1 件作られて true を返す', async () => {
    const created = await createNotification(createDatabase(world.d1), CUSTOMER_ACTOR, {
      ...BASE_INPUT,
      target: { kind: 'shop-owner', shopId: OWNED_SHOP_ID },
    });

    expect(created).toBe(true);
    const row = await readRow(world, 'SELECT user_id, type, title, body FROM notifications');
    expect(row?.user_id).toBe(OWNER_ID);
    expect(row?.type).toBe('reservation_requested');
    expect(row?.title).toBe('予約の申し込みが届きました');
  });

  it('data に操作した本人の id が入る（誰の操作か画面に出すため）', async () => {
    await createNotification(createDatabase(world.d1), CUSTOMER_ACTOR, {
      ...BASE_INPUT,
      target: { kind: 'shop-owner', shopId: OWNED_SHOP_ID },
    });

    const row = await readRow(world, 'SELECT data FROM notifications');
    expect(JSON.parse(String(row?.data))).toEqual({
      reservationId: 'rsv_notif_1',
      actorId: CUSTOMER_ID,
    });
  });

  it('オーナーが自分の店に対して起こした操作では通知を作らない', async () => {
    const created = await createNotification(createDatabase(world.d1), OWNER_ACTOR, {
      ...BASE_INPUT,
      target: { kind: 'shop-owner', shopId: OWNED_SHOP_ID },
    });

    expect(created).toBe(false);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('オーナーのいない店には通知を作らない', async () => {
    const created = await createNotification(createDatabase(world.d1), CUSTOMER_ACTOR, {
      ...BASE_INPUT,
      target: { kind: 'shop-owner', shopId: ORPHAN_SHOP_ID },
    });

    expect(created).toBe(false);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('存在しない店では通知を作らない（例外も投げない）', async () => {
    const created = await createNotification(createDatabase(world.d1), CUSTOMER_ACTOR, {
      ...BASE_INPUT,
      target: { kind: 'shop-owner', shopId: toShopId('shp_notif_nope') },
    });

    expect(created).toBe(false);
  });
});

describe('createNotification（宛先が利用者）', () => {
  it('利用者宛に 1 件作られる', async () => {
    const created = await createNotification(createDatabase(world.d1), OWNER_ACTOR, {
      ...BASE_INPUT,
      type: 'reservation_confirmed',
      title: '予約が確定しました',
      target: { kind: 'user', userId: toUserId(CUSTOMER_ID) },
    });

    expect(created).toBe(true);
    const row = await readRow(world, 'SELECT user_id, type FROM notifications');
    expect(row?.user_id).toBe(CUSTOMER_ID);
    expect(row?.type).toBe('reservation_confirmed');
  });

  it('自分自身宛には作らない（自分の店を自分で予約した場合）', async () => {
    const created = await createNotification(createDatabase(world.d1), OWNER_ACTOR, {
      ...BASE_INPUT,
      type: 'reservation_confirmed',
      title: '予約が確定しました',
      target: { kind: 'user', userId: toUserId(OWNER_ID) },
    });

    expect(created).toBe(false);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('退会済み（user 行が無い）の宛先には作らない', async () => {
    const created = await createNotification(createDatabase(world.d1), OWNER_ACTOR, {
      ...BASE_INPUT,
      type: 'reservation_confirmed',
      title: '予約が確定しました',
      target: { kind: 'user', userId: toUserId('usr_notif_gone') },
    });

    expect(created).toBe(false);
  });

  it('未読で作られる（read_at は NULL）', async () => {
    await createNotification(createDatabase(world.d1), OWNER_ACTOR, {
      ...BASE_INPUT,
      type: 'reservation_confirmed',
      title: '予約が確定しました',
      target: { kind: 'user', userId: toUserId(CUSTOMER_ID) },
    });

    const row = await readRow(world, 'SELECT read_at FROM notifications');
    expect(row?.read_at).toBeNull();
  });
});
```

- [ ] **Step 3: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- notification-repository
```

期待: `Failed to resolve import "./notification-repository"` で FAIL。

- [ ] **Step 4: 通知リポジトリを実装する**

`apps/api/src/repositories/notification-repository.ts`:

```ts
// 通知レコードの唯一の作成点。
//
// 宛先の決定は **SQL の WHERE 句**に置く。
// 「オーナーのいない店」「自分の操作で自分に届く通知」をハンドラの if で落とすと、
// 通知を出す経路が増えるたびに書き漏れる。

import { toUserId } from '@meshimap/core';
import type { ShopId, UserId } from '@meshimap/core';
import { and, eq, ne } from 'drizzle-orm';
import type { Actor } from '../auth/actor';
import type { Database } from '../db/client';
import type { NotificationType } from '../db/constants';
import { notifications, shops, user } from '../db/schema';
import { generateNotificationId } from '../lib/parse-id';

/** 宛先の指定方法。店に届けるなら店舗 ID、利用者に届けるならユーザー ID */
export type NotificationTarget =
  | { readonly kind: 'user'; readonly userId: UserId }
  | { readonly kind: 'shop-owner'; readonly shopId: ShopId };

export type NotificationInput = {
  readonly target: NotificationTarget;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string;
  /** 遷移先を決める識別子だけを入れる（admin.ts の設計方針） */
  readonly data: Readonly<Record<string, string>>;
};

/**
 * 宛先を 1 人に絞る。宛先が居なければ null。
 *
 * `shop-owner` の側で `owner_id IS NOT NULL` を書いていないのは、SQLite の三値論理で
 * `NULL <> 'usr_x'` が UNKNOWN になり、その行が WHERE を通らないため。
 * オーナー不在の店は `ne()` だけで「宛先なし」に落ちる。
 */
async function findRecipientId(
  db: Database,
  actor: Actor,
  target: NotificationTarget,
): Promise<UserId | null> {
  if (target.kind === 'user') {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      // 退会済み（user 行が無い）と自分自身宛を、同じ 1 本のクエリで落とす
      .where(and(eq(user.id, target.userId), ne(user.id, actor.userId)))
      .limit(1);
    const id = rows[0]?.id ?? null;
    return id === null ? null : toUserId(id);
  }

  const rows = await db
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, target.shopId), ne(shops.ownerId, actor.userId)))
    .limit(1);
  const ownerId = rows[0]?.ownerId ?? null;
  return ownerId === null ? null : toUserId(ownerId);
}

/** 通知を 1 件作る。宛先が居なければ false を返す（例外にしない） */
export async function createNotification(
  db: Database,
  actor: Actor,
  input: NotificationInput,
): Promise<boolean> {
  const recipientId = await findRecipientId(db, actor, input.target);
  if (recipientId === null) {
    return false;
  }

  await db.insert(notifications).values({
    id: generateNotificationId(),
    userId: recipientId,
    type: input.type,
    title: input.title,
    body: input.body,
    // 「誰の操作で出た通知か」を画面に出せるようにする。本文は再構成しない
    data: { ...input.data, actorId: actor.userId },
  });

  return true;
}
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- notification-repository
```

期待: 9 本すべて PASS。

- [ ] **Step 6: わざと壊してテストが落ちることを確認する**

(a) `findRecipientId` の `ne(user.id, actor.userId)` を消す:

→ 「自分自身宛には作らない（自分の店を自分で予約した場合）」が FAIL（1 件作られる）。

(b) `findRecipientId` の `ne(shops.ownerId, actor.userId)` を消す:

→ 「オーナーが自分の店に対して起こした操作では通知を作らない」と「オーナーのいない店には通知を作らない」の 2 本が FAIL。**`ne()` 1 つで 2 つのルールを担っている**ことがこれで見える。

(c) `data: { ...input.data, actorId: actor.userId }` を `data: input.data` に変える:

→ 「data に操作した本人の id が入る」が FAIL。

(d) `recipientId === null` の分岐を消して `recipientId ?? actor.userId` を入れる:

→ 「存在しない店では通知を作らない」と「退会済みの宛先には作らない」が FAIL（自分宛に作られてしまう）。

4 つとも確認したら元に戻す。

- [ ] **Step 7: 通知サービスの失敗するテストを書く**

`apps/api/src/services/reservation-notification-service.test.ts`:

```ts
import { toReservationId, toShopId, toUserId } from '@meshimap/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/client';
import { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH } from '../db/schema/admin';
import * as logger from '../lib/logger';
import * as notificationRepository from '../repositories/notification-repository';
import {
  buildActorForTest,
  countRows,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import {
  RESERVATION_NOTIFICATION_TITLES,
  buildReservationNotificationBody,
  notifyReservationEvent,
} from './reservation-notification-service';
import type { ReservationNotificationEvent } from './reservation-notification-service';

let world: TestWorld;

const OWNER_ID = 'usr_rnotif_owner';
const CUSTOMER_ID = 'usr_rnotif_customer';
const SHOP_ID = toShopId('shp_rnotif_0001');

/** 2026-10-01 18:00 JST = 2026-10-01T09:00:00Z */
const RESERVED_AT = new Date(Date.parse('2026-10-01T09:00:00Z'));

const CUSTOMER_ACTOR = buildActorForTest(CUSTOMER_ID, 'user');
const OWNER_ACTOR = buildActorForTest(OWNER_ID, 'owner');

const REQUESTED_EVENT: ReservationNotificationEvent = {
  type: 'reservation_requested',
  target: { kind: 'shop-owner', shopId: SHOP_ID },
  reservationId: toReservationId('rsv_rnotif_1'),
  shopName: '通知サービス店',
  reservedAt: RESERVED_AT,
  partySize: 2,
};

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: OWNER_ID, role: 'owner' });
  await seedUser(world, { userId: CUSTOMER_ID, role: 'user' });
  await seedShop(world, {
    id: SHOP_ID,
    ownerId: OWNER_ID,
    name: '通知サービス店',
    status: 'published',
  });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await runWrite(world, 'DELETE FROM notifications');
});

afterAll(async () => {
  await world.dispose();
});

describe('buildReservationNotificationBody', () => {
  it('店名・JST の日時・人数を並べる', () => {
    expect(buildReservationNotificationBody(REQUESTED_EVENT)).toBe(
      '通知サービス店 / 2026-10-01 18:00 / 2名',
    );
  });

  it('実行環境の TZ に依存しない（UTC 15:00 は翌日 0:00 JST）', () => {
    const body = buildReservationNotificationBody({
      ...REQUESTED_EVENT,
      reservedAt: new Date(Date.parse('2026-10-01T15:00:00Z')),
    });
    expect(body).toBe('通知サービス店 / 2026-10-02 0:00 / 2名');
  });

  it('店名が上限（100 文字）でも本文が上限に収まる', () => {
    const body = buildReservationNotificationBody({
      ...REQUESTED_EVENT,
      shopName: 'あ'.repeat(100),
      partySize: 20,
    });
    expect(body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_LENGTH);
  });
});

describe('RESERVATION_NOTIFICATION_TITLES', () => {
  it('4 種類すべてに見出しがある', () => {
    expect(Object.keys(RESERVATION_NOTIFICATION_TITLES).sort()).toEqual([
      'reservation_cancelled',
      'reservation_confirmed',
      'reservation_rejected',
      'reservation_requested',
    ]);
  });

  it('どの見出しも上限（100 文字）に収まる', () => {
    for (const title of Object.values(RESERVATION_NOTIFICATION_TITLES)) {
      expect(title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX_LENGTH);
    }
  });

  it('どの見出しにも店名を埋める余地がない（固定文言である）', () => {
    for (const title of Object.values(RESERVATION_NOTIFICATION_TITLES)) {
      expect(title).not.toContain('{');
    }
  });
});

describe('notifyReservationEvent', () => {
  it('申込の通知が店舗オーナー宛に作られる', async () => {
    await notifyReservationEvent(createDatabase(world.d1), CUSTOMER_ACTOR, REQUESTED_EVENT);

    const row = await readRow(world, 'SELECT user_id, type, title, body FROM notifications');
    expect(row?.user_id).toBe(OWNER_ID);
    expect(row?.title).toBe('予約の申し込みが届きました');
    expect(row?.body).toBe('通知サービス店 / 2026-10-01 18:00 / 2名');
  });

  it('data に予約 ID が入る（通知から予約詳細へ飛べるように）', async () => {
    await notifyReservationEvent(createDatabase(world.d1), CUSTOMER_ACTOR, REQUESTED_EVENT);

    const row = await readRow(world, 'SELECT data FROM notifications');
    expect(JSON.parse(String(row?.data))).toMatchObject({ reservationId: 'rsv_rnotif_1' });
  });

  it('確定の通知は利用者宛に作られる', async () => {
    await notifyReservationEvent(createDatabase(world.d1), OWNER_ACTOR, {
      ...REQUESTED_EVENT,
      type: 'reservation_confirmed',
      target: { kind: 'user', userId: toUserId(CUSTOMER_ID) },
    });

    const row = await readRow(world, 'SELECT user_id, title FROM notifications');
    expect(row?.user_id).toBe(CUSTOMER_ID);
    expect(row?.title).toBe('予約が確定しました');
  });

  it('通知の作成が失敗しても例外を投げず、logError に 1 回だけ記録する', async () => {
    const logErrorSpy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);
    vi.spyOn(notificationRepository, 'createNotification').mockRejectedValue(
      new Error('D1_ERROR: forced'),
    );

    await expect(
      notifyReservationEvent(createDatabase(world.d1), CUSTOMER_ACTOR, REQUESTED_EVENT),
    ).resolves.toBeUndefined();

    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy.mock.calls[0]?.[0]).toBe('予約通知の作成に失敗した');
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('宛先が居なくても logError は呼ばない（失敗ではないため）', async () => {
    const logErrorSpy = vi.spyOn(logger, 'logError').mockImplementation(() => undefined);

    await notifyReservationEvent(createDatabase(world.d1), OWNER_ACTOR, {
      ...REQUESTED_EVENT,
      target: { kind: 'user', userId: toUserId(OWNER_ID) },
    });

    expect(logErrorSpy).not.toHaveBeenCalled();
  });
});
```

**`vi.spyOn(notificationRepository, 'createNotification')` が効かないと言われたら。** Vitest は ESM の名前空間オブジェクトを直接書き換えられない場合がある。その場合は `vi.mock('../repositories/notification-repository', ...)` に切り替える。**「効かないからテストを消す」は選択肢にない。** 失敗したときに握ることこそがこのテストで守りたい振る舞いである。

- [ ] **Step 8: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-notification-service
```

期待: `Failed to resolve import "./reservation-notification-service"` で FAIL。

- [ ] **Step 9: 通知サービスを実装する**

`apps/api/src/services/reservation-notification-service.ts`:

```ts
// 予約にまつわる 4 種類の通知の、文言と宛先を決める唯一の場所。
//
// 呼び出し側（申込サービス・キャンセルルート・状態変更サービス）は
// 「何が起きたか」だけを渡す。文言の組み立てをここに閉じ込めないと、
// 3 か所で少しずつ違う日本語が出る。

import { formatMinuteOfDay, toJstClock } from '@meshimap/core';
import type { ReservationId } from '@meshimap/core';
import type { Actor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  NOTIFICATION_TYPE_RESERVATION_CANCELLED,
  NOTIFICATION_TYPE_RESERVATION_CONFIRMED,
  NOTIFICATION_TYPE_RESERVATION_REJECTED,
  NOTIFICATION_TYPE_RESERVATION_REQUESTED,
} from '../db/constants';
import { logError } from '../lib/logger';
import { createNotification } from '../repositories/notification-repository';
import type { NotificationTarget } from '../repositories/notification-repository';

/** 予約フローで出る通知だけに絞ったユニオン。NotificationType 全体より狭い */
export type ReservationNotificationType =
  | typeof NOTIFICATION_TYPE_RESERVATION_REQUESTED
  | typeof NOTIFICATION_TYPE_RESERVATION_CONFIRMED
  | typeof NOTIFICATION_TYPE_RESERVATION_REJECTED
  | typeof NOTIFICATION_TYPE_RESERVATION_CANCELLED;

export type ReservationNotificationEvent = {
  readonly type: ReservationNotificationType;
  readonly target: NotificationTarget;
  readonly reservationId: ReservationId;
  readonly shopName: string;
  readonly reservedAt: Date;
  readonly partySize: number;
};

/**
 * 見出しは**固定文言**にする。
 * 店名（最大 100 文字）を入れると NOTIFICATION_TITLE_MAX_LENGTH（100）を必ず超える。
 * 店名は本文に回す。
 */
export const RESERVATION_NOTIFICATION_TITLES: Record<ReservationNotificationType, string> = {
  [NOTIFICATION_TYPE_RESERVATION_REQUESTED]: '予約の申し込みが届きました',
  [NOTIFICATION_TYPE_RESERVATION_CONFIRMED]: '予約が確定しました',
  [NOTIFICATION_TYPE_RESERVATION_REJECTED]: '予約をお受けできませんでした',
  [NOTIFICATION_TYPE_RESERVATION_CANCELLED]: '予約がキャンセルされました',
};

/** 本文の項目を区切る文字 */
const BODY_SEPARATOR = ' / ';
/** 人数の単位 */
const PARTY_SIZE_SUFFIX = '名';
/** 通知の失敗を記録するときの文言。テストがこの文字列を突き合わせる */
const NOTIFICATION_FAILURE_MESSAGE = '予約通知の作成に失敗した';

/**
 * 本文を組み立てる。
 * `reserved_at` はエポックミリ秒なので、JST への変換は必ず `toJstClock` に通す。
 * `Date#getHours()` は実行環境の TZ で結果が変わるため使わない。
 */
export function buildReservationNotificationBody(event: ReservationNotificationEvent): string {
  const clock = toJstClock(event.reservedAt);
  return [
    event.shopName,
    `${clock.date} ${formatMinuteOfDay(clock.minuteOfDay)}`,
    `${event.partySize}${PARTY_SIZE_SUFFIX}`,
  ].join(BODY_SEPARATOR);
}

/**
 * 通知を 1 件出す。**失敗しても投げない。**
 *
 * D1 に対話型トランザクションが無いので、通知の失敗で予約の更新は巻き戻せない。
 * 予約そのものは成立しているのに 500 を返すと、利用者が同じ操作を繰り返して二重申込になる。
 * 通知は後追いで再送できる情報なので、ここは記録だけ残して握る。
 */
export async function notifyReservationEvent(
  db: Database,
  actor: Actor,
  event: ReservationNotificationEvent,
): Promise<void> {
  try {
    await createNotification(db, actor, {
      target: event.target,
      type: event.type,
      title: RESERVATION_NOTIFICATION_TITLES[event.type],
      body: buildReservationNotificationBody(event),
      data: { reservationId: event.reservationId },
    });
  } catch (error) {
    logError(NOTIFICATION_FAILURE_MESSAGE, error);
  }
}
```

- [ ] **Step 10: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-notification-service
```

期待: 10 本すべて PASS。

- [ ] **Step 11: わざと壊してテストが落ちることを確認する**

(a) `toJstClock(event.reservedAt)` を `{ date: '2026-10-01', minuteOfDay: 1080 }` の直値に変える:

→ 「実行環境の TZ に依存しない（UTC 15:00 は翌日 0:00 JST）」が FAIL。

(b) `RESERVATION_NOTIFICATION_TITLES` の `reservation_confirmed` を `` `${'{shopName}'}の予約が確定しました` `` に変える:

→ 「どの見出しにも店名を埋める余地がない（固定文言である）」が FAIL。

(c) `try` / `catch` を外す:

→ 「通知の作成が失敗しても例外を投げず、logError に 1 回だけ記録する」が FAIL（`Error: D1_ERROR: forced` が漏れる）。

(d) `catch` の中で `logError` を呼ばずに握るだけにする:

→ 同じテストが `toHaveBeenCalledTimes(1)` で FAIL。**握るだけで記録しないのは、障害に気づけないという意味で握り潰しと同じ。**

(e) `catch` の外側でも `logError` を呼ぶようにする（`finally` に移す）:

→ 「宛先が居なくても logError は呼ばない（失敗ではないため）」が FAIL。

5 つとも確認したら元に戻す。

- [ ] **Step 12: コミット（通知の土台まで）**

```bash
git add apps/api/src/db/schema/admin.ts apps/api/src/repositories/notification-repository.ts apps/api/src/repositories/notification-repository.test.ts apps/api/src/services/reservation-notification-service.ts apps/api/src/services/reservation-notification-service.test.ts
git commit -m "feat(api): 予約通知の作成を足す"
```

- [ ] **Step 13: 状態変更サービスの失敗するテストを書く**

`apps/api/src/services/reservation-status-service.test.ts`:

```ts
import { toReservationId, toShopId } from '@meshimap/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import {
  buildActorForTest,
  countRows,
  createTestWorld,
  ownerActorOrThrow,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  type TestWorld,
} from '../test/fixtures';
import { changeReservationStatus } from './reservation-status-service';

let world: TestWorld;

const MY_SHOP_ID = toShopId('shp_stsvc_0001');
const RIVAL_SHOP_ID = toShopId('shp_stsvc_0002');
const ME = 'usr_stsvc_me';
const RIVAL = 'usr_stsvc_rival';
const CUSTOMER = 'usr_stsvc_customer';

/** owner に絞った Actor。fixtures の型ガードを通すので as を書かずに済む */
function ownerActor(userId: string): OwnerActor {
  return ownerActorOrThrow(buildActorForTest(userId, 'owner'));
}

async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM notifications');
  await runWrite(world, 'DELETE FROM reservations');
  const rows: readonly [string, string, string][] = [
    ['rsv_stsvc_pending', MY_SHOP_ID, 'pending'],
    ['rsv_stsvc_confirmed', MY_SHOP_ID, 'confirmed'],
    ['rsv_stsvc_done', MY_SHOP_ID, 'completed'],
    ['rsv_stsvc_rival', RIVAL_SHOP_ID, 'pending'],
  ];
  for (const [id, shopId, status] of rows) {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      shopId,
      CUSTOMER,
      Date.parse('2026-10-01T09:00:00Z'),
      2,
      '',
      status,
    );
  }
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  await seedUser(world, { userId: ME, role: 'owner' });
  await seedUser(world, { userId: RIVAL, role: 'owner' });
  await seedUser(world, { userId: CUSTOMER, role: 'user', displayName: '山田太郎' });
  await seedShop(world, { id: MY_SHOP_ID, ownerId: ME, name: '自分の店', status: 'published' });
  await seedShop(world, {
    id: RIVAL_SHOP_ID,
    ownerId: RIVAL,
    name: 'よその店',
    status: 'published',
  });
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});

describe('changeReservationStatus', () => {
  it('pending → confirmed に動かせて、更新後の行を返す', async () => {
    const outcome = await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_pending'),
      'confirmed',
    );

    expect(outcome.kind).toBe('changed');
    if (outcome.kind === 'changed') {
      expect(outcome.row.status).toBe('confirmed');
      expect(outcome.row.customerName).toBe('山田太郎');
    }
  });

  it('承認すると利用者宛に reservation_confirmed の通知が 1 件作られる', async () => {
    await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_pending'),
      'confirmed',
    );

    const row = await readRow(world, 'SELECT user_id, type FROM notifications');
    expect(row?.user_id).toBe(CUSTOMER);
    expect(row?.type).toBe('reservation_confirmed');
  });

  it('拒否すると reservation_rejected の通知が作られる', async () => {
    await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_pending'),
      'rejected',
    );

    const row = await readRow(world, 'SELECT type FROM notifications');
    expect(row?.type).toBe('reservation_rejected');
  });

  it('来店（completed）では通知を作らない（利用者に知らせる意味がない）', async () => {
    await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_confirmed'),
      'completed',
    );

    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('無断キャンセル（no_show）でも通知を作らない', async () => {
    await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_confirmed'),
      'no_show',
    );

    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('許されない遷移は invalid-transition を返し、行も通知も変わらない', async () => {
    const outcome = await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_pending'),
      'completed',
    );

    expect(outcome.kind).toBe('invalid-transition');
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_stsvc_pending',
    );
    expect(row?.status).toBe('pending');
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
  });

  it('終端状態からの遷移も invalid-transition', async () => {
    const outcome = await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_done'),
      'confirmed',
    );

    expect(outcome.kind).toBe('invalid-transition');
  });

  it('よその店の予約は not-found（invalid-transition と区別する）', async () => {
    const outcome = await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_rival'),
      'confirmed',
    );

    expect(outcome.kind).toBe('not-found');
  });

  it('存在しない予約も not-found', async () => {
    const outcome = await changeReservationStatus(
      createDatabase(world.d1),
      ownerActor(ME),
      toReservationId('rsv_stsvc_nope'),
      'confirmed',
    );

    expect(outcome.kind).toBe('not-found');
  });

  it('同じ承認を 2 回続けても通知は 1 件しか増えない', async () => {
    const db = createDatabase(world.d1);
    const reservationId = toReservationId('rsv_stsvc_pending');
    await changeReservationStatus(db, ownerActor(ME), reservationId, 'confirmed');
    // 2 回目は WHERE 句が 0 行になるので invalid-transition。通知の経路まで進まない
    await changeReservationStatus(db, ownerActor(ME), reservationId, 'confirmed');

    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(1);
  });
});
```

- [ ] **Step 14: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- reservation-status-service
```

期待: `Failed to resolve import "./reservation-status-service"` で FAIL。

- [ ] **Step 15: 状態変更サービスを実装する**

`apps/api/src/services/reservation-status-service.ts`:

```ts
// 店舗側の状態遷移。「更新する → 更新後の行を読む → 通知する」の 3 手を 1 か所にまとめる。
//
// 「更新できるか」を先に読んで if で判定しない。読んでから書くまでの間に
// 別のリクエストが状態を動かす隙間ができるため。判定は UPDATE の WHERE 句に任せ、
// **0 行だったという結果**から理由を組み立てる。

import type { ReservationId } from '@meshimap/core';
import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import {
  NOTIFICATION_TYPE_RESERVATION_CONFIRMED,
  NOTIFICATION_TYPE_RESERVATION_REJECTED,
} from '../db/constants';
import type { ReservationStatus } from '../db/constants';
import {
  findShopReservation,
  updateReservationStatus,
} from '../repositories/owner-reservation-repository';
import type { OwnerReservationRow } from '../repositories/owner-reservation-repository';
import { notifyReservationEvent } from './reservation-notification-service';
import type { ReservationNotificationType } from './reservation-notification-service';

export type ChangeStatusOutcome =
  | { readonly kind: 'changed'; readonly row: OwnerReservationRow }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid-transition' };

/**
 * 遷移先ごとの通知種別。
 * `completed` / `no_show` は「店が記録を付けた」だけで、利用者に知らせる意味がないので載せない。
 * `Partial` にしてあるので、載っていない状態を引くと undefined になる。
 */
const STATUS_NOTIFICATION_TYPES: Partial<Record<ReservationStatus, ReservationNotificationType>> = {
  confirmed: NOTIFICATION_TYPE_RESERVATION_CONFIRMED,
  rejected: NOTIFICATION_TYPE_RESERVATION_REJECTED,
};

export async function changeReservationStatus(
  db: Database,
  actor: OwnerActor,
  reservationId: ReservationId,
  to: ReservationStatus,
): Promise<ChangeStatusOutcome> {
  const changed = await updateReservationStatus(db, actor, reservationId, to);
  // 成功しても失敗しても更新後の姿を読む。
  // 成功時は応答に載せるため、失敗時は not-found と invalid-transition を分けるため
  const row = await findShopReservation(db, actor, reservationId);

  if (row === null) {
    // 行が無い / 自店ではない。どちらも外からは区別させない
    return { kind: 'not-found' };
  }
  if (!changed) {
    // 自店の行はあるが、その遷移は遷移表に無い
    return { kind: 'invalid-transition' };
  }

  const notificationType = STATUS_NOTIFICATION_TYPES[to];
  if (notificationType !== undefined) {
    await notifyReservationEvent(db, actor, {
      type: notificationType,
      target: { kind: 'user', userId: row.userId },
      reservationId: row.id,
      shopName: row.shopName,
      reservedAt: row.reservedAt,
      partySize: row.partySize,
    });
  }

  return { kind: 'changed', row };
}
```

- [ ] **Step 16: テストが通ることを確認する**

```bash
npm test -w @meshimap/api -- reservation-status-service
```

期待: 10 本すべて PASS。

- [ ] **Step 17: わざと壊してテストが落ちることを確認する**

(a) `row === null` と `!changed` の順番を入れ替える:

→ 「よその店の予約は not-found」は通るが、**「許されない遷移は invalid-transition を返し」が FAIL**（`not-found` が返る）。順番に意味があることの確認。

(b) `STATUS_NOTIFICATION_TYPES` に `completed: NOTIFICATION_TYPE_RESERVATION_CONFIRMED` を足す:

→ 「来店（completed）では通知を作らない」が FAIL。

(c) `notificationType !== undefined` の分岐を消して常に通知する:

→ (b) と同じテストに加え「無断キャンセル（no_show）でも通知を作らない」も FAIL（`RESERVATION_NOTIFICATION_TITLES[undefined]` が undefined になり、`title` の NOT NULL 制約で落ちる経路も観測できる）。

(d) 通知を `changed` の判定より前に出す:

→ 「同じ承認を 2 回続けても通知は 1 件しか増えない」が FAIL（2 件になる）。

4 つとも確認したら元に戻す。

- [ ] **Step 18: 応答の整形に店舗向けを足す（失敗するテストから）**

`apps/api/src/routes/reservation-response.test.ts` に追記する:

```ts
import { toOwnerReservationResponse } from './reservation-response';

describe('toOwnerReservationResponse', () => {
  const OWNER_ROW = {
    ...ROW,
    userId: toUserId('usr_resp_customer'),
    customerName: '山田太郎',
    ownerMemo: 'アレルギー: 甲殻類',
  } as const;

  it('利用者向けの項目に加えて予約者とメモを載せる', () => {
    expect(toOwnerReservationResponse(OWNER_ROW)).toEqual({
      id: 'rsv_resp_1',
      shopId: 'shp_resp_1',
      shopName: 'レスポンス店',
      reservedAt: '2026-10-01T09:00:00.000Z',
      partySize: 2,
      note: '窓際希望',
      status: 'pending',
      createdAt: '2026-09-20T00:00:00.000Z',
      userId: 'usr_resp_customer',
      customerName: '山田太郎',
      ownerMemo: 'アレルギー: 甲殻類',
    });
  });
});
```

`toUserId` を import に足すこと。`ROW` と `createdAt` の値は Task 7-10 Step 1 で置いたものをそのまま使う。

- [ ] **Step 19: `toOwnerReservationResponse` を実装する**

`apps/api/src/routes/reservation-response.ts` に追記する:

```ts
import type { OwnerReservationRow } from '../repositories/owner-reservation-repository';

/**
 * 店舗向けの応答。利用者向けに予約者とメモを足しただけ。
 * **利用者向けの `toReservationResponse` にこれらを混ぜてはいけない。**
 * `ownerMemo` は店だけのものなので、利用者の応答に漏れると事故になる。
 */
export type OwnerReservationResponse = ReservationResponse & {
  readonly userId: string;
  readonly customerName: string;
  readonly ownerMemo: string;
};

export function toOwnerReservationResponse(row: OwnerReservationRow): OwnerReservationResponse {
  return {
    ...toReservationResponse(row),
    userId: row.userId,
    customerName: row.customerName,
    ownerMemo: row.ownerMemo,
  };
}
```

- [ ] **Step 20: 店舗側ルートの失敗するテストを書く**

`apps/api/src/routes/owner-reservations.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index';
import {
  createTestBindings,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  signUpAs,
  type TestUser,
  type TestWorld,
} from '../test/fixtures';

let world: TestWorld;
let owner: TestUser;
let rival: TestUser;
let customer: TestUser;

const MY_SHOP_ID = 'shp_oroute_0001';
const RIVAL_SHOP_ID = 'shp_oroute_0002';

async function request(
  path: string,
  cookie: string | undefined,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    createTestBindings(world),
  );
}

async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM notifications');
  await runWrite(world, 'DELETE FROM reservations');
  const rows: readonly [string, string, number, string][] = [
    // 2026-10-01 18:00 JST
    ['rsv_oroute_pending', MY_SHOP_ID, Date.parse('2026-10-01T09:00:00Z'), 'pending'],
    // 2026-10-02 18:00 JST
    ['rsv_oroute_next', MY_SHOP_ID, Date.parse('2026-10-02T09:00:00Z'), 'confirmed'],
    ['rsv_oroute_rival', RIVAL_SHOP_ID, Date.parse('2026-10-01T09:00:00Z'), 'pending'],
  ];
  for (const [id, shopId, reservedAt, status] of rows) {
    await runWrite(
      world,
      'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      shopId,
      customer.userId,
      reservedAt,
      2,
      '窓際希望',
      status,
    );
  }
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);
  owner = await signUpAs(world, 'oroute-owner@example.com', 'owner');
  rival = await signUpAs(world, 'oroute-rival@example.com', 'owner');
  customer = await signUpAs(world, 'oroute-customer@example.com', 'user');
  await seedShop(world, {
    id: MY_SHOP_ID,
    ownerId: owner.userId,
    name: '自分の店',
    status: 'published',
  });
  await seedShop(world, {
    id: RIVAL_SHOP_ID,
    ownerId: rival.userId,
    name: 'よその店',
    status: 'published',
  });
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});

describe('GET /owner/reservations', () => {
  it('未ログインは 401', async () => {
    expect((await request('/owner/reservations', undefined)).status).toBe(401);
  });

  it('user ロールは 403（行の有無ではなくロールで弾く）', async () => {
    expect((await request('/owner/reservations', customer.cookie)).status).toBe(403);
  });

  it('自店の予約だけを返す', async () => {
    const response = await request('/owner/reservations', owner.cookie);
    expect(response.status).toBe(200);
    const body = await response.json<{ reservations: readonly { id: string }[] }>();
    expect(body.reservations.map((row) => row.id)).toEqual([
      'rsv_oroute_pending',
      'rsv_oroute_next',
    ]);
  });

  it('予約者の表示名とメモ欄を載せる', async () => {
    const response = await request('/owner/reservations', owner.cookie);
    const body = await response.json<{ reservations: readonly Record<string, unknown>[] }>();
    expect(body.reservations[0]).toMatchObject({
      customerName: 'oroute-customer@example.com',
      ownerMemo: '',
      note: '窓際希望',
    });
  });

  it('date で絞れる', async () => {
    const response = await request('/owner/reservations?date=2026-10-02', owner.cookie);
    const body = await response.json<{ reservations: readonly { id: string }[] }>();
    expect(body.reservations.map((row) => row.id)).toEqual(['rsv_oroute_next']);
  });

  it('status で絞れる', async () => {
    const response = await request('/owner/reservations?status=pending', owner.cookie);
    const body = await response.json<{ reservations: readonly { id: string }[] }>();
    expect(body.reservations.map((row) => row.id)).toEqual(['rsv_oroute_pending']);
  });

  it('知らない status は 422', async () => {
    expect((await request('/owner/reservations?status=unknown', owner.cookie)).status).toBe(422);
  });

  it('日付の形が壊れていたら 422', async () => {
    expect((await request('/owner/reservations?date=2026-13-40', owner.cookie)).status).toBe(422);
  });
});

describe('GET /owner/reservations/:reservationId', () => {
  it('自店の予約は 200', async () => {
    const response = await request('/owner/reservations/rsv_oroute_pending', owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'rsv_oroute_pending',
      status: 'pending',
      customerName: 'oroute-customer@example.com',
    });
  });

  it('よその店の予約は 404', async () => {
    expect((await request('/owner/reservations/rsv_oroute_rival', owner.cookie)).status).toBe(404);
  });

  it('user ロールは 403（404 ではない。ロールの問題だから）', async () => {
    expect((await request('/owner/reservations/rsv_oroute_pending', customer.cookie)).status).toBe(
      403,
    );
  });
});

describe('POST /owner/reservations/:reservationId/status', () => {
  it('承認できて 200 を返す', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/status',
      owner.cookie,
      'POST',
      { status: 'confirmed' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'rsv_oroute_pending', status: 'confirmed' });
  });

  it('承認すると DB の行も変わる', async () => {
    await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST', {
      status: 'confirmed',
    });
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_oroute_pending',
    );
    expect(row?.status).toBe('confirmed');
  });

  it('承認すると予約者宛の通知が 1 件できる', async () => {
    await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST', {
      status: 'confirmed',
    });
    const row = await readRow(world, 'SELECT user_id, type FROM notifications');
    expect(row?.user_id).toBe(customer.userId);
    expect(row?.type).toBe('reservation_confirmed');
  });

  it('拒否もできる', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/status',
      owner.cookie,
      'POST',
      { status: 'rejected' },
    );
    expect(response.status).toBe(200);
  });

  it('遷移表にない遷移は 422', async () => {
    expect(
      (
        await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST', {
          status: 'completed',
        })
      ).status,
    ).toBe(422);
  });

  it('cancelled は店舗からは指定できない（利用者の権利）', async () => {
    expect(
      (
        await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST', {
          status: 'cancelled',
        })
      ).status,
    ).toBe(422);
  });

  it('知らない status は 422', async () => {
    expect(
      (
        await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST', {
          status: 'teleported',
        })
      ).status,
    ).toBe(422);
  });

  it('ボディが無いと 422', async () => {
    expect(
      (await request('/owner/reservations/rsv_oroute_pending/status', owner.cookie, 'POST')).status,
    ).toBe(422);
  });

  it('よその店の予約は 404 で、行も通知も変わらない', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_rival/status',
      owner.cookie,
      'POST',
      { status: 'confirmed' },
    );
    expect(response.status).toBe(404);
    const row = await readRow(
      world,
      'SELECT status FROM reservations WHERE id = ?',
      'rsv_oroute_rival',
    );
    expect(row?.status).toBe('pending');
    const notification = await readRow(world, 'SELECT id FROM notifications');
    expect(notification).toBeNull();
  });

  it('user ロールは 403', async () => {
    expect(
      (
        await request('/owner/reservations/rsv_oroute_pending/status', customer.cookie, 'POST', {
          status: 'confirmed',
        })
      ).status,
    ).toBe(403);
  });
});

describe('PATCH /owner/reservations/:reservationId/memo', () => {
  it('メモを書けて 200', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/memo',
      owner.cookie,
      'PATCH',
      { ownerMemo: 'アレルギー: 甲殻類' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ownerMemo: 'アレルギー: 甲殻類' });
  });

  it('空文字で消せる', async () => {
    await request('/owner/reservations/rsv_oroute_pending/memo', owner.cookie, 'PATCH', {
      ownerMemo: 'いったん書く',
    });
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/memo',
      owner.cookie,
      'PATCH',
      { ownerMemo: '' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ownerMemo: '' });
  });

  it('上限ちょうど（500 文字）は通る', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/memo',
      owner.cookie,
      'PATCH',
      { ownerMemo: 'あ'.repeat(500) },
    );
    expect(response.status).toBe(200);
  });

  it('上限 + 1（501 文字）は 422', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_pending/memo',
      owner.cookie,
      'PATCH',
      { ownerMemo: 'あ'.repeat(501) },
    );
    expect(response.status).toBe(422);
  });

  it('メモを書いても通知は出ない（店内の記録だから）', async () => {
    await request('/owner/reservations/rsv_oroute_pending/memo', owner.cookie, 'PATCH', {
      ownerMemo: '常連',
    });
    expect(await readRow(world, 'SELECT id FROM notifications')).toBeNull();
  });

  it('よその店の予約には書けず 404', async () => {
    const response = await request(
      '/owner/reservations/rsv_oroute_rival/memo',
      owner.cookie,
      'PATCH',
      { ownerMemo: '侵入' },
    );
    expect(response.status).toBe(404);
    const row = await readRow(
      world,
      'SELECT owner_memo FROM reservations WHERE id = ?',
      'rsv_oroute_rival',
    );
    expect(row?.owner_memo).toBeNull();
  });

  it('user ロールは 403', async () => {
    expect(
      (
        await request('/owner/reservations/rsv_oroute_pending/memo', customer.cookie, 'PATCH', {
          ownerMemo: '侵入',
        })
      ).status,
    ).toBe(403);
  });
});
```

**`customerName` が `oroute-customer@example.com` になるのはなぜか。** `signUpAs` は Better Auth に `name: email` を渡してサインアップする（`apps/api/src/test/fixtures.ts:243` で確認）。`databaseHooks` が作る `profiles.display_name` はその `name` を引き継ぐため、表示名はメールアドレスと同じ文字列になる。**表示名を別の値にしたければ `signUpAs` ではなく `seedUser` を使うが、その場合セッション Cookie が手に入らない。** ルートのテストはセッションが要るので `signUpAs` を使い、期待値をメールアドレスに合わせる。

- [ ] **Step 21: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/api -- owner-reservations
```

期待: すべて 404（`/owner/reservations` が未定義）で FAIL。401 / 403 のテストも 404 になるので落ちる。

- [ ] **Step 22: 店舗側ルートを実装する**

`apps/api/src/routes/owner-reservations.ts`:

```ts
// 店舗側の予約 API。
//
// ロール（owner かどうか）はミドルウェアで弾く → 403。
// 行の所有者（自店かどうか）はリポジトリの WHERE 句で落とす → 404。
// この 2 つを混ぜない。混ぜると「他店の予約 ID が実在するか」が 403 と 404 の差から漏れる。

import { ROLE_OWNER, toJstDate } from '@meshimap/core';
import { Hono } from 'hono';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { invalidInput, notFound } from '../lib/http-error';
import { parseReservationId } from '../lib/parse-id';
import { requireOwnerActor, roleGuard } from '../middleware/role-guard';
import {
  findShopReservation,
  listShopReservations,
  updateReservationMemo,
} from '../repositories/owner-reservation-repository';
import type { OwnerReservationFilter } from '../repositories/owner-reservation-repository';
import {
  ownerReservationListQuerySchema,
  reservationMemoUpdateSchema,
  reservationStatusUpdateSchema,
} from '../schemas/reservation-schema';
import { changeReservationStatus } from '../services/reservation-status-service';
import { toOwnerReservationResponse } from './reservation-response';

export const ownerReservationRoutes = new Hono<AppEnv>()
  // ロールが違うだけなら 403。ここを通った時点で「owner である」ことは保証される
  .use('*', roleGuard(ROLE_OWNER))
  .get('/', async (c) => {
    const actor = requireOwnerActor(c);
    const parsed = ownerReservationListQuerySchema.safeParse({
      date: c.req.query('date'),
      status: c.req.query('status'),
    });
    if (!parsed.success) {
      throw invalidInput();
    }

    // exactOptionalPropertyTypes が有効なので、undefined を明示的に代入しない。
    // キーごと足さないことで「絞り込み無し」を表す
    const filter: OwnerReservationFilter = {
      ...(parsed.data.date === undefined ? {} : { date: toJstDate(parsed.data.date) }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
    };

    const rows = await listShopReservations(createDatabase(c.env.DB), actor, filter);
    return c.json({ reservations: rows.map(toOwnerReservationResponse) });
  })
  .get('/:reservationId', async (c) => {
    const actor = requireOwnerActor(c);
    const row = await findShopReservation(
      createDatabase(c.env.DB),
      actor,
      parseReservationId(c.req.param('reservationId')),
    );
    if (row === null) {
      throw notFound();
    }
    return c.json(toOwnerReservationResponse(row));
  })
  .post('/:reservationId/status', async (c) => {
    const actor = requireOwnerActor(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = reservationStatusUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidInput();
    }

    const outcome = await changeReservationStatus(
      createDatabase(c.env.DB),
      actor,
      parseReservationId(c.req.param('reservationId')),
      parsed.data.status,
    );

    switch (outcome.kind) {
      case 'not-found':
        throw notFound();
      case 'invalid-transition':
        // 「その遷移はできない」は入力が現在の状態と噛み合っていないということ。
        // リソースの競合ではないので 409 は使わない
        throw invalidInput();
      case 'changed':
        return c.json(toOwnerReservationResponse(outcome.row));
    }
  })
  .patch('/:reservationId/memo', async (c) => {
    const actor = requireOwnerActor(c);
    const raw = await c.req.json().catch(() => null);
    const parsed = reservationMemoUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidInput();
    }

    const db = createDatabase(c.env.DB);
    const reservationId = parseReservationId(c.req.param('reservationId'));
    const written = await updateReservationMemo(db, actor, reservationId, parsed.data.ownerMemo);
    if (!written) {
      // メモは状態に関係なく書ける。0 行ということは「自店の行が無い」しかない
      throw notFound();
    }

    const row = await findShopReservation(db, actor, reservationId);
    if (row === null) {
      // 直前に書けた行が消えているのは整合性の崩れ。握り潰さない
      throw notFound();
    }
    return c.json(toOwnerReservationResponse(row));
  });
```

`apps/api/src/index.ts` にマウントする:

```ts
import { ownerReservationRoutes } from './routes/owner-reservations';

  .route('/owner/reservations', ownerReservationRoutes)
```

**同じコミットで `apps/api/src/routes/permission-matrix.test.ts` の 2 つの配列に 4 行ずつ足す。これで Phase 7 の 9 本が揃い、棚卸しは 19 本になる。** 足さないと次のメッセージになる（`roleGuard` は `.use('*', ...)` で載せるので `ALL /owner/reservations/*` も `app.routes` に現れるが、`collectEndpointPatterns` が `endsWith('*')` で落とすため violations には出てこない。「裏取りした事実 7」で確認済み）:

```
FAIL  ルート表と実装の突合 > app に登録されたエンドポイントは 15 本で、想定どおりの並びである
  - Expected  15 items
  + Received  19 items
FAIL  ルート表と実装の突合 > 権限マトリクスは app のエンドポイントを 1 本残らず覆っている
  - Expected  []
  + Received  [
      '権限マトリクスに無いエンドポイント: GET /owner/reservations',
      '権限マトリクスに無いエンドポイント: GET /owner/reservations/:reservationId',
      '権限マトリクスに無いエンドポイント: PATCH /owner/reservations/:reservationId/memo',
      '権限マトリクスに無いエンドポイント: POST /owner/reservations/:reservationId/status',
    ]
```

Phase 7 完了時の `EXPECTED_ROUTE_PATTERNS`（19 本）:

```ts
/** 権限マトリクスが責任を持つ 19 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /owner/reservations',
  'GET /owner/reservations/:reservationId',
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /owner/reservations/:reservationId/memo',
  'PATCH /shops/:shopId',
  'POST /owner/reservations/:reservationId/status',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];
```

Phase 7 完了時の委譲リスト（9 本。**Task 7-13 の `AUTHORIZATION_CASES` の 9 行と 1 対 1 で対応する**）:

```ts
const DELEGATED_ROUTE_PATTERNS: readonly string[] = [
  'GET /owner/reservations',
  'GET /owner/reservations/:reservationId',
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'PATCH /owner/reservations/:reservationId/memo',
  'POST /owner/reservations/:reservationId/status',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
];
```

- [ ] **Step 23: 申込とキャンセルの通知をつなぐ（失敗するテストから）**

`apps/api/src/routes/reservations.create.test.ts`（Task 7-8）に追記する:

```ts
it('申込が成立すると店舗オーナー宛に reservation_requested の通知ができる', async () => {
  await request('/reservations', customer.cookie, VALID_BODY);

  const row = await readRow(world, 'SELECT user_id, type, body FROM notifications');
  expect(row?.type).toBe('reservation_requested');
  expect(row?.body).toBe('申込ルート店 / 2026-10-01 18:00 / 2名');
});
```

このテストを通すには、Task 7-8 の `beforeAll` の `seedShop` に `ownerId` を入れる必要がある（現状は `ownerId: null`）。`shopOwner = await signUpAs(world, 'post-owner@example.com', 'owner')` を足し、`ownerId: shopOwner.userId` に変える。`readRow` を import に足すこと。

`apps/api/src/routes/reservations.test.ts`（Task 7-10）に追記する:

```ts
it('キャンセルすると店舗オーナー宛に reservation_cancelled の通知ができる', async () => {
  await request('/reservations/rsv_rroute_mine/cancel', me.cookie, 'POST');

  const row = await readRow(world, 'SELECT type FROM notifications');
  expect(row?.type).toBe('reservation_cancelled');
});
```

同じく `seedShop` に `ownerId` を入れ、`beforeEach` の後始末に `DELETE FROM notifications` を足す。

- [ ] **Step 24: 申込サービスに通知を足す**

`apps/api/src/services/reservation-create-service.ts` の `return { kind: 'created', ... }` の直前に入れる:

```ts
// 予約は成立している。通知に失敗しても申込は取り消さない（notifyReservationEvent が握る）
await notifyReservationEvent(db, actor, {
  type: NOTIFICATION_TYPE_RESERVATION_REQUESTED,
  target: { kind: 'shop-owner', shopId: input.shopId },
  reservationId,
  shopName: context.shopName,
  reservedAt,
  partySize: input.partySize,
});
```

import に足すもの:

```ts
import { NOTIFICATION_TYPE_RESERVATION_REQUESTED } from '../db/constants';
import { notifyReservationEvent } from './reservation-notification-service';
```

- [ ] **Step 25: キャンセルのルートに通知を足す**

`apps/api/src/routes/reservations.ts` の `.post('/:reservationId/cancel', ...)` で、更新後の行を読んだ直後・`c.json` を返す直前に入れる。渡す Actor は `requireActor(c)` で得た `actor`（キャンセルした本人）であって、店舗オーナーではない。**「誰の操作か」を渡す引数であり、「誰に届けるか」は `target` が持つ**:

```ts
await notifyReservationEvent(db, actor, {
  type: NOTIFICATION_TYPE_RESERVATION_CANCELLED,
  target: { kind: 'shop-owner', shopId: row.shopId },
  reservationId: row.id,
  shopName: row.shopName,
  reservedAt: row.reservedAt,
  partySize: row.partySize,
});
return c.json(toReservationResponse(row));
```

import に足すもの:

```ts
import { NOTIFICATION_TYPE_RESERVATION_CANCELLED } from '../db/constants';
import { notifyReservationEvent } from '../services/reservation-notification-service';
```

- [ ] **Step 26: すべてのテストが通ることを確認する**

```bash
npm test -w @meshimap/api
npm run typecheck -w @meshimap/api
npm run lint -w @meshimap/api
```

期待: Task 7-12 の追加ぶん（通知リポジトリ 9・通知サービス 10・状態変更サービス 10・応答整形 1・店舗ルート 27・申込 1・キャンセル 1）を含めて全件 PASS。型エラー 0、lint エラー 0。

**ここで `npm test -w @meshimap/api` を絞り込みなしで走らせているのは、Phase 4 の `permission-matrix.test.ts` を必ず巻き込むためである。** 上の配列 2 つを直し忘れていれば、このステップで確実に赤くなる。

- [ ] **Step 27: わざと壊してテストが落ちることを確認する**

(a) `roleGuard(ROLE_OWNER)` を外す:

→ 「user ロールは 403」の 4 本が FAIL（404 や 500 になる）。**ロールの門と所有権の門は別物**であることが見える。

(b) `roleGuard(ROLE_OWNER)` を `roleGuard(ROLE_OWNER, ROLE_USER)` に変える:

→ 同じ 4 本が FAIL。**「admin も owner も通す」のような安易な緩和がテストで止まる。**

(c) `PATCH /memo` の `written` の判定を消して常に `findShopReservation` の結果を返す:

→ 「よその店の予約には書けず 404」は通る（`findShopReservation` も null を返すので）。しかし **(c) は通ってしまう**ので、代わりに `updateReservationMemo` の呼び出しごと消す:

→ 「メモを書けて 200」が FAIL（`ownerMemo` が空のまま返る）。

(d) `GET /` の `filter` を常に `{}` にする:

→ 「date で絞れる」と「status で絞れる」が FAIL。

(e) `POST /status` の `case 'not-found'` と `case 'invalid-transition'` を入れ替える:

→ 「遷移表にない遷移は 422」と「よその店の予約は 404 で、行も通知も変わらない」が両方 FAIL。

(f) `toOwnerReservationResponse` を `toReservationResponse` に変える:

→ 「予約者の表示名とメモ欄を載せる」が FAIL（`customerName` が undefined）。

(g) 申込サービスの `target` を `{ kind: 'user', userId: actor.userId }` に変える:

→ 「申込が成立すると店舗オーナー宛に reservation_requested の通知ができる」が FAIL（宛先が自分なので `createNotification` が false を返し、通知が 0 件になる）。

(h) `permission-matrix.test.ts` の `DELEGATABLE_PATH_PATTERN` から `owner\/reservations` を消す:

→ 「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」が FAIL（委譲リスト 9 本に対し、予約系と認識されるのが 5 本になる）。**委譲の入口を広げすぎない仕掛けが効いている**ことの確認。

8 つとも確認したら元に戻す。

- [ ] **Step 28: コミット**

```bash
git add apps/api/src/routes/owner-reservations.ts apps/api/src/routes/owner-reservations.test.ts apps/api/src/routes/reservation-response.ts apps/api/src/routes/reservation-response.test.ts apps/api/src/services/reservation-status-service.ts apps/api/src/services/reservation-status-service.test.ts apps/api/src/services/reservation-create-service.ts apps/api/src/routes/reservations.ts apps/api/src/routes/reservations.test.ts apps/api/src/routes/reservations.create.test.ts apps/api/src/routes/permission-matrix.test.ts apps/api/src/index.ts
git commit -m "feat(api): 店舗側の予約エンドポイントと 4 種類の通知を足す"
```

---

## Task 7-13: 権限の網羅テスト

Phase 7 の 9 エンドポイントを、6 種類の主体で総当たりする 1 枚の表にする。

**なぜタスクを分けたか。** 7-5 / 7-8 / 7-10 / 7-12 の各ルートテストにも 401 / 403 / 404 は入っている。しかしそれは**そのタスクを書いた人が思いついた範囲**でしかない。「`GET /owner/reservations/:id` に admin で入れるか」のような**組み合わせ**は、1 本ずつ書いていくと必ず抜ける。表にして総当たりすれば、抜けは「表の穴」として目に見える。

**さらに、エンドポイントを足したのに表に足し忘れる**という抜け方がある。これは `app.routes` を読んで表と突き合わせれば機械的に止まる（「裏取りした事実 7」で `app.routes` が何を返すか実測済み）。

**Phase 4 の `permission-matrix.test.ts` との役割分担を、ここで明確にしておく。**

| ファイル                                            | 責任                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `permission-matrix.test.ts`（Phase 4）              | **全エンドポイントの棚卸し。** 「`app` に載っているものが 1 本残らず、どこかで検証されている」を保証する |
| `reservation-permission-matrix.test.ts`（本タスク） | **予約 9 本の権限仕様。** 9 × 6 の期待ステータスそのものを持つ                                           |

Phase 4 のファイルには `DELEGATED_ROUTE_PATTERNS`（予約 9 本）が 7-5 / 7-8 / 7-10 / 7-12 によって既に積まれている。そして両ファイルがそれぞれ次を主張する:

- Phase 4 側: `DELEGATED_ROUTE_PATTERNS` == `app.routes` の予約系
- 本タスク側（Step 5）: `AUTHORIZATION_CASES` == `app.routes` の予約系

**この 2 つが同時に緑なら、`DELEGATED_ROUTE_PATTERNS` と `AUTHORIZATION_CASES` は推移的に一致する。** 「委譲したのに誰も検証していない」経路は、この 2 本の間に作れない。だから両ファイルを直接つなぐ import は要らない（テストファイル同士を import すると、向こうの `describe` がこちらの実行に混ざる）。

**このタスクは新しい本番コードを 1 行も書かない。** 表が全部緑になるなら Task 7-5〜7-12 の実装が正しいということで、赤くなるならそこに穴がある。**穴が見つかったら、このタスクの中で塞ぐ。**

**Files:**

- Create: `apps/api/src/routes/reservation-permission-matrix.test.ts`（Phase 4 が置いた `permission-matrix.test.ts` / `tenant-isolation.test.ts` と同じ命名に揃える。実ディレクトリを `ls` して確認済み）
- Test: 同上（このタスクの成果物はテストだけ）

**Interfaces:**

- Consumes: `app`（`../index`）、`createTestBindings` / `createTestWorld` / `corruptProfileRole` / `countRows` / `readRow` / `runWrite` / `seedMasters` / `seedShop` / `signUpAs` / 型 `TestUser` / `TestWorld`（`../test/fixtures`）、`ERROR_MESSAGE_NOT_FOUND`（`../lib/http-error`）
- Produces: なし（テストのみ。他タスクはこのファイルを import しない）

---

- [ ] **Step 1: 表と主体を定義する（まだ実行しない）**

`apps/api/src/routes/reservation-permission-matrix.test.ts` の前半を書く:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index';
import { ERROR_MESSAGE_NOT_FOUND } from '../lib/http-error';
import {
  countRows,
  corruptProfileRole,
  createTestBindings,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  signUpAs,
  type TestUser,
  type TestWorld,
} from '../test/fixtures';

/** 主体の呼び名。テスト名にそのまま出るので、日本語ではなく短い英字にする */
type ActorLabel = 'anonymous' | 'customer' | 'stranger' | 'shop-owner' | 'other-owner' | 'admin';

const ACTOR_LABELS: readonly ActorLabel[] = [
  'anonymous',
  'customer',
  'stranger',
  'shop-owner',
  'other-owner',
  'admin',
];

type AuthorizationCase = {
  readonly method: string;
  /** Hono に登録されている形。`app.routes` との突き合わせに使う */
  readonly routePath: string;
  /** 実際に叩く URL。`routePath` のパラメータを実在の ID に置いたもの */
  readonly requestPath: string;
  readonly body?: unknown;
  /** 主体ごとの期待ステータス。6 種類すべてを書く（省略を許さない） */
  readonly expected: Readonly<Record<ActorLabel, number>>;
};

const MY_SHOP_ID = 'shp_auth_0001';
const OTHER_SHOP_ID = 'shp_auth_0002';
/** customer が MY_SHOP に取った pending の予約 */
const MY_RESERVATION_ID = 'rsv_auth_mine';
/** 実在しない予約 ID。他人の予約と同じ応答になることを確かめるために使う */
const MISSING_RESERVATION_ID = 'rsv_auth_missing';
/** 2026-10-01（木）。shop_hours は day_of_week = 4 に入れる */
const TARGET_DATE = '2026-10-01';
```

- [ ] **Step 2: 表の本体を書く**

同じファイルに続ける:

```ts
/**
 * 9 エンドポイント × 6 主体。**ここが Phase 7 の権限仕様そのもの**である。
 *
 * 期待値の読み方（Phase 4 の規約）:
 *   401 = 認証情報が無い
 *   403 = 認証はできたがロールが違う。**行の所有者かどうかでは 403 を返さない**
 *   404 = 行が無い、または自分のものではない。この 2 つを外から区別させない
 *   422 = 入力の形が不正
 */
const AUTHORIZATION_CASES: readonly AuthorizationCase[] = [
  {
    // 公開エンドポイント。ログインしていなくても空き枠は見える
    method: 'GET',
    routePath: '/reservation-slots',
    requestPath: `/reservation-slots?shopId=${MY_SHOP_ID}&date=${TARGET_DATE}`,
    expected: {
      anonymous: 200,
      customer: 200,
      stranger: 200,
      'shop-owner': 200,
      'other-owner': 200,
      admin: 200,
    },
  },
  {
    // **わざと壊れたボディを送る。**
    // 成功系（201）は RESERVATION_LOCK のバインディングが要るのでここでは測れない
    // （Task 7-17 の結合テストが miniflare 込みで測る）。
    // 壊れたボディにすると「認証を通れば 422 まで到達する」ことが確かめられ、
    // 同時に **401 が 422 より先に出る**（未認証の相手に検証規則を教えない）ことも測れる
    method: 'POST',
    routePath: '/reservations',
    requestPath: '/reservations',
    body: { shopId: '', date: 'not-a-date', startMinute: -1, partySize: 0 },
    expected: {
      anonymous: 401,
      customer: 422,
      stranger: 422,
      'shop-owner': 422,
      'other-owner': 422,
      admin: 422,
    },
  },
  {
    // 自分の一覧。ロールを問わず「自分の分だけ」見える
    method: 'GET',
    routePath: '/reservations',
    requestPath: '/reservations?scope=upcoming',
    expected: {
      anonymous: 401,
      customer: 200,
      stranger: 200,
      'shop-owner': 200,
      'other-owner': 200,
      admin: 200,
    },
  },
  {
    // 他人の予約は 404。**店のオーナーであっても、この経路では 404**。
    // 店側は /owner/reservations/:id を使う。経路ごとに見える範囲を分ける
    method: 'GET',
    routePath: '/reservations/:reservationId',
    requestPath: `/reservations/${MY_RESERVATION_ID}`,
    expected: {
      anonymous: 401,
      customer: 200,
      stranger: 404,
      'shop-owner': 404,
      'other-owner': 404,
      admin: 404,
    },
  },
  {
    // キャンセルは予約した本人の権利。admin にも代行させない（Phase 10 の範囲）
    method: 'POST',
    routePath: '/reservations/:reservationId/cancel',
    requestPath: `/reservations/${MY_RESERVATION_ID}/cancel`,
    expected: {
      anonymous: 401,
      customer: 200,
      stranger: 404,
      'shop-owner': 404,
      'other-owner': 404,
      admin: 404,
    },
  },
  {
    // ロールの門。user と admin は **403**。
    // ここで 404 を返すと「/owner/reservations というパスがある」ことすら隠れてしまい、
    // かえって「なぜ動かないのか」が分からなくなる。ロール違いは素直に 403
    method: 'GET',
    routePath: '/owner/reservations',
    requestPath: '/owner/reservations',
    expected: {
      anonymous: 401,
      customer: 403,
      stranger: 403,
      'shop-owner': 200,
      'other-owner': 200,
      admin: 403,
    },
  },
  {
    // other-owner が **403 ではなく 404** なのが肝。
    // ロールは合っているので門は通り、行の所有権で落ちる
    method: 'GET',
    routePath: '/owner/reservations/:reservationId',
    requestPath: `/owner/reservations/${MY_RESERVATION_ID}`,
    expected: {
      anonymous: 401,
      customer: 403,
      stranger: 403,
      'shop-owner': 200,
      'other-owner': 404,
      admin: 403,
    },
  },
  {
    method: 'POST',
    routePath: '/owner/reservations/:reservationId/status',
    requestPath: `/owner/reservations/${MY_RESERVATION_ID}/status`,
    body: { status: 'confirmed' },
    expected: {
      anonymous: 401,
      customer: 403,
      stranger: 403,
      'shop-owner': 200,
      'other-owner': 404,
      admin: 403,
    },
  },
  {
    method: 'PATCH',
    routePath: '/owner/reservations/:reservationId/memo',
    requestPath: `/owner/reservations/${MY_RESERVATION_ID}/memo`,
    body: { ownerMemo: '窓際を用意する' },
    expected: {
      anonymous: 401,
      customer: 403,
      stranger: 403,
      'shop-owner': 200,
      'other-owner': 404,
      admin: 403,
    },
  },
];
```

- [ ] **Step 3: 世界の組み立てと後始末を書く**

同じファイルに続ける:

```ts
let world: TestWorld;
let customer: TestUser;
let stranger: TestUser;
let shopOwner: TestUser;
let otherOwner: TestUser;
let admin: TestUser;
let suspended: TestUser;
let brokenRole: TestUser;

function cookieOf(label: ActorLabel): string | undefined {
  switch (label) {
    case 'anonymous':
      return undefined;
    case 'customer':
      return customer.cookie;
    case 'stranger':
      return stranger.cookie;
    case 'shop-owner':
      return shopOwner.cookie;
    case 'other-owner':
      return otherOwner.cookie;
    case 'admin':
      return admin.cookie;
  }
}

async function send(target: AuthorizationCase, cookie: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (target.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return await app.request(
    target.requestPath,
    {
      method: target.method,
      headers,
      ...(target.body === undefined ? {} : { body: JSON.stringify(target.body) }),
    },
    createTestBindings(world),
  );
}

/** 予約行を作り直す。承認やキャンセルで状態が動くので、テストごとに戻す */
async function resetReservations(): Promise<void> {
  await runWrite(world, 'DELETE FROM notifications');
  await runWrite(world, 'DELETE FROM reservations');
  await runWrite(
    world,
    'INSERT INTO reservations (id, shop_id, user_id, reserved_at, party_size, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    MY_RESERVATION_ID,
    MY_SHOP_ID,
    customer.userId,
    Date.parse('2026-10-01T09:00:00Z'),
    2,
    '',
    'pending',
  );
}

beforeAll(async () => {
  world = await createTestWorld();
  await seedMasters(world);

  customer = await signUpAs(world, 'auth-customer@example.com', 'user');
  stranger = await signUpAs(world, 'auth-stranger@example.com', 'user');
  shopOwner = await signUpAs(world, 'auth-shop-owner@example.com', 'owner');
  otherOwner = await signUpAs(world, 'auth-other-owner@example.com', 'owner');
  admin = await signUpAs(world, 'auth-admin@example.com', 'admin');
  suspended = await signUpAs(world, 'auth-suspended@example.com', 'user');
  brokenRole = await signUpAs(world, 'auth-broken@example.com', 'user');

  await runWrite(
    world,
    'UPDATE profiles SET status = ? WHERE user_id = ?',
    'suspended',
    suspended.userId,
  );
  // CHECK 制約が許さない値を入れて「マイグレーション事故で壊れた行」を再現する
  await corruptProfileRole(world, brokenRole.userId, 'superuser');

  await seedShop(world, {
    id: MY_SHOP_ID,
    ownerId: shopOwner.userId,
    name: '権限テスト店',
    status: 'published',
  });
  await seedShop(world, {
    id: OTHER_SHOP_ID,
    ownerId: otherOwner.userId,
    name: 'よその店',
    status: 'published',
  });
  // GET /reservation-slots が 200 を返すために、席設定と木曜の営業時間が要る
  await runWrite(
    world,
    'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, ?)',
    MY_SHOP_ID,
    8,
    60,
    2,
    1,
  );
  await runWrite(
    world,
    'INSERT INTO shop_hours (id, shop_id, day_of_week, open_minute, close_minute, is_closed) VALUES (?, ?, ?, ?, ?, ?)',
    'sh_auth_thu',
    MY_SHOP_ID,
    4,
    1080,
    1320,
    0,
  );
});

beforeEach(async () => {
  await resetReservations();
});

afterAll(async () => {
  await world.dispose();
});
```

- [ ] **Step 4: 総当たりのテストを書く**

同じファイルに続ける:

```ts
describe('権限マトリクス（9 エンドポイント × 6 主体）', () => {
  for (const target of AUTHORIZATION_CASES) {
    describe(`${target.method} ${target.routePath}`, () => {
      for (const label of ACTOR_LABELS) {
        it(`${label} は ${target.expected[label]}`, async () => {
          const response = await send(target, cookieOf(label));
          expect(response.status).toBe(target.expected[label]);
        });
      }
    });
  }
});
```

**ループでテストを組み立てる理由。** 54 本を手で書くと、コピペの取り違えで「同じ主体を 2 回書いて 1 つ抜ける」が起きる。`ACTOR_LABELS` を回せば、主体を 1 つ足したとき 9 本が自動で増える。**`Record<ActorLabel, number>` にしてあるので、主体を足して期待値を書き忘れれば型エラーになる。**

- [ ] **Step 5: 表と実際のルートを突き合わせるテストを書く**

同じファイルに続ける:

```ts
/**
 * Phase 7 が足したエンドポイントだけを拾う。他フェーズのルートはこのタスクの責任外。
 * `permission-matrix.test.ts` の `DELEGATABLE_PATH_PATTERN` と**同じ形にそろえること**。
 * 片方だけ広げると、広げたほうの経路が誰にも検証されないまま緑になる。
 */
const PHASE_7_PATH_PATTERN = /^\/(reservation-slots|reservations|owner\/reservations)(\/|$)/;

describe('表とルート定義のずれ', () => {
  it('Phase 7 のエンドポイントが過不足なく表に載っている', () => {
    const registered = app.routes
      // use('*', ...) のミドルウェアは method: 'ALL' で混ざる（裏取りした事実 7）
      .filter((route) => route.method !== 'ALL')
      .filter((route) => PHASE_7_PATH_PATTERN.test(route.path))
      .map((route) => `${route.method} ${route.path}`);
    const covered = AUTHORIZATION_CASES.map((target) => `${target.method} ${target.routePath}`);

    // Set にするのは、同じパスに複数のハンドラが積まれた場合に重複が出るため
    expect([...new Set(registered)].sort()).toEqual([...covered].sort());
  });

  it('表は 9 行ある（数を変えたら意図を疑う）', () => {
    expect(AUTHORIZATION_CASES).toHaveLength(9);
  });

  it('どの行も 6 主体ぶんの期待値を持つ', () => {
    for (const target of AUTHORIZATION_CASES) {
      expect(Object.keys(target.expected).sort()).toEqual([...ACTOR_LABELS].sort());
    }
  });
});
```

**この 3 本が「書き忘れ」を止める最後の砦である。** 1 本目はエンドポイントを足して表に書かなかったときに落ち、逆に表のパスを打ち間違えたときにも落ちる（`app.routes` に無いパスが表に現れるため）。2 本目は「表から 1 行こっそり消す」を止める。3 本目は「主体を 1 つ書き忘れる」を止める。

- [ ] **Step 6: 停止中・壊れたロールのテストを書く**

同じファイルに続ける:

```ts
describe('アカウントの状態で全エンドポイントが閉じる', () => {
  /**
   * authMiddleware は **ルーティングより前**に走る（`app.use('*', authMiddleware)`）。
   * そのため停止中のアカウントは、公開エンドポイントである /reservation-slots ですら 403 になる。
   *
   * これは意図した挙動である。停止中の相手には「アプリが使えない」と一貫して伝えたい。
   * `apps/api/src/index.ts` の 26 行目が `.use('*', authMiddleware)` になっていることは
   * 実ファイルで確認済み（Better Auth のハンドラだけが authMiddleware より前にある）。
   * 将来 Phase 8 以降で公開ルートを authMiddleware の外へ出す設計にすると、
   * この describe が最初に落ちる。落ちたら意図を確認してから期待値を直すこと。**黙って削らない。**
   */
  for (const target of AUTHORIZATION_CASES) {
    it(`停止中のアカウントは ${target.method} ${target.routePath} で 403`, async () => {
      const response = await send(target, suspended.cookie);
      expect(response.status).toBe(403);
    });
  }

  for (const target of AUTHORIZATION_CASES) {
    it(`ロールが壊れた行は ${target.method} ${target.routePath} で 403`, async () => {
      const response = await send(target, brokenRole.cookie);
      expect(response.status).toBe(403);
    });
  }
});
```

- [ ] **Step 7: 「拒否されたとき DB が変わっていない」テストを書く**

同じファイルに続ける:

```ts
/** 書き込み系のうち、拒否されるはずの組み合わせだけを抜き出す */
const DENIED_WRITE_CASES: readonly {
  readonly target: AuthorizationCase;
  readonly label: ActorLabel;
}[] = AUTHORIZATION_CASES.flatMap((target) =>
  target.method === 'GET'
    ? []
    : ACTOR_LABELS.filter((label) => target.expected[label] >= 400).map((label) => ({
        target,
        label,
      })),
);

describe('拒否された書き込みは DB に痕跡を残さない', () => {
  it('抜き出した組み合わせが 1 つ以上ある（抽出条件の壊れを検知する）', () => {
    expect(DENIED_WRITE_CASES.length).toBeGreaterThan(0);
  });

  for (const { target, label } of DENIED_WRITE_CASES) {
    it(`${label} の ${target.method} ${target.routePath} は行も通知も動かさない`, async () => {
      const response = await send(target, cookieOf(label));
      expect(response.status).toBeGreaterThanOrEqual(400);

      // 状態が pending のまま、メモが空のままであること
      const row = await readRow(
        world,
        'SELECT status, owner_memo FROM reservations WHERE id = ?',
        MY_RESERVATION_ID,
      );
      expect(row?.status).toBe('pending');
      expect(row?.owner_memo).toBeNull();
      // 予約が増えていないこと（POST /reservations の拒否を見る）
      expect(await countRows(world, 'SELECT COUNT(*) AS count FROM reservations')).toBe(1);
      // 通知も出ていないこと
      expect(await countRows(world, 'SELECT COUNT(*) AS count FROM notifications')).toBe(0);
    });
  }
});
```

**ステータスコードだけを見て満足しない。** 「403 は返したが UPDATE は走っていた」は、ステータスコードのテストでは絶対に捕まらない。`readRow` / `countRows` は**リポジトリ層を通さずに D1 の実体を見る**ための道具で（`apps/api/src/test/fixtures.ts:44-46` のコメント）、まさにこの用途にある。

- [ ] **Step 8: 「存在しない ID と他人の ID が区別できない」テストを書く**

同じファイルに続ける:

```ts
describe('存在有無を漏らさない', () => {
  it('他人の予約と存在しない予約で、本文まで同一の 404 を返す（利用者経路）', async () => {
    const other = await app.request(
      `/reservations/${MY_RESERVATION_ID}`,
      { headers: { cookie: stranger.cookie } },
      createTestBindings(world),
    );
    const missing = await app.request(
      `/reservations/${MISSING_RESERVATION_ID}`,
      { headers: { cookie: stranger.cookie } },
      createTestBindings(world),
    );

    expect(other.status).toBe(missing.status);
    expect(await other.text()).toBe(await missing.text());
  });

  it('他店の予約と存在しない予約で、本文まで同一の 404 を返す（店舗経路）', async () => {
    const other = await app.request(
      `/owner/reservations/${MY_RESERVATION_ID}`,
      { headers: { cookie: otherOwner.cookie } },
      createTestBindings(world),
    );
    const missing = await app.request(
      `/owner/reservations/${MISSING_RESERVATION_ID}`,
      { headers: { cookie: otherOwner.cookie } },
      createTestBindings(world),
    );

    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
  });

  it('404 の本文は固定文言で、ID を含まない', async () => {
    const response = await app.request(
      `/reservations/${MY_RESERVATION_ID}`,
      { headers: { cookie: stranger.cookie } },
      createTestBindings(world),
    );
    const text = await response.text();

    expect(text).toContain(ERROR_MESSAGE_NOT_FOUND);
    expect(text).not.toContain(MY_RESERVATION_ID);
  });
});
```

**「本文まで同じ」を見る理由。** ステータスが両方 404 でも、片方の本文に「この予約は他の店のものです」と書いてあれば存在は漏れる。`ERROR_MESSAGE_NOT_FOUND` は `apps/api/src/lib/http-error.ts:8` の固定文言で、`notFound()` はこれしか返さない。**テスト側に `'対象が見つかりません'` と直書きせず定数を参照する**ので、文言を変えたときにテストが嘘にならない。

- [ ] **Step 9: 全部走らせる**

```bash
npm test -w @meshimap/api -- permission-matrix
```

**この絞り込みは 2 ファイルに当たる**（`permission-matrix.test.ts` と `reservation-permission-matrix.test.ts`）。意図的にそうしている。上に書いた「2 つが同時に緑なら推移的に一致する」を 1 コマンドで確かめたいからである。

期待: 本ファイルが 54（マトリクス）+ 3（ずれ検査）+ 18（停止中・壊れたロール）+ 1 + N（拒否された書き込み）+ 3（存在有無）本。加えて Phase 4 の `permission-matrix.test.ts` が全件 PASS（`EXPECTED_ROUTE_PATTERNS` は 19 本、`DELEGATED_ROUTE_PATTERNS` は 9 本になっているはず）。**初回で全部緑になるとは限らない。** 赤が出たら、それは Task 7-5〜7-12 の実装の穴である。

- [ ] **Step 10: 赤が出た場合の直し方**

赤が出たときに何を直すかを、先に決めておく。**期待値のほうを実装に合わせて書き換えるのは最後の手段**で、その場合は「なぜその挙動が正しいのか」をコメントに残すこと。

| 赤の出方                                        | まず疑うところ                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/owner/*` で admin が 200 になる               | `roleGuard(ROLE_OWNER)` に `ROLE_ADMIN` を足していないか（Task 7-12 Step 27(b)）                                                                                                                  |
| `/owner/*` で other-owner が 403 になる         | ハンドラに所有者判定の `if` を書いていないか。所有権は `WHERE` 句の仕事                                                                                                                           |
| `/reservations/:id` で shop-owner が 200 になる | `WHERE user_id = ?` が抜けて店舗の条件だけになっていないか（Task 7-9）                                                                                                                            |
| 未認証なのに 422 が返る                         | `requireActor(c)` より先に `c.req.json()` を呼んでいないか（Task 7-8）                                                                                                                            |
| 停止中で 200 が返る                             | `authMiddleware` が全ルートに掛かっていない。Phase 4 の `index.ts` を見る                                                                                                                         |
| `app.routes` との突き合わせが落ちる             | エンドポイントを足して表に書いていない。**表を足す。テストを緩めない**                                                                                                                            |
| Phase 4 の `permission-matrix.test.ts` が落ちる | `EXPECTED_ROUTE_PATTERNS` か `DELEGATED_ROUTE_PATTERNS` への追記漏れ。7-5 / 7-8 / 7-10 / 7-12 のどのコミットで漏れたかを `git log -p -- apps/api/src/routes/permission-matrix.test.ts` で特定する |

- [ ] **Step 11: わざと壊してテストが落ちることを確認する**

(a) `AUTHORIZATION_CASES` から `PATCH /owner/reservations/:reservationId/memo` の行を消す:

→ 「Phase 7 のエンドポイントが過不足なく表に載っている」と「表は 9 行ある」の 2 本が FAIL。

(b) 表の `routePath` を `/owner/reservations/:id/memo` に打ち間違える（実際のパラメータ名は `:reservationId`）:

→ 「Phase 7 のエンドポイントが過不足なく表に載っている」が FAIL。**`requestPath` は正しいままなので 54 本のマトリクスは全部通る。** 突き合わせテストが無ければ素通りしていた、ということがここで見える。

(c) `PHASE_7_PATH_PATTERN` を `/^\/nothing/` に変える:

→ `registered` が空配列になり、突き合わせが FAIL（`covered` の 9 件と一致しない）。**正規表現が何にもマッチしなくなる**という壊れ方も止まることの確認。

(d) `filter((route) => route.method !== 'ALL')` を消す:

→ `ALL /owner/reservations/*` が混ざって突き合わせが FAIL。

(e) `apps/api/src/routes/owner-reservations.ts` の `roleGuard(ROLE_OWNER)` を `roleGuard(ROLE_OWNER, ROLE_ADMIN)` に変える:

→ `/owner/*` 4 エンドポイント × admin の 4 本が FAIL（403 のはずが 200 か 404 になる）。

(f) `apps/api/src/repositories/reservation-repository.ts` の `findMyReservation` から `eq(reservations.userId, actor.userId)` を消す:

→ `GET /reservations/:reservationId` の stranger / shop-owner / other-owner / admin の 4 本が FAIL（404 のはずが 200）。**所有権を `WHERE` 句に置いている効果が、ここで初めて 4 本まとめて観測できる。**

(g) `apps/api/src/middleware/role-guard.ts` の `requireActor` から `throw unauthorized()` を消して `c.get('viewer')` をそのまま返す:

→ 未認証の行が軒並み FAIL。型が合わなくなるので、まず `npm run typecheck` が落ちることも確かめる。

(h) `POST /reservations` のハンドラで `requireActor(c)` を `c.req.json()` の**後ろ**に動かす:

→ 「anonymous は 401」が FAIL（422 になる）。**未認証の相手に入力検証の結果を教えてしまう**経路がこれで塞がっている。

8 つとも確認したら元に戻す。

- [ ] **Step 12: ミューテーションテストを回す**

```bash
npm run test:mutation -w @meshimap/api
```

Phase 7 で足した本番コード（`src/repositories/reservation-*.ts` / `src/repositories/notification-repository.ts` / `src/services/reservation-*.ts` / `src/routes/reservation*.ts` / `src/routes/owner-reservations.ts` / `src/durable-objects/*.ts`）が対象。しきい値は `{ high: 95, low: 85, break: 85 }`。

生き残ったミュータントへの対応は 3 つだけ（「ミューテーションテスト方針」節のとおり）:

1. **テストの穴** → テストを足す
2. **出力を変えない最適化** → 呼び出し回数などで縛る
3. **到達不能** → 到達できる形に書き直してから殺す

**「除外する」は選択肢に無い。** `mutate` の対象からファイルを外して数字を上げるのは、測るのをやめているだけである。

- [ ] **Step 13: コミット**

```bash
git add apps/api/src/routes/reservation-permission-matrix.test.ts
git commit -m "test(api): 予約の 9 エンドポイントを 6 主体で総当たりする権限テストを追加"
```

---

## Task 7-14: モバイルの予約データ層

画面を 1 枚も作らずに、予約の 9 エンドポイントぶんの「取得・検証・キャッシュ・書き込み」を全部揃える。

**画面と分ける理由。** 画面のテストでフックをモックすれば、画面は「表示の責任」だけを検証できる。逆にここでは実 DOM を 1 つも触らずに「404 のときどうなるか」「キャンセル後にどのキャッシュが消えるか」を検証できる。混ぜると、どちらのテストも遅くて読みにくくなる。Phase 6 の Task 6-8（`features/shops` の schema / api / query-keys）と同じ切り方である。

**Files:**

- Modify: `apps/mobile/src/lib/api-client.ts`（Step 1 の確認結果しだい）
- Create: `apps/mobile/src/features/reservations/schema.ts`
- Create: `apps/mobile/src/features/reservations/schema.test.ts`
- Create: `apps/mobile/src/features/reservations/query-keys.ts`
- Create: `apps/mobile/src/features/reservations/query-keys.test.ts`
- Create: `apps/mobile/src/features/reservations/api.ts`
- Create: `apps/mobile/src/features/reservations/api.test.ts`
- Create: `apps/mobile/src/features/reservations/use-reservation-slots.ts`
- Create: `apps/mobile/src/features/reservations/use-reservation-slots.test.tsx`
- Create: `apps/mobile/src/features/reservations/use-reservations.ts`
- Create: `apps/mobile/src/features/reservations/use-reservations.test.tsx`
- Create: `apps/mobile/src/features/reservations/use-create-reservation.ts`
- Create: `apps/mobile/src/features/reservations/use-create-reservation.test.tsx`
- Create: `apps/mobile/src/features/reservations/use-cancel-reservation.ts`
- Create: `apps/mobile/src/features/reservations/use-cancel-reservation.test.tsx`
- Create: `apps/mobile/src/features/reservations/use-owner-reservations.ts`
- Create: `apps/mobile/src/features/reservations/use-owner-reservations.test.tsx`
- Create: `apps/mobile/src/features/reservations/use-update-reservation-status.ts`
- Create: `apps/mobile/src/features/reservations/use-update-reservation-status.test.tsx`
- Create: `apps/mobile/src/test-support/reservation-fixtures.ts`

**Interfaces:**

- Consumes: `apiFetch` / `ApiError`（`@/lib/api-client`、Phase 5）、`QueryWrapper` / `createTestQueryClient`（`@/test-support/query-wrapper`、Phase 6）、`@meshimap/core` の `PARTY_SIZE_MAX` / `PARTY_SIZE_MIN` / `RESERVATION_NOTE_MAX_LENGTH` / `RESERVATION_STATUSES` / `identifierSchema` / `minuteOfDaySchema` / `reservationCreateSchema` / `toJstDate` / `toMinuteOfDay` / `toReservationId` / `toShopId` / `toUserId` / 型 `JstDate` / `MinuteOfDay` / `ReservationBlockReason` / `ReservationId` / `ReservationStatus` / `ShopId` / `UserId`
- Produces:
  - `schema.ts`: `dailySlotsSchema` / `reservationSchema` / `ownerReservationSchema` / `createdReservationSchema` / `RESERVATION_SCOPES` / 型 `DailySlots` / `SlotAvailability` / `Reservation` / `OwnerReservation` / `CreatedReservation` / `ReservationScope` / `OwnerReservationFilter`
  - `query-keys.ts`: `reservationKeys`
  - `api.ts`: `fetchReservationSlots` / `createReservation` / `fetchMyReservations` / `fetchMyReservation` / `cancelReservation` / `fetchOwnerReservations` / `fetchOwnerReservation` / `updateReservationStatus` / `updateReservationMemo` / `toReservationErrorMessage` / 型 `ReservationErrorContext`
  - フック: `useReservationSlots` / `useMyReservations` / `useMyReservation` / `useCreateReservation` / `useCancelReservation` / `useOwnerReservations` / `useOwnerReservation` / `useUpdateReservationStatus` / `useUpdateReservationMemo`
  - `test-support/reservation-fixtures.ts`: `buildReservation` / `buildOwnerReservation` / `buildDailySlots`

---

- [ ] **Step 1: `apiFetch` が実在するか確認する**

**このステップを飛ばさない。** 本計画書の受け取り表に書いたとおり、`apiFetch` という名前は Phase 6 の計画書が前提にしているもので、Phase 5 の計画書（Task 5-3）が実際に作るのは `hc<AppType>` の `apiClient` と `buildAuthHeaders` である。**どちらが実在するかで、この先の全ファイルの import が変わる。**

```bash
sed -n '1,80p' apps/mobile/src/lib/api-client.ts
grep -rn "apiFetch\|ApiError" apps/mobile/src/lib/ apps/mobile/src/features/
```

判断:

| 確認結果                                          | やること                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `apiFetch` と `ApiError` がある                   | 何もしない。Step 2 へ進む                                              |
| 無く、`features/shops/api.ts` も `apiClient` 経由 | **Phase 6 に合わせる。** `features/reservations` も `apiClient` で書く |
| 無く、`features/shops/api.ts` は `apiFetch` 経由  | 下のコードで `api-client.ts` に足してからコミットする                  |

3 番目（Phase 6 が `apiFetch` を前提に書かれているのに実体が無い）の場合に足すもの:

```ts
// apps/mobile/src/lib/api-client.ts に追記する
import { API_BASE_URL } from '@/constants/api';

/**
 * HTTP のエラー応答。status を持たせるのは、呼び出し側が
 * 401 / 403 / 404 / 422 で文言を分けるため。
 * Error を継承したクラスにするのは、react-query の onError に素通しできるようにするため。
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type ApiFetchInit = {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly searchParams?: Record<string, string>;
  readonly body?: unknown;
};

/**
 * 業務 API の呼び出し。Cookie の付与は buildAuthHeaders に任せる。
 * 返り値を unknown にしてあるのは、**呼び出し側に Zod での検証を強制するため**。
 * ここで型を付けると「サーバが違う形を返した」に気づけない。
 */
export async function apiFetch(path: string, init: ApiFetchInit): Promise<unknown> {
  const authHeaders = await buildAuthHeaders();
  const query =
    init.searchParams === undefined ? '' : `?${new URLSearchParams(init.searchParams).toString()}`;
  const headers =
    init.body === undefined ? authHeaders : { ...authHeaders, 'content-type': 'application/json' };

  const response = await fetch(`${API_BASE_URL}${path}${query}`, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    // 本文は固定文言（Phase 4 の http-error.ts）なので、そのまま message に入れてよい
    throw new ApiError(response.status, await response.text());
  }
  return await response.json();
}
```

足した場合はここでコミットする:

```bash
git add apps/mobile/src/lib/api-client.ts
git commit -m "feat(mobile): apiFetch と ApiError を api-client に足す"
```

- [ ] **Step 2: schema の失敗するテストを書く**

`apps/mobile/src/features/reservations/schema.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  createdReservationSchema,
  dailySlotsSchema,
  ownerReservationSchema,
  reservationSchema,
} from './schema';

const SLOT_JSON = {
  startMinute: 1080,
  endMinute: 1140,
  label: '18:00',
  isAvailable: true,
  reason: null,
  remainingSeats: 6,
};

const DAILY_SLOTS_JSON = {
  shopId: 'shp_0001',
  shopName: '権限テスト店',
  date: '2026-10-01',
  acceptsReservation: true,
  isClosedOnDate: false,
  slots: [SLOT_JSON],
};

const RESERVATION_JSON = {
  id: 'rsv_0001',
  shopId: 'shp_0001',
  shopName: '権限テスト店',
  reservedAt: '2026-10-01T09:00:00.000Z',
  partySize: 2,
  note: '窓際希望',
  status: 'pending',
  createdAt: '2026-09-16T01:00:00.000Z',
};

describe('dailySlotsSchema', () => {
  it('API の形をそのまま受け取れる', () => {
    const parsed = dailySlotsSchema.parse(DAILY_SLOTS_JSON);

    expect(parsed.shopId).toBe('shp_0001');
    expect(parsed.date).toBe('2026-10-01');
    expect(parsed.slots[0]?.startMinute).toBe(1080);
  });

  it('埋まっている枠の理由コードを保つ', () => {
    const parsed = dailySlotsSchema.parse({
      ...DAILY_SLOTS_JSON,
      slots: [{ ...SLOT_JSON, isAvailable: false, reason: 'seats-full', remainingSeats: 0 }],
    });

    expect(parsed.slots[0]?.reason).toBe('seats-full');
  });

  it('知らない理由コードは弾く', () => {
    expect(() =>
      dailySlotsSchema.parse({
        ...DAILY_SLOTS_JSON,
        slots: [{ ...SLOT_JSON, reason: 'because-i-said-so' }],
      }),
    ).toThrow();
  });

  it('日付が YYYY-MM-DD でなければ弾く', () => {
    expect(() => dailySlotsSchema.parse({ ...DAILY_SLOTS_JSON, date: '2026/10/01' })).toThrow();
  });

  it('枠が 0 件でも通る（臨時休業日）', () => {
    const parsed = dailySlotsSchema.parse({
      ...DAILY_SLOTS_JSON,
      isClosedOnDate: true,
      slots: [],
    });

    expect(parsed.slots).toHaveLength(0);
    expect(parsed.isClosedOnDate).toBe(true);
  });
});

describe('reservationSchema', () => {
  it('reservedAt と createdAt を Date にする', () => {
    const parsed = reservationSchema.parse(RESERVATION_JSON);

    expect(parsed.reservedAt.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(parsed.createdAt.toISOString()).toBe('2026-09-16T01:00:00.000Z');
  });

  it('6 つの状態をすべて受け取れる', () => {
    for (const status of [
      'pending',
      'confirmed',
      'rejected',
      'cancelled',
      'completed',
      'no_show',
    ]) {
      expect(reservationSchema.parse({ ...RESERVATION_JSON, status }).status).toBe(status);
    }
  });

  it('知らない状態は弾く', () => {
    expect(() => reservationSchema.parse({ ...RESERVATION_JSON, status: 'maybe' })).toThrow();
  });

  it('人数の下限ちょうど（1）を受け取る', () => {
    expect(reservationSchema.parse({ ...RESERVATION_JSON, partySize: 1 }).partySize).toBe(1);
  });

  it('人数が 0 なら弾く', () => {
    expect(() => reservationSchema.parse({ ...RESERVATION_JSON, partySize: 0 })).toThrow();
  });

  it('ownerMemo のような店舗専用の列が来ても取り込まない', () => {
    const parsed = reservationSchema.parse({ ...RESERVATION_JSON, ownerMemo: '漏れてはいけない' });

    expect(Object.keys(parsed)).not.toContain('ownerMemo');
  });
});

describe('ownerReservationSchema', () => {
  it('予約者とメモを足した形を受け取る', () => {
    const parsed = ownerReservationSchema.parse({
      ...RESERVATION_JSON,
      userId: 'usr_0001',
      customerName: 'customer@example.com',
      ownerMemo: '窓際を用意する',
    });

    expect(parsed.userId).toBe('usr_0001');
    expect(parsed.ownerMemo).toBe('窓際を用意する');
  });

  it('userId が欠けていれば弾く', () => {
    expect(() =>
      ownerReservationSchema.parse({
        ...RESERVATION_JSON,
        customerName: 'customer@example.com',
        ownerMemo: '',
      }),
    ).toThrow();
  });
});

describe('createdReservationSchema', () => {
  it('201 の応答を受け取る', () => {
    const parsed = createdReservationSchema.parse({
      reservationId: 'rsv_0001',
      reservedAt: '2026-10-01T09:00:00.000Z',
    });

    expect(parsed.reservationId).toBe('rsv_0001');
    expect(parsed.reservedAt.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });
});
```

**「`ownerMemo` を取り込まない」テストを置いた理由。** API 側では `toReservationResponse` と `toOwnerReservationResponse` を分けて `ownerMemo` の漏れを止めている（Task 7-12 Step 19）。しかしモバイル側の schema が `.passthrough()` 相当で緩く書かれていると、万一サーバが漏らしたときに端末の画面まで届いてしまう。**Zod の既定は未知キーを落とす**ので、このテストは「既定のままであること」を固定する回帰テストになる。

- [ ] **Step 3: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/schema
```

期待: `Cannot find module './schema'` で FAIL。

- [ ] **Step 4: schema.ts を実装する**

```ts
// apps/mobile/src/features/reservations/schema.ts
import {
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  RESERVATION_STATUSES,
  identifierSchema,
  minuteOfDaySchema,
  toJstDate,
  toMinuteOfDay,
  toReservationId,
  toShopId,
  toUserId,
} from '@meshimap/core';
import type { JstDate, ReservationBlockReason, ReservationStatus } from '@meshimap/core';
import { z } from 'zod';

/**
 * 空き枠が埋まっている理由。core の `ReservationBlockReason` と同じ 4 値。
 * `satisfies` を付けて、core 側が値を増やしたらここがコンパイルエラーになるようにする。
 * （Phase 6 の openStatusSchema と同じ手口）
 */
const BLOCK_REASON_VALUES = [
  'not-accepting',
  'party-too-large',
  'parallel-full',
  'seats-full',
] as const satisfies readonly ReservationBlockReason[];

const blockReasonSchema = z.enum(BLOCK_REASON_VALUES);

const slotAvailabilitySchema = z.object({
  startMinute: minuteOfDaySchema.transform(toMinuteOfDay),
  endMinute: minuteOfDaySchema.transform(toMinuteOfDay),
  /** サーバが formatMinuteOfDay で作った「18:00」「翌 1:30」。端末で再計算しない */
  label: z.string().min(1),
  isAvailable: z.boolean(),
  reason: blockReasonSchema.nullable(),
  remainingSeats: z.number().int().min(0),
});

export const dailySlotsSchema = z.object({
  shopId: identifierSchema.transform(toShopId),
  shopName: z.string().min(1),
  date: z.iso.date().transform(toJstDate),
  acceptsReservation: z.boolean(),
  isClosedOnDate: z.boolean(),
  slots: z.array(slotAvailabilitySchema),
});

/**
 * ISO 8601 の文字列を Date にする。
 * 画面では「10/1（木）18:00」のように JST で出すので、文字列のままだと
 * 表示のたびに new Date() を書くことになり、変換し忘れが混ざる。入口で 1 回だけ変換する。
 */
const isoDateTimeSchema = z.iso.datetime().transform((value) => new Date(value));

const reservationStatusSchema = z.enum(RESERVATION_STATUSES);

/** 利用者向けの予約。**ownerMemo と userId は含めない**（サーバも返さない） */
export const reservationSchema = z.object({
  id: identifierSchema.transform(toReservationId),
  shopId: identifierSchema.transform(toShopId),
  shopName: z.string().min(1),
  reservedAt: isoDateTimeSchema,
  partySize: z.number().int().min(PARTY_SIZE_MIN).max(PARTY_SIZE_MAX),
  note: z.string().max(RESERVATION_NOTE_MAX_LENGTH),
  status: reservationStatusSchema,
  createdAt: isoDateTimeSchema,
});

/** 店舗向け。利用者向けに予約者とメモを足しただけ（サーバの型と同じ関係） */
export const ownerReservationSchema = reservationSchema.extend({
  userId: identifierSchema.transform(toUserId),
  /** 予約者の表示名。profiles.display_name をそのまま出す */
  customerName: z.string().min(1),
  ownerMemo: z.string(),
});

export const createdReservationSchema = z.object({
  reservationId: identifierSchema.transform(toReservationId),
  reservedAt: isoDateTimeSchema,
});

export const reservationListSchema = z.object({ reservations: z.array(reservationSchema) });
export const ownerReservationListSchema = z.object({
  reservations: z.array(ownerReservationSchema),
});

/**
 * 利用者の予約一覧の絞り込み。サーバの `reservationScopeSchema` と同じ 2 値。
 * リクエストのパラメータだがここに置くのは、api.ts と query-keys.ts の両方が使うため。
 * どちらかに置くともう一方が import することになり、依存の向きが読みにくくなる。
 */
export const RESERVATION_SCOPES = ['upcoming', 'past'] as const;
export type ReservationScope = (typeof RESERVATION_SCOPES)[number];

/** 店舗側の絞り込み。未指定を undefined ではなく null で表す（exactOptionalPropertyTypes 対策） */
export type OwnerReservationFilter = {
  readonly date: JstDate | null;
  readonly status: ReservationStatus | null;
};

export type SlotAvailability = z.infer<typeof slotAvailabilitySchema>;
export type DailySlots = z.infer<typeof dailySlotsSchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type OwnerReservation = z.infer<typeof ownerReservationSchema>;
export type CreatedReservation = z.infer<typeof createdReservationSchema>;
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/schema
```

期待: 15 本すべて PASS。

- [ ] **Step 6: テスト用のフィクスチャを作る**

`Reservation` は `ReservationId` / `ShopId` といったブランド型を含むので、オブジェクトリテラルを `Reservation` 型として直接書くとコンパイルが通らない。**素の JSON を組み立てて `parse` に通す**形にする（Phase 6 の `shop-fixtures.ts` と同じ理由）。こうしておくと、フィクスチャが実際の API レスポンスと食い違う事故も同時に防げる。

```ts
// apps/mobile/src/test-support/reservation-fixtures.ts
import {
  dailySlotsSchema,
  ownerReservationSchema,
  reservationSchema,
} from '@/features/reservations/schema';
import type { DailySlots, OwnerReservation, Reservation } from '@/features/reservations/schema';

/** 既定は「2026-10-01（木）18:00 に 2 名、承認待ち」 */
const DEFAULT_RESERVATION_JSON = {
  id: 'rsv_0001',
  shopId: 'shp_0001',
  shopName: '炭火焼鳥とり源',
  reservedAt: '2026-10-01T09:00:00.000Z',
  partySize: 2,
  note: '',
  status: 'pending',
  createdAt: '2026-09-16T01:00:00.000Z',
};

const DEFAULT_OWNER_EXTRA_JSON = {
  userId: 'usr_0001',
  customerName: 'customer@example.com',
  ownerMemo: '',
};

const DEFAULT_DAILY_SLOTS_JSON = {
  shopId: 'shp_0001',
  shopName: '炭火焼鳥とり源',
  date: '2026-10-01',
  acceptsReservation: true,
  isClosedOnDate: false,
  slots: [
    {
      startMinute: 1080,
      endMinute: 1140,
      label: '18:00',
      isAvailable: true,
      reason: null,
      remainingSeats: 8,
    },
    {
      startMinute: 1140,
      endMinute: 1200,
      label: '19:00',
      isAvailable: false,
      reason: 'seats-full',
      remainingSeats: 0,
    },
  ],
};

/** 上書きは「素の JSON のキー」で指定する。ブランド型を呼び出し側で作らせないため */
export function buildReservation(overrides: Record<string, unknown> = {}): Reservation {
  return reservationSchema.parse({ ...DEFAULT_RESERVATION_JSON, ...overrides });
}

export function buildOwnerReservation(overrides: Record<string, unknown> = {}): OwnerReservation {
  return ownerReservationSchema.parse({
    ...DEFAULT_RESERVATION_JSON,
    ...DEFAULT_OWNER_EXTRA_JSON,
    ...overrides,
  });
}

export function buildDailySlots(overrides: Record<string, unknown> = {}): DailySlots {
  return dailySlotsSchema.parse({ ...DEFAULT_DAILY_SLOTS_JSON, ...overrides });
}
```

**`Record<string, unknown>` を使うのは `any` の代用ではない。** 引数は「Zod に渡す前の素の JSON」であって、型を付ける対象ではない。間違ったキーを渡せば `parse` が実行時に落ちるので、テストの中で即座に分かる。

- [ ] **Step 7: クエリキーの失敗するテストを書く**

`apps/mobile/src/features/reservations/query-keys.test.ts`:

```ts
import { toJstDate, toReservationId, toShopId } from '@meshimap/core';
import { describe, expect, it } from '@jest/globals';

import { reservationKeys } from './query-keys';

const SHOP_ID = toShopId('shp_0001');
const RESERVATION_ID = toReservationId('rsv_0001');

/** react-query の invalidateQueries は前方一致なので、prefix 関係がそのまま無効化の範囲になる */
function isPrefixOf(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  return prefix.every((part, index) => key[index] === part);
}

describe('reservationKeys', () => {
  it('一覧のキーは myLists() を前方一致で含む', () => {
    expect(isPrefixOf(reservationKeys.myLists(), reservationKeys.myList('upcoming'))).toBe(true);
    expect(isPrefixOf(reservationKeys.myLists(), reservationKeys.myList('past'))).toBe(true);
  });

  it('詳細のキーは myLists() に含まれない（一覧だけを無効化できる）', () => {
    expect(isPrefixOf(reservationKeys.myLists(), reservationKeys.myDetail(RESERVATION_ID))).toBe(
      false,
    );
  });

  it('店舗側の一覧と利用者側の一覧が混ざらない', () => {
    expect(
      isPrefixOf(
        reservationKeys.myLists(),
        reservationKeys.ownerList({ date: null, status: null }),
      ),
    ).toBe(false);
    expect(isPrefixOf(reservationKeys.ownerLists(), reservationKeys.myList('upcoming'))).toBe(
      false,
    );
  });

  it('all はすべてのキーの前方一致になる（ログアウト時に全部消せる）', () => {
    const keys = [
      reservationKeys.slots(SHOP_ID, toJstDate('2026-10-01'), 2),
      reservationKeys.myList('upcoming'),
      reservationKeys.myDetail(RESERVATION_ID),
      reservationKeys.ownerList({ date: null, status: null }),
      reservationKeys.ownerDetail(RESERVATION_ID),
    ];

    for (const key of keys) {
      expect(isPrefixOf(reservationKeys.all, key)).toBe(true);
    }
  });

  it('枠のキーは人数が違えば別になる（1 名で空きでも 4 名で満席）', () => {
    const forTwo = reservationKeys.slots(SHOP_ID, toJstDate('2026-10-01'), 2);
    const forFour = reservationKeys.slots(SHOP_ID, toJstDate('2026-10-01'), 4);

    expect(forTwo).not.toEqual(forFour);
  });

  it('店舗側のキーは絞り込みが違えば別になる', () => {
    const all = reservationKeys.ownerList({ date: null, status: null });
    const onlyPending = reservationKeys.ownerList({ date: null, status: 'pending' });

    expect(all).not.toEqual(onlyPending);
  });
});
```

- [ ] **Step 8: テストを走らせて落ちることを確認したあと query-keys.ts を書く**

```bash
npm test -w @meshimap/mobile -- reservations/query-keys
```

期待: `Cannot find module './query-keys'` で FAIL。確認したら実装する。

```ts
// apps/mobile/src/features/reservations/query-keys.ts
import type { JstDate, ReservationId, ShopId } from '@meshimap/core';

import type { OwnerReservationFilter, ReservationScope } from './schema';

/** 絞り込み未指定を表すキー。null をそのままキーに入れると JSON 上で見分けにくい */
const ANY_FILTER = 'any';

/**
 * 予約まわりのクエリキー。
 *
 * **階層 = 無効化の単位**である。react-query の invalidateQueries は前方一致で効くので、
 * 「一覧だけ捨てて詳細は残す」を成立させるには、詳細を一覧の下にぶら下げてはいけない。
 * そのため my-list / my-detail / owner-list / owner-detail を兄弟に並べている。
 */
export const reservationKeys = {
  all: ['reservations'] as const,
  slots: (shopId: ShopId, date: JstDate, partySize: number) =>
    [...reservationKeys.all, 'slots', shopId, date, partySize] as const,
  myLists: () => [...reservationKeys.all, 'my-list'] as const,
  myList: (scope: ReservationScope) => [...reservationKeys.myLists(), scope] as const,
  myDetail: (reservationId: ReservationId) =>
    [...reservationKeys.all, 'my-detail', reservationId] as const,
  ownerLists: () => [...reservationKeys.all, 'owner-list'] as const,
  ownerList: (filter: OwnerReservationFilter) =>
    [
      ...reservationKeys.ownerLists(),
      filter.date ?? ANY_FILTER,
      filter.status ?? ANY_FILTER,
    ] as const,
  ownerDetail: (reservationId: ReservationId) =>
    [...reservationKeys.all, 'owner-detail', reservationId] as const,
};
```

```bash
npm test -w @meshimap/mobile -- reservations/query-keys
```

期待: 6 本すべて PASS。

- [ ] **Step 9: API 層の失敗するテストを書く**

`apps/mobile/src/features/reservations/api.test.ts`:

```ts
import { toJstDate, toMinuteOfDay, toReservationId, toShopId } from '@meshimap/core';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApiError, apiFetch } from '@/lib/api-client';

import {
  cancelReservation,
  createReservation,
  fetchMyReservation,
  fetchMyReservations,
  fetchOwnerReservation,
  fetchOwnerReservations,
  fetchReservationSlots,
  toReservationErrorMessage,
  updateReservationMemo,
  updateReservationStatus,
} from './api';

jest.mock('@/lib/api-client', () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const apiFetchMock = jest.mocked(apiFetch);

const RESERVATION_JSON = {
  id: 'rsv_0001',
  shopId: 'shp_0001',
  shopName: '炭火焼鳥とり源',
  reservedAt: '2026-10-01T09:00:00.000Z',
  partySize: 2,
  note: '',
  status: 'pending',
  createdAt: '2026-09-16T01:00:00.000Z',
};

const OWNER_RESERVATION_JSON = {
  ...RESERVATION_JSON,
  userId: 'usr_0001',
  customerName: 'customer@example.com',
  ownerMemo: '',
};

const SHOP_ID = toShopId('shp_0001');
const RESERVATION_ID = toReservationId('rsv_0001');

describe('fetchReservationSlots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('クエリ文字列を組み立てて GET する', async () => {
    apiFetchMock.mockResolvedValue({
      shopId: 'shp_0001',
      shopName: '炭火焼鳥とり源',
      date: '2026-10-01',
      acceptsReservation: true,
      isClosedOnDate: false,
      slots: [],
    });

    await fetchReservationSlots({ shopId: SHOP_ID, date: toJstDate('2026-10-01'), partySize: 2 });

    expect(apiFetchMock).toHaveBeenCalledWith('/reservation-slots', {
      method: 'GET',
      searchParams: { shopId: 'shp_0001', date: '2026-10-01', partySize: '2' },
    });
  });

  it('返ってきた形を検証する', async () => {
    apiFetchMock.mockResolvedValue({ shopId: 'shp_0001' });

    await expect(
      fetchReservationSlots({ shopId: SHOP_ID, date: toJstDate('2026-10-01'), partySize: 2 }),
    ).rejects.toThrow();
  });
});

describe('createReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('本文を JSON で POST する', async () => {
    apiFetchMock.mockResolvedValue({
      reservationId: 'rsv_0001',
      reservedAt: '2026-10-01T09:00:00.000Z',
    });

    const created = await createReservation({
      shopId: SHOP_ID,
      date: toJstDate('2026-10-01'),
      startMinute: toMinuteOfDay(1080),
      partySize: 2,
      note: '窓際希望',
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/reservations', {
      method: 'POST',
      body: {
        shopId: 'shp_0001',
        date: '2026-10-01',
        startMinute: 1080,
        partySize: 2,
        note: '窓際希望',
      },
    });
    expect(created.reservationId).toBe('rsv_0001');
  });
});

describe('利用者の読み取りとキャンセル', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('一覧は scope を付けて GET し、配列を取り出す', async () => {
    apiFetchMock.mockResolvedValue({ reservations: [RESERVATION_JSON] });

    const rows = await fetchMyReservations('past');

    expect(apiFetchMock).toHaveBeenCalledWith('/reservations', {
      method: 'GET',
      searchParams: { scope: 'past' },
    });
    expect(rows).toHaveLength(1);
  });

  it('詳細はパスに ID を埋めて GET する', async () => {
    apiFetchMock.mockResolvedValue(RESERVATION_JSON);

    await fetchMyReservation(RESERVATION_ID);

    expect(apiFetchMock).toHaveBeenCalledWith('/reservations/rsv_0001', { method: 'GET' });
  });

  it('キャンセルは POST して、取り消し後の予約を返す', async () => {
    apiFetchMock.mockResolvedValue({ ...RESERVATION_JSON, status: 'cancelled' });

    const cancelled = await cancelReservation(RESERVATION_ID);

    expect(apiFetchMock).toHaveBeenCalledWith('/reservations/rsv_0001/cancel', { method: 'POST' });
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('店舗側', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('絞り込みが無ければクエリを付けない', async () => {
    apiFetchMock.mockResolvedValue({ reservations: [] });

    await fetchOwnerReservations({ date: null, status: null });

    expect(apiFetchMock).toHaveBeenCalledWith('/owner/reservations', {
      method: 'GET',
      searchParams: {},
    });
  });

  it('日付と状態を指定したらクエリに載せる', async () => {
    apiFetchMock.mockResolvedValue({ reservations: [OWNER_RESERVATION_JSON] });

    await fetchOwnerReservations({ date: toJstDate('2026-10-01'), status: 'pending' });

    expect(apiFetchMock).toHaveBeenCalledWith('/owner/reservations', {
      method: 'GET',
      searchParams: { date: '2026-10-01', status: 'pending' },
    });
  });

  it('詳細は店舗向けの形で検証する（ownerMemo を含む）', async () => {
    apiFetchMock.mockResolvedValue({ ...OWNER_RESERVATION_JSON, ownerMemo: '窓際' });

    const row = await fetchOwnerReservation(RESERVATION_ID);

    expect(apiFetchMock).toHaveBeenCalledWith('/owner/reservations/rsv_0001', { method: 'GET' });
    expect(row.ownerMemo).toBe('窓際');
  });

  it('状態変更は POST する', async () => {
    apiFetchMock.mockResolvedValue({ ...OWNER_RESERVATION_JSON, status: 'confirmed' });

    const row = await updateReservationStatus({
      reservationId: RESERVATION_ID,
      status: 'confirmed',
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/owner/reservations/rsv_0001/status', {
      method: 'POST',
      body: { status: 'confirmed' },
    });
    expect(row.status).toBe('confirmed');
  });

  it('メモは PATCH する', async () => {
    apiFetchMock.mockResolvedValue({ ...OWNER_RESERVATION_JSON, ownerMemo: '窓際' });

    await updateReservationMemo({ reservationId: RESERVATION_ID, ownerMemo: '窓際' });

    expect(apiFetchMock).toHaveBeenCalledWith('/owner/reservations/rsv_0001/memo', {
      method: 'PATCH',
      body: { ownerMemo: '窓際' },
    });
  });
});

describe('toReservationErrorMessage', () => {
  it('401 はログインを促す', () => {
    expect(toReservationErrorMessage(new ApiError(401, 'x'), 'create')).toBe(
      'ログインしてからやり直してください',
    );
  });

  it('403 は権限が無いと伝える', () => {
    expect(toReservationErrorMessage(new ApiError(403, 'x'), 'owner-update')).toBe(
      'この操作をする権限がありません',
    );
  });

  it('404 は見つからないと伝える', () => {
    expect(toReservationErrorMessage(new ApiError(404, 'x'), 'read')).toBe(
      '予約が見つかりませんでした',
    );
  });

  it('422 は場面ごとに文言が変わる', () => {
    expect(toReservationErrorMessage(new ApiError(422, 'x'), 'create')).toBe(
      'その時間はすでに埋まっています。別の枠を選んでください',
    );
    expect(toReservationErrorMessage(new ApiError(422, 'x'), 'cancel')).toBe(
      'この予約はもうキャンセルできません',
    );
    expect(toReservationErrorMessage(new ApiError(422, 'x'), 'owner-update')).toBe(
      'いまの状態からその操作はできません',
    );
  });

  it('ApiError でないものは通信エラー扱いにする', () => {
    expect(toReservationErrorMessage(new Error('ネットワーク断'), 'read')).toBe(
      '通信に失敗しました。時間をおいてやり直してください',
    );
  });

  it('知らないステータスも通信エラー扱いにする', () => {
    expect(toReservationErrorMessage(new ApiError(500, 'x'), 'read')).toBe(
      '通信に失敗しました。時間をおいてやり直してください',
    );
  });
});
```

- [ ] **Step 10: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/api
```

期待: `Cannot find module './api'` で FAIL。

- [ ] **Step 11: api.ts を実装する**

```ts
// apps/mobile/src/features/reservations/api.ts
import type {
  JstDate,
  MinuteOfDay,
  ReservationId,
  ReservationStatus,
  ShopId,
} from '@meshimap/core';

import { ApiError, apiFetch } from '@/lib/api-client';

import {
  createdReservationSchema,
  dailySlotsSchema,
  ownerReservationListSchema,
  ownerReservationSchema,
  reservationListSchema,
  reservationSchema,
} from './schema';
import type {
  CreatedReservation,
  DailySlots,
  OwnerReservation,
  OwnerReservationFilter,
  Reservation,
  ReservationScope,
} from './schema';

export type ReservationSlotsParams = {
  readonly shopId: ShopId;
  readonly date: JstDate;
  readonly partySize: number;
};

export type CreateReservationParams = {
  readonly shopId: ShopId;
  readonly date: JstDate;
  readonly startMinute: MinuteOfDay;
  readonly partySize: number;
  readonly note: string;
};

export type UpdateReservationStatusParams = {
  readonly reservationId: ReservationId;
  readonly status: ReservationStatus;
};

export type UpdateReservationMemoParams = {
  readonly reservationId: ReservationId;
  readonly ownerMemo: string;
};

export async function fetchReservationSlots(params: ReservationSlotsParams): Promise<DailySlots> {
  const payload = await apiFetch('/reservation-slots', {
    method: 'GET',
    searchParams: {
      shopId: params.shopId,
      date: params.date,
      partySize: String(params.partySize),
    },
  });
  return dailySlotsSchema.parse(payload);
}

export async function createReservation(
  params: CreateReservationParams,
): Promise<CreatedReservation> {
  const payload = await apiFetch('/reservations', {
    method: 'POST',
    body: {
      shopId: params.shopId,
      date: params.date,
      startMinute: params.startMinute,
      partySize: params.partySize,
      note: params.note,
    },
  });
  return createdReservationSchema.parse(payload);
}

export async function fetchMyReservations(
  scope: ReservationScope,
): Promise<readonly Reservation[]> {
  const payload = await apiFetch('/reservations', { method: 'GET', searchParams: { scope } });
  return reservationListSchema.parse(payload).reservations;
}

export async function fetchMyReservation(reservationId: ReservationId): Promise<Reservation> {
  const payload = await apiFetch(`/reservations/${reservationId}`, { method: 'GET' });
  return reservationSchema.parse(payload);
}

export async function cancelReservation(reservationId: ReservationId): Promise<Reservation> {
  const payload = await apiFetch(`/reservations/${reservationId}/cancel`, { method: 'POST' });
  return reservationSchema.parse(payload);
}

export async function fetchOwnerReservations(
  filter: OwnerReservationFilter,
): Promise<readonly OwnerReservation[]> {
  // 未指定のキーは送らない。空文字を送るとサーバの z.iso.date() が 422 を返す
  const searchParams: Record<string, string> = {};
  if (filter.date !== null) {
    searchParams.date = filter.date;
  }
  if (filter.status !== null) {
    searchParams.status = filter.status;
  }

  const payload = await apiFetch('/owner/reservations', { method: 'GET', searchParams });
  return ownerReservationListSchema.parse(payload).reservations;
}

export async function fetchOwnerReservation(
  reservationId: ReservationId,
): Promise<OwnerReservation> {
  const payload = await apiFetch(`/owner/reservations/${reservationId}`, { method: 'GET' });
  return ownerReservationSchema.parse(payload);
}

export async function updateReservationStatus(
  params: UpdateReservationStatusParams,
): Promise<OwnerReservation> {
  const payload = await apiFetch(`/owner/reservations/${params.reservationId}/status`, {
    method: 'POST',
    body: { status: params.status },
  });
  return ownerReservationSchema.parse(payload);
}

export async function updateReservationMemo(
  params: UpdateReservationMemoParams,
): Promise<OwnerReservation> {
  const payload = await apiFetch(`/owner/reservations/${params.reservationId}/memo`, {
    method: 'PATCH',
    body: { ownerMemo: params.ownerMemo },
  });
  return ownerReservationSchema.parse(payload);
}

/** エラー文言を決める場面。同じ 422 でも言うべきことが違う */
export type ReservationErrorContext = 'create' | 'cancel' | 'owner-update' | 'read';

const UNAUTHORIZED_MESSAGE = 'ログインしてからやり直してください';
const FORBIDDEN_MESSAGE = 'この操作をする権限がありません';
const NOT_FOUND_MESSAGE = '予約が見つかりませんでした';
const NETWORK_MESSAGE = '通信に失敗しました。時間をおいてやり直してください';

/** 422 の言い換え。サーバは固定文言しか返さないので、意味付けは端末側の責任 */
const INVALID_INPUT_MESSAGES: Record<ReservationErrorContext, string> = {
  create: 'その時間はすでに埋まっています。別の枠を選んでください',
  cancel: 'この予約はもうキャンセルできません',
  'owner-update': 'いまの状態からその操作はできません',
  read: '指定した条件が正しくありません',
};

const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const INVALID_INPUT_STATUS = 422;

/**
 * 例外を画面に出す日本語へ変換する。
 * サーバの本文をそのまま出さないのは、固定文言（「対象が見つかりません」）が
 * 予約の文脈では意味を成さないため。
 */
export function toReservationErrorMessage(
  error: unknown,
  context: ReservationErrorContext,
): string {
  if (!(error instanceof ApiError)) {
    return NETWORK_MESSAGE;
  }
  switch (error.status) {
    case UNAUTHORIZED_STATUS:
      return UNAUTHORIZED_MESSAGE;
    case FORBIDDEN_STATUS:
      return FORBIDDEN_MESSAGE;
    case NOT_FOUND_STATUS:
      return NOT_FOUND_MESSAGE;
    case INVALID_INPUT_STATUS:
      return INVALID_INPUT_MESSAGES[context];
    default:
      return NETWORK_MESSAGE;
  }
}
```

- [ ] **Step 12: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/api
```

期待: 17 本すべて PASS。

- [ ] **Step 13: 読み取り系フックの失敗するテストを書く**

`apps/mobile/src/features/reservations/use-reservation-slots.test.tsx`:

```tsx
import { toJstDate, toShopId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildDailySlots } from '@/test-support/reservation-fixtures';

import { fetchReservationSlots } from './api';
import { useReservationSlots } from './use-reservation-slots';

jest.mock('./api', () => ({
  fetchReservationSlots: jest.fn(),
  // toReservationErrorMessage は純粋関数。モックすると errorMessage のテストが
  // undefined を呼ぶだけになって何も測らなくなるので、本物を残す
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const fetchReservationSlotsMock = jest.mocked(fetchReservationSlots);
const SHOP_ID = toShopId('shp_0001');
const DATE = toJstDate('2026-10-01');

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  };
}

describe('useReservationSlots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('店舗・日付・人数で取得する', async () => {
    fetchReservationSlotsMock.mockResolvedValue(buildDailySlots());

    const { result } = await renderHook(() => useReservationSlots(SHOP_ID, DATE, 2), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(fetchReservationSlotsMock).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      date: DATE,
      partySize: 2,
    });
    expect(result.current.slots).toHaveLength(2);
  });

  it('取得前は枠を空配列で返す（画面に undefined を渡さない）', async () => {
    fetchReservationSlotsMock.mockReturnValue(new Promise(() => undefined));

    const { result } = await renderHook(() => useReservationSlots(SHOP_ID, DATE, 2), {
      wrapper: createWrapper(),
    });

    expect(result.current.slots).toEqual([]);
    expect(result.current.status).toBe('loading');
  });

  it('404 のときは errorMessage を日本語で返す', async () => {
    fetchReservationSlotsMock.mockRejectedValue(new Error('boom'));

    const { result } = await renderHook(() => useReservationSlots(SHOP_ID, DATE, 2), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe('通信に失敗しました。時間をおいてやり直してください');
  });
});
```

`apps/mobile/src/features/reservations/use-reservations.test.tsx`:

```tsx
import { toReservationId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildReservation } from '@/test-support/reservation-fixtures';

import { fetchMyReservation, fetchMyReservations } from './api';
import { useMyReservation, useMyReservations } from './use-reservations';

jest.mock('./api', () => ({
  fetchMyReservations: jest.fn(),
  fetchMyReservation: jest.fn(),
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const fetchMyReservationsMock = jest.mocked(fetchMyReservations);
const fetchMyReservationMock = jest.mocked(fetchMyReservation);
const RESERVATION_ID = toReservationId('rsv_0001');

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  };
}

describe('useMyReservations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scope をそのまま API へ渡す', async () => {
    fetchMyReservationsMock.mockResolvedValue([buildReservation()]);

    const { result } = await renderHook(() => useMyReservations('past'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(fetchMyReservationsMock).toHaveBeenCalledWith('past');
    expect(result.current.reservations).toHaveLength(1);
  });

  it('0 件でも success にする（空は異常ではない）', async () => {
    fetchMyReservationsMock.mockResolvedValue([]);

    const { result } = await renderHook(() => useMyReservations('upcoming'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.reservations).toEqual([]);
  });
});

describe('useMyReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ID で 1 件取得する', async () => {
    fetchMyReservationMock.mockResolvedValue(buildReservation({ status: 'confirmed' }));

    const { result } = await renderHook(() => useMyReservation(RESERVATION_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.reservation?.status).toBe('confirmed');
  });

  it('取得できないうちは reservation が null', async () => {
    fetchMyReservationMock.mockReturnValue(new Promise(() => undefined));

    const { result } = await renderHook(() => useMyReservation(RESERVATION_ID), {
      wrapper: createWrapper(),
    });

    expect(result.current.reservation).toBeNull();
  });
});
```

`apps/mobile/src/features/reservations/use-owner-reservations.test.tsx`:

```tsx
import { toJstDate, toReservationId } from '@meshimap/core';
import { renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildOwnerReservation } from '@/test-support/reservation-fixtures';

import { fetchOwnerReservation, fetchOwnerReservations } from './api';
import { useOwnerReservation, useOwnerReservations } from './use-owner-reservations';

jest.mock('./api', () => ({
  fetchOwnerReservations: jest.fn(),
  fetchOwnerReservation: jest.fn(),
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const fetchOwnerReservationsMock = jest.mocked(fetchOwnerReservations);
const fetchOwnerReservationMock = jest.mocked(fetchOwnerReservation);
const RESERVATION_ID = toReservationId('rsv_0001');
const NO_FILTER = { date: null, status: null } as const;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  };
}

describe('useOwnerReservations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('絞り込み無しをそのまま API へ渡す', async () => {
    fetchOwnerReservationsMock.mockResolvedValue([buildOwnerReservation()]);

    const { result } = await renderHook(() => useOwnerReservations(NO_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(fetchOwnerReservationsMock).toHaveBeenCalledWith(NO_FILTER);
    expect(result.current.reservations).toHaveLength(1);
  });

  it('日付と状態の絞り込みをそのまま API へ渡す', async () => {
    fetchOwnerReservationsMock.mockResolvedValue([buildOwnerReservation()]);

    const { result } = await renderHook(
      () => useOwnerReservations({ date: toJstDate('2026-10-01'), status: 'pending' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(fetchOwnerReservationsMock).toHaveBeenCalledWith({
      date: '2026-10-01',
      status: 'pending',
    });
  });

  it('0 件でも success にする', async () => {
    fetchOwnerReservationsMock.mockResolvedValue([]);

    const { result } = await renderHook(() => useOwnerReservations(NO_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.reservations).toEqual([]);
  });

  it('失敗したら errorMessage を日本語で返す', async () => {
    fetchOwnerReservationsMock.mockRejectedValue(new Error('boom'));

    const { result } = await renderHook(() => useOwnerReservations(NO_FILTER), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe('通信に失敗しました。時間をおいてやり直してください');
  });
});

describe('useOwnerReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ID で 1 件取得し、店舗メモも受け取る', async () => {
    fetchOwnerReservationMock.mockResolvedValue(
      buildOwnerReservation({ ownerMemo: '窓際を用意する' }),
    );

    const { result } = await renderHook(() => useOwnerReservation(RESERVATION_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(fetchOwnerReservationMock).toHaveBeenCalledWith(RESERVATION_ID);
    expect(result.current.reservation?.ownerMemo).toBe('窓際を用意する');
  });

  it('取得できないうちは reservation が null', async () => {
    fetchOwnerReservationMock.mockReturnValue(new Promise(() => undefined));

    const { result } = await renderHook(() => useOwnerReservation(RESERVATION_ID), {
      wrapper: createWrapper(),
    });

    expect(result.current.reservation).toBeNull();
  });
});
```

- [ ] **Step 14: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- use-reservation-slots use-reservations use-owner-reservations
```

期待: 3 ファイルとも `Cannot find module` で FAIL。

- [ ] **Step 15: 読み取り系フックを実装する**

```ts
// apps/mobile/src/features/reservations/use-reservation-slots.ts
import type { JstDate, ShopId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';

import { fetchReservationSlots, toReservationErrorMessage } from './api';
import { reservationKeys } from './query-keys';
import type { DailySlots, SlotAvailability } from './schema';

export type ReservationSlotsResult = {
  readonly daily: DailySlots | null;
  /** 画面に undefined を渡さないための既定値付き */
  readonly slots: readonly SlotAvailability[];
  readonly status: 'loading' | 'error' | 'success';
  readonly errorMessage: string | null;
  readonly refetch: () => void;
};

const EMPTY_SLOTS: readonly SlotAvailability[] = [];

export function useReservationSlots(
  shopId: ShopId,
  date: JstDate,
  partySize: number,
): ReservationSlotsResult {
  const query = useQuery({
    queryKey: reservationKeys.slots(shopId, date, partySize),
    queryFn: () => fetchReservationSlots({ shopId, date, partySize }),
  });

  return {
    daily: query.data ?? null,
    slots: query.data?.slots ?? EMPTY_SLOTS,
    status: query.status === 'pending' ? 'loading' : query.status,
    errorMessage: query.error === null ? null : toReservationErrorMessage(query.error, 'read'),
    refetch: () => {
      void query.refetch();
    },
  };
}
```

```ts
// apps/mobile/src/features/reservations/use-reservations.ts
import type { ReservationId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';

import { fetchMyReservation, fetchMyReservations, toReservationErrorMessage } from './api';
import { reservationKeys } from './query-keys';
import type { Reservation, ReservationScope } from './schema';

export type ReservationQueryStatus = 'loading' | 'error' | 'success';

export type MyReservationsResult = {
  readonly reservations: readonly Reservation[];
  readonly status: ReservationQueryStatus;
  readonly errorMessage: string | null;
  readonly refetch: () => void;
};

export type MyReservationResult = {
  readonly reservation: Reservation | null;
  readonly status: ReservationQueryStatus;
  readonly errorMessage: string | null;
  readonly refetch: () => void;
};

const EMPTY_RESERVATIONS: readonly Reservation[] = [];

export function useMyReservations(scope: ReservationScope): MyReservationsResult {
  const query = useQuery({
    queryKey: reservationKeys.myList(scope),
    queryFn: () => fetchMyReservations(scope),
  });

  return {
    reservations: query.data ?? EMPTY_RESERVATIONS,
    status: query.status === 'pending' ? 'loading' : query.status,
    errorMessage: query.error === null ? null : toReservationErrorMessage(query.error, 'read'),
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useMyReservation(reservationId: ReservationId): MyReservationResult {
  const query = useQuery({
    queryKey: reservationKeys.myDetail(reservationId),
    queryFn: () => fetchMyReservation(reservationId),
  });

  return {
    reservation: query.data ?? null,
    status: query.status === 'pending' ? 'loading' : query.status,
    errorMessage: query.error === null ? null : toReservationErrorMessage(query.error, 'read'),
    refetch: () => {
      void query.refetch();
    },
  };
}
```

```ts
// apps/mobile/src/features/reservations/use-owner-reservations.ts
import type { ReservationId } from '@meshimap/core';
import { useQuery } from '@tanstack/react-query';

import { fetchOwnerReservation, fetchOwnerReservations, toReservationErrorMessage } from './api';
import { reservationKeys } from './query-keys';
import type { OwnerReservation, OwnerReservationFilter } from './schema';
import type { ReservationQueryStatus } from './use-reservations';

export type OwnerReservationsResult = {
  readonly reservations: readonly OwnerReservation[];
  readonly status: ReservationQueryStatus;
  readonly errorMessage: string | null;
  readonly refetch: () => void;
};

export type OwnerReservationResult = {
  readonly reservation: OwnerReservation | null;
  readonly status: ReservationQueryStatus;
  readonly errorMessage: string | null;
  readonly refetch: () => void;
};

const EMPTY_OWNER_RESERVATIONS: readonly OwnerReservation[] = [];

export function useOwnerReservations(filter: OwnerReservationFilter): OwnerReservationsResult {
  const query = useQuery({
    queryKey: reservationKeys.ownerList(filter),
    queryFn: () => fetchOwnerReservations(filter),
  });

  return {
    reservations: query.data ?? EMPTY_OWNER_RESERVATIONS,
    status: query.status === 'pending' ? 'loading' : query.status,
    errorMessage: query.error === null ? null : toReservationErrorMessage(query.error, 'read'),
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useOwnerReservation(reservationId: ReservationId): OwnerReservationResult {
  const query = useQuery({
    queryKey: reservationKeys.ownerDetail(reservationId),
    queryFn: () => fetchOwnerReservation(reservationId),
  });

  return {
    reservation: query.data ?? null,
    status: query.status === 'pending' ? 'loading' : query.status,
    errorMessage: query.error === null ? null : toReservationErrorMessage(query.error, 'read'),
    refetch: () => {
      void query.refetch();
    },
  };
}
```

**`query.status === 'pending' ? 'loading' : query.status` を 5 か所に書いている。** 共通化したくなるが、共通化すると「react-query の型が変わったときに 1 か所を直せば全部通る」ようになり、変更に気づけない。**ここは意図的に重複させる。** DRY は「知識の重複を避ける」原則であって、同じ形の式を機械的に 1 つにまとめる規則ではない。

- [ ] **Step 16: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- use-reservation-slots use-reservations use-owner-reservations
```

期待: 3 ファイル合計 13 本すべて PASS。

- [ ] **Step 17: 書き込み系フックの失敗するテストを書く**

キャッシュ無効化まで測る。**「ミューテーションが成功したこと」だけを見ると、無効化の書き忘れを一切検知できない。**

`apps/mobile/src/features/reservations/use-create-reservation.test.tsx`:

```tsx
import { toJstDate, toMinuteOfDay, toShopId } from '@meshimap/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';

import { createReservation } from './api';
import { reservationKeys } from './query-keys';
import { useCreateReservation } from './use-create-reservation';

jest.mock('./api', () => ({
  createReservation: jest.fn(),
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const createReservationMock = jest.mocked(createReservation);
const SHOP_ID = toShopId('shp_0001');
const DATE = toJstDate('2026-10-01');

describe('useCreateReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('申込が通ると createdReservationId が入る', async () => {
    createReservationMock.mockResolvedValue({
      reservationId: 'rsv_0001',
      reservedAt: new Date('2026-10-01T09:00:00.000Z'),
    });
    const queryClient = createTestQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
    }

    const { result } = await renderHook(() => useCreateReservation(SHOP_ID, DATE), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.submit({ startMinute: toMinuteOfDay(1080), partySize: 2, note: '' });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.createdReservationId).toBe('rsv_0001');
  });

  it('成功したら枠と自分の一覧のキャッシュを捨てる', async () => {
    createReservationMock.mockResolvedValue({
      reservationId: 'rsv_0001',
      reservedAt: new Date('2026-10-01T09:00:00.000Z'),
    });
    const queryClient = createTestQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
    }

    const { result } = await renderHook(() => useCreateReservation(SHOP_ID, DATE), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.submit({ startMinute: toMinuteOfDay(1080), partySize: 2, note: '' });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    // 枠は「その店のその日」だけ、一覧は upcoming / past の両方を巻き込む
    expect(invalidatedKeys).toContainEqual([...reservationKeys.all, 'slots', SHOP_ID, DATE]);
    expect(invalidatedKeys).toContainEqual(reservationKeys.myLists());
  });

  it('422 なら枠が埋まったことを伝える', async () => {
    const { ApiError } = jest.requireActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    createReservationMock.mockRejectedValue(new ApiError(422, 'x'));
    const queryClient = createTestQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
    }

    const { result } = await renderHook(() => useCreateReservation(SHOP_ID, DATE), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.submit({ startMinute: toMinuteOfDay(1080), partySize: 2, note: '' });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe(
      'その時間はすでに埋まっています。別の枠を選んでください',
    );
  });

  it('reset で idle に戻る', async () => {
    createReservationMock.mockRejectedValue(new Error('boom'));
    const queryClient = createTestQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
    }

    const { result } = await renderHook(() => useCreateReservation(SHOP_ID, DATE), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.submit({ startMinute: toMinuteOfDay(1080), partySize: 2, note: '' });
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });
});
```

`apps/mobile/src/features/reservations/use-cancel-reservation.test.tsx`:

```tsx
import { toReservationId } from '@meshimap/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildReservation } from '@/test-support/reservation-fixtures';

import { cancelReservation } from './api';
import { reservationKeys } from './query-keys';
import { useCancelReservation } from './use-cancel-reservation';

jest.mock('./api', () => ({
  cancelReservation: jest.fn(),
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const cancelReservationMock = jest.mocked(cancelReservation);
const RESERVATION_ID = toReservationId('rsv_0001');

function renderCancelHook(queryClient = createTestQueryClient()) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  const rendered = renderHook(() => useCancelReservation(RESERVATION_ID), {
    wrapper: Wrapper,
  });
  return { queryClient, rendered };
}

describe('useCancelReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('予約 ID を渡して取り消す', async () => {
    cancelReservationMock.mockResolvedValue(buildReservation({ status: 'cancelled' }));

    const { rendered } = renderCancelHook();
    const { result } = await rendered;
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(cancelReservationMock).toHaveBeenCalledWith(RESERVATION_ID);
  });

  it('成功したら一覧と詳細の両方のキャッシュを捨てる', async () => {
    cancelReservationMock.mockResolvedValue(buildReservation({ status: 'cancelled' }));
    const queryClient = createTestQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { rendered } = renderCancelHook(queryClient);
    const { result } = await rendered;
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(reservationKeys.myLists());
    expect(invalidatedKeys).toContainEqual(reservationKeys.myDetail(RESERVATION_ID));
  });

  it('成功したら詳細のキャッシュを取り消し後の姿に置き換える', async () => {
    cancelReservationMock.mockResolvedValue(buildReservation({ status: 'cancelled' }));
    const queryClient = createTestQueryClient();

    const { rendered } = renderCancelHook(queryClient);
    const { result } = await rendered;
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const cached = queryClient.getQueryData(reservationKeys.myDetail(RESERVATION_ID));
    expect((cached as { status: string } | undefined)?.status).toBe('cancelled');
  });

  it('422 ならキャンセルできない旨を返す', async () => {
    const { ApiError } = jest.requireActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    cancelReservationMock.mockRejectedValue(new ApiError(422, 'x'));

    const { rendered } = renderCancelHook();
    const { result } = await rendered;
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe('この予約はもうキャンセルできません');
  });

  it('reset で idle に戻る', async () => {
    cancelReservationMock.mockRejectedValue(new Error('boom'));

    const { rendered } = renderCancelHook();
    const { result } = await rendered;
    await act(async () => {
      result.current.cancel();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });
});
```

`apps/mobile/src/features/reservations/use-update-reservation-status.test.tsx`:

```tsx
import { toReservationId } from '@meshimap/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactNode } from 'react';

import { QueryWrapper, createTestQueryClient } from '@/test-support/query-wrapper';
import { buildOwnerReservation } from '@/test-support/reservation-fixtures';

import { updateReservationMemo, updateReservationStatus } from './api';
import { reservationKeys } from './query-keys';
import {
  useUpdateReservationMemo,
  useUpdateReservationStatus,
} from './use-update-reservation-status';

jest.mock('./api', () => ({
  updateReservationStatus: jest.fn(),
  updateReservationMemo: jest.fn(),
  toReservationErrorMessage:
    jest.requireActual<typeof import('./api')>('./api').toReservationErrorMessage,
}));

const updateReservationStatusMock = jest.mocked(updateReservationStatus);
const updateReservationMemoMock = jest.mocked(updateReservationMemo);
const RESERVATION_ID = toReservationId('rsv_0001');

function buildWrapper(queryClient = createTestQueryClient()) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper queryClient={queryClient}>{children}</QueryWrapper>;
  }
  return { queryClient, Wrapper };
}

describe('useUpdateReservationStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('予約 ID と新しい状態を渡す', async () => {
    updateReservationStatusMock.mockResolvedValue(buildOwnerReservation({ status: 'confirmed' }));
    const { Wrapper } = buildWrapper();

    const { result } = await renderHook(() => useUpdateReservationStatus(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.changeStatus('confirmed');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(updateReservationStatusMock).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      status: 'confirmed',
    });
  });

  it('成功したら店舗側の一覧と詳細を捨てる', async () => {
    updateReservationStatusMock.mockResolvedValue(buildOwnerReservation({ status: 'confirmed' }));
    const { queryClient, Wrapper } = buildWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(() => useUpdateReservationStatus(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.changeStatus('confirmed');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(reservationKeys.ownerLists());
    expect(invalidatedKeys).toContainEqual(reservationKeys.ownerDetail(RESERVATION_ID));
  });

  it('利用者側のキャッシュは捨てない', async () => {
    updateReservationStatusMock.mockResolvedValue(buildOwnerReservation({ status: 'confirmed' }));
    const { queryClient, Wrapper } = buildWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(() => useUpdateReservationStatus(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.changeStatus('confirmed');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(reservationKeys.myLists());
    expect(invalidatedKeys).not.toContainEqual(reservationKeys.myDetail(RESERVATION_ID));
  });

  it('422 なら状態が噛み合わない旨を返す', async () => {
    const { ApiError } = jest.requireActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    updateReservationStatusMock.mockRejectedValue(new ApiError(422, 'x'));
    const { Wrapper } = buildWrapper();

    const { result } = await renderHook(() => useUpdateReservationStatus(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.changeStatus('completed');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.errorMessage).toBe('いまの状態からその操作はできません');
  });
});

describe('useUpdateReservationMemo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('メモを送り、店舗側のキャッシュだけを捨てる', async () => {
    updateReservationMemoMock.mockResolvedValue(buildOwnerReservation({ ownerMemo: '窓際' }));
    const { queryClient, Wrapper } = buildWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = await renderHook(() => useUpdateReservationMemo(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.saveMemo('窓際');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(updateReservationMemoMock).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      ownerMemo: '窓際',
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(reservationKeys.ownerLists());
    expect(invalidatedKeys).not.toContainEqual(reservationKeys.myLists());
  });

  it('空文字のメモも送れる（メモの削除）', async () => {
    updateReservationMemoMock.mockResolvedValue(buildOwnerReservation({ ownerMemo: '' }));
    const { Wrapper } = buildWrapper();

    const { result } = await renderHook(() => useUpdateReservationMemo(RESERVATION_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.saveMemo('');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(updateReservationMemoMock).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      ownerMemo: '',
    });
  });
});
```

- [ ] **Step 18: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- use-create-reservation use-cancel-reservation use-update-reservation-status
```

期待: 3 ファイルとも `Cannot find module` で FAIL。

- [ ] **Step 19: 書き込み系フックを実装する**

```ts
// apps/mobile/src/features/reservations/use-create-reservation.ts
import type { JstDate, MinuteOfDay, ReservationId, ShopId } from '@meshimap/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createReservation, toReservationErrorMessage } from './api';
import { reservationKeys } from './query-keys';

export type CreateReservationFields = {
  readonly startMinute: MinuteOfDay;
  readonly partySize: number;
  readonly note: string;
};

export type CreateReservationResult = {
  readonly status: 'idle' | 'submitting' | 'error' | 'success';
  readonly errorMessage: string | null;
  readonly createdReservationId: ReservationId | null;
  readonly submit: (fields: CreateReservationFields) => void;
  readonly reset: () => void;
};

export function useCreateReservation(shopId: ShopId, date: JstDate): CreateReservationResult {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (fields: CreateReservationFields) =>
      createReservation({
        shopId,
        date,
        startMinute: fields.startMinute,
        partySize: fields.partySize,
        note: fields.note,
      }),
    onSuccess: async () => {
      // 枠は「その店のその日」だけ捨てる。人数まで含めると、
      // 2 名で取ったあと 4 名の枠が古いままになる。人数を含めない前方一致にする
      await queryClient.invalidateQueries({
        queryKey: [...reservationKeys.all, 'slots', shopId, date],
      });
      await queryClient.invalidateQueries({ queryKey: reservationKeys.myLists() });
    },
  });

  return {
    status: mutation.status === 'pending' ? 'submitting' : mutation.status,
    errorMessage:
      mutation.error === null ? null : toReservationErrorMessage(mutation.error, 'create'),
    createdReservationId: mutation.data?.reservationId ?? null,
    submit: (fields) => {
      mutation.mutate(fields);
    },
    reset: () => {
      mutation.reset();
    },
  };
}
```

```ts
// apps/mobile/src/features/reservations/use-cancel-reservation.ts
import type { ReservationId } from '@meshimap/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { cancelReservation, toReservationErrorMessage } from './api';
import { reservationKeys } from './query-keys';

export type CancelReservationResult = {
  readonly status: 'idle' | 'submitting' | 'error' | 'success';
  readonly errorMessage: string | null;
  readonly cancel: () => void;
  readonly reset: () => void;
};

export function useCancelReservation(reservationId: ReservationId): CancelReservationResult {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => cancelReservation(reservationId),
    onSuccess: async (cancelled) => {
      // 応答が取り消し後の姿そのものなので、詳細は捨てずに置き換える。
      // 置き換えてから無効化すると、画面が一瞬も古い状態を見ない
      queryClient.setQueryData(reservationKeys.myDetail(reservationId), cancelled);
      await queryClient.invalidateQueries({ queryKey: reservationKeys.myLists() });
      await queryClient.invalidateQueries({
        queryKey: reservationKeys.myDetail(reservationId),
      });
    },
  });

  return {
    status: mutation.status === 'pending' ? 'submitting' : mutation.status,
    errorMessage:
      mutation.error === null ? null : toReservationErrorMessage(mutation.error, 'cancel'),
    cancel: () => {
      mutation.mutate();
    },
    reset: () => {
      mutation.reset();
    },
  };
}
```

```ts
// apps/mobile/src/features/reservations/use-update-reservation-status.ts
import type { ReservationId, ReservationStatus } from '@meshimap/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { toReservationErrorMessage, updateReservationMemo, updateReservationStatus } from './api';
import { reservationKeys } from './query-keys';
import type { OwnerReservation } from './schema';

export type OwnerMutationStatus = 'idle' | 'submitting' | 'error' | 'success';

export type UpdateReservationStatusResult = {
  readonly status: OwnerMutationStatus;
  readonly errorMessage: string | null;
  readonly changeStatus: (to: ReservationStatus) => void;
  readonly reset: () => void;
};

export type UpdateReservationMemoResult = {
  readonly status: OwnerMutationStatus;
  readonly errorMessage: string | null;
  readonly saveMemo: (ownerMemo: string) => void;
  readonly reset: () => void;
};

/**
 * 店舗側の更新後に捨てるキャッシュ。
 * **利用者側（my-list / my-detail）は捨てない。** 店主の端末に客の一覧は存在せず、
 * 捨てても無駄な再取得が起きるだけだから。客の画面は客の端末が引き直す。
 */
async function invalidateOwnerCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  reservationId: ReservationId,
  updated: OwnerReservation,
): Promise<void> {
  queryClient.setQueryData(reservationKeys.ownerDetail(reservationId), updated);
  await queryClient.invalidateQueries({ queryKey: reservationKeys.ownerLists() });
  await queryClient.invalidateQueries({ queryKey: reservationKeys.ownerDetail(reservationId) });
}

export function useUpdateReservationStatus(
  reservationId: ReservationId,
): UpdateReservationStatusResult {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (to: ReservationStatus) => updateReservationStatus({ reservationId, status: to }),
    onSuccess: async (updated) => {
      await invalidateOwnerCaches(queryClient, reservationId, updated);
    },
  });

  return {
    status: mutation.status === 'pending' ? 'submitting' : mutation.status,
    errorMessage:
      mutation.error === null ? null : toReservationErrorMessage(mutation.error, 'owner-update'),
    changeStatus: (to) => {
      mutation.mutate(to);
    },
    reset: () => {
      mutation.reset();
    },
  };
}

export function useUpdateReservationMemo(
  reservationId: ReservationId,
): UpdateReservationMemoResult {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (ownerMemo: string) => updateReservationMemo({ reservationId, ownerMemo }),
    onSuccess: async (updated) => {
      await invalidateOwnerCaches(queryClient, reservationId, updated);
    },
  });

  return {
    status: mutation.status === 'pending' ? 'submitting' : mutation.status,
    errorMessage:
      mutation.error === null ? null : toReservationErrorMessage(mutation.error, 'owner-update'),
    saveMemo: (ownerMemo) => {
      mutation.mutate(ownerMemo);
    },
    reset: () => {
      mutation.reset();
    },
  };
}
```

- [ ] **Step 20: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations
npm run typecheck -w @meshimap/mobile
npm run lint -w @meshimap/mobile
```

期待: 予約まわり合計 51 本 PASS、型エラー 0、lint エラー 0。

- [ ] **Step 21: わざと壊してテストが落ちることを確認する**

(a) `reservationSchema` の `status` を `z.string()` に変える:

→ 「知らない状態は弾く」が FAIL。

(b) `blockReasonSchema` に `'because-i-said-so'` を足す:

→ 「知らない理由コードは弾く」が FAIL。`satisfies readonly ReservationBlockReason[]` のおかげで、そもそも**コンパイルが先に落ちる**ことも確認する。

(c) `query-keys.ts` の `myDetail` を `[...reservationKeys.myLists(), 'detail', reservationId]` に変える:

→ 「詳細のキーは myLists() に含まれない」が FAIL。**一覧の無効化が詳細まで巻き込む設計ミスが、ここで止まる。**

(d) `useCreateReservation` の `onSuccess` から `myLists()` の無効化を消す:

→ 「成功したら枠と自分の一覧のキャッシュを捨てる」が FAIL。

(e) `useCreateReservation` の枠の無効化キーに `partySize` を足す:

→ 同じテストが FAIL（`toContainEqual` の比較対象が 5 要素になる）。人数を含めると 4 名ぶんの枠が古いまま残る、という設計判断がテストで固定されていることの確認。

(f) `useUpdateReservationStatus` の `onSuccess` に `reservationKeys.myLists()` の無効化を足す:

→ 「利用者側は無効化されない」が FAIL。

(g) `toReservationErrorMessage` の `case 422` を消す:

→ 「422 は場面ごとに文言が変わる」の 3 本が FAIL。

(h) `fetchOwnerReservations` で `filter.date === null` のときに `searchParams.date = ''` を入れる:

→ 「絞り込みが無ければクエリを付けない」が FAIL。

8 つとも確認したら元に戻す。

- [ ] **Step 22: ミューテーションテストを回す**

```bash
npm run test:mutation -w @meshimap/mobile
```

`src/features/reservations/**` が対象。生き残ったミュータントへの対応は 3 つだけ（テストの穴 → テストを足す / 出力を変えない最適化 → 呼び出し回数で縛る / 到達不能 → 到達できる形に書き直してから殺す）。**「除外する」は選択肢に無い。**

想定される生き残りと、その潰し方:

| 生き残りそうな変異                                    | 潰し方                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query.data ?? EMPTY_SLOTS` → `query.data ?? []`      | 出力が同じ最適化。`toBe(EMPTY_SLOTS)` ではなく `toEqual([])` で十分なので、**この変異は殺せない**。`EMPTY_SLOTS` を module const にしている目的は再レンダリング時の参照安定なので、**参照が変わらないことを直接テストする**（2 回 render して `result.current.slots` の参照が同一であることを見る） |
| `ANY_FILTER` の文字列を変える                         | キーの中身を直接比較するテストを 1 本足す（`ownerList({date:null,status:null})` の末尾 2 要素が `'any'` であること）                                                                                                                                                                                |
| `status === 'pending' ? 'loading' : ...` の三項の反転 | 「取得前は枠を空配列で返す」が `status: 'loading'` を見ているので殺せる。見ていなければ足す                                                                                                                                                                                                         |

- [ ] **Step 23: コミット**

```bash
git add apps/mobile/src/features/reservations/ apps/mobile/src/test-support/reservation-fixtures.ts
git commit -m "feat(mobile): 予約の schema・API 層・クエリキー・9 つのフックを追加"
```

---

## Task 7-15: 予約申込画面

`(user)/shop/[shopId]/reserve.tsx` と、そこで使う部品 4 つを作る。**双方向フローの「行き」の入口**である。

**Files:**

- Create: `apps/mobile/src/features/reservations/status-label.ts`
- Create: `apps/mobile/src/features/reservations/status-label.test.ts`
- Create: `apps/mobile/src/features/reservations/format.ts`
- Create: `apps/mobile/src/features/reservations/format.test.ts`
- Create: `apps/mobile/src/components/reservation/reservation-status-badge.tsx`
- Create: `apps/mobile/src/components/reservation/reservation-status-badge.test.tsx`
- Create: `apps/mobile/src/components/reservation/slot-picker.tsx`
- Create: `apps/mobile/src/components/reservation/slot-picker.test.tsx`
- Create: `apps/mobile/src/app/(user)/shop/[shopId]/reserve.tsx`
- Create: `apps/mobile/src/app/(user)/shop/[shopId]/reserve.test.tsx`

**Interfaces:**

- Consumes: `@meshimap/core` の `PARTY_SIZE_MAX` / `PARTY_SIZE_MIN` / `RESERVATION_NOTE_MAX_LENGTH` / `addJstDays` / `formatMinuteOfDay` / `toJstClock` / `toShopId` / 型 `JstDate` / `MinuteOfDay` / `ReservationBlockReason` / `ReservationStatus` / `ShopId`、`@/components/ui/badge` の `Badge` / 型 `BadgeTone`、`@/components/ui/button` の `Button`、`@/components/ui/input` の `Input`、`@/components/ui/error-state` の `ErrorState`、`@/components/ui/empty-state` の `EmptyState`、`@/components/ui/skeleton` の `Skeleton`、`@/lib/query-params` の `readSingleQueryValue`、`@/hooks/use-now` の `useStableNow`、Task 7-14 の `useReservationSlots` / `useCreateReservation` / 型 `SlotAvailability`、`expo-router` の `router` / `useLocalSearchParams`、`lucide-react-native` の `CalendarX`
- Produces:
  - `status-label.ts`: `RESERVATION_STATUS_LABELS` / `RESERVATION_STATUS_TONES` / `BLOCK_REASON_LABELS`
  - `format.ts`: `formatReservationDate(date: JstDate): string` / `formatReservedAt(reservedAt: Date): string` / `formatPartySize(partySize: number): string`
  - `reservation-status-badge.tsx`: `ReservationStatusBadge` / 型 `ReservationStatusBadgeProps`
  - `slot-picker.tsx`: `SlotPicker` / 型 `SlotPickerProps`
  - `reserve.tsx`: expo-router の画面（**default export**。expo-router の規約なので例外として許される）

---

- [ ] **Step 1: ラベルと書式の失敗するテストを書く**

`apps/mobile/src/features/reservations/status-label.test.ts`:

```ts
import { RESERVATION_STATUSES } from '@meshimap/core';
import { describe, expect, it } from '@jest/globals';

import {
  BLOCK_REASON_LABELS,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
} from './status-label';

describe('RESERVATION_STATUS_LABELS', () => {
  it('6 状態すべてに日本語のラベルがある', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(RESERVATION_STATUS_LABELS[status]).not.toBe('');
    }
  });

  it('承認待ちと承認済みを別の言葉で出す', () => {
    expect(RESERVATION_STATUS_LABELS.pending).toBe('承認待ち');
    expect(RESERVATION_STATUS_LABELS.confirmed).toBe('予約確定');
  });

  it('店舗都合の拒否と利用者都合の取消を区別する', () => {
    expect(RESERVATION_STATUS_LABELS.rejected).toBe('お断り');
    expect(RESERVATION_STATUS_LABELS.cancelled).toBe('キャンセル済み');
  });

  it('来店済みと無断キャンセルを区別する', () => {
    expect(RESERVATION_STATUS_LABELS.completed).toBe('来店済み');
    expect(RESERVATION_STATUS_LABELS.no_show).toBe('無断キャンセル');
  });
});

describe('RESERVATION_STATUS_TONES', () => {
  it('確定と来店済みだけが success になる', () => {
    const successStatuses = RESERVATION_STATUSES.filter(
      (status) => RESERVATION_STATUS_TONES[status] === 'success',
    );

    expect([...successStatuses].sort()).toEqual(['completed', 'confirmed']);
  });

  it('承認待ちは warning、お断りと無断キャンセルは danger', () => {
    expect(RESERVATION_STATUS_TONES.pending).toBe('warning');
    expect(RESERVATION_STATUS_TONES.rejected).toBe('danger');
    expect(RESERVATION_STATUS_TONES.no_show).toBe('danger');
  });

  it('6 状態すべてに色がある', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(RESERVATION_STATUS_TONES[status]).toBeDefined();
    }
  });
});

describe('BLOCK_REASON_LABELS', () => {
  it('4 つの理由それぞれに説明がある', () => {
    expect(BLOCK_REASON_LABELS['not-accepting']).toBe('予約受付を停止中です');
    expect(BLOCK_REASON_LABELS['party-too-large']).toBe('この人数は受け付けていません');
    expect(BLOCK_REASON_LABELS['parallel-full']).toBe('同時間帯の予約が上限です');
    expect(BLOCK_REASON_LABELS['seats-full']).toBe('満席です');
  });
});
```

`apps/mobile/src/features/reservations/format.test.ts`:

```ts
import { toJstDate } from '@meshimap/core';
import { describe, expect, it } from '@jest/globals';

import { formatPartySize, formatReservationDate, formatReservedAt } from './format';

describe('formatReservationDate', () => {
  it('月日と曜日を出す', () => {
    // 2026-10-01 は木曜（dayOfWeekOf が 4 を返すことを実装時に確認する）
    expect(formatReservationDate(toJstDate('2026-10-01'))).toBe('10/1（木）');
  });

  it('1 月 1 日も 0 埋めしない', () => {
    expect(formatReservationDate(toJstDate('2027-01-01'))).toBe('1/1（金）');
  });

  it('日曜も曜日が出る', () => {
    expect(formatReservationDate(toJstDate('2026-10-04'))).toBe('10/4（日）');
  });
});

describe('formatReservedAt', () => {
  it('UTC の Date を JST の「月日（曜）時刻」にする', () => {
    // 2026-10-01T09:00:00Z = JST 2026-10-01 18:00
    expect(formatReservedAt(new Date('2026-10-01T09:00:00.000Z'))).toBe('10/1（木）18:00');
  });

  it('JST で日付が変わる時刻を取り違えない', () => {
    // 2026-10-01T16:00:00Z = JST 2026-10-02 01:00。UTC のまま読むと 10/1 になってしまう
    expect(formatReservedAt(new Date('2026-10-01T16:00:00.000Z'))).toBe('10/2（金）1:00');
  });
});

describe('formatPartySize', () => {
  it('人数に単位を付ける', () => {
    expect(formatPartySize(2)).toBe('2 名');
  });
});
```

**「JST で日付が変わる時刻」のテストを置いた理由。** `reservedAt` は UTC の瞬間であり、`getMonth()` を素で呼ぶと端末のタイムゾーン設定に結果が左右される。Jest の実行環境が UTC でも JST でも同じ答えになることを、このテストが固定する。

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/status-label reservations/format
```

期待: 両方とも `Cannot find module` で FAIL。

- [ ] **Step 3: 実装する**

```ts
// apps/mobile/src/features/reservations/status-label.ts
import type { ReservationBlockReason, ReservationStatus } from '@meshimap/core';

import type { BadgeTone } from '@/components/ui/badge';

/**
 * 状態 → 画面に出す日本語。
 * `Record<ReservationStatus, string>` なので、状態が増えるとここがコンパイルエラーになる。
 * Phase 6 の OPEN_STATUS_LABELS と同じ手口で、文言の付け忘れを型で止める。
 */
export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: '承認待ち',
  confirmed: '予約確定',
  rejected: 'お断り',
  cancelled: 'キャンセル済み',
  completed: '来店済み',
  no_show: '無断キャンセル',
};

export const RESERVATION_STATUS_TONES: Record<ReservationStatus, BadgeTone> = {
  pending: 'warning',
  confirmed: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  completed: 'success',
  no_show: 'danger',
};

/** 枠が押せない理由。core の判定順（受付停止 → 人数 → 件数 → 残席）と同じ並びで書く */
export const BLOCK_REASON_LABELS: Record<ReservationBlockReason, string> = {
  'not-accepting': '予約受付を停止中です',
  'party-too-large': 'この人数は受け付けていません',
  'parallel-full': '同時間帯の予約が上限です',
  'seats-full': '満席です',
};
```

```ts
// apps/mobile/src/features/reservations/format.ts
import { dayOfWeekOf, formatMinuteOfDay, toJstClock } from '@meshimap/core';
import type { DayOfWeek, JstDate } from '@meshimap/core';

/** 曜日番号 → 1 文字。core の DayOfWeek は 0 = 日曜（jst-clock.ts の getUTCDay 由来） */
const DAY_OF_WEEK_LABELS: Record<DayOfWeek, string> = {
  0: '日',
  1: '月',
  2: '火',
  3: '水',
  4: '木',
  5: '金',
  6: '土',
};

const MONTH_INDEX = 1;
const DAY_INDEX = 2;

/** 「10/1（木）」。JstDate は YYYY-MM-DD の文字列なので、分解して 0 埋めを外すだけ */
export function formatReservationDate(date: JstDate): string {
  const parts = date.split('-');
  const month = Number(parts[MONTH_INDEX]);
  const day = Number(parts[DAY_INDEX]);
  return `${month}/${day}（${DAY_OF_WEEK_LABELS[dayOfWeekOf(date)]}）`;
}

/**
 * 「10/1（木）18:00」。
 * **必ず toJstClock を通す。** Date のまま getMonth() を呼ぶと端末の TZ 設定に従ってしまい、
 * 海外で使うと日付が 1 日ずれる。JST への変換は core に 1 か所だけある実装を使う。
 */
export function formatReservedAt(reservedAt: Date): string {
  const clock = toJstClock(reservedAt);
  return `${formatReservationDate(clock.date)}${formatMinuteOfDay(clock.minuteOfDay)}`;
}

const PARTY_SIZE_SUFFIX = ' 名';

export function formatPartySize(partySize: number): string {
  return `${partySize}${PARTY_SIZE_SUFFIX}`;
}
```

**`formatMinuteOfDay` が「18:00」を返すことは Task 7-4 で確認済み**（枠のラベル生成で同じ関数を使っている）。`formatReservedAt` のテストが「1:00」を期待しているのは、`formatMinuteOfDay` が時を 0 埋めしないため。**もし実際の出力が「01:00」だったら、テストの期待値ではなく、この段落を直す。** 実装前に `packages/core/src/minute-of-day.ts` を開いて確かめること。

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- reservations/status-label reservations/format
```

期待: 14 本すべて PASS。

- [ ] **Step 5: 状態バッジの失敗するテストを書く**

`apps/mobile/src/components/reservation/reservation-status-badge.test.tsx`:

```tsx
import { RESERVATION_STATUSES } from '@meshimap/core';
import { render, screen } from '@testing-library/react-native';
import { describe, expect, it } from '@jest/globals';

import { ReservationStatusBadge } from './reservation-status-badge';

describe('ReservationStatusBadge', () => {
  it('6 状態すべてを日本語で出す', async () => {
    for (const status of RESERVATION_STATUSES) {
      const view = await render(<ReservationStatusBadge status={status} testID="badge" />);

      expect(screen.getByTestId('badge')).toBeTruthy();
      view.unmount();
    }
  });

  it('承認待ちは「承認待ち」と出す', async () => {
    await render(<ReservationStatusBadge status="pending" testID="badge" />);

    expect(screen.getByText('承認待ち')).toBeTruthy();
  });

  it('確定と承認待ちで背景クラスが違う', async () => {
    const confirmed = await render(<ReservationStatusBadge status="confirmed" testID="badge" />);
    const confirmedClassName = screen.getByTestId('badge').props.className;
    confirmed.unmount();

    await render(<ReservationStatusBadge status="pending" testID="badge" />);

    expect(screen.getByTestId('badge').props.className).not.toBe(confirmedClassName);
  });
});
```

- [ ] **Step 6: テストを走らせて落ちることを確認してから実装する**

```bash
npm test -w @meshimap/mobile -- reservation-status-badge
```

期待: `Cannot find module './reservation-status-badge'` で FAIL。

```tsx
// apps/mobile/src/components/reservation/reservation-status-badge.tsx
import type { ReservationStatus } from '@meshimap/core';

import { Badge } from '@/components/ui/badge';
import {
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
} from '@/features/reservations/status-label';

export type ReservationStatusBadgeProps = {
  status: ReservationStatus;
  testID?: string | undefined;
};

export function ReservationStatusBadge({ status, testID }: ReservationStatusBadgeProps) {
  return (
    <Badge
      label={RESERVATION_STATUS_LABELS[status]}
      tone={RESERVATION_STATUS_TONES[status]}
      testID={testID}
    />
  );
}
```

```bash
npm test -w @meshimap/mobile -- reservation-status-badge
```

期待: 3 本 PASS。

- [ ] **Step 7: 枠選択 UI の失敗するテストを書く**

`apps/mobile/src/components/reservation/slot-picker.test.tsx`:

```tsx
import { toMinuteOfDay } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SlotAvailability } from '@/features/reservations/schema';

import { SlotPicker } from './slot-picker';

function buildSlot(overrides: Partial<SlotAvailability> = {}): SlotAvailability {
  return {
    startMinute: toMinuteOfDay(1080),
    endMinute: toMinuteOfDay(1140),
    label: '18:00',
    isAvailable: true,
    reason: null,
    remainingSeats: 6,
    ...overrides,
  };
}

const OPEN_SLOT = buildSlot();
const FULL_SLOT = buildSlot({
  startMinute: toMinuteOfDay(1140),
  endMinute: toMinuteOfDay(1200),
  label: '19:00',
  isAvailable: false,
  reason: 'seats-full',
  remainingSeats: 0,
});

describe('SlotPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('枠のラベルをサーバの文字列そのままで出す', async () => {
    await render(
      <SlotPicker
        slots={[OPEN_SLOT, FULL_SLOT]}
        selectedStartMinute={null}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.getByText('18:00')).toBeTruthy();
    expect(screen.getByText('19:00')).toBeTruthy();
  });

  it('空いている枠を押すと開始分を返す', async () => {
    const handleSelect = jest.fn();
    await render(
      <SlotPicker
        slots={[OPEN_SLOT]}
        selectedStartMinute={null}
        onSelect={handleSelect}
        testID="slot-picker"
      />,
    );

    fireEvent.press(screen.getByTestId('slot-picker-slot-1080'));

    expect(handleSelect).toHaveBeenCalledWith(1080);
  });

  it('埋まっている枠を押しても何も起きない', async () => {
    const handleSelect = jest.fn();
    await render(
      <SlotPicker
        slots={[FULL_SLOT]}
        selectedStartMinute={null}
        onSelect={handleSelect}
        testID="slot-picker"
      />,
    );

    fireEvent.press(screen.getByTestId('slot-picker-slot-1140'));

    expect(handleSelect).not.toHaveBeenCalled();
  });

  it('埋まっている枠には理由を出す', async () => {
    await render(
      <SlotPicker
        slots={[FULL_SLOT]}
        selectedStartMinute={null}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.getByText('満席です')).toBeTruthy();
  });

  it('残席が少ないときだけ残席を出す', async () => {
    await render(
      <SlotPicker
        slots={[
          buildSlot({ remainingSeats: 2 }),
          buildSlot({
            startMinute: toMinuteOfDay(1140),
            label: '19:00',
            remainingSeats: 9,
          }),
        ]}
        selectedStartMinute={null}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.getByText('残り 2 席')).toBeTruthy();
    expect(screen.queryByText('残り 9 席')).toBeNull();
  });

  it('選択中の枠には選択状態が付く', async () => {
    await render(
      <SlotPicker
        slots={[OPEN_SLOT, FULL_SLOT]}
        selectedStartMinute={toMinuteOfDay(1080)}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.getByTestId('slot-picker-slot-1080').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('slot-picker-slot-1140').props.accessibilityState.selected).toBe(
      false,
    );
  });

  it('埋まっている枠は accessibilityState.disabled が true', async () => {
    await render(
      <SlotPicker
        slots={[FULL_SLOT]}
        selectedStartMinute={null}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.getByTestId('slot-picker-slot-1140').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('枠が 0 件なら何も描かない', async () => {
    await render(
      <SlotPicker
        slots={[]}
        selectedStartMinute={null}
        onSelect={jest.fn()}
        testID="slot-picker"
      />,
    );

    expect(screen.queryByTestId('slot-picker')).toBeNull();
  });
});
```

**`accessibilityState` を見ているのは飾りではない。** 予約は「どの時間を選んだか」が全てで、視覚的な色だけで示すと VoiceOver / TalkBack の利用者に伝わらない。押せない理由も同様に、色ではなくテキストで出す。

- [ ] **Step 8: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- slot-picker
```

期待: `Cannot find module './slot-picker'` で FAIL。

- [ ] **Step 9: SlotPicker を実装する**

```tsx
// apps/mobile/src/components/reservation/slot-picker.tsx
import type { MinuteOfDay } from '@meshimap/core';
import { Pressable, Text, View } from 'react-native';

import { BLOCK_REASON_LABELS } from '@/features/reservations/status-label';
import type { SlotAvailability } from '@/features/reservations/schema';

/** これ以下なら「残り n 席」を出す。十分空いているときに煽らない */
const LOW_SEAT_THRESHOLD = 3;
const LOW_SEAT_PREFIX = '残り ';
const LOW_SEAT_SUFFIX = ' 席';

export type SlotPickerProps = {
  slots: readonly SlotAvailability[];
  selectedStartMinute: MinuteOfDay | null;
  onSelect: (startMinute: MinuteOfDay) => void;
  testID?: string | undefined;
};

function slotTestID(testID: string | undefined, startMinute: MinuteOfDay): string | undefined {
  return testID === undefined ? undefined : `${testID}-slot-${startMinute}`;
}

export function SlotPicker({ slots, selectedStartMinute, onSelect, testID }: SlotPickerProps) {
  if (slots.length === 0) {
    // 空のときの見せ方は呼び出し側（画面）の責任。ここで EmptyState を描くと、
    // 「休業日」と「受付停止」と「取得前」を区別できなくなる
    return null;
  }

  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {slots.map((slot) => {
        const isSelected = selectedStartMinute === slot.startMinute;
        const showsRemaining = slot.isAvailable && slot.remainingSeats <= LOW_SEAT_THRESHOLD;

        return (
          <Pressable
            key={slot.startMinute}
            accessibilityRole="button"
            accessibilityState={{ disabled: !slot.isAvailable, selected: isSelected }}
            disabled={!slot.isAvailable}
            onPress={() => {
              onSelect(slot.startMinute);
            }}
            className={buildSlotClassName(slot.isAvailable, isSelected)}
            testID={slotTestID(testID, slot.startMinute)}
          >
            <Text className={slot.isAvailable ? 'text-neutral-900' : 'text-neutral-400'}>
              {slot.label}
            </Text>
            {slot.reason === null ? null : (
              <Text className="text-xs text-neutral-500">{BLOCK_REASON_LABELS[slot.reason]}</Text>
            )}
            {showsRemaining ? (
              <Text className="text-xs text-amber-700">
                {`${LOW_SEAT_PREFIX}${slot.remainingSeats}${LOW_SEAT_SUFFIX}`}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const SLOT_BASE_CLASS = 'min-w-[96px] items-center rounded-lg border px-3 py-2';

function buildSlotClassName(isAvailable: boolean, isSelected: boolean): string {
  if (!isAvailable) {
    return `${SLOT_BASE_CLASS} border-neutral-200 bg-neutral-100`;
  }
  if (isSelected) {
    return `${SLOT_BASE_CLASS} border-brand-600 bg-brand-50`;
  }
  return `${SLOT_BASE_CLASS} border-neutral-300 bg-white`;
}
```

**`disabled` と `accessibilityState.disabled` を両方書いている。** 前者が押下を止め、後者が支援技術に伝える。React Native は `disabled` を `accessibilityState` に自動反映しないので、片方だけでは足りない。

- [ ] **Step 10: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- slot-picker
```

期待: 8 本 PASS。

- [ ] **Step 11: 予約申込画面の失敗するテストを書く**

`apps/mobile/src/app/(user)/shop/[shopId]/reserve.test.tsx`:

```tsx
import { toJstDate, toMinuteOfDay } from '@meshimap/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router, useLocalSearchParams } from 'expo-router';

import { buildDailySlots } from '@/test-support/reservation-fixtures';

import { useCreateReservation } from '@/features/reservations/use-create-reservation';
import { useReservationSlots } from '@/features/reservations/use-reservation-slots';

import ReserveScreen from './reserve';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));
jest.mock('@/features/reservations/use-reservation-slots', () => ({
  useReservationSlots: jest.fn(),
}));
jest.mock('@/features/reservations/use-create-reservation', () => ({
  useCreateReservation: jest.fn(),
}));
jest.mock('@/hooks/use-now', () => ({
  // 2026-09-16T01:00:00Z = JST 2026-09-16 10:00。この日を「今日」として扱う
  useStableNow: () => new Date('2026-09-16T01:00:00.000Z'),
}));

const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);
const useReservationSlotsMock = jest.mocked(useReservationSlots);
const useCreateReservationMock = jest.mocked(useCreateReservation);
const submitMock = jest.fn();
const resetMock = jest.fn();

function stubSlots(overrides: Partial<ReturnType<typeof useReservationSlots>> = {}) {
  const daily = buildDailySlots();
  useReservationSlotsMock.mockReturnValue({
    daily,
    slots: daily.slots,
    status: 'success',
    errorMessage: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

function stubCreate(overrides: Partial<ReturnType<typeof useCreateReservation>> = {}) {
  useCreateReservationMock.mockReturnValue({
    status: 'idle',
    errorMessage: null,
    createdReservationId: null,
    submit: submitMock,
    reset: resetMock,
    ...overrides,
  });
}

describe('ReserveScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({ shopId: 'shp_0001' });
    stubSlots();
    stubCreate();
  });

  it('店舗 ID が無ければエラー表示にして枠を取りに行かない', async () => {
    useLocalSearchParamsMock.mockReturnValue({});

    await render(<ReserveScreen />);

    expect(screen.getByTestId('reserve-invalid-params')).toBeTruthy();
    expect(useReservationSlotsMock).not.toHaveBeenCalled();
  });

  it('店舗 ID が識別子の形でなければエラー表示にする', async () => {
    useLocalSearchParamsMock.mockReturnValue({ shopId: '../../etc/passwd' });

    await render(<ReserveScreen />);

    expect(screen.getByTestId('reserve-invalid-params')).toBeTruthy();
    expect(useReservationSlotsMock).not.toHaveBeenCalled();
  });

  it('初期表示は今日・2 名で枠を取りに行く', async () => {
    await render(<ReserveScreen />);

    expect(useReservationSlotsMock).toHaveBeenCalledWith('shp_0001', '2026-09-16', 2);
  });

  it('日付を選び直すと新しい日付で取りに行く', async () => {
    await render(<ReserveScreen />);

    fireEvent.press(screen.getByTestId('reserve-date-2026-09-18'));

    expect(useReservationSlotsMock).toHaveBeenLastCalledWith('shp_0001', '2026-09-18', 2);
  });

  it('人数を増やすと新しい人数で取りに行く', async () => {
    await render(<ReserveScreen />);

    fireEvent.press(screen.getByTestId('reserve-party-size-increment'));

    expect(useReservationSlotsMock).toHaveBeenLastCalledWith('shp_0001', '2026-09-16', 3);
  });

  it('人数は下限 1 より下げられない', async () => {
    await render(<ReserveScreen />);

    fireEvent.press(screen.getByTestId('reserve-party-size-decrement'));
    fireEvent.press(screen.getByTestId('reserve-party-size-decrement'));

    expect(useReservationSlotsMock).toHaveBeenLastCalledWith('shp_0001', '2026-09-16', 1);
  });

  it('枠を選ぶまで申込ボタンは押せない', async () => {
    await render(<ReserveScreen />);

    expect(screen.getByTestId('reserve-submit').props.accessibilityState.disabled).toBe(true);
  });

  it('枠を選んで申し込むと、選んだ内容を submit に渡す', async () => {
    await render(<ReserveScreen />);

    fireEvent.press(screen.getByTestId('reserve-slot-picker-slot-1080'));
    fireEvent.changeText(screen.getByTestId('reserve-note'), '窓際希望');
    fireEvent.press(screen.getByTestId('reserve-submit'));

    expect(submitMock).toHaveBeenCalledWith({
      startMinute: 1080,
      partySize: 2,
      note: '窓際希望',
    });
  });

  it('日付を変えたら選択中の枠を捨てる', async () => {
    await render(<ReserveScreen />);

    fireEvent.press(screen.getByTestId('reserve-slot-picker-slot-1080'));
    fireEvent.press(screen.getByTestId('reserve-date-2026-09-18'));

    expect(screen.getByTestId('reserve-submit').props.accessibilityState.disabled).toBe(true);
  });

  it('受付停止の店では申し込めないと伝える', async () => {
    const daily = buildDailySlots({ acceptsReservation: false, slots: [] });
    stubSlots({ daily, slots: [] });

    await render(<ReserveScreen />);

    expect(screen.getByText('この店舗は予約を受け付けていません')).toBeTruthy();
    expect(screen.queryByTestId('reserve-submit')).toBeNull();
  });

  it('休業日は休業だと伝える', async () => {
    const daily = buildDailySlots({ isClosedOnDate: true, slots: [] });
    stubSlots({ daily, slots: [] });

    await render(<ReserveScreen />);

    expect(screen.getByText('この日は営業していません')).toBeTruthy();
  });

  it('取得中はスケルトンを出す', async () => {
    stubSlots({ daily: null, slots: [], status: 'loading' });

    await render(<ReserveScreen />);

    expect(screen.getByTestId('reserve-skeleton')).toBeTruthy();
  });

  it('取得に失敗したら再試行できる', async () => {
    const refetch = jest.fn();
    stubSlots({
      daily: null,
      slots: [],
      status: 'error',
      errorMessage: '通信に失敗しました',
      refetch,
    });

    await render(<ReserveScreen />);
    fireEvent.press(screen.getByText('再試行'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('申込に失敗したらエラー文言を出し、画面遷移しない', async () => {
    stubCreate({
      status: 'error',
      errorMessage: 'その時間はすでに埋まっています。別の枠を選んでください',
    });

    await render(<ReserveScreen />);

    expect(screen.getByText('その時間はすでに埋まっています。別の枠を選んでください')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('申込が通ったら予約詳細へ置き換え遷移する', async () => {
    stubCreate({ status: 'success', createdReservationId: 'rsv_0001' });

    await render(<ReserveScreen />);

    expect(router.replace).toHaveBeenCalledWith('/reservations/rsv_0001');
  });

  it('送信中は申込ボタンを押せなくする', async () => {
    stubCreate({ status: 'submitting' });

    await render(<ReserveScreen />);

    expect(screen.getByTestId('reserve-submit').props.accessibilityState.disabled).toBe(true);
  });
});
```

**「申込が通ったら `replace` する」を `push` ではなく `replace` にしている理由。** 申込済みの画面へ戻るボタンで帰れてしまうと、同じ枠をもう一度押せる。サーバ側は Durable Object で二重予約を止めるが、**利用者に「押せるのに失敗するボタン」を見せない**のが画面側の責任である。

- [ ] **Step 12: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- shop/reserve
```

期待: `Cannot find module './reserve'` で FAIL。

- [ ] **Step 13: 画面を実装する**

```tsx
// apps/mobile/src/app/(user)/shop/[shopId]/reserve.tsx
import {
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  RESERVATION_NOTE_MAX_LENGTH,
  addJstDays,
  identifierSchema,
  toJstClock,
  toShopId,
} from '@meshimap/core';
import type { JstDate, MinuteOfDay, ShopId } from '@meshimap/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { SlotPicker } from '@/components/reservation/slot-picker';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatReservationDate } from '@/features/reservations/format';
import { useCreateReservation } from '@/features/reservations/use-create-reservation';
import { useReservationSlots } from '@/features/reservations/use-reservation-slots';
import { useStableNow } from '@/hooks/use-now';
import { readSingleQueryValue } from '@/lib/query-params';

/** 何日先まで選べるか。設計書の「2 週間先まで」に合わせる */
const SELECTABLE_DAY_COUNT = 14;
const DEFAULT_PARTY_SIZE = 2;
const SKELETON_HEIGHT_PX = 120;

const INVALID_PARAMS_TITLE = '店舗を特定できませんでした';
const INVALID_PARAMS_DESCRIPTION = 'もう一度お店の画面から開き直してください';
const NOT_ACCEPTING_MESSAGE = 'この店舗は予約を受け付けていません';
const CLOSED_MESSAGE = 'この日は営業していません';
const NO_SLOT_MESSAGE = 'この日に予約できる時間がありません';
const SUBMIT_LABEL = 'この内容で予約する';
const NOTE_LABEL = 'お店への要望（任意）';
const NOTE_PLACEHOLDER = 'アレルギー、席の希望など';
const PARTY_SIZE_LABEL = '人数';
const DATE_LABEL = '日付';
const TIME_LABEL = '時間';

/**
 * 画面の外側。パラメータの検証だけを行う。
 * フックを呼ぶ前に return する必要があるので、内側のコンポーネントと 2 段に分ける
 * （Phase 6 の shop/[shopId]/index.tsx と同じ形）。
 */
export default function ReserveScreen() {
  const params = useLocalSearchParams();
  const rawShopId = readSingleQueryValue(params.shopId);
  const parsed = identifierSchema.safeParse(rawShopId);

  if (!parsed.success) {
    return (
      <View className="flex-1 items-center justify-center p-6" testID="reserve-invalid-params">
        <Text className="text-base font-semibold text-neutral-900">{INVALID_PARAMS_TITLE}</Text>
        <Text className="mt-2 text-sm text-neutral-600">{INVALID_PARAMS_DESCRIPTION}</Text>
      </View>
    );
  }

  return <ReserveForm shopId={toShopId(parsed.data)} />;
}

type ReserveFormProps = { shopId: ShopId };

function ReserveForm({ shopId }: ReserveFormProps) {
  const now = useStableNow();
  const today = toJstClock(now).date;
  const selectableDates = useMemo(
    () => Array.from({ length: SELECTABLE_DAY_COUNT }, (_, index) => addJstDays(today, index)),
    [today],
  );

  const [selectedDate, setSelectedDate] = useState<JstDate>(today);
  const [partySize, setPartySize] = useState(DEFAULT_PARTY_SIZE);
  const [selectedStartMinute, setSelectedStartMinute] = useState<MinuteOfDay | null>(null);
  const [note, setNote] = useState('');

  const slotsResult = useReservationSlots(shopId, selectedDate, partySize);
  const createResult = useCreateReservation(shopId, selectedDate);

  // 申込が通った瞬間に詳細へ差し替える。戻って同じ枠を押せる状態を残さない
  useEffect(() => {
    if (createResult.createdReservationId !== null) {
      router.replace(`/reservations/${createResult.createdReservationId}`);
    }
  }, [createResult.createdReservationId]);

  /** 日付や人数が変わると枠の意味が変わるので、選択済みの時間は必ず捨てる */
  function changeDate(next: JstDate): void {
    setSelectedDate(next);
    setSelectedStartMinute(null);
  }

  function changePartySize(delta: number): void {
    setPartySize((current) => {
      const next = current + delta;
      if (next < PARTY_SIZE_MIN || next > PARTY_SIZE_MAX) {
        return current;
      }
      setSelectedStartMinute(null);
      return next;
    });
  }

  const canSubmit = selectedStartMinute !== null && createResult.status !== 'submitting';

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="p-4 gap-6">
      <View className="gap-2">
        <Text className="text-sm font-semibold text-neutral-700">{DATE_LABEL}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {selectableDates.map((date) => (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityState={{ selected: date === selectedDate }}
                onPress={() => {
                  changeDate(date);
                }}
                className={
                  date === selectedDate
                    ? 'border-brand-600 bg-brand-50 rounded-lg border px-3 py-2'
                    : 'rounded-lg border border-neutral-300 bg-white px-3 py-2'
                }
                testID={`reserve-date-${date}`}
              >
                <Text className="text-neutral-900">{formatReservationDate(date)}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>

      <View className="gap-2">
        <Text className="text-sm font-semibold text-neutral-700">{PARTY_SIZE_LABEL}</Text>
        <View className="flex-row items-center gap-4">
          <Button
            label="−"
            variant="outline"
            size="sm"
            onPress={() => {
              changePartySize(-1);
            }}
            isDisabled={partySize <= PARTY_SIZE_MIN}
            testID="reserve-party-size-decrement"
          />
          <Text className="text-lg text-neutral-900" testID="reserve-party-size-value">
            {`${partySize} 名`}
          </Text>
          <Button
            label="＋"
            variant="outline"
            size="sm"
            onPress={() => {
              changePartySize(1);
            }}
            isDisabled={partySize >= PARTY_SIZE_MAX}
            testID="reserve-party-size-increment"
          />
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-sm font-semibold text-neutral-700">{TIME_LABEL}</Text>
        <SlotSection
          slotsResult={slotsResult}
          selectedStartMinute={selectedStartMinute}
          onSelect={setSelectedStartMinute}
        />
      </View>

      {slotsResult.daily?.acceptsReservation === true &&
      slotsResult.daily.isClosedOnDate === false ? (
        <>
          <Input
            label={NOTE_LABEL}
            value={note}
            onChangeText={setNote}
            placeholder={NOTE_PLACEHOLDER}
            isMultiline
            maxLength={RESERVATION_NOTE_MAX_LENGTH}
            testID="reserve-note"
          />
          {createResult.errorMessage === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-red-700">
              {createResult.errorMessage}
            </Text>
          )}
          <Button
            label={SUBMIT_LABEL}
            onPress={() => {
              if (selectedStartMinute === null) {
                return;
              }
              createResult.submit({ startMinute: selectedStartMinute, partySize, note });
            }}
            isDisabled={!canSubmit}
            isLoading={createResult.status === 'submitting'}
            testID="reserve-submit"
          />
        </>
      ) : null}
    </ScrollView>
  );
}

type SlotSectionProps = {
  slotsResult: ReturnType<typeof useReservationSlots>;
  selectedStartMinute: MinuteOfDay | null;
  onSelect: (startMinute: MinuteOfDay) => void;
};

/** 枠の 5 状態（取得中 / 失敗 / 受付停止 / 休業 / 0 件）を 1 か所で出し分ける */
function SlotSection({ slotsResult, selectedStartMinute, onSelect }: SlotSectionProps) {
  if (slotsResult.status === 'loading') {
    return <Skeleton height={SKELETON_HEIGHT_PX} testID="reserve-skeleton" />;
  }
  if (slotsResult.status === 'error') {
    return (
      <ErrorState
        description={slotsResult.errorMessage ?? undefined}
        onRetry={slotsResult.refetch}
        testID="reserve-slots-error"
      />
    );
  }
  if (slotsResult.daily === null || !slotsResult.daily.acceptsReservation) {
    return <Text className="text-sm text-neutral-600">{NOT_ACCEPTING_MESSAGE}</Text>;
  }
  if (slotsResult.daily.isClosedOnDate) {
    return <Text className="text-sm text-neutral-600">{CLOSED_MESSAGE}</Text>;
  }
  if (slotsResult.slots.length === 0) {
    return <Text className="text-sm text-neutral-600">{NO_SLOT_MESSAGE}</Text>;
  }

  return (
    <SlotPicker
      slots={slotsResult.slots}
      selectedStartMinute={selectedStartMinute}
      onSelect={onSelect}
      testID="reserve-slot-picker"
    />
  );
}
```

**`identifierSchema.safeParse` を使って `toShopId` の例外に頼っていない。** `toShopId` は不正な値で `RangeError` を投げる（`packages/core/src/identifier.ts`）。画面の render の中で投げると React のエラー境界まで飛んで白画面になる。**利用者に見せる失敗は例外ではなく分岐で書く。**

- [ ] **Step 14: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- shop/reserve
npm run typecheck -w @meshimap/mobile
npm run lint -w @meshimap/mobile
```

期待: 16 本 PASS、型エラー 0、lint エラー 0。

- [ ] **Step 15: わざと壊してテストが落ちることを確認する**

(a) `changeDate` から `setSelectedStartMinute(null)` を消す:

→ 「日付を変えたら選択中の枠を捨てる」が FAIL。**これを消すと、10/1 の 18:00 を選んだまま 10/3 で申し込める。** 埋まっている枠へ申し込めてしまう経路がここで止まる。

(b) `changePartySize` の `next < PARTY_SIZE_MIN` を `next < 0` に変える:

→ 「人数は下限 1 より下げられない」が FAIL。

(c) `router.replace` を `router.push` に変える:

→ 「申込が通ったら予約詳細へ置き換え遷移する」が FAIL。

(d) `SlotPicker` の `disabled={!slot.isAvailable}` を消す:

→ 「埋まっている枠を押しても何も起きない」が FAIL。

(e) `SlotSection` の受付停止判定と休業判定の順序を入れ替える:

→ 受付停止かつ休業日のテストが無いので**落ちない**。ここはテストの穴なので、`buildDailySlots({ acceptsReservation: false, isClosedOnDate: true, slots: [] })` で「受付停止が優先される」テストを 1 本足してから、もう一度壊して FAIL を確認する。

(f) `canSubmit` の `selectedStartMinute !== null` を `true` に変える:

→ 「枠を選ぶまで申込ボタンは押せない」が FAIL。

(g) `formatReservedAt` の `toJstClock(reservedAt)` を `reservedAt` の `getUTCHours()` 直読みに変える:

→ 「JST で日付が変わる時刻を取り違えない」が FAIL。

(h) `RESERVATION_STATUS_TONES.completed` を `'neutral'` に変える:

→ 「確定と来店済みだけが success になる」が FAIL。

8 つとも確認したら元に戻す（(e) は足したテストを残す）。

- [ ] **Step 16: ミューテーションテストを回す**

```bash
npm run test:mutation -w @meshimap/mobile
```

想定される生き残りと潰し方:

| 生き残りそうな変異                    | 分類 | 潰し方                                                                                                                                                                                                                        |
| ------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOW_SEAT_THRESHOLD` の `<=` → `<`    | 1    | 残席ちょうど 3 の枠で「残り 3 席」が出るテストを足す（境界値）                                                                                                                                                                |
| `SELECTABLE_DAY_COUNT` の `14` → `13` | 1    | 「最後に選べる日は 13 日後」を `reserve-date-2026-09-29` の存在で確認する                                                                                                                                                     |
| `slots.length === 0` の `0` → `-1`    | 3    | 長さは負にならないので到達不能。`slots.length === 0` を `slots.length < 1` にせず、**早期 return 自体を消して呼び出し側の分岐に寄せる**か、0 件と 1 件の両方のテストで挟む（既にあるので、1 件のテストを 1 本足すだけで死ぬ） |
| `changePartySize(1)` の `1` → `-1`    | 1    | 「人数を増やすと 3 になる」が既に見ているので死ぬ。死ななければ増減の両方を 1 本のテストで往復させる                                                                                                                          |

- [ ] **Step 17: コミット**

```bash
git add apps/mobile/src/features/reservations/ apps/mobile/src/components/reservation/ "apps/mobile/src/app/(user)/shop/[shopId]/reserve.tsx" "apps/mobile/src/app/(user)/shop/[shopId]/reserve.test.tsx"
git commit -m "feat(mobile): 予約申込画面と枠選択 UI を追加"
```

---

## Task 7-16: 利用者の予約一覧と詳細

申し込んだあとに「いま自分の予約がどうなっているか」を見る 2 画面。**店舗側の承認が利用者に届く場所**なので、双方向フローの「帰り」の受け口にあたる。

**Files:**

- Create: `apps/mobile/src/components/reservation/reservation-card.tsx`
- Create: `apps/mobile/src/components/reservation/reservation-card.test.tsx`
- Create: `apps/mobile/src/app/(user)/reservations/index.tsx`
- Create: `apps/mobile/src/app/(user)/reservations/index.test.tsx`
- Create: `apps/mobile/src/app/(user)/reservations/[reservationId].tsx`
- Create: `apps/mobile/src/app/(user)/reservations/[reservationId].test.tsx`

**Interfaces:**

- Consumes: Task 7-14 の `useMyReservations` / `useMyReservation` / `useCancelReservation` / 型 `Reservation` / `ReservationScope` / `RESERVATION_SCOPES`、Task 7-15 の `ReservationStatusBadge` / `formatPartySize` / `formatReservedAt` / `RESERVATION_STATUS_LABELS`、`@meshimap/core` の `identifierSchema` / `toReservationId` / 型 `ReservationId`、`@/components/ui/*` の `Button` / `EmptyState` / `ErrorState` / `Skeleton`、`@/lib/query-params` の `readSingleQueryValue`、`expo-router` の `router` / `useLocalSearchParams`、`lucide-react-native` の `CalendarCheck`
- Produces:
  - `reservation-card.tsx`: `ReservationCard` / 型 `ReservationCardProps`
  - 2 つの画面（**default export**、expo-router の規約）

---

- [ ] **Step 1: 一覧の 1 行の失敗するテストを書く**

`apps/mobile/src/components/reservation/reservation-card.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { buildReservation } from '@/test-support/reservation-fixtures';

import { ReservationCard } from './reservation-card';

describe('ReservationCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('店名・日時・人数・状態を出す', async () => {
    await render(
      <ReservationCard
        reservation={buildReservation({ shopName: '炭火焼鳥とり源', partySize: 4 })}
        onPress={jest.fn()}
        testID="reservation-card"
      />,
    );

    expect(screen.getByText('炭火焼鳥とり源')).toBeTruthy();
    expect(screen.getByText('10/1（木）18:00')).toBeTruthy();
    expect(screen.getByText('4 名')).toBeTruthy();
    expect(screen.getByText('承認待ち')).toBeTruthy();
  });

  it('押すと予約 ID を返す', async () => {
    const handlePress = jest.fn();
    await render(
      <ReservationCard
        reservation={buildReservation()}
        onPress={handlePress}
        testID="reservation-card"
      />,
    );

    fireEvent.press(screen.getByTestId('reservation-card'));

    expect(handlePress).toHaveBeenCalledWith('rsv_0001');
  });

  it('要望があれば 1 行だけ出す', async () => {
    await render(
      <ReservationCard
        reservation={buildReservation({ note: '窓際希望' })}
        onPress={jest.fn()}
        testID="reservation-card"
      />,
    );

    expect(screen.getByTestId('reservation-card-note').props.numberOfLines).toBe(1);
    expect(screen.getByText('窓際希望')).toBeTruthy();
  });

  it('要望が空なら行ごと出さない', async () => {
    await render(
      <ReservationCard
        reservation={buildReservation({ note: '' })}
        onPress={jest.fn()}
        testID="reservation-card"
      />,
    );

    expect(screen.queryByTestId('reservation-card-note')).toBeNull();
  });

  it('状態が変わるとバッジの文言が変わる', async () => {
    await render(
      <ReservationCard
        reservation={buildReservation({ status: 'confirmed' })}
        onPress={jest.fn()}
        testID="reservation-card"
      />,
    );

    expect(screen.getByText('予約確定')).toBeTruthy();
    expect(screen.queryByText('承認待ち')).toBeNull();
  });

  it('読み上げ用のラベルに店名・日時・状態をまとめる', async () => {
    await render(
      <ReservationCard
        reservation={buildReservation({ shopName: '炭火焼鳥とり源', partySize: 2 })}
        onPress={jest.fn()}
        testID="reservation-card"
      />,
    );

    expect(screen.getByTestId('reservation-card').props.accessibilityLabel).toBe(
      '炭火焼鳥とり源、10/1（木）18:00、2 名、承認待ち',
    );
  });
});
```

**読み上げラベルのテストを置く理由。** カードは店名・日時・人数・バッジの 4 つのテキストに分かれている。スクリーンリーダーは要素を 1 つずつ読むので、まとめたラベルを付けないと「炭火焼鳥とり源」の次に何が来るか分からない。**カードの意味は 4 要素の組でしか成立しない。**

- [ ] **Step 2: テストを走らせて落ちることを確認してから実装する**

```bash
npm test -w @meshimap/mobile -- reservation-card
```

期待: `Cannot find module './reservation-card'` で FAIL。

```tsx
// apps/mobile/src/components/reservation/reservation-card.tsx
import type { ReservationId } from '@meshimap/core';
import { Pressable, Text, View } from 'react-native';

import { ReservationStatusBadge } from '@/components/reservation/reservation-status-badge';
import { formatPartySize, formatReservedAt } from '@/features/reservations/format';
import { RESERVATION_STATUS_LABELS } from '@/features/reservations/status-label';
import type { Reservation } from '@/features/reservations/schema';

const ACCESSIBILITY_LABEL_SEPARATOR = '、';
const NOTE_LINE_COUNT = 1;

export type ReservationCardProps = {
  reservation: Reservation;
  onPress: (reservationId: ReservationId) => void;
  testID?: string | undefined;
};

export function ReservationCard({ reservation, onPress, testID }: ReservationCardProps) {
  const reservedAtLabel = formatReservedAt(reservation.reservedAt);
  const accessibilityLabel = [
    reservation.shopName,
    reservedAtLabel,
    formatPartySize(reservation.partySize),
    RESERVATION_STATUS_LABELS[reservation.status],
  ].join(ACCESSIBILITY_LABEL_SEPARATOR);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        onPress(reservation.id);
      }}
      className="gap-2 rounded-xl border border-neutral-200 bg-white p-4"
      testID={testID}
    >
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-base font-semibold text-neutral-900">
          {reservation.shopName}
        </Text>
        <ReservationStatusBadge
          status={reservation.status}
          testID={testID === undefined ? undefined : `${testID}-status`}
        />
      </View>
      <View className="flex-row gap-3">
        <Text className="text-sm text-neutral-700">{reservedAtLabel}</Text>
        <Text className="text-sm text-neutral-700">{formatPartySize(reservation.partySize)}</Text>
      </View>
      {reservation.note === '' ? null : (
        <Text
          numberOfLines={NOTE_LINE_COUNT}
          className="text-sm text-neutral-500"
          testID={testID === undefined ? undefined : `${testID}-note`}
        >
          {reservation.note}
        </Text>
      )}
    </Pressable>
  );
}
```

```bash
npm test -w @meshimap/mobile -- reservation-card
```

期待: 6 本 PASS。

- [ ] **Step 3: 一覧画面の失敗するテストを書く**

`apps/mobile/src/app/(user)/reservations/index.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router } from 'expo-router';

import { useMyReservations } from '@/features/reservations/use-reservations';
import { buildReservation } from '@/test-support/reservation-fixtures';

import ReservationListScreen from './index';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/features/reservations/use-reservations', () => ({ useMyReservations: jest.fn() }));

const useMyReservationsMock = jest.mocked(useMyReservations);

function stubList(overrides: Partial<ReturnType<typeof useMyReservations>> = {}) {
  useMyReservationsMock.mockReturnValue({
    reservations: [buildReservation()],
    status: 'success',
    errorMessage: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

describe('ReservationListScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubList();
  });

  it('初期表示はこれからの予約を取りに行く', async () => {
    await render(<ReservationListScreen />);

    expect(useMyReservationsMock).toHaveBeenCalledWith('upcoming');
  });

  it('タブを切り替えると過去の予約を取りに行く', async () => {
    await render(<ReservationListScreen />);

    fireEvent.press(screen.getByTestId('reservation-scope-past'));

    expect(useMyReservationsMock).toHaveBeenLastCalledWith('past');
  });

  it('選択中のタブに selected が付く', async () => {
    await render(<ReservationListScreen />);

    expect(screen.getByTestId('reservation-scope-upcoming').props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByTestId('reservation-scope-past').props.accessibilityState.selected).toBe(
      false,
    );
  });

  it('予約を押すと詳細へ進む', async () => {
    await render(<ReservationListScreen />);

    fireEvent.press(screen.getByTestId('reservation-item-rsv_0001'));

    expect(router.push).toHaveBeenCalledWith('/reservations/rsv_0001');
  });

  it('取得中はスケルトンを出す', async () => {
    stubList({ reservations: [], status: 'loading' });

    await render(<ReservationListScreen />);

    expect(screen.getByTestId('reservation-list-skeleton')).toBeTruthy();
  });

  it('0 件のときは空状態を出す', async () => {
    stubList({ reservations: [] });

    await render(<ReservationListScreen />);

    expect(screen.getByText('これからの予約はありません')).toBeTruthy();
  });

  it('過去タブで 0 件のときは文言が変わる', async () => {
    stubList({ reservations: [] });
    await render(<ReservationListScreen />);

    fireEvent.press(screen.getByTestId('reservation-scope-past'));

    expect(screen.getByText('過去の予約はありません')).toBeTruthy();
  });

  it('失敗したら再試行できる', async () => {
    const refetch = jest.fn();
    stubList({ reservations: [], status: 'error', errorMessage: '通信に失敗しました', refetch });

    await render(<ReservationListScreen />);
    fireEvent.press(screen.getByText('再試行'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('複数件を順番どおりに出す', async () => {
    stubList({
      reservations: [
        buildReservation({ id: 'rsv_0001', shopName: '一番目' }),
        buildReservation({ id: 'rsv_0002', shopName: '二番目' }),
      ],
    });

    await render(<ReservationListScreen />);

    expect(screen.getByTestId('reservation-item-rsv_0001')).toBeTruthy();
    expect(screen.getByTestId('reservation-item-rsv_0002')).toBeTruthy();
  });
});
```

- [ ] **Step 4: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- "reservations/index"
```

期待: `Cannot find module './index'` で FAIL。

- [ ] **Step 5: 一覧画面を実装する**

```tsx
// apps/mobile/src/app/(user)/reservations/index.tsx
import type { ReservationId } from '@meshimap/core';
import { router } from 'expo-router';
import { CalendarCheck } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import { ReservationCard } from '@/components/reservation/reservation-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { RESERVATION_SCOPES } from '@/features/reservations/schema';
import type { Reservation, ReservationScope } from '@/features/reservations/schema';
import { useMyReservations } from '@/features/reservations/use-reservations';

const SCOPE_LABELS: Record<ReservationScope, string> = {
  upcoming: 'これから',
  past: '過去',
};

const EMPTY_TITLES: Record<ReservationScope, string> = {
  upcoming: 'これからの予約はありません',
  past: '過去の予約はありません',
};

const EMPTY_DESCRIPTION = 'お店の画面から予約できます';
const SKELETON_HEIGHT_PX = 96;
const SKELETON_COUNT = 3;

export default function ReservationListScreen() {
  const [scope, setScope] = useState<ReservationScope>('upcoming');
  const listResult = useMyReservations(scope);

  function openDetail(reservationId: ReservationId): void {
    router.push(`/reservations/${reservationId}`);
  }

  return (
    <View className="flex-1 bg-neutral-50">
      <View className="flex-row gap-2 p-4">
        {RESERVATION_SCOPES.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: value === scope }}
            onPress={() => {
              setScope(value);
            }}
            className={
              value === scope
                ? 'bg-brand-600 rounded-full px-4 py-2'
                : 'rounded-full bg-neutral-200 px-4 py-2'
            }
            testID={`reservation-scope-${value}`}
          >
            <Text className={value === scope ? 'text-white' : 'text-neutral-700'}>
              {SCOPE_LABELS[value]}
            </Text>
          </Pressable>
        ))}
      </View>
      <ReservationListBody listResult={listResult} scope={scope} onSelect={openDetail} />
    </View>
  );
}

type ReservationListBodyProps = {
  listResult: ReturnType<typeof useMyReservations>;
  scope: ReservationScope;
  onSelect: (reservationId: ReservationId) => void;
};

function ReservationListBody({ listResult, scope, onSelect }: ReservationListBodyProps) {
  if (listResult.status === 'loading') {
    return (
      <View className="gap-3 px-4" testID="reservation-list-skeleton">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          <Skeleton key={index} height={SKELETON_HEIGHT_PX} />
        ))}
      </View>
    );
  }
  if (listResult.status === 'error') {
    return (
      <ErrorState
        description={listResult.errorMessage ?? undefined}
        onRetry={listResult.refetch}
        testID="reservation-list-error"
      />
    );
  }
  if (listResult.reservations.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title={EMPTY_TITLES[scope]}
        description={EMPTY_DESCRIPTION}
        testID="reservation-list-empty"
      />
    );
  }

  return (
    <FlatList
      data={listResult.reservations}
      keyExtractor={(item: Reservation) => item.id}
      contentContainerClassName="gap-3 px-4 pb-6"
      renderItem={({ item }: { item: Reservation }) => (
        <ReservationCard
          reservation={item}
          onPress={onSelect}
          testID={`reservation-item-${item.id}`}
        />
      )}
      testID="reservation-list"
    />
  );
}
```

**空状態の文言を `Record<ReservationScope, string>` にしている。** タブが 3 つ目に増えたとき、文言の追加を忘れるとコンパイルエラーになる。「これからの予約はありません」を両方のタブで使い回すと、過去タブで意味が通らない。

- [ ] **Step 6: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- "reservations/index"
```

期待: 9 本 PASS。

- [ ] **Step 7: 詳細画面の失敗するテストを書く**

`apps/mobile/src/app/(user)/reservations/[reservationId].test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router, useLocalSearchParams } from 'expo-router';

import { useCancelReservation } from '@/features/reservations/use-cancel-reservation';
import { useMyReservation } from '@/features/reservations/use-reservations';
import { buildReservation } from '@/test-support/reservation-fixtures';

import ReservationDetailScreen from './[reservationId]';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));
jest.mock('@/features/reservations/use-reservations', () => ({ useMyReservation: jest.fn() }));
jest.mock('@/features/reservations/use-cancel-reservation', () => ({
  useCancelReservation: jest.fn(),
}));

const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);
const useMyReservationMock = jest.mocked(useMyReservation);
const useCancelReservationMock = jest.mocked(useCancelReservation);
const routerPushMock = jest.mocked(router.push);
const cancelMock = jest.fn();

function stubDetail(overrides: Partial<ReturnType<typeof useMyReservation>> = {}) {
  useMyReservationMock.mockReturnValue({
    reservation: buildReservation(),
    status: 'success',
    errorMessage: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

function stubCancel(overrides: Partial<ReturnType<typeof useCancelReservation>> = {}) {
  useCancelReservationMock.mockReturnValue({
    status: 'idle',
    errorMessage: null,
    cancel: cancelMock,
    reset: jest.fn(),
    ...overrides,
  });
}

describe('ReservationDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({ reservationId: 'rsv_0001' });
    stubDetail();
    stubCancel();
  });

  it('予約 ID が不正ならエラー表示にして取りに行かない', async () => {
    useLocalSearchParamsMock.mockReturnValue({ reservationId: '' });

    await render(<ReservationDetailScreen />);

    expect(screen.getByTestId('reservation-detail-invalid-params')).toBeTruthy();
    expect(useMyReservationMock).not.toHaveBeenCalled();
  });

  it('店名・日時・人数・状態を出す', async () => {
    stubDetail({ reservation: buildReservation({ shopName: '炭火焼鳥とり源', partySize: 4 }) });

    await render(<ReservationDetailScreen />);

    expect(screen.getByText('炭火焼鳥とり源')).toBeTruthy();
    expect(screen.getByText('10/1（木）18:00')).toBeTruthy();
    expect(screen.getByText('4 名')).toBeTruthy();
    expect(screen.getByText('承認待ち')).toBeTruthy();
  });

  it('要望が空なら「なし」と出す', async () => {
    stubDetail({ reservation: buildReservation({ note: '' }) });

    await render(<ReservationDetailScreen />);

    expect(screen.getByTestId('reservation-detail-note')).toHaveTextContent('なし');
  });

  it('店舗ページへ移動できる（経路案内はそこの地図ボタンから開く）', async () => {
    stubDetail({ reservation: buildReservation({ shopId: 'shp_0042' }) });

    await render(<ReservationDetailScreen />);
    fireEvent.press(screen.getByTestId('reservation-detail-shop-link'));

    expect(routerPushMock).toHaveBeenCalledWith('/shop/shp_0042');
  });

  it('承認待ちならキャンセルできる', async () => {
    await render(<ReservationDetailScreen />);

    expect(screen.getByTestId('reservation-detail-cancel')).toBeTruthy();
  });

  it('確定済みでもキャンセルできる', async () => {
    stubDetail({ reservation: buildReservation({ status: 'confirmed' }) });

    await render(<ReservationDetailScreen />);

    expect(screen.getByTestId('reservation-detail-cancel')).toBeTruthy();
  });

  it('終端の状態ではキャンセルボタンを出さない', async () => {
    for (const status of ['rejected', 'cancelled', 'completed', 'no_show']) {
      stubDetail({ reservation: buildReservation({ status }) });

      const view = await render(<ReservationDetailScreen />);

      expect(screen.queryByTestId('reservation-detail-cancel')).toBeNull();
      view.unmount();
    }
  });

  it('1 回押しただけでは取り消さない（確認を挟む）', async () => {
    await render(<ReservationDetailScreen />);

    fireEvent.press(screen.getByTestId('reservation-detail-cancel'));

    expect(cancelMock).not.toHaveBeenCalled();
    expect(screen.getByText('この予約をキャンセルしますか？')).toBeTruthy();
  });

  it('確認してから押すと取り消す', async () => {
    await render(<ReservationDetailScreen />);

    fireEvent.press(screen.getByTestId('reservation-detail-cancel'));
    fireEvent.press(screen.getByTestId('reservation-detail-cancel-confirm'));

    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('確認をやめると元に戻る', async () => {
    await render(<ReservationDetailScreen />);

    fireEvent.press(screen.getByTestId('reservation-detail-cancel'));
    fireEvent.press(screen.getByTestId('reservation-detail-cancel-dismiss'));

    expect(screen.queryByText('この予約をキャンセルしますか？')).toBeNull();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('取り消しに失敗したら理由を出す', async () => {
    stubCancel({ status: 'error', errorMessage: 'この予約はもうキャンセルできません' });

    await render(<ReservationDetailScreen />);

    expect(screen.getByText('この予約はもうキャンセルできません')).toBeTruthy();
  });

  it('取得に失敗したら再試行できる', async () => {
    const refetch = jest.fn();
    stubDetail({
      reservation: null,
      status: 'error',
      errorMessage: '予約が見つかりませんでした',
      refetch,
    });

    await render(<ReservationDetailScreen />);
    fireEvent.press(screen.getByText('再試行'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('取得中はスケルトンを出す', async () => {
    stubDetail({ reservation: null, status: 'loading' });

    await render(<ReservationDetailScreen />);

    expect(screen.getByTestId('reservation-detail-skeleton')).toBeTruthy();
  });
});
```

**「1 回押しただけでは取り消さない」を要求している理由。** キャンセルは元に戻せない（`cancelled` は終端）。誤タップで確定させない。`Alert.alert` を使わずに画面内の確認ブロックにしたのは、**`Alert` はテストでモックしないと押せず、モックすると「本当に確認が出るか」を検証できなくなる**ため。

**経路案内を「店舗ページを開く」1 枚挟みにした理由。** 設計書 5 章の画面一覧は、予約詳細に「キャンセル / 経路案内」を挙げている。しかし経路案内には緯度経度が要る一方、`ReservationResponse`（Task 7-10）は `shopId` と `shopName` しか返していない。**ここで座標を返すように変えると、`ReservationRow`・`RESERVATION_COLUMNS`・`toReservationRow`・`ReservationResponse`・`toReservationResponse`・店舗側の同型・「`userId` や `ownerMemo` は含めない」のキー集合テストまで一斉に変わる。** 予約の応答に店舗の位置情報を載せるのは責務としても重い（予約は「いつ・何人」の記録であって店舗マスタの写しではない）。そこで Phase 6 の Task 6-18 が作った `ShopInfoList` の「地図アプリで開く」（`mapsUrl(latitude, longitude)`）をそのまま使い、予約詳細からは店舗ページへ送る。**タップ 2 回で地図アプリに着く。** 予約詳細に直接「経路案内」を置くかどうかは Phase 10 の判断に回す（末尾の引き継ぎ表に記載）。

- [ ] **Step 8: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- "reservations/\[reservationId\]"
```

期待: `Cannot find module './[reservationId]'` で FAIL。

- [ ] **Step 9: 詳細画面を実装する**

```tsx
// apps/mobile/src/app/(user)/reservations/[reservationId].tsx
import { identifierSchema, toReservationId } from '@meshimap/core';
import type { ReservationId, ReservationStatus } from '@meshimap/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ReservationStatusBadge } from '@/components/reservation/reservation-status-badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPartySize, formatReservedAt } from '@/features/reservations/format';
import type { Reservation } from '@/features/reservations/schema';
import { useCancelReservation } from '@/features/reservations/use-cancel-reservation';
import { useMyReservation } from '@/features/reservations/use-reservations';
import { readSingleQueryValue } from '@/lib/query-params';

/**
 * 利用者がキャンセルできる状態。設計書の遷移表（pending→cancelled / confirmed→cancelled）と一対一。
 * `readonly ReservationStatus[]` に `satisfies` を当てて、綴り間違いをコンパイル時に止める。
 */
const CANCELLABLE_STATUSES = [
  'pending',
  'confirmed',
] as const satisfies readonly ReservationStatus[];

const INVALID_PARAMS_TITLE = '予約を特定できませんでした';
const NOTE_EMPTY_LABEL = 'なし';
const NOTE_HEADING = 'お店への要望';
const CANCEL_LABEL = '予約をキャンセルする';
const CANCEL_CONFIRM_QUESTION = 'この予約をキャンセルしますか？';
const CANCEL_CONFIRM_LABEL = 'キャンセルする';
const CANCEL_DISMISS_LABEL = 'やめる';
const SHOP_LINK_LABEL = '店舗ページを開く';
const SKELETON_HEIGHT_PX = 160;

export default function ReservationDetailScreen() {
  const params = useLocalSearchParams();
  const parsed = identifierSchema.safeParse(readSingleQueryValue(params.reservationId));

  if (!parsed.success) {
    return (
      <View
        className="flex-1 items-center justify-center p-6"
        testID="reservation-detail-invalid-params"
      >
        <Text className="text-base font-semibold text-neutral-900">{INVALID_PARAMS_TITLE}</Text>
      </View>
    );
  }

  return <ReservationDetail reservationId={toReservationId(parsed.data)} />;
}

type ReservationDetailProps = { reservationId: ReservationId };

function ReservationDetail({ reservationId }: ReservationDetailProps) {
  const detailResult = useMyReservation(reservationId);
  const cancelResult = useCancelReservation(reservationId);
  const [isConfirming, setIsConfirming] = useState(false);

  if (detailResult.status === 'loading') {
    return <Skeleton height={SKELETON_HEIGHT_PX} testID="reservation-detail-skeleton" />;
  }
  if (detailResult.status === 'error' || detailResult.reservation === null) {
    return (
      <ErrorState
        description={detailResult.errorMessage ?? undefined}
        onRetry={detailResult.refetch}
        testID="reservation-detail-error"
      />
    );
  }

  const reservation: Reservation = detailResult.reservation;
  const canCancel = CANCELLABLE_STATUSES.some((status) => status === reservation.status);

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="gap-5 p-4">
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-xl font-semibold text-neutral-900">
          {reservation.shopName}
        </Text>
        <ReservationStatusBadge status={reservation.status} testID="reservation-detail-status" />
      </View>

      <View className="gap-1">
        <Text className="text-base text-neutral-900">
          {formatReservedAt(reservation.reservedAt)}
        </Text>
        <Text className="text-base text-neutral-900">{formatPartySize(reservation.partySize)}</Text>
      </View>

      <View className="gap-1">
        <Text className="text-sm font-semibold text-neutral-700">{NOTE_HEADING}</Text>
        <Text className="text-sm text-neutral-900" testID="reservation-detail-note">
          {reservation.note === '' ? NOTE_EMPTY_LABEL : reservation.note}
        </Text>
      </View>

      <Button
        label={SHOP_LINK_LABEL}
        variant="outline"
        onPress={() => {
          router.push(`/shop/${reservation.shopId}`);
        }}
        testID="reservation-detail-shop-link"
      />

      {cancelResult.errorMessage === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {cancelResult.errorMessage}
        </Text>
      )}

      {canCancel ? (
        <View className="gap-3">
          {isConfirming ? (
            <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <Text className="text-sm text-red-900">{CANCEL_CONFIRM_QUESTION}</Text>
              <View className="flex-row gap-3">
                <Button
                  label={CANCEL_CONFIRM_LABEL}
                  variant="danger"
                  onPress={() => {
                    setIsConfirming(false);
                    cancelResult.cancel();
                  }}
                  isLoading={cancelResult.status === 'submitting'}
                  testID="reservation-detail-cancel-confirm"
                />
                <Button
                  label={CANCEL_DISMISS_LABEL}
                  variant="ghost"
                  onPress={() => {
                    setIsConfirming(false);
                  }}
                  testID="reservation-detail-cancel-dismiss"
                />
              </View>
            </View>
          ) : (
            <Button
              label={CANCEL_LABEL}
              variant="outline"
              onPress={() => {
                setIsConfirming(true);
              }}
              testID="reservation-detail-cancel"
            />
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}
```

**`CANCELLABLE_STATUSES.some(...)` を使い、`includes` を避けている。** `readonly ['pending', 'confirmed']` に対する `includes(reservation.status)` は、引数の型が `'pending' | 'confirmed'` に絞られてしまい `ReservationStatus` を渡せない（TypeScript の既知の挙動）。`as` で逃げずに `some` で書く。

- [ ] **Step 10: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- "reservations/\[reservationId\]"
npm run typecheck -w @meshimap/mobile
npm run lint -w @meshimap/mobile
```

期待: 14 本 PASS、型エラー 0、lint エラー 0。

- [ ] **Step 11: わざと壊してテストが落ちることを確認する**

(a) `CANCELLABLE_STATUSES` に `'cancelled'` を足す:

→ 「終端の状態ではキャンセルボタンを出さない」が FAIL。

(b) 確認ブロックを外して `onPress` から直接 `cancelResult.cancel()` を呼ぶ:

→ 「1 回押しただけでは取り消さない」が FAIL。

(c) `EMPTY_TITLES` の `past` を `upcoming` と同じ文言にする:

→ 「過去タブで 0 件のときは文言が変わる」が FAIL。

(d) `ReservationCard` の `accessibilityLabel` から状態を落とす:

→ 「読み上げ用のラベルに店名・日時・状態をまとめる」が FAIL。

(e) `useMyReservations(scope)` を `useMyReservations('upcoming')` に固定する:

→ 「タブを切り替えると過去の予約を取りに行く」が FAIL。**キーだけ切り替わって中身が切り替わらない不具合がここで止まる。**

(f) 詳細の `router.push` の引数を `` `/shop/${reservation.id}` `` に変える（`shopId` と `id` の取り違え）:

→ 「店舗ページへ移動できる」が FAIL。**予約 ID で店舗ページを開いて 404 になる不具合がここで止まる。** 両方 `xxx_0001` 形式なので、フィクスチャの `shopId` を `shp_0042` にずらしてあることがここで効く。

(g) 一覧の `keyExtractor` を `() => 'same'` に変える:

→ React の key 重複で警告が出るが**テストは落ちない**。テストの穴なので、「複数件を順番どおりに出す」に `expect(screen.getByTestId('reservation-item-rsv_0002')).toBeTruthy()` があることを確認し、加えて `keyExtractor` が ID を返すことを直接見るテストを 1 本足すか、`FlatList` の `data` を 2 件にしたまま `getAllByTestId` の件数を数えるテストへ強化する。

7 つとも確認したら元に戻す（(g) は足したテストを残す）。

- [ ] **Step 12: ミューテーションテストを回す**

```bash
npm run test:mutation -w @meshimap/mobile
```

想定される生き残り:

| 生き残りそうな変異                                    | 分類 | 潰し方                                                                                                                                                                     |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation.note === ''` → `reservation.note !== ''` | 1    | カード側は「空なら出さない」「あれば出す」の両方があるので死ぬ。詳細側にも「なしと出す」「要望があればそれを出す」の 2 本を揃える                                          |
| `SKELETON_COUNT` の `3` → `4`                         | 1    | `getAllByTestId` ではなく件数を数えるテストが要る。スケルトンの各行に `testID` を振り、`getAllByTestId('reservation-list-skeleton-row')` の長さを見る                      |
| `isConfirming` の初期値 `false` → `true`              | 1    | 「1 回押しただけでは取り消さない」で確認文が**押す前から**出ていても通ってしまう。押す前に `queryByText(CANCEL_CONFIRM_QUESTION)` が null であることを先に確認する行を足す |

- [ ] **Step 13: コミット**

```bash
git add apps/mobile/src/components/reservation/reservation-card.tsx apps/mobile/src/components/reservation/reservation-card.test.tsx "apps/mobile/src/app/(user)/reservations/"
git commit -m "feat(mobile): 利用者の予約一覧・詳細画面を追加"
```

---

## Task 7-17: 店舗側の予約画面と双方向フローの総点検

店舗側の 2 画面を作り、**利用者の申込 → 店舗の承認 → 利用者への反映**が本当に端から端まで繋がることを、本物の workerd 上で 1 本のテストで証明する。ここが Phase 7 の到達点「双方向のフローが動く」の判定基準になる。

**Files:**

- Create: `apps/mobile/src/app/(owner)/(tabs)/reservations.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/reservations.test.tsx`
- Create: `apps/mobile/src/app/(owner)/reservations/[reservationId].tsx`
- Create: `apps/mobile/src/app/(owner)/reservations/[reservationId].test.tsx`
- Create: `apps/api/src/routes/reservation-flow.integration.test.ts`

**Interfaces:**

- Consumes: Task 7-14 の `useOwnerReservations` / `useOwnerReservation` / `useUpdateReservationStatus` / `useUpdateReservationMemo` / 型 `OwnerReservation` / `OwnerReservationFilter`、Task 7-15 の `ReservationStatusBadge` / `formatPartySize` / `formatReservationDate` / `formatReservedAt` / `RESERVATION_STATUS_LABELS`、Task 7-2 の `nextReservationStatuses`、`@meshimap/core` の `ROLE_OWNER`、Task 7-7 の `buildWorkerScript`、`apps/api/src/db/testing/local-d1` の `readMigrationSql` / `toExecutableStatements`、`apps/api/src/auth/auth` の `AUTH_BASE_PATH`
- Produces: 店舗側の 2 画面（**default export**、expo-router の規約）と結合テスト。**他のモジュールから import されるものは無い**

---

- [ ] **Step 1: 店舗の予約一覧の失敗するテストを書く**

`apps/mobile/src/app/(owner)/(tabs)/reservations.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router } from 'expo-router';

import { useOwnerReservations } from '@/features/reservations/use-owner-reservations';
import { buildOwnerReservation } from '@/test-support/reservation-fixtures';

import OwnerReservationsScreen from './reservations';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/features/reservations/use-owner-reservations', () => ({
  useOwnerReservations: jest.fn(),
}));
jest.mock('@/hooks/use-now', () => ({
  // JST 2026-09-16 10:00
  useStableNow: () => new Date('2026-09-16T01:00:00.000Z'),
}));

const useOwnerReservationsMock = jest.mocked(useOwnerReservations);

function stubList(overrides: Partial<ReturnType<typeof useOwnerReservations>> = {}) {
  useOwnerReservationsMock.mockReturnValue({
    reservations: [buildOwnerReservation()],
    status: 'success',
    errorMessage: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

describe('OwnerReservationsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubList();
  });

  it('初期表示は今日の全件を取りに行く', async () => {
    await render(<OwnerReservationsScreen />);

    expect(useOwnerReservationsMock).toHaveBeenCalledWith({ date: '2026-09-16', status: null });
  });

  it('承認待ちだけに絞れる', async () => {
    await render(<OwnerReservationsScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-filter-pending'));

    expect(useOwnerReservationsMock).toHaveBeenLastCalledWith({
      date: '2026-09-16',
      status: 'pending',
    });
  });

  it('同じ絞り込みをもう一度押すと解除される', async () => {
    await render(<OwnerReservationsScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-filter-pending'));
    fireEvent.press(screen.getByTestId('owner-reservation-filter-pending'));

    expect(useOwnerReservationsMock).toHaveBeenLastCalledWith({
      date: '2026-09-16',
      status: null,
    });
  });

  it('日付を前後に動かせる', async () => {
    await render(<OwnerReservationsScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-next-day'));

    expect(useOwnerReservationsMock).toHaveBeenLastCalledWith({ date: '2026-09-17', status: null });

    fireEvent.press(screen.getByTestId('owner-reservation-previous-day'));
    fireEvent.press(screen.getByTestId('owner-reservation-previous-day'));

    expect(useOwnerReservationsMock).toHaveBeenLastCalledWith({ date: '2026-09-15', status: null });
  });

  it('予約者名と人数と時刻を出す', async () => {
    stubList({
      reservations: [buildOwnerReservation({ customerName: '田中太郎', partySize: 4 })],
    });

    await render(<OwnerReservationsScreen />);

    expect(screen.getByText('田中太郎')).toBeTruthy();
    expect(screen.getByText('4 名')).toBeTruthy();
    expect(screen.getByText('10/1（木）18:00')).toBeTruthy();
  });

  it('承認待ちの件数を見出しに出す', async () => {
    stubList({
      reservations: [
        buildOwnerReservation({ id: 'rsv_0001', status: 'pending' }),
        buildOwnerReservation({ id: 'rsv_0002', status: 'pending' }),
        buildOwnerReservation({ id: 'rsv_0003', status: 'confirmed' }),
      ],
    });

    await render(<OwnerReservationsScreen />);

    expect(screen.getByTestId('owner-reservation-pending-count')).toHaveTextContent(
      '承認待ち 2 件',
    );
  });

  it('承認待ちが 0 件なら件数を出さない', async () => {
    stubList({ reservations: [buildOwnerReservation({ status: 'confirmed' })] });

    await render(<OwnerReservationsScreen />);

    expect(screen.queryByTestId('owner-reservation-pending-count')).toBeNull();
  });

  it('行を押すと店舗側の詳細へ進む', async () => {
    await render(<OwnerReservationsScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-item-rsv_0001'));

    expect(router.push).toHaveBeenCalledWith('/reservations/rsv_0001');
  });

  it('0 件なら空状態を出す', async () => {
    stubList({ reservations: [] });

    await render(<OwnerReservationsScreen />);

    expect(screen.getByText('この日の予約はありません')).toBeTruthy();
  });

  it('失敗したら再試行できる', async () => {
    const refetch = jest.fn();
    stubList({ reservations: [], status: 'error', errorMessage: '通信に失敗しました', refetch });

    await render(<OwnerReservationsScreen />);
    fireEvent.press(screen.getByText('再試行'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
```

**「承認待ちの件数」を見出しに出すのは、店主が最初に知りたいのが「いま何件さばく必要があるか」だから。** 一覧を全部読ませないと分からない画面は、忙しい時間帯に使われない。

- [ ] **Step 2: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- "owner/(tabs)/reservations"
```

期待: `Cannot find module './reservations'` で FAIL。

- [ ] **Step 3: 店舗の予約一覧を実装する**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/reservations.tsx
import { RESERVATION_STATUSES, addJstDays, toJstClock } from '@meshimap/core';
import type { JstDate, ReservationId, ReservationStatus } from '@meshimap/core';
import { router } from 'expo-router';
import { CalendarCheck } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import { ReservationStatusBadge } from '@/components/reservation/reservation-status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatPartySize,
  formatReservationDate,
  formatReservedAt,
} from '@/features/reservations/format';
import type { OwnerReservation } from '@/features/reservations/schema';
import { RESERVATION_STATUS_LABELS } from '@/features/reservations/status-label';
import { useOwnerReservations } from '@/features/reservations/use-owner-reservations';
import { useStableNow } from '@/hooks/use-now';

/** 絞り込みに出す状態。6 つ全部を並べると押しにくいので、店主がよく使う 3 つに絞る */
const FILTERABLE_STATUSES = [
  'pending',
  'confirmed',
  'no_show',
] as const satisfies readonly ReservationStatus[];

const EMPTY_TITLE = 'この日の予約はありません';
const EMPTY_DESCRIPTION = '日付を切り替えて確認できます';
const PENDING_COUNT_PREFIX = '承認待ち ';
const PENDING_COUNT_SUFFIX = ' 件';
const PREVIOUS_DAY_LABEL = '前日';
const NEXT_DAY_LABEL = '翌日';
const SKELETON_HEIGHT_PX = 88;
const SKELETON_COUNT = 3;
const PENDING_STATUS: ReservationStatus = 'pending';

export default function OwnerReservationsScreen() {
  const now = useStableNow();
  const [date, setDate] = useState<JstDate>(toJstClock(now).date);
  const [status, setStatus] = useState<ReservationStatus | null>(null);
  const listResult = useOwnerReservations({ date, status });

  const pendingCount = listResult.reservations.filter(
    (reservation) => reservation.status === PENDING_STATUS,
  ).length;

  /** 同じボタンをもう一度押したら解除する。「全部」のボタンを別に置かずに済む */
  function toggleStatus(next: ReservationStatus): void {
    setStatus((current) => (current === next ? null : next));
  }

  return (
    <View className="flex-1 bg-neutral-50">
      <View className="gap-3 p-4">
        <View className="flex-row items-center justify-between">
          <Button
            label={PREVIOUS_DAY_LABEL}
            variant="ghost"
            size="sm"
            onPress={() => {
              setDate((current) => addJstDays(current, -1));
            }}
            testID="owner-reservation-previous-day"
          />
          <Text
            className="text-base font-semibold text-neutral-900"
            testID="owner-reservation-date"
          >
            {formatReservationDate(date)}
          </Text>
          <Button
            label={NEXT_DAY_LABEL}
            variant="ghost"
            size="sm"
            onPress={() => {
              setDate((current) => addJstDays(current, 1));
            }}
            testID="owner-reservation-next-day"
          />
        </View>

        {pendingCount === 0 ? null : (
          <Text
            className="text-sm font-semibold text-amber-700"
            testID="owner-reservation-pending-count"
          >
            {`${PENDING_COUNT_PREFIX}${pendingCount}${PENDING_COUNT_SUFFIX}`}
          </Text>
        )}

        <View className="flex-row gap-2">
          {FILTERABLE_STATUSES.map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: value === status }}
              onPress={() => {
                toggleStatus(value);
              }}
              className={
                value === status
                  ? 'bg-brand-600 rounded-full px-3 py-1'
                  : 'rounded-full bg-neutral-200 px-3 py-1'
              }
              testID={`owner-reservation-filter-${value}`}
            >
              <Text className={value === status ? 'text-white' : 'text-neutral-700'}>
                {RESERVATION_STATUS_LABELS[value]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <OwnerReservationListBody listResult={listResult} />
    </View>
  );
}

type OwnerReservationListBodyProps = {
  listResult: ReturnType<typeof useOwnerReservations>;
};

function OwnerReservationListBody({ listResult }: OwnerReservationListBodyProps) {
  if (listResult.status === 'loading') {
    return (
      <View className="gap-3 px-4">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          <Skeleton
            key={index}
            height={SKELETON_HEIGHT_PX}
            testID={`owner-reservation-skeleton-row-${index}`}
          />
        ))}
      </View>
    );
  }
  if (listResult.status === 'error') {
    return (
      <ErrorState
        description={listResult.errorMessage ?? undefined}
        onRetry={listResult.refetch}
        testID="owner-reservation-list-error"
      />
    );
  }
  if (listResult.reservations.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title={EMPTY_TITLE}
        description={EMPTY_DESCRIPTION}
        testID="owner-reservation-list-empty"
      />
    );
  }

  return (
    <FlatList
      data={listResult.reservations}
      keyExtractor={(item: OwnerReservation) => item.id}
      contentContainerClassName="gap-3 px-4 pb-6"
      renderItem={({ item }: { item: OwnerReservation }) => (
        <OwnerReservationRow reservation={item} />
      )}
      testID="owner-reservation-list"
    />
  );
}

type OwnerReservationRowProps = { reservation: OwnerReservation };

function OwnerReservationRow({ reservation }: OwnerReservationRowProps) {
  function openDetail(reservationId: ReservationId): void {
    router.push(`/reservations/${reservationId}`);
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        openDetail(reservation.id);
      }}
      className="gap-2 rounded-xl border border-neutral-200 bg-white p-4"
      testID={`owner-reservation-item-${reservation.id}`}
    >
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-base font-semibold text-neutral-900">
          {reservation.customerName}
        </Text>
        <ReservationStatusBadge status={reservation.status} />
      </View>
      <View className="flex-row gap-3">
        <Text className="text-sm text-neutral-700">{formatReservedAt(reservation.reservedAt)}</Text>
        <Text className="text-sm text-neutral-700">{formatPartySize(reservation.partySize)}</Text>
      </View>
    </Pressable>
  );
}
```

**`RESERVATION_STATUSES` を import していない。** `FILTERABLE_STATUSES` はその部分集合を手で選んでいるので、`as const satisfies readonly ReservationStatus[]` だけで十分に型で守られる。未使用 import は規約違反なので、**この段落を読んだら import 行を確認して余分があれば消すこと。**

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- "owner/(tabs)/reservations"
```

期待: 10 本 PASS。

- [ ] **Step 5: 店舗の予約詳細の失敗するテストを書く**

`apps/mobile/src/app/(owner)/reservations/[reservationId].test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useLocalSearchParams } from 'expo-router';

import { useOwnerReservation } from '@/features/reservations/use-owner-reservations';
import {
  useUpdateReservationMemo,
  useUpdateReservationStatus,
} from '@/features/reservations/use-update-reservation-status';
import { buildOwnerReservation } from '@/test-support/reservation-fixtures';

import OwnerReservationDetailScreen from './[reservationId]';

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useLocalSearchParams: jest.fn() }));
jest.mock('@/features/reservations/use-owner-reservations', () => ({
  useOwnerReservation: jest.fn(),
}));
jest.mock('@/features/reservations/use-update-reservation-status', () => ({
  useUpdateReservationStatus: jest.fn(),
  useUpdateReservationMemo: jest.fn(),
}));

const useLocalSearchParamsMock = jest.mocked(useLocalSearchParams);
const useOwnerReservationMock = jest.mocked(useOwnerReservation);
const useUpdateReservationStatusMock = jest.mocked(useUpdateReservationStatus);
const useUpdateReservationMemoMock = jest.mocked(useUpdateReservationMemo);
const changeStatusMock = jest.fn();
const saveMemoMock = jest.fn();

function stubDetail(overrides: Partial<ReturnType<typeof useOwnerReservation>> = {}) {
  useOwnerReservationMock.mockReturnValue({
    reservation: buildOwnerReservation(),
    status: 'success',
    errorMessage: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

function stubStatusMutation(
  overrides: Partial<ReturnType<typeof useUpdateReservationStatus>> = {},
) {
  useUpdateReservationStatusMock.mockReturnValue({
    status: 'idle',
    errorMessage: null,
    changeStatus: changeStatusMock,
    reset: jest.fn(),
    ...overrides,
  });
}

describe('OwnerReservationDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLocalSearchParamsMock.mockReturnValue({ reservationId: 'rsv_0001' });
    stubDetail();
    stubStatusMutation();
    useUpdateReservationMemoMock.mockReturnValue({
      status: 'idle',
      errorMessage: null,
      saveMemo: saveMemoMock,
      reset: jest.fn(),
    });
  });

  it('予約 ID が不正ならエラー表示にして取りに行かない', async () => {
    useLocalSearchParamsMock.mockReturnValue({ reservationId: undefined });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByTestId('owner-reservation-detail-invalid-params')).toBeTruthy();
    expect(useOwnerReservationMock).not.toHaveBeenCalled();
  });

  it('予約者名と要望を出す', async () => {
    stubDetail({
      reservation: buildOwnerReservation({ customerName: '田中太郎', note: '窓際希望' }),
    });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByText('田中太郎')).toBeTruthy();
    expect(screen.getByText('窓際希望')).toBeTruthy();
  });

  it('承認待ちには承認とお断りだけを出す', async () => {
    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByTestId('owner-reservation-action-confirmed')).toBeTruthy();
    expect(screen.getByTestId('owner-reservation-action-rejected')).toBeTruthy();
    expect(screen.queryByTestId('owner-reservation-action-completed')).toBeNull();
    expect(screen.queryByTestId('owner-reservation-action-no_show')).toBeNull();
  });

  it('確定済みには来店済みと無断キャンセルだけを出す', async () => {
    stubDetail({ reservation: buildOwnerReservation({ status: 'confirmed' }) });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByTestId('owner-reservation-action-completed')).toBeTruthy();
    expect(screen.getByTestId('owner-reservation-action-no_show')).toBeTruthy();
    expect(screen.queryByTestId('owner-reservation-action-confirmed')).toBeNull();
    expect(screen.queryByTestId('owner-reservation-action-rejected')).toBeNull();
  });

  it('終端の状態では操作ボタンを 1 つも出さない', async () => {
    for (const status of ['rejected', 'cancelled', 'completed', 'no_show']) {
      stubDetail({ reservation: buildOwnerReservation({ status }) });

      const view = await render(<OwnerReservationDetailScreen />);

      expect(screen.queryByTestId('owner-reservation-actions')).toBeNull();
      view.unmount();
    }
  });

  it('承認を押すと confirmed を送る', async () => {
    await render(<OwnerReservationDetailScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-action-confirmed'));

    expect(changeStatusMock).toHaveBeenCalledWith('confirmed');
  });

  it('お断りを押すと rejected を送る', async () => {
    await render(<OwnerReservationDetailScreen />);

    fireEvent.press(screen.getByTestId('owner-reservation-action-rejected'));

    expect(changeStatusMock).toHaveBeenCalledWith('rejected');
  });

  it('送信中は操作ボタンを押せなくする', async () => {
    stubStatusMutation({ status: 'submitting' });

    await render(<OwnerReservationDetailScreen />);

    expect(
      screen.getByTestId('owner-reservation-action-confirmed').props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('操作に失敗したら理由を出す', async () => {
    stubStatusMutation({
      status: 'error',
      errorMessage: 'いまの状態からその操作はできません',
    });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByText('いまの状態からその操作はできません')).toBeTruthy();
  });

  it('店舗メモの初期値はサーバの値', async () => {
    stubDetail({ reservation: buildOwnerReservation({ ownerMemo: '常連さん' }) });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByTestId('owner-reservation-memo').props.value).toBe('常連さん');
  });

  it('メモを書き換えて保存すると送られる', async () => {
    await render(<OwnerReservationDetailScreen />);

    fireEvent.changeText(screen.getByTestId('owner-reservation-memo'), '窓際を用意する');
    fireEvent.press(screen.getByTestId('owner-reservation-memo-save'));

    expect(saveMemoMock).toHaveBeenCalledWith('窓際を用意する');
  });

  it('メモを変えていなければ保存ボタンを押せない', async () => {
    await render(<OwnerReservationDetailScreen />);

    expect(
      screen.getByTestId('owner-reservation-memo-save').props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('終端の状態でもメモは書ける', async () => {
    stubDetail({ reservation: buildOwnerReservation({ status: 'completed' }) });

    await render(<OwnerReservationDetailScreen />);

    expect(screen.getByTestId('owner-reservation-memo')).toBeTruthy();
  });
});
```

**「終端の状態でもメモは書ける」を明示している理由。** 状態遷移とメモは別の権限・別の API（`/status` と `/memo`）である。来店済みの予約に「次回はカウンターを勧める」と書けなくなると、メモの用途が半分死ぬ。**遷移表がメモを巻き込まないことを、画面のテストで固定しておく。**

- [ ] **Step 6: テストを走らせて落ちることを確認する**

```bash
npm test -w @meshimap/mobile -- "owner/reservations"
```

期待: `Cannot find module './[reservationId]'` で FAIL。

- [ ] **Step 7: 店舗の予約詳細を実装する**

```tsx
// apps/mobile/src/app/(owner)/reservations/[reservationId].tsx
import {
  ROLE_OWNER,
  identifierSchema,
  nextReservationStatuses,
  toReservationId,
} from '@meshimap/core';
import type { ReservationId, ReservationStatus } from '@meshimap/core';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ReservationStatusBadge } from '@/components/reservation/reservation-status-badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPartySize, formatReservedAt } from '@/features/reservations/format';
import { RESERVATION_OWNER_MEMO_MAX_LENGTH } from '@/features/reservations/schema';
import type { OwnerReservation } from '@/features/reservations/schema';
import { useOwnerReservation } from '@/features/reservations/use-owner-reservations';
import {
  useUpdateReservationMemo,
  useUpdateReservationStatus,
} from '@/features/reservations/use-update-reservation-status';
import { readSingleQueryValue } from '@/lib/query-params';

const ACTION_LABELS: Record<ReservationStatus, string> = {
  pending: '承認待ちに戻す',
  confirmed: '承認する',
  rejected: 'お断りする',
  cancelled: 'キャンセルする',
  completed: '来店済みにする',
  no_show: '無断キャンセルにする',
};

const INVALID_PARAMS_TITLE = '予約を特定できませんでした';
const NOTE_HEADING = 'お客様からの要望';
const NOTE_EMPTY_LABEL = 'なし';
const MEMO_LABEL = '店舗メモ（お客様には見えません）';
const MEMO_PLACEHOLDER = '席の準備、アレルギー対応など';
const MEMO_SAVE_LABEL = 'メモを保存';
/** 承認だけを目立たせる。マジックストリングを JSX に直書きしない */
const RESERVATION_STATUS_CONFIRMED_VALUE: ReservationStatus = 'confirmed';
const SKELETON_HEIGHT_PX = 200;

export default function OwnerReservationDetailScreen() {
  const params = useLocalSearchParams();
  const parsed = identifierSchema.safeParse(readSingleQueryValue(params.reservationId));

  if (!parsed.success) {
    return (
      <View
        className="flex-1 items-center justify-center p-6"
        testID="owner-reservation-detail-invalid-params"
      >
        <Text className="text-base font-semibold text-neutral-900">{INVALID_PARAMS_TITLE}</Text>
      </View>
    );
  }

  return <OwnerReservationDetail reservationId={toReservationId(parsed.data)} />;
}

type OwnerReservationDetailProps = { reservationId: ReservationId };

function OwnerReservationDetail({ reservationId }: OwnerReservationDetailProps) {
  const detailResult = useOwnerReservation(reservationId);
  const statusMutation = useUpdateReservationStatus(reservationId);
  const memoMutation = useUpdateReservationMemo(reservationId);
  const [memoDraft, setMemoDraft] = useState<string | null>(null);

  if (detailResult.status === 'loading') {
    return <Skeleton height={SKELETON_HEIGHT_PX} testID="owner-reservation-detail-skeleton" />;
  }
  if (detailResult.status === 'error' || detailResult.reservation === null) {
    return (
      <ErrorState
        description={detailResult.errorMessage ?? undefined}
        onRetry={detailResult.refetch}
        testID="owner-reservation-detail-error"
      />
    );
  }

  const reservation: OwnerReservation = detailResult.reservation;
  // 編集を始めるまではサーバの値をそのまま出す。下書きを持つのは「変更したか」を判定するため
  const memoValue = memoDraft ?? reservation.ownerMemo;
  const isMemoDirty = memoDraft !== null && memoDraft !== reservation.ownerMemo;

  /**
   * 押せる操作は **Task 7-2 の遷移表から引く**。画面に if を書くと表と二重管理になる。
   * nextReservationStatuses は by が owner の遷移だけを残すので、
   * 利用者専用の cancelled はここに出ない。
   */
  const availableActions = nextReservationStatuses(reservation.status, ROLE_OWNER);
  const isSubmitting = statusMutation.status === 'submitting';

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="gap-5 p-4">
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-xl font-semibold text-neutral-900">
          {reservation.customerName}
        </Text>
        <ReservationStatusBadge
          status={reservation.status}
          testID="owner-reservation-detail-status"
        />
      </View>

      <View className="gap-1">
        <Text className="text-base text-neutral-900">
          {formatReservedAt(reservation.reservedAt)}
        </Text>
        <Text className="text-base text-neutral-900">{formatPartySize(reservation.partySize)}</Text>
      </View>

      <View className="gap-1">
        <Text className="text-sm font-semibold text-neutral-700">{NOTE_HEADING}</Text>
        <Text className="text-sm text-neutral-900" testID="owner-reservation-detail-note">
          {reservation.note === '' ? NOTE_EMPTY_LABEL : reservation.note}
        </Text>
      </View>

      {statusMutation.errorMessage === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {statusMutation.errorMessage}
        </Text>
      )}

      {availableActions.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-3" testID="owner-reservation-actions">
          {availableActions.map((next) => (
            <Button
              key={next}
              label={ACTION_LABELS[next]}
              variant={next === RESERVATION_STATUS_CONFIRMED_VALUE ? 'primary' : 'outline'}
              onPress={() => {
                statusMutation.changeStatus(next);
              }}
              isDisabled={isSubmitting}
              isLoading={isSubmitting}
              testID={`owner-reservation-action-${next}`}
            />
          ))}
        </View>
      )}

      <View className="gap-2">
        <Input
          label={MEMO_LABEL}
          value={memoValue}
          onChangeText={setMemoDraft}
          placeholder={MEMO_PLACEHOLDER}
          isMultiline
          maxLength={RESERVATION_OWNER_MEMO_MAX_LENGTH}
          errorMessage={memoMutation.errorMessage ?? undefined}
          testID="owner-reservation-memo"
        />
        <Button
          label={MEMO_SAVE_LABEL}
          variant="secondary"
          onPress={() => {
            memoMutation.saveMemo(memoValue);
            setMemoDraft(null);
          }}
          isDisabled={!isMemoDirty}
          isLoading={memoMutation.status === 'submitting'}
          testID="owner-reservation-memo-save"
        />
      </View>
    </ScrollView>
  );
}
```

**`nextReservationStatuses` で押せるボタンを引いているのがこの画面の肝。** Task 7-2 の遷移表、Task 7-12 の `WHERE status IN (...)`、Task 7-3 のトリガー、そしてこの画面が**同じ 1 つの表**を見る。表に行を足せばボタンが増え、消せばボタンが消える。画面に `if (status === 'pending')` を書いた瞬間にこの性質が壊れるので、**書かない**。

`RESERVATION_OWNER_MEMO_MAX_LENGTH` は Task 7-3 で `apps/api/src/db/constants.ts` に足したもの。**モバイルは api パッケージを import できない**ので、`features/reservations/schema.ts` に同じ値を置いて re-export する。Step 8 で schema.ts に次を足す:

```ts
/**
 * 店舗メモの上限。apps/api の RESERVATION_OWNER_MEMO_MAX_LENGTH と同じ値。
 * モバイルから apps/api は import できないため、値を二重に持つしかない。
 * ずれを検出するため、Task 7-3 の check-constraints.test.ts が DB 側の CHECK を、
 * この定数を使う画面テストが端末側を、それぞれ固定している。
 * **片方を変えたら必ず両方変える。**
 */
export const RESERVATION_OWNER_MEMO_MAX_LENGTH = 1000;
```

**実装前に `apps/api/src/db/constants.ts` を開いて実際の値を確認し、上の `1000` をその値に直すこと。** Task 7-3 で決める値であり、この時点では**未確認**である。

- [ ] **Step 8: テストが通ることを確認する**

```bash
npm test -w @meshimap/mobile -- "owner/reservations"
npm run typecheck -w @meshimap/mobile
npm run lint -w @meshimap/mobile
```

期待: 13 本 PASS、型エラー 0、lint エラー 0。

- [ ] **Step 9: 双方向フローの結合テストを書く（失敗する状態で）**

`apps/api/src/routes/reservation-flow.integration.test.ts`:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_BASE_PATH } from '../auth/auth';
import { readMigrationSql, toExecutableStatements } from '../db/testing/local-d1';
import { buildWorkerScript } from '../test/build-worker';

const COMPATIBILITY_DATE = '2026-09-01';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];
const BASE_URL = 'http://localhost:8787';
const SHOP_ID = 'shp_flow_0001';
const TARGET_DATE = '2026-10-01';
const START_MINUTE = 1080;
const PARTY_SIZE = 2;
const CAPACITY = 8;
const MAX_PARALLEL = 4;
const SLOT_MINUTES = 60;
const OK = 200;
const CREATED = 201;
const INVALID_INPUT = 422;
const PASSWORD = 'password1234';

/** 本物のルータをそのまま起こす。DO もルートも本番と同じ経路を通す */
const WORKER_SOURCE = `
export { ReservationLock } from './durable-objects/reservation-lock';
export { default } from './index';
`;

let miniflare: Miniflare;

beforeAll(async () => {
  const script = await buildWorkerScript({
    contents: WORKER_SOURCE,
    resolveDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
  });
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: COMPATIBILITY_FLAGS,
      d1Databases: { DB: ':memory:' },
      durableObjects: { RESERVATION_LOCK: 'ReservationLock' },
      r2Buckets: ['MEDIA'],
      kvNamespaces: ['CACHE'],
      bindings: {
        BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
        BETTER_AUTH_URL: BASE_URL,
        MOBILE_APP_SCHEME: 'meshimap',
      },
    }),
  );
  const d1 = await miniflare.getD1Database('DB');
  await d1.exec(toExecutableStatements(readMigrationSql()).join('\n'));
  await d1.exec(
    toExecutableStatements(`INSERT INTO areas (id, name, prefecture) VALUES ('area_flow', 'テスト', '東京都');
--> statement-breakpoint
INSERT INTO genres (id, name, slug) VALUES ('gnr_flow', 'テスト', 'genre-flow');`).join('\n'),
  );
}, 60_000);

afterAll(async () => {
  await miniflare.dispose();
});

type SignedUpUser = { readonly userId: string; readonly cookie: string };

/** Better Auth のサインアップを本物の HTTP 経路で通し、Cookie を取り出す */
async function signUp(email: string): Promise<SignedUpUser> {
  const response = await miniflare.dispatchFetch(`${BASE_URL}${AUTH_BASE_PATH}/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  expect(response.status).toBe(OK);
  const body = (await response.json()) as { user: { id: string } };
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  return { userId: body.user.id, cookie };
}

async function setRole(userId: string, role: string): Promise<void> {
  const d1 = await miniflare.getD1Database('DB');
  await d1.prepare('UPDATE profiles SET role = ? WHERE user_id = ?').bind(role, userId).run();
}

function request(path: string, cookie: string, init: RequestInit = {}) {
  return miniflare.dispatchFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, 'content-type': 'application/json' },
  });
}

describe('予約の双方向フロー', () => {
  it('申込 → 店舗が承認 → 利用者に確定として見える', async () => {
    const customer = await signUp('flow-customer@example.test');
    const owner = await signUp('flow-owner@example.test');
    await setRole(owner.userId, 'owner');

    const d1 = await miniflare.getD1Database('DB');
    await d1
      .prepare(
        "INSERT INTO shops (id, name, genre_id, area_id, address, lat, lng, geohash, owner_id, status) VALUES (?, '双方向テスト店', 'gnr_flow', 'area_flow', '東京都渋谷区', 35.658034, 139.701636, 'xn76fgr', ?, 'published')",
      )
      .bind(SHOP_ID, owner.userId)
      .run();
    await d1
      .prepare(
        'INSERT INTO seat_settings (shop_id, capacity, slot_minutes, max_parallel, accepts_reservation) VALUES (?, ?, ?, ?, 1)',
      )
      .bind(SHOP_ID, CAPACITY, SLOT_MINUTES, MAX_PARALLEL)
      .run();
    await d1
      .prepare(
        'INSERT INTO business_hours (shop_id, day_of_week, open_minute, close_minute) VALUES (?, 4, 660, 1320)',
      )
      .bind(SHOP_ID)
      .run();

    // 1. 利用者が枠を見る
    const slotsResponse = await request(
      `/reservation-slots?shopId=${SHOP_ID}&date=${TARGET_DATE}&partySize=${PARTY_SIZE}`,
      customer.cookie,
    );
    expect(slotsResponse.status).toBe(OK);
    const slots = (await slotsResponse.json()) as {
      acceptsReservation: boolean;
      slots: { startMinute: number; isAvailable: boolean }[];
    };
    expect(slots.acceptsReservation).toBe(true);
    expect(slots.slots.find((slot) => slot.startMinute === START_MINUTE)?.isAvailable).toBe(true);

    // 2. 利用者が申し込む（DO を通る唯一の経路）
    const createResponse = await request('/reservations', customer.cookie, {
      method: 'POST',
      body: JSON.stringify({
        shopId: SHOP_ID,
        date: TARGET_DATE,
        startMinute: START_MINUTE,
        partySize: PARTY_SIZE,
        note: '窓際希望',
      }),
    });
    expect(createResponse.status).toBe(CREATED);
    const created = (await createResponse.json()) as { reservationId: string };

    // 3. 店舗の一覧に承認待ちとして現れる
    const ownerListResponse = await request(
      `/owner/reservations?date=${TARGET_DATE}&status=pending`,
      owner.cookie,
    );
    expect(ownerListResponse.status).toBe(OK);
    const ownerList = (await ownerListResponse.json()) as {
      reservations: { id: string; note: string; ownerMemo: string }[];
    };
    expect(ownerList.reservations.map((row) => row.id)).toEqual([created.reservationId]);
    expect(ownerList.reservations[0]?.note).toBe('窓際希望');

    // 4. 店舗が承認する
    const approveResponse = await request(
      `/owner/reservations/${created.reservationId}/status`,
      owner.cookie,
      { method: 'POST', body: JSON.stringify({ status: 'confirmed' }) },
    );
    expect(approveResponse.status).toBe(OK);

    // 5. 利用者の詳細が confirmed になっている
    const detailResponse = await request(`/reservations/${created.reservationId}`, customer.cookie);
    expect(detailResponse.status).toBe(OK);
    const detail = (await detailResponse.json()) as { status: string; ownerMemo?: string };
    expect(detail.status).toBe('confirmed');
    // 店舗メモは利用者に漏れない
    expect(detail.ownerMemo).toBeUndefined();

    // 6. 利用者に通知が 1 件届いている
    const notificationCount = await d1
      .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?')
      .bind(customer.userId)
      .first<{ count: number }>();
    expect(notificationCount?.count).toBe(1);

    // 7. 確定済みからでも利用者はキャンセルできる
    const cancelResponse = await request(
      `/reservations/${created.reservationId}/cancel`,
      customer.cookie,
      { method: 'POST' },
    );
    expect(cancelResponse.status).toBe(OK);
    expect(((await cancelResponse.json()) as { status: string }).status).toBe('cancelled');

    // 8. 取り消し済みを店舗が承認しようとしても 422
    const reApproveResponse = await request(
      `/owner/reservations/${created.reservationId}/status`,
      owner.cookie,
      { method: 'POST', body: JSON.stringify({ status: 'confirmed' }) },
    );
    expect(reApproveResponse.status).toBe(INVALID_INPUT);
  }, 60_000);
});
```

**このテストが Phase 7 の合格判定である。** 8 段で「行き」と「帰り」の両方を通し、途中で **(a) 店舗メモが利用者に漏れないこと**、**(b) 終端状態への遷移が 422 で止まること**、**(c) 通知が 1 件だけ作られること**を確かめている。ユニットテストはそれぞれの層を個別に見ているが、**層の継ぎ目（DO → D1 → トリガー → レスポンス整形）がずれていないことは、この経路でしか分からない。**

- [ ] **Step 10: 結合テストを走らせる**

```bash
npx vitest run --root apps/api src/routes/reservation-flow.integration.test.ts
```

Task 7-1 〜 7-13 が終わっていれば PASS する。**落ちた場合、どの段で落ちたかがそのまま原因の層を指す。**

| 落ちた段 | 疑う場所                                           |
| -------- | -------------------------------------------------- |
| 1        | Task 7-4 / 7-5（枠計算とルート）                   |
| 2        | Task 7-6 / 7-8 / 7-9（DO とサービスとルート）      |
| 3        | Task 7-12（店舗側の一覧の `WHERE` 句）             |
| 4        | Task 7-2 / 7-3 / 7-12（遷移表・トリガー・更新）    |
| 5        | Task 7-10 / 7-11（利用者側の詳細とレスポンス整形） |
| 6        | Task 7-12（通知の作成）                            |
| 7        | Task 7-10（キャンセルの `WHERE status IN (...)`）  |
| 8        | Task 7-12（遷移不能を 422 に寄せる分岐）           |

- [ ] **Step 11: わざと壊してテストが落ちることを確認する**

(a) `toOwnerReservationResponse` を利用者側の詳細でも使うようにする（Task 7-11）:

→ 「店舗メモは利用者に漏れない」が FAIL。**情報漏れがこの 1 行で止まる。**

(b) Task 7-12 の状態更新から `WHERE status IN (...)` を外す:

→ 段 8 が FAIL（トリガーが `D1_ERROR` を投げて 500 になる）。**型でも SQL でもなくトリガーで止まった、という形で「3 段の壁」の最後の 1 枚が見える。**

(c) Task 7-12 の通知作成を消す:

→ 段 6 が FAIL。

(d) 店舗の一覧の `WHERE shops.owner_id = ?` を外す:

→ 段 3 は通ってしまう（この店の所有者は owner なので）。**テストの穴。** 2 人目の店主とその店の予約を seed し、`ownerList.reservations` にそれが混ざらないことを確かめる段を足してから、もう一度壊して FAIL を確認する。

(e) `ReservationLock` の `blockConcurrencyWhile` を外す:

→ この結合テストは**落ちない**（同時実行していないため）。同時実行の正しさは Task 7-7 の責任であることを確認する。**「結合テストが通ったから DO は正しい」と考えてはいけない。**

(f) 店舗側の詳細画面の `availableActions` を `nextReservationStatuses` ではなくハードコードした配列に変える:

→ モバイル側の「確定済みには来店済みと無断キャンセルだけを出す」は通ってしまうが、Task 7-2 の遷移表に行を足したとき画面だけが古くなる。**これはテストで検出できない設計の劣化**なので、コードレビューで止める。計画書としてはここに書いておくことが対策である。

(a)(b)(c)(d) の 4 つを確認し、(d) は足した段を残す。

- [ ] **Step 12: Phase 7 全体の品質ゲートを通す**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm run typecheck
npm run lint
npm run format:check
npm test -w @meshimap/core
npm test -w @meshimap/api
npm test -w @meshimap/mobile
npm run test:mutation -w @meshimap/core
npm run test:mutation -w @meshimap/api
npm run test:mutation -w @meshimap/mobile
```

**すべて通るまで次へ進まない。** ミューテーションのしきい値は `break: 85` だが、Phase 7 で追加したファイルは**実質 100% を目標**にする。生き残りへの対応は 3 つだけ（テストの穴 → テストを足す / 出力を変えない最適化 → 呼び出し回数で縛る / 到達不能 → 書き直してから殺す）で、**除外設定は足さない。**

`*.concurrency.test.ts` と `*.integration.test.ts` は miniflare の起動を伴うため、Stryker の `timeoutMS` が既定のままだと全変異が Timeout 判定になる可能性がある。**まず素の所要時間を測る:**

```bash
npx vitest run --root apps/api --no-file-parallelism src/durable-objects/reservation-lock.concurrency.test.ts src/routes/reservation-flow.integration.test.ts
```

出た秒数を見てから `apps/api/stryker.config.mjs` の `timeoutMS` を決める。**現時点では未測定なので、この計画書に具体的な秒数は書かない。** 測った値と、なぜその値にしたかを同ファイルのコメントに残すこと。

- [ ] **Step 13: 設計書との突き合わせ**

```bash
npx vitest run --root apps/api src/db/schema/design-doc-sync.test.ts
```

期待: PASS。**このテストが比較しているのは設計書 §6 の「テーブル名の集合」だけ**（実ファイル `apps/api/src/db/schema/design-doc-sync.test.ts` を開いて確認した。`readDesignDocTableNames()` と `collectExportedTableNames()` の `toEqual` 1 本）。Phase 7 は新しいテーブルを 1 つも足さず、`reservations` に `owner_memo` 列を足すだけなので、**このテストには影響しない。** 落ちたなら、それは意図しないテーブルを増やしたということ。落ちた場合、**設計書（`docs/superpowers/specs/2026-09-15-meshimap-design.md`）ではなくコードを直す。** 設計書はこの計画の入力であり、実装に合わせて書き換えると「計画と実装が食い違っていた」という事実が消える。

- [ ] **Step 14: コミット**

```bash
git add "apps/mobile/src/app/(owner)/reservations/" "apps/mobile/src/app/(owner)/(tabs)/reservations.tsx" "apps/mobile/src/app/(owner)/(tabs)/reservations.test.tsx" apps/api/src/routes/reservation-flow.integration.test.ts
git commit -m "feat: 店舗側の予約画面と双方向フローの結合テストを追加"
```

---

## Phase 7 完了チェックリスト

**ドメイン（packages/core）**

- [ ] `toJstInstant(date, minute)` が JST の暦日＋分を UTC の `Date` に変換する（日跨ぎ営業の 25:00 も含む）
- [ ] `RESERVATION_TRANSITIONS` が設計書の遷移表と 1 対 1 で対応している（6 行）
- [ ] `canTransitionReservationStatus(from, to, by)` が許可 6 通り・禁止 30 通りを正しく判定する
- [ ] `canReserve()` の判定順が 受付停止 → 人数超過 → 件数上限 → 残席不足 のまま変わっていない

**データベース（apps/api/migrations）**

- [ ] `0002_reservation_flow.sql` が `reservations` に `owner_memo` 列と長さ CHECK を足している
- [ ] `BEFORE UPDATE OF status` トリガーが、許可されない 30 通りすべてで `RAISE(ABORT)` する
- [ ] `check-constraints.test.ts` が `0000_init.sql` だけでなく全マイグレーションを読む
- [ ] トリガー違反時のエラーが `SQLITE_CONSTRAINT_TRIGGER` として届く

**Durable Object**

- [ ] `ReservationLock` が classic format（`constructor(state, env)` + `fetch()`）で書かれ、`cloudflare:workers` を import していない
- [ ] 臨界区間の全体が `state.blockConcurrencyWhile()` の中にある（D1 への `await` を含む）
- [ ] DO ID が `idFromName(`${shopId}:${date}`)` で決まっている
- [ ] `reservation-lock.concurrency.test.ts` が本物の workerd 上で 20 並列 × 5 ラウンドを通し、**毎回ちょうど `max_parallel` 件だけ成功する**
- [ ] `blockConcurrencyWhile` を外すと同じテストが落ちることを確認済み

**API**

- [ ] 9 エンドポイントすべてが実装され、`app.routes` に登録されている
- [ ] `reservation-permission-matrix.test.ts` の権限マトリクスが 9 行 × 6 主体すべて期待どおり
- [ ] 登録済みルートと権限テストの対象が**双方向に**一致する（片方にしかない経路が 0）
- [ ] Phase 4 の `permission-matrix.test.ts` が通る（`EXPECTED_ROUTE_PATTERNS` が 19 本、`DELEGATED_ROUTE_PATTERNS` が予約系 9 本、テスト名の数字も 19 に直っている）
- [ ] `DELEGATABLE_PATH_PATTERN`（Phase 4 側）と `PHASE_7_PATH_PATTERN`（Task 7-13 側）が同じ形である
- [ ] 他人の予約 ID は 403 ではなく **404** で隠れている
- [ ] 遷移不能は **422**（409 を使っていない）
- [ ] `ownerMemo` が利用者向けのレスポンスに含まれない
- [ ] `(db, actor, ...)` の引数順が `repository-convention.test.ts` を通る
- [ ] 所有権の判定がすべて SQL の `WHERE` 句にあり、ハンドラに `if (row.userId !== actor.userId)` が 1 つも無い

**モバイル**

- [ ] 5 画面すべてが動く（予約申込 / 利用者一覧 / 利用者詳細 / 店舗一覧 / 店舗詳細）
- [ ] 各画面に loading / empty / error の 3 状態がある
- [ ] `invalidateQueries` の範囲が意図どおり（一覧だけ捨てて詳細は残せる）
- [ ] 店舗側の操作ボタンが `nextReservationStatuses` から導出されている（画面に状態の `if` が無い）
- [ ] 日付・時刻の表示が必ず `toJstClock` を通っている（端末 TZ に依存しない）
- [ ] 予約詳細から店舗ページへ移動でき、`shopId` を渡している（`id` との取り違えが無い）
- [ ] `any` が 1 つも無い / default export は expo-router の画面ファイルだけ

**総点検**

- [ ] `reservation-flow.integration.test.ts` が 8 段すべて通る
- [ ] `npm run typecheck` / `lint` / `format:check` が全ワークスペースで通る
- [ ] 3 ワークスペースのミューテーションテストがしきい値を超える（新規除外設定ゼロ）
- [ ] `design-doc-sync.test.ts` が通る

---

## 次フェーズへの引き継ぎ

**Phase 8（店舗管理）が Phase 7 から受け取るもの:**

| 引き継ぐもの                      | 置き場所                                                   | 使いかた                                                   |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `seat_settings` の読み書き経路    | `apps/api/src/repositories/reservation-slot-repository.ts` | Phase 8 の「席数・同時受付数の編集画面」がこの表を更新する |
| `RESERVATION_TRANSITIONS`         | `packages/core/src/reservation-status.ts`                  | 店舗ダッシュボードの「今日の承認待ち」カウントに使う       |
| `reservationKeys.ownerLists()`    | `apps/mobile/src/features/reservations/query-keys.ts`      | 席設定を変えたら枠のキャッシュも捨てる必要がある           |
| `notification-repository.ts`      | `apps/api/src/repositories/`                               | Phase 8 のレビュー返信通知が同じリポジトリを使う           |
| `(owner)/(tabs)/reservations.tsx` | `apps/mobile/src/app/`                                     | Phase 8 が `(owner)` タブを増やすとき、既存タブとして残る  |

**Phase 9（通知・プッシュ）が Phase 7 から受け取るもの:**

- `notifications` 表に Phase 7 が 4 種類（申込 / 承認 / 拒否 / キャンセル）を書き込んでいる。**Phase 9 はこれを読んで端末へ送るだけでよい**。通知の本文生成は `reservation-notification-service.ts` に閉じているので、Phase 9 が文言を作り直す必要はない
- `ReservationLock` の臨界区間の中で通知を作っていない（DO は予約行の作成だけを担う）。**Phase 9 で送信処理を足すときも、DO の中には入れないこと。** 外部 API の `await` を臨界区間に入れると、ロックの保持時間が外部サービスの応答時間に引きずられる

**Phase 10（仕上げ）へ送る宿題:**

- admin による予約の代理操作は Phase 7 の範囲外（権限マトリクスで admin は `/owner/*` に対して 403）。モデレーション要件が固まった時点で設計する
- `reservation-lock.concurrency.test.ts` と `reservation-flow.integration.test.ts` は miniflare の起動を伴い遅い。CI の実行時間が問題になったら、**テストを消すのではなく**別ジョブに分離する
- 予約詳細からの**経路案内**は、Phase 6 の `ShopInfoList`（「地図アプリで開く」）に送る「店舗ページを開く」ボタンで代替している。予約詳細からタップ 1 回で地図アプリを開きたくなったら、`ReservationResponse` に `latitude` / `longitude` を足す判断が要る。**足すなら `ReservationRow` / `RESERVATION_COLUMNS` / `toReservationRow` / `ReservationResponse` / `toReservationResponse` と店舗側の同型、さらに「`userId` や `ownerMemo` は含めない」のキー集合テストまでが同時に変わる。** 予約の応答に店舗マスタの写しを増やすかどうかの設計判断なので、Phase 10 で決める

---

## 未確認事項

**この計画書で「実測した」と書いた箇所は、すべて実際にコマンドを走らせるかファイルを開いて確かめたものである。** 一方、以下は確認できていない。**実装時に必ず実物を開いて確かめ、食い違っていたらこの計画書ではなく実装を優先すること。**

| 未確認のもの                                                                              | なぜ確認できなかったか                                                                                                                                                                                                       | いつ確かめるか                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/mobile/src/lib/api-client.ts` の実体                                                | **Phase 5 がまだ実装されていない。** しかも Phase 5 の計画書は `apiClient`（Hono の `hc`）を作り、Phase 6 の計画書は `apiFetch` を前提にしていて**名前が食い違っている**                                                     | Task 7-14 Step 1。無ければ同ステップの実装を足す |
| `@/test-support/query-wrapper` の `QueryWrapper` / `createTestQueryClient` の正確な props | Phase 6 未実装。計画書（Task 6-1）の記述に基づいて書いた                                                                                                                                                                     | Task 7-14 Step 13 でフックのテストを書くとき     |
| `@/hooks/use-now` の `useStableNow` の戻り値                                              | Phase 6 未実装。計画書では `Date` を返す                                                                                                                                                                                     | Task 7-15 Step 11                                |
| `@/lib/query-params` の `readSingleQueryValue`                                            | **Phase 6 未実装。** `ls apps/mobile/src/lib` で `logger.ts` ほか 4 本しか無いことを確認済み。署名は Phase 6 計画書（Task 6-3）の `readSingleQueryValue(value: string \| string[] \| undefined): string \| undefined` に依る | Task 7-15 Step 13 / Task 7-16 Step 7             |
| `@/components/ui/*` の各 props                                                            | Phase 0 の計画書（Task 0-8 〜 0-13）のインタフェース定義を読んで書いた。実装済みかは未確認                                                                                                                                   | Task 7-15 Step 13 / Task 7-16 Step 5             |
| `RESERVATION_OWNER_MEMO_MAX_LENGTH` の値                                                  | Task 7-3 で決める定数。計画書に書いた `1000` は**仮の値**                                                                                                                                                                    | Task 7-17 Step 7                                 |
| `apps/api/stryker.config.mjs` の `timeoutMS` の適正値                                     | miniflare 込みのテストの所要時間を測っていない                                                                                                                                                                               | Task 7-17 Step 12 で実測してから決める           |

**上の表に無いものは、すべて実際に確認した。** 確認の根拠は「裏取りした事実」節（事実 1 〜 8）に、コマンドと出力つきで書いてある。

計画を書き終えたあとに実ファイルを開いて**確認が取れた**もの（当初は未確認だった）:

| 確認したもの                         | 確認した場所                                                                  | 結果                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roleGuard` / `requireActor` ほか    | `apps/api/src/middleware/role-guard.ts`                                       | `roleGuard(...allowedRoles: readonly Role[]): MiddlewareHandler<AppEnv>` と `requireUserActor(c: Context<AppEnv>): UserActor` / `requireOwnerActor` / `requireAdminActor` / `requireActor(c): Actor`。**未認証は 401、ロール不一致は 403** で、本計画書の権限マトリクスと一致する |
| `authMiddleware` の載せ方            | `apps/api/src/index.ts` 26 行目                                               | `.use('*', authMiddleware)`。**アプリ全体に載っている**ので、Task 7-13 の「停止アカウントは全経路で 403」は前提どおり成立する                                                                                                                                                     |
| `formatMinuteOfDay` の書式           | `packages/core/src/minute-of-day.ts` 41-48 行目                               | 時は 0 埋めしない（`18:00` / `9:00`）、分は 2 桁固定、1440 以上は `翌 ` を前置。本計画書の「18:00」「翌 1:30」という記述と一致する                                                                                                                                                |
| `design-doc-sync.test.ts` の比較対象 | `apps/api/src/db/schema/design-doc-sync.test.ts`                              | **テーブル名の集合だけ**を比較している。Phase 7 は列を足すだけでテーブルを足さないので、このテストには影響しない                                                                                                                                                                  |
| Phase 4 のルート突合テスト           | `apps/api/src/routes/permission-matrix.test.ts`（628 行、コミット `32d21f4`） | `EXPECTED_ROUTE_PATTERNS`（10 本・503 行）と `collectRouteCoverageViolations`（468 行）が `app.routes` と**双方向に**突き合わせている。**Phase 7 がエンドポイントを足すとこのファイルが落ちる**ので、7-5 / 7-8 / 7-10 / 7-12 の **Files:** に `Modify` として入れた               |
| `rpc-contract.test.ts` への影響      | `apps/api/src/routes/rpc-contract.test.ts`（351 行、同じコミット）            | ルートの一覧をベタ書きしていない（`hc<AppType>` で個別のエンドポイントを叩くだけ）。**Phase 7 がルートを足しても落ちない**                                                                                                                                                        |
